// 原站默认线路对照表。
//
// 上游 line_options 里的 selected 只表示「原站线路列表第一条」，不是原站播放页
// 真正播出的那条（例如《折月亮》原站实际播 高清-官方B，列表第一条却是 1080P-官方Z）。
// 所以逐部实看原站后，把观察到的默认线路记在 origin_defaults 表里，默认播放跟随它：
// 命中该线路时把 selected 标给它，其余线路取消，排序与选线沿用既有规则。
export async function loadOriginDefault(env, showId) {
  if (!showId) return { provider: '', label: '' }
  const row = await env.DB.prepare('SELECT provider,label FROM origin_defaults WHERE show_id=?')
    .bind(showId)
    .first()
    .catch(() => null)
  return { provider: String(row?.provider || ''), label: String(row?.label || '') }
}

// 纯函数，便于单测：只保留命中线路的 selected 标记，未命中则原样返回。
// 同一 provider 有多语言变体时（如 1080P-官方Z 与 1080P-官方Z · 粤语），先按标签精确匹配。
export function markOriginDefault(lines, provider, label = '') {
  if (!provider) return lines
  let at = label ? lines.findIndex((line) => line.provider === provider && line.label === label) : -1
  if (at < 0) at = lines.findIndex((line) => line.provider === provider)
  if (at < 0) return lines
  return lines.map((line, index) => (line.selected === (index === at) ? line : { ...line, selected: index === at }))
}

export async function applyOriginDefault(env, showId, lines) {
  const { provider, label } = await loadOriginDefault(env, showId)
  return markOriginDefault(lines, provider, label)
}
