// 后端接口层：指向部署在 Cloudflare Workers + D1 的 kanju-api。
// 构建时用 VITE_API_BASE 注入（例如 https://kanju-api.<subdomain>.workers.dev）。
// 没配置时 apiOn=false，页面完全走打包进来的静态片库（GitHub Pages 兜底）。
const RAW = (import.meta.env.VITE_API_BASE || '').trim().replace(/\/+$/, '')

export const API_BASE = RAW
export const apiOn = Boolean(RAW)

async function get(path, timeout = 6000) {
  if (!apiOn) return null
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeout)
  try {
    const r = await fetch(RAW + path, { signal: ctl.signal, headers: { accept: 'application/json' } })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

// 首页频道流（原站 /v1/feed/home 同构）
export function apiFeed({ sections = 3, cards = 10 } = {}) {
  return get(`/v1/feed/home?sections=${sections}&cards=${cards}&scope=public`)
}

// 影片详情（原站 /v1/catalog/:id 同构），返回中文简介与分段片源
export function apiDetail(id) {
  return get(`/v1/catalog/${encodeURIComponent(id)}`)
}

// 搜索建议
export function apiSuggest(q, limit = 12) {
  return get(`/v1/suggest?q=${encodeURIComponent(q)}&limit=${limit}`)
}

// 服务状态
export function apiHealth() {
  return get('/api/health', 3000)
}
