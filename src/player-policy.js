export function qualityRank(label = '') {
  const text = String(label)
  const match = text.match(/(\d{3,4})\s*[pP]?/)
  if (match) return Number(match[1])
  if (/4K|UHD/i.test(text)) return 2160
  if (/高清|HD/i.test(text)) return 720
  return 0
}

export function rankPlayableLines(options, { preferred = '', failed = new Set(), targetQuality = 1080 } = {}) {
  return [...options]
    .filter((option) => option.provider && !failed.has(option.provider))
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

export function sampleStall(previous, { now, position, suspended }) {
  if (suspended) return null
  const since = !previous || Math.abs(position - previous.position) >= 0.05 ? now : previous.since
  return { since, position: since === now ? position : previous.position, expired: now - since >= 8000 }
}
