import { chromium } from 'file:///C:/Users/kenzh/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core/index.mjs'
const base = process.argv[2] || 'https://zhuiju.dpdns.org'
const id = process.argv[3] || 'av_RQKPHe_swmdc2S67YD_FapUsze6-cWDeerX3qvKoejgyu5YFcUxsh5Hh2wmrcc1iPLCzBGy_VU5KvyQ'
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--mute-audio','--no-first-run'] })
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN' })
const p = await ctx.newPage()
p.on('console', m => { if (m.type()==='error') console.log('CONSOLE_ERR', m.text().slice(0,150)) })
await p.goto(`${base}/player/?id=${encodeURIComponent(id)}&v=live`, { waitUntil: 'domcontentloaded', timeout: 60000 })
for (let i=0;i<10;i++){
  await p.waitForTimeout(3000)
  const st = await p.evaluate(() => {
    const v = document.querySelector('video')
    const txt = document.body.innerText
    const btns = [...document.querySelectorAll('button')].map(b=>({aria:b.getAttribute('aria-label'), t:(b.innerText||'').trim().slice(0,18)})).filter(x=>x.t||x.aria)
    return { text: txt.slice(-500).replace(/\n+/g,'|'), video: v && {w:v.videoWidth,h:v.videoHeight,t:+v.currentTime.toFixed(1),d:+(v.duration||0).toFixed(1),ready:v.readyState,paused:v.paused}, btns: btns.slice(-15) }
  })
  console.log('tick',i,'video',JSON.stringify(st.video),'| tail',st.text)
  if (st.video && st.video.t > 3) break
  if (i===3) { // 尝试点击播放
    await p.evaluate(() => { const v=document.querySelector('video'); if (v) { v.muted = true; v.play().catch(()=>{}) } })
  }
}
await p.screenshot({ path: 'outputs/acceptance-100/raw/our-probe.png' })
await b.close()
