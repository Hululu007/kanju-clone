import test from 'node:test'
import assert from 'node:assert/strict'
import { orderLines } from '../worker/api/src/line-order.js'

test('1080p comes first, then trusted playback history before origin preference', () => {
  const lines = [
    { provider: 'official', label: '1080P', quality: 1080, selected: true, group: 'official', index: 0 },
    { provider: 'source-a', label: '1080P', quality: 1080, selected: false, group: 'normal', priority: 1 },
    { provider: 'source-b', label: '1080P', quality: 1080, selected: false, group: 'normal', priority: 2 },
    { provider: 'uhd', label: '4K', quality: 2160, selected: true, group: 'official', index: 1 },
    { provider: 'low', label: '720P', quality: 720, group: 'normal', priority: 0 },
  ]
  const history = new Map([
    ['source-a', { successes: 7, total: 8 }],
    ['source-b', { successes: 2, total: 8 }],
  ])
  assert.deepEqual(orderLines(lines, history).map((line) => line.provider), ['source-a', 'source-b', 'official', 'uhd', 'low'])
})

test('a single observation cannot override the default source preference', () => {
  const lines = [
    { provider: 'official', label: '1080P', quality: 1080, selected: true, group: 'official', index: 0 },
    { provider: 'source', label: '1080P', quality: 1080, selected: false, group: 'normal', priority: 0 },
  ]
  const history = new Map([['source', { successes: 1, total: 1 }]])
  assert.equal(orderLines(lines, history)[0].provider, 'official')
})
