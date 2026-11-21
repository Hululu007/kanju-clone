export async function resolveNextPlayableEpisode({ episodes, currentIdx, preferredProvider = '', targetQuality = 1080, loadOptions, resolveProvider }) {
  const next = [...episodes].filter((episode) => Number(episode.idx) > Number(currentIdx)).sort((a, b) => Number(a.idx) - Number(b.idx))
  for (const episode of next) {
    let options = []
    try { options = await loadOptions(episode.idx) || [] } catch { options = [] }
    const ordered = [...options].sort((a, b) => Number(b.quality || b.successRate && 1 || 0) - Number(a.quality || a.successRate && 1 || 0))
    const candidates = ordered.filter((option) => option.status !== 'dead' && option.status !== 'dup' && option.status !== 'member')
    const preferred = candidates.find((option) => option.provider === preferredProvider && Number(option.quality) === targetQuality)
    const picked = preferred || candidates.find((option) => Number(option.quality) === targetQuality) || candidates[0]
    if (!picked) continue
    const result = await resolveProvider(episode.idx, picked.provider).catch(() => null)
    if (result?.verified && result.url) return { episode, option: picked, result }
  }
  return null
}
