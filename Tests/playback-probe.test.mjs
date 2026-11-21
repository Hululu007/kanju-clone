import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { inspectHlsResource } from '../worker/api/src/playback-probe.js'

function response(body, { ok = true, status = 200, url = '', headers = {}, arrayBuffer } = {}) {
  return {
    ok,
    status,
    url,
    headers: new Headers({ 'access-control-allow-origin': '*', ...headers }),
    text: async () => body,
    arrayBuffer: arrayBuffer || (async () => new Uint8Array([1, 2, 3]).buffer),
  }
}

const playlist = (url, body) => response(body, { url })
const segment = (body = new Uint8Array(188 * 2).fill(0x47), extraHeaders = {}, url = 'https://media.example/seg-1.ts') => response('', {
  ok: true,
  status: 206,
  url,
  headers: { 'content-range': `bytes 0-${body.length - 1}/${body.length}`, ...extraHeaders },
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
})

const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url))

test('master playlist reports measured 1080p only after its segment is fetched', async () => {
  const media = await fixture('avc-1080.ts')
  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push({ url, options })
    if (url.endsWith('/master.m3u8')) return playlist(url, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1280x720\n720/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080\n1080/index.m3u8')
    if (url.endsWith('/1080/index.m3u8')) return playlist(url, '#EXTM3U\n#EXTINF:6,\nseg-1.ts')
    if (url.endsWith('/seg-1.ts')) return segment(media, {}, url)
    throw new Error('unexpected request')
  }
  const result = await inspectHlsResource('https://media.example/master.m3u8', { fetchImpl })
  assert.equal(result.ok, true, JSON.stringify({ error: result.error, variantHeight: result.variantHeight, requests: requests.map((request) => request.url) }))
  assert.equal(result.variantHeight, 1080)
  assert.equal(result.width, 1920)
  assert.equal(result.qualitySource, 'media')
  assert.equal(result.duration, 6)
  assert.deepEqual(Buffer.from(result.firstBytes), media)
  assert.equal(requests.length, 3)
  assert.equal(requests[0].options.headers.origin, 'https://zhuiju.dpdns.org')
})

for (const [name, expected] of [
  ['avc-720.ts', [1280, 720, 'media']],
  ['mpeg2-180.ts', [0, 0, 'unknown']],
]) {
  test(`a single 1080p declaration cannot override measurement of ${name}`, async () => {
    const media = await fixture(name)
    const result = await inspectHlsResource('https://media.example/master.m3u8', {
      fetchImpl: async (url) => url.endsWith('/master.m3u8')
        ? playlist(url, '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080\nvariant.m3u8')
        : url.endsWith('/variant.m3u8') ? playlist(url, '#EXTM3U\n#EXTINF:4,\nseg.ts') : segment(media, {}, url),
    })
    assert.deepEqual([result.ok, result.width, result.variantHeight, result.qualitySource], [true, ...expected])
  })
}

test('a measured 1080p variant wins even if its declaration is wrong', async () => {
  const first = await fixture('avc-720.ts')
  const second = await fixture('avc-1080.ts')
  const result = await inspectHlsResource('https://media.example/master.m3u8', {
    fetchImpl: async (url) => url.endsWith('/master.m3u8')
      ? playlist(url, '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080\na/index.m3u8\n#EXT-X-STREAM-INF:RESOLUTION=1280x720\nb/index.m3u8')
      : url.endsWith('/index.m3u8') ? playlist(url, '#EXTM3U\n#EXTINF:4,\nseg.ts') : segment(url.includes('/a/') ? first : second, {}, url),
  })
  assert.deepEqual([result.ok, result.width, result.variantHeight, result.mediaUrl], [true, 1920, 1080, 'https://media.example/b/index.m3u8'])
})

test('unrecognized bytes are not a playable HLS segment', async () => {
  const result = await inspectHlsResource('https://media.example/list.m3u8', {
    fetchImpl: async (url) => url.endsWith('.m3u8')
      ? playlist(url, '#EXTM3U\n#EXTINF:4,\nseg.ts')
      : segment(new Uint8Array(188 * 2).fill(0x7f), {}, url),
  })
  assert.deepEqual([result.ok, result.error], [false, 'first_segment_not_media'])
})

test('missing segment and HTTP errors fail closed', async () => {
  const fetchImpl = async (url) => url.endsWith('.m3u8')
    ? playlist(url, '#EXTM3U\n#EXTINF:4,\nseg.ts')
    : response('', { ok: false, status: 404 })
  const result = await inspectHlsResource('https://media.example/list.m3u8', { fetchImpl })
  assert.deepEqual({ ok: result.ok, error: result.error }, { ok: false, error: 'first_segment_http_404' })
})

test('master fails closed when every variant is broken', async () => {
  const fetchImpl = async (url) => url.endsWith('/master.m3u8')
    ? playlist(url, '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080\n1080.m3u8')
    : response('', { ok: false, status: 403 })
  const result = await inspectHlsResource('https://media.example/master.m3u8', { fetchImpl })
  assert.deepEqual({ ok: result.ok, error: result.error }, { ok: false, error: 'no_playable_variant' })
})

test('playlist request failure is bounded and reported unavailable', async () => {
  const result = await inspectHlsResource('https://media.example/timeout.m3u8', { fetchImpl: async () => { throw new Error('timeout') } })
  assert.deepEqual({ ok: result.ok, error: result.error }, { ok: false, error: 'fetch_failed' })
})

test('a foreign playlist without browser CORS permission is not playable', async () => {
  const result = await inspectHlsResource('https://media.example/list.m3u8', { fetchImpl: async (url) => ({ ...playlist(url, '#EXTM3U\n#EXTINF:4,\nseg.ts'), headers: new Headers() }) })
  assert.deepEqual({ ok: result.ok, error: result.error }, { ok: false, error: 'playlist_cors_blocked' })
})

test('a real transport stream with a recognized video codec is playable', async () => {
  const media = await fixture('avc-1080.ts')
  const result = await inspectHlsResource('https://media.example/list.m3u8', {
    fetchImpl: async (url) => url.endsWith('.m3u8')
      ? playlist(url, '#EXTM3U\n#EXTINF:4,\nseg.ts')
      : segment(media, {}, url),
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual([result.width, result.height, result.qualitySource], [1920, 1080, 'media'])
})

test('an exact cap on a partial segment body is not complete', async () => {
  const result = await inspectHlsResource('https://media.example/list.m3u8', {
    fetchImpl: async (url) => url.endsWith('.m3u8')
      ? playlist(url, '#EXTM3U\n#EXTINF:4,\nseg.ts')
      : response('', { url, headers: { 'content-range': 'bytes 0-8388608/8388609' }, arrayBuffer: async () => new Uint8Array(8 * 1024 * 1024 + 1).buffer }),
  })
  assert.equal(result.ok, false)
})

test('a playlist init segment must be accessible before selecting its media', async () => {
  const result = await inspectHlsResource('https://media.example/list.m3u8', {
    fetchImpl: async (url) => url.endsWith('.m3u8')
      ? playlist(url, '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg.m4s')
      : url.endsWith('/init.mp4') ? response('', { ok: false, status: 404 }) : segment(undefined, {}, url),
  })
  assert.equal(result.ok, false)
})

test('encrypted identity-key playlists verify the key and reject unavailable dependencies', async () => {
  const result = await inspectHlsResource('https://media.example/list.m3u8', {
    fetchImpl: async (url) => url.endsWith('.m3u8')
      ? playlist(url, '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4,\nseg.ts')
      : url.endsWith('/key.bin') ? response('', { ok: false, status: 403 }) : segment(undefined, {}, url),
  })
  assert.equal(result.ok, false)
})

test('non-HTTPS playlist dependencies fail closed', async () => {
  const result = await inspectHlsResource('http://media.example/list.m3u8', { fetchImpl: async () => { throw new Error('unexpected') } })
  assert.equal(result.ok, false)
})
