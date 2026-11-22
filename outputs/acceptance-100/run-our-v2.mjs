// 本站默认配置静音实播验证 v2：读默认集、默认线路、实际解码与进度推进。
import http from 'node:http'
import { readFileSync, existsSync, statSync, appendFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { chromium } from 'file:///C:/Users/kenzh/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core/index.mjs'
const sliceFile = process.argv[2]
const outFile = process.argv[3]
const PORT = Number(process.argv[4])
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
const args = ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--proxy-server=http://127.0.0.1:8202', '--proxy-bypass-list=127.0.0.1;localhost']
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args })
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
const page = await ctx.newPage()
const read = () => page.evaluate(() => {
  const vids = [...document.querySelectorAll('video')].map((v) => ({ w: v.videoWidth, h: v.videoHeight, t: +v.currentTime.toFixed(1), d: +(v.duration || 0).toFixed(1), err: v.error ? v.error.code : null }))
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
for (const item of items) {
  const started = Date.now()
  const rec = { no: item.no, cat: item.cat, title: item.title, id: item.id, target: item.target || '', at: new Date().toISOString(), ok: false }
  try {
    await page.goto(`http://127.0.0.1:${PORT}/player/?id=${encodeURIComponent(item.id)}&v=live`, { waitUntil: 'domcontentloaded', timeout: 45000 })
    let st = null, firstT = null, maxT = 0
    for (let t = 0; t < 26; t++) {
      await page.waitForTimeout(1500)
      st = await read()
      if (st.video && st.video.w > 0) {
        if (firstT == null) firstT = st.video.t
        maxT = Math.max(maxT, st.video.t)
        if (st.video.t > 3 && maxT - (firstT ?? 0) > 1.5) break
      }
    }
    rec.video = st?.video || null
    rec.line = st?.line || ''
    rec.lineOn = st?.lineOn || ''
    rec.episode = st?.episode || ''
    rec.episodeOn = st?.episodeOn || ''
    rec.status = st?.status || ''
    rec.bodyTail = st?.body || ''
    rec.firstT = firstT; rec.maxT = maxT
    rec.lineIsTarget = rec.target ? (rec.line === rec.target || rec.lineOn === rec.target) : null
    rec.ok = Boolean(rec.video && rec.video.w > 0 && rec.video.t > 2 && maxT - (firstT ?? 0) > 1)
    rec.elapsedMs = Date.now() - started
  } catch (e) {
    rec.error = String(e.message || e).slice(0, 160)
    rec.elapsedMs = Date.now() - started
  }
  appendFileSync(outFile, JSON.stringify(rec) + '\n')
  console.log(`${rec.no} ${rec.title} ${rec.ok ? 'PLAY' : 'FAIL'} line=${rec.line || rec.lineOn || '-'}${rec.target ? ' target=' + rec.target + (rec.lineIsTarget ? ' MATCH' : ' DIFF') : ''} t=${rec.video?.t ?? '-'} ${rec.video?.w || 0}x${rec.video?.h || 0} ${rec.elapsedMs}ms`)
}
await b.close()
srv.close()
