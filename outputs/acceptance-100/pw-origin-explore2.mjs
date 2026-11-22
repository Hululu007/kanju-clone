import { chromium } from 'file:///C:/Users/kenzh/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core/index.mjs'
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--mute-audio','--no-first-run'] })
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN' })
const p = await ctx.newPage()
p.on('console', m => console.log('CONSOLE', m.type(), m.text().slice(0,200)))
p.on('pageerror', e => console.log('PAGEERR', String(e).slice(0,300)))
p.on('requestfailed', r => console.log('REQFAIL', r.url().slice(0,120), r.failure()?.errorText))
await p.goto('https://kanju17.com/', { waitUntil: 'load', timeout: 60000 })
for (let i=0;i<6;i++){ await p.waitForTimeout(2500); console.log('tick',i,'url',p.url(),'html',(await p.content()).length,'text',(await p.locator('body').innerText()).length) }
console.log('TEXT', (await p.locator('body').innerText()).slice(0,600).replace(/\n+/g,' | '))
await p.screenshot({ path: 'outputs/acceptance-100/raw/origin-explore2.png', fullPage: false })
await b.close()
