import test from 'node:test'
import assert from 'node:assert/strict'

test('next episode follows actual episode number rather than API row index or order', () => {
  const episodes = [{ idx: 2, number: 5 }, { idx: 8, number: 1 }, { idx: 6, number: 3 }, { idx: 1, number: 2 }]
  assert.equal(nextEpisodeAfter(episodes, 8)?.idx, 1)
  assert.equal(nextEpisodeAfter(episodes, 2), null)
})
import { nextEpisodeAfter, qualityRank, rankPlayableLines, shouldShowNextCue } from '../src/player-policy.js'

test('quality labels rank 1080p above 720p and recognize UHD', () => {
  assert.equal(qualityRank('720P-普通'), 720)
  assert.equal(qualityRank('1080P-官方'), 1080)
  assert.equal(qualityRank('UHD'), 2160)
})

test('available 1080p is preferred over an unverified remembered 720p line', () => {
  const ranked = rankPlayableLines([
    { provider: 'remembered', label: '720P', quality: 720, status: 'ok' },
    { provider: 'uhd', label: '4K', quality: 2160, status: 'unknown' },
    { provider: 'fullhd', label: '1080P', quality: 1080, status: 'unknown' },
    { provider: 'broken', label: '1080P', quality: 1080, status: 'dead' },
  ], { preferred: 'remembered' })
  assert.deepEqual(ranked.map((line) => line.provider), ['fullhd', 'uhd', 'remembered'])
})

test('failed candidates are skipped without cycling back', () => {
  const ranked = rankPlayableLines([
    { provider: 'a', label: '1080P', quality: 1080 },
    { provider: 'b', label: '1080P', quality: 1080 },
    { provider: 'c', label: '720P', quality: 720 },
  ], { failed: new Set(['a', 'b']) })
  assert.deepEqual(ranked.map((line) => line.provider), ['c'])
})

test('next episode maps by greater episode index and handles movie/end-of-list', () => {
  const episodes = [{ idx: 0 }, { idx: 2 }, { idx: 7 }]
  assert.deepEqual(nextEpisodeAfter(episodes, 0), { idx: 2 })
  assert.equal(nextEpisodeAfter(episodes, 7), null)
  assert.equal(nextEpisodeAfter([{ idx: 0 }], 0), null)
})

test('next cue appears only in the last ten seconds and cancellation suppresses it', () => {
  assert.equal(shouldShowNextCue({ duration: 100, currentTime: 90, current: 2, cancelled: null }), true)
  assert.equal(shouldShowNextCue({ duration: 100, currentTime: 80, current: 2, cancelled: null }), false)
  assert.equal(shouldShowNextCue({ duration: 100, currentTime: 95, current: 2, cancelled: 2 }), false)
  assert.equal(shouldShowNextCue({ duration: 0, currentTime: 0, current: 2, cancelled: null }), false)
})

import { lineKeyOfOption, mergeLineOptionsList, pickStartEpisode } from '../src/player-policy.js'

test('同一 provider 的普通话与粤语线路合并后都保留', () => {
  const merged = mergeLineOptionsList(
    [{ provider: 'off-z', label: '1080P-官方Z', status: 'ok' }],
    [
      { provider: 'off-z', label: '1080P-官方Z', status: 'ok' },
      { provider: 'off-z', label: '1080P-官方Z · 粤语', status: 'ok' },
    ],
  )
  assert.deepEqual(merged.map(lineKeyOfOption), ['off-z|1080P-官方Z', 'off-z|1080P-官方Z · 粤语'])
})

test('合并时状态未知不覆盖已判定的不可用状态', () => {
  const merged = mergeLineOptionsList(
    [{ provider: 'off-z', label: '1080P-官方Z', status: 'dup' }],
    [{ provider: 'off-z', label: '1080P-官方Z', status: 'unknown' }],
  )
  assert.equal(merged.length, 1)
  assert.equal(merged[0].status, 'dup')
})

test('自动换线按 provider|label 排除，同源另一语言仍可尝试', () => {
  const ranked = rankPlayableLines([
    { provider: 'off-z', label: '1080P-官方Z', quality: 1080 },
    { provider: 'off-z', label: '1080P-官方Z · 粤语', quality: 1080 },
    { provider: 'other', label: '1080P', quality: 1080 },
  ], { failed: new Set(['off-z|1080P-官方Z']) })
  assert.deepEqual(ranked.map(lineKeyOfOption), ['off-z|1080P-官方Z · 粤语', 'other|1080P'])
})

test('没有续播记录时打开原站默认集，不会被第 0 集当成续播', () => {
  const episodes = [{ idx: 0 }, { idx: 1 }, { idx: 2 }]
  assert.equal(pickStartEpisode(episodes, { resumeIdx: null, originDefaultIdx: 1 }), 1)
  assert.equal(pickStartEpisode(episodes, { resumeIdx: null, originDefaultIdx: null }), 0)
})

test('有续播记录时优先续播集', () => {
  const episodes = [{ idx: 0 }, { idx: 1 }, { idx: 2 }]
  assert.equal(pickStartEpisode(episodes, { resumeIdx: 2, originDefaultIdx: 1 }), 2)
})
