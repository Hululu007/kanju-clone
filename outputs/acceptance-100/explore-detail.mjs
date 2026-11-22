import { chromium } from 'file:///C:/Users/kenzh/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core/index.mjs'
const title = process.argv[2]
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--mute-audio','--no-first-run','--proxy-server=http://127.0.0.1:8202','--proxy-bypass-list=127.0.0.1;localhost'] })
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
const page = await ctx.newPage()
async function openHome() {
  for (let a = 0; a < 5; a++) {
    await page.goto('https://kanju17.com/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    for (let w = 0; w < 14; w++) {
      await page.waitForTimeout(2500)
      if (await page.getByLabel('影视搜索输入').count()) return true
      const go = page.getByText('确认前往', { exact: false }).first()
      if (await go.count()) await go.click().catch(() => {})
      const go2 = page.getByText('继续访问', { exact: false }).first()
      if (await go2.count()) await go2.click().catch(() => {})
    }
  }
  return false
}
console.log('home', await openHome(), page.url())
await page.getByLabel('影视搜索输入').fill(title)
await page.keyboard.press('Enter')
await page.waitForTimeout(10000)
console.log('URL1', page.url())
const links = await page.evaluate(() => [...document.querySelectorAll('a')].map(a=>({t:(a.innerText||'').replace(/\s+/g,' ').trim().slice(0,30), h:a.getAttribute('href')})).filter(x=>x.h && !x.h.startsWith('http')).slice(0,60))
console.log('LINKS', JSON.stringify(links))
const clicked = await page.evaluate((t) => {
  const a=[...document.querySelectorAll('a')].find(a=>a.innerText.includes(t.slice(0,6)) && !a.getAttribute('href').startsWith('http'))
  if(a){a.click();return 'anchor:'+a.getAttribute('href')}
  const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='播放')
  if(btn){btn.click();return 'play-btn'}
  return 'none'
}, title)
console.log('CLICKED', clicked)
await page.waitForTimeout(8000)
console.log('URL2', page.url())
console.log('BODY', (await page.evaluate(()=>document.body.innerText)).replace(/\s+/g,' ').slice(0,1200))
const st = await page.evaluate(()=>{const vids=[...document.querySelectorAll('video')].map(v=>({w:v.videoWidth,h:v.videoHeight,t:+v.currentTime.toFixed(1)}));const shell=document.querySelector('.movie-player-shell');const lb=shell?.querySelector('button.react-player-panel-trigger');return {vids,line:(lb?.innerText||'').replace(/\s+/g,' ').trim(),shell:!!shell,iframes:[...document.querySelectorAll('iframe')].map(f=>f.src.slice(0,90))}})
console.log('STATE', JSON.stringify(st))
await b.close()
