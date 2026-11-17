import '../styles.css'
import { icon } from '../icons.js'
import { shell, bindShell, initTheme, pageHead, posterArt, posterCard, showToast } from '../shell.js'
import { findShow, shows } from '../data.js'
import { u } from '../base.js'
import { proxyReady, resolvePlay, PROXY } from '../runtime.js'
import { recordWatchedShow } from '../watch-history.js'

const id = new URLSearchParams(location.search).get('id')
const show = findShow(id)
let eps = show.episodes || []
document.title = `${show.title} - 看剧AI`

const related = shows.filter((s) => s.id !== show.id && s.cat === show.cat).slice(0, 10)
const rest = related.length >= 6 ? related : shows.slice(6, 16)

const EP_SHOW = 120
const mins = (s) => (s ? Math.round(s / 60) + ' 分钟' : '—')
const first = eps[0]
const srcHost = (first?.url || '').split('/')[2] || 'archive.org'

const body = `<section class="page-body"><div class="wrap page p-player" style="--h:${show.hue}">
  <section class="detail-backdrop">
    <div class="detail-head">
      <div class="detail-poster">${posterArt(show)}</div>
      <div class="detail-info">
        <h1>${show.title}</h1>
        ${show.originalTitle ? `<p class="detail-orig">原名：${show.originalTitle}</p>` : ''}
        <div class="detail-meta">
          ${show.year ? `<span>${show.year}</span><span>·</span>` : ''}
          <span>${show.kindLabel}</span><span>·</span>
          <span>${show.area}</span><span>·</span>
          ${show.genres.slice(0, 3).map((g) => `<span class="tag">${g}</span>`).join('')}
          <span>·</span><span>热度 ${show.heat}</span>
        </div>
        <span class="detail-badge">${show.badge}</span>
        <div class="detail-actions">
          <button class="btn-mint" type="button" data-play="1">${icon('play', 16)}开始播放</button>
          <button class="btn-ghost" type="button" data-fav>${icon('bookmark', 16)}加入片单</button>
          <button class="btn-ghost" type="button" data-action="share">${icon('share', 16)}分享</button>
        </div>
      </div>
    </div>
  </section>

  <div class="detail-cols">
    <div class="block">
      <section class="player" id="player" style="padding:0;overflow:hidden;background:#000">
        <video id="video" controls playsinline preload="metadata"
          poster="${show.poster || ''}" style="width:100%;display:block;aspect-ratio:16/9;background:#000">
          <source id="vsrc" src="${first?.url || ''}" type="video/mp4" />
          你的浏览器不支持 HTML5 播放。
        </video>
        <span class="p-label" id="playerLabel">${show.title} · ${first?.label || '正片'}</span>
      </section>
      <p class="synopsis" id="playHint" style="margin-top:10px;font-size:12px;color:var(--ink-50)">
        点播放即可观看，线路失败会自动切换下一条。
      </p>

      <h3 style="margin-top:18px">简介</h3>
      <p class="synopsis">${show.synopsis || `《${show.title}》收录于开放影像片库。`}</p>

      ${
        eps.length > 1
          ? `<div class="eps">
        <h3>分集 <span style="font-size:12px;color:var(--ink-50);font-weight:400">共 ${eps.length} 段</span></h3>
        <div class="ep-grid" id="epGrid">
          ${eps
            .slice(0, EP_SHOW)
            .map(
              (e, i) =>
                `<button class="ep ${i === 0 ? 'on' : ''}" type="button" data-ep="${e.idx}">${e.label}</button>`
            )
            .join('')}
        </div>
        ${eps.length > EP_SHOW ? `<button class="btn-ghost" type="button" id="epMore" style="margin-top:10px">显示全部 ${eps.length} 集</button>` : ''}
      </div>`
          : ''
      }
    </div>

    <aside>
      <h3>影片信息</h3>
      <div class="facts">
        <div><span>类型</span><span>${show.genres.slice(0, 3).join(' / ') || '—'}</span></div>
        <div><span>年份</span><span>${show.year || '—'}</span></div>
        <div><span>地区</span><span>${show.area || '—'}</span></div>
        <div><span>语言</span><span>${show.language || '—'}</span></div>
        <div><span>时长</span><span>${mins(first?.length)}</span></div>
        <div><span>分集</span><span>${show.episodeCount || eps.length} 集</span></div>
        <div><span>可播</span><span>${show.playableCount ?? eps.length} 集</span></div>
        <div><span>线路</span><span>${first?.line || '网页播放器'}</span></div>
      </div>
    </aside>
  </div>

  <section class="row" style="margin-top:30px">
    <div class="row-head">
      <div><h2>相关推荐</h2><p class="sub">同类片库里还有这些</p></div>
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
  head: pageHead({ title: show.title, nav: '', back: u('/') }),
})
bindShell()

const epMore = document.getElementById('epMore')
if (epMore) {
  epMore.addEventListener('click', () => {
    const grid = document.getElementById('epGrid')
    grid.innerHTML = eps
      .map((e, i) => `<button class="ep ${i === 0 ? 'on' : ''}" type="button" data-ep="${e.idx}">${e.label}</button>`)
      .join('')
    epMore.remove()
    const cur = document.querySelector('.ep.on')
    if (cur) cur.scrollIntoView({ block: 'nearest' })
  })
}

const video = document.getElementById('video')
const label = document.getElementById('playerLabel')
const hint = document.getElementById('playHint')

function remember(idx) {
  recordWatchedShow(show.id)
  // 片源服务在线时把进度存到服务端（离线只存本地 localStorage）
  if (PROXY) {
    fetch(PROXY + '/api/progress', {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ device: 'web', showId: show.id, idx, position: video.currentTime || 0, duration: video.duration || null }),
    }).catch(() => {})
  }
}

// ---- 播放器：mp4 直连；m3u8 用原生或按需加载 hls.js ----
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

const isHlsUrl = (u) => /\.m3u8(\?|$)/i.test(String(u || ''))

function attach(url) {
  if (hls) { hls.destroy(); hls = null }
  if (!url) return
  // Chrome 的 canPlayType 对 HLS 会撒谎（返回 maybe 但播不了），有 MediaSource 就统一走 hls.js
  if (isHlsUrl(url) && typeof window.MediaSource !== 'undefined') {
    hint.textContent = '正在加载 HLS 线路…'
    loadHls()
      .then((Hls) => {
        hls = new Hls({ maxBufferLength: 30 })
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data?.fatal) return
          hint.textContent = '这条 HLS 线路播不动，换一集或稍后再试。'
        })
        hls.loadSource(url)
        hls.attachMedia(video)
      })
      .catch(() => { hint.textContent = 'HLS 线路加载失败。' })
    return
  }
  video.src = url
  video.load()
}

async function play(idx, autoplay = true) {
  const ep = eps.find((e) => e.idx === Number(idx)) || eps[0]
  if (!ep) return
  document.querySelectorAll('.ep').forEach((b) => b.classList.toggle('on', Number(b.dataset.ep) === ep.idx))
  label.textContent = `${show.title} · ${ep.label}`
  hint.textContent = '正在换取片源…'
  // 静态页面里的直链会过期：优先让本地片源服务现场解析一条新的
  const fresh = await resolvePlay(show.id, ep.idx).catch(() => null)
  if (fresh?.error === 'login_required') {
    hint.textContent = '这一集在原站是会员片源，匿名拿不到地址。换一部标着「可播放」的片子就能直接看。'
    return
  }
  const url = fresh?.url || ep.url
  if (fresh?.error) {
    hint.textContent = '这一集的片源暂时取不到（线路维护或需要会员），换一集或换一部试试。'
    return
  }
  if (!url) {
    hint.textContent = '这一集暂时取不到片源（可能是会员片源或线路维护），换一集或换一部试试。'
    return
  }
  attach(url)
  hint.textContent = fresh
    ? `正在播放 第${fresh.episodeNumber ?? ep.idx + 1} 集 · 线路 ${fresh.line || '官方'} · ${fresh.kind === 'hls' ? 'HLS' : 'MP4'}`
    : '使用缓存的片源线路（可能已过期）'
  if (autoplay) {
    video.play().catch(() => {})
    remember(ep.idx)
  }
}

const playableEps = () => eps.filter((e) => e.url)
function nextEpisode() {
  const cur = Number(document.querySelector('.ep.on')?.dataset.ep)
  const list = playableEps()
  const at = list.findIndex((e) => e.idx === cur)
  const next = list[at + 1]
  if (next) { hint.textContent = `这条线路不通，自动切到 ${next.label}`; play(next.idx) }
}

video.addEventListener('error', nextEpisode)
video.addEventListener('loadedmetadata', () => {
  hint.textContent = video.duration ? `时长 ${mins(video.duration)} · 当前线路可直接播放` : '当前线路可直接播放'
})

document.addEventListener('click', (e) => {
  const ep = e.target.closest('[data-ep]')
  if (ep) return play(Number(ep.dataset.ep))
  const p = e.target.closest('[data-play]')
  if (p) {
    play(eps[0]?.idx ?? 0)
    video.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return
  }
  if (e.target.closest('[data-fav]')) showToast(`已把《${show.title}》加入默认片单`)
})

if (!eps.length) {
  hint.textContent = '这部暂时没有可播放文件。'
}

// 本地片源服务在线时，把分集/简介换成实时数据
proxyReady.then((info) => {
  if (!info) {
    hint.textContent = '未检测到片源服务，正在使用缓存线路。想稳定播放请在本机运行 npm run proxy。'
    return
  }
  hint.textContent = `片源服务已连接（${PROXY}）· 库内 ${info.shows} 部`
})
