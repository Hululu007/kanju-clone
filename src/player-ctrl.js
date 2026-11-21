/**
 * 播放器控制栏：播放 · 时间 · 进度条 · 外放 · 倍速 · 全屏。
 *
 * 为什么要自带一条：iOS 原生的 video 控件改不了布局 —— 全屏入口在左上角、
 * 远离拇指，倍速菜单最多到 2×。自带控制栏把全屏放到进度条右端，倍速扩到 3×。
 * 挂载后收起原生控件（video.removeAttribute('controls')），避免两条控制栏叠着。
 *
 * App 端有一份等价的注入实现（ios/ZhuijuAI/AppBootstrap.js），
 * 两边的 id / class 完全一致：注入层发现 #ppCtrl 已存在就不再重复挂载。
 */

const RATE_ORDER = [1, 1.5, 2, 2.5, 3]

function clockText(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${rest < 10 ? '0' + rest : rest}`
}

/**
 * @param {object} options
 * @param {HTMLElement} options.player  播放器容器（控制栏绝对定位在里面）
 * @param {HTMLVideoElement} options.video
 * @param {(text: string) => void} [options.announce] 提示文案输出
 * @param {(on: boolean) => void} [options.onFullscreen] 全屏回调（App 端锁方向用）
 * @param {number[]} [options.speeds]
 */
export function mountPlayerCtrl({ player, video, announce = () => {}, onFullscreen = null, speeds = RATE_ORDER }) {
  if (!player || !video) return null
  const existing = document.getElementById('ppCtrl')
  if (existing) return existing

  const say = (text) => {
    try { announce(text) } catch (error) { /* 提示失败不影响播放 */ }
  }

  let fullscreen = false
  const bar = document.createElement('div')
  bar.id = 'ppCtrl'
  bar.className = 'pp-ctrl'

  const button = (id, label, aria) => {
    const element = document.createElement('button')
    element.id = id
    element.type = 'button'
    element.className = 'pc-btn'
    element.textContent = label
    element.setAttribute('aria-label', aria)
    bar.appendChild(element)
    return element
  }

  const playButton = button('ppPlay', '播放', '播放 / 暂停')
  const time = document.createElement('span')
  time.id = 'ppTime'
  time.className = 'pc-time'
  time.textContent = '0:00 / 0:00'
  bar.appendChild(time)
  const seek = document.createElement('input')
  seek.id = 'ppSeek'
  seek.className = 'pc-seek'
  seek.type = 'range'
  seek.min = '0'
  seek.max = '1000'
  seek.step = '1'
  seek.value = '0'
  seek.setAttribute('aria-label', '播放进度')
  bar.appendChild(seek)
  button('ppCast', '外放', '用其他 App 播放或投屏')
  const rateButton = button('ppRate', '1×', '倍速')
  const fullButton = button('ppFull', '全屏', '全屏播放')

  const castMenu = document.createElement('div')
  castMenu.id = 'ppCastMenu'
  castMenu.className = 'pc-cast-menu'
  const castRow = (id, label, note) => {
    const row = document.createElement('button')
    row.id = id
    row.type = 'button'
    row.className = 'pc-menu-row'
    const text = document.createElement('span')
    text.className = 'pc-menu-label'
    text.textContent = label
    row.appendChild(text)
    const hint = document.createElement('small')
    hint.className = 'pc-menu-note'
    hint.textContent = note || ''
    row.appendChild(hint)
    castMenu.appendChild(row)
    return row
  }
  const shareRow = castRow('ppShareLink', '分享播放地址', '系统面板')
  const copyRow = castRow('ppCopyLink', '复制播放地址', '手动粘贴')
  const downloadRow = castRow('ppDownload', '下载本集', '需登录')
  const localRow = castRow('ppOpenLocal', '用其他播放器打开', '已下载')
  localRow.hidden = true
  bar.appendChild(castMenu)

  const menu = document.createElement('div')
  menu.id = 'ppRateMenu'
  menu.className = 'pc-rate-menu'
  speeds.forEach((value) => {
    const option = document.createElement('button')
    option.type = 'button'
    option.className = 'pc-rate-opt'
    option.dataset.rate = String(value)
    option.textContent = `${value}×`
    menu.appendChild(option)
  })
  bar.appendChild(menu)
  player.appendChild(bar)

  // 自带控制栏挂上之后才收起原生控件
  video.removeAttribute('controls')

  const effectiveRate = () => {
    const rate = Number(video.playbackRate)
    return Number.isFinite(rate) && rate > 0 ? rate : 1
  }

  const syncRate = () => {
    const real = effectiveRate()
    rateButton.textContent = `${real}×`
    menu.querySelectorAll('.pc-rate-opt').forEach((option) => {
      option.classList.toggle('on', Math.abs(Number(option.dataset.rate) - real) < 0.001)
    })
  }

  const sync = () => {
    const duration = Number(video.duration) || 0
    const current = Number(video.currentTime) || 0
    time.textContent = `${clockText(current)} / ${duration ? clockText(duration) : '0:00'}`
    if (document.activeElement !== seek) {
      seek.value = duration ? String(Math.round((current / duration) * 1000)) : '0'
    }
    playButton.textContent = video.paused ? '播放' : '暂停'
    fullButton.textContent = fullscreen ? '退出全屏' : '全屏'
    // 无障碍名跟着走：全屏里不能再有一个叫「全屏播放」的入口
    fullButton.setAttribute('aria-label', fullscreen ? '退出全屏' : '全屏播放')
    syncRate()
  }

  const closeMenu = () => menu.classList.remove('on')

  const setRate = (value, quiet) => {
    const wanted = Number(value) || 1
    try { video.playbackRate = wanted } catch (error) { /* 这条线路不可调速 */ }
    // 系统可能把倍速夹回去（例如只允许到 2×）：读回真实值再显示，不许谎报
    const real = effectiveRate()
    try { localStorage.setItem('kj-speed', String(real)) } catch (error) { /* 隐私模式 */ }
    syncRate()
    if (quiet) return
    closeMenu()
    if (Math.abs(real - wanted) > 0.05) say(`本机最高只支持 ${real}×，${wanted}× 被系统夹回`)
    else say(`已切到 ${real}×`)
  }

  // 真正能交给外部 App 的地址；同时把「还没有地址」和「地址不可交」分开。
  // 空的 <source src> 会被浏览器解析成当前页面地址，看起来像一条片源，必须挡掉。
  // 换集重渲染会换掉 / 清空 <video>：同一集内记住最后一次见过的真实片源，
  // 否则「已经播过的一集」会被冤枉成「还没解析出直链」。
  let mediaMemo = { url: '', ep: '' }

  const episodeKey = () => String(document.querySelector('.ep.on')?.dataset?.ep ?? '')

  const isPageUrl = (url) => {
    const page = location.href.split('#')[0].split('?')[0]
    return !!page && String(url).split('#')[0].split('?')[0] === page
  }

  const mediaCandidates = () => [
    video.currentSrc,
    video.src,
    video.getAttribute?.('src'),
    video.querySelector('source')?.getAttribute?.('src'),
  ]

  const rememberMedia = () => {
    for (const raw of mediaCandidates()) {
      const url = raw || ''
      if (/^https?:/i.test(url) && !isPageUrl(url)) {
        mediaMemo = { url, ep: episodeKey() }
        return
      }
    }
  }

  const mediaState = () => {
    for (const raw of mediaCandidates()) {
      const url = raw || ''
      if (/^https?:/i.test(url) && !isPageUrl(url)) return { url, reason: '' }
    }
    if (mediaMemo.url && mediaMemo.ep === episodeKey()) return { url: mediaMemo.url, reason: '' }
    const blob = String(video.currentSrc || video.src || '').startsWith('blob:')
    return { url: '', reason: blob ? 'opaque' : 'none' }
  }
  const mediaUrl = () => mediaState().url
  const mediaReason = () =>
    mediaState().reason === 'opaque'
      ? LINK_UNSUPPORTED
      : '还没拿到直链：先点播放让这一集解析出地址，再试。'

  // 真正播过的片源才记得住
  for (const name of ['loadedmetadata', 'play', 'durationchange']) video.addEventListener(name, rememberMedia)

  const LINK_UNSUPPORTED = '这条线路是加密或临时流，没法交给其他 App；换一条线路再试。'

  // 登录门控的唯一依据：站点自己的账号 token（与 App 注入层同源同一份）
  const signedIn = () => {
    try { return !!localStorage.getItem('kj-auth-token') } catch { return false }
  }

  const askLogin = () => {
    say('登录后才能下载本集')
    try { document.querySelector('[data-action="login"]')?.click() } catch { /* 弹窗打不开就只留提示 */ }
  }

  const castRow$ = (id) => document.getElementById(id)
  const setNote = (id, text) => {
    const note = castRow$(id)?.querySelector('.pc-menu-note')
    if (note) note.textContent = text
  }
  let downloading = null

  const setBusyLabel = (text) => {
    castButton.textContent = text || '外放'
    downloadRow.className = text ? 'pc-menu-row busy' : 'pc-menu-row'
  }

  // 菜单里的说明必须说真话：没登录说登录，没直链说没直链，分片线路说不能整集下载
  const downloadNote = () => {
    if (downloading && downloading.percent !== undefined) {
      return downloading.percent ? `${downloading.percent}%` : '准备中'
    }
    if (!signedIn()) return '需登录'
    const state = mediaState()
    if (!state.url) return state.reason === 'opaque' ? '线路不可下载' : '还没拿到直链'
    if (/\.m3u8(?:[?#]|$)/i.test(state.url)) return '分片线路不可下载'
    return '开始下载'
  }
  const refreshNote = () => setNote('ppDownload', downloadNote())
  const castButton = document.getElementById('ppCast')

  const closeCastMenu = () => castMenu.classList.remove('on')
  const toggleCastMenu = () => {
    closeMenu()
    castMenu.classList.toggle('on')
    if (castMenu.classList.contains('on')) refreshNote()
  }

  const shareLink = () => {
    closeCastMenu()
    const url = mediaUrl()
    if (!url) { say(mediaReason()); return }
    const title = document.title || '阿噗影视'
    const bridge = window.webkit?.messageHandlers?.iosPlayer
    if (bridge) {
      bridge.postMessage({ action: 'share', url, title })
      say('已打开系统分享面板')
      return
    }
    if (navigator.share) {
      Promise.resolve(navigator.share({ title, url })).catch(() => {})
      return
    }
    copyLink()
  }

  const copyLink = () => {
    closeCastMenu()
    const url = mediaUrl()
    if (!url) { say(mediaReason()); return }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(
        () => say('播放地址已复制，粘到播放器 App 里即可'),
        () => say(`复制失败，地址：${url.slice(0, 56)}`)
      )
      return
    }
    say(`这台设备没有剪贴板通道，地址：${url.slice(0, 56)}`)
  }

  const episodeLabel = () => {
    const text = document.querySelector('.ep.on')?.textContent || ''
    return String(text).replace(/\s+/g, '').slice(0, 16)
  }

  const downloadName = () => {
    const url = mediaUrl()
    const match = /\.(mp4|m4v|mov|mkv|ts)(?:[?#]|$)/i.exec(url || '')
    const ext = match ? `.${match[1].toLowerCase()}` : '.mp4'
    const label = episodeLabel()
    return `追剧AI${label ? `_${label}` : ''}${ext}`
  }

  // 浏览器端下载：拉完一整段再存盘（不并发、不批量），中途可取消
  const startDownload = async () => {
    /* 顺序很重要：先判登录，再说直链。
       以前先报「还没解析出直链」，用户明明是登录状态、这一集也刚播过，很冤。 */
    if (!signedIn()) { closeCastMenu(); askLogin(); return }
    if (downloading) { downloading.controller.abort(); return }
    const url = mediaUrl()
    if (!url) { closeCastMenu(); say(mediaReason()); return }
    if (/\.m3u8(?:[?#]|$)/i.test(url)) {
      closeCastMenu()
      say('HLS 分片线路没法整集下载；换一条 MP4 线路再试。')
      return
    }
    const name = downloadName()
    const controller = new AbortController()
    downloading = { controller, percent: 0 }
    closeCastMenu()
    setBusyLabel('下载 0%')
    setNote('ppDownload', '0%')
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const total = Number(response.headers.get('content-length')) || 0
      const chunks = []
      let received = 0
      const reader = response.body?.getReader?.()
      if (!reader) throw new Error('这条线路不支持边下边存，请换一条')
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.length
        const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0
        if (downloading) downloading.percent = percent
        setBusyLabel(`下载 ${percent}%`)
        setNote('ppDownload', `${percent}%`)
      }
      const type = response.headers.get('content-type') || 'video/mp4'
      const blob = new Blob(chunks, { type })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = name
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(link.href), 60000)
      say(`已下载 ${name}（${(received / 1048576).toFixed(1)} MB），点「外放」可交给其他播放器`)
      setNote('ppDownload', '已下载')
    } catch (error) {
      if (error?.name === 'AbortError') say('已取消下载')
      else if (/Failed to fetch|NetworkError|Load failed/i.test(String(error?.message || error))) {
        say('片源服务器不允许网页直接下载，请在 App 内下载这一集')
      } else say(`下载失败：${error?.message || '网络不给力，稍后再试'}`)
      refreshNote()
    } finally {
      downloading = null
      setBusyLabel('')
      refreshNote()
    }
  }

  bar.addEventListener('click', (event) => {
    const target = event.target.closest('button')
    if (!target) return
    if (target === playButton) {
      if (video.paused) video.play().catch(() => say('播放没有启动，再点一次试试'))
      else video.pause()
      return
    }
    if (target === fullButton) {
      fullscreen = !fullscreen
      // 站点里优先用标准全屏 API；不支持时退回和 App 端相同的沉浸式属性
      if (fullscreen && player.requestFullscreen) {
        Promise.resolve(player.requestFullscreen()).catch(() => document.documentElement.setAttribute('data-ios-immersive', ''))
      } else if (!fullscreen && document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {})
      } else {
        document.documentElement.toggleAttribute('data-ios-immersive', fullscreen)
      }
      if (onFullscreen) onFullscreen(fullscreen)
      sync()
      return
    }
    if (target === rateButton) {
      menu.classList.toggle('on')
      closeCastMenu()
      return
    }
    if (target.classList.contains('pc-rate-opt')) {
      setRate(target.dataset.rate)
      return
    }
    if (target === castButton) {
      toggleCastMenu()
      return
    }
    if (target === shareRow) shareLink()
    if (target === copyRow) copyLink()
    if (target === downloadRow) void startDownload()
  })

  seek.addEventListener('input', () => {
    const duration = Number(video.duration)
    if (duration && Number.isFinite(duration)) video.currentTime = (Number(seek.value) / 1000) * duration
  })
  ;['timeupdate', 'durationchange', 'loadedmetadata', 'seeked', 'play', 'pause', 'ended', 'ratechange'].forEach((name) => {
    video.addEventListener(name, sync)
  })
  ;['play', 'loadedmetadata'].forEach((name) => {
    video.addEventListener(name, () => {
      const saved = Number(localStorage.getItem('kj-speed') || 0)
      if (saved && Math.abs(video.playbackRate - saved) > 0.001) setRate(saved, true)
    })
  })

  sync()
  return bar
}
