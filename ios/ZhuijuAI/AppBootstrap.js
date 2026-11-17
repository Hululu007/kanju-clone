(function () {
  'use strict';
  if (window.top !== window) return;
  if (window.location.protocol !== 'https:' || window.location.hostname !== 'zhuiju.dpdns.org') return;
  if (window.__zhuijuIOSReady) return;
  window.__zhuijuIOSReady = true;

  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
    AbortSignal.timeout = function (milliseconds) {
      var controller = new AbortController();
      var timer = setTimeout(function () {
        controller.abort(new DOMException('请求超时', 'TimeoutError'));
      }, milliseconds);
      controller.signal.addEventListener('abort', function () { clearTimeout(timer); }, { once: true });
      return controller.signal;
    };
  }

  if (!Array.prototype.at) {
    Object.defineProperty(Array.prototype, 'at', { configurable: true, writable: true, value: function (index) {
      var offset = Math.trunc(Number(index) || 0);
      return this[offset < 0 ? this.length + offset : offset];
    } });
  }

  var generation = 0;
  var pendingPlayback = null;
  var playbackController = null;
  var originalFetch = window.fetch;
  function hint(message) {
    var element = document.getElementById('playHint');
    if (element) element.textContent = message;
  }
  function abortError() { return new DOMException('播放请求已过期', 'AbortError'); }
  function stillSelected(index, requestGeneration) {
    var selected = document.querySelector('.ep.on');
    return requestGeneration === generation && (!selected || Number(selected.dataset.ep) === index);
  }
  function invalidate() {
    generation += 1;
    pendingPlayback = null;
    if (playbackController) playbackController.abort();
    var video = document.getElementById('video');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.querySelectorAll('source').forEach(function (source) { source.removeAttribute('src'); });
      video.load();
    }
  }
  function validResult(data, url) {
    var index = Number(url.searchParams.get('ep'));
    if (data.showId !== url.searchParams.get('show') || data.idx !== index || data.verified !== true) return false;
    if (data.kind !== 'hls' && data.kind !== 'mp4') return false;
    var media;
    try { media = new URL(data.url); } catch (error) { return false; }
    if (media.protocol !== 'https:' || !media.hostname || media.username || media.password) return false;
    var selected = document.querySelector('.ep.on');
    var label = selected ? String(selected.textContent).trim().match(/^第\s*(\d+)\s*集$/) : null;
    return !label || Number(label[1]) === data.episodeNumber;
  }
  window.fetch = async function (input, options) {
    var address = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    var url = new URL(address, window.location.href);
    var isApi = url.pathname === '/api' || url.pathname.indexOf('/api/') === 0;
    if (!isApi || (url.origin !== window.location.origin && url.origin !== 'https://kanju-api.kenzhao123.workers.dev')) {
      return originalFetch.call(window, input, options);
    }
    var target = window.location.origin + url.pathname + url.search;
    if (isApi && url.pathname === '/api/list' && !url.searchParams.get('q')) {
      var keyword = currentKeyword();
      if (keyword) {
        url.searchParams.set('q', keyword);
        target = window.location.origin + url.pathname + url.search;
      }
    }
    var next = Object.assign({}, options || {}, { credentials: 'same-origin' });
    var requestGeneration = generation;
    var index = Number(url.searchParams.get('ep'));
    var isPlayback = url.pathname === '/api/play';
    var signal, abort, controller;
    if (isPlayback) {
      if (!stillSelected(index, requestGeneration)) throw abortError();
      if (playbackController) playbackController.abort();
      controller = playbackController = new AbortController();
      signal = next.signal || (input instanceof Request ? input.signal : null);
      abort = function () { controller.abort(); };
      if (signal) {
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }
      next.signal = controller.signal;
    }
    var response;
    try {
      response = await originalFetch.call(window, input instanceof Request ? new Request(target, input) : target, next);
      if (response.status === 401) {
        var denied = await response.clone().json().catch(function () { return {}; });
        if (denied.error === 'unauthorized') {
          pendingPlayback = null;
          hint('网站访问凭证已过期，请重新输入网站访问密码');
          if (!window.__zhuijuAccessRedirecting) {
            window.__zhuijuAccessRedirecting = true;
            window.location.replace('/__login?next=' + encodeURIComponent(window.location.pathname + window.location.search));
          }
          throw new Error('网站访问凭证已过期');
        }
      }
      if (!isPlayback) return response;
      if (!stillSelected(index, requestGeneration) || controller !== playbackController || controller.signal.aborted) throw abortError();
      if (!response.ok) return response;
      var data = await response.clone().json();
      if (!stillSelected(index, requestGeneration) || controller !== playbackController || controller.signal.aborted) throw abortError();
      if (data.error) return response;
      if (!validResult(data, url)) {
        hint('片源身份或集数校验失败，已停止播放，请重试本集或切换线路');
        throw new Error('片源身份或集数校验失败');
      }
      pendingPlayback = { index: index, generation: requestGeneration, url: data.url };
      return response;
    } finally {
      if (isPlayback && signal) signal.removeEventListener('abort', abort);
    }
  };

  var speeds = [1, 1.5, 2, 2.5, 3];
  function savedSpeed() {
    try {
      var value = Number(localStorage.getItem('kj-speed') || 1);
      return speeds.indexOf(value) >= 0 ? value : 1;
    } catch (error) { return 1; }
  }
  function applySpeed(event) {
    var media = event.target;
    if (!media || media.tagName !== 'VIDEO') return;
    var rate = savedSpeed();
    if (Math.abs(media.playbackRate - rate) > 0.001) {
      try { media.playbackRate = rate; } catch (error) { /* 播放器尚不可调速 */ }
    }
  }
  document.addEventListener('play', applySpeed, true);
  document.addEventListener('loadedmetadata', applySpeed, true);

  function startPending(event) {
    var video = event.target;
    if (!video || video.id !== 'video' || !pendingPlayback || document.visibilityState === 'hidden') return;
    var pending = pendingPlayback;
    if (!stillSelected(pending.index, pending.generation)) return;
    if ((video.currentSrc || video.src) !== pending.url || video.readyState < 1) return;
    pendingPlayback = null;
    applySpeed(event);
    var promise = video.play();
    if (promise) promise.catch(function () { hint('片源已准备好，请点击播放器中的播放按钮'); });
  }
  document.addEventListener('canplay', startPending, true);
  document.addEventListener('loadedmetadata', startPending, true);
  document.addEventListener('click', function (event) {
    var target = event.target.closest ? event.target : event.target.parentElement;
    if (!target) return;
    if (target.closest('#iosFullBtn')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleFullscreen();
      return;
    }
    if (target.closest('[data-ep], [data-play], [data-line], #nextEpBtn')) invalidate();
    if (target.closest('#pipBtn')) {
      var video = document.getElementById('video');
      if (video && typeof video.webkitSetPresentationMode === 'function'
          && typeof video.webkitSupportsPresentationMode === 'function'
          && video.webkitSupportsPresentationMode('picture-in-picture')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        try { video.webkitSetPresentationMode(video.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture'); }
        catch (error) { hint('暂时无法开启画中画'); }
      }
    }
  }, true);
  document.addEventListener('change', function (event) {
    if (event.target.id === 'lineSelect') invalidate();
  }, true);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'hidden') return;
    pendingPlayback = null;
    var video = document.getElementById('video');
    if (video && video.webkitPresentationMode !== 'picture-in-picture') video.pause();
  });

  function prepareLayout() {
    var style = document.createElement('style');
    style.id = 'iosShellStyle';
    style.textContent = [
      /* 全屏：竖屏也铺满，横屏时整屏播放，不再只有中间一条 */
      'html[data-ios-immersive] #player{position:fixed!important;inset:0!important;width:100%!important;height:100%!important;z-index:10000!important;border-radius:0!important;margin:0!important;background:#000!important;display:flex!important;align-items:center!important;justify-content:center!important}',
      'html[data-ios-immersive] #player video{width:100%!important;height:100%!important;aspect-ratio:auto!important;object-fit:contain!important;background:#000}',
      'html[data-ios-immersive],html[data-ios-immersive] body{overflow:hidden!important}',
      'html[data-ios-immersive] #playTools{position:fixed!important;top:calc(8px + env(safe-area-inset-top,0px))!important;right:12px!important;left:auto!important;z-index:10001!important;margin:0!important;background:rgba(16,24,28,.93);padding:6px;border-radius:10px}',
      'html[data-theme=\'light\'][data-ios-immersive] #playTools{background:rgba(255,255,255,.96)!important}',
      'html[data-ios-immersive] #playTools .dm-input{display:none!important}',
      'html[data-ios-immersive] .p-label{display:none!important}',
      'html[data-ios-immersive] #lineBar,html[data-ios-immersive] #settingsPanel{position:fixed!important;top:64px!important;right:12px!important;z-index:10002!important;max-height:65vh!important;overflow:auto;background:#10181c;padding:12px;border-radius:12px}',
      'html[data-theme=\'light\'][data-ios-immersive] #lineBar,html[data-theme=\'light\'][data-ios-immersive] #settingsPanel{background:#ffffff!important;border:1px solid rgba(15,20,24,.1)}',
      'html[data-ios-immersive] #lineBar[hidden],html[data-ios-immersive] #settingsPanel[hidden]{display:none!important}',
      /* 浅色主题：底栏是白底，文字必须转深色 */
      'html[data-theme=\'light\'] .tabbar .tab{color:rgba(15,20,24,.6)!important}',
      'html[data-theme=\'light\'] .tabbar .tab.on{color:#0b8a5f!important;background:rgba(18,153,111,.13)!important}',
      'html[data-theme=\'light\'] .tabbar .tab.center .tb-label{color:#0b8a5f!important}',
      'html[data-theme=\'light\'] .tabbar .tab-circle{color:#04241a!important}',
      /* 分类卡片横排：列宽固定，避免「更新至第N集」被平分挤压、重叠 */
      '@media (max-width:1099px){.cat-list{grid-template-columns:none!important;grid-auto-flow:column!important;grid-auto-columns:168px!important;gap:10px!important}.cat-list .ccard{width:168px!important}}',
      /* 选集卡片：长标签（第100集 / 第2集 预告）换行也不互压 */
      '.ep-grid{grid-auto-rows:minmax(38px,auto)!important}',
      '.ep{min-height:38px!important;height:auto!important;padding:4px 6px!important;line-height:1.2!important;text-align:center;overflow-wrap:anywhere}',
      '@media (max-width:639px){.ep-grid{grid-auto-rows:minmax(42px,auto)!important}.ep{min-height:42px!important}}',
      /* 触屏没有 hover：iOS 会把最后一次点的按钮的 :hover 粘住，
         某集文字发黑看着像“被加了粗”，其实只是 hover 没褪。按粗指针重置回常态。 */
      '@media (hover:none){#epGrid .ep:hover{color:var(--ink-66)!important;background:rgba(255,255,255,.05)!important}html[data-theme=\'light\'] #epGrid .ep:hover{color:var(--ink-66)!important;background:rgba(15,20,24,.04)!important}#epGrid .ep.on:hover{color:var(--mint-text)!important;background:rgba(22,224,157,.16)!important}html[data-theme=\'light\'] #epGrid .ep.on:hover{color:#0b8a5f!important;background:rgba(18,153,111,.14)!important}}'
    ].join('\n');
    document.head.appendChild(style);
    ensureFullButton();
    applyImmersive();
    installPlaybackGuard();
  }

  /* ---------- 播放启动兜底（iOS 上 play() 可能被拒绝或卡住 → 黑屏） ---------- */
  function hintText(text) {
    var hint = document.getElementById('playHint');
    if (hint) hint.textContent = text;
  }

  function installPlaybackGuard() {
    var proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
    if (!proto || typeof proto.play !== 'function' || proto.play.__iosWrapped) return;
    var original = proto.play;
    var retried = false;
    var wrapped = function () {
      var media = this;
      var result = original.apply(media, arguments);
      if (!result || typeof result.catch !== 'function') return result;
      result.catch(function (error) {
        var name = (error && error.name) || 'Error';
        // 黑屏最常见成因：play() 被拒绝但页面仍写着“可直接播放”，用户只看到黑屏。
        // 先在用户下一次触摸时重试一次，仍失败就把原因写出来。
        if (!retried) {
          retried = true;
          var retry = function () {
            document.removeEventListener('touchend', retry, true);
            document.removeEventListener('pointerup', retry, true);
            var again = original.call(media);
            if (again && again.catch) {
              again.catch(function () {
                hintText('播放器没有开始播放（' + name + '），请再点一次本集或换一条线路。');
              });
            }
          };
          document.addEventListener('touchend', retry, true);
          document.addEventListener('pointerup', retry, true);
          hintText('播放器还没开始播放，点一下画面重试。');
          return;
        }
        hintText('播放器没有开始播放（' + name + '），请再点一次本集或换一条线路。');
      });
      return result;
    };
    wrapped.__iosWrapped = true;
    proto.play = wrapped;
  }

  /* ---------- 选集「显示全部」展开后保持当前集高亮 ---------- */
  document.addEventListener('click', function (event) {
    var more = event.target && event.target.closest ? event.target.closest('#epMore') : null;
    if (!more) return;
    var active = document.querySelector('.ep.on');
    var activeIdx = active ? active.dataset.ep : null;
    if (activeIdx === null) return;
    // 站点展开时会把高亮重置成第 1 集，这里在下一帧改回来
    var restore = function () {
      var grid = document.getElementById('epGrid');
      if (!grid) return;
      var buttons = grid.querySelectorAll('.ep');
      for (var i = 0; i < buttons.length; i++) buttons[i].classList.toggle('on', buttons[i].dataset.ep === activeIdx);
    };
    if (typeof Promise !== 'undefined') Promise.resolve().then(restore).then(function () { setTimeout(restore, 0); });
    else setTimeout(restore, 0);
  }, true);

  /* ---------- 全屏 / 横屏 ---------- */
  var userFullscreen = false;
  var activePlayback = false;

  function postNative(payload) {
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.iosPlayer) {
        window.webkit.messageHandlers.iosPlayer.postMessage(payload);
      }
    } catch (error) { /* 原生通道不可用时退化为页面内全屏 */ }
  }

  function landscape() {
    if (typeof window.matchMedia === 'function') {
      try { return !!window.matchMedia('(orientation: landscape)').matches; } catch (error) { /* 老内核 */ }
    }
    return Number(window.innerWidth) > Number(window.innerHeight);
  }

  function syncFullButton() {
    var button = document.getElementById('iosFullBtn');
    if (button) button.textContent = userFullscreen ? '退出全屏' : '全屏';
  }

  function applyImmersive() {
    var root = document.documentElement;
    if (!root || typeof root.setAttribute !== 'function') return;
    var immersive = userFullscreen || (activePlayback && landscape());
    if (immersive) root.setAttribute('data-ios-immersive', '');
    else root.removeAttribute('data-ios-immersive');
    syncFullButton();
  }

  function setUserFullscreen(on) {
    userFullscreen = !!on;
    // 进场时补一个播放态，退出时清掉，避免刚退出又被「横屏播放自动沉浸」拉回去
    activePlayback = userFullscreen;
    applyImmersive();
    postNative({ action: userFullscreen ? 'fullscreen' : 'inline' });
  }

  function toggleFullscreen() {
    if (userFullscreen) {
      var playing = document.getElementById('video');
      if (playing && typeof playing.webkitExitFullscreen === 'function' && playing.webkitDisplayingFullscreen) {
        try { playing.webkitExitFullscreen(); } catch (error) { /* 已经不在原生全屏 */ }
      }
      setUserFullscreen(false);
      return;
    }
    setUserFullscreen(true);
  }

  function ensureFullButton() {
    var tools = document.getElementById('playTools');
    if (!tools || typeof tools.appendChild !== 'function' || typeof document.createElement !== 'function') return;
    if (document.getElementById('iosFullBtn')) return;
    var button = document.createElement('button');
    button.id = 'iosFullBtn';
    button.type = 'button';
    button.className = 'pp-tool';
    button.textContent = userFullscreen ? '退出全屏' : '全屏';
    button.setAttribute('aria-label', '全屏播放');
    var pip = document.getElementById('pipBtn');
    var next = document.getElementById('nextEpBtn');
    /* 0.1.1 的那一排按钮（显示设置/线路/弹幕/画中画/下一集）宽度刚好占满一行，
       插在中间会把「下一集」挤到第二行；所以固定接在「下一集」后面，原排布局不变，
       只有多出来的这个「全屏」落到下一行。 */
    if (next && next.parentNode === tools && typeof tools.insertBefore === 'function') tools.insertBefore(button, next.nextSibling);
    else if (pip && pip.parentNode === tools && typeof tools.insertBefore === 'function') tools.insertBefore(button, pip.nextSibling);
    else tools.appendChild(button);
  }

  /* ---------- 搜索关键词兜底 ---------- */
  function currentKeyword() {
    var input = document.getElementById('q');
    if (input && typeof input.value === 'string' && input.value.trim()) return input.value.trim();
    // 搜索结果页可能把关键词放在地址栏里，输入框已被清空
    try {
      var fromUrl = new URLSearchParams(window.location.search).get('q');
      if (fromUrl && fromUrl.trim()) return fromUrl.trim();
    } catch (error) { /* 老内核 */ }
    return '';
  }
  document.addEventListener('play', function (event) {
    if (event.target.id !== 'video') return;
    document.documentElement.setAttribute('data-ios-playing', '');
    activePlayback = true;
    applyImmersive();
  }, true);
  ['ended', 'emptied', 'error'].forEach(function (name) {
    document.addEventListener(name, function (event) {
      if (event.target.id !== 'video') return;
      document.documentElement.removeAttribute('data-ios-playing');
      activePlayback = false;
      if (userFullscreen) {
        userFullscreen = false;
        postNative({ action: 'inline' });
      }
      applyImmersive();
    }, true);
  });
  ['webkitbeginfullscreen', 'webkitendfullscreen'].forEach(function (name) {
    document.addEventListener(name, function (event) {
      if (!event.target || event.target.id !== 'video') return;
      setUserFullscreen(name === 'webkitbeginfullscreen');
    }, true);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && userFullscreen) setUserFullscreen(false);
  }, true);
  function onWindow(name, handler) {
    if (window && typeof window.addEventListener === 'function') window.addEventListener(name, handler);
  }
  onWindow('resize', function () {
    applyImmersive();
  });
  onWindow('orientationchange', function () {
    applyImmersive();
  });
  /* ---------- 首页日期条：一进来停在今天（只在条内横向定位，不动页面） ---------- */
  var stripTouched = false;
  var stripObserver = null;

  function markStripTouched(event) {
    var days = document.getElementById('days');
    if (!days || !event || !event.target) return;
    if (event.target === days || (typeof days.contains === 'function' && days.contains(event.target))) stripTouched = true;
  }

  /* 返回 false 表示今天那张卡还没渲染出来，可以再试一次。
     用「卡片自己身上的标记」判断是否已处理：站点重新渲染 #days 会换掉整批卡片，
     新卡片没有标记 → 会自动再居中一次；用户手动拖动后卡片不变 → 不再抢滚动条。 */
  function centerTodayStrip() {
    var days = document.getElementById('days');
    if (!days || typeof days.querySelector !== 'function') return false;
    var active = days.querySelector('.day.on');
    if (!active) return false;
    if (!active.dataset) return true;
    if (active.dataset.iosCentred) return true;
    active.dataset.iosCentred = '1';
    if (stripTouched) return true;
    var max = Math.max(0, days.scrollWidth - days.clientWidth);
    if (max <= 0) return true;
    var stripRect = days.getBoundingClientRect();
    var activeRect = active.getBoundingClientRect();
    /* 日期条是 scroll-snap 容器（每张卡一个 snap 点），居中会被吸附回卡片边界，
       所以把今天对齐到可视区起点，结果稳定；夹在 [0, max] 之间。 */
    var target = days.scrollLeft + (activeRect.left - stripRect.left);
    days.scrollLeft = Math.min(max, Math.max(0, target));
    return true;
  }

  function watchStrip() {
    if (stripObserver || typeof MutationObserver !== 'function') return;
    var days = document.getElementById('days');
    if (!days) return;
    stripObserver = new MutationObserver(function () {
      centerTodayStrip();
    });
    stripObserver.observe(days, { childList: true });
  }

  function scheduleStripCentering() {
    var delays = [0, 250, 700, 1500, 3000];
    for (var i = 0; i < delays.length; i++) {
      (function (delay) {
        setTimeout(function () {
          if (centerTodayStrip()) watchStrip();
        }, delay);
      }(delays[i]));
    }
  }

  document.addEventListener('touchstart', markStripTouched, true);
  document.addEventListener('pointerdown', markStripTouched, true);
  scheduleStripCentering();
  onWindow('popstate', scheduleStripCentering);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', prepareLayout, { once: true });
  } else {
    prepareLayout();
  }
  document.addEventListener('DOMContentLoaded', function () {
    ensureFullButton();
  }, { once: true });
}());
