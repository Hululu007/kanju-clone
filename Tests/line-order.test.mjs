import test from 'node:test'
import assert from 'node:assert/strict'
import { orderLines } from '../worker/api/src/line-order.js'

test('原站默认线路排在最高优先，其余按 1080P、可信历史、官方、优先级排序', () => {
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
  assert.deepEqual(orderLines(lines, history).map((line) => line.provider), ['official', 'uhd', 'source-a', 'source-b', 'low'])
})

test('原站默认线路比更高清晰度和更好历史都优先', () => {
  const lines = [
    { provider: 'hd-other', label: '4K', quality: 2160, selected: false, group: 'official', index: 0 },
    { provider: 'origin-default', label: '高清', quality: 720, selected: true, group: 'official', index: 3 },
  ]
  const history = new Map([['hd-other', { successes: 9, total: 10 }]])
  assert.equal(orderLines(lines, history)[0].provider, 'origin-default')
})

test('没有原站默认标记时保持原有清晰度与历史排序', () => {
  const lines = [
    { provider: 'low', label: '720P', quality: 720, group: 'normal', priority: 0 },
    { provider: 'best', label: '1080P', quality: 1080, group: 'normal', priority: 5 },
  ]
  assert.deepEqual(orderLines(lines).map((line) => line.provider), ['best', 'low'])
})

test('a single observation cannot override the default source preference', () => {
  const lines = [
    { provider: 'official', label: '1080P', quality: 1080, selected: true, group: 'official', index: 0 },
    { provider: 'source', label: '1080P', quality: 1080, selected: false, group: 'normal', priority: 0 },
  ]
  const history = new Map([['source', { successes: 1, total: 1 }]])
  assert.equal(orderLines(lines, history)[0].provider, 'official')
})
