import { chromium } from 'file:///C:/Users/kenzh/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core/index.mjs'
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--mute-audio','--no-first-run','--proxy-server=http://127.0.0.1:8202','--proxy-bypass-list=127.0.0.1;localhost'] })
const ctx = await b.newContext({ viewport:{width:1400,height:900}, locale:'zh-CN' })
const p = await ctx.newPage()
await p.goto('https://kanju17.com/', { waitUntil:'domcontentloaded', timeout:60000 })
await p.waitForTimeout(15000)
const box = p.getByLabel('影视搜索输入'); await box.fill('凡人修仙传'); await p.keyboard.press('Enter')
await p.waitForTimeout(12000)
const info = await p.evaluate(() => {
  const exact = [...document.querySelectorAll('*')].filter(e => e.children.length===0 && e.textContent.trim()==='凡人修仙传').slice(0,3)
  const out = exact.map(e => {
    let node = e, chain=[]
    for (let i=0;i<6 && node;i++){ chain.push({tag:node.tagName, cls:String(node.className).slice(0,60), role:node.getAttribute?.('role')}); node=node.parentElement }
    const card = e.closest('[data-show-id],article,li,div')
    return { chain, cardCls: card && String(card.className).slice(0,80), cardText: card && card.innerText.slice(0,120).replace(/\n+/g,'|'), btns: card ? [...card.querySelectorAll('button')].map(b=>b.innerText.trim().slice(0,12)) : [] }
  })
  return { out, videos: document.querySelectorAll('video').length }
})
console.log(JSON.stringify(info,null,1).slice(0,3000))
await b.close()
