// 连续采样判定：本地同源前端(dist, 与线上 f20a524 同一份代码) + 正式线上 API。
// 通过条件（全部满足）：
//  1) 视频真实解码 w>0 且 readyState>=2
//  2) 存在连续 >=5 帧，currentTime 单调递增、相邻增量 (0,3.5]（1.5s 间隔排除 seek 跳变），且该段跨度 >=5s
//  3) 全程 playStatus 无失败/错误文案
//  4) 采样期间线路、集保持稳定且命中目标（给出 target 时）
// 只关自己启动的 headless 浏览器；全程 --mute-audio。
import http from 'node:http'
import { appendFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { chromium } from 'file:///C:/Users/kenzh/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core/index.mjs'
const sliceFile = process.argv[2], outFile = process.argv[3], PORT = Number(process.argv[4] || 8391)
const items = JSON.parse(readFileSync(sliceFile, 'utf8'))
const DIST = 'C:/Users/kenzh/AppData/Local/Temp/kanju-web-playback/dist'
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  let f = join(DIST, decodeURIComponent(u.pathname))
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html')
  if (!existsSync(f)) f = join(DIST, 'index.html')
  res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' })
  res.end(readFileSync(f))
})
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${PORT}`
const args = ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--proxy-server=http://127.0.0.1:8202', '--proxy-bypass-list=127.0.0.1;localhost']
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args })
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
const page = await ctx.newPage()
const read = () => page.evaluate(() => {
  const vids = [...document.querySelectorAll('video')].map((v) => ({ w: v.videoWidth, h: v.videoHeight, t: +v.currentTime.toFixed(2), d: +(v.duration || 0).toFixed(1), ready: v.readyState, paused: v.paused, err: v.error ? v.error.code : null }))
  const best = vids.filter((v) => v.w > 0).sort((a, b) => b.t - a.t)[0] || vids[0] || null
  const q = document.querySelector('#qualityPill [data-quality-text]') || document.querySelector('.pl-quality [data-quality-text]')
  const ep = document.querySelector('#playerLabel')
  const st = document.querySelector('#playStatus')
  const on = document.querySelector('.pl-line.on')
  const epOn = document.querySelector('.pl-episodes .on, .pl-ep.on, [data-ep].on')
  return {
    video: best, line: (q?.textContent || '').trim(), lineOn: (on?.innerText || '').replace(/\s+/g, ' ').trim(),
    episode: (ep?.textContent || '').trim(), episodeOn: (epOn?.innerText || '').replace(/\s+/g, ' ').trim(),
    status: (st?.innerText || '').replace(/\s+/g, ' ').trim(), body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 200),
  }
})
const BAD = /失败|错误|没有.*可用线路|NotSupportedError|无法播放|请.*重试|请.*选择其他线路/
function judge(samples, target, targetEp) {
  const valid = samples.filter((s) => s.video && s.video.w > 0 && s.video.ready >= 2 && s.video.t != null)
  let best = [], cur = valid.length ? [valid[0]] : []
  for (let i = 1; i < valid.length; i++) {
    const d = valid[i].video.t - valid[i - 1].video.t
    if (d > 0 && d <= 3.5) cur.push(valid[i])
    else { if (cur.length > best.length) best = cur; cur = [valid[i]] }
  }
  if (cur.length > best.length) best = cur
  const span = best.length >= 2 ? +(best[best.length - 1].video.t - best[0].video.t).toFixed(2) : 0
  const anyJump = valid.length >= 2 && valid.slice(1).some((s, i) => { const d = s.video.t - valid[i].video.t; return d > 3.5 })
  const hasErr = samples.some((s) => BAD.test(s.status || ''))
  const lines = [...new Set(valid.map((s) => s.lineOn || s.line).filter(Boolean))]
  const eps = [...new Set(valid.map((s) => s.episodeOn || s.episode).filter(Boolean))]
  const lineStable = lines.length <= 1
  const epStable = eps.length <= 1
  const lineMatch = !target || lines.some((l) => l.includes(target)) || valid.some((s) => (s.line || '').includes(target))
  const epMatch = !targetEp || eps.some((e) => e.includes(targetEp)) || valid.some((s) => (s.episode || '').includes(targetEp))
  const maxJump = valid.length >= 2 ? Math.max(...valid.slice(1).map((s, i) => +(s.video.t - valid[i].video.t).toFixed(2))) : 0
  const ok = !anyJump && best.length >= 5 && span >= 5 && !hasErr && lineStable && epStable && lineMatch && epMatch
  return { ok, span, runLen: best.length, validFrames: valid.length, anyJump, hasErr, lineStable, epStable, lineMatch, epMatch, maxJump, lines, eps }
}
for (const item of items) {
  const started = Date.now()
  const rec = { no: item.no, cat: item.cat, title: item.title, id: item.id, target: item.target || '', targetEp: item.targetEp || '', at: new Date().toISOString() }
  const samples = []
  try {
    await page.goto(`${BASE}/player/?id=${encodeURIComponent(item.id)}&v=live`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    for (let t = 0; t < 14; t++) { await page.waitForTimeout(1500); samples.push(await read()) }
    rec.samples = samples.map((s) => ({ t: s.video?.t ?? null, w: s.video?.w ?? 0, ready: s.video?.ready ?? null, err: s.video?.err ?? null, paused: s.video?.paused ?? null, line: s.line || s.lineOn || '', ep: s.episode || s.episodeOn || '', status: s.status || '' }))
    Object.assign(rec, judge(samples, item.target, item.targetEp))
    rec.lastStatus = samples[samples.length - 1].status || ''
    rec.elapsedMs = Date.now() - started
  } catch (e) {
    rec.error = String(e.message || e).slice(0, 200); rec.ok = false; rec.elapsedMs = Date.now() - started
  }
  appendFileSync(outFile, JSON.stringify(rec) + '\n')
  console.log(`${rec.no} ${rec.title} ${rec.ok ? 'PASS' : 'FAIL'} span=${rec.span} run=${rec.runLen} jump=${rec.maxJump} err=${rec.hasErr} line=${(rec.lines || []).join('|')} ep=${(rec.eps || []).join('|')} ${rec.lastStatus || ''}`)
}
await b.close(); srv.close()
