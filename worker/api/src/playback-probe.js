export async function inspectHlsResource(url, { fetchImpl = fetch, timeoutMs = 5000, depth = 0, maxDepth = 3 } = {}) {
  if (depth > maxDepth) return { ok: false, kind: 'hls', error: 'variant_depth_exceeded' }
  let response
  try {
    response = await fetchImpl(url, { headers: { accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    return { ok: false, kind: 'hls', error: 'fetch_failed' }
  }
  if (!response.ok) return { ok: false, kind: 'hls', status: response.status, error: `http_${response.status}` }
  const text = await response.text()
  if (!text.includes('#EXTM3U')) return { ok: false, kind: 'hls', error: 'not_m3u8' }

  if (/#EXT-X-STREAM-INF/i.test(text)) {
    const rows = text.split('\n').map((line) => line.trim())
    const variants = []
    for (let index = 0; index < rows.length; index++) {
      if (!rows[index].startsWith('#EXT-X-STREAM-INF')) continue
      const path = rows.slice(index + 1).find((line) => line && !line.startsWith('#'))
      if (!path) continue
      const height = Number(rows[index].match(/RESOLUTION=\d+x(\d+)/i)?.[1] || 0)
      variants.push({ url: new URL(path, response.url || url).href, height })
    }
    variants.sort((a, b) => (b.height === 1080) - (a.height === 1080) || b.height - a.height)
    for (const variant of variants) {
      const probe = await inspectHlsResource(variant.url, { fetchImpl, timeoutMs, depth: depth + 1, maxDepth })
      if (probe.ok) return { ...probe, variantHeight: variant.height }
    }
    return { ok: false, kind: 'hls', error: 'no_playable_variant' }
  }

  const segments = text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  if (!segments.length) return { ok: false, kind: 'hls', error: 'empty_playlist' }
  const firstSegment = new URL(segments[0], response.url || url).href
  let segmentResponse
  try {
    segmentResponse = await fetchImpl(firstSegment, { headers: { range: 'bytes=0-65535' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    return { ok: false, kind: 'hls', error: 'first_segment_unavailable' }
  }
  if (!segmentResponse.ok) return { ok: false, kind: 'hls', error: `first_segment_http_${segmentResponse.status}` }
  const segment = await segmentResponse.arrayBuffer()
  if (!segment.byteLength) return { ok: false, kind: 'hls', error: 'first_segment_empty' }
  const duration = [...text.matchAll(/#EXTINF:([0-9.]+)/g)].reduce((sum, match) => sum + Number(match[1]), 0)
  return { ok: true, kind: 'hls', segments: segments.length, duration, firstSegment, firstBytes: segment, variantHeight: 0 }
}
