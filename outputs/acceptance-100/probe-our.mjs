// 逐部向本站正式 API 取分集与默认线路（本机 DNS 对 workers.dev 被污染，走 curl + 本机代理）。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const API = 'https://kanju-api.kenzhao123.workers.dev'
const PROXY = 'http://127.0.0.1:8202'
const list = JSON.parse(readFileSync('hot-100-fixed-20261122.json', 'utf8')).items
const best = JSON.parse(readFileSync('origin-best-20261122.json', 'utf8'))
const byNo = new Map(best.map((r) => [r.no, r]))
function get(path) {
  for (let i = 0; i < 6; i++) {
    try {
      const out = execFileSync('curl', ['-s', '--max-time', '70', '-x', PROXY, API + path], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
      if (out && out.trim()) return JSON.parse(out)
    } catch { /* retry */ }
  }
  return null
}
const out = []
const queue = [...list]
async function worker() {
  while (queue.length) {
    const item = queue.shift()
    const rec = { no: item.no, cat: item.cat, title: item.title, id: item.id, errs: [] }
    const show = get(`/api/show?id=${encodeURIComponent(item.id)}`)
    rec.episodes = (show?.episodes || []).map((e) => e.label)
    rec.language = show?.language || ''
    rec.kind = show?.kind || ''
    rec.defaultEpisode = show?.defaultEpisode ?? null
    const lines = get(`/api/lines?show=${encodeURIComponent(item.id)}&ep=0`)
    rec.ourLines = (lines?.options || []).map((o) => ({ provider: o.provider, label: o.label }))
    rec.ourFirst = rec.ourLines[0] || null
    rec.linesNote = lines?.note || ''
    if (!show) rec.errs.push('show failed')
    if (!lines) rec.errs.push('lines failed')
    const o = byNo.get(item.no)
    rec.originOk = Boolean(o?.ok)
    rec.originLine = o?.originLine || ''
    rec.originEpisode = o?.originEpisode || ''
    rec.originReason = o ? String(o.reason || o.error || '').slice(0, 120) : 'no record'
    const hit = rec.ourLines.find((l) => l.label === rec.originLine)
    rec.providerForOrigin = hit?.provider || ''
    rec.lineExists = Boolean(hit)
    out.push(rec)
    process.stderr.write(`${item.no} ${item.title} origin=${rec.originLine || '-'} ourFirst=${rec.ourFirst?.label || '-'} exists=${rec.lineExists}\n`)
  }
}
await Promise.all([worker(), worker()])
out.sort((a, b) => a.no - b.no)
writeFileSync('our-probe-20261122.json', JSON.stringify(out, null, 1))
console.log(JSON.stringify({ total: out.length, originOk: out.filter((r) => r.originOk).length, lineExists: out.filter((r) => r.lineExists).length, firstIsOrigin: out.filter((r) => r.ourFirst && r.ourFirst.label === r.originLine).length, failed: out.filter((r) => r.errs.length).length }))
