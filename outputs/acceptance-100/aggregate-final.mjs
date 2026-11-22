// 汇总 100 部：原站默认、本站默认（D1 写入后）、静音实播三项逐条证据。
import { readFileSync, writeFileSync } from 'node:fs'
const list = JSON.parse(readFileSync('hot-100-fixed-20261122.json', 'utf8')).items
const origin = new Map(JSON.parse(readFileSync('origin-best-20261122.json', 'utf8')).map((r) => [r.no, r]))
const plan = new Map(JSON.parse(readFileSync('plan-defaults-20261122.json', 'utf8')).map((r) => [r.no, r]))
const after = new Map(JSON.parse(readFileSync('our-probe-after-20261122.json', 'utf8')).map((r) => [r.no, r]))
const playFiles = ['play-our-1.jsonl', 'play-our-2.jsonl', 'play-our-3.jsonl', 'retry-1.jsonl', 'retry-2.jsonl', 'retry-check.jsonl', 'diag-slice.jsonl', 'final-slice.jsonl', 'final-slice-2.jsonl']
const plays = new Map()
const attempts = new Map()
for (const f of playFiles) {
  for (const line of readFileSync(f, 'utf8').trim().split('\n')) {
    if (!line) continue
    const r = JSON.parse(line)
    attempts.set(r.no, (attempts.get(r.no) || 0) + 1)
    if (r.ok && !plays.has(r.no)) plays.set(r.no, r)
  }
}
const rows = []
for (const item of list) {
  const o = origin.get(item.no)
  const p = plan.get(item.no)
  const a = after.get(item.no)
  const pl = plays.get(item.no)
  const r = {
    no: item.no, cat: item.cat, title: item.title, id: item.id,
    originOk: o?.ok ? 'yes' : 'no',
    originLine: o?.originLine || '',
    originEpisode: o?.originEpisode || '',
    originFail: o && !o.ok ? String(o.reason || o.error || '').replace(/\s+/g, ' ').slice(0, 100) : '',
    planStatus: p?.status || '',
    targetLabel: p?.label || '',
    targetProvider: p?.provider || '',
    ourFirstAfter: a?.ourFirst?.label || '',
    oursHasEpisode: o?.originEpisode ? (a?.episodes || []).includes(o.originEpisode) ? 'yes' : 'no' : 'n/a',
    playback: pl ? 'yes' : 'no',
    playLine: pl?.lineOn || '',
    playEpisode: pl?.episode || '',
    playTime: pl?.video?.t ?? '',
    playSize: pl?.video ? `${pl.video.w}x${pl.video.h}` : '',
    attempts: attempts.get(item.no) || 0,
    status: '', reason: '',
  }
  const lineAligned = Boolean(r.targetLabel) && r.ourFirstAfter === r.targetLabel
  const episodeAligned = r.oursHasEpisode === 'yes' || (r.oursHasEpisode === 'n/a' && Boolean(pl))
  const playAligned = Boolean(pl) && r.playLine === r.targetLabel
  if (r.originOk === 'no') { r.status = '原站不可观察'; r.reason = r.originFail || '原站正常页面未给出默认播放' }
  else if (r.planStatus === 'episode_missing') { r.status = '未对齐-库缺集'; r.reason = p.reason }
  else if (r.planStatus === 'line_missing') { r.status = '未对齐-本站无该线路'; r.reason = p.reason }
  else if (lineAligned && episodeAligned && playAligned) { r.status = '完整通过'; r.reason = '原站默认=本站默认，静音实播解码并推进' }
  else if (!lineAligned) { r.status = '未对齐-默认线路未生效'; r.reason = `本站首选 ${r.ourFirstAfter || '无'} ≠ 原站默认 ${r.targetLabel}` }
  else if (!pl) { r.status = '未实播-无可用线路'; r.reason = '多次静音实播未取得解码与进度推进' }
  else { r.status = '未对齐-实播线路不同'; r.reason = `实播 ${r.playLine} ≠ 默认 ${r.targetLabel}` }
  rows.push(r)
}
const head = ['no', 'cat', 'title', 'originOk', 'originLine', 'originEpisode', 'targetLabel', 'ourFirstAfter', 'oursHasEpisode', 'planStatus', 'playback', 'playLine', 'playEpisode', 'playTime', 'playSize', 'attempts', 'status', 'reason']
const esc = (v) => `"${String(v).replace(/"/g, '""')}"`
writeFileSync('acceptance-100-final-20261122.csv', [head.join(','), ...rows.map((r) => head.map((h) => esc(r[h])).join(','))].join('\n') + '\n')
writeFileSync('acceptance-100-final-20261122.json', JSON.stringify(rows, null, 1))
const byStatus = {}
for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1
const byCat = {}
for (const r of rows) { byCat[r.cat] = byCat[r.cat] || {}; byCat[r.cat][r.status] = (byCat[r.cat][r.status] || 0) + 1 }
console.log(JSON.stringify({ total: rows.length, byStatus, byCat, played: rows.filter((r) => r.playback === 'yes').length }, null, 1))
