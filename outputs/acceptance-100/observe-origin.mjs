// 观察原站用户可见的默认季/集/线路：正常搜索→站点自己打开播放器，不手动换线。
// 静音：Chrome 以 --mute-audio 启动；只读观察，不复制片源。
import { chromium } from 'file:///C:/Users/kenzh/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core/index.mjs'
import { readFileSync, appendFileSync } from 'node:fs'
const items = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const outFile = process.argv[3]
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--mute-audio', '--no-first-run', '--proxy-server=http://127.0.0.1:8202', '--proxy-bypass-list=127.0.0.1;localhost'] })
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
const page = await ctx.newPage()

async function openHome() {
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.goto('https://kanju17.com/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    for (let w = 0; w < 12; w++) {
      await page.waitForTimeout(2500)
      if (await page.getByLabel('影视搜索输入').count()) return true
      const go = page.getByText('确认前往', { exact: false }).first()
      if (await go.count()) await go.click().catch(() => {})
    }
  }
  return false
}

const stateOf = () => page.evaluate(() => {
  const v = document.querySelector('video')
  const shell = document.querySelector('.movie-player-shell')
  const preview = document.querySelector('.global-player-preview-actions')
  const lineBtn = shell?.querySelector('button.react-player-panel-trigger')
  return {
    video: v ? { w: v.videoWidth, h: v.videoHeight, t: +v.currentTime.toFixed(1), d: +(v.duration || 0).toFixed(1), ready: v.readyState, paused: v.paused, err: v.error ? { code: v.error.code, msg: String(v.error.message || '').slice(0, 60) } : null } : null,
    line: (lineBtn?.innerText || '').replace(/\s+/g, ' ').trim(),
    preview: (preview?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    hasPlayer: Boolean(shell),
  }
})

const clickExactPlay = (title) => page.evaluate((title) => {
  const nodes = [...document.querySelectorAll('h1,h2,h3,h4,p,span,div,img')]
    .filter((e) => e.children.length === 0 && (e.textContent.trim() === title || e.getAttribute('alt') === title))
  for (const n of nodes) {
    let p = n
    for (let i = 0; i < 9 && p; i++) {
      const btn = [...p.querySelectorAll('button')].find((b) => b.textContent.trim() === '播放')
      if (btn) { btn.click(); return true }
      p = p.parentElement
    }
  }
  return false
}, title)

let homeOk = false
let originHome = 'https://kanju17.com/'
for (const item of items) {
  const started = Date.now()
  const rec = { no: item.no, cat: item.cat, title: item.title, id: item.id, observedAt: new Date().toISOString(), ok: false }
  try {
    if (!homeOk || !(await page.getByLabel('影视搜索输入').count())) {
      homeOk = await openHome()
      originHome = page.url()
    }
    if (!homeOk) throw new Error('origin_home_unavailable')
    // 每部都重置到原站首页，避免沿用上一部的小窗、视频和线路
    await page.goto(originHome, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.getByLabel('影视搜索输入').waitFor({ state: 'visible', timeout: 20000 })
    await page.getByLabel('影视搜索输入').fill(item.title)
    await page.keyboard.press('Enter')
    let st = null, clicked = false
    const matchesTitle = (s) => Boolean(s && s.preview && s.preview.includes(item.title))
    for (let t = 0; t < 30; t++) {
      await page.waitForTimeout(1500)
      st = await stateOf()
      if (matchesTitle(st) && st.line && st.video && st.video.w > 0 && st.video.t > 0.5) break
      if (t === 6 && !(matchesTitle(st) && st.line)) { clicked = await clickExactPlay(item.title) }
    }
    rec.video = st.video
    rec.preview = st.preview
    rec.originLine = st.line.replace(/\s*自动\s*$/, '').trim()
    rec.originEpisode = (st.preview.match(/第\s*\d+\s*[集期]/) || st.preview.match(/正片/) || [])[0] || ''
    rec.clickedPlay = clicked
    rec.ok = Boolean(matchesTitle(st) && st.video && st.video.w > 0 && st.video.t > 0.5 && rec.originLine)
    if (!rec.ok && matchesTitle(st) === false) rec.titleMismatch = true
    if (!rec.ok) rec.reason = (await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(-240)))
    rec.elapsedMs = Date.now() - started
    await page.keyboard.press('Escape').catch(() => {})
  } catch (e) {
    rec.error = String(e.message || e).slice(0, 200)
    rec.elapsedMs = Date.now() - started
    homeOk = false
  }
  appendFileSync(outFile, JSON.stringify(rec) + '\n')
  console.log(`${item.no} ${item.title} ${rec.ok ? 'OK ' + rec.originEpisode + ' / ' + rec.originLine + ' ' + rec.video.w + 'x' + rec.video.h : 'FAIL ' + (rec.reason || rec.error || '').slice(0, 70)} ${rec.elapsedMs}ms`)
}
await b.close()
