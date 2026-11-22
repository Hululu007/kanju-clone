// Cloudflare 免费版一次 Worker 调用最多 50 个子请求。留 6 个给入口处已有的
// 会话/目录请求，探测阶段最多用 44 个。计数用完之后的线路保持「未探测」，
// 不能标成死线，也不能继续发请求撞上限。
export function createProbeBudget(limit = 44) {
  let used = 0
  return {
    get used() { return used },
    get remaining() { return Math.max(0, limit - used) },
    canSpend(cost = 1) { return used + cost <= limit },
    spend(cost = 1) { used += cost; return used <= limit },
  }
}
