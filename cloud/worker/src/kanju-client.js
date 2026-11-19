// 带签名的原站 API 客户端（Workers 版，WebCrypto 实现，逻辑与 server/kanju-client.mjs 一致）
export const SITE = 'https://kanju32.com'

const BASE_HEADERS = {
  'x-ai-movie-client-name': 'dianyingtiantang-frontend',
  'x-ai-movie-client-version': '1.0.0',
  'x-ai-movie-protocol-version': '2026-07-05.library-v2.playback-v1',
  'x-ai-movie-build-version': 'dianyingtiantang-v2026.11.12.3-worker-flag-fix-46f791897b69-web',
  accept: 'application/json',
  'accept-language': 'zh-CN,zh;q=0.9',
}

const enc = new TextEncoder()
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

let cachedKey = null
let cachedSecret = ''
async function keyFor(secret) {
  if (cachedKey && cachedSecret === secret) return cachedKey
  cachedKey = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  cachedSecret = secret
  return cachedKey
}

export async function sign(method, pathSearch, ts, nonce, secret) {
  const key = await keyFor(secret)
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${method}\n${pathSearch}\n${ts}\n${nonce}`)))
}

function nonceHex() {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return hex(b.buffer)
}

// 全局串行限速（同一 isolate 内有效）：原站对高频签名请求返回 401/429
const MIN_GAP = 160
let gate = Promise.resolve()
function throttle(gap = MIN_GAP) {
  const p = gate.then(() => new Promise((r) => setTimeout(r, gap)))
  gate = p.catch(() => {})
  return p
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function call(path, { method = 'GET', body, secret, retry = 4, timeout = 20000 } = {}) {
  if (!secret) throw new Error('缺少上游签名密钥')
  const u = new URL(path, SITE)
  let lastErr
  for (let attempt = 0; attempt < retry; attempt++) {
    await throttle()
    const ts = String(Date.now())
    const nonce = nonceHex()
    const headers = {
      ...BASE_HEADERS,
      'x-ai-movie-timestamp': ts,
      'x-ai-movie-nonce': nonce,
      'x-ai-movie-signature': await sign(method, u.pathname + u.search, ts, nonce, secret),
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    try {
      const res = await fetch(u.href, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      })
      const txt = await res.text()
      let json = null
      try {
        json = JSON.parse(txt)
      } catch {
        /* 非 JSON 原样返回 */
      }
      if (res.status >= 200 && res.status < 300) return json ?? txt
      lastErr = new Error(`HTTP ${res.status} ${u.pathname}: ${txt.slice(0, 160)}`)
      if (/playback_user_session_required|playback_line_level_required|login_required|level_required|需要登录|需要会员|等级不足/.test(txt)) {
        const fatal = new Error(`HTTP ${res.status} ${u.pathname}: ${txt.slice(0, 160)}`)
        fatal.body = txt
        fatal.fatal = true
        throw fatal
      }
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        await sleep(600 * Math.pow(2, attempt))
        continue
      }
      throw lastErr
    } catch (e) {
      if (e && e.fatal) throw e
      lastErr = e
      await sleep(800 * (attempt + 1))
    }
  }
  throw lastErr
}

export const api = {
  resolve: (id, secret) => call(`/v1/playback/resolve/${id}?view=compact`, { secret }),
  resolveLine: (ticket, secret) => call('/v1/playback/resolve-line', { method: 'POST', body: { ticket }, secret }),
}
