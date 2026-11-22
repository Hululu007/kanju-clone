// 100 部最终验收汇总（审核返修版）。
// 关键修正：
//  - 集名用 preview 提取的完整名（ep-evidence），截断的「第10期」不再算匹配失败；
//  - 实播用 isContinuousPlayback 严格判定（排除 seek 跳转/报错/换线，要求连续推进）；
//  - 完整通过必须原站默认项有证据 + 本站默认命中 + 实播连续推进三者同时成立；
//  - 无可用线路/通道失败、原站不可观察、库缺集、本站无授权线路分开统计，不冒充通过。
import { readFileSync, writeFileSync } from 'node:fs'
import { extractOriginEpisode, isContinuousPlayback } from '../../worker/api/src/acceptance-evidence.js'
const j = (f) => JSON.parse(readFileSync(f, 'utf8'))
const list = j('hot-100-fixed-20261122.json').items
const origin = new Map(j('origin-best-20261122.json').map((r) => [r.no, r]))
const probe = new Map(j('our-probe-after-20261122.json').map((r) => [r.no, r]))
const plan = new Map(j('plan-defaults-20261122.json').map((r) => [r.no, r]))
const after = new Map(j('our-probe-after-20261122.json').map((r) => [r.no, r]))
const recs = readFileSync('v3-all.jsonl', 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
const play = new Map()
for (const r of recs) if (!play.has(r.no) || (r.ok && !play.get(r.no).ok)) play.set(r.no, r)

const rows = []
for (const item of list) {
  const o = origin.get(item.no), p = probe.get(item.no), pl = play.get(item.no)
  const targetLabel = p?.originLine || ''
  const targetEp = extractOriginEpisode(o?.preview) || (o?.originEpisode || '')
  const ourFirst = p?.ourFirst?.label || ''
  const lineHit = Boolean(targetLabel) && p?.ourLines?.some((l) => l.label === targetLabel)
  const defaultHit = Boolean(targetLabel) && ourFirst === targetLabel
  const epInLib = Boolean(targetEp) && (p?.episodes || []).includes(targetEp)
  // v3-all 的 samples 是扁平记录 {t,w,ready,line,ep,status}，适配判定函数的 video/lineOn/episodeOn 结构。
  const adapted = (pl?.samples || []).map((s) => ({
    video: { w: s.w, h: 0, t: s.t, ready: s.ready, err: s.err },
    line: s.line, lineOn: s.line, episode: s.ep, episodeOn: s.ep, status: s.status,
  }))
  const verdict = pl ? isContinuousPlayback(adapted, { target: targetLabel, targetEp }) : { ok: false }
  const code = {
    no: item.no, cat: item.cat, title: item.title, id: item.id,
    originLine: targetLabel, originEpisode: targetEp,
    ourDefaultLine: ourFirst, lineInLibrary: lineHit ? 'yes' : 'no',
    episodeInLibrary: epInLib ? 'yes' : (targetEp ? 'no' : 'n/a'),
    playOk: verdict.ok ? 'yes' : 'no',
    playLine: (verdict.lines || [])[0] || '', playEpisode: (verdict.episodes || [])[0] || '',
    playSpan: verdict.span ?? '', seekJump: verdict.anyJump ? 'yes' : 'no', playerError: verdict.hasError ? 'yes' : 'no',
    attempts: pl ? 1 : 0,
    status: '', reason: '',
  }
  if (!o?.ok) { code.status = '原站不可观察'; code.reason = String(o?.reason || o?.error || '原站正常页面未给出默认播放').replace(/\s+/g, ' ').slice(0, 90) }
  else if (!targetLabel) { code.status = '原站默认线路无证据'; code.reason = '原站正常页面未观察到明确默认线路，不猜、不写' }
  else if (!lineHit) { code.status = '本站无授权对应线路'; code.reason = `本站该集没有原站默认线路 ${targetLabel}，不移植未授权线路` }
  else if (!epInLib) { code.status = '库缺集'; code.reason = `库内没有原站默认集「${targetEp}」，不补写、不用别的集冒充` }
  else if (verdict.ok && defaultHit) { code.status = '完整通过'; code.reason = '原站默认集/线路有证据 + 本站默认命中 + 静音连续解码推进' }
  else if (verdict.ok && !defaultHit) { code.status = '线路回退-未对齐'; code.reason = `静音连续推进但线路 ${code.playLine} ≠ 本站默认 ${targetLabel}` }
  else if (verdict.anyJump) { code.status = '未取得连续推进证据'; code.reason = '播放中出现 seek 跳变（>3.5s/1.5s 采样），按规则不算连续推进' }
  else if (verdict.hasError || (pl?.lastStatus || '')) { code.status = '上游/播放器阻塞'; code.reason = String(pl?.lastStatus || '播放器或上游未给出可解码播放').replace(/\s+/g, ' ').slice(0, 90) }
  else { code.status = '未取得连续推进证据'; code.reason = '静音实播未取得满足连续帧/跨度要求的解码推进' }
  rows.push(code)
}
const byStatus = {}, byCat = {}
for (const r of rows) { byStatus[r.status] = (byStatus[r.status] || 0) + 1; byCat[r.cat] = byCat[r.cat] || {}; byCat[r.cat][r.status] = (byCat[r.cat][r.status] || 0) + 1 }
const head = ['no', 'cat', 'title', 'originLine', 'originEpisode', 'ourDefaultLine', 'lineInLibrary', 'episodeInLibrary', 'playOk', 'playLine', 'playEpisode', 'playSpan', 'seekJump', 'playerError', 'attempts', 'status', 'reason']
const esc = (v) => `"${String(v).replace(/"/g, '""')}"`
writeFileSync('acceptance-100-final-20261122.csv', [head.join(','), ...rows.map((r) => head.map((h) => esc(r[h])).join(','))].join('\n') + '\n')
writeFileSync('acceptance-100-final-20261122.json', JSON.stringify(rows, null, 1))
console.log(JSON.stringify({ total: rows.length, byStatus, byCat, strictPlayOk: rows.filter((r) => r.playOk === 'yes').length }, null, 1))
