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
  const preview = document.querySelector('.global-player-preview-actions')
  const shell = document.querySelector('.movie-player-shell')
  const lines = [...document.querySelectorAll('*')].filter(e => e.children.length===0 && e.textContent.trim()==='1080P-官方Z')
  const btns = [...(shell?.querySelectorAll('button,[role=button]')||[])].map(e => ({aria:e.getAttribute('aria-label'), txt:(e.innerText||'').trim().slice(0,20), pressed:e.getAttribute('aria-pressed'), cls:String(e.className).slice(0,40)}))
  return { previewText: preview?.innerText, lineEls: lines.map(e=>({tag:e.tagName, cls:String(e.className).slice(0,60), parentTag:e.parentElement?.tagName, parentCls:String(e.parentElement?.className).slice(0,60), parentRole:e.parentElement?.getAttribute('role'), parentSel:e.parentElement?.getAttribute('aria-selected')})), btns }
})
console.log(JSON.stringify(info, null, 1).slice(0, 5000))
await b.close()
