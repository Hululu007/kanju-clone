const qualityRankValue = (label = '') => {
  const text = String(label)
  if (/4K|UHD/i.test(text)) return 2160
  const match = text.match(/(\d{3,4})\s*[pP]?/)
  if (match) return Number(match[1])
  if (/高清|HD/i.test(text)) return 720
  return 0
}

export const qualityRank = qualityRankValue

export function orderLines(lines, successfulProviders = new Map()) {
  return [...lines].sort((a, b) => {
    // 原站播放页当前选中的线路就是这一轮要对齐的默认项，排在最前。
    if (a.selected !== b.selected) return a.selected ? -1 : 1

    const rankA = Number(a.quality) || 0
    const rankB = Number(b.quality) || 0
    if ((rankA === 1080) !== (rankB === 1080)) return rankA === 1080 ? -1 : 1
    if (rankA > 0 && rankB > 0 && rankA !== rankB) return rankB - rankA

    const scoreA = successfulProviders.get(a.provider)
    const scoreB = successfulProviders.get(b.provider)
    const totalA = Number(scoreA?.total) || 0
    const totalB = Number(scoreB?.total) || 0
    const measuredA = totalA >= 2
    const measuredB = totalB >= 2
    if (measuredA !== measuredB) return measuredA ? -1 : 1
    if (measuredA && measuredB) {
      const rateA = Number(scoreA.successes || 0) / totalA
      const rateB = Number(scoreB.successes || 0) / totalB
      if (rateA !== rateB) return rateB - rateA
    }
    if (a.group !== b.group) return a.group === 'official' ? -1 : 1
    if (a.group === 'official') return a.index - b.index
    return a.priority - b.priority
  })
}
