import http from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { chromium } from 'file:///C:/Users/kenzh/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core/index.mjs'
const DIST = 'C:/Users/kenzh/AppData/Local/Temp/kanju-web-playback/dist'
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.woff2':'font/woff2', '.webmanifest':'application/manifest+json' }
const srv = http.createServer((req,res)=>{
  const u = new URL(req.url,'http://x')
  let f = join(DIST, decodeURIComponent(u.pathname))
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f,'index.html')
  if (!existsSync(f)) f = join(DIST,'index.html')
  res.writeHead(200, {'content-type': MIME[extname(f)]||'application/octet-stream'})
  res.end(readFileSync(f))
})
await new Promise(r=>srv.listen(5311,'127.0.0.1',r))
const b = await chromium.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true, args:['--mute-audio','--no-first-run','--proxy-server=http://127.0.0.1:8202','--proxy-bypass-list=127.0.0.1;localhost'] })
const ctx = await b.newContext({ viewport:{width:1400,height:900}, locale:'zh-CN' })
const p = await ctx.newPage()
const id = 'av_RQKPHe_swmdc2S67YD_FapUsze6-cWDeerX3qvKoejgyu5YFcUxsh5Hh2wmrcc1iPLCzBGy_VU5KvyQ'
await p.goto(`http://127.0.0.1:5311/player/?id=${id}&v=live`, { waitUntil:'domcontentloaded', timeout:60000 })
for (let i=0;i<10;i++){
  await p.waitForTimeout(3000)
  const st = await p.evaluate(()=>{ const v=document.querySelector('video'); return { text: document.body.innerText.slice(-400).replace(/\n+/g,'|'), video: v&&{w:v.videoWidth,h:v.videoHeight,t:+v.currentTime.toFixed(1),d:+(v.duration||0).toFixed(1),ready:v.readyState,paused:v.paused,muted:v.muted} } })
  console.log('tick',i,JSON.stringify(st.video),'|',st.text)
  if (st.video && st.video.t>3) break
  if (i===2) await p.evaluate(()=>{ const v=document.querySelector('video'); if(v){v.muted=true;v.play().catch(()=>{})} })
}
await p.screenshot({path:'outputs/acceptance-100/raw/local-probe.png'})
await b.close(); srv.close()
