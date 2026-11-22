// kanju-api —— Cloudflare Worker 版片源服务（D1）
import { syncOnce } from './sync.js'
import { syncHomeFeed, syncHotRanks } from './feed-sync.js'
import { createCountedFetch, inspectHlsResource } from './playback-probe.js'
import { mediaDimensions, readBounded } from './media-dimensions.js'
import { isSoftProbeFailure, probeCandidates, probeStatus, selectPlayable } from './source-selection.js'
import { createProbeBudget } from './probe-budget.js'
import { orderLines } from './line-order.js'
import { issuePlaybackAttempt, verifyPlaybackAttempt } from './playback-attempt.js'
import { applyOriginDefault, loadOriginDefault, markOriginDefault, mergeOriginRetry, pickOriginDefaultEpisode, planOriginRetry } from './origin-default.js'
import { lineKey, matchesLineKey } from './line-key.js'
// 契约与本地 server/proxy.mjs 一致：/api/health /api/list /api/show /api/lines /api/play /api/audit /api/progress
const SITE = 'https://kanju32.com'
const BUILD = 'dianyingtiantang-v2026.11.12.3-worker-flag-fix-46f791897b69-web'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const PROVIDER_PRIORITY = ['hongniu','xinlang','hhzy','subo','jinying','jszy','iqiyi','mdzy','xigua','wsyzy','ikun','bfzy','uku','dytt','maotai','wujin','maoyan','zuida','niuniu','zy360','ffzy','suoni','yyzy1080']
const priorityOf = (p) => {
  const i = PROVIDER_PRIORITY.indexOf(p)
  return i < 0 ? 90 : i
}
const isOfficial = (p) => /^(official|bytevod|bytedance)/i.test(String(p || ''))

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,authorization',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-max-age': '86400',
}
const json = (data, status = 200, cacheControl = 'no-store') =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': cacheControl } })

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
const sha = async (value) => {
  const bytes = value instanceof ArrayBuffer || ArrayBuffer.isView(value)
    ? value
    : new TextEncoder().encode(String(value))
  return hex(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 16)
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)))
}

function safeEqual(a, b) {
  const left = new TextEncoder().encode(String(a))
  const right = new TextEncoder().encode(String(b))
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i]
  return diff === 0
}

// ---------- 上游调用 ----------
let gate = Promise.resolve()
const MIN_GAP = 120
function throttle() {
  const p = gate.then(() => new Promise((r) => setTimeout(r, MIN_GAP)))
  gate = p.catch(() => {})
  return p
}

async function signedFetch(env, path, { method = 'GET', body, cookie = '', timeout = 20000, signal, budget } = {}) {
  const u = new URL(path, SITE)
  const ts = String(Date.now())
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')
  const headers = {
    'x-ai-movie-client-name': 'dianyingtiantang-frontend',
    'x-ai-movie-client-version': '1.0.0',
    'x-ai-movie-protocol-version': '2026-07-05.library-v2.playback-v1',
    'x-ai-movie-build-version': BUILD,
    'x-ai-movie-timestamp': ts,
    'x-ai-movie-nonce': nonce,
    'x-ai-movie-signature': await hmacHex(env.KJ_SECRET, `${method}\n${u.pathname}${u.search}\n${ts}\n${nonce}`),
    accept: 'application/json',
    'accept-language': 'zh-CN,zh;q=0.9',
  }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (cookie) headers.cookie = cookie
  if (budget && !budget.canSpend(1)) throw new Error('probe_budget_exceeded')
  if (budget) budget.spend(1)
  const res = await fetch(u, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  return { status: res.status, text, cookies: res.headers.getSetCookie?.() || [] }
}

async function fetchJson(env, path) {
  await throttle()
  const r = await signedFetch(env, path)
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status} ${r.text.slice(0, 100)}`)
  return JSON.parse(r.text)
}

// 匿名访客会话（官方 1080P 必需）
let guest = ''
let guestForceAt = 0
async function dbFirst(env, sql, ...args) {
  return env.DB.prepare(sql).bind(...args).first()
}
async function dbAll(env, sql, ...args) {
  const r = await env.DB.prepare(sql).bind(...args).all()
  return r.results || []
}
async function dbRun(env, sql, ...args) {
  return env.DB.prepare(sql).bind(...args).run()
}

async function getGuest(env, force = false, immediate = false, budget) {
  if (guest && !force) return guest
  if (!immediate && guestForceAt && Date.now() - guestForceAt < 300_000) return guest
  if (!force) {
    const row = await dbFirst(env, "SELECT value FROM meta WHERE key='guest_cookie'").catch(() => null)
    if (row?.value) {
      guest = row.value
      return guest
    }
  }
  let anon = (await dbFirst(env, "SELECT value FROM meta WHERE key='anon_id'").catch(() => null))?.value
  if (!anon) {
    anon = 'web_' + crypto.randomUUID()
    await dbRun(env, "INSERT INTO meta(key,value,updated_at) VALUES('anon_id',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", anon).catch(() => {})
  }
  const res = await signedFetch(env, '/v1/users/anonymous', { method: 'POST', body: { anonymous_id: anon }, budget })
  if (res.status < 200 || res.status >= 300) throw new Error(`访客会话失败 HTTP ${res.status}`)
  const pick = res.cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('ai_movie_session=') && c.length > 18)
  if (!pick) throw new Error('访客会话失败：没有 cookie')
  guest = pick
  guestForceAt = force ? Date.now() : 0
  await dbRun(env, "INSERT INTO meta(key,value,updated_at) VALUES('guest_cookie',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", pick).catch(() => {})
  return guest
}

const resolveCache = new Map()
async function resolveEpisode(env, ep, budget) {
  const hit = resolveCache.get(ep.token)
  if (hit && Date.now() - hit.at < 60_000) return hit.value
  await throttle()
  const cookie = await getGuest(env, false, false, budget).catch(() => '')
  let r = await signedFetch(env, `/v1/playback/resolve/${ep.token}?view=compact`, { cookie, budget })
  if (r.status === 401 && /playback_user_session_required/.test(r.text)) {
    const fresh = await getGuest(env, true, true, budget).catch(() => '')
    r = await signedFetch(env, `/v1/playback/resolve/${ep.token}?view=compact`, { cookie: fresh, budget })
  }
  if (r.status < 200 || r.status >= 300) {
    const err = new Error(`HTTP ${r.status} ${r.text.slice(0, 140)}`)
    err.body = r.text
    throw err
  }
  const value = JSON.parse(r.text)
  resolveCache.set(ep.token, { at: Date.now(), value })
  return value
}

// 原站对 resolve-line 会按会话/IP 限流（实测 Worker 侧曾返回 429），
// 本地客户端有重试，Worker 旧实现一次失败就丢掉整条官方线。这里补上有界重试。
const RESOLVE_RETRY_STATUS = new Set([403, 429, 500, 502, 503, 504])
async function resolveTicket(env, ticket, signal, retries = 1, budget) {
  await throttle()
  if (signal?.aborted) throw new Error('probe_aborted')
  let cookie = await getGuest(env, false, false, budget).catch(() => '')
  let last
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new Error('probe_aborted')
    const r = await signedFetch(env, '/v1/playback/resolve-line', { method: 'POST', body: { ticket }, cookie, timeout: 7000, signal, budget })
    if (r.status >= 200 && r.status < 300) return JSON.parse(r.text)?.line?.url || ''
    const code = (() => { try { return JSON.parse(r.text)?.code || '' } catch { return '' } })()
    last = { status: r.status, body: r.text, code }
    // Cloudflare 免费版每次调用最多 50 个子请求；撞限后任何重试都只会继续失败。
    if (/too many subrequests/i.test(r.text)) break
    const sessionExpired = (r.status === 401 || r.status === 403) && /playback_user_session_required|login_required|session/i.test(r.text)
    if (attempt === 0 && sessionExpired) {
      cookie = await getGuest(env, true, true, budget).catch(() => '')
      continue
    }
    if (attempt < retries && (RESOLVE_RETRY_STATUS.has(r.status) || sessionExpired)) {
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
      continue
    }
    break
  }
  const budgetExceeded = /too many subrequests|probe_budget_exceeded/i.test(last.body)
  const err = new Error(budgetExceeded ? 'probe_budget_exceeded' : `HTTP ${last.status} ${last.body.slice(0, 120)}`)
  err.body = last.body
  err.status = last.status
  err.code = last.code
  throw err
}

// ---------- 线路与内容指纹 ----------
function lineOptions(rv) {
  return (rv?.line_options || [])
    .map((o, index) => {
      const raw = String(o.url || '')
      const ticket = raw.startsWith('resolve://') ? raw.slice('resolve://'.length) : ''
      const provider = o.provider_id || ''
      return {
        provider,
        label: o.label || o.display_label || '',
        ticket,
        url: ticket ? '' : raw,
        index,
        selected: !!o.selected,
        group: isOfficial(provider) ? 'official' : 'normal',
        priority: priorityOf(provider),
      }
    })
    .filter((x) => x.provider && (x.ticket || x.url))
}


function probeMediaUrl(response, fallback) {
  return response?.probeFinalUrl || response?.url || fallback
}

function sniff(buf, contentType = '') {
  if (/image\//i.test(contentType)) {
    const b = new Uint8Array(buf)
    if ((b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50)) return 'image'
  }
  const head = new Uint8Array(buf).slice(0, 64)
  const s = String.fromCharCode(...head)
  if (s.includes('ftyp')) return 'mp4'
  if (s.includes('#EXTM3U')) return 'hls'
  if (s.trimStart().startsWith('<')) return 'html'
  if (head[0] === 0x47) return 'ts'
  return 'unknown'
}

async function inspectHls(url, signal, budget) {
  const result = await inspectHlsResource(url, {
    fetchImpl: (resource, options) => fetch(resource, { ...options, headers: { ...options.headers, 'user-agent': UA } }),
    timeoutMs: 5000,
    signal,
    budget,
  })
  if (!result.ok) return result
  const first = result.firstSegment
  const contentFingerprint = result.firstBytes.byteLength > 1024 ? `hls-bytes:${await sha(result.firstBytes)}` : null
  return {
    ...result,
    first,
    fingerprint: contentFingerprint || (await sha(`${first.split('?')[0]}|${result.segments}|${Math.round(result.duration)}`)),
  }
}

async function inspectMp4(url, signal, budget) {
  const countedFetch = createCountedFetch(
    (resource, options) => fetch(resource, { ...options, headers: { ...options.headers, 'user-agent': UA } }),
    budget
  )
  try {
    const r = await countedFetch(url, {
      headers: { range: 'bytes=0-8388607' },
      signal: AbortSignal.any([AbortSignal.timeout(7000), ...(signal ? [signal] : [])]),
    })
    if (r.status >= 400) return { ok: false, kind: 'mp4', status: r.status, error: `http_${r.status}` }
    const ct = r.headers.get('content-type') || ''
    const len = r.headers.get('content-range') || r.headers.get('content-length') || ''
    const buf = await readBounded(r, 8 * 1024 * 1024)
    const kind = sniff(buf, ct)
    if (kind === 'hls') return inspectHls(url, signal, budget)
    if (kind === 'image') return { ok: false, kind: 'image', error: 'placeholder_image' }
    if (kind === 'html') return { ok: false, kind: 'page', error: 'not_video' }
    if (kind !== 'mp4') return { ok: false, kind, error: 'not_video' }
    if (!buf.byteLength) return { ok: false, kind: 'mp4', error: 'empty_media' }
    const dimensions = mediaDimensions(buf)
    const mediaUrl = probeMediaUrl(r, url)
    return { ok: true, kind: 'mp4', length: len, ...dimensions, qualitySource: dimensions.height ? 'media' : 'unknown', mediaUrl, fingerprint: `mp4-url:${await sha(`${String(mediaUrl).split('?')[0]}|${len}`)}` }
  } catch (error) {
    return { ok: false, kind: 'mp4', error: error?.message === 'probe_budget_exceeded' ? 'probe_budget_exceeded' : 'fetch_failed' }
  }
}

async function inspectSource(url, signal, budget) {
  if (/\.m3u8(\?|$)/i.test(url)) return inspectHlsResource(url, {
    fetchImpl: (resource, options) => fetch(resource, { ...options, headers: { ...options.headers, 'user-agent': UA } }),
    timeoutMs: 5000,
    signal,
    budget,
  }).then(async (result) => {
    if (!result.ok) return result
    const fingerprint = result.firstBytes.byteLength > 1024 ? `hls-bytes:${await sha(result.firstBytes)}` : null
    return { ...result, fingerprint }
  })
  return inspectMp4(url, signal, budget)
}

// ---------- 播放 ----------
const playCache = new Map()

async function healthMap(env, showId) {
  const rows = await dbAll(env, 'SELECT provider, verdict, detail FROM provider_health WHERE show_id=?', showId).catch(() => [])
  return new Map(rows.map((r) => [r.provider, r]))
}

async function setHealth(env, showId, provider, verdict, detail = '') {
  await dbRun(
    env,
    `INSERT INTO provider_health(show_id,provider,verdict,detail,checked_at) VALUES(?,?,?,?,datetime('now'))
     ON CONFLICT(show_id,provider) DO UPDATE SET verdict=excluded.verdict, detail=excluded.detail, checked_at=excluded.checked_at`,
    showId,
    provider,
    verdict,
    detail
  ).catch(() => {})
}

// 原站对 Worker 出口会限流 resolve-line（实测 429）。同一集上次验证过的直链仍可用时，
// 用它顶上，避免只因为限流就把原站默认线路换掉。只认同一 show+集+provider+标签的记录。
async function cachedSourceUrl(env, showId, epIdx, line) {
  const rows = await dbAll(env, `SELECT url,label,checked_at FROM sources
    WHERE show_id=? AND ep_idx=? AND provider=? AND status='ok' AND url IS NOT NULL AND url<>''
    ORDER BY checked_at DESC`, showId, Number(epIdx), line.provider).catch(() => [])
  // 空标签的旧记录不能冒充任何语言版本：必须标签完全一致才复用，否则可能把
  // 普通话直链当成粤语默认线返回。
  const hit = rows.find((row) => String(row.label || '') === String(line.label || ''))
  if (!hit) return ''
  const checkedAt = Date.parse(String(hit.checked_at).replace(' ', 'T') + 'Z')
  const age = Date.now() - checkedAt
  if (!Number.isFinite(age) || age < -3_600_000 || age > 7 * 86_400_000) return ''
  return hit.url
}

async function recordLineProbe(env, showId, provider, ok) {
  await dbRun(env,
    `INSERT INTO provider_playback_stats(show_id,provider,successes,failures,updated_at) VALUES(?,?,?,?,datetime('now'))
     ON CONFLICT(show_id,provider) DO UPDATE SET successes=successes+excluded.successes, failures=failures+excluded.failures, updated_at=datetime('now')`,
    showId, provider, ok ? 1 : 0, ok ? 0 : 1).catch(() => {})
}

async function saveSource(env, showId, epIdx, s) {
  await dbRun(
    env,
    `INSERT INTO sources(show_id,ep_idx,provider,label,url,kind,fingerprint,segments,duration,quality,status,checked_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(show_id,ep_idx,provider) DO UPDATE SET label=excluded.label,url=excluded.url,kind=excluded.kind,
       fingerprint=excluded.fingerprint,segments=excluded.segments,duration=excluded.duration,quality=COALESCE(excluded.quality, sources.quality),status=excluded.status,checked_at=excluded.checked_at`,
    showId,
    epIdx,
    s.provider,
    s.label ?? null,
    s.url ?? null,
    s.kind ?? null,
    s.fingerprint ?? null,
    s.segments ?? null,
    s.duration ?? null,
    s.quality ?? null,
    s.status ?? 'ok'
  ).catch(() => {})
}

// 片头片尾（原站 /v1/catalog/:id 的 playback_skip_settings_preset），按剧缓存到 D1。
async function loadSkipSettings(env, showId) {
  try {
    let srow = null
    try { srow = await dbFirst(env, 'SELECT intro_end, outro_from FROM shows WHERE id=?', showId) } catch {}
    let intro = srow?.intro_end
    let outro = srow?.outro_from
    if (intro == null) {
      const d = await fetchJson(env, `/v1/catalog/${showId}`)
      const p = d?.playback_skip_settings_preset
      if (p && Number.isFinite(Number(p.intro_end_seconds))) {
        intro = Number(p.intro_end_seconds)
        outro = Number.isFinite(Number(p.outro_from_end_seconds)) ? Number(p.outro_from_end_seconds) : null
        await dbRun(env, 'UPDATE shows SET intro_end=?, outro_from=? WHERE id=?', intro, outro, showId).catch(() => {})
      }
    }
    return intro != null ? { introEnd: intro, outroFrom: outro } : null
  } catch {
    /* 拿不到就不显示跳过按钮 */
    return null
  }
}

// 已验证直链快取。
//
// 正式站的 /api/play 是 zhuiju-web 经 service binding 嵌套调用 kanju-api：任何要跑
// 十几秒的重请求都会被平台按 CPU 上限掐断（2026-11-22 事故：cpuTime 只有 9–51ms、
// wall 2–5s 就被终止并包装成 upstream_unreachable，而同一参数公网直连 13 秒返回 200）。
// 解析上游 + 并发探测全部候选正是这类重请求。
//
// 因此：这一集在 D1 里已有近期验证过的直链时，直接按原版完全相同的选线规则
// （selectPlayable：手选线路优先 > 原站默认对照表 > 清晰度/可信历史）返回，
// 不解析上游、不探测候选。
//
// 只用于「没有手选线路」的普通播放。前端换源或严格选线（请求带 line/strict）照旧走
// 完整解析与探测；快取的直链一旦过期，播放器报错后会按线路重试，那时进入完整路径
// 重新解析，结果与旧版一致。
const VERIFIED_SOURCE_MAX_AGE_MS = 7 * 86_400_000

async function playFromVerifiedSources(env, showId, idx, targetQuality, preferred = '') {
  if (!showId) return null
  const rows = await dbAll(env, `SELECT provider,label,url,kind,segments,duration,quality,checked_at FROM sources
    WHERE show_id=? AND ep_idx=? AND status='ok' AND url IS NOT NULL AND url<>''
    ORDER BY checked_at DESC`, showId, Number(idx)).catch(() => [])
  if (!rows.length) return null
  const fresh = rows.filter((row) => {
    const checkedAt = Date.parse(String(row.checked_at || '').replace(' ', 'T') + 'Z')
    if (!Number.isFinite(checkedAt)) return false
    const age = Date.now() - checkedAt
    return age > -3_600_000 && age <= VERIFIED_SOURCE_MAX_AGE_MS
  })
  if (!fresh.length) return null
  const health = await healthMap(env, showId)
  // 被判为串集（dup）或需要会员的线路不得从快取里返回；
  // 空标签的旧记录同样不能冒充任何语言版本（与 cachedSourceUrl 的规则一致），
  // 否则可能把普通话直链当成粤语默认线返回。
  const usable = fresh.filter((row) => String(row.label || '').trim() !== ''
    && !['dup', 'member'].includes(String(health.get(row.provider)?.verdict || '')))
  if (!usable.length) return null
  const originDefault = await loadOriginDefault(env, showId)
  const candidates = markOriginDefault(usable.map((row) => ({
    provider: row.provider,
    label: row.label || row.provider,
    url: row.url,
    kind: row.kind || (/\.m3u8(\?|$)/i.test(row.url) ? 'hls' : 'mp4'),
    segments: row.segments ?? null,
    duration: row.duration ?? null,
    quality: Number(row.quality) || 0,
    ok: true,
  })), originDefault.provider, originDefault.label)
  const chosen = selectPlayable(candidates, { preferred, targetQuality: Number(targetQuality) || 0 })
  if (!chosen) return null
  // 选中的线路排到换源列表最前，前端按顺序换源时先试它。
  const ordered = [chosen, ...candidates.filter((item) => item !== chosen)]
  const skip = await loadSkipSettings(env, showId)
  const ep = await dbFirst(env, 'SELECT number FROM episodes WHERE show_id=? AND idx=?', showId, Number(idx)).catch(() => null)
  return {
    showId,
    idx: Number(idx),
    url: chosen.url,
    kind: chosen.kind,
    episodeNumber: Number(ep?.number ?? Number(idx) + 1),
    line: chosen.label,
    provider: chosen.provider,
    segments: chosen.segments,
    duration: chosen.duration,
    width: 0,
    quality: chosen.quality,
    qualitySource: 'sources',
    firstSegmentMs: null,
    fingerprint: null,
    verified: true,
    probeDegraded: false,
    originDefaultStatus: !originDefault.provider ? 'not_in_lines' : chosen.originDefault ? 'ok' : 'unknown',
    sourceFromCache: true,
    verifiedSourceCache: true,
    skip,
    options: ordered.map((item) => ({
      provider: item.provider,
      label: item.label,
      key: lineKey(item.provider, item.label),
      group: '',
      mode: 'direct',
      status: 'ok',
      quality: item.quality,
      successRate: null,
      selected: item.provider === chosen.provider && String(item.label) === String(chosen.label),
    })),
    candidateProviders: ordered.map((item) => item.provider),
    tried: [],
  }
}

async function playUrl(env, showId, idx, requestedLine = '', targetQuality = 0, preferred = '', strictLine = false) {
  const budget = createProbeBudget()
  const requestedQuality = Number(targetQuality) || 0
  const key = `${showId}#${idx}#${requestedLine}#${requestedQuality}#${preferred}`
  const hit = playCache.get(key)
  if (!requestedLine && hit && Date.now() - hit.at < 90_000) {
    const health = await healthMap(env, showId)
    if (health.get(hit.value.provider)?.verdict !== 'dup') return { ...hit.value, cached: true }
    playCache.delete(key)
  }

  if (!requestedLine) {
    const fast = await playFromVerifiedSources(env, showId, idx, requestedQuality, preferred).catch(() => null)
    if (fast) {
      playCache.set(key, { at: Date.now(), value: fast })
      return fast
    }
  }

  let ep = await dbFirst(env, 'SELECT * FROM episodes WHERE show_id=? AND idx=?', showId, Number(idx)).catch(() => null)
  if (!ep) {
    const page = await fetchJson(env, `/v1/catalog/${showId}/episodes?limit=48&offset=0`)
    const item = (page.episodes || [])[Number(idx)]
    if (item?.token) ep = { token: item.token, number: item.number ?? Number(idx) + 1 }
  }
  if (!ep) throw new Error('没有这一集')
  if (!ep.token) throw new Error('这一集缺少播放凭证')

  let rv
  try {
    rv = await resolveEpisode(env, ep, budget)
  } catch (e) {
    const msg = String(e.body || e.message || '')
    if (/playback_line_level_required|level_required|等级不足/.test(msg)) throw new Error('该集需要更高等级或会员，匿名无法播放')
    throw e
  }
  const gotNum = rv?.current_episode?.episode_number
  const wantNum = ep.number || Number(idx) + 1
  if (gotNum != null && Number(gotNum) !== Number(wantNum)) throw new Error(`集数不一致：请求第${wantNum}集，原站返回第${gotNum}集`)

  const firstEp = await dbFirst(env, 'SELECT idx, number, token FROM episodes WHERE show_id=? ORDER BY idx LIMIT 1', showId).catch(() => null)
  const health = await healthMap(env, showId)
  for (const [provider, row] of health) {
    if (row.verdict === 'dup' && !String(row.detail || '').startsWith('fingerprint-v2:') && /与第\d+集同内容|所有集指向第1集/.test(row.detail || '')) {
      await dbRun(env, 'UPDATE provider_health SET verdict=\'unknown\',detail=\'需要按 HLS 首片字节指纹复核\' WHERE show_id=? AND provider=?', showId, provider).catch(() => {})
      health.set(provider, { ...row, verdict: 'unknown', detail: '需要按 HLS 首片字节指纹复核' })
    }
  }
  const successfulProviders = new Map((await dbAll(env, `SELECT p.provider,p.successes,p.failures,p.successes+p.failures total,MAX(s.quality) quality
       FROM provider_playback_stats p LEFT JOIN sources s ON s.show_id=p.show_id AND s.provider=p.provider
       WHERE p.show_id=? GROUP BY p.provider`, showId).catch(() => [])).map((row) => [row.provider, row]))

  const skip = await loadSkipSettings(env, showId)

  const originDefault = await loadOriginDefault(env, showId)
  const lines = orderLines(markOriginDefault(lineOptions(rv), originDefault.provider, originDefault.label).map((line) => ({
    ...line,
    quality: 0,
    stats: successfulProviders.get(line.provider),
  })), successfulProviders).filter((line) => health.get(line.provider)?.verdict !== 'dup')
  const requestedHit = requestedLine ? lines.find((line) => matchesLineKey(line, requestedLine)) : null
  if (!requestedLine) {
    const at = lines.findIndex((line) => line.originDefault)
    if (at > 0) lines.unshift(lines.splice(at, 1)[0])
  }
  if (requestedLine) {
    if (!requestedHit) throw new Error('所选线路在本集不可用')
    const at = lines.indexOf(requestedHit)
    if (at > 0) lines.unshift(lines.splice(at, 1)[0])
  } else if (preferred) {
    const at = lines.findIndex((line) => line.provider === preferred)
    if (at > 0) lines.unshift(lines.splice(at, 1)[0])
  }
  const candidates = requestedLine
    ? strictLine ? [requestedHit] : [requestedHit, ...lines.filter((line) => line !== requestedHit)]
    : lines
  const tried = []
  const probeOne = async (line, signal) => {
    if (!budget.canSpend(1)) return { line, ok: false, deferred: true, error: 'probe_budget_exceeded' }
    let url = line.url
    let fromCache = false
    if (!url && line.ticket) {
      try { url = await resolveTicket(env, line.ticket, signal, line.originDefault ? 2 : 1, budget) } catch (error) {
        const body = String(error.body || error.message || '')
        const member = /playback_user_session_required|login_required/.test(body)
        if (member) {
          await setHealth(env, showId, line.provider, 'member', '需要登录/会员')
          return { line, ok: false, url: '', kind: '', error: 'member' }
        }
        const budgetHit = /too many subrequests|probe_budget_exceeded/i.test(body)
        const rateLimited = error.status === 429 || budgetHit
        if (rateLimited) {
          const cached = await cachedSourceUrl(env, showId, idx, line)
          if (cached) { url = cached; fromCache = true } else {
            // 限流不是死线：没有缓存就如实标「未知」，不能把默认线路标 dead 后换别家。
            return { line, ok: false, url: '', kind: '', error: budgetHit ? 'probe_budget_exceeded' : 'rate_limited', deferred: true }
          }
        } else {
          const detail = error.status ? `resolve_http_${error.status}${error.code ? `_${error.code}` : ''}` : `resolve_${String(error.message).slice(0, 40)}`
          return { line, ok: false, url: '', kind: '', error: detail }
        }
      }
    }
    if (!url) return { line, ok: false, url: '', kind: '', error: 'no_url' }
    const info = await inspectSource(url, signal, budget)
    if (!info.ok) {
      // 线路已经解析出真实地址，但 Worker 自己的出口拿不到媒体。
      // 这是探测器的网络限制，不等于浏览器也拿不到；留给选线阶段做未验证兜底。
      const soft = isSoftProbeFailure(info.error)
      return { line, ok: false, url, ...info, tentative: soft || undefined }
    }
    const rows = await dbAll(env, 'SELECT ep_idx, kind, fingerprint FROM sources WHERE show_id=? AND provider=? AND fingerprint IS NOT NULL', showId, line.provider).catch(() => [])
    // Old HLS hashes were invalid; old MP4 URL hashes remain comparable within MP4 only.
    const comparableFingerprint = (kind, fingerprint) => {
      if (!fingerprint) return null
      if (kind === 'mp4') return fingerprint.startsWith('mp4-url:') ? fingerprint : /^[a-f0-9]{16}$/.test(fingerprint) ? `mp4-url:${fingerprint}` : null
      return kind === 'hls' && fingerprint.startsWith('hls-bytes:') ? fingerprint : null
    }
    const fingerprint = comparableFingerprint(info.kind, info.fingerprint)
    const collision = fingerprint && rows.find((row) => Number(row.ep_idx) !== Number(idx)
      && comparableFingerprint(row.kind, row.fingerprint) === fingerprint)
    if (collision) {
      await setHealth(env, showId, line.provider, 'dup', `fingerprint-v2:第${Number(collision.ep_idx) + 1}集与第${Number(idx) + 1}集同内容`)
      return { ...info, line, url, ok: false, error: 'episode_collision' }
    }
    if (fingerprint && firstEp && Number(idx) !== Number(firstEp.idx)) {
      const baseline = await dbFirst(env, 'SELECT fingerprint FROM provider_baseline WHERE show_id=? AND provider=?', showId, line.provider).catch(() => null)
      if (baseline?.fingerprint && comparableFingerprint(info.kind, baseline.fingerprint) === fingerprint) {
        await setHealth(env, showId, line.provider, 'dup', 'fingerprint-v2:所有集指向第1集')
        return { ...info, line, url, ok: false, error: 'same_as_first_episode' }
      }
    }
    return { line, url, ...info, ok: true, fromCache }
  }
  // 不再固定只探前 8 条：前 8 条全失败时第 9 条可能正好能播。
  // 真正的上限是子请求预算；预算用完的线路由 probeOne 标成「未探测」，绝不标 dead。
  const allCandidates = candidates.filter(Boolean)
  let probed = await probeCandidates(allCandidates, probeOne, { concurrency: 4, timeoutMs: 7000, budgetMs: 20000 })

  // 原站默认线路只有「超时/预算不足」这类软失败时单独再试一次：
  // 并发探测会把它挤到超时，导致默认线路被换成别的线路，与原站不一致。
  // 只对对照表命中的线路重试，上游 selected（列表第一条）不算默认项。
  const retryPlan = requestedLine ? { index: -1, retry: false } : planOriginRetry(probed, originDefault)
  if (retryPlan.retry) {
    const retried = await probeCandidates([probed[retryPlan.index].line], probeOne, { concurrency: 1, timeoutMs: 12000, budgetMs: 13000 })
    // 重试如果给出明确失败（会员/HTTP 403 等），也要用它替换，避免把该线路报成「超时、状态未知」。
    probed = mergeOriginRetry(probed, retryPlan.index, retried[0])
  }

  for (const item of probed) {
    if (!item.ok) {
      tried.push({ label: item.line.label, provider: item.line.provider, reason: item.error || 'unavailable', quality: Number(item.height || item.variantHeight) || 0 })
      // 软失败（Worker 出口拿不到媒体、限流、预算不足）不能写回 sources：
      // 否则一次 fetch_failed 就会把之前已验证的直链和指纹清掉，之后连缓存也没得复用。
      if (item.url && !item.tentative && !isSoftProbeFailure(item.error, item) && !['member', 'resolve_failed'].includes(item.error)) {
        await saveSource(env, showId, Number(idx), { provider: item.line.provider, label: item.line.label, url: item.url, kind: item.kind, quality: Number(item.height) || null, status: item.error || 'dead' })
      }
    }
  }
  const mediaCandidates = probed.map((item) => ({ ...item.line, ...item, quality: Number(item.height || item.variantHeight) || 0 }))
  // 原站默认线路解析出了地址、只是 Worker 出口探测超时/失败时，不要因为我们的网络
  // 限制把用户切到别家线路：浏览器在用户自己的网络里仍可能正常播放。标记为未验证交给播放器。
  const tentativeDefault = !requestedLine && !mediaCandidates.some((item) => item.ok && item.originDefault)
    ? mediaCandidates.find((item) => item.originDefault && item.tentative && item.url)
    : null
  const chosen = requestedLine
    ? mediaCandidates.find((item) => matchesLineKey(item, requestedLine) && item.ok) || selectPlayable(mediaCandidates.filter((item) => !matchesLineKey(item, requestedLine)), { preferred, targetQuality: requestedQuality })
    : tentativeDefault
      ? { ...tentativeDefault, ok: true, kind: tentativeDefault.kind || (/\.m3u8(\?|$)/i.test(tentativeDefault.url) ? 'hls' : 'mp4'), mediaUrl: tentativeDefault.url, quality: 0 }
      : selectPlayable(mediaCandidates, { preferred, targetQuality: requestedQuality })
  // 原站默认线路到底怎么了，要明确告诉前端：限流/出口探测失败不是「线路死了」。
  const defaultItem = mediaCandidates.find((item) => item.originDefault)
  const defaultUnverified = !!defaultItem && !defaultItem.ok && isSoftProbeFailure(defaultItem.error, defaultItem)
  const originDefaultStatus = !defaultItem ? 'not_in_lines'
    : defaultItem.ok ? 'ok'
      : defaultUnverified ? (defaultItem.error || 'unknown')
        : 'unavailable'
  if (chosen) {
    const { line, mediaUrl, fingerprint: fp, kind, segments, duration, height = 0, width = 0 } = chosen
    const quality = Number(height || chosen.variantHeight) || 0
    const url = mediaUrl || chosen.url
    // 未验证线路不能写进 sources 冒充已验证片源。
    if (!chosen.tentative) await saveSource(env, showId, Number(idx), { provider: line.provider, label: line.label, url, kind, fingerprint: fp, segments, duration, quality: quality || null, status: 'ok' })
    const value = {
      showId,
      idx: Number(idx),
      url,
      kind,
      episodeNumber: Number(gotNum ?? wantNum),
      line: line.label,
      provider: line.provider,
      segments,
      duration,
      width,
      quality,
      qualitySource: chosen.qualitySource || 'unknown',
      firstSegmentMs: chosen.firstSegmentMs ?? null,
      fingerprint: fp,
      verified: !chosen.tentative,
      probeDegraded: !!chosen.tentative || (defaultUnverified && chosen.line.provider !== defaultItem.line.provider),
      originDefaultStatus,
      sourceFromCache: !!chosen.fromCache,
      skip,
      options: probed.map((item) => ({
        provider: item.line.provider,
        label: item.line.label,
        key: lineKey(item.line.provider, item.line.label),
        group: item.line.group,
        mode: item.line.ticket ? 'ticket' : 'direct',
        status: probeStatus(item),
        quality: Number(item.height || item.variantHeight) || 0,
        successRate: item.line.stats?.total >= 2 ? item.line.stats.successes / item.line.stats.total : null,
        selected: item.line.provider === line.provider && String(item.line.label) === String(line.label),
      })),
      candidateProviders: probed.filter((item) => item.ok).map((item) => item.line.provider),
      tried,
    }
    playCache.set(key, { at: Date.now(), value })
    return value
  }

  if (preferred && tried.length) {
    const reason = tried[0].reason
    const tip =
      reason === 'member'
        ? '该线路需要登录或会员，匿名无法播放'
        : reason === 'placeholder_image'
          ? '该线路匿名只返回占位图，需要登录'
          : reason === 'episode_collision' || reason === 'same_as_first_episode'
            ? '该线路内容与其它集重复（串集），已停用'
            : `该线路暂不可用（${reason}）`
    throw new Error(tip)
  }
  if (tried.length && tried.every((t) => t.reason === 'member')) throw new Error('该集为会员片源，需要登录后才能播放')
  throw new Error(`线路解析失败：${tried.map((t) => `${t.label}:${t.reason}`).slice(0, 6).join(' / ') || '没有可用线路'}`)
}

const parseJSON = (v, d) => {
  try {
    const x = JSON.parse(v ?? 'null')
    return x ?? d
  } catch {
    return d
  }
}
// 列表项统一结构（分类热榜直查 / 普通查询共用，避免前端拿到原始行）
const listItemOf = (r) => ({
  id: r.id,
  title: r.title,
  year: r.year,
  kind: r.kind,
  area: r.area,
  language: r.language,
  genres: Array.isArray(r.genres) ? r.genres : parseJSON(r.genres, []),
  poster: r.poster,
  remarks: r.remarks,
  episodeCount: r.episode_count,
  availableEpisodeCount: r.available_episode_count,
  heatValue: r.heat_value,
  updatedAt: textOf(r.updated_at),
})

const textOf = (v) => {
  if (!v) return null
  if (typeof v !== 'string') return v
  if (v[0] !== '{') return v
  try {
    const o = JSON.parse(v)
    return o.display_text || o.text || null
  } catch {
    return v
  }
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const PASSWORD_ITERATIONS = 100000
const textEncoder = new TextEncoder()

function bytesToB64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function b64urlToBytes(value) {
  const base64 = String(value).replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0))
}

async function sha256Hex(value) {
  return hex(await crypto.subtle.digest('SHA-256', textEncoder.encode(String(value))))
}

async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16)), iterations = PASSWORD_ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', textEncoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256)
  return `pbkdf2-sha256$${iterations}$${bytesToB64url(salt)}$${bytesToB64url(new Uint8Array(bits))}`
}

async function verifyPassword(password, encoded) {
  const [algorithm, iterationsText, saltText, expected] = String(encoded || '').split('$')
  const iterations = Number(iterationsText)
  if (algorithm !== 'pbkdf2-sha256' || !Number.isInteger(iterations) || iterations < 100000 || !saltText || !expected) return false
  const actual = await hashPassword(password, b64urlToBytes(saltText), iterations)
  return safeEqual(actual, encoded)
}

function cleanUsername(value) {
  return String(value || '').normalize('NFKC').trim()
}

function usernameKey(value) {
  return cleanUsername(value).toLocaleLowerCase('zh-CN')
}

function validUsername(value) {
  return /^[\p{L}\p{N}_-]{3,24}$/u.test(cleanUsername(value))
}

function publicUser(row) {
  return { id: row.id, username: row.username, createdAt: Number(row.created_at) || null }
}

function bearerToken(request) {
  const match = /^Bearer\s+([A-Za-z0-9_-]{32,128})$/i.exec(request.headers.get('authorization') || '')
  return match ? match[1] : ''
}

async function createSession(env, userId) {
  const token = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)))
  const tokenHash = await sha256Hex(token)
  const now = Date.now()
  const expiresAt = now + SESSION_TTL_MS
  await dbRun(
    env,
    'INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?)',
    tokenHash,
    userId,
    now,
    expiresAt,
    now
  )
  return { token, tokenHash, expiresAt }
}

async function authenticate(request, env) {
  const token = bearerToken(request)
  if (!token) return null
  const tokenHash = await sha256Hex(token)
  const row = await dbFirst(
    env,
    `SELECT u.id,u.username,u.created_at,s.expires_at,s.last_seen_at
     FROM auth_sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=?`,
    tokenHash
  ).catch(() => null)
  if (!row) return null
  const now = Date.now()
  if (Number(row.expires_at) <= now) {
    await dbRun(env, 'DELETE FROM auth_sessions WHERE token_hash=?', tokenHash).catch(() => {})
    return null
  }
  if (now - Number(row.last_seen_at || 0) > 24 * 60 * 60 * 1000) {
    await dbRun(env, 'UPDATE auth_sessions SET last_seen_at=? WHERE token_hash=?', now, tokenHash).catch(() => {})
  }
  return { ...publicUser(row), tokenHash }
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown'
}

async function rateLimitHit(env, bucket, limit, windowMs) {
  const key = await sha256Hex(bucket)
  const now = Date.now()
  const row = await dbFirst(env, 'SELECT attempts,window_start FROM auth_attempts WHERE bucket=?', key).catch(() => null)
  if (!row || Number(row.window_start) <= now - windowMs) {
    await dbRun(
      env,
      `INSERT INTO auth_attempts(bucket,attempts,window_start) VALUES(?,?,?)
       ON CONFLICT(bucket) DO UPDATE SET attempts=excluded.attempts,window_start=excluded.window_start`,
      key,
      1,
      now
    )
    return false
  }
  if (Number(row.attempts) >= limit) return true
  await dbRun(env, 'UPDATE auth_attempts SET attempts=attempts+1 WHERE bucket=?', key)
  return false
}

async function clearRateLimit(env, bucket) {
  await dbRun(env, 'DELETE FROM auth_attempts WHERE bucket=?', await sha256Hex(bucket)).catch(() => {})
}

function parseProgress(body, fallbackShowId = '') {
  const showId = String(body.showId || fallbackShowId || '').trim().slice(0, 160)
  const idx = Number(body.idx)
  const position = Number(body.position)
  const duration = body.duration === null || body.duration === undefined || body.duration === '' ? null : Number(body.duration)
  if (!showId || !Number.isInteger(idx) || idx < 0 || idx > 1000000) return null
  if (!Number.isFinite(position) || position < 0 || position > 86400) return null
  if (duration !== null && (!Number.isFinite(duration) || duration <= 0 || duration > 86400)) return null
  return { showId, idx, position, duration }
}

async function listUserProgress(env, userId, { showId = '', limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100))
  const rows = showId
    ? await dbAll(
        env,
        `SELECT p.show_id,p.idx,p.position,p.duration,p.updated_at,
                s.title,s.poster,s.content_kind,s.year,s.area,s.remarks,s.episode_count,s.available_episode_count
         FROM user_progress p LEFT JOIN shows s ON s.id=p.show_id
         WHERE p.user_id=? AND p.show_id=? ORDER BY p.updated_at DESC LIMIT ?`,
        userId,
        showId,
        safeLimit
      )
    : await dbAll(
        env,
        `SELECT p.show_id,p.idx,p.position,p.duration,p.updated_at,
                s.title,s.poster,s.content_kind,s.year,s.area,s.remarks,s.episode_count,s.available_episode_count
         FROM user_progress p LEFT JOIN shows s ON s.id=p.show_id
         WHERE p.user_id=? ORDER BY p.updated_at DESC LIMIT ?`,
        userId,
        safeLimit
      )
  return rows.map((row) => ({
    showId: row.show_id,
    idx: Number(row.idx) || 0,
    position: Number(row.position) || 0,
    duration: row.duration === null ? null : Number(row.duration),
    updatedAt: row.updated_at,
    title: row.title || row.show_id,
    poster: row.poster || '',
    kind: row.content_kind || 'series',
    year: row.year || '',
    area: row.area || '',
    remarks: row.remarks || '',
    episodeCount: Number(row.episode_count) || 0,
    availableEpisodeCount: Number(row.available_episode_count) || 0,
  }))
}

async function saveUserProgress(env, userId, item) {
  await dbRun(
    env,
    `INSERT INTO user_progress(user_id,show_id,idx,position,duration,updated_at)
     VALUES(?,?,?,?,?,datetime('now'))
     ON CONFLICT(user_id,show_id) DO UPDATE SET
       idx=excluded.idx,position=excluded.position,duration=excluded.duration,updated_at=excluded.updated_at`,
    userId,
    item.showId,
    item.idx,
    item.position,
    item.duration
  )
}

export default {
  async fetch(request, env) {
    const u = new URL(request.url)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
    try {
      if (u.pathname === '/api/health') {
        return json({ ok: true, service: 'kanju-api', runtime: 'cloudflare-worker', time: new Date().toISOString() })
      }

      if (u.pathname === '/api/auth/register') {
        if (request.method !== 'POST') return json({ error: '只支持 POST' }, 405)
        const body = await request.json().catch(() => ({}))
        const username = cleanUsername(body.username)
        const password = String(body.password || '')
        const ip = clientIp(request)
        if (await rateLimitHit(env, `register:${ip}`, 8, 60 * 60 * 1000)) {
          return json({ error: '注册尝试过于频繁，请稍后再试' }, 429)
        }
        if (!validUsername(username)) {
          return json({ error: '账号需为 3-24 位字母、数字、中文、下划线或短横线' }, 400)
        }
        if (password.length < 8 || password.length > 128) {
          return json({ error: '密码需为 8-128 位' }, 400)
        }
        const normalized = usernameKey(username)
        const existing = await dbFirst(env, 'SELECT id FROM users WHERE normalized_username=?', normalized).catch(() => null)
        if (existing) return json({ error: '这个账号已被注册' }, 409)
        const now = Date.now()
        const userId = `usr_${crypto.randomUUID()}`
        const passwordHash = await hashPassword(password)
        try {
          await dbRun(
            env,
            'INSERT INTO users(id,username,normalized_username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)',
            userId,
            username,
            normalized,
            passwordHash,
            now,
            now
          )
        } catch {
          return json({ error: '这个账号已被注册' }, 409)
        }
        const session = await createSession(env, userId)
        return json(
          {
            object: 'auth',
            token: session.token,
            expiresAt: session.expiresAt,
            user: { id: userId, username, createdAt: now },
          },
          201
        )
      }

      if (u.pathname === '/api/auth/login') {
        if (request.method !== 'POST') return json({ error: '只支持 POST' }, 405)
        const body = await request.json().catch(() => ({}))
        const username = cleanUsername(body.username)
        const password = String(body.password || '')
        const normalized = usernameKey(username)
        if (!normalized || !password) return json({ error: '请输入账号和密码' }, 400)
        const ip = clientIp(request)
        if (
          (await rateLimitHit(env, `login:user:${normalized}`, 10, 15 * 60 * 1000)) ||
          (await rateLimitHit(env, `login:ip:${ip}`, 30, 15 * 60 * 1000))
        ) {
          return json({ error: '登录尝试过于频繁，请 15 分钟后再试' }, 429)
        }
        const user = await dbFirst(
          env,
          'SELECT id,username,password_hash,created_at FROM users WHERE normalized_username=?',
          normalized
        ).catch(() => null)
        if (!user) {
          await hashPassword(password)
          return json({ error: '账号或密码不正确' }, 401)
        }
        if (!(await verifyPassword(password, user.password_hash))) {
          return json({ error: '账号或密码不正确' }, 401)
        }
        await clearRateLimit(env, `login:user:${normalized}`)
        const session = await createSession(env, user.id)
        return json({
          object: 'auth',
          token: session.token,
          expiresAt: session.expiresAt,
          user: publicUser(user),
        })
      }

      if (u.pathname === '/api/auth/me') {
        if (request.method !== 'GET') return json({ error: '只支持 GET' }, 405)
        const user = await authenticate(request, env)
        if (!user) return json({ error: '登录已失效，请重新登录' }, 401)
        return json({ object: 'user', user: publicUser(user) })
      }

      if (u.pathname === '/api/auth/logout') {
        if (request.method !== 'POST') return json({ error: '只支持 POST' }, 405)
        const user = await authenticate(request, env)
        if (user) await dbRun(env, 'DELETE FROM auth_sessions WHERE token_hash=?', user.tokenHash).catch(() => {})
        return json({ ok: true })
      }

      if (u.pathname === '/api/user/progress/bulk') {
        if (request.method !== 'POST') return json({ error: '只支持 POST' }, 405)
        const user = await authenticate(request, env)
        if (!user) return json({ error: '请先登录' }, 401)
        const body = await request.json().catch(() => ({}))
        const items = Array.isArray(body.items) ? body.items.slice(0, 100) : []
        const valid = items.map((item) => parseProgress(item)).filter(Boolean)
        if (valid.length) {
          await env.DB.batch(
            valid.map((item) =>
              env.DB.prepare(
                `INSERT INTO user_progress(user_id,show_id,idx,position,duration,updated_at)
                 VALUES(?,?,?,?,?,datetime('now'))
                 ON CONFLICT(user_id,show_id) DO UPDATE SET
                   idx=excluded.idx,position=excluded.position,duration=excluded.duration,updated_at=excluded.updated_at`
              ).bind(user.id, item.showId, item.idx, item.position, item.duration)
            )
          )
        }
        return json({ ok: true, imported: valid.length })
      }

      if (u.pathname === '/api/user/progress') {
        const user = await authenticate(request, env)
        if (!user) return json({ error: '请先登录' }, 401)
        if (request.method === 'GET') {
          const items = await listUserProgress(env, user.id, {
            showId: u.searchParams.get('show') || '',
            limit: Number(u.searchParams.get('limit') || 100),
          })
          return json({ object: 'user-progress', items })
        }
        if (request.method === 'POST' || request.method === 'PUT') {
          const body = await request.json().catch(() => ({}))
          const item = parseProgress(body, u.searchParams.get('show') || '')
          if (!item) return json({ error: '进度参数不正确' }, 400)
          await saveUserProgress(env, user.id, item)
          return json({ ok: true })
        }
        if (request.method === 'DELETE') {
          const showId = String(u.searchParams.get('show') || '').trim()
          if (!showId) return json({ error: '缺少 show' }, 400)
          await dbRun(env, 'DELETE FROM user_progress WHERE user_id=? AND show_id=?', user.id, showId)
          return json({ ok: true })
        }
        return json({ error: '不支持的请求方法' }, 405)
      }

      if (u.pathname === '/api/home-calendar') {
        const cacheKey = new Request(new URL('/api/home-calendar?week=current', request.url))
        const cache = caches.default
        const cached = await cache.match(cacheKey)
        if (cached) return cached
        const upstream = await fetchJson(env, '/v1/watch-calendar?view=weekly&week=current&sort=heat&kind=all&limit=4')
        const response = new Response(JSON.stringify({ object: 'home-calendar', days: upstream.days || [] }), {
          headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=900' },
        })
        await cache.put(cacheKey, response.clone())
        return response
      }

      if (u.pathname === '/api/home-feed') {
        const cacheKey = new Request(new URL('/api/home-feed?v=5', request.url))
        const cache = caches.default
        const cached = await cache.match(cacheKey)
        if (cached) return cached
        const itemOfRow = (row) => ({
          id: row.id,
          title: row.title,
          year: row.year,
          kind: row.kind,
          area: row.area,
          language: row.language,
          genres: parseJSON(row.genres, []),
          poster: row.poster,
          remarks: row.remarks,
          episodeCount: row.episode_count,
          availableEpisodeCount: row.available_episode_count,
          heatValue: row.heat_value,
          updatedAt: textOf(row.updated_at),
        })
        const [feedRows, calendar] = await Promise.all([
          dbAll(env, 'SELECT row_id,title,subtitle,position,items FROM feed_rows ORDER BY position').catch(() => []),
          fetchJson(env, '/v1/watch-calendar?view=weekly&week=current&sort=heat&kind=all&limit=4').catch(() => ({ days: [] })),
        ])
        const rows = {}
        const order = []
        if (feedRows.length) {
          // 栏目顺序、标题、条目全部来自原站 feed，逐条一致
          for (const r of feedRows) {
            rows[r.row_id] = parseJSON(r.items, [])
            order.push({ id: r.row_id, title: r.title, sub: r.subtitle || '' })
          }
        } else {
          // 还没跑过栏目同步：先用分类热度拼一版，等首次同步后自动切换
          const legacy = [
            ['hot', `SELECT id,title,year,content_kind AS kind,area,language,genres,poster,remarks,episode_count,available_episode_count,heat_value,updated_at FROM shows ORDER BY heat_value DESC, updated_ts DESC LIMIT 12`, []],
            ['kr', `SELECT id,title,year,content_kind AS kind,area,language,genres,poster,remarks,episode_count,available_episode_count,heat_value,updated_at FROM shows WHERE content_kind IN ('series','short_drama') AND area=? ORDER BY heat_value DESC, updated_ts DESC LIMIT 12`, ['韩国']],
            ['jp', `SELECT id,title,year,content_kind AS kind,area,language,genres,poster,remarks,episode_count,available_episode_count,heat_value,updated_at FROM shows WHERE content_kind IN ('series','short_drama') AND area=? ORDER BY updated_ts DESC, heat_value DESC LIMIT 12`, ['日本']],
            ['us', `SELECT id,title,year,content_kind AS kind,area,language,genres,poster,remarks,episode_count,available_episode_count,heat_value,updated_at FROM shows WHERE content_kind IN ('series','short_drama') AND area=? ORDER BY updated_ts DESC, heat_value DESC LIMIT 12`, ['美国']],
            ['cn', `SELECT id,title,year,content_kind AS kind,area,language,genres,poster,remarks,episode_count,available_episode_count,heat_value,updated_at FROM shows WHERE content_kind IN ('series','short_drama') AND area=? ORDER BY updated_ts DESC, heat_value DESC LIMIT 12`, ['中国大陆']],
            ['movie-high', `SELECT id,title,year,content_kind AS kind,area,language,genres,poster,remarks,episode_count,available_episode_count,heat_value,updated_at FROM shows WHERE content_kind='movie' ORDER BY playback_count DESC, heat_value DESC, updated_ts DESC LIMIT 12`, []],
            ['movie-hot', `SELECT id,title,year,content_kind AS kind,area,language,genres,poster,remarks,episode_count,available_episode_count,heat_value,updated_at FROM shows WHERE content_kind='movie' ORDER BY heat_value DESC, updated_ts DESC LIMIT 12`, []],
            ['theater', `SELECT id,title,year,content_kind AS kind,area,language,genres,poster,remarks,episode_count,available_episode_count,heat_value,updated_at FROM shows WHERE content_kind='movie' AND genres LIKE ? ORDER BY updated_ts DESC, heat_value DESC LIMIT 12`, ['%院线%']],
            ['anime-series', `SELECT id,title,year,content_kind AS kind,area,language,genres,poster,remarks,episode_count,available_episode_count,heat_value,updated_at FROM shows WHERE content_kind IN ('anime','animation') AND COALESCE(episode_count,0)>=12 ORDER BY heat_value DESC, updated_ts DESC LIMIT 12`, []],
          ]
          const titles = { hot: '大家都在看', kr: '韩剧在追', jp: '日剧上新', us: '美剧续看', cn: '国产新剧', 'movie-high': '高分电影', 'movie-hot': '电影热播', theater: '院线热映', 'anime-series': '动画连载' }
          const results = await env.DB.batch(legacy.map(([, sql, args]) => env.DB.prepare(sql).bind(...args)))
          legacy.forEach(([id], i) => {
            rows[id] = (results[i]?.results || []).map(itemOfRow)
            order.push({ id, title: titles[id] || id, sub: '' })
          })
        }
        // 原站首页没有综艺栏目：按原站综艺分类热榜补一栏，位置放在剧集之后
        if (!rows['variety-hot']) {
          const variety = await dbAll(
            env,
            `SELECT s.id,s.title,s.year,s.content_kind AS kind,s.area,s.language,s.genres,s.poster,s.remarks,s.episode_count,s.available_episode_count,s.heat_value,s.updated_at
             FROM hot_rank r JOIN shows s ON s.id=r.show_id WHERE r.kind='variety' ORDER BY r.rank LIMIT 12`
          ).catch(() => [])
          if (variety.length) {
            rows['variety-hot'] = variety.map(itemOfRow)
            const entry = { id: 'variety-hot', title: '综艺热播', sub: '热门综艺持续更新' }
            const at = order.findIndex((o) => o.id === 'cn')
            if (at >= 0) order.splice(at + 1, 0, entry)
            else order.push(entry)
          }
        }
        const body = { object: 'home-feed', rows, order, calendar: calendar.days || [] }
        const response = json(body, 200, 'public, max-age=900')
        await cache.put(cacheKey, response.clone())
        return response
      }

      if (u.pathname === '/api/list') {
        // v=2：热榜直查上线后换了返回结构，旧缓存键作废
        const cacheKey = new Request(new URL('/api/list?v=2&' + u.searchParams.toString(), request.url), { headers: { accept: 'application/json' } })
        const cache = caches.default
        const cached = await cache.match(cacheKey)
        if (cached) return new Response(cached.body, { status: cached.status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=900' } })
        const cat = u.searchParams.get('cat') || ''
        const area = (u.searchParams.get('area') || '').trim()
        const genre = (u.searchParams.get('genre') || '').trim()
        const minEpisodes = Math.max(0, Number(u.searchParams.get('minEpisodes') || 0))
        const q = (u.searchParams.get('q') || '').trim()
        const sort = u.searchParams.get('sort') || 'heat'
        const limit = Math.min(60, Number(u.searchParams.get('limit') || 24))
        const page = Math.max(1, Number(u.searchParams.get('page') || 1))
        const kinds = { tv: ['series', 'short_drama'], movie: ['movie'], anime: ['anime', 'animation'], variety: ['variety', 'documentary'] }
        const where = []
        const args = []
        if (kinds[cat]) {
          where.push(`content_kind IN (${kinds[cat].map(() => '?').join(',')})`)
          args.push(...kinds[cat])
        }
        if (area) {
          where.push('area LIKE ?')
          args.push(`%${area}%`)
        }
        if (genre) {
          where.push('genres LIKE ?')
          args.push(`%${genre}%`)
        }
        if (minEpisodes > 0) {
          where.push('COALESCE(episode_count, 0) >= ?')
          args.push(minEpisodes)
        }
        if (q) {
          where.push('(title LIKE ? OR genres LIKE ? OR actors LIKE ? OR description LIKE ?)')
          args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
        }
        const orderBy = sort === 'updated'
          ? 'synced_at IS NULL, synced_at DESC, updated_ts DESC, heat_value DESC'
          : sort === 'playback'
            ? 'playback_count DESC, heat_value DESC, updated_ts DESC'
            : 'heat_value DESC, updated_ts DESC'
        const filter = where.length ? `WHERE ${where.join(' AND ')}` : ''
        // 分类热榜：按原站 heat_desc 的分类名次排序，保证第一屏与原站一致
        const hotKind = { tv: 'series', movie: 'movie', variety: 'variety', anime: 'anime' }[cat]
        const offset = (page - 1) * limit
        if (hotKind && !q && !area && !genre && !minEpisodes && sort === 'heat' && offset < 100) {
          const ranked = await dbAll(
            env,
            `SELECT s.id,s.title,s.year,s.content_kind AS kind,s.area,s.language,s.genres,s.poster,s.remarks,s.episode_count,s.available_episode_count,s.heat_value,s.updated_at
             FROM hot_rank r JOIN shows s ON s.id=r.show_id WHERE r.kind=? ORDER BY r.rank LIMIT ? OFFSET ?`,
            hotKind,
            limit,
            offset
          ).catch(() => [])
          const seen = new Set(ranked.map((r) => r.id))
          const missing = limit - ranked.length
          const fill =
            missing > 0
              ? await dbAll(
                  env,
                  `SELECT id,title,year,content_kind AS kind,area,language,genres,poster,remarks,episode_count,available_episode_count,heat_value,updated_at
                   FROM shows WHERE content_kind IN (${kinds[cat].map(() => '?').join(',')})
                   ${seen.size ? `AND id NOT IN (${[...seen].map(() => '?').join(',')})` : ''}
                   ORDER BY heat_value DESC, updated_ts DESC LIMIT ?`,
                  ...kinds[cat],
                  ...seen,
                  missing
                )
              : []
          const items = [...ranked, ...fill].map(listItemOf)
          const response = json({ object: 'list', total: items.length, page, limit, items }, 200, 'public, max-age=600')
          await cache.put(cacheKey, response.clone())
          return response
        }
        const rows = await dbAll(
          env,
          `SELECT id,title,year,content_kind AS kind,area,language,genres,poster,remarks,episode_count,available_episode_count,heat_value,updated_at
           FROM shows ${filter} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
          ...args,
          limit,
          (page - 1) * limit
        )
        const response = json({
          object: 'list',
          total: rows.length,
          page,
          limit,
          items: rows.map((r) => ({
            id: r.id,
            title: r.title,
            year: r.year,
            kind: r.kind,
            area: r.area,
            language: r.language,
            genres: parseJSON(r.genres, []),
            poster: r.poster,
            remarks: r.remarks,
            episodeCount: r.episode_count,
            availableEpisodeCount: r.available_episode_count,
            heatValue: r.heat_value,
            updatedAt: textOf(r.updated_at),
          })),
        }, 200, 'public, max-age=900')
        await cache.put(cacheKey, response.clone())
        return response
      }

      if (u.pathname === '/api/show') {
        const id = u.searchParams.get('id')
        const s = await dbFirst(env, 'SELECT * FROM shows WHERE id=?', id).catch(() => null)
        const eps = s ? await dbAll(env, 'SELECT idx,number,title,token,quality,line_label,provider,stream_kind FROM episodes WHERE show_id=? ORDER BY idx', id).catch(() => []) : []
        const health = s ? await dbAll(env, 'SELECT provider, verdict, detail FROM provider_health WHERE show_id=?', id).catch(() => []) : []
        if (!s || !eps.length) {
          const d = await fetchJson(env, `/v1/catalog/${id}`)
          const page = await fetchJson(env, `/v1/catalog/${id}/episodes?limit=48&offset=0`)
          const liveEps = page.episodes || []
          const c = d.catalog || d.card || d
          const episodes = liveEps.map((e, i) => ({ idx: i, label: e.title || `第${e.number || i + 1}集`, playable: !!e.token }))
          const defaultEpisode = pickOriginDefaultEpisode(episodes, await loadOriginDefault(env, id))
          return json({
            object: 'show',
            id,
            title: c.title || s?.title || '',
            year: c.year || s?.year || '',
            area: c.area || s?.area || '',
            language: c.language || s?.language || '',
            genres: Array.isArray(c.genres) ? c.genres : parseJSON(s?.genres, []),
            actors: Array.isArray(c.actors) ? c.actors : parseJSON(s?.actors, []),
            directors: Array.isArray(c.directors) ? c.directors : parseJSON(s?.directors, []),
            kind: c.content_kind || c.kind || 'series',
            poster: c.poster_url || c.poster || s?.poster || '',
            backdrop: c.backdrop_url || c.backdrop || s?.backdrop || '',
            synopsis: c.description || s?.description || '',
            remarks: c.remarks || s?.remarks || '',
            episodeCount: c.episode_count || liveEps.length,
            availableEpisodeCount: c.available_episode_count || liveEps.length,
            providers: health,
            episodes,
            defaultEpisode,
          })
        }
        const episodes = eps.map((e) => ({ idx: e.idx, label: e.title || `第${e.number || e.idx + 1}集`, playable: !!e.token, quality: e.quality, line: e.line_label }))
        const defaultEpisode = pickOriginDefaultEpisode(episodes, await loadOriginDefault(env, id))
        return json({
          object: 'show',
          id: s.id,
          title: s.title,
          year: s.year,
          kind: s.content_kind,
          area: s.area,
          language: s.language,
          genres: parseJSON(s.genres, []),
          actors: parseJSON(s.actors, []),
          directors: parseJSON(s.directors, []),
          poster: s.poster,
          backdrop: s.backdrop,
          synopsis: s.description,
          remarks: s.remarks,
          episodeCount: s.episode_count,
          availableEpisodeCount: s.available_episode_count,
          heatValue: s.heat_value,
          updatedAt: textOf(s.updated_at),
          providers: health,
          episodes,
          defaultEpisode,
        })
      }

      if (u.pathname === '/api/lines') {
        const showId = u.searchParams.get('show')
        const idx = Number(u.searchParams.get('ep') || 0)
        let ep = await dbFirst(env, 'SELECT * FROM episodes WHERE show_id=? AND idx=?', showId, idx).catch(() => null)
        if (!ep) {
          const page = await fetchJson(env, `/v1/catalog/${showId}/episodes?limit=48&offset=0`)
          const item = (page.episodes || [])[idx]
          if (item?.token) ep = { token: item.token, number: item.number ?? idx + 1 }
        }
        if (!ep) return json({ error: '没有这一集' }, 404)
        let rv
        try {
          rv = await resolveEpisode(env, ep)
        } catch (e) {
          const msg = String(e.body || e.message || '')
          if (/level_required|等级不足/.test(msg)) return json({ object: 'lines', episodeNumber: ep.number, options: [], note: '该集需要更高等级或会员' })
          if (/playback_user_session_required|login_required/.test(msg)) return json({ object: 'lines', episodeNumber: ep.number, options: [], note: '该集为会员片源' })
          throw e
        }
        const health = await healthMap(env, showId)
        const successfulProviders = new Map((await dbAll(env, `SELECT p.provider,p.successes,p.failures,p.successes+p.failures total,MAX(s.quality) quality
          FROM provider_playback_stats p LEFT JOIN sources s ON s.show_id=p.show_id AND s.provider=p.provider
          WHERE p.show_id=? GROUP BY p.provider`, showId).catch(() => [])).map((row) => [row.provider, row]))
        return json({
          object: 'lines',
          showId,
          idx,
          episodeNumber: rv?.current_episode?.episode_number ?? ep.number,
          options: orderLines(await applyOriginDefault(env, showId, lineOptions(rv)), successfulProviders).map((l) => ({
            provider: l.provider,
            label: l.label,
            key: lineKey(l.provider, l.label),
            group: l.group,
            mode: l.ticket ? 'ticket' : 'direct',
            status: health.get(l.provider)?.verdict || 'unknown',
            quality: Number(successfulProviders.get(l.provider)?.quality) || 0,
            successRate: successfulProviders.has(l.provider) && Number(successfulProviders.get(l.provider).total) > 0 ? Number(successfulProviders.get(l.provider).successes || 0) / Number(successfulProviders.get(l.provider).total) : null,
          })),
        })
      }

      if (u.pathname === '/api/playback-result' && request.method === 'POST') {
        const user = await authenticate(request, env)
        if (!user) return json({ error: '登录后才能提交播放统计' }, 401)
        const body = await request.json().catch(() => ({}))
        const showId = String(body.showId || '')
        const provider = String(body.provider || '')
        const attemptId = String(body.attemptId || '')
        if (!showId || !provider || typeof body.ok !== 'boolean' || showId.length > 160 || provider.length > 120) return json({ error: '播放结果参数无效' }, 400)
        if (!await verifyPlaybackAttempt(env.KJ_SECRET, attemptId, user.id, showId, provider)) return json({ error: '播放尝试无效或已过期' }, 403)
        const known = await dbFirst(env, 'SELECT provider FROM sources WHERE show_id=? AND provider=? AND status=\'ok\' LIMIT 1', showId, provider).catch(() => null)
        if (!known) return json({ error: '未知播放线路' }, 404)
        const inserted = await dbRun(env, 'INSERT OR IGNORE INTO provider_playback_attempts(attempt_id,user_id,show_id,provider,ok,created_at) VALUES(?,?,?,?,?,datetime(\'now\'))', attemptId, user.id, showId, provider, body.ok ? 1 : 0)
        if (Number(inserted?.meta?.changes) === 1) await recordLineProbe(env, showId, provider, body.ok)
        // Client feedback affects history only; it must not undo server-confirmed duplicate health.
        return json({ ok: true, duplicate: Number(inserted?.meta?.changes) !== 1 })
      }

      if (u.pathname === '/api/play') {
        const showId = u.searchParams.get('show')
        const idx = Number(u.searchParams.get('ep') || 0)
        const line = u.searchParams.get('line') || ''
        const strictLine = u.searchParams.get('strict') === '1'
        const preferred = u.searchParams.get('preferred') || ''
        const quality = Number(u.searchParams.get('quality')) || 0
        const out = await playUrl(env, showId, idx, line, quality, preferred, strictLine)
        const user = await authenticate(request, env)
        const attemptId = user ? await issuePlaybackAttempt(env.KJ_SECRET, user.id, out) : null
        return json({ object: 'play', ...out, attemptId })
      }

      if (u.pathname === '/api/progress') {
        const user = await authenticate(request, env)
        if (user) {
          if (request.method === 'POST' || request.method === 'PUT') {
            const body = await request.json().catch(() => ({}))
            const item = parseProgress(body)
            if (!item) return json({ error: '进度参数不正确' }, 400)
            await saveUserProgress(env, user.id, item)
            return json({ ok: true })
          }
          const items = await listUserProgress(env, user.id, {
            showId: u.searchParams.get('show') || '',
            limit: Number(u.searchParams.get('limit') || 30),
          })
          return json({ object: 'progress', items })
        }
        if (request.method === 'POST') {
          const b = await request.json().catch(() => ({}))
          await dbRun(
            env,
            `INSERT INTO progress(device,show_id,idx,position,duration,updated) VALUES(?,?,?,?,?,datetime('now'))
             ON CONFLICT(device,show_id) DO UPDATE SET idx=excluded.idx,position=excluded.position,duration=excluded.duration,updated=excluded.updated`,
            b.device || 'web',
            b.showId,
            Number(b.idx || 0),
            Number(b.position || 0),
            b.duration ?? null
          )
          return json({ ok: true })
        }
        const device = String(u.searchParams.get('device') || '').trim()
        if (!device) return json({ object: 'progress', items: [] })
        const rows = await dbAll(env, 'SELECT * FROM progress WHERE device=? ORDER BY updated DESC LIMIT 30', device)
        return json({ object: 'progress', items: rows })
      }

      // 弹幕：按 剧 + 集 存取
      if (u.pathname === '/api/danmaku') {
        const showId = u.searchParams.get('show')
        const idx = Number(u.searchParams.get('ep') || 0)
        if (!showId) return json({ error: '缺少 show' }, 400)
        if (request.method === 'POST') {
          const b = await request.json().catch(() => ({}))
          const text = String(b.text || '').trim().slice(0, 60)
          if (!text) return json({ error: '弹幕不能为空' }, 400)
          const t = Math.max(0, Math.min(4 * 3600, Number(b.t) || 0))
          await dbRun(
            env,
            `INSERT INTO danmaku(show_id,ep_idx,t,text,color,device,created_at) VALUES(?,?,?,?,?,?,datetime('now'))`,
            showId,
            Number(b.idx ?? idx),
            t,
            text,
            b.color || null,
            b.device || 'web'
          )
          return json({ ok: true })
        }
        const rows = await dbAll(
          env,
          'SELECT t, text, color FROM danmaku WHERE show_id=? AND ep_idx=? ORDER BY t ASC LIMIT 800',
          showId,
          idx
        )
        return json({ object: 'danmaku', items: rows })
      }

      // 讨论区（原站 /v1/comments，读取免登录）
      if (u.pathname === '/api/comments') {
        const showId = u.searchParams.get('show')
        if (!showId) return json({ error: '缺少 show' }, 400)
        const limit = Math.min(50, Number(u.searchParams.get('limit') || 30))
        const offset = Math.max(0, Number(u.searchParams.get('offset') || 0))
        const r = await fetchJson(
          env,
          `/v1/comments?variant_id=${encodeURIComponent(showId)}&limit=${limit}&offset=${offset}&sort=latest&include_folded=true`
        )
        const items = (r.results || []).map((c) => ({
          id: c.id,
          content: String(c.content || '').slice(0, 300),
          up: Number(c.up_count) || 0,
          replies: Number(c.reply_count) || 0,
          at: c.created_at || '',
          author:
            c.author?.display_name ||
            c.author?.nickname ||
            c.author?.name ||
            (c.author?.id ? String(c.author.id).slice(-6) : '观众'),
        }))
        return json({ object: 'comments', items, hasMore: !!r.has_more, total: r.folded_count ?? null })
      }

      if (u.pathname === '/api/audit') {
        const id = u.searchParams.get('show')
        if (!id) return json({ error: '缺少 show' }, 400)
        const health = await dbAll(env, 'SELECT provider, verdict, detail, checked_at FROM provider_health WHERE show_id=? ORDER BY verdict', id)
        const coverage = (await dbFirst(env, "SELECT COUNT(DISTINCT ep_idx) c FROM sources WHERE show_id=? AND status='ok'", id)).c
        const eps = (await dbFirst(env, 'SELECT COUNT(*) c FROM episodes WHERE show_id=?', id)).c
        return json({ show: id, episodes: eps, verifiedEpisodes: coverage, providers: health })
      }

      // 手动触发增量同步（x-sync-key = sha256(KJ_SECRET + ':sync') 前 16 位）
      if (u.pathname === '/api/sync') {
        if (request.method !== 'POST') return json({ error: 'POST only' }, 405)
        const key = request.headers.get('x-sync-key') || ''
        const expected = await sha(env.KJ_SECRET + ':sync')
        let authorized = safeEqual(key, expected)
        if (!authorized) {
          const timestamp = request.headers.get('x-ai-movie-timestamp') || ''
          const nonce = request.headers.get('x-ai-movie-nonce') || ''
          const signature = request.headers.get('x-ai-movie-signature') || ''
          const timestampValue = Number(timestamp)
          if (Number.isFinite(timestampValue) && Math.abs(Date.now() - timestampValue) <= 300_000 && /^[a-f0-9]{32}$/i.test(nonce)) {
            const signed = await hmacHex(env.KJ_SECRET, `POST\n${u.pathname}${u.search}\n${timestamp}\n${nonce}`)
            authorized = safeEqual(signature, signed)
          }
        }
        if (!authorized) return json({ error: 'forbidden' }, 403)
        const mode = u.searchParams.get('mode') || 'all'
        const seed = Number(u.searchParams.get('seed') || 6)
        const out = { object: 'sync', mode }
        if (mode === 'feed' || mode === 'all') {
          out.feed = await syncHomeFeed(env, (p) => fetchJson(env, p), { cards: 20, seedBudget: seed })
        }
        if (mode === 'hot' || mode === 'all') {
          out.hot = await syncHotRanks(env, (p) => fetchJson(env, p), {
            pages: Number(u.searchParams.get('hotPages') || 5),
            seedBudget: Number(u.searchParams.get('hotSeed') || 3),
            kinds: (u.searchParams.get('kinds') || '').split(',').filter(Boolean).length
              ? u.searchParams.get('kinds').split(',').filter(Boolean)
              : undefined,
          })
        }
        if (mode === 'update' || mode === 'all') {
          out.update = await syncOnce(env, (p) => fetchJson(env, p), {
            maxShows: Number(u.searchParams.get('max') || 10),
            maxPages: Number(u.searchParams.get('pages') || 2),
            sort: u.searchParams.get('sort') || 'update_desc',
            kind: u.searchParams.get('kind') || '',
            force: u.searchParams.get('force') === '1',
          })
        }
        await caches.default.delete(new Request(new URL('/api/home-feed?v=5', request.url)))
        return json(out)
      }

      return json({ error: 'not found', paths: ['/api/health', '/api/list', '/api/show', '/api/lines', '/api/play', '/api/audit', '/api/progress', '/api/auth/register', '/api/auth/login', '/api/auth/me', '/api/user/progress', '/api/danmaku', '/api/comments', '/api/sync'] }, 404)
    } catch (e) {
      return json({ error: String(e.message || e) }, 500)
    }
  },

  // 定时增量同步：上游有新剧/新集 → 写入 D1
  async scheduled(event, env, ctx) {
    const now = Date.now()
    ctx.waitUntil(
      Promise.all([
        dbRun(env, 'DELETE FROM auth_sessions WHERE expires_at<=?', now),
        dbRun(env, 'DELETE FROM auth_attempts WHERE window_start<=?', now - 24 * 60 * 60 * 1000),
      ]).catch(() => {})
    )
    if (env.SYNC_DISABLED === '1') return
    ctx.waitUntil(
      (async () => {
        const fetch = (p) => fetchJson(env, p)
        // 先刷新首页栏目与四个分类热榜（内容与会原站保持一致），再补最近更新的新剧/新集
        const feed = await syncHomeFeed(env, fetch, { cards: 20, seedBudget: 8 }).catch((e) => ({ error: String(e.message || e) }))
        const hot = await syncHotRanks(env, fetch, { pages: 5, seedBudget: 4 }).catch((e) => ({ error: String(e.message || e) }))
        const updated = await syncOnce(env, fetch, { maxShows: 10, maxPages: 3, sort: 'update_desc' })
        return { feed, hot, updated }
      })().catch(() => {})
    )
  },
}
