import test from 'node:test'
import assert from 'node:assert/strict'

test('next episode follows actual episode number rather than API row index or order', () => {
  const episodes = [{ idx: 2, number: 5 }, { idx: 8, number: 1 }, { idx: 6, number: 3 }, { idx: 1, number: 2 }]
  assert.equal(nextEpisodeAfter(episodes, 8)?.idx, 1)
  assert.equal(nextEpisodeAfter(episodes, 2), null)
})
import { allowsAutoSwitchTo, autoSwitchCandidates, autoSwitchPlan, lineLabelOfKey, lineRequestOptions, needsFullLineList, nextEpisodeAfter, qualityRank, rankPlayableLines, shouldRetrySwitchAfterRefresh, shouldShowNextCue } from '../src/player-policy.js'

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

test('手选线路必须严格解析，不能回退到同 provider 的另一语言版本', () => {
  assert.deepEqual(lineRequestOptions('official-z|1080P-官方Z · 粤语'), { strict: true })
  assert.deepEqual(lineRequestOptions(''), { strict: false })
})

test('手选粤语后起播失败，自动换线不能换成同源的普通话', () => {
  // 粤语线路拿到地址后起播超时/致命错误会调用自动换线；这里检查真实候选函数。
  const manualKey = 'zdfy|1080P-官方Z · 粤语'
  const options = [
    { provider: 'zdfy', label: '1080P-官方Z · 粤语', quality: 1080 },
    { provider: 'zdfy', label: '1080P-官方Z', quality: 1080 },
    { provider: 'other', label: '1080P-其他', quality: 1080 },
    { provider: 'other2', label: '1080P-官方Z · 粤语', quality: 1080 },
  ]
  const candidates = autoSwitchCandidates(options, { currentKey: manualKey, currentProvider: 'zdfy', manualKey })
  // 只允许换到标签完全相同的另一条线（同语言同清晰度）；不同标签一律不自动换。
  assert.deepEqual(candidates.map(lineKeyOfOption), ['other2|1080P-官方Z · 粤语'])
  assert.equal(allowsAutoSwitchTo(manualKey, options[1]), false)
  assert.equal(lineLabelOfKey(manualKey), '1080P-官方Z · 粤语')
})

test('手选粤语且没有别的粤语版本时，自动换线候选为空，由页面提示用户重选', () => {
  const manualKey = 'zdfy|1080P-官方Z · 粤语'
  const options = [
    { provider: 'zdfy', label: '1080P-官方Z · 粤语', quality: 1080 },
    { provider: 'zdfy', label: '1080P-官方Z', quality: 1080 },
  ]
  const candidates = autoSwitchCandidates(options, { currentKey: manualKey, currentProvider: 'zdfy', manualKey })
  assert.equal(candidates.length, 0)
})

test('没手选线路时自动换线行为不变，仍可换到其他线路', () => {
  const options = [
    { provider: 'zdfy', label: '1080P-官方Z', quality: 1080 },
    { provider: 'zdfy', label: '1080P-官方Z · 粤语', quality: 1080 },
    { provider: 'other', label: '1080P-其他', quality: 1080, status: 'dead' },
  ]
  const candidates = autoSwitchCandidates(options, { currentKey: 'zdfy|1080P-官方Z', currentProvider: 'zdfy', manualKey: '' })
  assert.deepEqual(candidates.map(lineKeyOfOption), ['zdfy|1080P-官方Z · 粤语'])
})

test('已经有可用备用线时立刻换线，不为补拉完整列表等待（审核 P1-2）', () => {
  assert.equal(autoSwitchPlan({ candidateCount: 1, partial: true }), 'switch')
  assert.equal(autoSwitchPlan({ candidateCount: 2, partial: true }), 'switch')
})

test('一个候选都没有时才等补拉，且只等一次（审核 P1-2）', () => {
  assert.equal(autoSwitchPlan({ candidateCount: 0, partial: true }), 'await-refresh')
  // 补拉已经等过一轮还是没候选：不再重复等，避免反复卡 8 秒。
  assert.equal(autoSwitchPlan({ candidateCount: 0, partial: true, afterRefresh: true }), 'give-up')
  assert.equal(autoSwitchPlan({ candidateCount: 0, partial: false }), 'give-up')
})

test('补拉在等待窗口之后才回来时，没播起来就再试一次换线（审核 P1-2）', () => {
  assert.equal(shouldRetrySwitchAfterRefresh({ wanted: true, switching: false, playing: false }), true)
  // 已经在播、或另一次换线正在跑，都不该重入。
  assert.equal(shouldRetrySwitchAfterRefresh({ wanted: true, switching: true, playing: false }), false)
  assert.equal(shouldRetrySwitchAfterRefresh({ wanted: true, switching: false, playing: true }), false)
  assert.equal(shouldRetrySwitchAfterRefresh({ wanted: false, switching: false, playing: false }), false)
})

test('快取起播的部分线路列表必须补拉完整清单，完整列表不用重复拉', () => {
  assert.equal(needsFullLineList({ options: [{ provider: 'good' }], optionsPartial: true }), true)
  assert.equal(needsFullLineList({ options: [] }), true)
  assert.equal(needsFullLineList(null), true)
  assert.equal(needsFullLineList({ options: [{ provider: 'good' }, { provider: 'spare' }] }), false)
})
