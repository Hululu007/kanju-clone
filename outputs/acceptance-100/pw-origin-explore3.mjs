import { chromium } from 'file:///C:/Users/kenzh/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core/index.mjs'
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--mute-audio','--no-first-run'] })
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN' })
const p = await ctx.newPage()
p.on('framenavigated', f => { if (f === p.mainFrame()) console.log('NAV', f.url()) })
await p.goto('https://kanju17.com/', { waitUntil: 'domcontentloaded', timeout: 60000 })
for (let i=0;i<10;i++){
  await p.waitForTimeout(2500)
  let url='?', text='', html=0
  try { url = p.url(); text = await p.locator('body').innerText(); html=(await p.content()).length } catch(e){ console.log('tick',i,'busy') ; continue }
  console.log('tick',i,'url',url,'html',html,'text',text.length, text.slice(0,120).replace(/\n+/g,'|'))
  if (html > 20000) break
}
await p.screenshot({ path: 'outputs/acceptance-100/raw/origin-explore3.png' })
try { console.log('FINALURL', p.url()) } catch {}
await b.close()
