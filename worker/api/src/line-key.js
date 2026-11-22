// 线路标识：provider|label。
//
// 同一个 provider 会有多个语言版本（如 1080P-官方Z 与 1080P-官方Z · 粤语），
// 只按 provider 匹配/选线会落到排序后的第一条，用户点粤语也会播普通话。
// 前端把线路上传成 provider|label，后端按完整标识匹配；没有分隔符时仍按 provider 兼容旧值。
export function lineKey(provider = '', label = '') {
  return `${provider}|${label ?? ''}`
}

export function parseLineKey(value = '') {
  const text = String(value || '')
  const at = text.indexOf('|')
  if (at < 0) return { provider: text, label: '' }
  return { provider: text.slice(0, at), label: text.slice(at + 1) }
}

export function matchesLineKey(line, value = '') {
  const { provider, label } = parseLineKey(value)
  if (!provider || line.provider !== provider) return false
  return !label || String(line.label) === label
}
