// zhuiju-web —— 静态站点网关：密码门 + API 转发
//
// 路由：
//   GET  /robots.txt   禁止收录（无需登录即可读，爬虫才看得见）
//   GET  /favicon*  /apple-touch-icon*  /manifest.webmanifest  /icons/*  图标与 manifest（无需登录，仅 GET/HEAD）
//   GET  /__login      密码页
//   POST /__login      校验密码 → 下发 HMAC 签名 cookie → 302 回首页
//   GET  /__logout     清 cookie
//   /api/*             需要 cookie；带 cookie 时经 service binding 转发给 kanju-api
//   其它               需要 cookie；带 cookie 时交给 ASSETS 处理
//
// 密码与密钥全部走 Worker secret（SITE_PASSWORD / COOKIE_SECRET），代码里没有任何明文。

const COOKIE_NAME = 'zj_auth'
const COOKIE_MAX_AGE = 365 * 24 * 3600 // 一年
const MAX_FAILS = 10 // 同 IP 连续错误次数上限
const LOCK_MS = 15 * 60 * 1000 // 锁定时长
const NOINDEX = { 'x-robots-tag': 'noindex, nofollow, noarchive' }

// 图标与 PWA manifest：浏览器 / iOS 主屏在未登录状态下就会抓，必须放在密码门前
const PUBLIC_ASSETS = new Set([
  '/manifest.webmanifest',
  '/favicon.ico',
  '/favicon-16x16.png',
  '/favicon-32x32.png',
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
])

function isPublicAsset(path) {
  if (PUBLIC_ASSETS.has(path)) return true
  if (path.startsWith('/favicon')) return true // 其它 favicon 变体
  if (path.startsWith('/icons/')) return true // manifest 里的 192/512 图标
  return false
}

const enc = new TextEncoder()

// ---------- 工具 ----------

function b64url(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function hmacSign(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg))
  return b64url(new Uint8Array(sig))
}

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text))
  return new Uint8Array(d)
}

// 定长比较，避免计时侧信道
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function cookieValue(request, name) {
  const raw = request.headers.get('cookie') || ''
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return ''
}

async function issueToken(env) {
  const exp = Date.now() + COOKIE_MAX_AGE * 1000
  return `${exp}.${await hmacSign(env.COOKIE_SECRET, `v1.${exp}`)}`
}

async function tokenValid(env, token) {
  if (!token || !env.COOKIE_SECRET) return false
  const i = token.indexOf('.')
  if (i <= 0) return false
  const exp = Number(token.slice(0, i))
  const sig = token.slice(i + 1)
  if (!Number.isFinite(exp) || exp <= Date.now()) return false
  return safeEqual(sig, await hmacSign(env.COOKIE_SECRET, `v1.${exp}`))
}

async function isAuthed(env, request) {
  return tokenValid(env, cookieValue(request, COOKIE_NAME))
}

// ---------- 失败计数（KV 优先，退化为 Cache API） ----------

function kvStore(ns) {
  return {
    async get(key) {
      return ns.get(key, 'json')
    },
    async put(key, value) {
      await ns.put(key, JSON.stringify(value), { expirationTtl: Math.ceil((LOCK_MS * 2) / 1000) })
    },
  }
}

function cacheStore() {
  const store = caches.default
  const url = (key) => `https://zj-rl.internal/${encodeURIComponent(key)}`
  return {
    async get(key) {
      const hit = await store.match(url(key))
      if (!hit) return null
      try {
        return await hit.json()
      } catch {
        return null
      }
    },
    async put(key, value) {
      await store.put(
        url(key),
        new Response(JSON.stringify(value), {
          headers: { 'content-type': 'application/json', 'cache-control': `max-age=${Math.ceil((LOCK_MS * 2) / 1000)}` },
        })
      )
    },
  }
}

function rlStore(env) {
  return env.RL && typeof env.RL.get === 'function' ? kvStore(env.RL) : cacheStore()
}

async function readState(env, ip) {
  const st = await rlStore(env).get(`rl:${ip}`)
  const fails = Number(st?.fails) || 0
  const until = Number(st?.until) || 0
  if (until && until <= Date.now()) return { fails: 0, until: 0 } // 锁已过期，重新计数
  return { fails, until }
}

async function writeState(env, ip, st) {
  await rlStore(env).put(`rl:${ip}`, st)
}

// ---------- 页面 ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function safeNext(raw) {
  const s = String(raw || '')
  // 只允许站内绝对路径，挡掉 //evil.com 这类协议相对跳转
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\')) return '/'
  return s
}

function tipHtml({ error = '', lockMinutes = 0, fails = 0 } = {}) {
  if (lockMinutes) return `<p class="err">尝试次数过多，已锁定，请 ${lockMinutes} 分钟后再试。</p>`
  if (!error) return ''
  const tail = fails ? `（已连续错误 ${fails}/${MAX_FAILS} 次）` : ''
  return `<p class="err">${esc(error)}${tail}</p>`
}

function loginPage({ next = '/', error = '', lockMinutes = 0, fails = 0 } = {}) {
  const tip = tipHtml({ error, lockMinutes, fails })
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>需要密码 · 阿噗影视</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  background:#0f1115;color:#e8eaed;padding:24px}
.card{width:100%;max-width:340px;background:#181b21;border:1px solid #262b33;border-radius:14px;padding:26px 24px}
h1{margin:0 0 6px;font-size:18px;font-weight:600}
p.sub{margin:0 0 18px;font-size:13px;color:#8b939f}
input[type=password]{width:100%;padding:11px 12px;font-size:15px;color:#e8eaed;background:#10131a;
  border:1px solid #2c323c;border-radius:9px;outline:none}
input[type=password]:focus{border-color:#4c8dff}
button{width:100%;margin-top:12px;padding:11px;font-size:15px;font-weight:600;color:#fff;
  background:#2f6fed;border:0;border-radius:9px;cursor:pointer}
button:active{background:#2860d0}
.err{margin:0 0 14px;font-size:13px;color:#ff6b6b;line-height:1.5}
</style>
</head>
<body>
<form class="card" method="post" action="/__login">
  <h1>阿噗影视</h1>
  <p class="sub">本站仅限私用，请输入访问密码</p>
  ${tip}
  <input type="password" name="password" inputmode="text" autocomplete="current-password"
         placeholder="访问密码" autofocus required>
  <input type="hidden" name="next" value="${esc(safeNext(next))}">
  <button type="submit">进入</button>
</form>
</body>
</html>`
}

function pageResponse({ status = 200, next, error, lockMinutes, fails } = {}) {
  return new Response(loginPage({ next, error, lockMinutes, fails }), {
    status,
    headers: {
      ...NOINDEX,
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    },
  })
}

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...NOINDEX, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

// ---------- 请求处理 ----------

async function handleLogin(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown'
  const st = await readState(env, ip)
  if (st.until) {
    const mins = Math.max(1, Math.ceil((st.until - Date.now()) / 60000))
    return pageResponse({ status: 429, lockMinutes: mins })
  }

  let form
  try {
    form = await request.formData()
  } catch {
    return pageResponse({ status: 400, error: '请求格式有误，请重试。' })
  }

  const next = safeNext(form.get('next'))
  const given = String(form.get('password') || '')

  // 密码比较走摘要，避免长度/前缀的计时差异
  const expected = env.SITE_PASSWORD ? await sha256(env.SITE_PASSWORD) : null
  const actual = await sha256(given)
  const ok = !!expected && safeEqual(b64url(expected), b64url(actual))

  if (!ok) {
    const fails = st.fails + 1
    const until = fails >= MAX_FAILS ? Date.now() + LOCK_MS : 0
    await writeState(env, ip, { fails, until })
    if (until) return pageResponse({ status: 429, lockMinutes: Math.ceil(LOCK_MS / 60000) })
    return pageResponse({ status: 401, next, error: '密码不正确，请重试。', fails })
  }

  if (st.fails) await writeState(env, ip, { fails: 0, until: 0 })

  const token = await issueToken(env)
  return new Response(null, {
    status: 302,
    headers: {
      ...NOINDEX,
      location: next,
      'cache-control': 'no-store',
      'set-cookie': `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`,
    },
  })
}

async function forwardApi(request, env) {
  const headers = new Headers(request.headers)
  // 不给上游留任何可能触发来源校验的头，也不把本站 cookie 带过去
  headers.delete('origin')
  headers.delete('referer')
  headers.delete('cookie')
  headers.delete('host')

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const init = { method: request.method, headers, redirect: 'manual' }
  if (hasBody) {
    init.body = request.body
    init.duplex = 'half'
  }
  const upstream = new Request(request.url, init)

  let res
  try {
    res = await env.API.fetch(upstream)
  } catch (e) {
    return jsonResponse(502, { error: 'upstream_unreachable', detail: String(e && e.message ? e.message : e) })
  }

  const out = new Headers(res.headers)
  for (const [k, v] of Object.entries(NOINDEX)) out.set(k, v)
  return new Response(res.body, { status: res.status, headers: out })
}

export default {
  async fetch(request, env) {
    let url
    try {
      url = new URL(request.url)
    } catch {
      return jsonResponse(400, { error: 'bad_request' })
    }
    const path = url.pathname
    const method = request.method

    // 收录拦截：无需登录，爬虫才拿得到
    if (path === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /\n', {
        headers: { ...NOINDEX, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' },
      })
    }
    // 图标 / manifest：匿名可读，但不带任何站点内容（也不下发 cookie）
    if (isPublicAsset(path)) {
      if (method !== 'GET' && method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405, headers: { ...NOINDEX, allow: 'GET, HEAD' } })
      }
      const asset = await env.ASSETS.fetch(request)
      const headers = new Headers(asset.headers)
      for (const [k, v] of Object.entries(NOINDEX)) headers.set(k, v)
      headers.set('cache-control', 'public, max-age=86400')
      return new Response(asset.body, { status: asset.status, headers })
    }

    if (path === '/__login') {
      if (method === 'POST') return handleLogin(request, env)
      if (method === 'GET' || method === 'HEAD') {
        if (await isAuthed(env, request)) {
          return new Response(null, { status: 302, headers: { ...NOINDEX, location: safeNext(url.searchParams.get('next')), 'cache-control': 'no-store' } })
        }
        return pageResponse({ next: safeNext(url.searchParams.get('next')) })
      }
      return new Response('Method Not Allowed', { status: 405, headers: { ...NOINDEX, allow: 'GET, POST' } })
    }

    if (path === '/__logout') {
      return new Response(null, {
        status: 302,
        headers: {
          ...NOINDEX,
          location: '/__login',
          'cache-control': 'no-store',
          'set-cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
        },
      })
    }

    const authed = await isAuthed(env, request)

    // 接口：未登录一律 401 JSON
    if (path === '/api' || path.startsWith('/api/')) {
      if (!authed) return jsonResponse(401, { error: 'unauthorized' })
      return forwardApi(request, env)
    }

    if (!authed) return pageResponse({ next: path + url.search })

    if (method !== 'GET' && method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { ...NOINDEX, allow: 'GET, HEAD' } })
    }

    // 已登录：静态资源交给 ASSETS
    const res = await env.ASSETS.fetch(request)
    const out = new Headers(res.headers)
    for (const [k, v] of Object.entries(NOINDEX)) out.set(k, v)
    return new Response(res.body, { status: res.status, headers: out })
  },
}
