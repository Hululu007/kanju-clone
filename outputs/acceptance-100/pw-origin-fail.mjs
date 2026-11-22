import { chromium } from 'file:///C:/Users/kenzh/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core/index.mjs'
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--mute-audio','--no-first-run','--proxy-server=http://127.0.0.1:8202','--proxy-bypass-list=127.0.0.1;localhost'] })
const ctx = await b.newContext({ viewport:{width:1400,height:900}, locale:'zh-CN' })
const p = await ctx.newPage()
await p.goto('https://kanju17.com/', { waitUntil:'domcontentloaded', timeout:60000 })
await p.waitForTimeout(15000)
const box = p.getByLabel('影视搜索输入'); await box.fill(process.argv[2]||'凡人修仙传'); await p.keyboard.press('Enter')
for (let i=0;i<8;i++){
  await p.waitForTimeout(5000)
  const st = await p.evaluate(() => {
    const v=document.querySelector('video')
    const shell=document.querySelector('.movie-player-shell')
    const lineBtn = shell?.querySelector('button.react-player-panel-trigger')
    const status = [...document.querySelectorAll('[role=status]')].map(e=>e.innerText).filter(Boolean).slice(0,4)
    return { v: v && {w:v.videoWidth,h:v.videoHeight,tv:+v.currentTime.toFixed(1),d:+(v.duration||0).toFixed(1),ready:v.readyState,paused:v.paused,err:v.error&&{code:v.error.code,msg:v.error.message}}, line:(lineBtn?.innerText||'').replace(/\s+/g,' '), shellText: (shell?.innerText||'').replace(/\s+/g,' ').slice(0,300), status }
  })
  console.log('t',i,JSON.stringify(st).slice(0,700))
  if (st.v && st.v.tv>1) break
}
await b.close()
