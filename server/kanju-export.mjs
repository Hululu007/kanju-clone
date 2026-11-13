// 把抓取到的原站片库（server/data/kanju.db）导出成前端可直接用的 src/catalog.gen.js
const updatedText = (v) => { if (!v) return null; if (typeof v !== 'string') return v; if (v[0] !== '{') return v; try { const o = JSON.parse(v); return o.display_text || o.text || null } catch { return v } }

import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DB_PATH = fileURLToPath(new URL('./data/kanju.db', import.meta.url))
const OUT = fileURLToPath(new URL('../src/catalog.gen.js', import.meta.url))

const db = new DatabaseSync(DB_PATH)
const parse = (v, d) => { try { const x = JSON.parse(v ?? 'null'); return x ?? d } catch { return d } }

const KIND = {
  series: ['tv', '电视剧'],
  movie: ['movie', '电影'],
  anime: ['anime', '动漫'],
  animation: ['anime', '动漫'],
  variety: ['variety', '综艺'],
  short_drama: ['tv', '短剧'],
  documentary: ['variety', '纪录片'],
}

const rows = db.prepare(`
  SELECT s.*, (SELECT COUNT(*) FROM episodes e WHERE e.show_id = s.id AND e.stream IS NOT NULL) AS playable,
         (SELECT COUNT(*) FROM episodes e WHERE e.show_id = s.id) AS ep_rows
  FROM shows s
  WHERE EXISTS (SELECT 1 FROM episodes e WHERE e.show_id = s.id)
  ORDER BY COALESCE(s.heat_value, 0) DESC, s.title
`).all()

const epStmt = db.prepare('SELECT idx,number,key,title,token,quality,line_label,provider,stream,stream_kind FROM episodes WHERE show_id=? ORDER BY idx')

const shows = []
for (const r of rows) {
  const eps = epStmt.all(r.id)
  const [cat, kindLabel] = KIND[r.content_kind] || ['tv', '影视']
  const playableEps = eps.filter(e => e.stream)
  // 静态包里只留集号/标题，直链只留第一集做兜底（其余靠本地片源服务现场解析），
  // 否则 3.7 万集的地址会把首屏数据撑到十几 MB。
  // 顺序就是原站列表顺序：idx 是分页数组里的位置，label 用「第几集」的连续序号。
  // 有些综艺/多季剧的 number 会从 1 重新开始，直接用 number 会重号，所以统一按顺序编号。
  const seqOk = eps.every((e, i) => Number(e.number) === i + 1)
  const labelOf = (e, i) => (e.title && !/^\s*$/.test(e.title)
    ? e.title
    : `第${seqOk ? e.number : i + 1}集`)
  const slimEp = (e, i) => (i === 0
    ? { idx: e.idx, label: labelOf(e, i), url: e.stream || '', quality: e.quality || '', line: e.line_label || '', kind: e.stream_kind || '' }
    : { idx: e.idx, label: labelOf(e, i) })

  shows.push({
    id: r.id,
    title: r.title,
    originalTitle: r.normalized_title && r.normalized_title !== r.title ? '' : '',
    year: r.year || '',
    cat,
    kind: cat,
    kindLabel,
    area: r.area || '中国大陆',
    language: r.language || '国语',
    genres: parse(r.genres, []).slice(0, 6),
    actors: parse(r.actors, []).slice(0, 8),
    directors: parse(r.directors, []).slice(0, 3),
    remarks: r.remarks || r.episode_progress || '',
    headline: [r.area, r.year ? r.year + '年' : '', kindLabel].filter(Boolean).join(' · '),
    synopsis: r.description || '',
    desc: r.description || '',
    poster: r.poster || '',
    backdrop: r.backdrop || '',
    heatValue: r.heat_value || 0,
    playbackCount: r.playback_count || 0,
    updatedAt: updatedText(r.updated_at) || '',
    episodeCount: r.episode_count || eps.length,
    availableEpisodeCount: r.available_episode_count || eps.length,
    playableCount: playableEps.length,
    availability: availabilityOf(r, playableEps),
    groups: [{
      id: 'yjplayer',
      label: '网页播放器',
      type: 'player',
      episodeCount: eps.length,
      episodes: eps.map((e, i) => slimEp(e, i)),
    }],
    // 兼容旧播放器结构：eps 直接用第一条线路
    episodes: eps.map((e, i) => slimEp(e, i)),
  })
}

// 可播状态：play_state 来自 server/kanju-resolve.mjs 的实测（公开可播 / 需登录 / 解析失败）
function availabilityOf(row, playableEps) {
  const st = row.play_state || ''
  if (st === 'playable') return { state: 'playable', label: '可播放', playable: true }
  if (st === 'login_required') return { state: 'login_required', label: '需会员', playable: false }
  if (playableEps.length) return { state: 'playable', label: '可播放', playable: true }
  if (st === 'error') return { state: 'error', label: '片源异常', playable: false }
  return { state: 'pending', label: '待更新', playable: false }
}

const body = `// 由 server/kanju-export.mjs 从 server/data/kanju.db 生成，请勿手改。\n// 数据来源：kanju32.com 公开片库元数据 + 公开播放线路（不下载、不转存视频文件）。\nexport default ${JSON.stringify(shows)}\n`
writeFileSync(OUT, body, 'utf8')

const stat = {
  shows: shows.length,
  episodes: shows.reduce((a, s) => a + s.episodes.length, 0),
  playable: shows.reduce((a, s) => a + s.playableCount, 0),
  noStream: shows.filter(s => !s.playableCount).length,
  bytes: Buffer.byteLength(body),
}
console.log('导出', JSON.stringify(stat))
console.log('示例', shows.slice(0, 3).map(s => `${s.title}(${s.kindLabel},${s.year},${s.episodes.length}集,可播${s.playableCount})`).join(' | '))
