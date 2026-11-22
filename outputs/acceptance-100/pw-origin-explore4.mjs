import { chromium } from 'file:///C:/Users/kenzh/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core/index.mjs'
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--mute-audio','--no-first-run'] })
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN' })
const p = await ctx.newPage()
await p.goto('https://kanju17.com/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await p.waitForTimeout(16000)
console.log('URL', p.url())
const info = await p.evaluate(() => ({
  inputs: [...document.querySelectorAll('input')].map(e => ({ph:e.placeholder,type:e.type,cls:e.className})).slice(0,10),
  buttons: [...document.querySelectorAll('button,[role=button],a')].map(e => ({tag:e.tagName, txt:(e.innerText||'').trim().slice(0,20), aria:e.getAttribute('aria-label'), href:e.getAttribute('href')})).slice(0,40),
  imgs: document.querySelectorAll('img').length,
}))
console.log(JSON.stringify(info, null, 1).slice(0, 3000))
await p.screenshot({ path: 'outputs/acceptance-100/raw/origin-home-app.png' })
await b.close()
