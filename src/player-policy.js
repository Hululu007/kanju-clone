export function qualityRank(label = '') {
  const text = String(label)
  const match = text.match(/(\d{3,4})\s*[pP]?/)
  if (match) return Number(match[1])
  if (/4K|UHD/i.test(text)) return 2160
  if (/高清|HD/i.test(text)) return 720
  return 0
}

// 线路标识：provider|label。同一 provider 会有多个语言版本
// （如 1080P-官方Z 与 1080P-官方Z · 粤语），只看 provider 会把它们当成同一条线路。
export function lineKeyOfOption(option) {
  if (option?.key) return option.key
  return `${option?.provider || ''}|${option?.label ?? ''}`
}

// 合并两次线路探测结果：按 provider|label 区分，粤语版本不会被普通话覆盖。
// 新的「状态未知」不覆盖已有的明确状态（如已判定的 dup/dead）。
export function mergeLineOptionsList(existing, incoming) {
  const options = new Map((existing || []).map((option) => [lineKeyOfOption(option), option]))
  for (const option of incoming || []) {
    const key = lineKeyOfOption(option)
    const previous = options.get(key)
    if (previous && option.status === 'unknown' && previous.status !== 'unknown') continue
    options.set(key, { ...previous, ...option })
  }
  return [...options.values()]
}

// 手选线路后，自动换线不得换语言版本：用户点了粤语，粤语播不了就提示，
// 不能悄悄切成同源的普通话。没有手选时返回 true，按原有规则自动换线。
export function lineLabelOfKey(key = '') {
  const parts = String(key).split('|')
  return (parts.length > 1 ? parts.slice(1).join('|') : '').trim()
}

export function allowsAutoSwitchTo(manualKey, option) {
  if (!String(manualKey || '')) return true
  return lineLabelOfKey(lineKeyOfOption(option)) === lineLabelOfKey(manualKey)
}

// 自动换线候选：排除当前线路、已失败和不可用线路；手选过线路时只保留同一语言版本。
export function autoSwitchCandidates(options, { currentKey = '', currentProvider = '', failed = new Set(), manualKey = '' } = {}) {
  const isCurrent = (option) => (currentKey ? lineKeyOfOption(option) === currentKey : option.provider === currentProvider)
  return (options || []).filter((option) => option.provider &&
    !isCurrent(option) &&
    !failed.has(lineKeyOfOption(option)) &&
    !['dead', 'dup', 'member'].includes(option.status) &&
    allowsAutoSwitchTo(manualKey, option))
}

// 手选线路：用户点了哪一条就只认哪一条，包括语言版本。
// 粤语探测失败时应当提示「所选线路不可用」，不能回退到同 provider 的普通话。
export function lineRequestOptions(requestedLine = '') {
  return { strict: Boolean(String(requestedLine || '')) }
}

// 起播集：有续播用续播，否则用原站默认集，再否则用列表第一集。
// resumeIdx 为 null 表示没有续播记录——不能把它当成第 0 集。
export function pickStartEpisode(episodes, { resumeIdx = null, originDefaultIdx = null } = {}) {
  const list = Array.isArray(episodes) ? episodes : []
  const findIdx = (value) => {
    if (value == null || value === '') return undefined
    return list.find((episode) => Number(episode.idx) === Number(value))?.idx
  }
  const resumed = findIdx(resumeIdx)
  if (resumed != null) return resumed
  const origin = findIdx(originDefaultIdx)
  if (origin != null) return origin
  return list[0]?.idx ?? 0
}

export function rankPlayableLines(options, { preferred = '', failed = new Set(), targetQuality = 1080 } = {}) {
  return [...options]
    .filter((option) => option.provider && !failed.has(option.provider) && !failed.has(lineKeyOfOption(option)))
    .filter((option) => !['dead', 'dup', 'member'].includes(option.status))
    .sort((a, b) => {
      const aRank = Number(a.quality) || 0
      const bRank = Number(b.quality) || 0
      if ((aRank === targetQuality) !== (bRank === targetQuality)) return aRank === targetQuality ? -1 : 1
      if (aRank !== bRank) return bRank - aRank
      const aPreferred = a.provider === preferred
      const bPreferred = b.provider === preferred
      if (aPreferred !== bPreferred) return aPreferred ? -1 : 1
      const aSuccess = Number(a.successRate)
      const bSuccess = Number(b.successRate)
      if (Number.isFinite(aSuccess) && Number.isFinite(bSuccess) && aSuccess !== bSuccess) return bSuccess - aSuccess
      return 0
    })
}

export function shouldHandlePlaybackShortcut({ defaultPrevented, onControl }) {
  return !defaultPrevented && !onControl
}

export function nextEpisodeAfter(episodes, current) {
  const numberOf = (episode) => Number(episode.number || String(episode.label || '').match(/^第\s*(\d+)\s*[集期]/)?.[1] || Number(episode.idx) + 1)
  const active = episodes.find((episode) => Number(episode.idx) === Number(current))
  if (!active) return null
  const number = numberOf(active)
  return episodes.reduce((next, episode) => {
    const candidate = numberOf(episode)
    return candidate > number && (!next || candidate < numberOf(next)) ? episode : next
  }, null)
}

export function shouldShowNextCue({ duration, currentTime, current, cancelled }) {
  return Number.isFinite(duration) && duration > 0 && duration - currentTime <= 10 && current !== cancelled
}

// 快取起播只带「库里已验证过的线路」，不是这一集的完整线路清单：
// 播放器必须再补拉一次 /api/lines，否则自动换线会以为没有候选、线路菜单也会少项。
export function needsFullLineList(result) {
  if (result?.optionsPartial) return true
  return !result?.options?.length
}

// 自动换线的等待策略（2026-11-22 审核 P1-2）。
// 快取起播带回的线路列表只是库内已验证的那几条，不是整集清单。只有「手上一个可用
// 备用线都没有」时才值得有界等待补拉；已经有候选就立刻换线，不能被补拉拖慢。
export function autoSwitchPlan({ candidateCount = 0, partial = false, afterRefresh = false } = {}) {
  if (candidateCount > 0) return 'switch'
  if (!partial) return 'give-up'
  if (afterRefresh) return 'give-up'
  return 'await-refresh'
}

// 补拉在等待窗口（8 秒）之后才回来时，播放器可能已经提示过「没有可用线路」。
// 只要还没播起来、也没有另一次换线在跑，就要用补到的列表再试一次，不能提示完就放弃。
export function shouldRetrySwitchAfterRefresh({ wanted = true, switching = false, playing = false } = {}) {
  return Boolean(wanted && !switching && !playing)
}

// 换线时手上的清单如果只是「库里已验证的部分清单」，候选全失败后补拉可能带回
// 还没试过的新线路：只要补拉还在跑，就必须登记一次续接，不能因为起初有几条
// 候选就直接判定这一集没有可用线路（2026-11-22 审核 P1-1）。
// afterRefresh 表示这次本身就是续接后的重试，只允许再试一次，避免循环。
export function shouldScheduleRefreshRetry({ partial = false, afterRefresh = false } = {}) {
  return Boolean(partial && !afterRefresh)
}

// 「已恢复播放」不能只看 paused/ended：缓冲卡死时 paused=false、currentTime 不动，
// 补拉回来的可用线路会被误判成「已经在播」而错过立即换线（2026-11-22 审核 P1-2）。
// advancing 表示最近确实有进度推进，由播放器按时间窗计算后传入。
export function playbackResumed({ paused = true, ended = false, advancing = false } = {}) {
  return !paused && !ended && Boolean(advancing)
}

export function sampleStall(previous, { now, position, suspended }) {
  if (suspended) return null
  const since = !previous || Math.abs(position - previous.position) >= 0.05 ? now : previous.since
  return { since, position: since === now ? position : previous.position, expired: now - since >= 8000 }
}
