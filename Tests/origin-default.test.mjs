import test from 'node:test'
import assert from 'node:assert/strict'
import {
  markOriginDefault,
  mergeOriginRetry,
  pickOriginDefaultEpisode,
  planOriginRetry,
} from '../worker/api/src/origin-default.js'
import { orderLines } from '../worker/api/src/line-order.js'

const lines = () => ([
  { provider: 'official-v', label: '1080P-官方V', selected: true, group: 'official', index: 0, priority: 0 },
  { provider: 'bytevod-lv2', label: '1080P-官方Z', selected: false, group: 'official', index: 1, priority: 0 },
])

test('原站实测默认线路接替上游第一条成为默认项', () => {
  const marked = markOriginDefault(lines(), 'bytevod-lv2')
  assert.equal(marked.find((l) => l.provider === 'bytevod-lv2').originDefault, true)
  assert.equal(marked.find((l) => l.provider === 'official-v').originDefault, false)
  assert.equal(orderLines(marked)[0].provider, 'bytevod-lv2')
})

test('本集没有对照线路时清掉上游标记，不把列表第一条当默认', () => {
  const marked = markOriginDefault(lines(), 'not-in-this-episode')
  assert.equal(marked.some((l) => l.originDefault), false)
})

test('同一线路有多语言变体时按原站标签精确匹配', () => {
  const variants = [
    { provider: 'bytevod-lv2', label: '1080P-官方Z · 粤语', selected: true, group: 'official', index: 0, priority: 0 },
    { provider: 'bytevod-lv2', label: '1080P-官方Z', selected: false, group: 'official', index: 1, priority: 0 },
  ]
  const marked = markOriginDefault(variants, 'bytevod-lv2', '1080P-官方Z')
  assert.equal(orderLines(marked)[0].label, '1080P-官方Z')
})

test('没有对照记录时清掉上游标记，交回原有清晰度排序', () => {
  const input = [
    { provider: 'low', label: '720P', quality: 720, selected: true, group: 'normal', priority: 0 },
    { provider: 'best', label: '1080P', quality: 1080, selected: false, group: 'normal', priority: 5 },
  ]
  const marked = markOriginDefault(input, '')
  assert.equal(marked.some((l) => l.originDefault), false)
  assert.equal(orderLines(marked)[0].provider, 'best')
})

test('只对对照表命中的软失败线路重试，上游 selected 不触发', () => {
  const probed = [
    { line: { provider: 'official-v', label: '1080P-官方V', selected: true }, ok: false, error: 'probe_timeout' },
    { line: { provider: 'bytevod-lv2', label: '1080P-官方Z' }, ok: true },
  ]
  assert.deepEqual(planOriginRetry(probed, { provider: '', label: '' }), { index: -1, retry: false })
  assert.deepEqual(planOriginRetry(probed, { provider: 'bytevod-lv2', label: '1080P-官方Z' }), { index: 1, retry: false })
  const withTimeout = probed.map((item, i) => (i === 1 ? { ...item, ok: false, error: 'probe_timeout' } : item))
  assert.deepEqual(planOriginRetry(withTimeout, { provider: 'bytevod-lv2', label: '1080P-官方Z' }), { index: 1, retry: true })
})

test('重试返回会员限制这类明确失败时替换原结果，不再报超时', () => {
  const probed = [{ line: { provider: 'origin' }, ok: false, error: 'probe_timeout' }]
  const merged = mergeOriginRetry(probed, 0, { line: { provider: 'origin' }, ok: false, error: 'member' })
  assert.equal(merged[0].error, 'member')
  assert.equal(mergeOriginRetry(probed, -1, { ok: true })[0].error, 'probe_timeout')
})

test('原站默认集按标签优先匹配，缺失时诚实报原因', () => {
  const episodes = [
    { idx: 0, label: '2026-11-13 第6期 上' },
    { idx: 1, label: '第1集' },
  ]
  assert.deepEqual(pickOriginDefaultEpisode(episodes, { epLabel: '第1集' }), { idx: 1, label: '第1集', matched: true, reason: '' })
  assert.equal(pickOriginDefaultEpisode(episodes, { epIdx: 0 }).matched, true)
  const missing = pickOriginDefaultEpisode(episodes, { epLabel: '2026-11-21 第7期 上' })
  assert.equal(missing.matched, false)
  assert.equal(missing.reason, 'episode_not_in_library')
})
