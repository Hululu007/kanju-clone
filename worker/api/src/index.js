// kanju-api —— Cloudflare Worker 版片源服务（D1）
import { syncOnce } from './sync.js'
import { syncHomeFeed, syncHotRanks } from './feed-sync.js'
import { inspectHlsResource } from './playback-probe.js'
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
const qualityRank = (label = '') => {
  const text = String(label)
  const match = text.match(/(\d{3,4})\s*[pP]?/)
  if (match) return Number(match[1])
  if (/4K|UHD/i.test(text)) return 2160
  if (/高清|HD/i.test(text)) return 720
  return 0
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,authorization',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-max-age': '86400',
}
const json = (data, status = 200, cacheControl = 'no-store') =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': cacheControl } })

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)))).slice(0, 16)

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

async function signedFetch(env, path, { method = 'GET', body, cookie = '', timeout = 20000 } = {}) {
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
  const res = await fetch(u, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeout),
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

async function getGuest(env, force = false) {
  if (guest && !force) return guest
  if (guestForceAt && Date.now() - guestForceAt < 300_000) return guest
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
  const res = await signedFetch(env, '/v1/users/anonymous', { method: 'POST', body: { anonymous_id: anon } })
  if (res.status < 200 || res.status >= 300) throw new Error(`访客会话失败 HTTP ${res.status}`)
  const pick = res.cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('ai_movie_session=') && c.length > 18)
  if (!pick) throw new Error('访客会话失败：没有 cookie')
  guest = pick
  guestForceAt = force ? Date.now() : 0
  await dbRun(env, "INSERT INTO meta(key,value,updated_at) VALUES('guest_cookie',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", pick).catch(() => {})
  return guest
}

const resolveCache = new Map()
async function resolveEpisode(env, ep) {
  const hit = resolveCache.get(ep.token)
  if (hit && Date.now() - hit.at < 60_000) return hit.value
  await throttle()
  const cookie = await getGuest(env).catch(() => '')
  let r = await signedFetch(env, `/v1/playback/resolve/${ep.token}?view=compact`, { cookie })
  if (r.status === 401 && /playback_user_session_required/.test(r.text)) {
    const fresh = await getGuest(env, true).catch(() => '')
    r = await signedFetch(env, `/v1/playback/resolve/${ep.token}?view=compact`, { cookie: fresh })
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

async function resolveTicket(env, ticket) {
  await throttle()
  const cookie = await getGuest(env).catch(() => '')
  const r = await signedFetch(env, '/v1/playback/resolve-line', { method: 'POST', body: { ticket }, cookie })
  if (r.status < 200 || r.status >= 300) {
    const err = new Error(`HTTP ${r.status} ${r.text.slice(0, 120)}`)
    err.body = r.text
    throw err
  }
  return JSON.parse(r.text)?.line?.url || ''
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

function orderLines(lines, stats = new Map()) {
  return [...lines].sort((a, b) => {
    const rankA = qualityRank(a.label)
    const rankB = qualityRank(b.label)
    const exact1080A = rankA === 1080
    const exact1080B = rankB === 1080
    if (exact1080A !== exact1080B) return exact1080A ? -1 : 1
    const sa = stats.get(a.provider)
    const sb = stats.get(b.provider)
    const scoreA = sa ? Number(sa.successes || 0) / Math.max(1, Number(sa.successes || 0) + Number(sa.failures || 0)) : null
    const scoreB = sb ? Number(sb.successes || 0) / Math.max(1, Number(sb.successes || 0) + Number(sb.failures || 0)) : null
    if (scoreA != null && scoreB == null) return -1
    if (scoreB != null && scoreA == null) return 1
    if (scoreA != null && scoreB != null && scoreA !== scoreB) return scoreB - scoreA
    if (a.selected !== b.selected) return a.selected ? -1 : 1
    if (a.group !== b.group) return a.group === 'official' ? -1 : 1
    if (a.group === 'official') return a.index - b.index
    return a.priority - b.priority
  })
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

async function inspectHls(url) {
  const result = await inspectHlsResource(url, {
    fetchImpl: (resource, options) => fetch(resource, { ...options, headers: { ...options.headers, 'user-agent': UA } }),
    timeoutMs: 5000,
  })
  if (!result.ok) return result
  const first = result.firstSegment
  const contentFingerprint = result.firstBytes.byteLength > 1024 ? await sha(new Uint8Array(result.firstBytes)) : null
  return {
    ...result,
    first,
    fingerprint: contentFingerprint || (await sha(`${first.split('?')[0]}|${result.segments}|${Math.round(result.duration)}`)),
  }
}

async function inspectMp4(url) {
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA, range: 'bytes=0-4095' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    })
    if (r.status >= 400) return { ok: false, kind: 'mp4', status: r.status, error: `http_${r.status}` }
    const ct = r.headers.get('content-type') || ''
    const len = r.headers.get('content-range') || r.headers.get('content-length') || ''
    const buf = await r.arrayBuffer()
    const kind = sniff(buf, ct)
    if (kind === 'hls') return inspectHls(url)
    if (kind === 'image') return { ok: false, kind: 'image', error: 'placeholder_image' }
    if (kind === 'html') return { ok: false, kind: 'page', error: 'not_video' }
    if (kind !== 'mp4') return { ok: false, kind, error: 'not_video', contentType: ct }
    if (!buf.byteLength) return { ok: false, kind: 'mp4', error: 'empty_media' }
    return { ok: true, kind: 'mp4', length: len, fingerprint: await sha(`${String(r.url || url).split('?')[0]}|${len}`) }
  } catch (e) {
    return { ok: false, kind: 'mp4', error: 'fetch_failed' }
  }
}

async function inspectSource(url) {
  if (/\.m3u8(\?|$)/i.test(url)) return inspectHls(url)
  return inspectMp4(url)
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

async function saveSource(env, showId, epIdx, s) {
  await dbRun(
    env,
    `INSERT INTO sources(show_id,ep_idx,provider,label,url,kind,fingerprint,segments,duration,status,checked_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(show_id,ep_idx,provider) DO UPDATE SET label=excluded.label,url=excluded.url,kind=excluded.kind,
       fingerprint=excluded.fingerprint,segments=excluded.segments,duration=excluded.duration,status=excluded.status,checked_at=excluded.checked_at`,
    showId,
    epIdx,
    s.provider,
    s.label ?? null,
    s.url ?? null,
    s.kind ?? null,
    s.fingerprint ?? null,
    s.segments ?? null,
    s.duration ?? null,
    s.status ?? 'ok'
  ).catch(() => {})
}

async function playUrl(env, showId, idx, preferred = '') {
  // 指定线路时不读缓存，避免返回上一次自动选择的结果
  const key = `${showId}#${idx}#${preferred || ''}`
  const hit = playCache.get(key)
  if (!preferred && hit && Date.now() - hit.at < 90_000) return { ...hit.value, cached: true }

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
    rv = await resolveEpisode(env, ep)
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
  const playbackStats = new Map((await dbAll(env, 'SELECT provider,successes,failures FROM provider_playback_stats WHERE show_id=?', showId).catch(() => [])).map((row) => [row.provider, row]))
  if (preferred && health.get(preferred)?.verdict === 'dup') throw new Error('该线路已判定串集，已停用；请换一条线路')

  // 片头片尾（原站 /v1/catalog/:id 的 playback_skip_settings_preset），按剧缓存到 D1
  let skip = null
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
    if (intro != null) skip = { introEnd: intro, outroFrom: outro }
  } catch {
    /* 拿不到就不显示跳过按钮 */
  }

  const lines = orderLines(lineOptions(rv), playbackStats).filter((l) => health.get(l.provider)?.verdict !== 'dup')
  if (preferred) {
    const at = lines.findIndex((l) => l.provider === preferred)
    if (at > 0) lines.unshift(lines.splice(at, 1)[0])
  }
  const attempt = preferred ? lines.filter((l) => l.provider === preferred) : lines.slice(0, 20)

  const tried = []
  for (const line of attempt) {
    let url = line.url
    if (!url && line.ticket) {
      try {
        url = await resolveTicket(env, line.ticket)
      } catch (e) {
        const body = String(e.body || e.message || '')
        if (/playback_user_session_required|login_required/.test(body)) {
          await setHealth(env, showId, line.provider, 'member', '需要登录/会员')
          tried.push({ label: line.label, provider: line.provider, reason: 'member' })
        } else {
          tried.push({ label: line.label, provider: line.provider, reason: 'resolve_failed' })
        }
        continue
      }
    }
    if (!url) {
      tried.push({ label: line.label, provider: line.provider, reason: 'no_url' })
      continue
    }
    const info = await inspectSource(url)
    if (!info.ok) {
      tried.push({ label: line.label, provider: line.provider, reason: info.error || 'not_playable', kind: info.kind })
      await saveSource(env, showId, Number(idx), { provider: line.provider, label: line.label, url, kind: info.kind, status: info.error || 'dead' })
      continue
    }
    const fp = info.fingerprint
    const rows = await dbAll(env, 'SELECT ep_idx, fingerprint FROM sources WHERE show_id=? AND provider=? AND fingerprint IS NOT NULL', showId, line.provider).catch(() => [])
    const collision = rows.find((r) => r.fingerprint === fp && Number(r.ep_idx) !== Number(idx))
    if (collision) {
      await setHealth(env, showId, line.provider, 'dup', `第${Number(collision.ep_idx) + 1}集与第${Number(idx) + 1}集同内容`)
      tried.push({ label: line.label, provider: line.provider, reason: 'episode_collision' })
      continue
    }
    if (!rows.length && firstEp && Number(idx) !== Number(firstEp.idx)) {
      const base = await dbFirst(env, 'SELECT fingerprint FROM provider_baseline WHERE show_id=? AND provider=?', showId, line.provider).catch(() => null)
      if (base?.fingerprint && base.fingerprint === fp) {
        await setHealth(env, showId, line.provider, 'dup', '所有集指向第1集')
        tried.push({ label: line.label, provider: line.provider, reason: 'same_as_first_episode' })
        continue
      }
    }
    await saveSource(env, showId, Number(idx), {
      provider: line.provider,
      label: line.label,
      url,
      kind: info.kind,
      fingerprint: fp,
      segments: info.segments,
      duration: info.duration,
      status: 'ok',
    })
    const value = {
      showId,
      idx: Number(idx),
      url,
      kind: info.kind,
      episodeNumber: Number(gotNum ?? wantNum),
      line: line.label,
      provider: line.provider,
      segments: info.segments,
      duration: info.duration,
      quality: info.variantHeight || qualityRank(line.label),
      fingerprint: fp,
      verified: true,
      skip,
      options: lineOptions(rv).map((l) => ({
        provider: l.provider,
        label: l.label,
        group: l.group,
        mode: l.ticket ? 'ticket' : 'direct',
        status: health.get(l.provider)?.verdict || 'unknown',
        selected: l.provider === line.provider,
      })),
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
            episodes: liveEps.map((e, i) => ({ idx: i, label: e.title || `第${e.number || i + 1}集`, playable: !!e.token })),
          })
        }
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
          episodes: eps.map((e) => ({ idx: e.idx, label: e.title || `第${e.number || e.idx + 1}集`, playable: !!e.token, quality: e.quality, line: e.line_label })),
        })
      }

      if (u.pathname === '/api/line-result') {
        if (request.method !== 'POST') return json({ error: '只支持 POST' }, 405)
        const origin = request.headers.get('origin') || ''
        if (origin !== 'https://zhuiju.dpdns.org') return json({ error: '来源不允许' }, 403)
        const body = await request.json().catch(() => ({}))
        const provider = String(body.provider || '').slice(0, 80)
        if (!provider || !/^[a-zA-Z0-9_-]+$/.test(provider)) return json({ error: '线路参数无效' }, 400)
        if (typeof body.ok !== 'boolean') return json({ error: '结果参数无效' }, 400)
        const showId = String(body.showId || '').slice(0, 120)
        if (!/^[a-zA-Z0-9_-]+$/.test(showId)) return json({ error: '作品参数无效' }, 400)
        await dbRun(env,
          `INSERT INTO provider_playback_stats(show_id,provider,successes,failures,updated_at) VALUES(?,?,?,?,datetime('now'))
           ON CONFLICT(show_id,provider) DO UPDATE SET successes=successes+excluded.successes, failures=failures+excluded.failures, updated_at=datetime('now')`,
          showId, provider, body.ok ? 1 : 0, body.ok ? 0 : 1)
        return json({ ok: true })
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
        const playbackStats = new Map((await dbAll(env, 'SELECT provider,successes,failures FROM provider_playback_stats WHERE show_id=?', showId).catch(() => [])).map((row) => [row.provider, row]))
        return json({
          object: 'lines',
          showId,
          idx,
          episodeNumber: rv?.current_episode?.episode_number ?? ep.number,
          options: orderLines(lineOptions(rv), playbackStats).map((l) => ({
            provider: l.provider,
            label: l.label,
            group: l.group,
            mode: l.ticket ? 'ticket' : 'direct',
            status: health.get(l.provider)?.verdict || 'unknown',
          })),
        })
      }

      if (u.pathname === '/api/play') {
        const showId = u.searchParams.get('show')
        const idx = Number(u.searchParams.get('ep') || 0)
        const line = u.searchParams.get('line') || ''
        const out = await playUrl(env, showId, idx, line)
        return json({ object: 'play', ...out })
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
