// 这些失败只说明 Worker 自己的出口/预算不够，不代表线路不可播：
// 地址已经拿到，浏览器在用户网络里仍可能正常起播。按「未验证/状态未知」处理。
export const SOFT_PROBE_FAILURES = new Set([
  'probe_timeout',
  'probe_budget_exceeded',
  'probe_aborted',
  'fetch_failed',
  'rate_limited',
])

// 只有确实可能因并发挤压而变好的失败才值得再探一次；限流和出口网络失败重试只会浪费子请求。
export const RETRYABLE_PROBE_FAILURES = new Set(['probe_timeout', 'probe_budget_exceeded', 'probe_aborted'])

// 明确证明浏览器也拿不到媒体的失败，不能当成「Worker 出口问题」去抢可播备用线。
function isHardProbeFailure(code) {
  if (/(^|_)cors_blocked$/.test(code)) return true
  // 依赖资源明确返回 4xx（密钥 404、鉴权 403 等）是线路自己的问题，不是 Worker 出口问题。
  if (/^playlist_dependencies_http_4\d\d$/.test(code) && code !== 'playlist_dependencies_http_429') return true
  return /^first_segment_(not_media|empty|decryption_failed|invalid_byte_range|placeholder_image)$/.test(code)
    || code === 'no_playable_variant'
}

export function isSoftProbeFailure(error, item) {
  const code = String(error || '')
  if (item?.tentative) return true
  if (isHardProbeFailure(code)) return false
  return SOFT_PROBE_FAILURES.has(code)
    || /^http_(429|5\d\d)$/.test(code)
    || /^first_segment_(http_(429|5\d\d)|incomplete|unavailable|fetch_failed|timeout)$/.test(code)
    || /^playlist_dependencies_(unavailable|fetch_failed|timeout|http_(429|5\d\d))$/.test(code)
    || /^resolve_http_(429|5\d\d)/.test(code)
    || /^resolve_(too_many_subrequests|probe_budget_exceeded)/.test(code)
    // 解析请求自身的传输失败（超时、断网、连接重置、被中止）只是 Worker 出口没查成，
    // 不等于线路不可播；解析接口明确返回 HTTP 4xx（鉴权/会员等）仍按硬失败处理。
    || (/^resolve_/.test(code) && !/^resolve_http_4\d\d/.test(code))
}

export function probeStatus(item) {
  if (item.ok) return 'ok'
  if (item.error === 'member') return 'member'
  if (item.deferred || isSoftProbeFailure(item.error, item) || item.error === 'resolve_failed') return 'unknown'
  return 'dead'
}

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
  // 用户没手动选过线路时，默认用对照表记录的原站默认线路，与原站保持一致。
  // 只认 originDefault 标记（对照表命中），上游 selected 不参与。
  if (!preferred) {
    const originDefault = candidates.find((line) => line.originDefault)
    if (originDefault) return originDefault
  }
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
