import { chromium } from 'file:///C:/Users/kenzh/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core/index.mjs'
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--mute-audio','--no-first-run'] })
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN' })
const p = await ctx.newPage()
await p.goto('https://kanju17.com/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await p.waitForTimeout(14000)
await p.getByLabel('影视搜索输入').fill('嫁金钗')
await p.keyboard.press('Enter')
await p.waitForTimeout(16000)
const info = await p.evaluate(() => {
  const vid = document.querySelector('video')
  const all = [...document.querySelectorAll('button,[role=button],[role=tab],li,div')]
  const hits = all.filter(e => e.children.length <= 2 && /000P|高清|zyk|官方|线路|第\d+集|正片/.test(e.innerText || ''))
  return {
    video: vid ? { w: vid.videoWidth, h: vid.videoHeight, t: vid.currentTime, d: vid.duration } : null,
    hits: hits.slice(0,40).map(e => ({ tag:e.tagName, role:e.getAttribute('role'), txt:(e.innerText||'').trim().slice(0,30), aria:e.getAttribute('aria-label'), pressed:e.getAttribute('aria-pressed'), sel:e.getAttribute('aria-selected'), cls:String(e.className).slice(0,50) })),
  }
})
console.log(JSON.stringify(info, null, 1).slice(0, 4000))
await b.close()
