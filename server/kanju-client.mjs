// 带签名的原站 API 客户端（签名算法由 REA 从 movie-card-runtime bundle 反解，见 kanju-rea/README）
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const SITE = 'https://kanju32.com'
const SECRET = '557d0e4ae929f438da6bd84412374e6086b8af09b3fed54bf22601d5bf8c54a0'
const BASE_HEADERS = {
  'x-ai-movie-client-name': 'dianyingtiantang-frontend',
  'x-ai-movie-client-version': '1.0.0',
  'x-ai-movie-protocol-version': '2026-07-05.library-v2.playback-v1',
  'x-ai-movie-build-version': 'dianyingtiantang-v2026.11.12.3-worker-flag-fix-46f791897b69-web',
  accept: 'application/json',
  'accept-language': 'zh-CN,zh;q=0.9',
}

// 消息格式：`${METHOD}\n${pathname}${search}\n${ts}\n${nonce}`，HMAC-SHA256 → 小写 hex
export function sign(method, pathSearch, ts, nonce, secret = SECRET) {
  return crypto.createHmac('sha256', secret).update(`${method}\n${pathSearch}\n${ts}\n${nonce}`).digest('hex')
}

// 全局限速：原站对高频签名请求会返回 401/429，这里串行化排队，默认约 6 请求/秒
const MIN_GAP = Number(process.env.KANJU_MIN_GAP || 160)
let gate = Promise.resolve()
function throttle() {
  const p = gate.then(() => new Promise(r => setTimeout(r, MIN_GAP)))
  gate = p.catch(() => {})
  return p
}

export async function call(path, { method = 'GET', body, retry = 5, timeout = 25000 } = {}) {
  const u = new URL(path, SITE)
  let lastErr
  for (let attempt = 0; attempt < retry; attempt++) {
    await throttle()
    const ts = String(Date.now())
    const nonce = crypto.randomBytes(16).toString('hex')
    const headers = {
      ...BASE_HEADERS,
      'x-ai-movie-timestamp': ts,
      'x-ai-movie-nonce': nonce,
      'x-ai-movie-signature': sign(method, u.pathname + u.search, ts, nonce),
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    try {
      const res = await fetch(u, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) })
      const txt = await res.text()
      let json = null
      try { json = JSON.parse(txt) } catch { /* 非 JSON 原样返回 */ }
      if (res.status >= 200 && res.status < 300) return json ?? txt
      lastErr = new Error(`HTTP ${res.status} ${u.pathname}: ${txt.slice(0, 160)}`)
      // 会员/登录限制是确定性结果，重试只会让人干等
      if (/playback_user_session_required|login_required|需要登录|需要会员/.test(txt)) {
        const fatal = new Error(`HTTP ${res.status} ${u.pathname}: ${txt.slice(0, 160)}`)
        fatal.body = txt
        fatal.fatal = true
        throw fatal
      }
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        await new Promise(r => setTimeout(r, 600 * Math.pow(2, attempt)))
        continue
      }
      throw lastErr
    } catch (e) {
      if (e && e.fatal) throw e
      lastErr = e
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)))
    }
  }
  throw lastErr
}

export const api = {
  bootstrap: () => call('/v1/runtime/bootstrap'),
  announcements: () => call('/v1/announcements/manifest'),
  feed: (sections = 11, cards = 20) => call(`/v1/feed/home?scope=public&mode=preview&sections=${sections}&cards=${cards}`),
  browse: (params = {}) => {
    const q = new URLSearchParams({ scope: 'public', sort: 'heat_desc', limit: '24', offset: '0', ...params })
    return call('/v1/browse/catalog?' + q.toString())
  },
  detail: (id) => call(`/v1/catalog/${id}`),
  episodes: (id, limit = 48, offset = 0) => call(`/v1/catalog/${id}/episodes?limit=${limit}&offset=${offset}`),
  resolve: (id) => call(`/v1/playback/resolve/${id}?view=compact`),
  calendarSummary: (week = 'current') => call(`/v1/watch-calendar/summary?week=${week}`),
  calendar: (params = {}) => {
    const q = new URLSearchParams({ week: 'current', sort: 'heat', limit: '12', ...params })
    return call('/v1/watch-calendar?' + q.toString())
  },
  suggest: (q) => call(`/v1/suggest?` + new URLSearchParams({ q, limit: '8', mode: 'home', scope: 'public' }).toString()),
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2] || '/v1/runtime/bootstrap'
  const out = await call(path)
  console.log(JSON.stringify(out).slice(0, 1200))
}
