import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectHlsResource } from '../worker/api/src/playback-probe.js'
import { sampleStall, shouldHandlePlaybackShortcut } from '../src/player-policy.js'

const player = readFileSync(new URL('../src/pages/player.js', import.meta.url), 'utf8')

test('the next preview does not jump using a wall clock while the video buffers', () => {
  const preview = player.split('function scheduleNextEpisode() {')[1].split("document.getElementById('nextPlayNow')")[0]
  assert.doesNotMatch(preview, /setTimeout|\bplay\(/)
})

test('player shortcuts leave focused controls and handled events alone', () => {
  const seek = player.split("seekBar.addEventListener('keydown',")[1].split('function togglePlay')[0]
  assert.match(seek, /event\.preventDefault\(\)/)
  assert.equal(shouldHandlePlaybackShortcut({ defaultPrevented: true, onControl: false }), false)
  assert.equal(shouldHandlePlaybackShortcut({ defaultPrevented: false, onControl: true }), false)
  assert.equal(shouldHandlePlaybackShortcut({ defaultPrevented: false, onControl: false }), true)
})

test('stall timing restarts after seeking or background playback and ignores progress', () => {
  let state = sampleStall(null, { now: 0, position: 10, suspended: false })
  assert.equal(state.expired, false)
  state = sampleStall(state, { now: 7999, position: 10, suspended: false })
  assert.equal(state.expired, false)
  assert.equal(sampleStall(state, { now: 8000, position: 10, suspended: false }).expired, true)
  assert.equal(sampleStall(state, { now: 8000, position: 10.2, suspended: false }).expired, false)
  const suspended = sampleStall(state, { now: 8000, position: 10, suspended: true })
  assert.equal(suspended, null)
  assert.equal(sampleStall(suspended, { now: 30000, position: 10, suspended: false }).expired, false)
})

test('an exact cap on a partial HLS body cannot be mistaken for a complete segment', async () => {
  const result = await inspectHlsResource('https://media.example/list.m3u8', {
    fetchImpl: async (url) => url.endsWith('.m3u8')
      ? new Response('#EXTM3U\n#EXTINF:4,\nseg.ts')
      : new Response(new Uint8Array(8 * 1024 * 1024 + 1).fill(0x47), { status: 200 }),
  })
  assert.equal(result.ok, false)
})

test('an HLS init segment must be accessible before selecting its media playlist', async () => {
  const result = await inspectHlsResource('https://media.example/list.m3u8', {
    fetchImpl: async (url) => url.endsWith('.m3u8')
      ? new Response('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg.m4s')
      : url.endsWith('/init.mp4') ? new Response(null, { status: 404 }) : new Response(new Uint8Array([0, 0, 0, 8, 109, 111, 111, 102])),
  })
  assert.equal(result.ok, false)
})

test('a remembered provider cannot make a known bad line win or abort automatic selection', () => {
  assert.doesNotMatch(readFileSync(new URL('../worker/api/src/index.js', import.meta.url), 'utf8'), /if \(preferred && health\.get\(preferred\)\?\.verdict === 'dup'\)/)
})
