// 抓取原站（kanju32.com）真实片库：目录 → 详情 → 分集 → 播放地址
// 只抓元数据与公开播放地址，不下载、不转存任何视频文件。
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { api, call } from './kanju-client.mjs'

const DB_PATH = fileURLToPath(new URL('./data/kanju.db', import.meta.url))
const LIMIT = Number(process.env.LIMIT || 500)           // 目标影片数
const CONCURRENCY = Number(process.env.CONCURRENCY || 4)
const RESOLVE = process.env.RESOLVE || 'all'             // all | first | none
const FRESH = process.env.FRESH === '1'                   // 1 = 删库重抓

mkdirSync(dirname(DB_PATH), { recursive: true })
if (FRESH) rmSync(DB_PATH, { force: true })
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;')

db.exec(`
CREATE TABLE IF NOT EXISTS shows(
  id TEXT PRIMARY KEY, work_id TEXT, export_id INTEGER, title TEXT, normalized_title TEXT,
  aliases TEXT, content_kind TEXT, year INTEGER, area TEXT, language TEXT,
  genres TEXT, actors TEXT, directors TEXT, poster TEXT, backdrop TEXT, description TEXT,
  remarks TEXT, update_status TEXT, episode_progress TEXT, episode_count INTEGER,
  available_episode_count INTEGER, heat_value REAL, playback_count INTEGER, updated_at TEXT,
  availability_state TEXT, availability_label TEXT, detail_url TEXT, fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS episodes(
  show_id TEXT, idx INTEGER, number INTEGER, key TEXT, title TEXT, token TEXT,
  playback_count INTEGER, quality TEXT, line_label TEXT, provider TEXT, stream TEXT, stream_kind TEXT,
  resolved_at TEXT, PRIMARY KEY(show_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_shows_kind ON shows(content_kind);
CREATE INDEX IF NOT EXISTS idx_shows_heat ON shows(heat_value);
`)

const now = () => new Date().toISOString()
// SQLite 只能绑基础类型：对象/布尔统一转成文本
const textOf = (v) => (v && typeof v === 'object' ? (v.display_text || v.text || null) : (v ?? null))
const S = (v) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? String(v) : v)

const J = (v) => JSON.stringify(v ?? [])

const upShow = db.prepare(`INSERT INTO shows(id,work_id,export_id,title,normalized_title,aliases,content_kind,year,area,language,
 genres,actors,directors,poster,backdrop,description,remarks,update_status,episode_progress,episode_count,
 available_episode_count,heat_value,playback_count,updated_at,availability_state,availability_label,detail_url,fetched_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
 ON CONFLICT(id) DO UPDATE SET title=excluded.title, normalized_title=excluded.normalized_title,
 aliases=excluded.aliases, content_kind=excluded.content_kind, year=excluded.year, area=excluded.area,
 language=excluded.language, genres=excluded.genres, actors=excluded.actors, directors=excluded.directors,
 poster=excluded.poster, backdrop=excluded.backdrop, description=excluded.description, remarks=excluded.remarks,
 update_status=excluded.update_status, episode_progress=excluded.episode_progress, episode_count=excluded.episode_count,
 available_episode_count=excluded.available_episode_count, heat_value=excluded.heat_value,
 playback_count=excluded.playback_count, updated_at=excluded.updated_at, availability_state=excluded.availability_state,
 availability_label=excluded.availability_label, detail_url=excluded.detail_url, fetched_at=excluded.fetched_at`)

const upEp = db.prepare(`INSERT INTO episodes(show_id,idx,number,key,title,token,playback_count,quality,line_label,provider,stream,stream_kind,resolved_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
 ON CONFLICT(show_id,idx) DO UPDATE SET number=excluded.number, key=excluded.key, title=excluded.title,
 token=excluded.token, playback_count=excluded.playback_count, quality=excluded.quality,
 line_label=excluded.line_label, provider=excluded.provider, stream=excluded.stream,
 stream_kind=excluded.stream_kind, resolved_at=excluded.resolved_at`)

// 已经抓过分集的才算“抓过”，只有卡片的不算
const have = new Set(db.prepare('SELECT DISTINCT show_id AS id FROM episodes').all().map(r => r.id))

// ---------- 1. 目录：分页拉卡片，拿 id 列表 ----------
async function collectIds(target) {
  const ids = []
  const seen = new Set()
  // 原站 browse 只认 page（offset 参数被忽略），按 page 轮转推进
  const kinds = ['series', 'movie', 'anime', 'variety']
  const page = Object.fromEntries(kinds.map((k) => [k, 1]))
  const done = new Set()
  let guard = 0
  while (ids.length < target * 1.15 && done.size < kinds.length && guard++ < 400) {
    for (const kind of kinds) {
      if (done.has(kind) || ids.length >= target * 1.15) continue
      let res
      try {
        res = await call(`/v1/browse/catalog?scope=public&sort=heat_desc&limit=20&kind=${kind}&page=${page[kind]}`)
      } catch (e) {
        console.warn('browse 失败', kind, e.message.slice(0, 100)); done.add(kind); continue
      }
      const cards = res.cards || []
      upsertCards(cards)
      for (const c of cards) if (c.id && !seen.has(c.id)) { seen.add(c.id); ids.push(c) }
      if (!cards.length || !res.pagination?.has_more) done.add(kind)
      console.log(`  目录 ${kind} page=${page[kind]} +${cards.length} 累计 ${ids.length}`)
      page[kind]++
    }
  }
  // 首页 11 个栏目再补一批（编辑推荐位里的片子未必在热度榜前列）
  try {
    const feed = await api.feed(11, 20)
    const extra = []
    for (const sec of feed.sections || []) for (const c of sec.cards || []) if (c.id && !seen.has(c.id)) { seen.add(c.id); extra.push(c) }
    upsertCards(extra)
    ids.push(...extra)
    console.log('  feed 补充 ' + extra.length)
  } catch (e) { console.warn('feed 失败', e.message.slice(0, 120)) }
  return ids
}

// 卡片先落库（串行写入，避免 node:sqlite 并发写锁库）
function upsertCards(cards) {
  for (const c of cards) {
    try { pagePrime([c]) } catch (e) { console.warn('写卡片失败', c?.id?.slice(0, 12), e.message.slice(0, 60)) }
  }
}

// 列表阶段的卡片先落库（即使详情抓取失败也有封面和标题）
async function pagePrime(cards) {
  for (const c of cards || []) {
    const av = c.availability || {}
    upShow.run(c.id, c.work_id ?? null, c.export_id ?? null, c.title ?? null, c.normalized_title ?? null,
      J(c.aliases), c.content_kind ?? null, c.year ?? null, c.area ?? null, c.language ?? null,
      J(c.genres), J(c.actors), J(c.directors), c.poster_url ?? null, c.backdrop_url ?? null, null,
      c.remarks ?? null, null, null, null, null, c.heat_value ?? null, c.playback_count ?? null,
      c.updated_at ?? null, av.state ?? null, av.label ?? null, c.detail_url ?? null, now())
  }
}

// ---------- 2. 详情 + 分集 + 播放地址 ----------
async function fetchShow(card) {
  const id = card.id
  let detail = null
  try { detail = await api.detail(id) } catch { detail = null }
  const d = detail || {}

  let eps = []
  let offset = 0
  for (let guard = 0; guard < 12; guard++) {
    let page
    try { page = await api.episodes(id, 48, offset) } catch (e) {
      console.warn('  分集失败', (card.title || id).slice(0, 18), e.message.slice(0, 90))
      break
    }
    eps = eps.concat(page.episodes || [])
    const pg = page.episode_pagination || page.pagination || {}
    if (!pg.has_more) break
    offset = pg.offset + pg.limit
  }

  const av = card.availability || {}
  upShow.run(id, card.work_id ?? d.work_id ?? null, card.export_id ?? d.export_id ?? null,
    d.title ?? card.title ?? null, d.normalized_title ?? card.normalized_title ?? null,
    J(card.aliases), d.content_kind ?? card.content_kind ?? null, d.year ?? card.year ?? null,
    d.area ?? card.area ?? null, d.language ?? card.language ?? null,
    J(d.genres ?? card.genres), J(d.actors ?? card.actors), J(d.directors ?? card.directors),
    d.poster_url ?? card.poster_url ?? null, d.backdrop_url ?? card.backdrop_url ?? null,
    d.description ?? null, d.remarks ?? card.remarks ?? null, d.update_status ?? null,
    d.episode_progress_text ?? null, d.episode_count ?? null, d.available_episode_count ?? eps.length,
    d.heat_value ?? card.heat_value ?? null, d.playback_count ?? card.playback_count ?? null,
    textOf(d.recent_update) ?? S(card.updated_at), S(av.state), S(av.label),
    card.detail_url ?? null, now())

  let resolved = 0
  for (let i = 0; i < eps.length; i++) {
    const e = eps[i]
    let quality = null, label = null, provider = null, stream = null, kind = null
    const wantResolve = RESOLVE === 'all' || (RESOLVE === 'first' && i === 0)
    if (wantResolve && e.token) {
      try {
        const rv = await api.resolve(e.token)
        const opts = rv.line_options || []
        const opt = opts.find(o => o.selected) || opts.find(o => o.default_priority) || opts[0]
        if (opt) {
          label = opt.label ?? null
          provider = opt.provider_id ?? null
          quality = (String(opt.label || '').match(/\d{3,4}P/i) || [null])[0]
          const ticket = String(opt.url || '').replace(/^resolve:\/\//, '')
          if (opt.url_kind === 'resolve_ticket' && ticket) {
            const rl = await call('/v1/playback/resolve-line', { method: 'POST', body: { ticket } })
            const line = rl.line || {}
            stream = line.url || line.play_url || null
            kind = line.type || (stream && /\.m3u8/.test(stream) ? 'm3u8' : 'video')
            if (!label && line.label) label = line.label
            if (!provider && line.provider_id) provider = line.provider_id
            if (!quality && line.quality) quality = line.quality
          } else if (opt.url) {
            stream = String(opt.url)
            kind = 'direct'
          }
          resolved++
        }
      } catch { /* 单集失败不影响整片 */ }
    }
    upEp.run(id, i, e.number ?? i + 1, e.key ?? null, e.title ?? null, e.token ?? null,
      e.playback_count ?? null, quality, label, provider, stream, kind, stream ? now() : null)
  }
  return { id, title: d.title ?? card.title, eps: eps.length, resolved }
}

async function pool(items, worker, size) {
  const out = []
  let cursor = 0
  const runners = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      try { out.push(await worker(items[i], i)) } catch (e) { out.push({ err: String(e.message || e).slice(0, 120) }) }
    }
  })
  await Promise.all(runners)
  return out
}

const started = Date.now()

// REPAIR=1：不重新拉目录，只补抓库里还没有分集的片子（可指定 KIND=movie/anime/series/variety）
if (process.env.REPAIR) {
  const kind = process.env.KIND || ''
  const where = `NOT EXISTS (SELECT 1 FROM episodes e WHERE e.show_id = s.id)` + (kind ? ` AND s.content_kind = ?` : '')
  const args = kind ? [kind, LIMIT] : [LIMIT]
  const need = db.prepare(`SELECT s.id, s.title FROM shows s WHERE ${where} ORDER BY COALESCE(s.heat_value,0) DESC LIMIT ?`).all(...args)
  console.log(`补抓队列 ${need.length} 部${kind ? '（' + kind + '）' : ''}`)
  let ok = 0, ep = 0
  await pool(need, async (c) => {
    let r
    try { r = await fetchShow({ id: c.id, title: c.title }) }
    catch (e) { console.error('  ERR', c.title || c.id, String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); return { err: String(e) } }
    if (r.eps) { ok++; ep += r.eps }
    console.log(`  ${r.eps ? '✓' : '·'} ${r.title || c.id} ${r.eps ? r.eps + ' 集' : '无分集'} (${ok}/${need.length})`)
    return r
  }, CONCURRENCY)
  const st = {
    shows: db.prepare('SELECT COUNT(*) c FROM shows').get().c,
    withEpisodes: db.prepare('SELECT COUNT(DISTINCT show_id) c FROM episodes').get().c,
    episodes: db.prepare('SELECT COUNT(*) c FROM episodes').get().c,
  }
  console.log('补抓完成', JSON.stringify(st), ((Date.now() - started) / 1000).toFixed(1) + 's')
  await new Promise(r => setTimeout(r, 300)) // 等 stdout 刷完再退出
  process.exit(0)
}

const cards = await collectIds(LIMIT)
console.log(`目录卡片 ${cards.length} 条（库内已有 ${have.size} 部）`)
const todo = cards.filter((c) => !have.has(c.id)).slice(0, LIMIT)
let done = 0, totalEp = 0, totalStream = 0
await pool(todo, async (c) => {
  const r = await fetchShow(c)
  done++
  totalEp += r.eps || 0
  totalStream += r.resolved || 0
  if (done % 10 === 0 || done === todo.length) {
    const sec = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`[${done}/${todo.length}] ${sec}s 分集 ${totalEp} 已解析 ${totalStream} 最近: ${r.title || r.id}`)
  }
  return r
}, CONCURRENCY)

// 补抓：主流程里因为限速失败、分集为 0 的，放慢速度再补一轮
const empty = db.prepare(`SELECT s.id, s.title FROM shows s
  WHERE s.content_kind IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.show_id = s.id)
  ORDER BY COALESCE(s.heat_value,0) DESC LIMIT ?`).all(Math.ceil(LIMIT / 4))
if (empty.length) {
  console.log(`补抓 ${empty.length} 部（慢速）`)
  await pool(empty, async (c) => fetchShow({ id: c.id, title: c.title }), 2)
}

const stat = {
  shows: db.prepare('SELECT COUNT(*) c FROM shows').get().c,
  withEpisodes: db.prepare('SELECT COUNT(DISTINCT show_id) c FROM episodes').get().c,
  episodes: db.prepare('SELECT COUNT(*) c FROM episodes').get().c,
  streams: db.prepare('SELECT COUNT(*) c FROM episodes WHERE stream IS NOT NULL').get().c,
  byKind: db.prepare('SELECT content_kind k, COUNT(*) c FROM shows GROUP BY 1 ORDER BY 2 DESC').all(),
}
console.log('完成', JSON.stringify(stat), ((Date.now() - started) / 1000).toFixed(1) + 's')
