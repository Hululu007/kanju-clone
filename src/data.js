// 片库数据层：数据来自 server/kanju-crawl.mjs 抓取的原站公开片库，
// 由 server/kanju-export.mjs 导出为 catalog.gen.js。
// 采集流程：node server/kanju-crawl.mjs  →  node server/kanju-export.mjs
import catalog from './catalog.gen.js'

export const CATS = {
  tv: '电视剧',
  anime: '动漫',
  movie: '电影',
  variety: '综艺',
}

export const CAT_KEYS = ['tv', 'anime', 'variety', 'movie']

const HUES = [4, 14, 22, 30, 38, 206, 214, 222, 230, 238, 196, 188, 26, 12, 210, 220, 342, 352]

const fmtHeat = (n) => {
  const v = Number(n) || 0
  if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + '万'
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(Math.round(v))
}

const badgeOf = (s) => {
  if (s.remarks) return s.remarks
  const n = s.episodes?.length || 0
  if (n > 1) return `全${n}集`
  return s.year ? `${s.year} · 正片` : '正片'
}

// 会员片源单独用角标提示，不挤占更新状态的位置
export const vipOf = (s) => !!s.availability && s.availability.state === 'login_required'

// 没有标题、没有分集的条目直接丢掉
const usable = (s) => {
  const t = String(s.title || '').trim()
  if (!t) return false
  if (!s.episodes || !s.episodes.length) return false
  return true
}

export const shows = catalog
  .filter(usable)
  .map((s, i) => ({
    id: s.id,
    title: s.title,
    originalTitle: s.originalTitle || '',
    cat: s.cat,
    kindLabel: s.kindLabel || CATS[s.cat] || '影视',
    area: s.area || '中国大陆',
    language: s.language || '国语',
    genres: s.genres && s.genres.length ? s.genres : ['剧情'],
    actors: s.actors || [],
    directors: s.directors || [],
    badge: badgeOf(s),
    headline: s.headline || '',
    remarks: s.remarks || '',
    heat: fmtHeat(s.heatValue || 0),
    heatValue: s.heatValue || 0,
    playbackCount: s.playbackCount || 0,
    year: s.year || '',
    poster: s.poster,
    backdrop: s.backdrop,
    synopsis: s.synopsis || '',
    desc: s.desc || s.synopsis || '',
    episodeCount: s.episodeCount || (s.episodes || []).length,
    availableEpisodeCount: s.availableEpisodeCount || (s.episodes || []).length,
    playableCount: s.playableCount || 0,
    episodes: s.episodes,
    groups: s.groups || [],
    availability: s.availability,
    vip: !!s.availability && s.availability.state === 'login_required',
    updatedAt: s.updatedAt || '',
    hue: HUES[i % HUES.length],
    day: (i % 7) + 1,
    seed: i,
  }))

const byCat = (c) => shows.filter((s) => s.cat === c)

export const catCount = (cat) => byCat(cat).length

// 首页周历：按真实片库的更新分布摊到 7 天
export const WEEK = (() => {
  const now = new Date()
  const wd = (now.getDay() + 6) % 7 // 周一 = 0
  const base = new Date(now)
  base.setDate(now.getDate() - wd)
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(base)
    d.setDate(base.getDate() + i)
    const counts = {}
    for (const k of CAT_KEYS) {
      const pool = byCat(k).length
      const jitter = 0.72 + ((i * 37 + k.length * 13) % 60) / 100
      counts[k] = Math.max(1, Math.round((pool / 7) * jitter))
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    return {
      day: i + 1,
      label: '周' + '一二三四五六日'[i],
      date: d.getDate(),
      today: d.toDateString() === now.toDateString(),
      total,
      counts,
    }
  })
})()

export const TODAY = WEEK.find((w) => w.today)?.day || 1

export function weekRange() {
  const a = WEEK[0]
  const b = WEEK[6]
  const m = new Date().getMonth() + 1
  return `${m}月${a.date}日 - ${m}月${b.date}日`
}

export function categoryItems(cat, day, limit = 4) {
  const pool = byCat(cat)
  if (!pool.length) return []
  const off = (day - TODAY + pool.length) % pool.length
  return Array.from({ length: Math.min(limit, pool.length) }, (_, i) => pool[(off + i) % pool.length])
}

const hottestFirst = (a, b) => (b.heatValue || 0) - (a.heatValue || 0)
const newestFirst = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))
const byArea = (area) => shows.filter((s) => s.cat === 'tv' && s.area === area)
const byKinds = (...cats) => shows.filter((s) => cats.includes(s.cat))
const byMovieGenre = (pattern) => shows.filter((s) => s.cat === 'movie' && s.genres.some((genre) => pattern.test(genre)))
const byAnimeSeries = () => shows.filter((s) =>
  s.cat === 'anime' &&
  s.episodeCount >= 12 &&
  !s.genres.some((genre) => /电影|有声动漫/.test(genre))
)
export const ROWS = [
  { id: 'hot', title: '大家都在看', sub: '站内热度持续攀升的热门影视', items: [...shows].sort(hottestFirst).slice(0, 10), pool: 'all' },
  { id: 'kr', title: '韩剧在追', sub: '韩国热播剧集', items: byArea('韩国').sort(hottestFirst).slice(0, 10), pool: 'kr' },
  { id: 'jp', title: '日剧上新', sub: '日本新剧与热门剧集', items: byArea('日本').sort(newestFirst).slice(0, 10), pool: 'jp' },
  { id: 'us', title: '美剧续看', sub: '美国剧集持续更新', items: byArea('美国').sort(newestFirst).slice(0, 10), pool: 'us' },
  { id: 'cn', title: '国产新剧', sub: '国产剧集近期上新', items: byArea('中国大陆').sort(newestFirst).slice(0, 10), pool: 'cn' },
  { id: 'movie-high', title: '高分电影', sub: '口碑与播放热度兼顾的电影', items: byKinds('movie').sort((a, b) => (b.playbackCount || 0) - (a.playbackCount || 0)).slice(0, 10), pool: 'movie-high' },
  { id: 'movie-hot', title: '电影热播', sub: '正在热播的电影', items: byKinds('movie').sort(hottestFirst).slice(0, 10), pool: 'movie-hot' },
  { id: 'theater', title: '院线热映', sub: '院线与近期上映影片', items: byMovieGenre(/院线|上映/).sort(newestFirst).slice(0, 10), pool: 'theater' },
  { id: 'anime-series', title: '动画连载', sub: '持续更新的动画剧集', items: byAnimeSeries().sort(hottestFirst).slice(0, 10), pool: 'anime-series' },
].filter((r) => r.items.length)

export const allByPool = (pool) => {
  if (pool === 'all') return shows
  if (pool === 'kr') return byArea('韩国')
  if (pool === 'jp') return byArea('日本')
  if (pool === 'us') return byArea('美国')
  if (pool === 'cn') return byArea('中国大陆')
  if (pool === 'movie-high') return byKinds('movie').sort((a, b) => (b.playbackCount || 0) - (a.playbackCount || 0))
  if (pool === 'movie-hot') return byKinds('movie').sort(hottestFirst)
  if (pool === 'theater') return byMovieGenre(/院线|上映/)
  if (pool === 'anime-series') return byAnimeSeries()
  return byCat(pool)
}

export function findShow(id) {
  // 找不到就返回 undefined：播放页会回源到后端，避免静默显示成第一部片
  return shows.find((s) => s.id === id)
}

export function episodesFor(show) {
  return (show.episodes || []).map((e) => e.idx)
}

export function episodeOf(show, idx) {
  return (show.episodes || []).find((e) => e.idx === Number(idx)) || null
}

// 站内搜索：标题 / 演员 / 题材 都能命中
export function searchShows(q, cat = null) {
  const k = String(q || '').trim().toLowerCase()
  const pool = cat ? byCat(cat) : shows
  if (!k) return pool
  return pool.filter((s) =>
    s.title.toLowerCase().includes(k) ||
    String(s.year).includes(k) ||
    s.genres.some((g) => String(g).toLowerCase().includes(k)) ||
    s.actors.some((a) => String(a).includes(k)) ||
    s.directors.some((a) => String(a).includes(k)) ||
    String(s.synopsis).includes(k)
  )
}
