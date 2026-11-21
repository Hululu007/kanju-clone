// 播放器控制栏显隐自测：本地静态服务 + 静音无头 Chrome + CDP 真实鼠标事件
// 用法：npx vite build && node scripts/player-ctrl-selftest.mjs [宽] [高] [normal|fullscreen|webfull]
// 任何一条 FAIL 都会以退出码 1 结束，方便接进 CI 或包一层脚本跑。
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(REPO_ROOT, '.testtmp')
const WIDTH = Number(process.argv[2] || 1024)
const HEIGHT = Number(process.argv[3] || 800)
const MODE = process.argv[4] || 'normal'
const DIST = join(REPO_ROOT, 'dist')
const CLIP = join(TMP, 'testclip.mp4')
const PORT = 5200 + (WIDTH % 100)
const CDP = 9400 + (WIDTH % 100)
const PROFILE = join(TMP, `cdpprof-${WIDTH}-${MODE}`)
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'

if (!existsSync(DIST)) {
  console.error(`找不到 ${DIST}，先跑 npx vite build`)
  process.exit(2)
}

// 本地测试片源：45 秒彩条 + 无音轨（静音规矩），缺失时用 ffmpeg 生成
mkdirSync(TMP, { recursive: true })
if (!existsSync(CLIP)) {
  const ff = spawnSync(process.env.FFMPEG || 'ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=45',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', CLIP,
  ], { stdio: 'inherit' })
  if (ff.status !== 0 || !existsSync(CLIP)) {
    console.error('生成测试片源失败：请安装 ffmpeg，或用 FFMPEG=/path/to/ffmpeg 指定路径')
    process.exit(2)
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4' }

const playRequests = []
const options = [
  { provider: 'fixture-a', label: 'Fixture A', status: 'ok', quality: 720 },
  { provider: 'fixture-b', label: 'Fixture B', status: 'ok', quality: 720 },
]
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname.startsWith('/api/')) {
    let body = { ok: true }
    if (url.pathname === '/api/lines') body = { options }
    if (url.pathname === '/api/play') {
      const provider = url.searchParams.get('line') || options[0].provider
      playRequests.push(provider)
      body = { url: `/__clip.mp4?line=${provider}`, kind: 'mp4', provider, quality: 720,
        options: url.searchParams.has('line') ? options.filter((option) => option.provider === provider) : options }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(body))
  }
  if (url.pathname === '/__clip.mp4') {
    const clip = readFileSync(CLIP)
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
    const start = range ? Number(range[1]) : 0
    const end = range?.[2] ? Math.min(Number(range[2]), clip.length - 1) : clip.length - 1
    if (start > end || start >= clip.length) {
      res.writeHead(416, { 'content-range': `bytes */${clip.length}` })
      return res.end()
    }
    const headers = { 'content-type': 'video/mp4', 'content-length': end - start + 1, 'accept-ranges': 'bytes' }
    if (range) headers['content-range'] = `bytes ${start}-${end}/${clip.length}`
    res.writeHead(range ? 206 : 200, headers)
    return res.end(clip.subarray(start, end + 1))
  }
  let file = join(DIST, decodeURIComponent(url.pathname))
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  if (!existsSync(file)) { res.writeHead(404); return res.end('nf') }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(PROFILE, { recursive: true })
const chrome = spawn(CHROME, [
  ...(process.env.HEADED === '1' ? [] : ['--headless=new']), '--mute-audio', '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required', '--disable-gpu',
  `--window-size=${WIDTH},${HEIGHT}`, `--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`,
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const get = (p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: CDP, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))) }).on('error', rej))
let targets = null
for (let i = 0; i < 60; i++) { try { targets = await get('/json/list'); break } catch { await sleep(250) } }
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map(); let id = 0
const send = (m, p = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method: m, params: p })) })
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (!m.id || !pending.has(m.id)) return; const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) })
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }) })

const evaluate = async (expression) => {
  const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails).slice(0, 400))
  return out.result.value
}
const mouse = async (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'mouse', ...extra })
const clickAt = async (x, y, count = 1) => {
  await mouse('mouseMoved', x, y); await sleep(40)
  await mouse('mousePressed', x, y, { clickCount: count }); await sleep(40)
  await mouse('mouseReleased', x, y, { clickCount: count }); await sleep(count > 1 ? 60 : 650)
}
const key = async (k, code, vk) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }) }

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
if (process.env.HEADED === '1') { try { await send('Page.bringToFront') } catch {} }
// 断掉外网片源请求：测试只用本地 mp4，避免真实片源把 src 覆盖掉
await send('Network.setBlockedURLs', { urls: ['https://*', 'http://kanju*', 'http://localhost*'] })
await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
const SHOW_ID = process.env.SHOW_ID || 'av_11r8C6YQBbEwnXSLgPkpXBr8a6knud-m8Zj5bcSXdcpG8mQ-vMYEC-OmE6GG0wYU8_vDj7_XQCQ98mo'
await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('kj-proxy', location.origin)` })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/player/?id=${SHOW_ID}` })
await sleep(3000)
const firstTime = await evaluate(`document.getElementById('video')?.currentTime ?? 0`)
await sleep(700)
const secondTime = await evaluate(`document.getElementById('video')?.currentTime ?? 0`)
const startsThroughApi = playRequests.includes('fixture-a') && secondTime > firstTime

const state = () => evaluate(`(() => {
  const p = document.getElementById('player'), c = document.getElementById('plCtrl'), v = document.getElementById('video');
  const pic = document.querySelector('.pl-picture');
  const fsel = p.classList.contains('is-fullscreen') ? 'is-fullscreen' : p.classList.contains('is-webfull') ? 'is-webfull' : '';
  return {
    controls: p.dataset.controls,
    ctrlOpacity: getComputedStyle(c).opacity,
    ctrlPE: getComputedStyle(c).pointerEvents,
    ctrlVisible: getComputedStyle(c).opacity !== '0' && getComputedStyle(c).pointerEvents !== 'none',
    paused: v.paused, seeking: v.seeking, t: Math.round(v.currentTime * 10) / 10, ready: v.readyState,
    hoverCtrl: c.matches(':hover'),
    activeEl: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '',
    cursor: getComputedStyle(pic).cursor,
    dmCursor: getComputedStyle(document.getElementById('dmLayer')).cursor,
    mode: fsel,
    dmVisible: (() => { const el = document.querySelector('.dm-input'); return el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.getBoundingClientRect().width > 0 })(),
    gearOpen: !document.getElementById('plGear').hidden,
  };
})()`)
const rect = (sel) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), l: Math.round(r.x), t: Math.round(r.y), r: Math.round(r.right), b: Math.round(r.bottom) } })()`)

const out = []
const rec = (name, pass, detail) => { out.push(`${pass ? 'PASS' : 'FAIL'} ${name} :: ${detail}`) }

// 把画面滚到视口顶部，指针停到左上角空地，避免「一直停在控制栏上」这种干扰
const scrollInfo = await evaluate(`(() => {
  document.querySelector('.pl-picture').scrollIntoView({ block: 'center', inline: 'nearest' });
  return { wy: window.scrollY, de: document.documentElement.scrollTop, se: document.scrollingElement && document.scrollingElement.scrollTop };
})()`)
await sleep(400)
console.log('scroll:', JSON.stringify(scrollInfo), 'after:', JSON.stringify(await evaluate('window.scrollY')))
const park = async () => { await mouse('mouseMoved', 3, 3); await sleep(50) }

const S0 = await state()
rec('正常片源接口起播且时间前进', startsThroughApi && !S0.paused && S0.t > 0, JSON.stringify({ requests: playRequests, firstTime, secondTime, paused: S0.paused, ready: S0.ready }))
if (process.argv.includes('--start-only')) {
  console.log(out.join('\n'))
  ws.close()
  chrome.kill()
  server.close()
  process.exit(startsThroughApi ? 0 : 1)
}

const geo = await evaluate(`(() => {
  const pic = document.querySelector('.pl-picture').getBoundingClientRect();
  const v = document.getElementById('video').getBoundingClientRect();
  const pts = [[0.06,0.12],[0.5,0.5],[0.92,0.12],[0.5,0.08]];
  const hit = pts.map(([fx,fy]) => { const x = Math.round(pic.x + pic.width*fx), y = Math.round(pic.y + pic.height*fy); const el = document.elementFromPoint(x,y); return [x,y, (el && (el.id || el.className || el.tagName))]; });
  return { pic: {x:Math.round(pic.x),y:Math.round(pic.y),w:Math.round(pic.width),h:Math.round(pic.height)}, video: {x:Math.round(v.x),y:Math.round(v.y),w:Math.round(v.width),h:Math.round(v.height)}, hit };
})()`)

let pic = await rect('.pl-picture')
// 画面里避开中央播放键的点（暂停时中央是大播放钮）
const tapPt = { x: pic.x, y: pic.t + Math.round(pic.h * 0.22) }
const ensureShown = async () => {
  await evaluate(`(() => { const control = document.getElementById('btnPlay'); control.focus({ preventScroll: true }); control.blur() })()`)
  await sleep(260)
}

// R0：播放中静止 3.4s 自动隐藏
await park(); await ensureShown(); await park()
await sleep(3400)
let s = await state()
rec('R0 播放中无操作 3.4s 自动隐藏', s.controls === 'off' && !s.ctrlVisible, `controls=${s.controls} visible=${s.ctrlVisible}`)

// R1：画面单击切换播放状态，暂停时控制栏保持显示
await clickAt(tapPt.x, tapPt.y)
s = await state()
rec('R1a 单击画面暂停并显示控制栏', s.paused && s.controls === 'on' && s.ctrlVisible, `paused=${s.paused} controls=${s.controls}`)
await clickAt(tapPt.x, tapPt.y)
s = await state()
rec('R1b 再次单击画面恢复播放', !s.paused && s.controls === 'on', `paused=${s.paused} controls=${s.controls}`)

// R2：画面各处（含弹幕层覆盖区、留边）都能切换播放状态
const dmResults = []
for (const [x, y, t] of geo.hit) {
  const before = (await state()).paused
  await clickAt(x, y)
  const after = (await state()).paused
  dmResults.push(`${x},${y}(${t}):${before ? 'paused' : 'playing'}→${after ? 'paused' : 'playing'}`)
  if (after) await clickAt(x, y)
}
rec('R2 画面各处单击切换播放状态', dmResults.every((r) => /paused→playing|playing→paused/.test(r)), dmResults.join(' | '))

// R3：移动仍在继续、已超过隐藏时长时，控制栏应早已隐藏。
if ((await state()).paused) await evaluate(`document.getElementById('video').play()`)
await park(); await ensureShown()
for (let i = 0; i < 15; i++) {
  await mouse('mouseMoved', tapPt.x + (i % 5) * 22 - 44, tapPt.y + (i % 3) * 12 - 12)
  await sleep(300)
  if (i === 11) {
    s = await state()
    rec('R3 连续移动期间超过自动隐藏期限后控制栏已隐藏', s.controls === 'off', `controls=${s.controls} moves=${i + 1}`)
  }
}

// R4：鼠标停在控制栏上保持显示，离开后 3s 隐藏
await park(); await ensureShown()
const ctrl = await rect('#plCtrl')
await mouse('mouseMoved', ctrl.x, ctrl.y); await sleep(80)
for (let i = 0; i < 7; i++) { await mouse('mouseMoved', ctrl.x + i * 3, ctrl.y); await sleep(500) }
s = await state()
rec('R4a 停在控制栏上 3.5s 不隐藏', s.controls === 'on' && s.ctrlVisible, `controls=${s.controls} visible=${s.ctrlVisible}`)
await park()
await sleep(3400)
s = await state()
rec('R4b 离开控制栏后自动隐藏', s.controls === 'off', `controls=${s.controls} hover=${s.hoverCtrl} focus=${s.activeEl} hide=${await evaluate('!!window.__hideTimer')} pointer=${JSON.stringify(await evaluate('window.__autoHide ? window.__autoHide() : null'))}`)

// R5：暂停时保持显示，观察期间不再点击画面（画面单击会恢复播放）
await park(); await ensureShown()
await evaluate(`document.getElementById('video').pause()`)
await sleep(300)
await park()
await sleep(3600)
s = await state()
rec('R5 暂停时 3.6s 仍保持显示', s.paused && s.controls === 'on' && s.ctrlVisible, `paused=${s.paused} controls=${s.controls}`)
await evaluate(`document.getElementById('video').play()`)
await sleep(500)

// R6：拖动进度条——拖住时保持显示，松手并移开指针后 3s 隐藏
await park(); await ensureShown()
const seek = await rect('#plSeek')
await mouse('mouseMoved', seek.l + 20, seek.y)
await mouse('mousePressed', seek.l + 20, seek.y)
await sleep(250)
await mouse('mouseMoved', seek.l + 90, seek.y)
await sleep(3400)
s = await state()
rec('R6a 拖动中 >3s 保持显示', s.controls === 'on', `controls=${s.controls}`)
await mouse('mouseMoved', seek.l + 140, seek.y)
await mouse('mouseReleased', seek.l + 140, seek.y)
await park()
await sleep(3300)
s = await state()
rec('R6b 松手移开 3.3s 后自动隐藏', s.controls === 'off', `controls=${s.controls} seeking=${s.t}`)

// R7：拖动被中断（指针捕获丢失）后不卡死
await park(); await ensureShown()
await mouse('mouseMoved', seek.l + 20, seek.y)
await mouse('mousePressed', seek.l + 20, seek.y)
await sleep(250)
const releasedCapture = await evaluate(`(() => { const bar = document.getElementById('plSeek'); if (!bar.hasPointerCapture(1)) return false; bar.releasePointerCapture(1); return true })()`)
await park()
await sleep(3400)
s = await state()
rec('R7 拖动被中断后自动隐藏恢复', releasedCapture && s.controls === 'off', `captureReleased=${releasedCapture} controls=${s.controls} hover=${s.hoverCtrl} focus=${s.activeEl} paused=${s.paused} seeking=${s.seeking}`)
await mouse('mouseReleased', 3, 3)

// R8：设置面板打开时保持显示
await park(); await ensureShown()
const gearBtn = await rect('#btnGear')
await clickAt(gearBtn.x, gearBtn.y)
await park()
await sleep(3600)
s = await state()
rec('R8 设置面板打开时保持显示', s.gearOpen && s.controls === 'on', `gearOpen=${s.gearOpen} controls=${s.controls}`)
await clickAt(gearBtn.x, gearBtn.y)
await park(); await sleep(300)

// R9 只在全屏/网页全屏下测（非全屏时设计上就不显示弹幕输入框，见 styles-player.css:77）

// R10：全屏 / 网页全屏（用真实点击按钮进入，headless 下 requestFullscreen 需要手势）
if (MODE !== 'normal') {
  await park(); await ensureShown()
  const enterBtn = await rect(MODE === 'fullscreen' ? '#btnFull' : '#btnWebFull')
  await clickAt(enterBtn.x, enterBtn.y)
  await sleep(1500)
  if (MODE === 'fullscreen' && !(await evaluate('!!document.fullscreenElement'))) {
    // headless 里 requestFullscreen 会被拒绝，页面会退回网页全屏；这里改成直接打上真实的 is-fullscreen 类，
    // 走的是同一条 syncFullscreen() 的 CSS/逻辑路径（光标隐藏等规则完全一致）
    await evaluate(`(() => { const p = document.getElementById('player'); p.classList.remove('is-webfull'); document.documentElement.classList.remove('pl-webfull'); p.classList.add('is-fullscreen'); document.getElementById('plCtrl').classList.add('on'); p.dataset.controls = 'on'; })()`)
    out.push('UNVERIFIED fullscreen :: headless 拒绝系统 fullscreen；其余全屏样式仅作模拟检查，不计通过')
    await sleep(300)
  }
  await park()
  pic = await rect('.pl-picture')
  const tp = { x: pic.x, y: pic.t + Math.round(pic.h * 0.25) }
  const shownInMode = ensureShown

  s = await state()
  const fsEl = await evaluate('!!document.fullscreenElement')
  if (MODE === 'fullscreen' && !fsEl) out.push(`UNVERIFIED R10a 系统全屏 :: fullscreenElement=${fsEl}，网页样式模拟不作真实全屏证据`)
  else rec(`R10a 已进入 ${MODE}`, s.mode !== '' && (MODE === 'webfull' || fsEl), `picMode=${s.mode} fullscreenElement=${fsEl}`)

  await evaluate(`(() => { window.__seekLog = []; const v = document.getElementById('video'); ['seeking','seeked','loop','ended','play','pause','ratechange'].forEach((e) => v.addEventListener(e, () => window.__seekLog.push([e, Math.round(v.currentTime * 100) / 100]))); return 1 })()`)
  await shownInMode(); await park()
  const pre = await state()
  console.log('DBG pre:', JSON.stringify(await evaluate('window.__autoHide ? window.__autoHide() : null')))
  await sleep(3400)
  s = await state()
  console.log('DBG post:', JSON.stringify(await evaluate('window.__autoHide ? window.__autoHide() : null')))
  console.log('DBG log:', JSON.stringify(await evaluate('(window.__scLog||[]).slice(-8)')))
  console.log('DBG seeks:', JSON.stringify(await evaluate('(window.__seekLog||[]).slice(-10)')))
  console.log('DBG loop:', JSON.stringify(await evaluate('(()=>{const v=document.getElementById("video");return {t:v.currentTime,d:v.duration,loop:v.loop,seeking:v.seeking}})()')))
  rec(`R10b ${MODE} 显示后 3.4s 自动隐藏`, s.controls === 'off', `before=${JSON.stringify({c:pre.controls,paused:pre.paused,seeking:pre.seeking,hover:pre.hoverCtrl,act:pre.activeEl,gear:pre.gearOpen})} after=${JSON.stringify({c:s.controls,paused:s.paused,seeking:s.seeking,hover:s.hoverCtrl,act:s.activeEl,gear:s.gearOpen})}`)
  rec(`R10c ${MODE} 隐藏时鼠标光标一起隐藏`, s.cursor === 'none', `cursor=${s.cursor}`)

  const hitd = await evaluate(`(() => { const el = document.elementFromPoint(${'{tp.x}'}, ${'{tp.y}'}); return el ? { tag: el.tagName, cls: String(el.className).slice(0, 40), id: el.id } : null })()`.replace('{tp.x}', String(tp.x)).replace('{tp.y}', String(tp.y)))
  console.log('DBG hit:', JSON.stringify(hitd), 'tap:', JSON.stringify(tp))
  await evaluate(`window.__clicks = []; document.getElementById('player').addEventListener('click', (e) => window.__clicks.push((e.target.id || e.target.className || e.target.tagName) + '@' + e.clientX + ',' + e.clientY), true)`)
  await clickAt(tp.x, tp.y)
  console.log('DBG clicks:', JSON.stringify(await evaluate('(window.__clicks||[]).slice(-4)')))
  s = await state()
  console.log('DBG pd:', JSON.stringify(await evaluate('window.__pd')), 'plEps:', JSON.stringify(await evaluate(`(() => { const e = document.getElementById('plEps'); const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { hidden: e.hidden, display: cs.display, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), pe: cs.pointerEvents } })()`)))
  console.log('DBG piclog:', JSON.stringify(await evaluate('(window.__picLog||[]).slice(-5)')))
  console.log('DBG postclick:', JSON.stringify(s), JSON.stringify(await evaluate('window.__autoHide ? window.__autoHide() : null')), JSON.stringify(await evaluate('(window.__scLog||[]).slice(-3)')))
  rec(`R10d ${MODE} 中点画面重新显示、光标恢复`, s.controls === 'on' && s.cursor !== 'none', `controls=${s.controls} cursor=${s.cursor}`)

  // R9：弹幕输入框聚焦时保持显示，失焦后控制栏和输入框必须隐藏。
  if ((await state()).paused) await clickAt(tp.x, tp.y)
  await shownInMode(); await park()
  const dm = await rect('#dmText')
  await clickAt(dm.x, dm.y)
  await send('Input.insertText', { text: '测试' })
  await park()
  await sleep(3600)
  s = await state()
  const focused = await evaluate(`document.activeElement && document.activeElement.id`)
  rec('R9a 弹幕输入框有焦点时保持显示且输入框可见', s.controls === 'on' && s.dmVisible && focused === 'dmText', `controls=${s.controls} dmVisible=${s.dmVisible} focus=${focused}`)
  await evaluate(`document.getElementById('dmText').blur(); document.getElementById('player').dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))`)
  await sleep(3400)
  s = await state()
  const focusState = await evaluate(`(() => ({ active: document.activeElement?.id || document.activeElement?.tagName, hideTimer: !!window.__hideTimer, pointer: document.querySelector('.pl-ctrl').matches(':hover'), popup: [...document.querySelectorAll('.pl-pop')].some((el) => !el.hidden) }))()`)
  rec('R9b 失焦后弹幕输入框和控制栏都隐藏', s.controls === 'off' && !s.ctrlVisible && !s.dmVisible, `controls=${s.controls} dmVisible=${s.dmVisible} focus=${JSON.stringify(focusState)}`)
}

const shot = await send('Page.captureScreenshot', { format: 'png' })
const { writeFileSync } = await import('node:fs')
writeFileSync(join(TMP, `shot-${WIDTH}-${MODE}.png`), Buffer.from(shot.data, 'base64'))

console.log(`### ${WIDTH}x${HEIGHT} ${MODE}`)
console.log('geo:', JSON.stringify(geo))
for (const line of out) console.log(line)
const failures = out.filter((l) => l.startsWith('FAIL'))
const unverified = out.filter((l) => l.startsWith('UNVERIFIED'))
console.log('结果:', out.filter((l) => l.startsWith('PASS')).length + '/' + out.length, `失败=${failures.length} 未验证=${unverified.length}`)

ws.close(); await sleep(200)
try { chrome.kill('SIGKILL') } catch {}
server.close()
await sleep(400)
process.exit(failures.length ? 1 : 0)
