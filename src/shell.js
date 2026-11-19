import { icon } from './icons.js'
import { u } from './base.js'
import {
  fetchUserProgress,
  getCachedUser,
  loginAccount,
  logoutAccount,
  registerAccount,
} from './auth.js'

const NAV = [
  { label: '首页', href: u('/') },
  { label: '短剧', href: u('/') + '?cat=tv' },
  { label: '历史', href: u('/library/history/') },
  { label: '片单', href: u('/playlists/') },
]

const AVATAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
<defs>
<radialGradient id="s" cx="0.32" cy="0.26" r="0.75">
<stop offset="0" stop-color="#f3e4c6"/>
<stop offset="0.35" stop-color="#8fb8ae"/>
<stop offset="0.7" stop-color="#33414d"/>
<stop offset="1" stop-color="#111820"/>
</radialGradient>
<linearGradient id="f" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#0d1216" stop-opacity="0.15"/>
<stop offset="1" stop-color="#0d1216" stop-opacity="0.85"/>
</linearGradient>
</defs>
<rect width="96" height="96" fill="url(#s)"/>
<path d="M48 26c8 0 13 6 13 14s-5 15-13 15-13-7-13-15 5-14 13-14z" fill="#1a222a" opacity="0.55"/>
<path d="M16 96c3-19 15-28 32-28s29 9 32 28z" fill="#1a222a" opacity="0.6"/>
<rect width="96" height="96" fill="url(#f)"/>
</svg>`

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

export function avatarHTML(cls = 'avatar') {
  return `<img class="${cls}" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    AVATAR_SVG
  )}" alt="" width="44" height="44" decoding="async" />`
}

export function sidebarInner(active = 'history') {
  const user = getCachedUser()
  return `
  <div class="sb-profile">
    ${avatarHTML()}
    <div class="sb-id">
      <p class="sb-name">${user ? esc(user.username) : '游客账号'}</p>
      <p class="sb-sub">${user ? '已登录 · 观看记录跨设备同步' : '本设备使用中 · 游客账号'}</p>
    </div>
    <button class="icon-btn" type="button" data-action="settings" aria-label="设置" title="设置">${icon('settings', 16)}</button>
  </div>

  <div class="theme-switch" role="group" aria-label="主题" data-theme-switch>
    ${[
      ['dark', 'moon', '深色', '深色主题'],
      ['light', 'sun', '白色', '白色主题'],
      ['auto', 'monitor', '自动', '跟随系统'],
    ]
      .map(([value, ico, label, title]) => {
        const on = (document.documentElement.dataset.themeMode || 'dark') === value
        return `<button type="button" data-theme-set="${value}" title="${title}" class="${on ? 'on' : ''}" aria-pressed="${on}">${icon(ico, 14)}<span>${label}</span></button>`
      })
      .join('')}
  </div>

  <section class="acct">
    <div class="acct-row">
      <span class="acct-coin" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3l4 4-4 4-4-4z"/><path d="M8 7h8"/><path d="M12 11v10"/><path d="M9 21h6"/></svg>
      </span>
      <p class="acct-name">${user ? esc(user.username) : '游客账号'}</p>
      <span class="bar"><i style="width:0%"></i></span>
      <span class="acct-pct">0%</span>
      <button class="acct-help" type="button" data-action="notice" aria-label="账号说明">?</button>
    </div>
    <div class="acct-row2">
      <span>成长 0</span>
      <span>剩余 90万 词元</span>
    </div>
  </section>

  <p class="sb-warning">
    <span class="warn-ico">${icon('info', 14)}</span>
    <span>${user ? '观看记录和断点进度已绑定到账号，换设备登录即可继续观看。' : '游客数据会因为浏览器和域名变更造成丢失，请及时注册账号。'}</span>
  </p>

  <div class="sb-quick">
    <button type="button" data-action="qr"><span class="qi">${icon('qr', 24)}</span><span class="ql">扫一扫</span></button>
    <button type="button" data-action="share"><span class="qi">${icon('share', 24)}</span><span class="ql">分享</span></button>
    <button type="button" data-action="notice"><span class="qi">${icon('bell', 24)}<i class="dot"></i></span><span class="ql">通知</span></button>
    <a href="${u('/download/')}"><span class="qi">${icon('phone', 24)}</span><span class="ql">APP</span></a>
  </div>

  <div class="seg" role="tablist" aria-label="片库">
    <button type="button" class="seg-btn ${active === 'history' ? 'on' : ''}" data-seg="history" role="tab" aria-selected="${active === 'history'}">
      ${icon('history', 15)}<span>历史 0</span>
    </button>
    <button type="button" class="seg-btn ${active === 'fav' ? 'on' : ''}" data-seg="fav" role="tab" aria-selected="${active === 'fav'}">
      ${icon('bookmark', 15)}<span>收藏 0</span>
    </button>
  </div>

  <div class="sb-empty" role="tabpanel">
    <span class="se-ico">${icon('clock', 26)}</span>
    <p class="se-title">还没有播放记录</p>
    <p class="se-sub">看过的影片，会留在这里</p>
  </div>

  <div class="sb-links">
    <a href="${u('/library/history/')}" class="sb-link">
      <span>全部播放历史</span>${icon('chevronRight', 16)}
    </a>
    <a href="${u('/library/sessions/')}" class="sb-link">
      <span class="sl-ico">${icon('list', 18)}</span>
      <span>会话记录</span>${icon('chevronRight', 16)}
    </a>
  </div>

  <div class="sb-bottom">
    <button class="btn-login" type="button" data-action="${user ? 'logout' : 'login'}">
      ${icon('login', 16)}<span>${user ? '退出登录' : '登录账号'}</span>
    </button>
  </div>
  `
}

export function navPill(active = 'home') {
  return `<nav class="navpill" aria-label="主导航">
    ${NAV.map(
      (n) =>
        `<a href="${n.href}" class="${n.label === active ? 'on' : ''}"${
          n.label === active ? ' aria-current="page"' : ''
        }>${n.label}</a>`
    ).join('')}
  </nav>`
}

const TABS = [
  { label: '首页', href: u('/'), ico: 'home' },
  { label: '短剧', href: u('/playlists/'), ico: 'film' },
  { label: '分享', href: '#', ico: 'share', center: true },
  { label: '历史', href: u('/library/history/'), ico: 'history' },
  { label: '片单', href: u('/playlists/'), ico: 'bookmark' },
]

const TAB_ICON = {
  home: '<path d="M4 10.5 12 3.5l8 7"/><path d="M6.5 9.5V20h11V9.5"/><path d="M10 20v-5h4v5"/>',
  film: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M8 5v14M16 5v14"/><path d="M3 9.5h5M3 14.5h5M16 9.5h5M16 14.5h5"/>',
  share: '<path d="M4 12h11"/><path d="M11 7l5 5-5 5"/>',
  history: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 1.8"/>',
  bookmark: '<path d="M6 4h12v16l-6-4.5L6 20z"/>',
}

export function tabbar(active = 'home') {
  return `<nav class="tabbar" aria-label="底部导航">
    ${TABS.map((t) => {
      const on = t.label === active
      const body = `<span class="tb-ico"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${
        TAB_ICON[t.ico]
      }</svg></span><span class="tb-label">${t.label}</span>`
      if (t.center) {
        return `<button type="button" class="tab center ${on ? 'on' : ''}" data-action="share"><span class="tab-circle">${
          t.label === '分享'
            ? '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h11"/><path d="M11.5 7l5.5 5-5.5 5"/></svg>'
            : ''
        }</span><span class="tb-label">${t.label}</span></button>`
      }
      return `<a class="tab ${on ? 'on' : ''}" href="${t.href}"${on ? ' aria-current="page"' : ''}>${body}</a>`
    }).join('')}
  </nav>`
}

export function mobileTop() {
  return `<header class="topbar">
    <button class="tb-btn" type="button" data-action="drawer" aria-label="打开菜单">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg>
    </button>
    <a class="brand" href="${u('/')}">
      <span class="brand-mark">
        <svg viewBox="0 0 32 32" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"><rect x="4" y="10" width="24" height="17" rx="5"/><path d="M10 5.5 16 10l6-4.5"/><path d="M14.5 16.5 20 19.5l-5.5 3z" fill="currentColor" stroke="none"/></svg>
      </span>
      <span class="brand-text">阿噗影视</span>
    </a>
    <span class="tb-right">
      <button class="tb-btn tb-theme" type="button" data-theme-cycle aria-label="切换主题" title="切换主题">
        <span class="tt-dark">${icon('moon', 18)}</span>
        <span class="tt-light">${icon('sun', 18)}</span>
      </button>
      <button class="tb-btn tb-settings" type="button" data-action="settings" aria-label="设置" title="设置">${icon('settings', 18)}</button>
    </span>
  </header>`
}

export function pageHead({ title, nav = null, back = null, big = false }) {
  return `<header class="page-head${big ? ' big' : ''}">
    <div class="ph-left">
      ${
        back
          ? `<a class="ph-back" href="${back}" aria-label="返回">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/></svg>
            </a>`
          : ''
      }
    </div>
    <h1 class="ph-title">${title}</h1>
    <div class="ph-right">
      <button class="ph-menu ph-theme" type="button" data-theme-cycle aria-label="切换主题" title="切换主题">
        <span class="tt-dark">${icon('moon', 18)}</span>
        <span class="tt-light">${icon('sun', 18)}</span>
      </button>
      <button class="ph-menu ph-settings" type="button" data-action="settings" aria-label="设置" title="设置">${icon('settings', 18)}</button>
      <button class="ph-menu" type="button" data-action="drawer" aria-label="打开菜单">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
      </button>
      ${nav === null ? '' : navPill(nav)}
    </div>
  </header>`
}

export function shell({ body, active = 'home', sidebarActive = 'history', head = '', top = true, tabActive = 'home' }) {
  return `
  ${top ? mobileTop() : ''}
  <aside class="sidebar" id="sidebar" aria-label="侧栏">${sidebarInner(sidebarActive)}</aside>
  <div class="scrim" data-action="drawer-close"></div>
  <aside class="drawer" id="drawer" aria-label="菜单" aria-hidden="true" data-active="${sidebarActive}"></aside>
  ${head}
  <main class="main">${body}</main>
  ${tabbar(tabActive)}
  ${navPill(active)}
  <div class="modal-wrap" id="modalWrap" aria-hidden="true">
    <div class="modal" role="dialog" aria-modal="true" aria-label="登录">
      <button class="modal-x" type="button" data-action="modal-close" aria-label="关闭">${icon('close', 18)}</button>
      <div class="modal-mark">${icon('tv', 26)}</div>
      <h2>登录阿噗影视</h2>
      <p>登录后可跨设备同步观看记录与断点进度</p>
      <div class="modal-tabs" role="tablist" aria-label="账号操作">
        <button type="button" class="modal-tab on" data-auth-mode="login" role="tab" aria-selected="true">登录</button>
        <button type="button" class="modal-tab" data-auth-mode="register" role="tab" aria-selected="false">注册</button>
      </div>
      <label class="modal-field"><span>账号</span><input id="authUsername" type="text" placeholder="3-24 位账号" maxlength="24" autocomplete="username" data-focus /></label>
      <label class="modal-field"><span>密码</span><input id="authPassword" type="password" placeholder="至少 8 位" maxlength="128" autocomplete="current-password" /></label>
      <label class="modal-field" id="authConfirmField" hidden><span>确认</span><input id="authConfirm" type="password" placeholder="再次输入密码" maxlength="128" autocomplete="new-password" /></label>
      <p class="modal-error" id="authError" role="alert"></p>
      <button class="modal-submit" type="button" data-action="auth-submit" id="authSubmit">登录</button>
      <p class="modal-hint">账号支持中文、字母、数字、下划线和短横线</p>
    </div>
  </div>
  <div class="notice-wrap" id="noticeWrap" aria-hidden="true">
    <section class="notice-modal" role="dialog" aria-modal="true" aria-labelledby="noticeTitle">
      <button class="notice-close" type="button" data-action="notice-close" aria-label="关闭">×</button>
      <span class="notice-kicker">阿噗影视 · 站内通知</span>
      <h2 id="noticeTitle">欢迎来到阿噗影视</h2>
      <p>片库与播放线路持续更新。遇到无法播放的影片，可切换线路或稍后再试；登录后观看记录和断点进度会跨设备同步。</p>
      <button class="notice-confirm" type="button" data-action="notice-close">我知道了</button>
    </section>
  </div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  `
}

/* ---------- shared bits ---------- */

// Drawn fallback artwork (used only when a show has no real poster).
export function posterSVG(show, w = 300, h = 450, thumb = false) {
  const hue = show.hue
  const h2 = (hue + 34) % 360
  const s = show.seed
  const big = show.title.slice(0, 2)
  const small = show.title.slice(2)
  const cx = 0.3 + ((s * 37) % 40) / 100
  const cy = 0.16 + ((s * 17) % 22) / 100
  const r = 0.5 + ((s * 11) % 24) / 100
  const bandY = 0.6 + ((s * 7) % 12) / 100
  const lift = 42 + ((s * 29) % 16)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs>
<linearGradient id="a" x1="0.15" y1="0" x2="0.75" y2="1">
<stop offset="0" stop-color="hsl(${hue} 34% ${lift}%)"/>
<stop offset="0.5" stop-color="hsl(${hue} 30% ${lift - 14}%)"/>
<stop offset="1" stop-color="hsl(${h2} 26% ${lift - 26}%)"/>
</linearGradient>
<radialGradient id="b" cx="${cx}" cy="${cy}" r="${r}">
<stop offset="0" stop-color="hsl(${(hue + 8) % 360} 62% 76%)" stop-opacity="0.62"/>
<stop offset="0.45" stop-color="hsl(${hue} 52% 58%)" stop-opacity="0.26"/>
<stop offset="1" stop-color="hsl(${hue} 46% 48%)" stop-opacity="0"/>
</radialGradient>
<radialGradient id="c" cx="0.8" cy="0.72" r="0.62">
<stop offset="0" stop-color="hsl(${h2} 56% 58%)" stop-opacity="0.4"/>
<stop offset="1" stop-color="hsl(${h2} 56% 58%)" stop-opacity="0"/>
</radialGradient>
<linearGradient id="f" x1="0" y1="0" x2="0" y2="1">
<stop offset="0.5" stop-color="hsl(${hue} 40% 70%)" stop-opacity="0"/>
<stop offset="1" stop-color="hsl(${hue} 40% 70%)" stop-opacity="0.14"/>
</linearGradient>
<linearGradient id="d" x1="0" y1="0" x2="0" y2="1">
<stop offset="0.42" stop-color="#050809" stop-opacity="0"/>
<stop offset="0.78" stop-color="#050809" stop-opacity="0.55"/>
<stop offset="1" stop-color="#050809" stop-opacity="0.94"/>
</linearGradient>
<radialGradient id="e" cx="0.5" cy="0.4" r="0.8">
<stop offset="0.58" stop-color="#000" stop-opacity="0"/>
<stop offset="1" stop-color="#000" stop-opacity="0.42"/>
</radialGradient>
</defs>
<rect width="100%" height="100%" fill="url(#a)"/>
<rect width="100%" height="100%" fill="url(#b)"/>
<rect width="100%" height="100%" fill="url(#c)"/>
<rect width="100%" height="100%" fill="url(#f)"/>
<g fill="#050a0c" opacity="0.42">
<rect x="0" y="${h * bandY}" width="100%" height="${h * 0.4}"/>
<ellipse cx="${w * (0.22 + ((s * 13) % 26) / 100)}" cy="${h * (bandY + 0.14)}" rx="${w * 0.15}" ry="${h * 0.19}"/>
<ellipse cx="${w * (0.62 + ((s * 23) % 22) / 100)}" cy="${h * (bandY + 0.22)}" rx="${w * 0.19}" ry="${h * 0.25}"/>
<ellipse cx="${w * 0.5}" cy="${h * 0.56}" rx="${w * 0.36}" ry="${h * 0.1}"/>
</g>
<g fill="hsl(${(hue + 12) % 360} 70% 84%)" opacity="0.16">
<ellipse cx="${w * (0.3 + ((s * 41) % 40) / 100)}" cy="${h * (0.2 + ((s * 19) % 20) / 100)}" rx="${w * 0.22}" ry="${h * 0.08}"/>
</g>
<rect width="100%" height="100%" fill="url(#e)"/>
${
  thumb
    ? ''
    : `<g font-family="PingFang SC, Microsoft YaHei, sans-serif" text-anchor="middle" fill="#ffffff">
<text x="${w * 0.5}" y="${h * 0.46}" font-size="${w * 0.19}" font-weight="700" fill-opacity="0.82" letter-spacing="${w * 0.02}">${big}</text>
${small ? `<text x="${w * 0.5}" y="${h * 0.58}" font-size="${w * 0.12}" font-weight="500" fill-opacity="0.6" letter-spacing="${w * 0.03}">${small}</text>` : ''}
</g>`
}
<rect width="100%" height="100%" fill="url(#d)"/>
</svg>`
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
}

// Real cover from the catalogue when available; otherwise the drawn placeholder.
export function posterSrc(show, w = 300, h = 450, thumb = false) {
  return show?.poster || posterSVG(show, w, h, thumb)
}

export function posterArt(show, cls = '') {
  const thumb = cls === 'thumb'
  const fb = posterSVG(show, thumb ? 120 : 300, thumb ? 184 : 450, true)
  const src = posterSrc(show, thumb ? 120 : 300, thumb ? 184 : 450, true)
  return `<img class="poster ${cls}" src="${src}" data-fb="${encodeURIComponent(fb)}"
    onerror="this.onerror=null;this.src=decodeURIComponent(this.dataset.fb)" alt=""
    width="${thumb ? 42 : 185}" height="${thumb ? 64 : 279}" loading="lazy" decoding="async" />`
}

const shortBadge = (b) => b.replace(/更新至第(\d+)集/, '更新至$1集')

export function posterCard(show, { badge, heat } = {}) {
  const text = shortBadge(badge || show.badge)
  return `<article class="pcard">
    <a class="pcard-link" href="${u('/player/')}?id=${show.id}&v=live">
      ${posterArt(show)}
      <span class="p-badge${/(抢鲜|特别)/.test(badge || show.badge) ? ' gold' : ''}">${text}</span>
      <span class="p-heat">${heat || show.heat}</span>
      ${show.vip ? '<span class="p-vip">会员</span>' : ''}
      <span class="p-shade"></span>
      <h3 class="p-title">${show.title}</h3>
      <p class="p-meta">${show.year || '—'} · ${show.area || '美国'} · ${show.genres.slice(0, 2).join(' / ')}</p>
    </a>
  </article>`
}

export function compactCard(show) {
  return `<article class="ccard">
    ${posterArt(show, 'thumb')}
    <span class="ctxt">
      <h4>${show.title}</h4>
      <p>${show.badge}</p>
    </span>
    <a class="ccard-hit" href="${u('/player/')}?id=${show.id}&v=live" aria-label="${show.title}"></a>
  </article>`
}

/* ---------- behaviour ---------- */

export function showToast(msg) {
  const el = document.getElementById('toast')
  if (!el) return
  el.textContent = msg
  el.classList.add('on')
  clearTimeout(showToast._t)
  showToast._t = setTimeout(() => el.classList.remove('on'), 2200)
}

export function openModal() {
  const w = document.getElementById('modalWrap')
  if (!w) return
  setAuthMode(w.dataset.authMode || 'login')
  setAuthError('')
  w.classList.add('on')
  w.setAttribute('aria-hidden', 'false')
  setTimeout(() => w.querySelector('[data-focus]')?.focus(), 60)
}

export function closeModal() {
  const w = document.getElementById('modalWrap')
  if (!w) return
  w.classList.remove('on')
  w.setAttribute('aria-hidden', 'true')
  const password = document.getElementById('authPassword')
  const confirm = document.getElementById('authConfirm')
  if (password) password.value = ''
  if (confirm) confirm.value = ''
  setAuthError('')
}

function setAuthError(message) {
  const el = document.getElementById('authError')
  if (el) el.textContent = message || ''
}

function setAuthMode(mode = 'login') {
  const w = document.getElementById('modalWrap')
  if (!w) return
  const next = mode === 'register' ? 'register' : 'login'
  w.dataset.authMode = next
  w.querySelectorAll('[data-auth-mode]').forEach((button) => {
    const active = button.dataset.authMode === next
    button.classList.toggle('on', active)
    button.setAttribute('aria-selected', String(active))
  })
  const confirmField = document.getElementById('authConfirmField')
  const password = document.getElementById('authPassword')
  const submit = document.getElementById('authSubmit')
  if (confirmField) confirmField.hidden = next !== 'register'
  if (password) password.autocomplete = next === 'register' ? 'new-password' : 'current-password'
  if (submit) submit.textContent = next === 'register' ? '创建账号' : '登录'
  setAuthError('')
}

async function submitAuth() {
  const w = document.getElementById('modalWrap')
  if (!w) return
  const mode = w.dataset.authMode === 'register' ? 'register' : 'login'
  const username = document.getElementById('authUsername')?.value.trim() || ''
  const password = document.getElementById('authPassword')?.value || ''
  const confirm = document.getElementById('authConfirm')?.value || ''
  const submit = document.getElementById('authSubmit')
  if (!username) return setAuthError('请输入账号')
  if (password.length < 8) return setAuthError('密码至少 8 位')
  if (mode === 'register' && password !== confirm) return setAuthError('两次输入的密码不一致')
  if (submit) {
    submit.disabled = true
    submit.textContent = mode === 'register' ? '创建中…' : '登录中…'
  }
  setAuthError('')
  try {
    const user = mode === 'register' ? await registerAccount(username, password) : await loginAccount(username, password)
    closeModal()
    refreshAccountUI()
    showToast(mode === 'register' ? `账号 ${user.username} 已创建，进度同步已开启` : `欢迎回来，${user.username}`)
  } catch (error) {
    setAuthError(error.message || '操作失败，请稍后再试')
  } finally {
    if (submit) {
      submit.disabled = false
      submit.textContent = mode === 'register' ? '创建账号' : '登录'
    }
  }
}

export async function refreshAccountUI() {
  const user = getCachedUser()
  document.querySelectorAll('.sb-name').forEach((el) => {
    el.textContent = user ? user.username : '游客账号'
  })
  document.querySelectorAll('.sb-sub').forEach((el) => {
    el.textContent = user ? '已登录 · 观看记录跨设备同步' : '本设备使用中 · 游客账号'
  })
  /* 成长卡片以前是写死的「游客账号」，登录后侧栏上下一半写用户名一半写游客，
     看着像账号状态坏了。名字统一走同一个来源。 */
  document.querySelectorAll('.acct-name').forEach((el) => {
    el.textContent = user ? user.username : '游客账号'
  })
  document.querySelectorAll('.sb-warning span:last-child').forEach((el) => {
    el.textContent = user
      ? '观看记录和断点进度已绑定到账号，换设备登录即可继续观看。'
      : '游客数据会因为浏览器和域名变更造成丢失，请及时注册账号。'
  })
  document.querySelectorAll('.btn-login').forEach((button) => {
    button.dataset.action = user ? 'logout' : 'login'
    button.innerHTML = `${icon('login', 16)}<span>${user ? '退出登录' : '登录账号'}</span>`
  })
  let historyCount = 0
  try {
    historyCount = JSON.parse(localStorage.getItem('kj-history') || '[]').length
  } catch {}
  if (user) {
    const items = await fetchUserProgress('', 200).catch(() => null)
    if (items) historyCount = items.length
  }
  document.querySelectorAll('[data-seg="history"] span').forEach((element) => {
    element.textContent = `历史 ${historyCount}`
  })
}

function setDrawer(open) {
  document.body.classList.toggle('drawer-open', open)
  const d = document.getElementById('drawer')
  if (d) {
    if (open && !d.childElementCount) d.innerHTML = sidebarInner(d.dataset.active || 'history')
    d.setAttribute('aria-hidden', String(!open))
  }
}

export function bindShell() {
  document.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-theme-set]')
    if (pick) {
      applyTheme(pick.dataset.themeSet, { toast: true })
      return
    }
    const cycle = e.target.closest('[data-theme-cycle]')
    if (cycle) {
      const cur = document.documentElement.dataset.themeMode || 'dark'
      applyTheme(THEME_MODES[(THEME_MODES.indexOf(cur) + 1) % THEME_MODES.length], { toast: true })
    }
  })
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]')
    if (!el) return
    const a = el.dataset.action
    if (a === 'drawer') setDrawer(true)
    if (a === 'drawer-close') setDrawer(false)
    if (a === 'share') {
      const url = location.origin
      if (navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {})
      showToast('链接已复制，去分享给朋友吧')
    }
    if (a === 'qr') {
      document.getElementById('qrModal')?.classList.add('on')
      showToast('扫一扫：请用手机相机对准二维码')
    }
    if (a === 'notice') {
      const notice = document.getElementById('noticeWrap')
      if (notice) {
        notice.classList.add('on')
        notice.setAttribute('aria-hidden', 'false')
      } else showToast('暂无新通知')
    }
    if (a === 'notice-close') {
      const notice = document.getElementById('noticeWrap')
      notice?.classList.remove('on')
      notice?.setAttribute('aria-hidden', 'true')
      try { localStorage.setItem('kj-notice-seen', '1') } catch {}
    }
    if (a === 'settings') {
      // 懒加载：设置面板本身又要用 shell 的弹窗/主题函数，静态互相 import 会成环
      import('./settings-panel.js').then((m) => m.toggleSettings()).catch(() => showToast('设置面板加载失败'))
    }
    if (a === 'login') openModal()
    if (a === 'logout') {
      await logoutAccount()
      refreshAccountUI()
      showToast('已退出登录')
    }
    if (a === 'modal-close') closeModal()
    if (a === 'auth-submit') await submitAuth()
  })
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-auth-mode]')
    if (tab) setAuthMode(tab.dataset.authMode)
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.closest('#modalWrap') && e.target.matches('input')) {
      e.preventDefault()
      void submitAuth()
      return
    }
    if (e.key === 'Escape') {
      closeModal()
      const notice = document.getElementById('noticeWrap')
      notice?.classList.remove('on')
      notice?.setAttribute('aria-hidden', 'true')
      setDrawer(false)
    }
  })
  document.addEventListener('kj-auth-changed', refreshAccountUI)
  refreshAccountUI()
  const w = document.getElementById('modalWrap')
  w?.addEventListener('click', (e) => {
    if (e.target === w) closeModal()
  })

  // sidebar history / favourite tabs (delegated: the drawer is built on first open)
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-seg]')
    if (!b) return
    const seg = b.closest('.seg')
    if (!seg) return
    seg.querySelectorAll('[data-seg]').forEach((x) => {
      x.classList.toggle('on', x === b)
      x.setAttribute('aria-selected', String(x === b))
    })
    const fav = b.dataset.seg === 'fav'
    document.querySelectorAll('.sb-empty').forEach((p) => {
      p.querySelector('.se-title').textContent = fav ? '还没有收藏影片' : '还没有播放记录'
      p.querySelector('.se-sub').textContent = fav ? '遇到喜欢的影片，收藏起来慢慢看' : '看过的影片，会留在这里'
    })
  })
}

const THEME_MODES = ['dark', 'light', 'auto']
const THEME_LABEL = { dark: '深色主题', light: '白色主题', auto: '跟随系统' }

function prefersLight() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches
}

function resolveThemeMode(mode) {
  return mode === 'auto' ? (prefersLight() ? 'light' : 'dark') : mode
}

export function themeMode() {
  try {
    const saved = localStorage.getItem('kj-theme-mode')
    if (THEME_MODES.includes(saved)) return saved
    const legacy = localStorage.getItem('kj-theme')
    if (legacy === 'light' || legacy === 'dark') return legacy
  } catch {}
  return 'dark'
}

export function applyTheme(mode = 'dark', { persist = true, toast = false } = {}) {
  const html = document.documentElement
  const safeMode = THEME_MODES.includes(mode) ? mode : 'dark'
  const resolved = resolveThemeMode(safeMode)
  html.dataset.theme = resolved
  html.dataset.themeMode = safeMode
  if (persist) {
    try {
      localStorage.setItem('kj-theme-mode', safeMode)
      localStorage.setItem('kj-theme', resolved)
    } catch {}
  }
  document.querySelectorAll('[data-theme-set]').forEach((btn) => {
    const on = btn.dataset.themeSet === safeMode
    btn.classList.toggle('on', on)
    btn.setAttribute('aria-pressed', String(on))
  })
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#ffffff' : '#0b1f2b')
  if (toast) showToast(`已切换到${THEME_LABEL[safeMode]}`)
  return resolved
}

export function initTheme() {
  let param = ''
  try {
    param = new URLSearchParams(location.search).get('theme') || ''
  } catch {}
  const mode = THEME_MODES.includes(param) ? param : themeMode()
  applyTheme(mode, { persist: THEME_MODES.includes(param) })
  if (typeof matchMedia === 'function') {
    const mq = matchMedia('(prefers-color-scheme: light)')
    const onChange = () => {
      if (document.documentElement.dataset.themeMode === 'auto') applyTheme('auto', { persist: false })
    }
    if (mq.addEventListener) mq.addEventListener('change', onChange)
    else if (mq.addListener) mq.addListener(onChange)
  }
}
