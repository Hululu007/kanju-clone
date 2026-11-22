import test from 'node:test'
import assert from 'node:assert/strict'
import { markOriginDefault } from '../worker/api/src/origin-default.js'
import { orderLines } from '../worker/api/src/line-order.js'

const lines = () => ([
  { provider: 'official-v', label: '1080P-官方V', selected: true, group: 'official', index: 0, priority: 0 },
  { provider: 'bytevod-lv2', label: '1080P-官方Z', selected: false, group: 'official', index: 1, priority: 0 },
])

test('原站实测默认线路接替上游第一条成为默认项', () => {
  const marked = markOriginDefault(lines(), 'bytevod-lv2')
  assert.equal(marked.find((l) => l.provider === 'bytevod-lv2').selected, true)
  assert.equal(marked.find((l) => l.provider === 'official-v').selected, false)
  assert.equal(orderLines(marked)[0].provider, 'bytevod-lv2')
})

test('本集没有对照线路时保留上游标记', () => {
  const marked = markOriginDefault(lines(), 'not-in-this-episode')
  assert.equal(marked[0].selected, true)
  assert.equal(marked[1].selected, false)
})

test('同一线路有多语言变体时按原站标签精确匹配', () => {
  const variants = [
    { provider: 'bytevod-lv2', label: '1080P-官方Z · 粤语', selected: true, group: 'official', index: 0, priority: 0 },
    { provider: 'bytevod-lv2', label: '1080P-官方Z', selected: false, group: 'official', index: 1, priority: 0 },
  ]
  const marked = markOriginDefault(variants, 'bytevod-lv2', '1080P-官方Z')
  assert.equal(orderLines(marked)[0].label, '1080P-官方Z')
})

test('没有对照记录时原样返回', () => {
  const input = lines()
  assert.equal(markOriginDefault(input, ''), input)
})
