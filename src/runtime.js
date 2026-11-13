// 片源服务（本地 node server/proxy.mjs）探测与现场解析
// 静态站点上的视频直链会过期，播放时优先向本地片源服务换一条新的。
const CANDIDATES = [
  import.meta.env.VITE_PROXY_BASE,
  (typeof localStorage !== 'undefined' && localStorage.getItem('kj-proxy')) || '',
  'http://127.0.0.1:8899',
].filter(Boolean)

export let PROXY = ''
export let proxyInfo = null

export const proxyReady = (async () => {
  for (const raw of CANDIDATES) {
    const base = String(raw).replace(/\/+$/, '')
    try {
      const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(1800) })
      if (!r.ok) continue
      const j = await r.json()
      if (j && j.ok) { PROXY = base; proxyInfo = j; return j }
    } catch { /* 下一个 */ }
  }
  return null
})()

export async function resolvePlay(showId, idx) {
  if (!PROXY) return null
  try {
    const r = await fetch(`${PROXY}/api/play?show=${encodeURIComponent(showId)}&ep=${idx}`, { signal: AbortSignal.timeout(15000) })
    const j = await r.json().catch(() => null)
    if (!r.ok || !j || j.error) {
      // 把原因带给播放页：会员片 / 线路异常要分开提示
      const reason = String(j?.error || '')
      return { error: /login_required|会员|登录/.test(reason) ? 'login_required' : 'unavailable', detail: reason }
    }
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
