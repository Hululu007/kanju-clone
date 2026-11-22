import { chromium } from 'file:///C:/Users/kenzh/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core/index.mjs'
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--mute-audio','--no-first-run'] })
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN' })
const p = await ctx.newPage()
await p.goto('https://kanju17.com/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await p.waitForTimeout(16000)
console.log('URL', p.url())
const info = await p.evaluate(() => ({
  fields: [...document.querySelectorAll('input,textarea,[contenteditable=true]')].map(e => ({tag:e.tagName,ph:e.placeholder,type:e.type,aria:e.getAttribute('aria-label'),cls:String(e.className).slice(0,60)})),
}))
console.log(JSON.stringify(info, null, 1))
await b.close()
