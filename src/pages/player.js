import '../styles.css'
import '../styles-player.css'
import { icon } from '../icons.js'
import { shell, bindShell, initTheme, pageHead, posterCard, showToast } from '../shell.js'
import { findShow, shows } from '../data.js'
import { u } from '../base.js'
import { proxyReady, proxyShowFresh, resolvePlay, reportPlaybackResult, fetchLines, fetchDanmaku, sendDanmaku } from '../runtime.js'
import { authReady, fetchShowProgress, flushSavedProgress, saveProgress } from '../auth.js'
import { openSettings } from '../settings-panel.js'
import { createPictureClickHandlers, didTouchMove } from '../player-gestures.js'
import { nextEpisodeAfter, rankPlayableLines, sampleStall, shouldHandlePlaybackShortcut, shouldShowNextCue } from '../player-policy.js'
import {
  FILL_MODES,
  clampRate,
  getSetting,
  onSettingChange,
  rateText,
  setSetting,
} from '../settings.js'

const id = new URLSearchParams(location.search).get('id')
const resumeParams = new URLSearchParams(location.search)
let resumeIdx = Number(resumeParams.get('ep'))
let resumeTime = Math.max(0, Number(resumeParams.get('t')) || 0)
let lastSavedSecond = -10
const KIND_CAT = { series: 'tv', short_drama: 'tv', movie: 'movie', anime: 'anime', animation: 'anime', variety: 'variety', documentary: 'variety' }
const KIND_LABEL = { series: '电视剧', short_drama: '短剧', movie: '电影', anime: '动漫', animation: '动漫', variety: '综艺', documentary: '纪录片' }

// 静态片库里没有的 id（后端新同步进来的）→ 回源到片源服务
async function loadRemoteShow(showId) {
  const s = await proxyShowFresh(showId)
  if (!s) return null
  const eps = (s.episodes || []).map((e) => ({ idx: e.idx, number: e.number, label: e.label, url: '', quality: e.quality, line: e.line }))
  return {
    id: s.id,
    title: s.title,
    originalTitle: '',
    year: s.year || '',
    cat: KIND_CAT[s.kind] || 'tv',
    kindLabel: KIND_LABEL[s.kind] || '影视',
    area: s.area || '中国大陆',
    language: s.language || '国语',
    genres: s.genres?.length ? s.genres : ['剧情'],
    actors: s.actors || [],
    directors: s.directors || [],
    badge: s.remarks || '最新上线',
    remarks: s.remarks || '',
    headline: '',
    synopsis: s.synopsis || '',
    desc: s.synopsis || '',
    poster: s.poster || '',
    backdrop: s.backdrop || '',
    heat: '',
    heatValue: s.heatValue || 0,
    playbackCount: 0,
    episodeCount: s.episodeCount || eps.length,
    availableEpisodeCount: s.availableEpisodeCount || eps.length,
    playableCount: eps.length,
    episodes: eps,
    groups: [],
    availability: { state: 'playable', label: '可播放', playable: true },
    vip: false,
    hue: 210,
  }
}

const staticShow = findShow(id)
const remoteShow = id ? await loadRemoteShow(id) : null
const show = remoteShow
  ? { ...(staticShow || {}), ...remoteShow, episodes: remoteShow.episodes }
  : staticShow
if (!show) {
  location.replace(u('/'))
  throw new Error('show not found')
}
let eps = show.episodes || []
if (await authReady) {
  const saved = await fetchShowProgress(show.id).catch(() => null)
  if (saved && Number.isInteger(Number(saved.idx))) {
    if (!resumeParams.has('ep')) resumeIdx = Number(saved.idx)
    if (!resumeParams.has('t') && Number(saved.idx) === Number(resumeIdx)) {
      resumeTime = Math.max(0, Number(saved.position) || 0)
    }
  }
}
document.title = `${show.title} - 阿噗影视`

const related = shows.filter((s) => s.id !== show.id && s.cat === show.cat).slice(0, 10)
const rest = related.length >= 6 ? related : shows.slice(6, 16)
const first = eps[0]
const startIdx = eps.find((e) => Number(e.idx) === Number(resumeIdx))?.idx ?? first?.idx ?? 0
const epLabel = (idx) => eps.find((e) => Number(e.idx) === Number(idx))?.label || `第${Number(idx) + 1}集`
const heatText = show.heat || (show.heatValue ? `热度 ${Math.round(show.heatValue / 1000)} 万` : '热播中')
const metaText = [show.kindLabel, show.year, show.area].filter(Boolean).join(' · ')
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

const ACT_BTN = (key, ico, label, extra = '') =>
  `<button class="pw-act${extra}" type="button" data-pw-act="${key}" aria-label="${label}">${icon(ico, 20)}<span>${label}</span></button>`

const body = `<section class="page-body"><div class="wrap page pw" style="--h:${show.hue}">
  <div class="pw-grid" id="pwGrid">
    <div class="pw-stage">
      <div class="pl" id="player" data-controls="on">
        <div class="pl-top">
          <span class="pl-rate" id="rateNum" aria-label="播放速度">1.00</span>
          <button class="pl-quality pl-quality-pill" id="qualityPill" type="button" aria-label="线路与清晰度">
            <span class="pl-quality-dot" aria-hidden="true"></span><span data-quality-text>1080P-官方R</span><span class="pl-quality-auto">自动</span>
          </button>
        </div>

        <div class="pl-picture">
          <video id="video" playsinline preload="metadata" poster="${show.poster || ''}"></video>
          <div class="dm-layer" id="dmLayer"></div>
          <button class="pl-bigplay" id="bigPlay" type="button" aria-label="播放">${icon('play', 30)}</button>
          <button class="pl-epov" id="epOverlay" type="button">≡▷ <span id="playerLabel">${epLabel(startIdx)}</span> ›</button>
          <p class="pl-status" id="playStatus" role="status" aria-live="polite" hidden></p>
          <div class="pl-next-cue" id="nextCue" role="status" aria-live="polite" hidden>
            <span id="nextCueText"></span>
            <button type="button" id="nextPlayNow">立即播放</button>
            <button type="button" id="nextCancel">取消</button>
          </div>
          <button class="pw-handle" id="pwHandle" type="button" aria-label="收起侧栏" title="收起侧栏">‹</button>
        </div>

        <div class="pl-ctrl" id="plCtrl">
          <div class="pl-seek" id="plSeek" role="slider" tabindex="0" aria-label="播放进度" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
            <i class="pl-buf" id="plBuf"></i>
            <i class="pl-played" id="plPlayed"></i>
          </div>
          <div class="pl-btns">
            <div class="pl-btns-l">
              <button class="plb" id="btnPlay" type="button" aria-label="播放 / 暂停">${icon('play', 20)}</button>
              <button class="plb" id="btnNext" type="button" aria-label="下一集">${icon('next', 20)}</button>
              <div class="pl-vol">
                <button class="plb" id="btnVol" type="button" aria-label="静音">${icon('volume', 20)}</button>
                <input class="pl-vol-range" id="volRange" type="range" min="0" max="1" step="0.05" value="1" aria-label="音量" />
              </div>
              <span class="pl-time" id="plTime">03:06 / 45:45</span>
            </div>
            <div class="pl-btns-m">
              <button class="dm-icon" id="btnDm" type="button" aria-label="弹幕开关" aria-pressed="true">弹</button>
              <button class="dm-icon" id="btnDmSet" type="button" aria-label="弹幕设置">弹<i>⚙</i></button>
              <div class="dm-input">
                <input id="dmText" type="text" maxlength="60" placeholder="发个友善的弹幕见证当下" autocomplete="off" aria-label="弹幕内容" />
                <button id="dmSend" type="button">发送</button>
              </div>
            </div>
            <div class="pl-btns-r">
              <button class="pl-quality pl-quality-inline" id="qualityInline" type="button" aria-label="线路与清晰度"><span data-quality-text>1080P-官方R</span></button>
              <button class="plb" id="btnGear" type="button" aria-label="播放设置">${icon('settings', 20)}</button>
              <button class="plb" id="btnPip" type="button" aria-label="画中画">${icon('pip', 20)}</button>
              <button class="plb" id="btnWebFull" type="button" aria-label="网页全屏">${icon('webfull', 20)}</button>
              <button class="plb" id="btnFull" type="button" aria-label="全屏">${icon('fullscreen', 20)}</button>
            </div>
          </div>
        </div>

        <div class="pl-pop pl-gear" id="plGear" hidden>
          <div class="pg-main">
            <button class="pg-row" type="button" data-pg-go="speed"><span>播放速度</span><em id="pgRate">1.00</em><i>›</i></button>
            <button class="pg-row" type="button" data-pg-go="fill"><span>画面填充</span><em id="pgFill">默认</em><i>›</i></button>
            <div class="pg-row"><span>画质增强</span><button class="set-sw" type="button" role="switch" data-pg-switch="enhance" aria-checked="false"><i></i></button></div>
            <div class="pg-row"><span>P2P 共享加速</span><button class="set-sw" type="button" role="switch" data-pg-switch="p2p" aria-checked="false"><i></i></button></div>
            <button class="pg-row pg-more" type="button" data-pg-more><span>更多设置</span><i>›</i></button>
          </div>
          <div class="pg-sub" data-pg-sub="speed" hidden>
            <button class="pg-back" type="button" data-pg-back>‹ 播放速度</button>
            <div class="pg-list" id="pgSpeedList"></div>
          </div>
          <div class="pg-sub" data-pg-sub="fill" hidden>
            <button class="pg-back" type="button" data-pg-back>‹ 画面填充</button>
            <div class="pg-list">
              ${FILL_MODES.map(([value, label]) => `<button class="pg-opt${getSetting('fill') === value ? ' on' : ''}" type="button" data-fill="${value}">${label}</button>`).join('')}
            </div>
          </div>
        </div>

        <div class="pl-pop pl-lines" id="plLines" hidden>
          <p class="pl-pop-title">线路 / 清晰度</p>
          <div class="pl-line-list" id="lineList"></div>
        </div>

        <div class="pl-pop pl-dmset" id="plDm" hidden>
          <p class="pl-pop-title">弹幕设置</p>
          <label class="pl-dmrow"><span>透明度</span><input type="range" data-dm-range="dmOpacity" min="0.2" max="1" step="0.1" /><b data-dm-val="dmOpacity">90%</b></label>
          <label class="pl-dmrow"><span>字号</span><input type="range" data-dm-range="dmSize" min="12" max="28" step="1" /><b data-dm-val="dmSize">18px</b></label>
          <label class="pl-dmrow"><span>速度</span><input type="range" data-dm-range="dmSpeed" min="4" max="14" step="1" /><b data-dm-val="dmSpeed">8s</b></label>
          <p class="pl-dmrow"><span>显示区域</span>
            <select class="pl-dmarea" data-dm-area aria-label="弹幕显示区域">
              <option value="25">1/4 画面</option><option value="50">1/2 画面</option><option value="75">3/4 画面</option><option value="100">全画面</option>
            </select>
          </p>
        </div>

        <div class="pl-eps" id="plEps" hidden>
          <header class="pl-eps-head">
            <span id="plEpsTitle">选集</span>
            <button class="pl-eps-x" type="button" data-pl-eps-close aria-label="关闭选集">${icon('close', 16)}</button>
          </header>
          <div class="pl-eps-grid" id="plEpsGrid"></div>
        </div>
      </div>
    </div>

    <aside class="pw-side" id="pwSide">
      <div class="pw-tabs" role="tablist">
        <button class="pw-tab on" type="button" role="tab" aria-selected="true" data-pw-tab="eps">选集</button>
        <button class="pw-tab" type="button" role="tab" aria-selected="false" data-pw-tab="cast">投屏</button>
      </div>

      <section class="pw-card">
        <div class="pw-card-bg" aria-hidden="true"${show.poster ? ` style="background-image:url('${esc(show.poster)}')"` : ''}></div>
        <div class="pw-card-in">
          <div class="pw-card-top">
            <div class="pw-card-id">
              <h1 class="pw-title">${esc(show.title)}<span class="pw-caret">›</span></h1>
              <p class="pw-meta">${esc(heatText)}<i>·</i>${esc(metaText)}</p>
            </div>
            <button class="pw-more" type="button" data-pw-more>更多推荐 ›</button>
          </div>
          <div class="pw-acts">
            ${ACT_BTN('fav', 'bookmark', '片单')}
            ${ACT_BTN('line', 'swap', '换源')}
            ${ACT_BTN('cast', 'tv', '投屏')}
            ${ACT_BTN('dl', 'download', '下载')}
            ${ACT_BTN('share', 'share', '分享')}
          </div>
          <div class="pw-crew">
            ${
              show.directors?.length
                ? `<button class="pw-crow" type="button" data-pw-row><span>导演</span><b>${esc(show.directors.join('、'))}</b></button>`
                : ''
            }
            ${
              show.actors?.length
                ? `<button class="pw-crow" type="button" data-pw-row><span>主演</span><b>${esc(show.actors.slice(0, 12).join('、'))}</b></button>`
                : ''
            }
            ${
              show.synopsis
                ? `<button class="pw-crow" type="button" data-pw-row><span>简介</span><b>${esc(show.synopsis)}</b></button>`
                : ''
            }
          </div>
        </div>
      </section>

      <div class="pw-pane" id="pwEps">
        <div class="pw-ephead">
          <span id="pwEpCount">当前：${epLabel(startIdx)}/共 ${eps.length} 集</span>
          <button class="pw-expand" type="button" data-pw-expand-eps>展开选集 ›</button>
        </div>
        <div class="pw-eplist" id="pwEpList">
          ${eps.map((e) => `<button class="ep${Number(e.idx) === Number(startIdx) ? ' on' : ''}" type="button" data-ep="${e.idx}">${e.label}</button>`).join('')}
        </div>
        <div class="pw-epgrid" id="pwEpGrid" hidden></div>
      </div>

      <div class="pw-pane" id="pwCast" hidden>
        <div class="pw-cast">
          <div class="pw-cast-ico">${icon('tv', 26)}</div>
          <p class="pw-cast-t">投屏到电视</p>
          <p class="pw-cast-s">在同一网络下打开 TV 版或手机 App，选择本片即可投到电视。</p>
          <a class="pw-cast-btn" href="${u('/download/')}">${icon('download', 15)}获取 TV / 手机 App</a>
        </div>
      </div>
    </aside>

  </div>

  <section class="row pw-related" id="pwRelated" style="margin-top:26px">
    <div class="row-head">
      <div><h2>更多推荐</h2><p class="sub">同类片库里还有这些</p></div>
    </div>
    <div class="strip">${rest.map((s) => posterCard(s)).join('')}</div>
  </section>
</div></section>`

initTheme()
document.getElementById('app').innerHTML = shell({
  body,
  active: '',
  tabActive: '首页',
  top: false,
  head: pageHead({ title: show.title, subtitle: [show.year, show.area].filter(Boolean).join(' · '), nav: '', back: u('/') }),
})
document.body.classList.add('player-page')
bindShell()

const $ = (sel) => document.querySelector(sel)
const player = document.getElementById('player')
const video = document.getElementById('video')
const label = document.getElementById('playerLabel')
const playStatus = document.getElementById('playStatus')
const dmLayer = document.getElementById('dmLayer')
const ppCtrl = document.getElementById('plCtrl')
const seekBar = document.getElementById('plSeek')
const seekBuf = document.getElementById('plBuf')
const seekPlayed = document.getElementById('plPlayed')
const btnPlay = document.getElementById('btnPlay')
const bigPlay = document.getElementById('bigPlay')
const btnNext = document.getElementById('btnNext')
const btnVol = document.getElementById('btnVol')
const volRange = document.getElementById('volRange')
const timeText = document.getElementById('plTime')
const btnDm = document.getElementById('btnDm')
const btnDmSet = document.getElementById('btnDmSet')
const btnGear = document.getElementById('btnGear')
const btnPip = document.getElementById('btnPip')
const btnWebFull = document.getElementById('btnWebFull')
const btnFull = document.getElementById('btnFull')
const rateNum = document.getElementById('rateNum')
const qualityButtons = player.querySelectorAll('.pl-quality')
const epOverlay = document.getElementById('epOverlay')
const gear = document.getElementById('plGear')
const linePop = document.getElementById('plLines')
const lineList = document.getElementById('lineList')
const dmPop = document.getElementById('plDm')
const plEps = document.getElementById('plEps')
const plEpsGrid = document.getElementById('plEpsGrid')
const plEpsTitle = document.getElementById('plEpsTitle')
const epList = document.getElementById('pwEpList')
const epGrid = document.getElementById('pwEpGrid')
const epCount = document.getElementById('pwEpCount')
const dmText = document.getElementById('dmText')

function sayPlayStatus(message) {
  if (playStatus) {
    playStatus.textContent = message
    playStatus.hidden = false
  }
  showToast(message)
}

function clearPlayStatus() {
  if (!playStatus) return
  playStatus.hidden = true
  playStatus.textContent = ''
}
const dmSend = document.getElementById('dmSend')

/* ---------------- 控制栏显隐（点画面切换，播放中 3 秒无操作隐藏） ----------------
 *
 * 规则：
 * - 播放中点画面显示控制栏；再点一次立刻隐藏；显示后 3 秒没有操作也隐藏。
 * - 暂停、拖动进度条、鼠标停在控制栏上、设置/清晰度/弹幕/选集面板打开时保持显示。
 * - 非全屏与全屏（网页全屏）同一套规则；全屏隐藏时连鼠标光标一起隐藏（见样式）。
 */

const AUTO_HIDE_MS = 3000
let hideTimer = null
let barHover = false
let dragging = false

function playing() {
  return !video.paused && !video.ended
}

function popupOpen() {
  if (gear && !gear.hidden) return true
  if (linePop && !linePop.hidden) return true
  if (dmPop && !dmPop.hidden) return true
  if (plEps && !plEps.hidden) return true
  return false
}

function canAutoHide() {
  if (!playing()) return false
  if (dragging || video.seeking) return false
  if (barHover) return false
  if (popupOpen()) return false
  // 只有正在往弹幕输入框里打字才保持显示；按钮的焦点不算「操作中」
  const active = document.activeElement
  if (active && ppCtrl && ppCtrl.contains(active) && (active.matches('input:not([type="range"]), textarea, select') || active.isContentEditable)) return false
  return true
}

function hideControls() {
  clearTimeout(hideTimer)
  hideTimer = null
  player.dataset.controls = 'off'
  ppCtrl?.classList.remove('on')
}

function scheduleHide() {
  clearTimeout(hideTimer)
  hideTimer = null
  if (!canAutoHide()) return
  hideTimer = setTimeout(() => {
    hideTimer = null
    if (canAutoHide()) hideControls()
  }, AUTO_HIDE_MS)
}

function showControls({ keep = false } = {}) {
  player.dataset.controls = 'on'
  ppCtrl?.classList.add('on')
  clearTimeout(hideTimer)
  hideTimer = null
  if (keep) return
  scheduleHide()
}

// 点画面：显示 → 隐藏；隐藏 → 显示。暂停时只负责显示，不主动隐藏。
function toggleControls() {
  if (player.dataset.controls === 'off') {
    showControls()
    return
  }
  if (!playing() || popupOpen()) {
    showControls({ keep: !playing() })
    return
  }
  hideControls()
}

// 控件上的操作算「有操作」：刷新 3 秒计时。
player.addEventListener('pointerdown', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  if (target.closest('.pl-ctrl, .pl-pop, .pl-top, .pl-eps')) showControls()
})
// 只有鼠标在控制栏 / 顶部工具条上移动才算「操作」并续时。
// 在画面上随意划过不算操作，否则控制栏永远等不到自动隐藏。
player.addEventListener('pointermove', (event) => {
  if (player.dataset.controls !== 'on') return
  if (!(event.target instanceof Element)) return
  if (event.target.closest('.pl-ctrl, .pl-top')) showControls()
})
player.addEventListener('focusin', () => showControls())
ppCtrl?.addEventListener('pointerenter', () => {
  barHover = true
  showControls()
})
ppCtrl?.addEventListener('pointerleave', () => {
  barHover = false
  showControls()
})
// 焦点离开控制栏（例如用户改去点画面）时只续一次计时，不要强行把栏显示出来，
// 否则「栏已隐藏、焦点还停在某个按钮上」时点画面会先显示再隐藏，等于点了没反应。
ppCtrl?.addEventListener('focusout', (event) => {
  if (event.relatedTarget && ppCtrl.contains(event.relatedTarget)) return
  if (player.dataset.controls === 'on') scheduleHide()
})
video.addEventListener('play', () => {
  syncPlayButton()
  showControls()
  resetStallCheck()
  scheduleStallCheck(playGeneration)
})
video.addEventListener('pause', () => {
  syncPlayButton()
  showControls({ keep: true })
})
video.addEventListener('seeking', () => resetStallCheck())
video.addEventListener('seeked', () => {
  showControls()
  if (!dragging && playing()) scheduleStallCheck(playGeneration)
})

/* ---------------- 播放 / 进度 / 时间 ---------------- */

const clock = (value) => {
  const total = Math.max(0, Math.floor(Number(value) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const two = (n) => (n < 10 ? '0' + n : String(n))
  return (h ? h + ':' + two(m) : two(m)) + ':' + two(s)
}

function syncPlayButton() {
  const on = playing()
  btnPlay.innerHTML = on ? icon('pause', 20) : icon('play', 20)
  btnPlay.setAttribute('aria-label', on ? '暂停' : '播放')
  bigPlay.classList.toggle('on', !on)
  bigPlay.setAttribute('aria-label', on ? '暂停' : '播放')
  player.classList.toggle('is-playing', on)
}

function paintProgress() {
  const d = video.duration || 0
  const t = video.currentTime || 0
  const ratio = d > 0 ? Math.min(1, Math.max(0, t / d)) : 0
  seekPlayed.style.width = (ratio * 100).toFixed(3) + '%'
  let buffered = 0
  try {
    if (video.buffered && video.buffered.length) buffered = video.buffered.end(video.buffered.length - 1)
  } catch {}
  seekBuf.style.width = d > 0 ? Math.min(100, (buffered / d) * 100).toFixed(3) + '%' : '0%'
  timeText.textContent = `${clock(t)} / ${clock(d)}`
  seekBar.setAttribute('aria-valuemax', String(Math.round(d)))
  seekBar.setAttribute('aria-valuenow', String(Math.round(t)))
}

function seekTo(clientX) {
  const rect = seekBar.getBoundingClientRect()
  if (!rect.width || !video.duration) return
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  video.currentTime = ratio * video.duration
  paintProgress()
}

seekBar.addEventListener('pointerdown', (event) => {
  dragging = true
  resetStallCheck()
  player.classList.add('seeking')
  seekBar.setPointerCapture?.(event.pointerId)
  seekTo(event.clientX)
  showControls({ keep: true })
})
seekBar.addEventListener('pointermove', (event) => {
  if (!dragging) return
  seekTo(event.clientX)
})
const endSeek = (event) => {
  if (!dragging) return
  dragging = false
  player.classList.remove('seeking')
  // 只有正常抬手才按松手位置定位；pointercancel / 捕获被抢走时不要再动进度
  if (event?.type === 'pointerup' && typeof event.clientX === 'number') seekTo(event.clientX)
  showControls()
  if (!video.seeking && playing()) scheduleStallCheck(playGeneration)
}
seekBar.addEventListener('pointerup', endSeek)
seekBar.addEventListener('pointercancel', endSeek)
// 指针捕获被系统或其他元素抢走时同样要收尾，否则 dragging 会一直为 true，控制栏就再也不会自动隐藏
seekBar.addEventListener('lostpointercapture', endSeek)
window.addEventListener('blur', () => {
  if (dragging) endSeek()
})
seekBar.addEventListener('keydown', (event) => {
  if (!Number.isFinite(video.duration) || video.duration <= 0) return
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
  event.preventDefault()
  video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + (event.key === 'ArrowRight' ? 5 : -5)))
  showControls()
})

function togglePlay() {
  if (video.paused || video.ended) {
    playbackWanted = true
    startPlayback()
  } else {
    playbackWanted = false
    playRequest?.abort()
    video.pause()
  }
  showControls({ keep: video.paused })
}

btnPlay.addEventListener('click', togglePlay)
bigPlay.addEventListener('click', togglePlay)
// Defer the single-click action so a double-click only changes fullscreen.
const picture = player.querySelector('.pl-picture')
const pictureClick = createPictureClickHandlers({ singleClick: togglePlay, doubleClick: toggleFullscreen })
let picturePointer = null
let suppressPictureClick = false
picture.addEventListener('pointerdown', (event) => {
  if (event.pointerType !== 'touch') return
  picturePointer = { x: event.clientX, y: event.clientY, moved: false }
})
picture.addEventListener('pointermove', (event) => {
  if (!picturePointer || event.pointerType !== 'touch') return
  if (didTouchMove(picturePointer, { x: event.clientX, y: event.clientY })) picturePointer.moved = true
})
picture.addEventListener('pointerup', () => {
  if (picturePointer?.moved) {
    pictureClick.cancel()
    suppressPictureClick = true
    setTimeout(() => { suppressPictureClick = false }, 350)
  }
  picturePointer = null
})
picture.addEventListener('pointercancel', () => { picturePointer = null; pictureClick.cancel() })

function isPictureChrome(target) {
  if (!(target instanceof Element)) return true
  return !!target.closest('button, a, input, textarea, select, .dm-input')
}

picture.addEventListener('click', (event) => {
  if (isPictureChrome(event.target)) return
  if (suppressPictureClick) {
    suppressPictureClick = false
    return
  }
  pictureClick.click()
})
picture.addEventListener('dblclick', (event) => {
  if (isPictureChrome(event.target)) return
  pictureClick.doubleClick()
})

btnVol.addEventListener('click', () => {
  const muted = video.muted || video.volume === 0
  video.muted = !muted
  if (muted && video.volume === 0) video.volume = 1
  volRange.value = String(muted ? 1 : video.volume)
  syncVolumeIcon()
})
volRange.addEventListener('input', () => {
  video.volume = Number(volRange.value)
  video.muted = video.volume === 0
  syncVolumeIcon()
})
function syncVolumeIcon() {
  const muted = video.muted || video.volume === 0
  btnVol.innerHTML = icon(muted ? 'volumeMute' : 'volume', 20)
  btnVol.setAttribute('aria-label', muted ? '取消静音' : '静音')
}

video.addEventListener('volumechange', () => {
  if (!video.muted && video.volume > 0) volRange.value = String(video.volume)
  syncVolumeIcon()
})

/* ---------------- 倍速：数字 + « − + » ---------------- */

let rate = clampRate(getSetting('speed'))

function applyRateUI() {
  const text = rateText(rate)
  rateNum.textContent = text
  const pgRate = document.getElementById('pgRate')
  if (pgRate) pgRate.textContent = text
  document.querySelectorAll('#pgSpeedList [data-speed]').forEach((button) => {
    button.classList.toggle('on', Math.abs(Number(button.dataset.speed) - rate) < 0.001)
  })
}

function applyRate() {
  try {
    video.playbackRate = rate
    // iOS 等平台会把 >2x 钳制到 2x，界面按真实值回显
    const real = video.playbackRate
    if (real && Math.abs(real - rate) > 0.01) {
      rate = clampRate(real)
      setSetting('speed', rate)
    }
  } catch {}
  applyRateUI()
}

function setRate(value, { persist = true } = {}) {
  const next = clampRate(value)
  if (next === rate) return
  rate = next
  if (persist) setSetting('speed', rate)
  applyRate()
  showToast(`播放速度 ${rateText(rate)}×`)
}

/* ---------------- 画质增强 / 画面填充 ---------------- */

function applyHQ() {
  const on = getSetting('enhance')
  video.style.filter = on ? 'contrast(1.06) saturate(1.08) brightness(1.02)' : ''
  document.querySelectorAll('[data-pg-switch="enhance"]').forEach((button) => {
    button.classList.toggle('on', on)
    button.setAttribute('aria-checked', String(on))
  })
}

function applyFill() {
  const value = getSetting('fill')
  video.classList.toggle('is-stretched', value === 'fill')
  const label = (FILL_MODES.find(([mode]) => mode === value) || FILL_MODES[0])[1]
  const pgFill = document.getElementById('pgFill')
  if (pgFill) pgFill.textContent = label
  document.querySelectorAll('[data-fill]').forEach((button) => button.classList.toggle('on', button.dataset.fill === value))
}

document.addEventListener('click', (event) => {
  const fill = event.target.closest('[data-fill]')
  if (!fill) return
  setSetting('fill', fill.dataset.fill)
  applyFill()
})

/* ---------------- 弹幕 ---------------- */

let dmOn = getSetting('danmaku')
let dmList = []
let dmCursor = 0
let lastT = 0
let dmLane = 0

function applyDm() {
  dmOn = getSetting('danmaku')
  btnDm.textContent = '弹'
  btnDm.classList.toggle('off', !dmOn)
  btnDm.setAttribute('aria-pressed', String(dmOn))
  if (!dmOn) dmLayer.innerHTML = ''
}

function applyDmStyle() {
  const opacity = getSetting('dmOpacity')
  const size = getSetting('dmSize')
  const speed = getSetting('dmSpeed')
  dmLayer.style.setProperty('--dm-opacity', String(opacity))
  dmLayer.style.setProperty('--dm-size', size + 'px')
  dmLayer.style.setProperty('--dur', speed + 's')
  dmLayer.style.height = getSetting('dmArea') + '%'
  dmLayer.style.bottom = 'auto'
  document.querySelectorAll('[data-dm-range]').forEach((input) => {
    const key = input.dataset.dmRange
    input.value = String(getSetting(key))
    const out = document.querySelector(`[data-dm-val="${key}"]`)
    if (out) out.textContent = key === 'dmOpacity' ? Math.round(getSetting(key) * 100) + '%' : key === 'dmSize' ? getSetting(key) + 'px' : getSetting(key) + 's'
  })
  const area = document.querySelector('[data-dm-area]')
  if (area) area.value = String(getSetting('dmArea'))
}

function spawnDm(d) {
  const el = document.createElement('span')
  el.className = 'dm-item'
  el.textContent = d.text
  if (d.color) el.style.color = d.color
  dmLane = (dmLane + 1) % 7
  el.style.top = 6 + dmLane * 11 + '%'
  el.style.setProperty('--dur', getSetting('dmSpeed') + Math.min(6, d.text.length * 0.12) + 's')
  dmLayer.appendChild(el)
  setTimeout(() => el.remove(), 16000)
}

function pumpDm() {
  if (!dmOn) return
  const t = video.currentTime || 0
  if (t < lastT - 1) {
    dmCursor = 0
    dmLayer.innerHTML = ''
  }
  lastT = t
  while (dmCursor < dmList.length) {
    const d = dmList[dmCursor]
    if (d.t > t) break
    if (d.t > t - 2) spawnDm(d)
    dmCursor++
  }
}

async function loadDm(epIdx, generation) {
  dmList = []
  dmCursor = 0
  lastT = 0
  dmLayer.innerHTML = ''
  const j = await fetchDanmaku(show.id, epIdx).catch(() => null)
  if (generation === playGeneration && j?.items?.length) {
    dmList = j.items.map((x) => ({ t: Number(x.t) || 0, text: String(x.text || ''), color: x.color || '' })).filter((x) => x.text)
  }
}

async function sendDm() {
  const text = dmText.value.trim()
  if (!text) return
  const t = video.currentTime || 0
  const ok = await sendDanmaku(show.id, currentEpIdx(), t, text)
  if (!ok) {
    return
  }
  dmText.value = ''
  if (dmOn) {
    dmList.push({ t, text, color: '' })
    dmList.sort((a, b) => a.t - b.t)
    dmCursor = dmList.findIndex((x) => x.t >= lastT)
    if (dmCursor < 0) dmCursor = dmList.length
    spawnDm({ t, text })
  }
}

btnDm.addEventListener('click', () => {
  setSetting('danmaku', !dmOn)
})
dmSend?.addEventListener('click', (event) => {
  event.preventDefault()
  void sendDm()
})
dmText?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    void sendDm()
  }
})
document.querySelectorAll('[data-dm-range]').forEach((input) => {
  input.addEventListener('input', () => setSetting(input.dataset.dmRange, Number(input.value)))
})
document.querySelector('[data-dm-area]')?.addEventListener('change', (event) => {
  setSetting('dmArea', Number(event.target.value))
})

/* ---------------- 弹出层通用开关 ---------------- */

const POPS = [gear, linePop, dmPop]
function closePops(except = null) {
  for (const pop of POPS) {
    if (!pop || pop === except) continue
    pop.hidden = true
  }
}
function togglePop(pop) {
  if (!pop) return
  const willOpen = pop.hidden
  closePops(pop)
  pop.hidden = !willOpen
  if (willOpen) showControls({ keep: true })
  else showControls()
}

btnGear.addEventListener('click', () => {
  togglePop(gear)
  syncGear()
})
qualityButtons.forEach((button) => {
  button.addEventListener('click', () => {
    togglePop(linePop)
    renderLineList()
  })
})
btnDmSet.addEventListener('click', () => {
  togglePop(dmPop)
  applyDmStyle()
})
document.addEventListener('pointerdown', (event) => {
  if (!POPS.some((pop) => pop && !pop.hidden)) return
  if (event.target.closest('.pl-pop, #btnGear, .pl-quality, #btnDmSet')) return
  closePops()
})

/* ---------------- 齿轮浮层 ---------------- */

function syncGear() {
  applyRateUI()
  applyFill()
  applyHQ()
  document.querySelectorAll('[data-pg-switch]').forEach((button) => {
    const key = button.dataset.pgSwitch
    const on = !!getSetting(key)
    button.classList.toggle('on', on)
    button.setAttribute('aria-checked', String(on))
  })
}

gear.addEventListener('click', (event) => {
  const go = event.target.closest('[data-pg-go]')
  if (go) {
    gear.querySelector('.pg-main').hidden = true
    const sub = gear.querySelector(`[data-pg-sub="${go.dataset.pgGo}"]`)
    if (sub) sub.hidden = false
    if (go.dataset.pgGo === 'speed') renderSpeedList()
    return
  }
  const back = event.target.closest('[data-pg-back]')
  if (back) {
    gear.querySelectorAll('.pg-sub').forEach((sub) => (sub.hidden = true))
    gear.querySelector('.pg-main').hidden = false
    return
  }
  const sw = event.target.closest('[data-pg-switch]')
  if (sw) {
    const key = sw.dataset.pgSwitch
    setSetting(key, !getSetting(key))
    syncGear()
    return
  }
  if (event.target.closest('[data-pg-more]')) {
    closePops()
    openSettings()
    return
  }
  const speed = event.target.closest('[data-speed]')
  if (speed) {
    setRate(Number(speed.dataset.speed))
    gear.querySelectorAll('.pg-sub').forEach((sub) => (sub.hidden = true))
    gear.querySelector('.pg-main').hidden = false
  }
})

function renderSpeedList() {
  const list = document.getElementById('pgSpeedList')
  if (!list) return
  const values = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]
  if (!values.includes(rate)) values.push(rate)
  values.sort((a, b) => a - b)
  list.innerHTML = values
    .map(
      (value) =>
        `<button class="pg-opt${Math.abs(value - rate) < 0.001 ? ' on' : ''}" type="button" data-speed="${value}">${value.toFixed(2)}×</button>`
    )
    .join('')
}

/* ---------------- 线路 / 清晰度 ---------------- */

let linesByEp = new Map()
let currentProvider = ''
let lastSuccessfulProvider = ''
const STATUS_TIP = { dup: '该线路串集，已停用', dead: '线路不可用', empty: '线路为空', member: '需要会员或更高等级', unknown: '', ok: '' }

function lineOptions(epIdx) {
  return linesByEp.get(Number(epIdx))?.options || []
}

function mergeLineOptions(epIdx, incoming) {
  const old = linesByEp.get(Number(epIdx)) || {}
  const options = new Map((old.options || []).map((option) => [option.provider, option]))
  for (const option of incoming || []) {
    const previous = options.get(option.provider)
    if (previous && option.status === 'unknown' && previous.status !== 'unknown') continue
    options.set(option.provider, { ...previous, ...option })
  }
  linesByEp.set(Number(epIdx), { ...old, options: [...options.values()] })
}

function updateQuality() {
  const options = lineOptions(currentEpIdx())
  const hit = options.find((option) => option.provider === currentProvider) || options[0]
  qualityButtons.forEach((button) => {
    const resolution = Number(hit?.quality || actualQuality) > 0 ? `${Number(hit?.quality || actualQuality)}P` : '清晰度未知'
    button.querySelector('[data-quality-text]').textContent = hit ? `${resolution} · ${hit.label}` : '清晰度未知'
    button.title = hit ? `${resolution} · ${hit.label}` : ''
  })
}

function renderLineList() {
  const options = lineOptions(currentEpIdx())
  if (!options.length) {
    lineList.innerHTML = '<p class="pl-line-empty">这一集暂时没有可选线路</p>'
    return
  }
  const groups = { official: [], normal: [] }
  for (const o of options) (groups[o.group] || groups.normal).push(o)
  const row = (o) =>
    `<button class="pl-line${o.provider === currentProvider ? ' on' : ''}" type="button" data-line="${esc(o.provider)}"${
      o.status === 'dup' || o.status === 'dead' ? ' disabled' : ''
    }><span>${esc(o.label)}</span>${o.status && o.status !== 'ok' ? `<em>${esc(STATUS_TIP[o.status] || '')}</em>` : ''}</button>`
  lineList.innerHTML = `
    ${groups.official.length ? `<p class="pl-line-group">官方线路</p>${groups.official.map(row).join('')}` : ''}
    ${groups.normal.length ? `<p class="pl-line-group">普通线路</p>${groups.normal.map(row).join('')}` : ''}`
}

document.addEventListener('click', (event) => {
  const line = event.target.closest('[data-line]')
  if (!line) return
  play(currentEpIdx(), true, line.dataset.line)
  closePops()
})

/* ---------------- 选集：侧栏一行 + 展开网格 + 播放器内抽屉 ---------------- */

let epExpanded = false

function paintEpSelection(activeIdx) {
  const idx = Number(activeIdx)
  document.querySelectorAll('.ep').forEach((button) => button.classList.toggle('on', Number(button.dataset.ep) === idx))
  const found = eps.find((e) => Number(e.idx) === idx)
  label.textContent = found ? found.label : epLabel(idx)
  epCount.textContent = `当前：${found ? found.label : epLabel(idx)}/共 ${eps.length} 集`
  plEpsTitle.textContent = `选集 · 共 ${eps.length} 集`
  const active = epList.querySelector('.ep.on')
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'center' })
}

function buildEpGrid() {
  epGrid.innerHTML = eps.map((e) => `<button class="ep${Number(e.idx) === currentEpIdx() ? ' on' : ''}" type="button" data-ep="${e.idx}">${e.label}</button>`).join('')
}

plEpsGrid.innerHTML = eps.map((e) => `<button class="ep${Number(e.idx) === Number(startIdx) ? ' on' : ''}" type="button" data-ep="${e.idx}">${e.label}</button>`).join('')

document.addEventListener('click', (event) => {
  if (event.target.closest('[data-pl-eps-close]')) {
    plEps.hidden = true
    showControls()
    return
  }
  if (event.target.closest('[data-pw-expand-eps]')) {
    epExpanded = !epExpanded
    const button = document.querySelector('[data-pw-expand-eps]')
    if (epExpanded) buildEpGrid()
    epList.hidden = epExpanded
    epGrid.hidden = !epExpanded
    if (button) button.textContent = epExpanded ? '收起选集 ‹' : '展开选集 ›'
    return
  }
  const epBtn = event.target.closest('[data-ep]')
  if (epBtn) {
    plEps.hidden = true
    void play(Number(epBtn.dataset.ep))
  }
})

epOverlay.addEventListener('click', () => {
  plEps.hidden = !plEps.hidden
  if (!plEps.hidden) {
    const active = plEpsGrid.querySelector('.ep.on')
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'center' })
    showControls({ keep: true })
  }
})

/* ---------------- 侧栏 Tab / 收起把手 / 信息卡 ---------------- */

document.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-pw-tab]')
  if (tab) {
    document.querySelectorAll('[data-pw-tab]').forEach((button) => {
      const on = button === tab
      button.classList.toggle('on', on)
      button.setAttribute('aria-selected', String(on))
    })
    const eps1 = document.getElementById('pwEps')
    const cast = document.getElementById('pwCast')
    if (eps1) eps1.hidden = tab.dataset.pwTab !== 'eps'
    if (cast) cast.hidden = tab.dataset.pwTab !== 'cast'
    return
  }

  const row = event.target.closest('[data-pw-row]')
  if (row) {
    row.classList.toggle('open')
    return
  }

  if (event.target.closest('[data-pw-more]')) {
    document.getElementById('pwRelated')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }

  const act = event.target.closest('[data-pw-act]')
  if (act) {
    const key = act.dataset.pwAct
    if (key === 'fav') {
      try {
        const list = JSON.parse(localStorage.getItem('kj-fav') || '[]')
        const next = [...new Set([show.id, ...list])]
        localStorage.setItem('kj-fav', JSON.stringify(next))
      } catch {}
      showToast(`已把《${show.title}》加入片单`)
    }
    if (key === 'line') {
      togglePop(linePop)
      renderLineList()
    }
    if (key === 'cast') {
      document.querySelector('[data-pw-tab="cast"]')?.click()
      document.getElementById('pwSide')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
    if (key === 'dl') {
      const bridge = window.webkit?.messageHandlers?.iosPlayer
      if (bridge) bridge.postMessage({ action: 'download', url: mediaUrl(), name: downloadName() })
      else window.location.href = u('/download/')
    }
    if (key === 'share') {
      const url = location.href
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(() => showToast('链接已复制，去分享给朋友吧'), () => showToast('复制失败'))
      else showToast('链接已复制，去分享给朋友吧')
      try {
        window.webkit?.messageHandlers?.iosPlayer?.postMessage({ action: 'share', url, title: document.title })
      } catch {}
    }
  }
})

const pwGrid = document.getElementById('pwGrid')
const pwHandle = document.getElementById('pwHandle')
pwHandle?.addEventListener('click', () => {
  const collapsed = pwGrid.classList.toggle('collapsed')
  pwHandle.textContent = collapsed ? '›' : '‹'
  pwHandle.setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏')
  pwHandle.title = collapsed ? '展开侧栏' : '收起侧栏'
  try {
    localStorage.setItem('kj-pw-collapsed', collapsed ? '1' : '0')
  } catch {}
})
try {
  if (localStorage.getItem('kj-pw-collapsed') === '1') {
    pwGrid.classList.add('collapsed')
    if (pwHandle) {
      pwHandle.textContent = '›'
      pwHandle.setAttribute('aria-label', '展开侧栏')
      pwHandle.title = '展开侧栏'
    }
  }
} catch {}

/* ---------------- 全屏 / 画中画 ---------------- */

let webFull = false
function setWebFull(on) {
  webFull = on
  document.documentElement.classList.toggle('pl-webfull', on)
  player.classList.toggle('is-webfull', on)
  btnWebFull.setAttribute('aria-label', on ? '退出网页全屏' : '网页全屏')
  showControls()
}
btnWebFull?.addEventListener('click', () => setWebFull(!webFull))

function toggleFullscreen() {
  const doc = document
  if (doc.fullscreenElement || doc.webkitFullscreenElement) {
    ;(doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc)
    return
  }
  const el = player
  const fn = el.requestFullscreen || el.webkitRequestFullscreen
  if (fn) {
    Promise.resolve(fn.call(el)).catch(() => {
      // iOS Safari 没有元素级全屏，退回网页全屏
      setWebFull(true)
    })
  } else setWebFull(true)
}
btnFull?.addEventListener('click', () => {
  toggleFullscreen()
  try {
    window.webkit?.messageHandlers?.iosPlayer?.postMessage({ action: 'fullscreen' })
  } catch {}
})
function syncFullscreen() {
  const isFullscreen = (document.fullscreenElement || document.webkitFullscreenElement) === player
  player.classList.toggle('is-fullscreen', isFullscreen)
  showControls()
}
document.addEventListener('fullscreenchange', syncFullscreen)
document.addEventListener('webkitfullscreenchange', syncFullscreen)

btnPip?.addEventListener('click', async () => {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture()
    else if (document.pictureInPictureEnabled && video.requestPictureInPicture) await video.requestPictureInPicture()
    else showToast('当前浏览器不支持画中画')
  } catch {
    showToast('暂时无法开启画中画')
  }
})

/* ---------------- 设置联动（设置面板 ↔ 播放器共用一份值） ---------------- */

onSettingChange((key) => {
  if (key === 'speed') {
    rate = clampRate(getSetting('speed'))
    applyRate()
  }
  if (key === 'enhance') applyHQ()
  if (key === 'fill') applyFill()
  if (key === 'danmaku') applyDm()
  if (key === 'dmOpacity' || key === 'dmSize' || key === 'dmSpeed' || key === 'dmArea') applyDmStyle()
  if (key === 'p2p') syncGear()
})

/* ---------------- 播放器：mp4 直连；m3u8 用原生或按需加载 hls.js ---------------- */

let hls = null
let hlsLoading = null

function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls)
  if (!hlsLoading) {
    hlsLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js'
      s.onload = () => resolve(window.Hls)
      s.onerror = reject
      document.head.appendChild(s)
    })
  }
  return hlsLoading
}

const isHlsUrl = (value) => /\.m3u8(\?|$)/i.test(String(value || ''))

function attach(url, kind = '', onFatal = () => {}, onAttached = () => {}) {
  const attempt = ++playbackAttemptId
  if (hls) {
    hls.destroy()
    hls = null
  }
  video.removeAttribute('src')
  video.load()
  if (!url) return
  const useNativeHls = (kind === 'hls' || isHlsUrl(url)) && !!video.canPlayType('application/vnd.apple.mpegurl')
  if (!useNativeHls && (kind === 'hls' || isHlsUrl(url)) && typeof window.MediaSource !== 'undefined') {
    loadHls()
      .then((Hls) => {
        if (attempt !== playbackAttemptId) return
        if (!Hls?.isSupported()) throw new Error('HLS unsupported')
        hls = new Hls({ maxBufferLength: 30 })
        hls.on(Hls.Events.ERROR, (_e, data) => { if (attempt === playbackAttemptId && data?.fatal) onFatal() })
        hls.on(Hls.Events.MEDIA_ATTACHED, () => { if (attempt === playbackAttemptId) onAttached() })
        hls.loadSource(url)
        hls.attachMedia(video)
      })
      .catch(() => { if (attempt === playbackAttemptId) onFatal() })
    return
  }
  video.src = url
  video.load()
  applyRate()
  onAttached()
}

/* ---------------- 线路数据 ---------------- */

async function ensureLines(epIdx) {
  if (linesByEp.has(Number(epIdx))) return
  await proxyReady
  if (linesByEp.has(Number(epIdx))) return
  const j = await fetchLines(show.id, epIdx).catch(() => null)
  if (j) mergeLineOptions(epIdx, j.options)
}

function currentEpIdx() {
  return Number(document.querySelector('.ep.on')?.dataset.ep ?? eps[0]?.idx ?? 0)
}

function mediaUrl() {
  const direct = video.currentSrc || video.src || ''
  if (direct) return direct
  const ep = eps.find((e) => Number(e.idx) === currentEpIdx())
  return ep?.url || ''
}

function downloadName() {
  const url = mediaUrl()
  const match = /\.(mp4|m4v|mov|mkv|ts)(?:[?#]|$)/i.exec(url || '')
  const ext = match ? `.${match[1].toLowerCase()}` : '.mp4'
  const name = epLabel(currentEpIdx()).replace(/\s+/g, '')
  return `阿噗影视_${name}${ext}`
}

/* ---------------- 播放主流程 ---------------- */

let skipInfo = null
let skipDone = { intro: false, outro: false }
let playGeneration = 0
let playbackAttemptId = 0
let playRequest = null
let pending = false
let playbackWanted = false
let switchingAutomatically = false
let switchingGeneration = null
let activeEpisode = null
let mediaStarted = false
let cancelMediaWait = null
let actualQuality = 0
let stallState = null
let stallTimer = null
let nextTarget = null
let nextCancelledFor = null
const failedProviders = new Set()
const MAX_AUTO_ALTERNATIVES = 4
const nextCue = document.getElementById('nextCue')
const nextCueText = document.getElementById('nextCueText')

function clearNextCue() {
  nextTarget = null
  if (nextCue) nextCue.hidden = true
}

function scheduleNextEpisode() {
  const current = currentEpIdx()
  const next = !pending && mediaStarted && activeEpisode === current && show.cat !== 'movie' && nextEpisodeAfter(eps, current)
  if (!next || !shouldShowNextCue({ duration: video.duration, currentTime: video.currentTime, current, cancelled: nextCancelledFor })) {
    clearNextCue()
    return
  }
  if (nextTarget !== Number(next.idx)) {
    clearNextCue()
    nextTarget = Number(next.idx)
    nextCueText.textContent = `即将播放${next.label || epLabel(next.idx)}`
    nextCue.hidden = false
  }
}

document.getElementById('nextPlayNow')?.addEventListener('click', () => {
  const current = currentEpIdx()
  const target = nextTarget
  clearNextCue()
  if (target != null && current === activeEpisode && nextCancelledFor !== current) {
    nextCancelledFor = current
    void play(target, true, '', { fromEpisode: current })
  }
})
document.getElementById('nextCancel')?.addEventListener('click', () => {
  nextCancelledFor = currentEpIdx()
  clearNextCue()
})

function resetStallCheck() {
  stallState = null
  clearTimeout(stallTimer)
  stallTimer = null
}

function scheduleStallCheck(generation) {
  clearTimeout(stallTimer)
  stallTimer = setTimeout(() => {
    const suspended = generation !== playGeneration || pending || video.paused || document.visibilityState === 'hidden' || video.seeking || dragging || document.pictureInPictureElement
    stallState = sampleStall(stallState, { now: Date.now(), position: video.currentTime || 0, suspended })
    if (stallState?.expired) void switchToNextLine(generation)
    else if (!suspended) scheduleStallCheck(generation)
  }, 1_000)
}

async function switchToNextLine(generation = playGeneration) {
  if (generation !== playGeneration || switchingAutomatically || !playbackWanted ||
      document.visibilityState === 'hidden' || video.seeking || dragging || document.pictureInPictureElement) return
  pending = false
  failedProviders.add(currentProvider)
  const candidates = lineOptions(currentEpIdx()).filter((option) => option.provider && option.provider !== currentProvider && !failedProviders.has(option.provider) && option.status !== 'dead' && option.status !== 'dup' && option.status !== 'member')
  if (!candidates.length) {
    sayPlayStatus('当前集的其他线路也不可用，请手动选择线路。')
    return
  }
  switchingAutomatically = true
  switchingGeneration = generation
  const oldTime = video.currentTime || 0
  const wasPlaying = playbackWanted
  const epIdx = currentEpIdx()
  const ordered = rankPlayableLines(candidates, { preferred: lastSuccessfulProvider, targetQuality: actualQuality || 1080 })
  try {
    for (const candidate of ordered.slice(0, MAX_AUTO_ALTERNATIVES)) {
      if (generation !== playGeneration || !playbackWanted) return
      const controller = new AbortController()
      playRequest = controller
      const result = await resolvePlay(show.id, currentEpIdx(), candidate.provider, { quality: actualQuality, signal: controller.signal }).catch(() => null)
      if (playRequest === controller) playRequest = null
      if (generation !== playGeneration || !playbackWanted) return
      if (!result?.url || result.error) {
        failedProviders.add(candidate.provider)
        continue
      }
      currentProvider = result.provider || candidate.provider
      const switched = await new Promise((resolve) => {
        let metadataReady = false
        let started = false
        let settled = false
        const onMetadata = () => {
          if (generation !== playGeneration) return finish(false)
          metadataReady = true
          video.currentTime = Math.min(oldTime, Math.max(0, (video.duration || oldTime + 1) - 1))
          applyRate()
          if (wasPlaying) startPlayback()
          else finish(true)
        }
        const onPlaying = () => { started = true; finish(true) }
        const finish = (ok) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          video.removeEventListener('playing', onPlaying)
          video.removeEventListener('error', onError)
          video.removeEventListener('loadedmetadata', onMetadata)
          resolve(ok && (started || !wasPlaying && metadataReady))
        }
        const onError = () => finish(false)
        const timeout = setTimeout(() => finish(false), 8_000)
        video.addEventListener('playing', onPlaying, { once: true })
        video.addEventListener('error', onError, { once: true })
        video.addEventListener('loadedmetadata', onMetadata, { once: true })
        currentProvider = result.provider || candidate.provider
        attach(result.url, result.kind, () => finish(false), () => {
          if (generation !== playGeneration) return finish(false)
          if (video.readyState >= 1) onMetadata()
        })
      })
      if (generation !== playGeneration) return
      if (!switched) {
        failedProviders.add(candidate.provider)
        void reportPlaybackResult(show.id, candidate.provider, false)
        continue
      }
      mediaStarted = true
      void reportPlaybackResult(show.id, currentProvider, true)
      lastSuccessfulProvider = currentProvider
      actualQuality = Number(result.quality || 0)
      try { localStorage.setItem(`kj-line:${show.id}`, currentProvider) } catch {}
      updateQuality()
      renderLineList()
      mergeLineOptions(epIdx, result.options)
      skipInfo = result.skip || skipInfo
      resetStallCheck()
      if (wasPlaying) startPlayback()
      sayPlayStatus(`已自动切换到 ${candidate.label} 线路`)
      return
    }
    sayPlayStatus('当前集所有可用线路均播放失败，请手动选择线路。')
  } finally {
    if (switchingGeneration === generation) {
      switchingAutomatically = false
      switchingGeneration = null
      resetStallCheck()
      if (playing()) scheduleStallCheck(generation)
    }
  }
}

async function play(idx, autoplay = true, requestedLine = '', { fromEpisode = null, preferred = '' } = {}) {
  const ep = eps.find((e) => Number(e.idx) === Number(idx)) || eps[0]
  if (!ep) return
  const sameEpisode = Number(ep.idx) === activeEpisode
  const resumeAt = sameEpisode ? video.currentTime : Number(ep.idx) === Number(resumeIdx) ? resumeTime : 0
  if (video.currentTime > 0 && mediaStarted && activeEpisode != null) {
    void saveProgress({ showId: show.id, idx: activeEpisode, position: video.currentTime, duration: video.duration || null }, { force: true })
  }
  const generation = ++playGeneration
  playRequest?.abort()
  cancelMediaWait?.()
  playRequest = new AbortController()
  const requestSignal = playRequest.signal
  pending = true
  playbackWanted = autoplay
  switchingAutomatically = false
  switchingGeneration = null
  attach('')
  playbackWanted = autoplay
  activeEpisode = null
  mediaStarted = false
  lastSavedSecond = -10
  if (!sameEpisode) nextCancelledFor = null
  resetStallCheck()
  failedProviders.clear()
  clearNextCue()
  if (!requestedLine) preferred = preferred || lastSuccessfulProvider
  skipDone = { intro: false, outro: false }
  clearPlayStatus()
  paintEpSelection(ep.idx)
  if (!requestedLine && !preferred) {
    try { preferred = localStorage.getItem(`kj-line:${show.id}`) || '' } catch {}
  }
  await proxyReady
  if (generation !== playGeneration) return
  const fresh = await resolvePlay(show.id, ep.idx, requestedLine, {
    quality: fromEpisode == null && !sameEpisode ? 1080 : actualQuality || 1080,
    preferred,
    signal: requestSignal,
  }).catch(() => null)
  if (generation !== playGeneration) return
  if (playRequest?.signal === requestSignal) playRequest = null
  if (!fresh?.options?.length) void ensureLines(ep.idx).then(() => {
    if (generation === playGeneration) renderLineList()
  })
  if (!fresh) {
    pending = false
    if (playRequest?.signal === requestSignal) playRequest = null
    resetStallCheck()
    if (generation === playGeneration) sayPlayStatus('本集没有通过真实首片验证的可用线路，请稍后重试。')
    return
  }
  if (fresh?.error === 'login_required') {
    pending = false
    if (playRequest?.signal === requestSignal) playRequest = null
    sayPlayStatus('这一集在原站是会员片源，匿名拿不到地址。换一部标着「可播放」的片子就能直接看。')
    return
  }
  const url = fresh.url
  if (fresh?.error) {
    pending = false
    if (playRequest?.signal === requestSignal) playRequest = null
    sayPlayStatus('这一集的片源暂时取不到（线路维护或需要会员），换一集或换一部试试。')
    return
  }
  if (!url) {
    pending = false
    if (playRequest?.signal === requestSignal) playRequest = null
    sayPlayStatus('这一集暂时取不到片源（可能是会员片源或线路维护），换一集或换一部试试。')
    return
  }
  activeEpisode = Number(ep.idx)
  if (fresh?.provider) currentProvider = fresh.provider
  actualQuality = Number(fresh.quality || 0)
  mergeLineOptions(ep.idx, fresh.options)
  updateQuality()
  renderLineList()
  clearPlayStatus()
  const sourceAttempt = playbackAttemptId + 1
  attach(url, fresh.kind, () => {
    if (generation === playGeneration) {
      failedProviders.add(currentProvider)
      void switchToNextLine(generation)
    }
  }, () => {
    if (generation !== playGeneration) return
    pending = false
    if (autoplay) startPlayback()
    else resetStallCheck()
  })
  const markPlaybackFailure = () => {
    if (generation !== playGeneration || sourceAttempt !== playbackAttemptId || mediaStarted) return
    void reportPlaybackResult(show.id, currentProvider, false)
  }
  const startFailureTimer = setTimeout(markPlaybackFailure, 12_000)
  video.addEventListener('playing', () => {
    if (generation !== playGeneration || sourceAttempt !== playbackAttemptId) return
    clearTimeout(startFailureTimer)
    mediaStarted = true
    remember(ep.idx)
    void reportPlaybackResult(show.id, currentProvider, true)
    lastSuccessfulProvider = fresh.provider || currentProvider
    actualQuality = Number(video.videoHeight || fresh.quality || 0)
    try { localStorage.setItem(`kj-line:${show.id}`, currentProvider) } catch {}
    updateQuality()
    renderLineList()
  }, { once: true })
  skipInfo = fresh?.skip || null
  loadDm(ep.idx, generation)
  if (resumeAt > 0) {
    const seekResume = () => {
      if (generation !== playGeneration || sourceAttempt !== playbackAttemptId) return
      video.currentTime = Math.min(resumeAt, Math.max(0, video.duration - 1))
    }
    if (video.readyState >= 1) seekResume()
    else video.addEventListener('loadedmetadata', seekResume, { once: true })
  }
  if (generation === playGeneration && !autoplay) {
    pending = false
  }
  if (Number(ep.idx) === Number(resumeIdx)) resumeTime = 0
}

// 播放启动失败不能静默：iOS 上 play() 会被拒绝或卡住，页面却已写着「当前线路可播放」，用户看到的就是黑屏。
function startPlayback() {
  const generation = playGeneration
  const attempt = playbackAttemptId
  playbackWanted = true
  const p = video.play()
  if (!p || typeof p.catch !== 'function') return
  p.catch((error) => {
    if (generation !== playGeneration || attempt !== playbackAttemptId || error?.name === 'AbortError') return
    if (error?.name !== 'NotAllowedError') {
      failedProviders.add(currentProvider)
      void switchToNextLine(generation)
    }
    sayPlayStatus('播放器没有开始播放（' + (error?.name || 'Error') + '），请点一下画面重试或选择其他线路。')
  })
}

video.addEventListener('error', () => {
  if (video.error?.code === MediaError.MEDIA_ERR_ABORTED || !video.currentSrc || switchingAutomatically) return
  if (!mediaStarted) void reportPlaybackResult(show.id, currentProvider, false)
  if (pending) return
  void switchToNextLine(playGeneration)
})
video.addEventListener('waiting', () => {
  if (video.paused || document.visibilityState === 'hidden' || video.seeking || switchingAutomatically) return
  const generation = playGeneration
  stallState = sampleStall(stallState, { now: Date.now(), position: video.currentTime || 0, suspended: false })
  scheduleStallCheck(generation)
})
video.addEventListener('playing', () => {
  resetStallCheck()
  scheduleStallCheck(playGeneration)
  scheduleNextEpisode()
})
video.addEventListener('ended', () => {
  const current = currentEpIdx()
  if (pending || switchingAutomatically || !mediaStarted || activeEpisode !== current || !video.ended) return
  remember(current)
  if (show.cat === 'movie' || nextCancelledFor === current) return
  const next = nextEpisodeAfter(eps, current)
  if (next) {
    nextCancelledFor = current
    clearNextCue()
    void play(next.idx, true, '', { fromEpisode: current })
  }
})
video.addEventListener('loadedmetadata', () => {
  applyRate()
  paintProgress()
})
video.addEventListener('pause', () => {
  if (pending || switchingAutomatically) return
  playbackWanted = false
  const active = activeEpisode
  if (!mediaStarted || active == null || active !== currentEpIdx() || !(video.currentTime > 0)) return
  void saveProgress(
    { showId: show.id, idx: active, position: video.currentTime || 0, duration: video.duration || null },
    { force: true }
  )
})
function runSkip() {
  const t = video.currentTime || 0
  const d = video.duration || 0
  if (!skipInfo) return
  if (getSetting('skipIntro') && skipInfo.introEnd && !skipDone.intro && t > 0.8 && t < skipInfo.introEnd - 1) {
    skipDone.intro = true
    video.currentTime = skipInfo.introEnd
    showToast('已跳过片头')
    return
  }
  if (getSetting('skipOutro') && skipInfo.outroFrom && d > 0 && !skipDone.outro && d - t <= skipInfo.outroFrom) {
    skipDone.outro = true
    const current = currentEpIdx()
    const nxt = show.cat !== 'movie' && nextCancelledFor !== current && nextEpisodeAfter(eps, current)
    if (nxt) {
      nextCancelledFor = current
      showToast('已跳过片尾，播放下一集')
      void play(nxt.idx, true, '', { fromEpisode: current })
    }
  }
}

video.addEventListener('timeupdate', () => {
  pumpDm()
  paintProgress()
  if (!mediaStarted || pending || switchingAutomatically || activeEpisode !== currentEpIdx()) return
  if (Number.isFinite(video.duration) && video.duration > 0) scheduleNextEpisode()
  const second = Math.floor(video.currentTime)
  if (second > 0 && second - lastSavedSecond >= 10) {
    lastSavedSecond = second
    remember(currentEpIdx())
  }
  runSkip()
})
video.addEventListener('progress', paintProgress)

btnNext.addEventListener('click', () => {
  const cur = currentEpIdx()
  const nxt = show.cat !== 'movie' && nextEpisodeAfter(eps, cur)
  if (nxt) void play(nxt.idx)
  else showToast('已经是最后一集了')
})

function remember(idx) {
  const position = video.currentTime || 0
  const duration = video.duration || null
  const name = epLabel(idx)
  try {
    const hist = JSON.parse(localStorage.getItem('kj-history') || '[]')
    localStorage.setItem('kj-history', JSON.stringify([show.id, ...hist.filter((x) => x !== show.id)].slice(0, 12)))
  } catch {}
  try {
    const progress = JSON.parse(localStorage.getItem('kj-progress') || '{}')
    progress[show.id] = { idx, label: name, position, duration, updated: Date.now() }
    localStorage.setItem('kj-progress', JSON.stringify(progress))
  } catch {}
  void saveProgress({ showId: show.id, idx, position, duration })
}

/* ---------------- 启动 ---------------- */

applyRate()
applyFill()
applyHQ()
applyDm()
applyDmStyle()
syncVolumeIcon()
syncGear()
syncPlayButton()
paintProgress()
paintEpSelection(startIdx)

if (!eps.length) {
}

if (eps.length) {
  const initialEp = eps.find((episode) => Number(episode.idx) === Number(resumeIdx)) || eps[0]
  ensureLines(initialEp.idx).then(() => {
    updateQuality()
    renderLineList()
  })
  if (resumeParams.has('ep')) void play(initialEp.idx, true)
  else void play(initialEp.idx, true)
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') {
    if (playing()) { resetStallCheck(); scheduleStallCheck(playGeneration) }
    return
  }
  resetStallCheck()
  if (pending || !mediaStarted || activeEpisode == null || activeEpisode !== currentEpIdx() || !(video.currentTime > 0)) return
  void saveProgress(
    { showId: show.id, idx: activeEpisode, position: video.currentTime || 0, duration: video.duration || null },
    { force: true }
  )
})
window.addEventListener('pagehide', () => void flushSavedProgress())

document.addEventListener('keydown', (event) => {
  const target = event.target
  const onControl = target instanceof Element && (target.isContentEditable || !!target.closest('input, textarea, select, button, a, [role="button"], [role="slider"]'))
  if (event.altKey || event.ctrlKey || event.metaKey) return
  if (event.key !== 'Escape' && !shouldHandlePlaybackShortcut({ defaultPrevented: event.defaultPrevented, onControl })) return
  if (event.key === 'Escape' && (event.defaultPrevented || (target instanceof Element && (target.isContentEditable || target.matches('input, textarea, select'))))) return
  if (event.key === ' ' || event.key.toLowerCase() === 'k') {
    event.preventDefault()
    togglePlay()
    return
  }
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return
    event.preventDefault()
    video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + (event.key === 'ArrowRight' ? 5 : -5)))
    showControls()
    return
  }
  if (event.key.toLowerCase() === 'f') {
    event.preventDefault()
    toggleFullscreen()
  }
  if (event.key === 'Escape') {
    if (webFull) setWebFull(false)
    closePops()
    plEps.hidden = true
  }
})
