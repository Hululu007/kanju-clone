import '../styles.css'
import { icon } from '../icons.js'
import { shell, bindShell, initTheme, pageHead, posterArt, posterCard, showToast } from '../shell.js'
import { findShow, episodesFor, shows } from '../data.js'

const id = new URLSearchParams(location.search).get('id') || 's1'
const show = findShow(id)
const eps = episodesFor(show)
document.title = `${show.title} - 看剧AI`

const synopsis = `《${show.title}》是一部${show.year}年的${show.genres[0]}题材作品，围绕一群普通人在${['长街', '旧城', '海边小镇', '北方雪城'][show.seed % 4]}里相遇、错过又重逢的故事展开。节奏不急，情绪很满，适合晚上慢慢看。`
const related = shows.filter((s) => s !== show && s.cat === show.cat).slice(0, 10)
const rest = related.length >= 6 ? related : shows.slice(6, 14)

const body = `<section class="page-body"><div class="wrap page p-player" style="--h:${show.hue}">
  <section class="detail-backdrop">
    <div class="detail-head">
      <div class="detail-poster">${posterArt(show)}</div>
      <div class="detail-info">
        <h1>${show.title}</h1>
        <div class="detail-meta">
          <span>${show.year}</span><span>·</span>
          ${show.genres.map((g) => `<span class="tag">${g}</span>`).join('')}
          <span>·</span><span>${show.heat}人在追</span>
        </div>
        <span class="detail-badge">${show.badge}</span>
        <div class="detail-actions">
          <button class="btn-mint" type="button" data-play="1">${icon('play', 16)}播放第 1 集</button>
          <button class="btn-ghost" type="button" data-fav>${icon('bookmark', 16)}加入片单</button>
          <button class="btn-ghost" type="button" data-action="share">${icon('share', 16)}分享</button>
        </div>
      </div>
    </div>
  </section>

  <div class="detail-cols">
    <div class="block">
      <section class="player" id="player">
        <div class="player-inner">
          <button class="player-play" type="button" data-play="1" aria-label="播放">${icon('play', 26)}</button>
          <p id="playerHint">播放器占位 · 点击开始播放第 1 集</p>
        </div>
        <span class="p-label" id="playerLabel">${show.title} · 第 1 集</span>
      </section>

      <h3 style="margin-top:22px">简介</h3>
      <p class="synopsis">${synopsis}</p>

      <div class="eps">
        <h3>剧集列表 <span style="font-size:12px;color:var(--ink-50);font-weight:400">共 ${eps.length} 集</span></h3>
        <div class="ep-grid" id="epGrid">
          ${eps.map((n) => `<button class="ep ${n === 1 ? 'on' : ''}" type="button" data-ep="${n}">第${n}集</button>`).join('')}
        </div>
      </div>
    </div>

    <aside>
      <h3>影片信息</h3>
      <div class="facts">
        <div><span>类型</span><span>${show.genres.join(' / ')}</span></div>
        <div><span>年份</span><span>${show.year}</span></div>
        <div><span>状态</span><span>${show.badge}</span></div>
        <div><span>热度</span><span>${show.heat}</span></div>
        <div><span>语言</span><span>国语</span></div>
      </div>
    </aside>
  </div>

  <section class="row" style="margin-top:30px">
    <div class="row-head">
      <div><h2>相关推荐</h2><p class="sub">看过这部的人还在看</p></div>
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
  head: pageHead({ title: show.title, nav: '', back: '/' }),
})
bindShell()

function remember() {
  try {
    const list = JSON.parse(localStorage.getItem('kj-history') || '[]')
    const next = [show.id, ...list.filter((x) => x !== show.id)].slice(0, 12)
    localStorage.setItem('kj-history', JSON.stringify(next))
  } catch {}
}

function play(n) {
  document.querySelectorAll('.ep').forEach((b) => b.classList.toggle('on', Number(b.dataset.ep) === n))
  document.getElementById('playerLabel').textContent = `${show.title} · 第 ${n} 集`
  document.getElementById('playerHint').textContent = `正在播放第 ${n} 集（播放器占位）`
  remember()
  showToast(`开始播放第 ${n} 集`)
}

document.addEventListener('click', (e) => {
  const ep = e.target.closest('[data-ep]')
  if (ep) return play(Number(ep.dataset.ep))
  const p = e.target.closest('[data-play]')
  if (p) return play(1)
  if (e.target.closest('[data-fav]')) showToast(`已把《${show.title}》加入默认片单`)
})
