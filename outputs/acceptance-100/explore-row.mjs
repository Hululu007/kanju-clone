import { chromium } from 'file:///C:/Users/kenzh/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core/index.mjs'
const title = process.argv[2]
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--mute-audio','--no-first-run','--proxy-server=http://127.0.0.1:8202','--proxy-bypass-list=127.0.0.1;localhost'] })
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
const page = await ctx.newPage()
ctx.on('page', (p) => console.log('NEWPAGE', p.url()))
async function openHome() {
  for (let a = 0; a < 5; a++) {
    await page.goto('https://kanju17.com/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    for (let w = 0; w < 14; w++) {
      await page.waitForTimeout(2500)
      if (await page.getByLabel('影视搜索输入').count()) return true
      for (const lab of ['确认前往','继续访问']) { const g = page.getByText(lab, { exact: false }).first(); if (await g.count()) await g.click().catch(()=>{}) }
    }
  }
  return false
}
await openHome()
await page.getByLabel('影视搜索输入').fill(title)
await page.keyboard.press('Enter')
await page.waitForTimeout(11000)
// 找到包含标题的结果行，点该行自己的「播放」
const hit = await page.evaluate((t) => {
  const rows = [...document.querySelectorAll('li,article,div')].filter((e) => {
    const txt = (e.innerText || '').replace(/\s+/g, ' ')
    return txt.includes(t) && txt.length < 160 && [...e.querySelectorAll('button')].some((b) => b.textContent.trim() === '播放')
  })
  // 取最内层
  const row = rows[rows.length - 1]
  if (!row) return 'no-row:' + rows.length
  const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '播放')
  btn.click()
  return 'clicked:' + (row.innerText || '').replace(/\s+/g, ' ').slice(0, 90)
}, title)
console.log('HIT', hit)
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(2500)
  const st = await page.evaluate(() => { const vids=[...document.querySelectorAll('video')].map(v=>({w:v.videoWidth,h:v.videoHeight,t:+v.currentTime.toFixed(1),d:+(v.duration||0).toFixed(1)})); const shell=document.querySelector('.movie-player-shell'); const lb=shell?.querySelector('.movie-player-shell button.react-player-panel-trigger') || document.querySelector('button.react-player-panel-trigger'); return {vids, line:(lb?.innerText||'').replace(/\s+/g,' ').trim(), shell:!!shell, tabs:document.title} })
  console.log(i, JSON.stringify(st), 'pages=' + ctx.pages().length)
  if (st.vids.some(v=>v.w>0 && v.t>0.5)) break
  for (const lab of ['暂不查看','暂不登录']) { const g = page.getByText(lab, { exact: true }).first(); if (await g.count()) { await g.click().catch(()=>{}); console.log('dismissed',lab) } }
}
console.log('BODYTAIL', (await page.evaluate(()=>document.body.innerText)).replace(/\s+/g,' ').slice(-500))
await b.close()
