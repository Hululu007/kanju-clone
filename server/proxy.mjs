// 本地片源服务：给静态站点提供"现场解析"能力
// 用法：node server/proxy.mjs [--port 8899]
// 站点里把「片源服务地址」指到 http://127.0.0.1:8899 即可站内播放（视频直链由该服务现场换取）。
import http from 'node:http'
const updatedText = (v) => { if (!v) return null; if (typeof v !== 'string') return v; if (v[0] !== '{') return v; try { const o = JSON.parse(v); return o.display_text || o.text || null } catch { return v } }

import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { api, call } from './kanju-client.mjs'

const PORT = Number(process.env.PORT || process.argv.includes('--port') ? process.env.PORT || process.argv[process.argv.indexOf('--port') + 1] : 8899)
const DB_PATH = fileURLToPath(new URL('./data/kanju.db', import.meta.url))
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000;')

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
}

const json = (res, code, obj) => {
  const body = JSON.stringify(obj)
  res.writeHead(code, { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

// 解析结果缓存：同一集 90 秒内不重复打原站
const cache = new Map()
const TTL = 90_000

// 用 Range 请求试探片源是否可用（只取 2KB，代价很小）
async function probeUrl(url) {
  try {
    const r = await fetch(url, { headers: { range: 'bytes=0-2047' }, signal: AbortSignal.timeout(8000) })
    const ct = String(r.headers.get('content-type') || '')
    if (r.status >= 400) return false
    return /video|octet-stream|mpegurl/i.test(ct) || r.status === 206
  } catch { return false }
}

async function playUrl(showId, idx) {
  const key = `${showId}#${idx}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL) return { ...hit.value, cached: true }

  const ep = db.prepare('SELECT * FROM episodes WHERE show_id=? AND idx=?').get(showId, Number(idx))
  if (!ep) throw new Error('没有这一集')
  if (!ep.token) throw new Error('这一集缺少播放凭证')

  const rv = await api.resolve(ep.token)
  // 校验原站返回的到底是第几集：万一线路串了集，宁可报错也不能播错内容
  const gotNum = rv?.current_episode?.episode_number
  const wantNum = ep.number || Number(idx) + 1
  if (gotNum != null && Number(gotNum) !== Number(wantNum)) {
    throw new Error(`集数不一致：请求第${wantNum}集，原站返回第${gotNum}集`)
  }
  const opts = (rv.line_options || []).filter(o => o.url)
  if (!opts.length) throw new Error('原站没有可用线路')
  // 优先官方解析线路，其次任意一条
  // 依次试前几条线路：MP4 优先（浏览器原生最稳），都不行就用第一条成功的
  const ordered = [...opts].sort((a, b) => {
    const good = (o) => (o.type === 'player' || o.url_kind === 'resolve_ticket' ? 0 : 1)
    return good(a) - good(b) || (a.default_priority || 0) - (b.default_priority || 0)
  })
  let pick = null, url = ''
  const tried = []
  for (const o of ordered.slice(0, 4)) {
    const ticket = String(o.url).replace(/^resolve:\/\//, '')
    try {
      const rl = await call('/v1/playback/resolve-line', { method: 'POST', body: { ticket } })
      const u = rl?.line?.url
      if (!u) continue
      const kind = /\.m3u8(\?|$)/i.test(u) ? 'hls' : 'mp4'
      // 现场验一下这条线路是否真能用（有的线路带防盗链，浏览器里会 403）
      if (kind === 'mp4' && !(await probeUrl(u))) { tried.push({ label: o.label, kind, ok: false }); continue }
      tried.push({ label: o.label, kind, ok: true })
      if (!pick) { pick = o; url = u }
      if (kind === 'mp4') { pick = o; url = u; break } // 能用 MP4 就停
    } catch (e) {
      if (/login_required|playback_user_session_required/.test(String(e.body || e.message || ''))) throw e
    }
  }
  if (!url) throw new Error('线路解析失败')
  const value = {
    showId, idx,
    url,
    kind: /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'mp4',
    tried,
    episodeNumber: Number(gotNum ?? wantNum),
    line: pick.label || '',
    provider: pick.provider_id || '',
    options: opts.map(o => ({ label: o.label, provider: o.provider_id, type: o.type })),
  }
  cache.set(key, { at: Date.now(), value })
  return value
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`)
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end() }
  try {
    if (u.pathname === '/api/health') {
      const n = db.prepare('SELECT COUNT(*) c FROM shows WHERE EXISTS(SELECT 1 FROM episodes e WHERE e.show_id=shows.id)').get().c
      const eps = db.prepare('SELECT COUNT(*) c FROM episodes').get().c
      return json(res, 200, { ok: true, service: 'kanju-proxy', shows: n, episodes: eps, site: 'https://kanju32.com', time: new Date().toISOString() })
    }
    if (u.pathname === '/api/list') {
      const cat = u.searchParams.get('cat') || ''
      const q = (u.searchParams.get('q') || '').trim()
      const limit = Math.min(60, Number(u.searchParams.get('limit') || 24))
      const page = Math.max(1, Number(u.searchParams.get('page') || 1))
      const kinds = { tv: ['series', 'short_drama'], movie: ['movie'], anime: ['anime', 'animation'], variety: ['variety', 'documentary'] }
      const where = ["EXISTS(SELECT 1 FROM episodes e WHERE e.show_id=shows.id)"]
      const args = []
      if (kinds[cat]) { where.push(`content_kind IN (${kinds[cat].map(() => '?').join(',')})`); args.push(...kinds[cat]) }
      if (q) { where.push('(title LIKE ? OR genres LIKE ? OR actors LIKE ? OR description LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`) }
      const sql = `SELECT id,title,year,content_kind AS kind,area,language,genres,poster,remarks,episode_count,available_episode_count,heat_value,updated_at FROM shows WHERE ${where.join(' AND ')} ORDER BY heat_value DESC LIMIT ? OFFSET ?`
      const rows = db.prepare(sql).all(...args, limit, (page - 1) * limit)
      const total = db.prepare(`SELECT COUNT(*) c FROM shows WHERE ${where.join(' AND ')}`).get(...args).c
      return json(res, 200, { object: 'list', total, page, limit, items: rows.map((r) => ({
        id: r.id, title: r.title, year: r.year, kind: r.kind, area: r.area, language: r.language,
        genres: safeJSON(r.genres, []), poster: r.poster, remarks: r.remarks,
        episodeCount: r.episode_count, availableEpisodeCount: r.available_episode_count,
        heatValue: r.heat_value, updatedAt: updatedText(r.updated_at),
      })) })
    }
    if (u.pathname === '/api/show') {
      const id = u.searchParams.get('id')
      const s = db.prepare('SELECT * FROM shows WHERE id=?').get(id)
      if (!s) return json(res, 404, { error: '没有这部剧' })
      const eps = db.prepare('SELECT idx,number,title,token,quality,line_label,provider,stream_kind FROM episodes WHERE show_id=? ORDER BY idx').all(id)
      return json(res, 200, {
        object: 'show',
        id: s.id, title: s.title, year: s.year, kind: s.content_kind, area: s.area, language: s.language,
        genres: safeJSON(s.genres, []), actors: safeJSON(s.actors, []), directors: safeJSON(s.directors, []),
        poster: s.poster, backdrop: s.backdrop, synopsis: s.description, remarks: s.remarks,
        episodeCount: s.episode_count, availableEpisodeCount: s.available_episode_count, heatValue: s.heat_value,
        updatedAt: updatedText(s.updated_at),
        episodes: eps.map(e => ({ idx: e.idx, label: e.title || `第${e.number || e.idx + 1}集`, playable: !!e.token, quality: e.quality, line: e.line_label })),
      })
    }
    if (u.pathname === '/api/play') {
      const showId = u.searchParams.get('show')
      const idx = Number(u.searchParams.get('ep') || 0)
      const out = await playUrl(showId, idx)
      return json(res, 200, { object: 'play', ...out })
    }
    if (u.pathname === '/api/progress') {
      if (req.method === 'POST') {
        let raw = ''
        for await (const chunk of req) raw += chunk
        const b = safeJSON(raw, {})
        db.prepare(`INSERT INTO progress(device,show_id,idx,position,duration,updated) VALUES(?,?,?,?,?,datetime('now'))
          ON CONFLICT(device,show_id) DO UPDATE SET idx=excluded.idx,position=excluded.position,duration=excluded.duration,updated=excluded.updated`)
          .run(b.device || 'web', b.showId, Number(b.idx || 0), Number(b.position || 0), b.duration ?? null)
        return json(res, 200, { ok: true })
      }
      const rows = db.prepare('SELECT * FROM progress ORDER BY updated DESC LIMIT 30').all()
      return json(res, 200, { object: 'progress', items: rows })
    }
    return json(res, 404, { error: 'not found', paths: ['/api/health', '/api/list', '/api/show', '/api/play', '/api/progress'] })
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) })
  }
})

function safeJSON(v, d) { try { const x = JSON.parse(v ?? 'null'); return x ?? d } catch { return d } }

server.listen(PORT, '127.0.0.1', () => {
  const n = db.prepare('SELECT COUNT(*) c FROM shows').get().c
  console.log(`片源服务已启动 http://127.0.0.1:${PORT}  (库内 ${n} 部)`)
  console.log(`健康检查：http://127.0.0.1:${PORT}/api/health`)
})
