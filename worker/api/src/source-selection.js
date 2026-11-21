// Keep the network work bounded; an untested line is never advertised as playable.
export async function probeCandidates(lines, probe, { concurrency = 4, timeoutMs = 7000, budgetMs = 20000 } = {}) {
  const results = new Array(lines.length)
  const deadline = Date.now() + budgetMs
  let cursor = 0
  async function worker() {
    while (cursor < lines.length) {
      const index = cursor++
      const line = lines[index]
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        results[index] = { line, ok: false, deferred: true, error: 'probe_budget_exceeded' }
        continue
      }
      const controller = new AbortController()
      let timer
      try {
        results[index] = await Promise.race([
          Promise.resolve().then(() => probe(line, controller.signal)),
          new Promise((resolve) => {
            timer = setTimeout(() => {
              controller.abort()
              resolve({ line, ok: false, error: 'probe_timeout' })
            }, Math.min(timeoutMs, remaining))
          }),
        ])
      } catch {
        results[index] = { line, ok: false, error: 'probe_failed' }
      } finally {
        clearTimeout(timer)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(lines.length, Math.max(1, Math.min(4, concurrency))) }, worker))
  return results
}

export function selectPlayable(results, { preferred = '', targetQuality = 0 } = {}) {
  const candidates = results.filter((line) => line.ok)
  candidates.sort((a, b) => {
    const qa = Number(a.quality) || 0
    const qb = Number(b.quality) || 0
    const target = Number(targetQuality) || 1080
    const score = (line) => {
      const stats = line.stats
      if (!stats || Number(stats.total) < 2) return 0.5
      return Number(stats.successes || 0) / Number(stats.total)
    }
    if (qa > 0 && qb === 0) return -1
    if (qb > 0 && qa === 0) return 1
    if ((qa === target) !== (qb === target)) return qa === target ? -1 : 1
    if (qa !== qb) return qb - qa
    const scoreA = score(a)
    const scoreB = score(b)
    if (scoreA !== scoreB) return scoreB - scoreA
    if ((a.provider === preferred) !== (b.provider === preferred)) return a.provider === preferred ? -1 : 1
    return 0 // input order already includes persistent reliability
  })
  return candidates[0] || null
}
