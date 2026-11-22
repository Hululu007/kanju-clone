import test from 'node:test'
import assert from 'node:assert/strict'
import { lineKey, matchesLineKey, parseLineKey } from '../worker/api/src/line-key.js'

const variants = [
  { provider: 'bytevod-lv2', label: '1080P-官方Z · 粤语' },
  { provider: 'bytevod-lv2', label: '1080P-官方Z' },
]

test('线路标识带上标签，同一 provider 的多语言版本可以区分', () => {
  assert.equal(lineKey('bytevod-lv2', '1080P-官方Z · 粤语'), 'bytevod-lv2|1080P-官方Z · 粤语')
  assert.equal(matchesLineKey(variants[0], lineKey('bytevod-lv2', '1080P-官方Z')), false)
  assert.equal(matchesLineKey(variants[1], lineKey('bytevod-lv2', '1080P-官方Z')), true)
})

test('没有标签或旧格式的 provider 值仍然兼容', () => {
  assert.deepEqual(parseLineKey('bytevod-lv2'), { provider: 'bytevod-lv2', label: '' })
  assert.equal(matchesLineKey(variants[0], 'bytevod-lv2'), true)
  assert.equal(matchesLineKey(variants[1], 'bytevod-lv2'), true)
})
