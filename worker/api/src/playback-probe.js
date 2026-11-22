import { mediaDimensions, readBounded } from './media-dimensions.js'

const PLAYER_ORIGIN = 'https://zhuiju.dpdns.org'

function mediaResource(path, base) {
  const url = new URL(path, base)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid_media_url')
  return url.href
}

function byteRange(spec) {
  if (!spec) return null
  const match = /^(\d+)@(\d+)$/.exec(spec)
  if (!match) throw new Error('unsupported_byte_range')
  const length = Number(match[1])
  const start = Number(match[2])
  if (!length || !Number.isSafeInteger(start + length) || length > 8 * 1024 * 1024) throw new Error('unsupported_byte_range')
  return { start, end: start + length - 1 }
}

// Cloudflare 免费版一次 Worker 调用最多 50 个子请求。媒体探测的每个请求都从这里过，
// 计数用完就把线路留成「未探测」，不能让它变成死线或继续发请求。
function countedFetch(fetchImpl, budget) {
  if (!budget) return fetchImpl
  return (resource, options) => {
    if (!budget.canSpend(1)) throw new Error('probe_budget_exceeded')
    budget.spend(1)
    return fetchImpl(resource, options)
  }
}

function corsAllowsPlayer(response) {
  let sameOrigin = false
  try { sameOrigin = new URL(response.url).origin === PLAYER_ORIGIN } catch { return false }
  if (sameOrigin) return true
  const allowed = response.headers?.get('access-control-allow-origin')
  return allowed === '*' || allowed?.split(/\s*,\s*/).includes(PLAYER_ORIGIN) === true
}

function hasMediaContainer(buffer) {
  const bytes = new Uint8Array(buffer)
  // Transport streams carry a sync byte at every 188-byte packet boundary.
  if (bytes.length >= 188 * 3 && isTransportStream(buffer)) return true
  // HLS fragmented MP4 starts with an optional segment type, followed by a movie fragment.
  const view = new DataView(buffer)
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset)
    if (size < 8 || offset + size > bytes.length) break
    if (view.getUint32(offset + 4) === 0x6d6f6f66) return true // moof
    offset += size
  }
  return false
}

function isTransportStream(buffer) {
  const bytes = new Uint8Array(buffer)
  if (bytes.length < 188 * 3) return false
  const firstSync = bytes.indexOf(0x47)
  if (firstSync > 187 || firstSync + 188 * 2 >= bytes.length) return false
  return [firstSync, firstSync + 188, firstSync + 376].every((offset) => {
    const adaptationControl = (bytes[offset + 3] >> 4) & 0x03
    return bytes[offset] === 0x47 && adaptationControl !== 0
  })
}

function segmentIv(tag, playlist) {
  const explicit = tag.match(/(?:^|,)IV=0x([0-9a-f]+)(?:,|$)/i)?.[1]
  const sequence = playlist.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m)?.[1] || '0'
  const hex = (explicit || BigInt(sequence).toString(16)).padStart(32, '0')
  if (hex.length !== 32) throw new Error('invalid_iv')
  return Uint8Array.from(hex.match(/../g), (byte) => parseInt(byte, 16))
}

async function fetchPart(fetchImpl, url, signal, range, limit) {
  const headers = { origin: PLAYER_ORIGIN }
  if (range) headers.range = `bytes=${range.start}-${range.end}`
  const r = await fetchImpl(url, { headers, redirect: 'follow', signal })
  if (!r.ok) throw new Error(`http_${r.status}`)
  if (!corsAllowsPlayer(r)) throw new Error('cors_blocked')
  if (range && r.status !== 206) throw new Error('invalid_byte_range')
  if (r.status === 206) {
    const bounds = r.headers?.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/)
    if (range && (!bounds || Number(bounds[1]) !== range.start || Number(bounds[2]) !== range.end)) throw new Error('invalid_byte_range')
    if (!range && bounds && (!/^\d+$/.test(bounds[3]) || Number(bounds[1]) !== 0 || Number(bounds[2]) + 1 !== Number(bounds[3]))) throw new Error('incomplete')
  }
  const body = await readBounded(r, range ? range.end - range.start + 1 : limit, { requireComplete: true })
  if (range && body.byteLength !== range.end - range.start + 1) throw new Error('incomplete')
  return body
}

export async function inspectHlsResource(url, { fetchImpl = fetch, timeoutMs = 5000, signal, depth = 0, maxDepth = 3, budget } = {}) {
  if (depth > maxDepth) return { ok: false, kind: 'hls', error: 'variant_depth_exceeded' }
  fetchImpl = countedFetch(fetchImpl, budget)
  if (depth === 0) signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  const probeStarted = Date.now()
  let response
  let text
  try {
    response = await fetchImpl(mediaResource(url, url), { headers: { accept: '*/*', origin: PLAYER_ORIGIN }, redirect: 'follow', signal })
    if (!response.ok) return { ok: false, kind: 'hls', status: response.status, error: `http_${response.status}` }
    if (!corsAllowsPlayer(response)) return { ok: false, kind: 'hls', error: 'playlist_cors_blocked' }
    if (response.body?.getReader) text = new TextDecoder().decode(await readBounded(response, 1024 * 1024, { requireComplete: true }))
    else text = await response.text()
  } catch (error) {
    return { ok: false, kind: 'hls', error: error?.message === 'probe_budget_exceeded' ? 'probe_budget_exceeded' : 'fetch_failed' }
  }
  if (!text.trimStart().startsWith('#EXTM3U')) return { ok: false, kind: 'hls', error: 'not_m3u8' }
  if (depth === 0 && Date.now() - probeStarted >= timeoutMs) return { ok: false, kind: 'hls', error: 'probe_timeout' }

  if (/#EXT-X-STREAM-INF/i.test(text)) {
    const rows = text.split('\n').map((line) => line.trim())
    const variants = []
    for (let index = 0; index < rows.length; index++) {
      if (!rows[index].startsWith('#EXT-X-STREAM-INF')) continue
      const path = rows[index + 1]
      if (!path || path.startsWith('#')) continue
      try {
        const height = Number(rows[index].match(/RESOLUTION=\d+x(\d+)/i)?.[1] || 0)
        variants.push({ url: mediaResource(path, response.url || url), height })
      } catch { /* Invalid variant URL is not playable. */ }
    }
    variants.sort((a, b) => (b.height === 1080) - (a.height === 1080) || b.height - a.height)
    let best
    for (const variant of variants) {
      if (signal.aborted || Date.now() - probeStarted >= timeoutMs) break
      const probe = await inspectHlsResource(variant.url, { fetchImpl, timeoutMs, signal, depth: depth + 1, maxDepth })
      if (!probe.ok || signal.aborted || Date.now() - probeStarted >= timeoutMs) continue
      if (probe.height === 1080) return probe
      if (!best || probe.height > best.height) best = probe
    }
    return best || { ok: false, kind: 'hls', error: 'no_playable_variant' }
  }

  const segments = text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  if (!segments.length) return { ok: false, kind: 'hls', error: 'empty_playlist' }
  const base = response.url || url
  const beforeFirst = text.split(/\r?\n/).map((row) => row.trim()).slice(0, text.split(/\r?\n/).findIndex((row) => row.trim() === segments[0]))
  const lastTag = (tag) => beforeFirst.findLast((row) => row.startsWith(tag))?.slice(tag.length) || ''
  let init
  let decryptionKey
  const key = lastTag('#EXT-X-KEY:')
  try {
    if (key && !/(?:^|,)METHOD=NONE(?:,|$)/.test(key)) {
      const uri = key.match(/(?:^|,)URI="([^"]+)"/)?.[1]
      if (!uri || !/(?:^|,)METHOD=AES-128(?:,|$)/.test(key) || /KEYFORMAT="(?!identity")/.test(key)) throw new Error('unsupported_key')
      const keyBytes = await fetchPart(fetchImpl, mediaResource(uri, base), signal, null, 16)
      if (keyBytes.byteLength !== 16) throw new Error('invalid_key')
      decryptionKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['decrypt'])
    }
    const map = lastTag('#EXT-X-MAP:')
    if (map) {
      const uri = map.match(/(?:^|,)URI="([^"]+)"/)?.[1]
      if (!uri) throw new Error('invalid_init')
      init = await fetchPart(fetchImpl, mediaResource(uri, base), signal, byteRange(map.match(/BYTERANGE="([^"]+)"/)?.[1]), 1024 * 1024)
      if (!init.byteLength) throw new Error('empty_init')
    }
  } catch {
    return { ok: false, kind: 'hls', error: 'playlist_dependencies_unavailable' }
  }
  let firstSegment
  let segment
  const started = Date.now()
  try {
    firstSegment = mediaResource(segments[0], base)
    segment = await fetchPart(fetchImpl, firstSegment, signal, byteRange(lastTag('#EXT-X-BYTERANGE:')), 8 * 1024 * 1024)
  } catch (error) {
    if (error?.message === 'probe_budget_exceeded') return { ok: false, kind: 'hls', error: 'probe_budget_exceeded' }
    const reason = /^(http_\d+|incomplete|cors_blocked)$/.test(error.message) ? error.message : 'unavailable'
    return { ok: false, kind: 'hls', error: `first_segment_${reason}` }
  }
  const firstSegmentMs = Date.now() - started
  if (!segment.byteLength) return { ok: false, kind: 'hls', error: 'first_segment_empty' }
  if (decryptionKey) {
    try {
      segment = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: segmentIv(key, text) }, decryptionKey, segment)
    } catch {
      return { ok: false, kind: 'hls', error: 'first_segment_decryption_failed' }
    }
  }
  if (!hasMediaContainer(segment)) return { ok: false, kind: 'hls', error: 'first_segment_not_media' }
  const duration = [...text.matchAll(/#EXTINF:([0-9.]+)/g)].reduce((sum, match) => sum + Number(match[1]), 0)
  const probeMs = Date.now() - probeStarted
  if (depth === 0 && probeMs >= timeoutMs) return { ok: false, kind: 'hls', error: 'probe_timeout' }
  const dimensions = mediaDimensions(init || segment)
  if (isTransportStream(segment) && !dimensions.height) return { ok: true, kind: 'hls', segments: segments.length, duration, firstSegment, firstSegmentMs, probeMs: Date.now() - probeStarted, firstBytes: segment.slice(0, 65536), variantHeight: 0, width: 0, height: 0, qualitySource: 'unknown', mediaUrl: response.url || url }
  return { ok: true, kind: 'hls', segments: segments.length, duration, firstSegment, firstSegmentMs, probeMs, firstBytes: segment.slice(0, 65536), variantHeight: dimensions.height, ...dimensions, qualitySource: dimensions.height ? 'media' : 'unknown', mediaUrl: response.url || url }
}
