import test from 'node:test'
import assert from 'node:assert/strict'
import { probeCandidates, selectPlayable } from '../worker/api/src/source-selection.js'

test('probe candidates concurrently but never exceed the configured limit', async () => {
  let active = 0
  let peak = 0
  const results = await probeCandidates(Array.from({ length: 7 }, (_, i) => ({ provider: String(i) })), async (line) => {
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 3))
    active--
    return { ...line, ok: line.provider !== '0', quality: 720 }
  }, { concurrency: 3 })
  assert.equal(peak, 3)
  assert.equal(active, 0)
  assert.equal(results.length, 7)
  assert.equal(results[0].ok, false)
})

test('a rejected probe fails closed without discarding healthy results', async () => {
  const results = await probeCandidates([{ provider: 'bad' }, { provider: 'good' }], async (line) => {
    if (line.provider === 'bad') throw new Error('timeout')
    return { ...line, ok: true, quality: 1080 }
  })
  assert.equal(results[0].ok, false)
  assert.equal(results[1].ok, true)
})

test('measured quality wins over labels, and remembered source wins only equal quality', () => {
  const lines = [
    { provider: 'fake', label: '1080P', ok: true, quality: 360 },
    { provider: 'hd', label: 'source', ok: true, quality: 1080 },
    { provider: 'uhd', label: 'source', ok: true, quality: 2160 },
    { provider: 'bad', label: '1080P', ok: false, quality: 1080 },
  ]
  assert.equal(selectPlayable(lines, { preferred: 'fake' }).provider, 'hd')
  assert.equal(selectPlayable(lines, { targetQuality: 2160 }).provider, 'uhd')
  assert.equal(selectPlayable(lines.filter((line) => line.provider !== 'hd')).provider, 'uhd')
  assert.equal(selectPlayable(lines.map((line) => ({ ...line, ok: false }))), null)
})

test('successful preference applies inside the same measured quality tier', () => {
  const lines = [{ provider: 'a', ok: true, quality: 1080 }, { provider: 'b', ok: true, quality: 1080 }]
  assert.equal(selectPlayable(lines, { preferred: 'b' }).provider, 'b')
})
