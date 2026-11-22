import { chromium } from 'file:///C:/Users/kenzh/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core/index.mjs'
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--mute-audio','--no-first-run'] })
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN' })
const p = await ctx.newPage()
await p.goto('https://kanju17.com/', { waitUntil: 'domcontentloaded', timeout: 45000 })
await p.waitForTimeout(1500)
// 走站点自身“确认前往”
const go = p.getByText('确认前往', { exact: false }).first()
if (await go.count()) { await go.click().catch(()=>{}) }
await p.waitForTimeout(6000)
console.log('URL1', p.url())
console.log('TITLE', await p.title())
const text = await p.locator('body').innerText()
console.log('TEXT', text.slice(0, 1200).replace(/\n+/g,' | '))
console.log('INPUTS', await p.locator('input').evaluateAll(els => els.map(e => ({ph:e.placeholder, type:e.type, name:e.name})).slice(0,8)))
console.log('LINKS', await p.locator('a').evaluateAll(els => els.map(e => e.getAttribute('href')).filter(Boolean).slice(0,15)))
await p.screenshot({ path: 'outputs/acceptance-100/raw/origin-explore.png' })
await b.close()
