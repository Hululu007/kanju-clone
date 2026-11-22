// 本站候选构建静音实播：默认配置（不手动换线）能否真实解码并推进。
// Chrome 以 --mute-audio 启动；媒体音量在页面内也强制静音。
import http from 'node:http'
import { readFileSync, existsSync, statSync, appendFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { chromium } from 'file:///C:/Users/kenzh/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core/index.mjs'

const items = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const outFile = process.argv[3]
const PORT = 5312
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

for (const item of items) {
  const started = Date.now()
  const rec = { no: item.no, cat: item.cat, title: item.title, id: item.id, observedAt: new Date().toISOString(), ok: false }
  try {
    await page.goto(`http://127.0.0.1:${PORT}/player/?id=${encodeURIComponent(item.id)}&v=live`, { waitUntil: 'domcontentloaded', timeout: 45000 })
    let st = null
    for (let t = 0; t < 24; t++) {
      await page.waitForTimeout(1500)
      st = await page.evaluate(() => {
        const v = document.querySelector('video')
        const q = document.querySelector('#qualityPill [data-quality-text]') || document.querySelector('.pl-quality [data-quality-text]')
        const ep = document.querySelector('#playerLabel')
        const status = document.querySelector('#playStatus')
        const on = document.querySelector('.pl-line.on')
        return {
          video: v ? { w: v.videoWidth, h: v.videoHeight, t: +v.currentTime.toFixed(1), d: +(v.duration || 0).toFixed(1), ready: v.readyState, paused: v.paused, muted: v.muted, err: v.error ? { code: v.error.code, msg: String(v.error.message || '').slice(0, 80) } : null } : null,
          line: (q?.textContent || '').trim(),
          lineOn: (on?.innerText || '').replace(/\s+/g, ' ').trim(),
          episode: (ep?.textContent || '').trim(),
          status: (status?.innerText || '').replace(/\s+/g, ' ').trim(),
        }
      })
      if (st.video && st.video.w > 0 && st.video.t > 2) break
    }
    rec.video = st.video
    rec.ourLine = st.line
    rec.ourLineOn = st.lineOn
    rec.ourEpisode = st.episode
    rec.status = st.status
    rec.ok = Boolean(st.video && st.video.w > 0 && st.video.t > 2)
    rec.elapsedMs = Date.now() - started
  } catch (e) {
    rec.error = String(e.message || e).slice(0, 200)
    rec.elapsedMs = Date.now() - started
  }
  appendFileSync(outFile, JSON.stringify(rec) + '\n')
  console.log(`${item.no} ${item.title} ${rec.ok ? 'OK ' + rec.ourEpisode + ' / ' + rec.ourLine + ' ' + rec.video.w + 'x' + rec.video.h + ' t=' + rec.video.t : 'FAIL ' + (rec.error || rec.status || '') .slice(0, 70)} ${rec.elapsedMs}ms`)
}
await b.close()
srv.close()
