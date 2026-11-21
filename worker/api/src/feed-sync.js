// 首页栏目与分类热榜同步
//
// 原站首页 /v1/feed/home 返回 11 个栏目（大家都在看 / 韩剧 / 日剧 / 美剧 / 国产剧 /
// 高分电影 / 电影热播 / 院线热映 / 即将上映 / 冷门好片 / 动画连载）。
// 这里把栏目顺序、标题、条目原样落进 D1，前端据此渲染，才能和原站逐条一致。
//
// 原站首页没有综艺栏目，综艺热榜按 /v1/browse/catalog?kind=variety&sort=heat_desc
// 落进 hot_rank，并在接口层补一栏「综艺热播」。

const SECTION_ROW = {
  feed_sec_everyone_watching: 'hot',
  feed_sec_hot_tv_korean: 'kr',
  feed_sec_hot_tv_japanese: 'jp',
  feed_sec_hot_tv_american: 'us',
  feed_sec_hot_tv_domestic: 'cn',
  feed_sec_hot_movie_high_score: 'movie-high',
  feed_sec_hot_movie_hot: 'movie-hot',
  feed_sec_hot_movie_nowplaying: 'theater',
  feed_sec_hot_movie_upcoming: 'upcoming',
  feed_sec_hot_movie_hidden_gems: 'hidden-gems',
  feed_sec_hot_tv_animation: 'anime-series',
}

import { syncEpisodes, episodeCount, needsEpisodes } from './episodes.js'

export const HOT_KINDS = ['series', 'movie', 'variety', 'anime']

const J = (v) => JSON.stringify(v ?? [])
const S = (v) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? String(v) : v)

// 上游卡片没有简介（后面单独补），因此 description 不在这里覆盖
const UPSERT_SHOW = `
INSERT INTO shows(id,work_id,export_id,title,normalized_title,aliases,content_kind,year,area,language,
  genres,actors,directors,poster,backdrop,remarks,episode_count,available_episode_count,heat_value,
  playback_count,updated_at,updated_ts,synced_at,availability_state,availability_label,detail_url,fetched_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?,?,?,datetime('now'))
ON CONFLICT(id) DO UPDATE SET
  title=COALESCE(excluded.title, shows.title),
  work_id=COALESCE(excluded.work_id, shows.work_id),
  export_id=COALESCE(excluded.export_id, shows.export_id),
  normalized_title=COALESCE(excluded.normalized_title, shows.normalized_title),
  aliases=COALESCE(excluded.aliases, shows.aliases),
  content_kind=COALESCE(excluded.content_kind, shows.content_kind),
  year=COALESCE(excluded.year, shows.year),
  area=COALESCE(excluded.area, shows.area),
  language=COALESCE(excluded.language, shows.language),
  genres=COALESCE(excluded.genres, shows.genres),
  actors=COALESCE(excluded.actors, shows.actors),
  directors=COALESCE(excluded.directors, shows.directors),
  poster=COALESCE(excluded.poster, shows.poster),
  backdrop=COALESCE(excluded.backdrop, shows.backdrop),
  remarks=COALESCE(excluded.remarks, shows.remarks),
  episode_count=COALESCE(excluded.episode_count, shows.episode_count),
  available_episode_count=COALESCE(excluded.available_episode_count, shows.available_episode_count),
  heat_value=COALESCE(excluded.heat_value, shows.heat_value),
  playback_count=COALESCE(excluded.playback_count, shows.playback_count),
  updated_at=COALESCE(excluded.updated_at, shows.updated_at),
  updated_ts=COALESCE(excluded.updated_ts, shows.updated_ts),
  synced_at=excluded.synced_at,
  availability_state=COALESCE(excluded.availability_state, shows.availability_state),
  availability_label=COALESCE(excluded.availability_label, shows.availability_label),
  detail_url=COALESCE(excluded.detail_url, shows.detail_url),
  fetched_at=excluded.fetched_at
`

async function setMeta(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO meta(key,value,updated_at) VALUES(?,?,datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  )
    .bind(key, value)
    .run()
}

async function batchAll(env, statements, size = 30) {
  for (let i = 0; i < statements.length; i += size) {
    await env.DB.batch(statements.slice(i, i + size))
  }
}

// 栏目卡片只保留前端渲染需要的字段；heat_value 是原站趋势分（万级），
// 与分类页的 heat_value（百级）不是同一口径，绝不写回 shows。
function feedItem(c) {
  const av = c.availability || null
  return {
    id: c.id,
    title: c.title,
    year: c.year || '',
    kind: c.content_kind || '',
    area: c.area || '',
    language: c.language || '',
    genres: Array.isArray(c.genres) ? c.genres : [],
    poster: c.poster_url || c.poster || '',
    backdrop: c.backdrop_url || c.backdrop || '',
    remarks: c.remarks || '',
    heatValue: Number(c.heat_value) || 0,
    playbackCount: Number(c.playback_count) || 0,
    updatedAt: c.updated_at || '',
    availability: av ? { state: av.state || '', label: av.label || '' } : null,
  }
}

function showBind(c, withHeat) {
  const av = c.availability || {}
  return [
    c.id,
    c.work_id ?? null,
    c.export_id ?? null,
    c.title ?? null,
    c.normalized_title ?? null,
    J(c.aliases),
    c.content_kind ?? null,
    c.year ?? null,
    c.area ?? null,
    c.language ?? null,
    J(c.genres),
    J(c.actors),
    J(c.directors),
    c.poster_url ?? null,
    c.backdrop_url ?? null,
    c.remarks ?? null,
    c.episode_count ?? null,
    c.available_episode_count ?? null,
    withHeat ? c.heat_value ?? null : null,
    c.playback_count ?? null,
    S(c.updated_at),
    S(c.updated_at),
    S(av.state),
    S(av.label),
    c.detail_url ?? null,
  ]
}

// 补分集：只在「标称集数 > 库内实际分集数」时才补，顺带补一次简介
async function fillEpisodes(env, fetchJson, card, out, existing = 0) {
  if (!needsEpisodes(card, existing)) return false
  try {
    const row = await env.DB.prepare('SELECT description FROM shows WHERE id=?').bind(card.id).first().catch(() => null)
    if (!row?.description) {
      const detail = await fetchJson(`/v1/catalog/${card.id}`)
      const c = detail.catalog || detail.card || detail
      if (c?.description) {
        await env.DB.prepare('UPDATE shows SET description=? WHERE id=?').bind(String(c.description).slice(0, 4000), card.id).run()
        out.descriptions = (out.descriptions || 0) + 1
      }
    }
    const r = await syncEpisodes(env, fetchJson, card, { existing })
    out.episodes += r.episodes
    out.seeded++
    return true
  } catch (e) {
    const msg = String(e.message || e)
    // 原站对「即将上映 / 无片源」的条目详情直接 500，这类不算同步失败也不占预算
    if (/HTTP 5\d\d/.test(msg)) {
      out.dead = (out.dead || 0) + 1
      return 'dead'
    }
    out.errors.push(`seed ${String(card.id).slice(0, 12)}: ${msg.slice(0, 70)}`)
    return false
  }
}

async function upsertCards(env, fetchJson, cards, { withHeat = false, seedBudget = 0 } = {}) {
  const out = { shows: cards.length, episodes: 0, seeded: 0, descriptions: 0, errors: [] }
  await batchAll(env, cards.map((c) => env.DB.prepare(UPSERT_SHOW).bind(...showBind(c, withHeat))))
  if (seedBudget <= 0) return out
  // 一次查出这批卡片的实际分集数，避免逐条 COUNT 把一次同步拖到超时
  const counts = new Map()
  const ids = cards.map((c) => c.id)
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80)
    const rows = await env.DB.prepare(
      `SELECT show_id, COUNT(*) c FROM episodes WHERE show_id IN (${chunk.map(() => '?').join(',')}) GROUP BY show_id`
    )
      .bind(...chunk)
      .all()
      .catch(() => ({ results: [] }))
    for (const r of rows.results || []) counts.set(r.show_id, Number(r.c || 0))
  }
  let budget = seedBudget
  // 正在连载（remarks 带「更新至」）的优先补集，避免预算被无片源条目吃掉
  const ordered = [...cards].sort((a, b) => {
    const score = (c) => (/更新至/.test(String(c.remarks || '')) ? 0 : 1)
    return score(a) - score(b)
  })
  for (const c of ordered) {
    if (budget <= 0) break
    const existing = counts.get(c.id) || 0
    if (!needsEpisodes(c, existing)) continue
    budget--
    const r = await fillEpisodes(env, fetchJson, c, out, existing)
    if (r === 'dead') budget++
  }
  return out
}

export async function syncHomeFeed(env, fetchJson, { cards = 20, seedBudget = 6 } = {}) {
  const out = { startedAt: new Date().toISOString(), sections: 0, cards: 0, episodes: 0, seeded: 0, descriptions: 0, errors: [] }
  const feed = await fetchJson(`/v1/feed/home?scope=public&mode=preview&sections=11&cards=${cards}`)
  const sections = feed.sections || []
  const rows = []
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]
    const rowId = SECTION_ROW[s.id]
    if (!rowId) continue
    rows.push({
      rowId,
      sectionId: s.id,
      title: s.title || rowId,
      subtitle: s.subtitle || '',
      position: rows.length,
      items: (s.cards || []).map(feedItem),
      browse: s.browse?.params ? JSON.stringify(s.browse.params) : null,
    })
  }
  if (!rows.length) throw new Error('上游 feed 没有可用栏目')
  await env.DB.prepare('DELETE FROM feed_rows').run()
  await batchAll(
    env,
    rows.map((r) =>
      env.DB.prepare('INSERT INTO feed_rows(row_id,section_id,title,subtitle,position,items,browse,synced_at) VALUES(?,?,?,?,?,?,?,datetime(\'now\'))')
        .bind(r.rowId, r.sectionId, r.title, r.subtitle, r.position, JSON.stringify(r.items), r.browse)
    )
  )
  out.sections = rows.length

  const unique = [...new Map(sections.flatMap((s) => s.cards || []).map((c) => [c.id, c])).values()].filter((c) => c.id)
  out.cards = unique.length
  const meta = await upsertCards(env, fetchJson, unique, { withHeat: false, seedBudget })
  out.episodes += meta.episodes
  out.seeded += meta.seeded
  out.descriptions += meta.descriptions
  out.errors.push(...meta.errors)
  await setMeta(env, 'last_feed_sync_at', new Date().toISOString())
  out.finishedAt = new Date().toISOString()
  return out
}

export async function syncHotRanks(env, fetchJson, { pages = 5, perPage = 20, seedBudget = 3, kinds = HOT_KINDS } = {}) {
  const out = { startedAt: new Date().toISOString(), kinds: {}, episodes: 0, seeded: 0, errors: [] }
  for (const kind of kinds.filter((k) => HOT_KINDS.includes(k))) {
    const cards = []
    const seen = new Set()
    try {
      for (let page = 0; page < pages; page++) {
        const res = await fetchJson(
          `/v1/browse/catalog?scope=public&kind=${kind}&sort=heat_desc&limit=${perPage}&page=${page + 1}`
        )
        const list = res.cards || []
        if (!list.length) break
        for (const c of list) {
          if (!c?.id || seen.has(c.id)) continue
          seen.add(c.id)
          cards.push(c)
        }
      }
    } catch (e) {
      out.errors.push(`${kind} browse: ${String(e.message || e).slice(0, 70)}`)
    }
    if (!cards.length) continue
    const meta = await upsertCards(env, fetchJson, cards, { withHeat: true, seedBudget })
    await env.DB.prepare('DELETE FROM hot_rank WHERE kind=?').bind(kind).run()
    const now = new Date().toISOString()
    await batchAll(
      env,
      cards.map((c, i) =>
        env.DB.prepare('INSERT OR REPLACE INTO hot_rank(kind,rank,show_id,heat_value,synced_at) VALUES(?,?,?,?,?)').bind(
          kind,
          i + 1,
          c.id,
          c.heat_value ?? null,
          now
        )
      )
    )
    out.kinds[kind] = cards.length
    out.episodes += meta.episodes
    out.seeded += meta.seeded
    out.errors.push(...meta.errors)
  }
  await setMeta(env, 'last_hot_sync_at', new Date().toISOString())
  out.finishedAt = new Date().toISOString()
  return out
}
