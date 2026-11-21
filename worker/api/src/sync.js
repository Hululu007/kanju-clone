// 增量同步：上游「最近更新」→ D1（shows / episodes）
// 只处理 updated_at 有变化或新出现的剧，避免每次全量抓 5000 部。
import { syncEpisodes, episodeCount, needsEpisodes } from './episodes.js'

const J = (v) => JSON.stringify(v ?? [])
const S = (v) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? String(v) : v)

const UPSERT_SHOW = `
INSERT INTO shows(id,work_id,export_id,title,normalized_title,aliases,content_kind,year,area,language,
  genres,actors,directors,poster,backdrop,description,remarks,update_status,episode_progress,episode_count,
  available_episode_count,heat_value,playback_count,updated_at,updated_ts,synced_at,availability_state,availability_label,detail_url,fetched_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
ON CONFLICT(id) DO UPDATE SET
  title=COALESCE(excluded.title, shows.title),
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
  description=COALESCE(shows.description, excluded.description),
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

const UPSERT_EP = `
INSERT INTO episodes(show_id,idx,number,key,title,token,playback_count)
VALUES(?,?,?,?,?,?,?)
ON CONFLICT(show_id,idx) DO UPDATE SET
  number=excluded.number, key=excluded.key, title=excluded.title,
  token=excluded.token, playback_count=excluded.playback_count
`

async function setMeta(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO meta(key,value,updated_at) VALUES(?,?,datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  )
    .bind(key, value)
    .run()
}

export async function syncOnce(env, fetchJson, { maxShows = 20, maxPages = 3, lookbackDays = 3, sort = 'update_desc', kind = '', force = false } = {}) {
  const out = { startedAt: new Date().toISOString(), sort, kind, force, pages: 0, seen: 0, newShows: 0, updatedShows: 0, episodes: 0, descriptions: 0, skipped: 0, errors: [] }
  const cutoff = new Date(Date.now() - lookbackDays * 86400_000).toISOString()

  let budget = maxShows
  let descriptionBudget = 2
  let complete = true
  outer: for (let page = 1; page <= maxPages; page++) {
    let res
    try {
      const query = new URLSearchParams({ scope: 'public', sort, limit: '20', page: String(page) })
      if (kind) query.set('kind', kind)
      res = await fetchJson(`/v1/browse/catalog?${query}`)
    } catch (e) {
      out.errors.push(`page ${page}: ${String(e.message || e).slice(0, 80)}`)
      complete = false
      break
    }
    const cards = res.cards || []
    out.pages++
    if (!cards.length) break

    for (const c of cards) {
      if (budget <= 0) {
        complete = false
        break outer
      }
      if (!c.id) continue
      out.seen++

      const row = await env.DB.prepare('SELECT updated_at, episode_count, heat_value, description FROM shows WHERE id=?').bind(c.id).first()
      const existingEps = await episodeCount(env, c.id)
      // 上游标称集数 > 库内实际分集数时必须补分集，否则会出现「显示 20 集、只能播 17 集」
      const deficit = needsEpisodes(c, existingEps)
      const changed = force ||
        !row ||
        String(c.updated_at || '') !== String(row.updated_at || '') ||
        Number(c.episode_count || 0) !== Number(row.episode_count || 0) ||
        Number(c.heat_value || 0) !== Number(row.heat_value || 0) ||
        deficit
      const shouldBackfillDescription = !!row && !row.description && descriptionBudget > 0
      if (!changed && !shouldBackfillDescription) {
        out.skipped++
        continue
      }

      if (!changed && shouldBackfillDescription) {
        descriptionBudget--
        try {
          const d = await fetchJson(`/v1/catalog/${c.id}`)
          if (d?.description) {
            await env.DB.prepare('UPDATE shows SET description=? WHERE id=?').bind(d.description, c.id).run()
            out.descriptions++
          }
        } catch (e) {
          out.errors.push(`detail ${c.id.slice(0, 12)}: ${String(e.message || e).slice(0, 60)}`)
        }
        continue
      }

      if (row && sort === 'update_desc' && c.updated_at && String(c.updated_at) < cutoff && Number(c.heat_value || 0) === Number(row.heat_value || 0)) continue

      budget--
      const av = c.availability || {}
      await env.DB.prepare(UPSERT_SHOW)
        .bind(
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
          null,
          c.remarks ?? null,
          null,
          null,
          c.episode_count ?? null,
          c.available_episode_count ?? null,
          c.heat_value ?? null,
          c.playback_count ?? null,
          S(c.updated_at),
          S(c.updated_at),
          new Date().toISOString(),
          S(av.state),
          S(av.label),
          c.detail_url ?? null
        )
        .run()
      if (!row) out.newShows++
      else out.updatedShows++

      // 详情补简介（卡片没有 description）
      if (!row || !row.description) {
        try {
          const d = await fetchJson(`/v1/catalog/${c.id}`)
          if (d?.description) {
            await env.DB.prepare('UPDATE shows SET description=? WHERE id=?').bind(d.description, c.id).run()
            out.descriptions++
          }
        } catch (e) {
          out.errors.push(`detail ${c.id.slice(0, 12)}: ${String(e.message || e).slice(0, 60)}`)
        }
      }

      // 分集：只补缺的尾部，枚举完整且达到标称集数才裁剪
      try {
        const eps = await syncEpisodes(env, fetchJson, c, { existing: existingEps })
        out.episodes += eps.episodes
      } catch (e) {
        out.errors.push(`episodes ${c.id.slice(0, 12)}: ${String(e.message || e).slice(0, 60)}`)
      }
    }

  }

  // 变更判断基于每条记录的更新时间、集数和热度，不依赖全局水位线。
  // 即使本轮预算用完，也要记录运行时间，避免状态看起来一直停在旧日期。
  if (out.pages > 0) await setMeta(env, 'last_sync_at', new Date().toISOString())
  out.complete = complete
  out.finishedAt = new Date().toISOString()
  return out
}
