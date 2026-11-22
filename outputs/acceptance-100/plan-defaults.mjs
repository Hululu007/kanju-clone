// 把原站默认项映射成 origin_defaults 行（provider + 本站精确标签 + 集）。
import { readFileSync, writeFileSync } from 'node:fs'
const probe = JSON.parse(readFileSync('our-probe-20261122.json', 'utf8'))
const LANG = { 国语: '普通话', 普通话: '普通话', 英语: '英语', 粤语: '粤语', 韩语: '韩语', 日语: '日语', 泰语: '泰语' }
function pickLabel(ourLines, originLine, language) {
  const exact = ourLines.find((l) => l.label === originLine)
  if (exact) return exact
  const pref = ourLines.filter((l) => l.label.startsWith(originLine + ' · '))
  if (!pref.length) return null
  if (pref.length === 1) return pref[0]
  const want = LANG[language] || ''
  const byLang = pref.find((l) => l.label.endsWith(' · ' + want))
  return byLang || null
}
const plan = []
for (const r of probe) {
  const row = { no: r.no, cat: r.cat, title: r.title, id: r.id, originOk: r.originOk, originLine: r.originLine, originEpisode: r.originEpisode, status: '', provider: '', label: '', epIdx: null, epLabel: '', reason: '' }
  if (!r.originOk) { row.status = 'origin_unavailable'; row.reason = r.originReason || '原站正常页面未给出默认播放'; plan.push(row); continue }
  const hit = pickLabel(r.ourLines, r.originLine, r.language)
  if (!hit) { row.status = 'line_missing'; row.reason = `本站该集没有原站默认线路 ${r.originLine}（现有：${r.ourLines.map((l) => l.label).slice(0, 5).join(' / ') || '无'}）`; plan.push(row); continue }
  row.provider = hit.provider
  row.label = hit.label
  // 默认集：综艺/动漫/剧集用集名；电影无集名概念，取第 1 条（正片）
  if (r.originEpisode) {
    const at = r.episodes.indexOf(r.originEpisode)
    if (at >= 0) { row.epIdx = at; row.epLabel = r.originEpisode }
    else { row.status = 'episode_missing'; row.reason = `库内没有原站默认集「${r.originEpisode}」（本站最新：${r.episodes.slice(-2).join(' / ') || '无'}）`; plan.push(row); continue }
  } else {
    row.epIdx = 0
    row.epLabel = r.episodes[0] || ''
    if (r.cat === 'variety' && !r.episodes.length) { row.status = 'episode_missing'; row.reason = '库内没有分集'; plan.push(row); continue }
  }
  row.status = row.ourFirstLabel === row.label ? 'already' : 'to_apply'
  plan.push(row)
}
// already 判定：探测时本站首选就等于目标标签
for (const row of plan) {
  const r = probe.find((p) => p.no === row.no)
  if (row.status === 'to_apply' && r.ourFirst && r.ourFirst.label === row.label) row.status = 'already'
}
for (const row of plan) {
  const r = probe.find((p) => p.no === row.no)
  row.ourFirstBefore = r.ourFirst ? r.ourFirst.label : ''
}
writeFileSync('plan-defaults-20261122.json', JSON.stringify(plan, null, 1))
const by = (f) => plan.filter(f).length
console.log(JSON.stringify({
  total: plan.length,
  to_apply: by((r) => r.status === 'to_apply'),
  already: by((r) => r.status === 'already'),
  line_missing: by((r) => r.status === 'line_missing'),
  episode_missing: by((r) => r.status === 'episode_missing'),
  origin_unavailable: by((r) => r.status === 'origin_unavailable'),
}, null, 1))
for (const r of plan.filter((x) => ['line_missing', 'episode_missing', 'origin_unavailable'].includes(x.status))) console.log(' ', r.status, r.no, r.cat, r.title, '|', r.reason.slice(0, 90))
console.log('--- already ---')
console.log(plan.filter((r) => r.status === 'already').map((r) => r.no + ':' + r.title + '=' + r.label).join('\n'))
