// 片源服务（本地 node server/proxy.mjs）探测与现场解析
// 静态站点上的视频直链会过期，播放时优先向本地片源服务换一条新的。
// Cloudflare Worker 后端（D1），线上默认走它；本机 8899 仅作本地开发兜底
const DEFAULT_PROXY = 'https://kanju-api.kenzhao123.workers.dev'

const CANDIDATES = [
  import.meta.env.VITE_PROXY_BASE,
  (typeof localStorage !== 'undefined' && localStorage.getItem('kj-proxy')) || '',
  DEFAULT_PROXY,
  'http://127.0.0.1:8899',
].filter(Boolean)

export let PROXY = ''
export let proxyInfo = null

export const proxyReady = (async () => {
  for (const raw of CANDIDATES) {
    const base = String(raw).replace(/\/+$/, '')
    try {
      const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(5000) })
      if (!r.ok) continue
      const j = await r.json()
      if (j && j.ok) { PROXY = base; proxyInfo = j; return j }
    } catch { /* 下一个 */ }
  }
  return null
})()

export async function resolvePlay(showId, idx, line = '') {
  if (!PROXY) return null
  try {
    const extra = line ? `&line=${encodeURIComponent(line)}` : ''
    // 官方线路要二次换 ticket，慢的时候会超过 15 秒
    const r = await fetch(`${PROXY}/api/play?show=${encodeURIComponent(showId)}&ep=${idx}${extra}`, { signal: AbortSignal.timeout(60000) })
    const j = await r.json().catch(() => null)
    if (!r.ok || !j || j.error) {
      // 把原因带给播放页：会员片 / 线路异常要分开提示
      const reason = String(j?.error || '')
      return { error: /login_required|level_required|会员|登录|等级不足/.test(reason) ? 'login_required' : 'unavailable', detail: reason }
    }
    return j
  } catch { return null }
}

// 原站该集的可选线路（官方 / 普通）
export async function fetchLines(showId, idx) {
  if (!PROXY) return null
  try {
    const r = await fetch(`${PROXY}/api/lines?show=${encodeURIComponent(showId)}&ep=${idx}`, { signal: AbortSignal.timeout(30000) })
    const j = await r.json().catch(() => null)
    if (!r.ok || !j || j.error) return null
    return j
  } catch { return null }
}

export async function proxyShow(id) {
  if (!PROXY) return null
  try {
    const r = await fetch(`${PROXY}/api/show?id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8000) })
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

export async function proxyShowFresh(id) {
  try {
    const r = await fetch(`${DEFAULT_PROXY}/api/show?id=${encodeURIComponent(id)}&v=live`, {
      signal: AbortSignal.timeout(12000),
      cache: 'no-store',
    })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

// 动态列表（首页「最新上线」用）
export async function proxyList({ sort = 'updated', cat = '', area = '', genre = '', q = '', minEpisodes = 0, limit = 12, page = 1 } = {}) {
  if (!PROXY) return null
  try {
    const params = new URLSearchParams({ sort, limit: String(limit), page: String(page) })
    if (cat) params.set('cat', cat)
    if (area) params.set('area', area)
    if (genre) params.set('genre', genre)
    // 关键词必须带给后端，否则搜索会被当成普通列表请求（只按热度返回，搜不到目标影片）
    const keyword = String(q || '').trim()
    if (keyword) params.set('q', keyword)
    if (minEpisodes > 0) params.set('minEpisodes', String(minEpisodes))
    const r = await fetch(`${PROXY}/api/list?${params}`, { signal: AbortSignal.timeout(12000), cache: 'no-store' })
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

export async function proxyHomeCalendar() {
  if (!PROXY) return null
  try {
    const r = await fetch(`${PROXY}/api/home-calendar`, { signal: AbortSignal.timeout(15000) })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

export async function proxyHomeFeed() {
  try {
    const r = await fetch(`${DEFAULT_PROXY}/api/home-feed?v=5`, { signal: AbortSignal.timeout(15000), cache: 'no-store' })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

// ---- 弹幕 ----
export async function fetchDanmaku(showId, idx) {
  if (!PROXY) return null
  try {
    const r = await fetch(`${PROXY}/api/danmaku?show=${encodeURIComponent(showId)}&ep=${idx}`, { signal: AbortSignal.timeout(10000) })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

export async function sendDanmaku(showId, idx, t, text) {
  if (!PROXY) return false
  try {
    const r = await fetch(`${PROXY}/api/danmaku?show=${encodeURIComponent(showId)}&ep=${idx}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ showId, idx, t, text, device: 'web' }),
      signal: AbortSignal.timeout(10000),
    })
    return r.ok
  } catch {
    return false
  }
}

// 讨论区
export async function fetchComments(showId, offset = 0, limit = 30) {
  if (!PROXY) return null
  try {
    const r = await fetch(
      `${PROXY}/api/comments?show=${encodeURIComponent(showId)}&limit=${limit}&offset=${offset}`,
      { signal: AbortSignal.timeout(15000) }
    )
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}
