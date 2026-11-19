// 调用 kanju-probe 做可行性探测：从本地库取真实播放凭证，回显 Worker 的解析结果
// 用法： node cloud/probe-run.mjs [probeBase]
// 凭证只存在于进程内存，不打印、不落盘。
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const PROBE = (process.argv[2] || 'https://kanju-probe.kenzhao123.workers.dev').replace(/\/+$/, '')
const DB = fileURLToPath(new URL('../server/data/kanju.db', import.meta.url))
const db = new DatabaseSync(DB, { readOnly: true })

const targets = [
  { name: '谷雨 第19集', title: '谷雨', idx: 18 },
  { name: '名侦探柯南（国语） 第1集', title: '名侦探柯南（国语）', idx: 0 },
]

for (const t of targets) {
  const show = db.prepare('SELECT id,title FROM shows WHERE title=? ORDER BY heat_value DESC LIMIT 1').get(t.title)
  if (!show) {
    console.log(`\n### ${t.name}\n  ✗ 本地库没有这部剧`)
    continue
  }
  const ep = db.prepare('SELECT idx,number,token FROM episodes WHERE show_id=? AND idx=?').get(show.id, t.idx)
  if (!ep?.token) {
    console.log(`\n### ${t.name}\n  ✗ 本地库没有这一集或缺少凭证`)
    continue
  }
  const want = ep.number ?? t.idx + 1
  const url = `${PROBE}/?token=${encodeURIComponent(ep.token)}&want=${want}`
  const t0 = Date.now()
  let out
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(90000) })
    out = await r.json()
  } catch (e) {
    out = { error: String(e.message || e) }
  }
  console.log(`\n### ${t.name}  (idx=${ep.idx}, want=${want}, ${Date.now() - t0}ms)`)
  console.log(JSON.stringify(out, null, 1))
}
