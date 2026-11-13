import '../styles.css'
import { icon } from '../icons.js'
import { shell, bindShell, initTheme, posterArt, pageHead } from '../shell.js'
import { u } from '../base.js'
import { shows } from '../data.js'

const KEY = 'kj-history'

function readHistory() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]')
  } catch {
    return []
  }
}

const rows = readHistory()
  .map((id) => shows.find((s) => s.id === id))
  .filter(Boolean)

const body = `<section class="page-body"><div class="wrap page p-history">
  <div class="lib-head">
    <h1>播放历史</h1>
    <span class="count-chip">${rows.length}</span>
  </div>
  <label class="searchbar">
    ${icon('search', 15)}
    <input type="search" id="filter" placeholder="搜索标题、类型、地区" />
  </label>
  <section class="lib-panel" aria-label="播放历史列表">
  ${
    rows.length
      ? `<div class="hlist" id="hlist">${rows
          .map(
            (s) => `<a class="hitem" href="${u('/player/')}?id=${s.id}">
        ${posterArt(s, 'thumb')}
        <span class="hi-main"><h4>${s.title}</h4><p>${s.badge} · ${s.year} · ${s.genres.join(' / ')}</p></span>
        <span class="hi-go">${icon('chevronRight', 16)}</span>
      </a>`
          )
          .join('')}</div>`
      : `<div class="empty-card" id="emptyCard">还没有观看历史</div>`
  }
  </section>
</div></section>`

initTheme()
document.getElementById('app').innerHTML = shell({
  body,
  active: '历史',
  tabActive: '历史',
  top: false,
  head: pageHead({ title: '播放历史', nav: '历史', back: '/' }),
})
bindShell()

const filter = document.getElementById('filter')
filter?.addEventListener('input', () => {
  const q = filter.value.trim().toLowerCase()
  document.querySelectorAll('#hlist .hitem').forEach((el) => {
    el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none'
  })
})
