// 原站默认项观察 v2：先关「播放小窗已经打开 / 登录后确认」弹层，再取默认季/集/线路。
// 静音 headless Chrome；只观察正常可见界面，不复制片源。
import { chromium } from 'file:///C:/Users/kenzh/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core/index.mjs'
import { readFileSync, appendFileSync } from 'node:fs'
const items = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const outFile = process.argv[3]
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--mute-audio', '--no-first-run', '--proxy-server=http://127.0.0.1:8202', '--proxy-bypass-list=127.0.0.1;localhost'] })
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
const page = await ctx.newPage()

const stateOf = () => page.evaluate(() => {
  const vids = [...document.querySelectorAll('video')].map((v) => ({ w: v.videoWidth, h: v.videoHeight, t: +v.currentTime.toFixed(1), d: +(v.duration || 0).toFixed(1), ready: v.readyState, paused: v.paused, err: v.error ? v.error.code : null }))
  const best = vids.filter((v) => v.w > 0).sort((a, b) => b.t - a.t)[0] || vids[0] || null
  const shell = document.querySelector('.movie-player-shell')
  const preview = document.querySelector('.global-player-preview-actions') || document.querySelector('.global-player-preview')
  const lineBtn = shell?.querySelector('button.react-player-panel-trigger')
  const epNodes = [...document.querySelectorAll('.movie-player-shell [class*=episode], .movie-player-shell [class*=ep], .global-player-preview [class*=episode]')]
  const epOn = epNodes.map((n) => (n.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
  return {
    vids, best,
    line: (lineBtn?.innerText || '').replace(/\s+/g, ' ').trim(),
    preview: (preview?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 260),
    epOn: epOn.slice(0, 6),
    hasPlayer: Boolean(shell),
    body: document.body.innerText.replace(/\s+/g, ' ').slice(-300),
  }
})

async function dismiss() {
  for (const label of ['暂不查看', '暂不登录', '关闭']) {
    const el = page.getByText(label, { exact: true }).first()
    if (await el.count()) { await el.click({ timeout: 3000 }).catch(() => {}); return true }
  }
  return false
}

async function openHome() {
  for (let a = 0; a < 4; a++) {
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

const clickExactPlay = (title) => page.evaluate((title) => {
  const nodes = [...document.querySelectorAll('h1,h2,h3,h4,p,span,div,img')]
    .filter((e) => e.children.length === 0 && (e.textContent.trim() === title || e.getAttribute('alt') === title))
  for (const n of nodes) {
    let p = n
    for (let i = 0; i < 9 && p; i++) {
      const btn = [...p.querySelectorAll('button,a')].find((b) => b.textContent.trim() === '播放')
      if (btn) { btn.click(); return true }
      p = p.parentElement
    }
  }
  return false
}, title)

let homeOk = false, originHome = 'https://kanju17.com/'
for (const item of items) {
  const started = Date.now()
  const rec = { no: item.no, cat: item.cat, title: item.title, id: item.id, observedAt: new Date().toISOString(), ok: false, v: 2 }
  try {
    if (!homeOk || !(await page.getByLabel('影视搜索输入').count())) { homeOk = await openHome(); originHome = page.url() }
    if (!homeOk) throw new Error('origin_home_unavailable')
    await page.goto(originHome, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.getByLabel('影视搜索输入').waitFor({ state: 'visible', timeout: 30000 })
    await page.getByLabel('影视搜索输入').fill(item.title)
    await page.keyboard.press('Enter')
    let st = null, clicked = 0, dismissed = 0
    const matches = (s) => Boolean(s && s.preview && s.preview.includes(item.title.slice(0, 8)))
    for (let t = 0; t < 40; t++) {
      await page.waitForTimeout(1500)
      st = await stateOf()
      if (st.best && st.best.w > 0 && st.best.t > 0.5 && st.line) break
      if (await dismiss()) { dismissed++; continue }
      if (t === 5 || (t === 14 && !st.best?.w)) { if (await clickExactPlay(item.title)) clicked++ }
    }
    rec.video = st.best
    rec.vids = st.vids
    rec.preview = st.preview
    rec.epOn = st.epOn
    rec.originLine = (st.line || '').replace(/\s*自动\s*$/, '').trim()
    rec.originEpisode = (st.preview.match(/第\s*\d+\s*[集期]/) || st.epOn.find((x) => /第\s*\d+\s*[集期]/.test(x)) || st.preview.match(/正片/) || [])[0] || ''
    rec.clicked = clicked; rec.dismissed = dismissed
    rec.ok = Boolean(st.best && st.best.w > 0 && st.best.t > 0.5 && rec.originLine)
    if (!rec.ok) rec.reason = st.body
    rec.elapsedMs = Date.now() - started
    await page.keyboard.press('Escape').catch(() => {})
  } catch (e) {
    rec.error = String(e.message || e).slice(0, 200)
    rec.elapsedMs = Date.now() - started
    homeOk = false
  }
  appendFileSync(outFile, JSON.stringify(rec) + '\n')
  console.log(`${item.no} ${item.title} ${rec.ok ? 'OK ' + (rec.originEpisode || '-') + ' / ' + rec.originLine + ' ' + rec.video.w + 'x' + rec.video.h : 'FAIL ' + (rec.reason || rec.error || '').slice(-70)} ${rec.elapsedMs}ms`)
}
await b.close()
