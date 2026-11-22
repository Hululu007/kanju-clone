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

export function sampleStall(previous, { now, position, suspended }) {
  if (suspended) return null
  const since = !previous || Math.abs(position - previous.position) >= 0.05 ? now : previous.since
  return { since, position: since === now ? position : previous.position, expired: now - since >= 8000 }
}
