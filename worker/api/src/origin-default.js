import { RETRYABLE_PROBE_FAILURES } from './source-selection.js'

// 原站默认线路与默认集对照表。
//
// 上游 line_options 里的 selected 只表示「原站线路列表第一条」，不是原站播放页
// 真正播出的那条（例如《折月亮》原站实际播 高清-官方B，列表第一条却是 1080P-官方Z）。
// 所以逐部实看原站后，把观察到的默认线路记在 origin_defaults 表里，默认播放跟随它：
// 命中该线路时把 selected 标给它，其余线路取消，排序与选线沿用既有规则。
//
// 对照表没有命中时（没有记录、或这一集没有那条线路），上游 selected 也不可信，
// 一律清掉，交回原有的清晰度/可信历史排序，避免把「列表第一条 720P」当成默认。
export async function loadOriginDefault(env, showId) {
  const empty = { provider: '', label: '', epIdx: null, epLabel: '' }
  if (!showId) return empty
  const row = await env.DB.prepare('SELECT provider,label,ep_idx,ep_label FROM origin_defaults WHERE show_id=?')
    .bind(showId)
    .first()
    .catch(() => null)
  return {
    provider: String(row?.provider || ''),
    label: String(row?.label || ''),
    epIdx: row?.ep_idx == null || row.ep_idx === '' ? null : Number(row.ep_idx),
    epLabel: String(row?.ep_label || ''),
  }
}

// 纯函数，便于单测。排序与选线只认 originDefault 这个对照表信号，
// 上游 selected（列表第一条）一律不参与，避免把 720P 的列表第一条当成默认项。
// 同一 provider 有多语言变体时（如 1080P-官方Z 与 1080P-官方Z · 粤语），先按标签精确匹配。
// 指定了标签（语言版本）却找不到时就是没匹配上：不能退到同 provider 的第一条，
// 否则粤语默认会被当成普通话，选线把它当默认、重试却判定未命中。
// 没给标签时，只有该 provider 在本集恰好只有一条线路才算命中，多条无从判断。
// 默认标记和单独重试必须用同一套判定，否则会出现「标记不认、重试却认」的分歧。
function findOriginDefaultIndex(lines, provider, label = '') {
  const wanted = String(provider || '')
  if (!wanted) return -1
  const wantedLabel = String(label || '')
  if (wantedLabel) {
    return lines.findIndex((line) => line?.provider === wanted && String(line?.label) === wantedLabel)
  }
  const hits = lines.reduce((list, line, index) => (line?.provider === wanted ? [...list, index] : list), [])
  // 多条同 provider 时，若它们标签全同（重复行）可认定是同一条；标签不同（多语言版本）则无从判断，不猜。
  const sameLabel = hits.length > 1 && hits.every((index) => String(lines[index]?.label) === String(lines[hits[0]]?.label))
  return hits.length === 1 || sameLabel ? hits[0] : -1
}

export function markOriginDefault(lines, provider, label = '') {
  const at = findOriginDefaultIndex(lines, provider, label)
  return lines.map((line, index) => ({ ...line, originDefault: index === at }))
}

export async function applyOriginDefault(env, showId, lines) {
  const { provider, label } = await loadOriginDefault(env, showId)
  return markOriginDefault(lines, provider, label)
}

// 软失败（并发探测把默认线路挤到超时）才值得单独重试一次；会员、HTTP 硬失败不重试。
// 只对对照表命中的线路重试，上游 selected（列表第一条）不触发重试。
export function planOriginRetry(probed, originDefault = {}) {
  const provider = String(originDefault?.provider || '')
  const label = String(originDefault?.label || '')
  if (!provider) return { index: -1, retry: false }
  const index = findOriginDefaultIndex(probed.map((item) => item.line), provider, label)
  if (index < 0) return { index, retry: false }
  const item = probed[index]
  return { index, retry: !item.ok && RETRYABLE_PROBE_FAILURES.has(item.error) }
}

// 重试结果不论成功还是明确失败（会员/403 等）都替换原结果，
// 否则响应会把已是会员限制的线路报成「超时、状态未知」。
export function mergeOriginRetry(probed, index, attempt) {
  if (index < 0 || !attempt) return probed
  const original = probed[index]
  const hasAddress = (item) => !!(item?.url || item?.mediaUrl)
  const code = String(attempt.error || '')
  // 重试连地址都没拿到时，只有「线路本身明确不能用」才覆盖首次结果：
  // 会员/登录限制、解析接口明确返回 HTTP 4xx（429 限流除外）。
  // 超时、断网、连接重置、被中止、限流、预算耗尽都只是 Worker 出口没查成，
  // 必须保留首次已经解析出的地址，不能把默认线路判成没地址后换成别家。
  // 这里用「明确失败」黑名单而不是「已知软失败」白名单，避免每出现一种新的
  // 传输异常就再漏一次（resolve_fetch failed、resolve_connect timeout 等）。
  const definiteFailure = attempt.error === 'member'
    || (/^resolve_http_4\d\d/.test(code) && !/^resolve_http_429/.test(code))
  const retryOnlySaysUnknown = !hasAddress(attempt) && !definiteFailure
  if (retryOnlySaysUnknown && hasAddress(original)) return probed
  return probed.map((item, at) => (at === index ? attempt : item))
}

// 原站默认集：优先按标签匹配（综艺的「2026-11-21 第7期 上」这类），再退回序号。
// 库里还没有那一集时诚实返回 matched:false 与原因，不拿别的集冒充。
// 对照表记了集名时只认集名：库里没有这一集就诚实报未匹配。
// 按序号退回会把「预告片」顶替成「正片」，等于把别的集冒充原站默认集。
export function pickOriginDefaultEpisode(episodes, { epIdx = null, epLabel = '' } = {}) {
  const list = Array.isArray(episodes) ? episodes : []
  if (epLabel) {
    const hit = list.find((ep) => String(ep.label) === String(epLabel))
    if (hit) return { idx: hit.idx, label: hit.label, matched: true, reason: '' }
    return {
      idx: null,
      label: String(epLabel),
      matched: false,
      reason: list.length ? 'episode_not_in_library' : 'no_episodes',
    }
  }
  if (epIdx != null && Number.isFinite(Number(epIdx))) {
    const hit = list.find((ep) => Number(ep.idx) === Number(epIdx))
    if (hit) return { idx: hit.idx, label: hit.label, matched: true, reason: '' }
  }
  return {
    idx: null,
    label: '',
    matched: false,
    reason: list.length ? 'episode_not_in_library' : 'no_episodes',
  }
}
