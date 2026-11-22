import { chromium } from 'file:///C:/Users/kenzh/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core/index.mjs'
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--mute-audio','--no-first-run'] })
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN' })
const p = await ctx.newPage()
p.on('response', async r => { const u=r.url(); if (/show|play|line|episode|detail|media|source/i.test(u) && r.status()<400 && !/\.(js|css|png|jpg|webp|woff2?)$/i.test(u)) console.log('RESP', r.status(), u.slice(0,150)) })
await p.goto('https://kanju17.com/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await p.waitForTimeout(15000)
await p.getByLabel('影视搜索输入').fill('嫁金钗')
await p.keyboard.press('Enter')
for (let i=0;i<8;i++){
  await p.waitForTimeout(5000)
  let t='', vids=[]
  try { t = await p.locator('body').innerText(); vids = await p.evaluate(() => [...document.querySelectorAll('video')].map(v=>({w:v.videoWidth,h:v.videoHeight,t:+v.currentTime.toFixed(1),d:+(v.duration||0).toFixed(1),paused:v.paused}))) } catch(e){ console.log('tick',i,'busy'); continue }
  const tail = t.slice(-260).replace(/\n+/g,'|')
  console.log('tick',i,'videos',JSON.stringify(vids),'|',tail)
  if (vids.some(v=>v.t>3)) break
}
await b.close()
