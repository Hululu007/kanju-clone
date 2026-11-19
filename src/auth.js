import { proxyReady, PROXY } from './runtime.js'

const TOKEN_KEY = 'kj-auth-token'
const USER_KEY = 'kj-auth-user'
const HISTORY_KEY = 'kj-history'
const PROGRESS_KEY = 'kj-progress'
const SAVE_INTERVAL_MS = 30000

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback
  } catch {
    return fallback
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}

let token = ''
let cachedUser = readJson(USER_KEY, null)
let queuedProgress = null
let flushTimer = null
let lastRemoteSaveAt = 0

try {
  token = localStorage.getItem(TOKEN_KEY) || ''
} catch {}

export function getToken() {
  return token
}

export function getCachedUser() {
  return cachedUser
}

function announce() {
  window.dispatchEvent(new CustomEvent('kj-auth-changed', { detail: { user: cachedUser } }))
}

function setAuth(nextToken, user, { silent = false } = {}) {
  token = nextToken || ''
  cachedUser = user || null
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {}
  if (user) writeJson(USER_KEY, user)
  else {
    try {
      localStorage.removeItem(USER_KEY)
    } catch {}
  }
  if (!silent) announce()
}

export function clearGuestCache() {
  try {
    localStorage.removeItem(HISTORY_KEY)
    localStorage.removeItem(PROGRESS_KEY)
  } catch {}
}

async function api(path, { method = 'GET', body, authenticated = true, timeout = 20000 } = {}) {
  await proxyReady
  if (!PROXY) throw new Error('片源服务暂不可用')
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (authenticated && token) headers.authorization = `Bearer ${token}`
  const response = await fetch(PROXY + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(timeout),
  })
  const data = await response.json().catch(() => ({}))
  if (response.status === 401 && authenticated) {
    clearGuestCache()
    setAuth('', null)
  }
  if (!response.ok) {
    const error = new Error(data.error || `请求失败（${response.status}）`)
    error.status = response.status
    throw error
  }
  return data
}

function localProgressItems() {
  const ids = readJson(HISTORY_KEY, [])
  const progress = readJson(PROGRESS_KEY, {})
  const seen = new Set()
  const items = []
  const push = (showId) => {
    const value = progress[showId] || {}
    items.push({
      showId,
      idx: Math.max(0, Number(value.idx) || 0),
      position: Math.max(0, Number(value.position) || 0),
      duration: value.duration ? Number(value.duration) : null,
    })
  }
  ids.forEach((showId) => {
    if (!showId || seen.has(showId)) return
    seen.add(showId)
    push(showId)
  })
  Object.keys(progress).forEach((showId) => {
    if (!showId || seen.has(showId)) return
    seen.add(showId)
    push(showId)
  })
  return items.slice(0, 100)
}

async function migrateGuestProgress() {
  const items = localProgressItems()
  if (!items.length) return
  await api('/api/user/progress/bulk', { method: 'POST', body: { items } })
  clearGuestCache()
}

export const authReady = (async () => {
  if (!token) return null
  try {
    await proxyReady
    const data = await api('/api/auth/me')
    setAuth(token, data.user)
    return data.user
  } catch {
    return cachedUser
  }
})()

export async function registerAccount(username, password) {
  const data = await api('/api/auth/register', {
    method: 'POST',
    body: { username, password },
    authenticated: false,
  })
  setAuth(data.token, data.user, { silent: true })
  await migrateGuestProgress().catch(() => {})
  announce()
  return data.user
}

export async function loginAccount(username, password) {
  const data = await api('/api/auth/login', {
    method: 'POST',
    body: { username, password },
    authenticated: false,
  })
  setAuth(data.token, data.user, { silent: true })
  await migrateGuestProgress().catch(() => {})
  announce()
  return data.user
}

export async function logoutAccount() {
  if (token) await api('/api/auth/logout', { method: 'POST' }).catch(() => {})
  clearGuestCache()
  setAuth('', null)
}

export async function fetchUserProgress(showId = '', limit = 100) {
  if (!token) return []
  const query = new URLSearchParams({ limit: String(limit) })
  if (showId) query.set('show', showId)
  const data = await api(`/api/user/progress?${query}`).catch(() => null)
  return data?.items || []
}

export async function fetchShowProgress(showId) {
  const items = await fetchUserProgress(showId, 1)
  return items[0] || null
}

async function flushProgress() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (!queuedProgress || !token) return false
  const item = queuedProgress
  queuedProgress = null
  try {
    await api('/api/user/progress', { method: 'PUT', body: item, timeout: 12000 })
    lastRemoteSaveAt = Date.now()
    return true
  } catch {
    if (!queuedProgress) queuedProgress = item
    return false
  }
}

export function saveProgress(item, { force = false } = {}) {
  if (!token || !item?.showId) return Promise.resolve(false)
  queuedProgress = {
    showId: item.showId,
    idx: Math.max(0, Number(item.idx) || 0),
    position: Math.max(0, Number(item.position) || 0),
    duration: Number(item.duration) > 0 ? Number(item.duration) : null,
  }
  if (force) return flushProgress()
  const wait = Math.max(0, SAVE_INTERVAL_MS - (Date.now() - lastRemoteSaveAt))
  if (wait === 0) return flushProgress()
  if (!flushTimer) flushTimer = setTimeout(() => void flushProgress(), wait)
  return Promise.resolve(false)
}

export function flushSavedProgress() {
  return flushProgress()
}
