import '../styles.css'
import { icon } from '../icons.js'
import {
  shell,
  bindShell,
  initTheme,
  posterCard,
  compactCard,
  showToast,
} from '../shell.js'
import { u } from '../base.js'
import { WEEK, TODAY, CATS, categoryItems, catCount, ROWS, allByPool, shows } from '../data.js'
import { readWatchHistory } from '../watch-history.js'

const state = {
  day: TODAY,
  q: '',
  mode: 'quick',
  cat: null,
  extra: [],
}

const DOW = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

function daysHTML() {
  return WEEK.map(
    (d) => `<button class="day ${d.day === state.day ? 'on' : ''}" type="button" role="tab"
      aria-selected="${d.day === state.day}" data-day="${d.day}">
      <span class="dow">${d.label}</span>
      <span class="dnum">${d.date}日</span>
      <span class="dcnt">${d.total}部</span>
    </button>`
  ).join('')
}

function catsHTML() {
  return Object.entries(CATS)
    .map(([key, label]) => {
      const items = categoryItems(key, state.day, 4)
      return `<section class="cat" aria-label="${label}">
      <div class="cat-head">
        <h3><button class="cat-name" type="button" data-cat="${key}">${label}</button></h3>
        <span class="cat-count"><b>${catCount(key, state.day)}</b> 部</span>
      </div>
      <div class="cat-list" data-catlist="${key}">
        ${items.map((s) => compactCard(s)).join('')}
      </div>
    </section>`
    })
    .join('')
}

function rowHTML(row, idx) {
  return `<section class="row" data-row="${row.id}">
    <div class="row-head">
      <div>
        <h2>${row.title}</h2>
        <p class="sub">${row.sub}</p>
      </div>
      <div class="row-tools">
        <button class="circ" type="button" data-scroll="${row.id}:-1" aria-label="向左">${icon('chevronLeft', 16)}</button>
        <button class="circ" type="button" data-scroll="${row.id}:1" aria-label="向右">${icon('chevronRight', 16)}</button>
        <button class="more-btn" type="button" data-more="${row.id}">查看更多</button>
      </div>
    </div>
    <div class="strip" id="strip-${row.id}" tabindex="0">
      ${row.items.map((s) => posterCard(s)).join('')}
    </div>
  </section>`
}

function rowsHTML() {
  return [...ROWS, ...state.extra].map(rowHTML).join('')
}

function continueWatchingHTML() {
  const watched = readWatchHistory()
    .map((id) => shows.find((show) => show.id === id))
    .filter(Boolean)
    .slice(0, 8)
  if (!watched.length) return ''

  return `<section class="row continue-row" aria-label="继续播放">
    <div class="row-head">
      <div><h2>继续播放</h2><p class="sub">接着看最近播放的电影和电视剧</p></div>
      <a class="more-btn" href="${u('/library/history/')}">播放历史</a>
    </div>
    <div class="strip continue-strip">
      ${watched.map((show) => posterCard(show, { badge: '继续播放' })).join('')}
    </div>
  </section>`
}

function bodyHTML() {
  return `<section class="page-body">
    <div class="wrap home">
    <section class="hero">
      <h1>看剧AI</h1>
      <p class="hero-sub">永久域名 <b>kanju.ai</b></p>
      <form class="search" id="searchForm" autocomplete="off">
        <label class="sr-only" for="q">影视搜索输入</label>
        <textarea id="q" rows="1" placeholder="今天你想看什么？"></textarea>
        <div class="search-row">
          <button class="sbtn" type="button" data-action="expand" aria-label="展开扩展功能">${icon('plus', 20)}</button>
          <div class="modes" role="group" aria-label="搜索模式">
            <button type="button" class="on" data-mode="quick">${icon('bolt', 16)}快速</button>
            <button type="button" data-mode="smart">${icon('sparkle', 16)}智能</button>
          </div>
          <span class="search-spacer"></span>
          <button class="sbtn round" type="button" data-action="mic" aria-label="切换到语音输入">${icon('mic', 16)}</button>
          <button class="send" type="submit" aria-label="发送搜索">${icon('send', 18)}</button>
        </div>
      </form>
    </section>

    <div id="homeSections">
      ${continueWatchingHTML()}
      <section class="week">
        <div class="sec-head">
          <span class="sec-ico">${icon('calendar', 18)}</span>
          <div class="sec-titles">
            <h2>本周追剧</h2>
            <p class="sub">按日期查看影片更新</p>
          </div>
          <div class="sec-actions">
            <a class="link-mint" href="${u('/library/history/')}">查看完整日历</a>
            <span class="range">11月9日 - 11月15日</span>
          </div>
        </div>
        <div class="days" id="days" role="tablist" aria-label="本周追剧">${daysHTML()}</div>
      </section>

      <div class="cats" id="cats">${catsHTML()}</div>
      <div id="rows">${rowsHTML()}</div>
      <button class="loadmore" type="button" id="loadmore">继续下滑，或点击加载更多</button>
    </div>

    <div id="results"></div>
    </div>
  </section>`
}

function renderResultView() {
  const box = document.getElementById('results')
  const home = document.getElementById('homeSections')
  if (!state.q && !state.cat) {
    box.innerHTML = ''
    home.hidden = false
    return
  }
  home.hidden = true
  const q = state.q.trim().toLowerCase()
  let list = shows
  if (state.cat) list = list.filter((s) => s.cat === state.cat)
  if (q) {
    list = list.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.genres.join(' ').toLowerCase().includes(q) ||
        s.badge.toLowerCase().includes(q)
    )
  }
  const title = state.cat ? CATS[state.cat] : '搜索结果'
  box.innerHTML = `<section class="browse">
    <div class="browse-head">
      <h2>${title}</h2>
      <span>共 ${list.length} 部</span>
      <button class="more-btn" type="button" id="clearView" style="margin-left:auto">返回首页</button>
    </div>
    ${
      list.length
        ? `<div class="browse-grid">${list.map((s) => posterCard(s)).join('')}</div>`
        : `<div class="empty-note">没有找到相关影片，换个关键词试试</div>`
    }
  </section>`
}

function refreshDay() {
  // keep the day buttons themselves in place (their click targets stay alive),
  // only move the highlight and re-draw the category lists
  document.querySelectorAll('.day').forEach((b) => {
    const on = Number(b.dataset.day) === state.day
    b.classList.toggle('on', on)
    b.setAttribute('aria-selected', String(on))
  })
  document.getElementById('cats').innerHTML = catsHTML()
}

function refreshRow(id) {
  const row = [...ROWS, ...state.extra].find((r) => r.id === id)
  const el = document.querySelector(`[data-row="${id}"]`)
  if (!row || !el) return
  el.outerHTML = rowHTML(row, 0)
}

function bind() {
  document.getElementById('app').addEventListener('click', (e) => {
    const day = e.target.closest('[data-day]')
    if (day) {
      state.day = Number(day.dataset.day)
      refreshDay()
      return
    }
    const mode = e.target.closest('[data-mode]')
    if (mode) {
      state.mode = mode.dataset.mode
      document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b === mode))
      showToast(state.mode === 'quick' ? '快速模式：直接匹配片名与类型' : '智能模式：按一句话描述找片')
      return
    }
    const cat = e.target.closest('[data-cat]')
    if (cat) {
      state.cat = cat.dataset.cat
      state.q = ''
      const ta = document.getElementById('q')
      if (ta) ta.value = ''
      renderResultView()
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    if (e.target.closest('#clearView')) {
      state.cat = null
      state.q = ''
      const ta = document.getElementById('q')
      if (ta) ta.value = ''
      renderResultView()
      return
    }
    const sc = e.target.closest('[data-scroll]')
    if (sc) {
      const [id, dir] = sc.dataset.scroll.split(':')
      const strip = document.getElementById('strip-' + id)
      strip?.scrollBy({ left: Number(dir) * Math.round(strip.clientWidth * 0.8), behavior: 'smooth' })
      return
    }
    const more = e.target.closest('[data-more]')
    if (more) {
      const row = [...ROWS, ...state.extra].find((r) => r.id === more.dataset.more)
      if (!row) return
      const pool = allByPool(row.pool)
      row.items = pool.slice(0, Math.min(pool.length, row.items.length + 6))
      refreshRow(row.id)
      showToast('已展开全部 ' + row.title)
      return
    }
    if (e.target.closest('#loadmore')) {
      const pools = ['all', 'kr', 'jp']
      const pool = pools[state.extra.length % pools.length]
      const n = state.extra.length + 1
      state.extra.push({
        id: 'more' + n,
        title: ['再刷一遍', '今晚继续', '片单补货'][(n - 1) % 3],
        sub: ['越往后越好看', '换个口味继续看', '按热度挑的下一批'][(n - 1) % 3],
        items: allByPool(pool).slice(0, 10),
        pool,
      })
      document.getElementById('rows').insertAdjacentHTML('beforeend', rowHTML(state.extra.at(-1)))
      const btn = document.getElementById('loadmore')
      btn?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    if (e.target.closest('[data-action="expand"]')) showToast('可以粘贴影片链接或上传剧照来找片')
    if (e.target.closest('[data-action="mic"]')) showToast('语音搜索正在准备中')
  })

  const form = document.getElementById('searchForm')
  const ta = document.getElementById('q')
  ta.addEventListener('input', () => {
    state.q = ta.value
    state.cat = null
    renderResultView()
  })
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      form.requestSubmit()
    }
  })
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    state.q = ta.value
    state.cat = null
    renderResultView()
    if (state.q.trim()) showToast(`正在为你找“${state.q.trim()}”`)
    else showToast('先输入片名、类型或地区')
  })
}

initTheme()
const bootCat = new URLSearchParams(location.search).get('cat')
if (bootCat && CATS[bootCat]) state.cat = bootCat
document.getElementById('app').innerHTML = shell({
  body: bodyHTML(),
  active: '首页',
  tabActive: '首页',
  top: true,
})
bindShell()
bind()
renderResultView()
