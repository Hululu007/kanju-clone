import test from 'node:test'
import assert from 'node:assert/strict'
import { extractOriginEpisode, isContinuousPlayback } from '../worker/api/src/acceptance-evidence.js'

const sample = (t, extra = {}) => ({ video: { w: 1920, h: 1080, t, ready: 4 }, line: '1080P-官方V', lineOn: '1080P-官方V', episode: '第1集', episodeOn: '第1集', status: '', ...extra })

test('原站 preview 提取完整集名，不被地区/语言/UI 文案干扰', () => {
  assert.equal(extractOriginEpisode('现在就出发 第1季 2023-10-18 第10期 加更 2023 · 综艺 · 2023-10-18 第10期 加更 · 中国大陆 · 国语 关闭 播放详情'), '2023-10-18 第10期 加更')
  assert.equal(extractOriginEpisode('今天是太阳雨 第1集 2026 · 剧集 · 第1集 · 中国大陆 · 国语 关闭 播放详情'), '第1集')
  assert.equal(extractOriginEpisode('哪吒之魔童闹海 2025 · 电影 · 中国大陆 关闭 播放详情'), '')
  assert.equal(extractOriginEpisode(''), '')
})

test('自然连续推进判定通过', () => {
  const samples = [0, 1.5, 3.1, 4.6, 6.2, 7.7].map((t) => sample(t))
  const v = isContinuousPlayback(samples, { target: '1080P-官方V', targetEp: '第1集' })
  assert.equal(v.ok, true)
  assert.equal(v.anyJump, false)
  assert.ok(v.span >= 5)
})

test('seek 跳转不算连续推进（整段最长连续不足）', () => {
  const samples = [1.5, 106.2, 107.7, 109.2, 110.8, 112.3].map((t) => sample(t))
  const v = isContinuousPlayback(samples)
  assert.equal(v.ok, false)
  assert.equal(v.anyJump, true)
})

test('回退 seek 也算跳变，不算连续推进', () => {
  const samples = [1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9].map((t) => sample(t))
  const v = isContinuousPlayback(samples)
  assert.equal(v.anyJump, true)
  assert.equal(v.ok, false)
})

test('媒体错误码 video.err 不算通过', () => {
  const samples = [0, 1.5, 3.1, 4.6, 6.2, 7.7].map((t) => sample(t))
  samples[3].video.err = 4
  const v = isContinuousPlayback(samples)
  assert.equal(v.hasError, true)
  assert.equal(v.ok, false)
})

test('只有起播、时间不推进不算通过', () => {
  const samples = [1.5, 1.5, 1.6, 1.6, 1.7, 1.7].map((t) => sample(t))
  assert.equal(isContinuousPlayback(samples).ok, false)
})

test('播放器报错不算通过', () => {
  const samples = [0, 1.5, 3.1, 4.6, 6.2, 7.7].map((t) => sample(t))
  samples[5].status = '当前集所有可用线路均播放失败，请手动选择线路。'
  assert.equal(isContinuousPlayback(samples).ok, false)
})

test('线路或集不稳定（自动换线）不算通过', () => {
  const samples = [0, 1.5, 3.1, 4.6, 6.2, 7.7].map((t) => sample(t))
  samples[4].lineOn = '西瓜资源'
  assert.equal(isContinuousPlayback(samples).ok, false)
})

test('连续推进但线路不等于目标不算对齐通过', () => {
  const samples = [0, 1.5, 3.1, 4.6, 6.2, 7.7].map((t) => sample(t))
  assert.equal(isContinuousPlayback(samples, { target: '高清-官方B' }).ok, false)
})
