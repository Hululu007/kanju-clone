// 分集同步（首页栏目同步 / 分类热榜同步 / 最近更新同步共用）
//
// 关键点：
// 1) 上游标称集数（更新至 N 集 / 全 N 集 / episode_count）与库内实际分集数不一致时，
//    只补缺的尾部，避免「页面显示 20 集、实际只能播 17 集」。
// 2) 只有确认把分集枚举完、并且拿到的集数达到了标称集数，才裁掉多余分集；
//    否则绝不删除——超长剧（如海贼王 1000+ 集）只同步前若干页时删尾巴会造成不可逆丢集。

const J = (v) => JSON.stringify(v ?? [])
const S = (v) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? String(v) : v)

const UPSERT_EP = `
INSERT INTO episodes(show_id,idx,number,key,title,token,playback_count)
VALUES(?,?,?,?,?,?,?)
ON CONFLICT(show_id,idx) DO UPDATE SET
  number=excluded.number, key=excluded.key, title=excluded.title,
  token=excluded.token, playback_count=excluded.playback_count
`

export function expectedEpisodes(card) {
  const remarks = String(card?.remarks || '')
  const m = remarks.match(/(?:更新至|全)\s*(\d+)\s*集/)
  const marker = m ? Number(m[1]) : 0
  return Math.max(Number(card?.episode_count || 0), Number(card?.available_episode_count || 0), marker, 0)
}

export async function episodeCount(env, showId) {
  const row = await env.DB.prepare('SELECT COUNT(*) c FROM episodes WHERE show_id=?').bind(showId).first().catch(() => null)
  return Number(row?.c || 0)
}

export async function syncEpisodes(env, fetchJson, card, { existing = 0 } = {}) {
  const out = { episodes: 0, complete: false }
  const expected = expectedEpisodes(card)
  // 已有分集时从最后一个整页开始翻，长剧不会被从 0 重翻
  let offset = existing > 48 ? Math.floor(existing / 48) * 48 : 0
  let fetched = 0
  let complete = false
  const stmts = []
  for (let p = 0; p < 8; p++) {
    const page = await fetchJson(`/v1/catalog/${card.id}/episodes?limit=48&offset=${offset}`)
    const eps = page.episodes || []
    for (let i = 0; i < eps.length; i++) {
      const e = eps[i]
      stmts.push(
        env.DB.prepare(UPSERT_EP).bind(card.id, offset + i, e.number ?? offset + i + 1, e.key ?? null, e.title ?? null, e.token ?? null, e.playback_count ?? null)
      )
    }
    fetched += eps.length
    const pg = page.episode_pagination || page.pagination || {}
    const reached = expected > 0 && offset + eps.length >= expected
    if (!pg.has_more || !eps.length || reached) {
      complete = true
      break
    }
    offset = pg.offset + pg.limit
  }
  for (let i = 0; i < stmts.length; i += 25) {
    await env.DB.batch(stmts.slice(i, i + 25))
  }
  out.episodes = fetched
  // 只在「确实枚举完 + 达到标称集数」时裁剪
  if (complete && expected > 0 && offset + fetched >= expected) {
    await env.DB.prepare('DELETE FROM episodes WHERE show_id=? AND idx>=?').bind(card.id, expected).run()
    out.trimmedTo = expected
  }
  out.complete = complete
  return out
}

export function needsEpisodes(card, existing) {
  const expected = expectedEpisodes(card)
  if (expected > 0) return expected > existing
  return existing === 0
}

export { J, S }
