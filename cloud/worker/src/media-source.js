// 片源线路识别与「集数一致性」指纹校验（Workers 版，WebCrypto 实现）
// 与 server/media-source.mjs 保持同一套判定逻辑：同一部剧不同集的指纹必须不同。
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export const PROVIDER_PRIORITY = [
  'hongniu',
  'xinlang',
  'hhzy',
  'subo',
  'jinying',
  'jszy',
  'iqiyi',
  'mdzy',
  'xigua',
  'wsyzy',
  'ikun',
  'bfzy',
  'uku',
  'dytt',
  'maotai',
  'wujin',
  'maoyan',
  'zuida',
  'niuniu',
  'zy360',
  'ffzy',
  'suoni',
  'yyzy1080',
]

const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|avif)(\?|$)/i
const HLS_RE = /\.m3u8(\?|$)/i
const MP4_RE = /\.(mp4|m4v)(\?|$)/i

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

export async function sha1(s, len = 16) {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(String(s)))
  return hex(d).slice(0, len)
}

export function guessKind(url, contentType = '') {
  if (/image\//i.test(contentType) || IMAGE_RE.test(url)) return 'image'
  if (/mpegurl/i.test(contentType) || HLS_RE.test(url)) return 'hls'
  if (/^video\//i.test(contentType) || MP4_RE.test(url)) return 'mp4'
  return 'unknown'
}

export const isPlayableKind = (k) => k === 'hls' || k === 'mp4'

export function priorityOf(provider) {
  const i = PROVIDER_PRIORITY.indexOf(provider)
  return i < 0 ? 90 : i
}

export function absUrl(base, ref) {
  try {
    return new URL(ref, base).href
  } catch {
    return ref
  }
}

async function getText(url, timeout) {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, accept: '*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  })
  const text = await r.text()
  return {
    status: r.status,
    ok: r.ok,
    contentType: r.headers.get('content-type') || '',
    text,
    finalUrl: r.url || url,
  }
}

export async function segmentFingerprint(url, bytes = 65536, timeout = 15000) {
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA, range: `bytes=0-${bytes - 1}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    })
    if (r.status >= 400) return { ok: false, error: `http_${r.status}` }
    const buf = await r.arrayBuffer()
    if (buf.byteLength < 1024) return { ok: false, error: 'too_small' }
    return { ok: true, bytes: buf.byteLength, fingerprint: (await sha1Buffer(buf)).slice(0, 16) }
  } catch (e) {
    return { ok: false, error: 'fetch_failed', detail: String(e.message || e).slice(0, 80) }
  }
}

async function sha1Buffer(buf) {
  const d = await crypto.subtle.digest('SHA-1', buf)
  return hex(d)
}

export async function inspectHls(url, opts = {}) {
  const { timeout = 15000, contentHash = false } = typeof opts === 'number' ? { timeout: opts } : opts
  let r
  try {
    r = await getText(url, timeout)
  } catch (e) {
    return { ok: false, kind: 'hls', error: 'fetch_failed', detail: String(e.message || e).slice(0, 80) }
  }
  if (!r.ok) return { ok: false, kind: 'hls', status: r.status, error: `http_${r.status}` }
  if (/image\//i.test(r.contentType)) return { ok: false, kind: 'image', error: 'placeholder_image' }
  if (!r.text.includes('#EXTM3U')) {
    return { ok: false, kind: /<html/i.test(r.text) ? 'page' : 'unknown', error: 'not_m3u8' }
  }
  if (/#EXT-X-STREAM-INF/i.test(r.text)) {
    const variant = r.text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'))
    if (variant) return inspectHls(absUrl(r.finalUrl, variant), { timeout, contentHash })
  }
  const segments = r.text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  const durations = [...r.text.matchAll(/#EXTINF:([0-9.]+)/g)].map((m) => Number(m[1]))
  const duration = durations.reduce((a, b) => a + b, 0)
  if (!segments.length) return { ok: false, kind: 'hls', error: 'empty_playlist', segments: 0, duration: 0 }
  const first = absUrl(r.finalUrl, segments[0])
  const out = {
    ok: true,
    kind: 'hls',
    segments: segments.length,
    duration,
    first,
    fingerprint: await sha1(`${first.split('?')[0]}|${segments.length}|${Math.round(duration)}`),
  }
  if (contentHash) {
    const seg = await segmentFingerprint(first, 65536, timeout)
    out.contentFingerprint = seg.ok ? seg.fingerprint : null
    if (!seg.ok) out.contentError = seg.error
  }
  return out
}

export async function inspectMp4(url, timeout = 15000) {
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA, range: 'bytes=0-4095' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    })
    const ct = r.headers.get('content-type') || ''
    const len = r.headers.get('content-range') || r.headers.get('content-length') || ''
    if (r.status >= 400) return { ok: false, kind: 'mp4', status: r.status, error: `http_${r.status}` }
    if (/image\/|text\/html/i.test(ct)) {
      return { ok: false, kind: /image/i.test(ct) ? 'image' : 'page', error: 'not_video' }
    }
    if (!/video\/|octet-stream|mp4/i.test(ct) && r.status !== 206) {
      return { ok: false, kind: 'unknown', error: 'not_video', contentType: ct }
    }
    return { ok: true, kind: 'mp4', length: len, fingerprint: await sha1(`${String(r.url || url).split('?')[0]}|${len}`) }
  } catch (e) {
    return { ok: false, kind: 'mp4', error: 'fetch_failed', detail: String(e.message || e).slice(0, 80) }
  }
}

export async function inspectSource(url, opts = {}) {
  const { timeout = 15000, contentHash = false } = typeof opts === 'number' ? { timeout: opts } : opts
  const kind = guessKind(url)
  if (kind === 'image') return { ok: false, kind: 'image', error: 'placeholder_image' }
  if (kind === 'hls') return inspectHls(url, { timeout, contentHash })
  if (kind === 'mp4') return inspectMp4(url, timeout)
  const hls = await inspectHls(url, { timeout, contentHash })
  if (hls.ok) return hls
  return inspectMp4(url, timeout)
}

export function lineOptions(rv) {
  return (rv?.line_options || [])
    .map((o) => {
      const raw = String(o.url || '')
      const ticket = raw.startsWith('resolve://') ? raw.slice('resolve://'.length) : ''
      return {
        provider: o.provider_id || '',
        label: o.label || o.display_label || '',
        ticket,
        url: ticket ? '' : raw,
        type: o.type || '',
        priority: priorityOf(o.provider_id || ''),
      }
    })
    .filter((x) => x.provider && (x.ticket || x.url))
}
