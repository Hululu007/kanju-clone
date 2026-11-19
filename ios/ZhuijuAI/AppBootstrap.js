(function () {
  'use strict';
  if (window.top !== window) return;
  var TEST_ORIGIN = String(window.__zhuijuTestOrigin || '');
  if (window.location.protocol !== 'https:' || window.location.hostname !== 'zhuiju.dpdns.org') {
    /* 出包关卡的截图工作流要在一个同机夹具站上真点一遍；只认原生在测试进程里
       注入的这一个 origin，正式包里没有这个变量，下面的 early return 照常生效。 */
    if (!TEST_ORIGIN || window.location.origin !== TEST_ORIGIN) return;
  }
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
  /* 批量下载逐集解析片源时，同一个 /api/play 不应该按「当前正在播放的那一集」校验：
     否则除了当前集以外每一集都会被当成过期请求中止。计数只在解析期间 > 0。 */
  var batchResolving = 0;
  var pendingPlayback = null;
  var playbackController = null;
  var originalFetch = window.fetch;
  function hint(message) {
    var element = document.getElementById('playHint');
    if (element) element.textContent = message;
  }
  function abortError() { return new DOMException('播放请求已过期', 'AbortError'); }
  /* 片源只允许 https；测试夹具站是自己的同机 http 服务时，只放行那个 host。 */
  function allowedMediaOrigin(media) {
    if (media.protocol === 'https:') return true;
    if (!TEST_ORIGIN) return false;
    try { return media.origin === TEST_ORIGIN && media.hostname === new URL(TEST_ORIGIN).hostname; } catch (error) { return false; }
  }
  function stillSelected(index, requestGeneration) {
    var selected = document.querySelector('.ep.on');
    return requestGeneration === generation && (!selected || Number(selected.dataset.ep) === index);
  }
  function invalidate() {
    generation += 1;
    pendingPlayback = null;
    mediaMemo = { url: '', ep: '' };
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
    if (!allowedMediaOrigin(media) || !media.hostname || media.username || media.password) return false;
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
    var isPlayback = url.pathname === '/api/play' && batchResolving === 0;
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
      if (batchResolving === 0 && !validResult(data, url)) {
        hint('片源身份或集数校验失败，已停止播放，请重试本集或切换线路');
        throw new Error('片源身份或集数校验失败');
      }
      pendingPlayback = { index: index, generation: requestGeneration, url: data.url };
      /* iOS 原生 HLS 会把 video.currentSrc 改成 blob:；保留已校验的原始直链，
         让外放/下载状态和实际成功解析的这一集保持一致。 */
      mediaMemo = { url: data.url, ep: String(index) };
      return response;
    } finally {
      if (isPlayback && signal) signal.removeEventListener('abort', abort);
    }
  };

  /* 应用内品牌图：与随包分发的图标同源（用户提供的爆米花角色），以 data URI 内联，
     这样站点还没部署新资源时也能立刻换掉两处旧 Logo。 */
  var BRAND_LOGO = 'data:image/webp;base64,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';

  var speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  var SETTING_DEFAULTS = {
    'kj-speed': '1', 'kj-skip-intro': '1', 'kj-skip-outro': '0', 'kj-hq': '0',
    'kj-dm': '1', 'kj-dm-opacity': '0.9', 'kj-dm-size': '18', 'kj-dm-speed': '8', 'kj-dm-area': '100'
  };
  var settingValue;
  var setSettingValue;
  function savedSpeed() {
    try {
      var value = Number(localStorage.getItem('kj-speed') || SETTING_DEFAULTS['kj-speed']);
      return speeds.indexOf(value) >= 0 ? value : 1;
    } catch (error) { return 1; }
  }
  function applySpeed(event) {
    var media = event && event.target ? event.target : document.getElementById('video');
    if (!media || media.tagName !== 'VIDEO') return;
    var rate = savedSpeed();
    if (Math.abs(media.playbackRate - rate) > 0.001) {
      try { media.playbackRate = rate; } catch (error) { /* 播放器尚不可调速 */ }
    }
  }
  document.addEventListener('play', applySpeed, true);
  document.addEventListener('loadedmetadata', applySpeed, true);
  document.addEventListener('ratechange', function (event) {
    if (event.target && event.target.id === 'video') {
      var rate = Number(event.target.playbackRate);
      if (speeds.indexOf(rate) >= 0) writeStore('kj-speed', String(rate));
    }
  }, true);
  document.addEventListener('loadedmetadata', function (event) {
    if (event.target.id === 'video') applyEnhancePreference(event.target);
  }, true);

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
    if (!event.target) return;
    var target = event.target.closest ? event.target : event.target.parentElement;
    if (!target) return;
    var downloadTrigger = target.closest ? target.closest('#iosTitleDownload') : null;
    if (downloadTrigger) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeMinePage();
      openDownloadPage();
      return;
    }
    var preferenceControl = target.closest ? target.closest('[data-setting-action],[data-theme-setting],[data-setting-toggle],#iosDanmakuExpand') : null;
    if (preferenceControl && handleSettingsClick(preferenceControl)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (settingsTriggerHit(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openSettingsSheet();
      return;
    }
    if (handleSettingsClick(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (handleCtrlClick(event)) return;
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
    if (event.target.id === 'iosSettingSpeed') setRate(event.target.value);
    var playerSpeed = document.getElementById('kjSettingSpeed');
    if (event.target === playerSpeed) setRate(event.target.value);
    var key = event.target && event.target.getAttribute ? event.target.getAttribute('data-dm-setting') : null;
    if (key) setSettingValue(key, event.target.value);
  }, true);
  document.addEventListener('input', function (event) {
    var key = event.target && event.target.getAttribute ? event.target.getAttribute('data-dm-setting') : null;
    if (key && key !== 'kj-dm-area') setSettingValue(key, event.target.value);
  }, true);
  document.addEventListener('change', function (event) {
    if (!event.target || !event.target.getAttribute) return;
    var preference = event.target.getAttribute('data-ios-pref');
    if (preference) setSettingValue(preference, event.target.value);
  }, true);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'hidden') {
      /* 回到前台：让原生把后台会话里的最新进度/终态补回来 */
      postNative({ action: 'downloadSync' });
      syncDownloadRow();
      return;
    }
    pendingPlayback = null;
    var video = document.getElementById('video');
    if (video && video.webkitPresentationMode !== 'picture-in-picture') video.pause();
  });

  function prepareLayout() {
    applyDanmakuPreference();
    var initialTheme = readStore('kj-theme');
    if (initialTheme) document.documentElement.setAttribute('data-theme', initialTheme);
    var style = document.createElement('style');
    style.id = 'iosShellStyle';
    style.textContent = [
      'html{--brand-logo:url("' + BRAND_LOGO + '")}',
      /* 滚动中 WKWebView 曾短暂切到 WebKit.GPU 并丢掉卡片图层。
         首页背景原本由两个全屏 fixed pseudo-element + mask/filter 组成，
         会长期占用独立 GPU surface；改成根视图的一张静态渐变，减少滚动层回收压力。 */
      'html{background-color:#07131b!important;background-image:linear-gradient(90deg,rgba(0,0,0,.2),rgba(0,0,0,0) 58%),radial-gradient(125% 95% at 100% 0%,#15333a 0%,rgba(21,51,58,0) 58%),radial-gradient(80% 60% at 62% -12%,#0e2530 0%,rgba(14,37,48,0) 60%),linear-gradient(180deg,#0b1f2b 0%,#0a1a26 42%,#07131b 100%);background-attachment:fixed}',
      "html[data-theme='light']{background-color:#eef1f4!important;background-image:radial-gradient(125% 95% at 100% 0%,#d8f3ea 0%,rgba(216,243,234,0) 58%),linear-gradient(180deg,#f7fafb 0%,#eef1f4 45%,#e6ebee 100%)}",
      'body{background:transparent!important}',
      'body:before,body:after{content:none!important;display:none!important}',
      /* WKWebView 用唯一主滚动容器；不要让卡片 hover/隔离再为每张海报建立合成层。 */
      '.main{-webkit-overflow-scrolling:touch;transform:none!important;will-change:auto!important}',
      '.pcard-link{isolation:auto!important;transition:none!important;transform:none!important}',
      '@media(hover:none){.pcard-link:hover{transform:none!important}}',
      /* 全屏：竖屏也铺满，横屏时整屏播放，不再只有中间一条 */
      'html[data-ios-immersive] #pwGrid,html[data-ios-immersive] .pw-grid,html[data-ios-immersive] .pw-stage{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;height:100dvh!important;max-width:none!important;margin:0!important;padding:0!important;overflow:hidden!important;z-index:9997!important;background:#000!important}',
      'html[data-ios-immersive] #player{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;height:100dvh!important;max-width:none!important;aspect-ratio:auto!important;z-index:10000!important;border-radius:0!important;margin:0!important;padding:0!important;background:#000!important;overflow:hidden!important;display:block!important}',
      'html[data-ios-immersive] #player video:not([data-ios-fit-box]){position:absolute!important;inset:0!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;aspect-ratio:auto!important;object-fit:contain!important;background:#000}',
      '#player>:not(video):not(.dm-layer):not(#iosTopBar):not(#iosFsTop):not(#iosFsMenu):not(#iosFsSide):not(#iosFsRow2):not(#ppCtrl):not(#iosPlaySettings):not(#iosTopBar):not(#iosFsTop),#playTools,.pp-toolbar,#plCtrl,.pl-top,.pl-ctrl,.pl-epov,.pl-bigplay,#btnWebFull,#btnFull,#btnGear,#btnPip{display:none!important;visibility:hidden!important;pointer-events:none!important}',
      /* 画面档位：三条写在沉浸态那条之后，同样的优先级下由它们覆盖 contain。
         适应=完整画面（可留边），裁剪=等比铺满（裁边），拉伸=不等比铺满。 */
      /* 画面填充不走 object-fit：真机上站点给 video 的盒子和内联样式会把它盖掉，
         用户看到的就是「点了没反应」。三档改成按 videoWidth/videoHeight 直接算元素
         几何（见 applyFitGeometry），渲染层必须照做，没有第二条样式可以顶掉它。 */
      '#player video[data-ios-fit-box]{position:absolute!important;left:50%!important;top:50%!important;inset:auto!important;transform:translate(-50%,-50%)!important;max-width:none!important;max-height:none!important;object-fit:fill!important;background:#000}',
      'html[data-ios-immersive],html[data-ios-immersive] body{overflow:hidden!important}',
      /* 全屏：上方那一排「显示设置 / 线路 / 弹幕 / 画中画 / 下一集」整条收起。
         它原本被固定到右上角，正好压在画面上，是真机上最挡视线的一排；
         全屏只保留底部控制栏（播放 · 进度 · 外放 · 倍速 · 退出全屏）。 */
      'html[data-ios-immersive] #playTools{display:none!important}',
      'html[data-ios-immersive] #settingsPanel,html[data-ios-immersive] #lineBar{display:none!important}',
      'html[data-ios-immersive] .tabbar{display:none!important;visibility:hidden!important;pointer-events:none!important}',
      'html[data-ios-immersive] .p-label{display:none!important}',
      /* 全屏里压在最上面的其实是站点头栏（返回 + 片名 + 菜单）。
         它和播放器不在同一个层叠上下文里，z-index 压不住，只能直接收起来。 */
      'html[data-ios-immersive] .page-head{display:none!important}',
      'html[data-ios-immersive] .topbar{display:none!important}',
      /* 真机横屏全屏时画面上方还空着一条 60px 高的深灰带（截图里就是它挡着画面）。
         站点移动端把滚动容器写成 `.main{margin-top:60px;height:calc(100vh - 60px)}`，
         而它又带 `-webkit-overflow-scrolling:touch`：WebKit 会把里面的 position:fixed
         “收编”成相对这个滚动容器定位，于是 #player 只铺满了 .main 那一块（正好少掉顶部
         60px 页头高度），上面露出页面背景。全屏时把 .main 本身铺满整屏：
         不管 fixed 以视口还是以它为参照，#player 都正好盖住整块屏幕。 */
      'html[data-ios-immersive] body{position:fixed!important;inset:0!important;width:100%!important;height:100%!important;margin:0!important;padding:0!important;overflow:hidden!important}',
      'html[data-ios-immersive] .main{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;height:100dvh!important;min-height:100vh!important;margin:0!important;padding:0!important;overflow:hidden!important;-webkit-overflow-scrolling:auto!important;transform:none!important;z-index:9998!important}',
      'html[data-ios-immersive] #iosTopBar{display:none!important}',
      'html[data-ios-immersive] #iosFsTop,html[data-ios-immersive] #ppCtrl,html[data-ios-immersive] #iosFsMenu{position:fixed!important;z-index:10006!important}',
      /* 老播放器的站点控件与新版原生式控制栏重叠；iOS 只显示新版这一套。 */
      '#playTools,.pp-toolbar,.pl-top,.pl-controls,.pl-bottom,.pl-tools,#plControls,#btnWebFull,#btnFull,#btnGear,#btnPip{display:none!important;visibility:hidden!important;pointer-events:none!important}',
      'html[data-ios-immersive] body{margin:0!important;padding:0!important}',
      'html[data-ios-immersive] .ph-back{display:none!important}',
      'html[data-ios-immersive] .ph-title{display:none!important}',
      /* 站点的「全屏」按钮优先走标准全屏 API（player.requestFullscreen），
         这条路不经过 data-ios-immersive，片名标题和工具条会留在画面上。
         用 :fullscreen 兜住：无论谁开的全屏，标题都不许压在视频上。
         两条分开写：不认识 -webkit- 别名的内核不会把整条规则一起丢掉。 */
      '#player:fullscreen .p-label{display:none!important}',
      '#player:-webkit-full-screen .p-label{display:none!important}',
      '#player:fullscreen .pp-toolbar,#player:fullscreen .tabbar,#player:fullscreen .dm-input{display:none!important}',
      '#player:-webkit-full-screen .pp-toolbar,#player:-webkit-full-screen .tabbar,#player:-webkit-full-screen .dm-input{display:none!important}',
      /* 全屏里可能残留的其他浮层入口（弹幕输入、画中画、下一集、提示行等）一并收起 */
      'html[data-ios-immersive] .pp-toolbar,html[data-ios-immersive] .dm-input,html[data-ios-immersive] #dmInputWrap,html[data-ios-immersive] .pp-hint,html[data-ios-immersive] #playHint{display:none!important}',
      /* 跳过片头/片尾和挂件上移，避免和底部控制栏叠在一起 */
      'html[data-ios-immersive] .skip-btn{bottom:calc(58px + env(safe-area-inset-bottom,0px))!important}',
      'html[data-ios-immersive] #ppCtrl{z-index:10003!important;padding:8px 10px calc(10px + env(safe-area-inset-bottom,0px))!important;gap:6px!important}',
      /* 沉浸态按钮变大后，「退出全屏」四个字会把整条挤出屏幕（实测 387 > 367）。
         收紧左右内边距、给按钮固定宽度、让进度条吃掉剩余空间，按钮就不会被裁。 */
      'html[data-ios-immersive] #ppCtrl .pc-btn{font-size:13px;padding:10px 9px;min-height:42px;flex:0 0 auto}',
      'html[data-ios-immersive] #ppCtrl .pc-time{flex:0 0 auto;font-size:11px}',
      'html[data-ios-immersive] #ppCtrl .pc-seek{height:30px;min-width:40px}',
      'html[data-ios-immersive] #ppCtrl{min-width:0}',
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
      /* 手势标签由注入层处理横向切页，纵向仍交给页面滚动，避免 WebKit 抢走横滑。 */
      '.pp-tabs{touch-action:pan-y;overscroll-behavior-x:contain}',
      /* 触屏没有 hover：iOS 会把最后一次点的按钮的 :hover 粘住，
         某集文字发黑看着像“被加了粗”，其实只是 hover 没褪。按粗指针重置回常态。 */
      '@media (hover:none){#epGrid .ep:hover{color:var(--ink-66)!important;background:rgba(255,255,255,.05)!important}html[data-theme=\'light\'] #epGrid .ep:hover{color:var(--ink-66)!important;background:rgba(15,20,24,.04)!important}#epGrid .ep.on:hover{color:var(--mint-text)!important;background:rgba(22,224,157,.16)!important}html[data-theme=\'light\'] #epGrid .ep.on:hover{color:#0b8a5f!important;background:rgba(18,153,111,.14)!important}}',
      /* ---------- 自带播放控制栏 + 品牌图 ---------- */
      '#ppCtrl{position:absolute;left:0;right:0;bottom:0;z-index:6;display:flex;align-items:center;gap:6px;padding:6px 8px calc(6px + env(safe-area-inset-bottom,0px));background:linear-gradient(to top,rgba(0,0,0,.82),rgba(0,0,0,.44) 55%,rgba(0,0,0,0));color:#fff;transition:opacity .18s ease}',
      /* 全屏里控制栏收起来时整条消失：不留半透明底栏、不留渐变，画面上只剩视频本身。 */
      '#ppCtrl.pc-hidden{opacity:0!important;visibility:hidden!important;pointer-events:none!important}',
      '#ppCtrl .pc-btn{appearance:none;-webkit-appearance:none;border:0;background:transparent;color:#fff;font-size:12px;font-weight:600;line-height:1;padding:9px 10px;border-radius:9px;white-space:nowrap;cursor:pointer}',
      '#ppCtrl .pc-btn:active{background:rgba(255,255,255,.2)}',
      '#ppCtrl .pc-time{font-size:11px;color:rgba(255,255,255,.85);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '#ppCtrl .pc-seek{flex:1 1 auto;min-width:54px;height:24px;margin:0;background:transparent;appearance:none;-webkit-appearance:none}',
      '#ppCtrl .pc-seek::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:rgba(255,255,255,.34)}',
      '#ppCtrl .pc-seek::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;margin-top:-5px;border:0;border-radius:50%;background:#16e09d}',
      '#ppCtrl #ppRate{background:rgba(255,255,255,.16)}',
      '#ppCtrl #ppFull{background:rgba(22,224,157,.92);color:#04241a}',
      /* 全屏 + 暂停时才在屏幕顶部出现的一排：默认 / 拉伸 / 平铺（规格 §1） */
      /* ---- 0.1.17 五屏规格（ios/UX_SPEC.md） ---- */
      /* 全屏顶部栏：左 返回 + 剧名 + 画面模式下拉，右 投屏/分享/更多 */
      '#iosFsTop{position:absolute;left:0;right:0;top:0;z-index:10006;display:none;align-items:center;gap:8px;padding:calc(8px + env(safe-area-inset-top,0px)) 12px 10px;background:linear-gradient(to bottom,rgba(0,0,0,.8),rgba(0,0,0,0))}',
      '#iosFsTop.on{display:flex}',
      '#iosFsTop .iosfs-btn{appearance:none;border:0;background:transparent;color:#fff;font-size:13px;font-weight:600;padding:8px 6px;min-height:40px;min-width:36px}',
      '#iosFsTop .iosfs-title{flex:1 1 auto;min-width:0;font-size:13px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#iosFsTop .iosfs-fit{border:1px solid rgba(255,255,255,.4);border-radius:8px;padding:7px 10px;background:rgba(0,0,0,.4);color:#fff;font-size:12px;font-weight:600;min-height:34px}',
      '#iosFsMenu{position:absolute;z-index:10007;top:calc(52px + env(safe-area-inset-top,0px));left:12px;display:none;flex-direction:column;min-width:112px;padding:6px;border-radius:10px;background:rgba(12,18,22,.97);border:1px solid rgba(255,255,255,.16)}',
      '#iosFsMenu.on{display:flex}',
      '#iosFsMenu button{border:0;background:transparent;color:#fff;font-size:13px;font-weight:600;text-align:left;padding:11px 14px;border-radius:8px;min-height:42px}',
      '#iosFsMenu button.on{background:rgba(22,224,157,.22);color:#16e09d}',
      /* 全屏左右居中的锁屏 / 截图 */
      '#iosFsSide{position:absolute;top:50%;transform:translateY(-50%);z-index:10005;display:none;flex-direction:column;gap:18px}',
      '#iosFsSide.on{display:flex}',
      '#iosFsSide.left{left:14px}',
      '#iosFsSide.right{right:14px}',
      '#iosFsSide button{appearance:none;border:0;border-radius:50%;width:44px;height:44px;background:rgba(0,0,0,.45);color:#fff;font-size:17px}',
      /* 全屏第二排：字幕 / 倍速 / 画质 / 选集 / 下一集 */
      '#iosFsRow2{position:absolute;left:0;right:0;bottom:0;z-index:10005;display:none;align-items:center;justify-content:flex-end;gap:4px;padding:0 10px calc(8px + env(safe-area-inset-bottom,0px))}',
      '#iosFsRow2.on{display:flex}',
      '#iosFsRow2 button{appearance:none;border:0;background:transparent;color:#fff;font-size:12px;font-weight:600;padding:9px 10px;min-height:40px}',
      /* 播放页顶部（竖屏）：返回 + 投屏/分享/更多 */
      '#iosTopBar{position:absolute;left:0;right:0;top:0;z-index:10006;display:flex;align-items:center;gap:6px;padding:8px 10px;background:linear-gradient(to bottom,rgba(0,0,0,.62),rgba(0,0,0,0))}',
      '#iosTopBar button{appearance:none;border:0;background:transparent;color:#fff;font-size:13px;font-weight:600;padding:8px 9px;min-height:38px}',
      '#iosTopBar .iostb-title{flex:1 1 auto;min-width:0;font-size:13px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      /* 播放器下方：剧名 + 追剧 / 下载；信息行；选集标题 */
      '#iosTitleRow{display:flex;align-items:center;gap:10px;padding:12px 12px 0}',
      '#iosTitleRow .iostr-name{flex:1 1 auto;min-width:0;font-size:19px;font-weight:800;color:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#iosTitleRow button{appearance:none;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.07);color:inherit;border-radius:10px;padding:9px 11px;font-size:12px;font-weight:700;min-height:40px;white-space:nowrap}',
      '#iosTitleRow button.on{border-color:rgba(22,224,157,.6);color:#16e09d}',
      '#iosInfoRow{display:flex;align-items:center;gap:6px;padding:8px 12px 0;font-size:12px;color:rgba(232,241,245,.72);flex-wrap:wrap}',
      '#iosInfoRow .iosir-more{border:0;background:transparent;color:rgba(232,241,245,.72);font-size:12px;padding:2px 4px}',
      '#iosEpHead{display:flex;align-items:center;gap:8px;padding:14px 12px 0}',
      '#iosEpHead .ioseh-title{flex:1 1 auto;border:0;background:transparent;color:inherit;font-size:16px;font-weight:800;text-align:left;padding:0;min-height:32px}',
      /* 整页推入的下载页 / 我的下载 */
      '.ios-page{position:fixed;left:0;right:0;top:0;bottom:0;z-index:13000;display:flex;flex-direction:column;background:#0b1116;color:#e8f1f5}',
      '.ios-page[hidden]{display:none!important}',
      '.ios-page .ip-head{display:flex;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top,0px)) 14px 10px;border-bottom:1px solid rgba(255,255,255,.08)}',
      '.ios-page .ip-head .ip-title{flex:1 1 auto;font-size:16px;font-weight:800}',
      '.ios-page .ip-head button{appearance:none;border:0;background:transparent;color:#e8f1f5;font-size:14px;font-weight:600;padding:8px 6px;min-height:40px}',
      '.ios-page .ip-body{flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:12px 14px 16px}',
      '.ios-page .ip-foot{padding:10px 14px calc(12px + env(safe-area-inset-bottom,0px));border-top:1px solid rgba(255,255,255,.08);display:flex;align-items:center;gap:10px;font-size:12px;color:rgba(232,241,245,.66)}',
      '.ios-page .ip-row{display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid rgba(255,255,255,.06);font-size:13px}',
      '.ios-page .ip-row .ip-label{flex:1 1 auto;font-weight:600}',
      '.ios-page .ip-row .ip-value{color:rgba(232,241,245,.7);font-weight:600}',
      '.ios-page #iosDlQuality{border:0;background:transparent;color:rgba(232,241,245,.7);font-size:13px;font-weight:600;min-height:36px}',
      '.ios-page #iosDlGrid6{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin-top:10px}',
      '.ios-page .ip-cell{appearance:none;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:rgba(255,255,255,.06);color:#e8f1f5;font-size:12px;font-weight:700;min-height:44px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:4px}',
      '.ios-page .ip-cell .ip-cell-state{font-size:9px;font-weight:600;color:rgba(232,241,245,.62)}',
      '.ios-page .ip-cell.busy,.ios-page .ip-cell.done{border-color:rgba(22,224,157,.6);background:rgba(22,224,157,.18);color:#16e09d}',
      '.ios-page .ip-cell.busy .ip-cell-state,.ios-page .ip-cell.done .ip-cell-state{color:#16e09d}',
      '.ios-page #iosDlListBtn{flex:1 1 auto;appearance:none;border:0;border-radius:10px;background:#16e09d;color:#04241a;font-size:14px;font-weight:800;padding:12px;min-height:46px}',
      '.ios-page .ip-sub{font-size:12px;color:rgba(232,241,245,.62);margin:2px 0 10px}',
      '.ios-page #iosMineRunning{display:flex;gap:10px;align-items:center;padding:10px;border-radius:10px;background:rgba(22,224,157,.12);margin-bottom:12px}',
      '.ios-page #iosMineRunning .imr-main{flex:1 1 auto;min-width:0}',
      '.ios-page #iosMineRunning .imr-title{font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ios-page #iosMineRunning .imr-meta{font-size:11px;color:rgba(232,241,245,.66)}',
      '.ios-page .ip-show{display:flex;gap:10px;align-items:center;padding:12px 0;border-bottom:1px solid rgba(255,255,255,.06)}',
      '.ios-page .ip-show img{width:44px;height:62px;border-radius:6px;object-fit:cover;background:#182028;flex:none}',
      '.ios-page .ip-show .ips-main{flex:1 1 auto;min-width:0}',
      '.ios-page .ip-show .ips-title{font-size:14px;font-weight:700}',
      '.ios-page .ip-show .ips-meta{font-size:11px;color:rgba(232,241,245,.62);margin-top:3px}',
      '.ios-page .ip-eprow{position:relative;overflow:hidden;border-radius:9px;margin-top:8px;background:rgba(255,255,255,.05)}',
      '.ios-page .ip-eprow .ip-epbody{display:flex;align-items:center;gap:10px;padding:11px 12px;transition:transform .16s ease;will-change:transform;touch-action:pan-y}',
      '.ios-page .ip-eprow .ip-eptitle{flex:1 1 auto;font-size:13px;font-weight:600}',
      '.ios-page .ip-eprow .ip-epsize{font-size:11px;color:rgba(232,241,245,.6)}',
      '.ios-page .ip-eprow .ip-epdel{position:absolute;right:0;top:0;bottom:0;width:82px;border:0;background:#e5484d;color:#fff;font-size:13px;font-weight:700}',
      /* 播放设置面板：从右侧滑出 */
      '#iosPlaySettings{position:fixed;left:0;right:0;top:0;bottom:0;z-index:13100;display:none;background:rgba(4,8,11,.5)}',
      '#iosPlaySettings.on{display:block}',
      '#iosPlaySettings .ips-card{position:absolute;right:0;top:0;bottom:0;width:min(320px,84vw);background:#0e151b;color:#e8f1f5;padding:calc(14px + env(safe-area-inset-top,0px)) 16px calc(16px + env(safe-area-inset-bottom,0px));overflow-y:auto;box-shadow:-8px 0 24px rgba(0,0,0,.5)}',
      '#iosPlaySettings .ips-head{display:flex;align-items:center;margin-bottom:14px}',
      '#iosPlaySettings .ips-head .ips-title{flex:1 1 auto;font-size:15px;font-weight:800}',
      '#iosPlaySettings .ips-head button{appearance:none;border:0;background:transparent;color:#e8f1f5;font-size:17px;padding:6px}',
      '#iosPlaySettings .ips-icons{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px}',
      '#iosPlaySettings .ips-icons button{appearance:none;border:0;background:rgba(255,255,255,.07);color:#e8f1f5;border-radius:10px;padding:12px 4px;font-size:11px;font-weight:600;min-height:64px}',
      '#iosPlaySettings .ips-list .ips-item{display:flex;align-items:center;gap:10px;padding:13px 0;border-bottom:1px solid rgba(255,255,255,.07);font-size:13px}',
      '#iosPlaySettings .ips-list .ips-item .ips-name{flex:1 1 auto;font-weight:600}',
      '#iosPlaySettings .ips-list .ips-item .ips-val{color:rgba(232,241,245,.66);font-size:12px}',
      "html[data-theme='light'] .ios-page{background:#f6f7f9;color:#151b20}",
      "html[data-theme='light'] .ios-page .ip-head button,html[data-theme='light'] .ios-page .ip-cell{color:#151b20}",
      "html[data-theme='light'] #iosPlaySettings .ips-card{background:#fff;color:#151b20}", 
      /* 集数网格：一行 5–6 个，格子之间留正常间距（规格 §2） */
      '#iosDlGrid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin-top:8px}',
      '#iosDlGrid .ios-dl-cell{appearance:none;border:1px solid rgba(255,255,255,.16);border-radius:10px;background:rgba(255,255,255,.06);color:#e8f1f5;font-size:12px;font-weight:600;padding:10px 4px;min-height:56px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px}',
      '#iosDlGrid .ios-dl-cell .ios-dl-cell-state{font-size:10px;font-weight:600;color:rgba(232,241,245,.66)}',
      '#iosDlGrid .ios-dl-cell.busy{border-color:rgba(22,224,157,.6);background:rgba(22,224,157,.16)}',
      '#iosDlGrid .ios-dl-cell.done{border-color:rgba(22,224,157,.5);color:#16e09d}',
      '#iosDlGrid .ios-dl-cell.done .ios-dl-cell-state{color:#16e09d}',
      "html[data-theme='light'] #iosDlGrid .ios-dl-cell{background:rgba(15,20,24,.06);color:#141a1e;border-color:rgba(15,20,24,.14)}",
      '#iosDlGrid .ios-dl-cell .ios-dl-cell-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}',
      /* 已下载列表：每行左滑露出红色删除（规格 §3），不做批量 */
      /* 首页没有站点面板（只有一句「设置面板即将上线」），注入层自带一个：
         下载进度和播放方式都在里面，任何页面都能打开。 */
      '#iosSettingsSheet{position:fixed;left:0;right:0;top:0;bottom:0;z-index:12000;display:flex;align-items:flex-end;background:rgba(4,8,11,.62)}',
      '#iosSettingsSheet[hidden]{display:none!important}',
      '#iosSettingsCard{--settings-card:#262a29;--settings-muted:#a9b4af;--settings-line:#454d49;box-sizing:border-box;width:100%;max-height:100%;overflow:auto;overscroll-behavior:contain;padding:calc(16px + env(safe-area-inset-top,0px)) 16px calc(20px + env(safe-area-inset-bottom,0px));background:#161a18;color:#f4f7f5;font-size:15px;line-height:1.4}',
      'html[data-theme="light"] #iosSettingsCard{--settings-card:#fff;--settings-muted:#52625a;--settings-line:#e2ebe5;background:#edf6ef;color:#18261e;color-scheme:light}',
      '#iosSettingsHead,#iosSettingsBody{max-width:560px;margin-inline:auto}',
      '#iosSettingsHead{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:22px;font-weight:700;margin-bottom:16px}',
      '#iosSettingsClose{border:0;background:var(--settings-card);color:inherit;border-radius:50%;width:44px;height:44px;font-size:18px}',
      '.ios-set-group{margin:0 0 18px}.ios-set-group h3{font-size:15px;margin:0 0 8px}.ios-set-group h3 span{display:inline-block;width:24px;color:var(--settings-muted)}',
      '.ios-set-card{background:var(--settings-card);border-radius:12px;padding:0 14px}',
      '.ios-set-row{box-sizing:border-box;width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:50px;padding:10px 0;border:0;background:none;color:inherit;font:inherit;text-align:left}',
      '.ios-set-row+.ios-set-row{border-top:1px solid var(--settings-line)}.ios-set-row small{display:block;color:var(--settings-muted);margin-top:3px;font-size:12px}',
      '.ios-set-row i{position:relative;flex:none;width:40px;height:24px;border-radius:16px;background:#66736c}.ios-set-row i::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff}.ios-set-row.on i{background:#168344}.ios-set-row.on i::after{left:19px}',
      '.ios-set-seg{display:flex;padding:2px;border-radius:8px;background:var(--settings-line)}.ios-set-seg button,.ios-set-card select{border:0;border-radius:6px;background:var(--settings-card);color:inherit;padding:7px 10px;font:inherit}.ios-set-seg button.on{background:#168344;color:#fff}',
      '#iosDanmakuSettings:not([hidden]){display:grid;gap:12px;padding:8px 0 14px}#iosDanmakuSettings label{display:flex;align-items:center;justify-content:space-between;gap:12px}#iosDanmakuSettings input{width:55%;accent-color:#168344}',
      '@media(min-width:620px) and (min-height:610px){#iosSettingsSheet{align-items:center;justify-content:center}#iosSettingsCard{width:560px;max-height:88%;padding:16px;border-radius:16px}}',
      '#iosExtToggle{display:block;width:100%;margin:12px 0 0;padding:13px 14px;border:0;border-radius:10px;background:#16e09d;color:#04241a;font-weight:700;font-size:13px;text-align:left;min-height:44px}',
      '#iosDownloadTrack{height:6px;margin-top:9px;overflow:hidden;border-radius:4px;background:rgba(127,127,127,.3)}',
      '#iosDownloadFill{width:0;height:100%;border-radius:inherit;background:#16e09d;transition:width .15s linear}',
      '.ios-page #iosMineRunningProgress{display:block;width:100%;height:6px;margin-top:8px;accent-color:#16e09d}',
      '.ios-page #iosMineRunningProgress[hidden]{display:none}',
      '.ios-page #iosMineRunningPath{display:block;margin-top:6px;color:rgba(232,241,245,.58);font:11px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;overflow-wrap:anywhere}',
      '#iosOpenDownloaded{margin-top:10px;padding:8px 12px;border-radius:8px;background:#16e09d;color:#04241a;font-weight:700}',
      '#iosOpenDownloaded[hidden]{display:none!important}',
      /* 设置里的下载：按剧列出封面/片名/下了哪几集，再跟正在下载的进度 */
      '.ios-dl-heading{font-size:14px;font-weight:700;margin:0 0 8px}',
      '.ios-dl-running{padding:10px 12px;margin-bottom:8px;border-radius:10px;background:rgba(22,224,157,.14);color:#b8f5dd;font-size:12px;line-height:1.4}',
      '.ios-dl-running[hidden]{display:none!important}',
      '.ios-dl-show{display:flex;align-items:center;gap:10px;padding:8px;border-radius:10px;background:rgba(255,255,255,.06)}',
      '.ios-dl-show+.ios-dl-show{margin-top:8px}',
      '.ios-dl-cover{width:40px;height:60px;object-fit:cover;border-radius:6px;flex:none;background:#1a2228}',
      '.ios-dl-meta{min-width:0;flex:1 1 auto}',
      '.ios-dl-name{font-size:13px;font-weight:700;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ios-dl-count{font-size:12px;color:rgba(244,247,248,.72);margin-top:2px}',
      '.ios-dl-eps{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}',
      '.ios-dl-ep{font-size:11px;line-height:1;padding:4px 6px;border-radius:5px;background:rgba(255,255,255,.1);color:#e9f2f4}',
      '#ppRateMenu{position:absolute;right:6px;bottom:calc(100% + 6px);display:none;flex-direction:column;gap:2px;padding:6px;border-radius:12px;background:rgba(12,18,22,.97);border:1px solid rgba(255,255,255,.14)}',
      '#ppRateMenu.on{display:flex}',
      '#ppRateMenu .pc-rate-opt{border:0;background:transparent;color:#fff;font-size:13px;line-height:1;padding:9px 18px;border-radius:8px;white-space:nowrap;cursor:pointer}',
      '#ppRateMenu .pc-rate-opt.on{background:rgba(22,224,157,.2);color:#16e09d;font-weight:700}',
      /* 外放/下载菜单：从底部控制栏往上弹，行高 ≥44px 便于单手点 */
      '#ppCastMenu{position:absolute;right:6px;bottom:calc(100% + 6px);display:none;flex-direction:column;gap:2px;padding:6px;border-radius:12px;background:rgba(12,18,22,.97);border:1px solid rgba(255,255,255,.14);min-width:210px}',
      '#ppCastMenu.on{display:flex}',
      '#ppCastMenu .pc-menu-row{display:flex;align-items:center;justify-content:space-between;gap:12px;border:0;background:transparent;color:#fff;font-size:13px;font-weight:600;line-height:1.2;padding:12px 14px;border-radius:9px;text-align:left;white-space:nowrap;cursor:pointer;min-height:44px}',
      '#ppCastMenu .pc-menu-row:active{background:rgba(255,255,255,.16)}',
      '#ppCastMenu .pc-menu-row small{color:rgba(255,255,255,.62);font-weight:400;font-size:11px}',
      '#ppCastMenu .pc-menu-row[hidden]{display:none!important}',
      '#ppCastMenu .pc-menu-row.busy small{color:#16e09d}',
      /* 提示的 z-index 要高于设置面板（12000）：面板里切「播放方式」时要看得到反馈 */
      '#iosToast{position:fixed;left:50%;bottom:calc(96px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);max-width:82vw;padding:10px 14px;border-radius:12px;background:rgba(8,12,15,.94);color:#fff;font-size:13px;line-height:1.35;z-index:13000;opacity:0;pointer-events:none;transition:opacity .18s ease;text-align:center}',
      '#iosToast[data-show]{opacity:1}',
      '.brand .brand-mark{width:30px;height:30px;background-image:var(--brand-logo);background-size:cover;background-position:center;border-radius:9px;overflow:hidden;filter:none}',
      '.brand .brand-mark>svg{display:none}',
      '.tabbar .tab.center .tab-circle{background-image:var(--brand-logo);background-size:cover;background-position:center;overflow:hidden}',
      '.tabbar .tab.center .tab-circle>svg{display:none}',
      '#iosFullBtn{display:none!important}',
      /* 控制栏接管后，首屏脚本挂载前也不让 WebKit 原生右上角全屏入口闪现。 */
      'video::-webkit-media-controls-fullscreen-button{display:none!important}',
      /* 弹幕改用 transform 动画（走合成层），不再每帧动 left：
         left 每帧触发布局+重绘，播放页滚动被它拖住，自动化也一直等不到「稳定」。 */
      '.dm-layer{contain:layout paint;transform:translateZ(0);opacity:var(--ios-dm-opacity,1);clip-path:inset(0 0 calc(100% - var(--ios-dm-area,100%)) 0)}',
      'html[data-ios-dm-off] .dm-layer{display:none!important}',
      '.dm-item{left:0!important;font-size:var(--ios-dm-size,18px)!important;animation:dm-fly-x var(--ios-dm-duration,var(--dur,9s)) linear forwards!important;will-change:transform!important}',
      '@keyframes dm-fly-x{from{transform:translateX(100vw)}to{transform:translateX(-100%)}}',
      /* App 内场景：固定/粘性顶栏的 backdrop-filter 在 iOS 的 WebKit 里滚动时每帧重算，
         长列表明显掉帧。换成等效的半透明底色（观感基本不变）。 */
      '.topbar,.page-head{-webkit-backdrop-filter:none!important;backdrop-filter:none!important;background:linear-gradient(180deg,rgba(10,20,28,.97),rgba(10,20,28,.9))!important}',
      'html[data-theme=\'light\'] .topbar,html[data-theme=\'light\'] .page-head{background:linear-gradient(180deg,rgba(255,255,255,.97),rgba(255,255,255,.92))!important}',
      '.tabbar{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}',
      /* 首页一屏有大量海报角标；逐卡 backdrop-filter 会让 WebKit 在惯性滚动中反复重算模糊。 */
      '.p-badge,.p-heat{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}',
      /* 横滑条改回即时定位：站点给日期条/分类条开了 scroll-behavior:smooth，
         后台刷新重建卡片后我们一设 scrollLeft 就会整条滑过去，视觉上就是「日期条自己漂走」。 */
      '.days,.strip,.cat-list,.line-group{scroll-behavior:auto!important}',
      /* 播放提示行预留两行高度：提示词变化不再把下方的标题/选集区顶得上下跳。 */
      '#playHint,.pp-hint{min-height:2.6em;display:flex;align-items:center}',
    ].join('\n');
    document.head.appendChild(style);
    mountCtrlBar();
    mountFitBar();
    mountTencentUI();
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
  var explicitInline = false;

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
    var button = document.getElementById('ppFull') || document.getElementById('iosFullBtn');
    if (!button) return;
    var immersive = userFullscreen;
    button.textContent = immersive ? '退出全屏' : '全屏';
    /* 无障碍名也跟着切换：全屏里读屏/自动化不能再看到一个叫「全屏播放」的入口 */
    button.setAttribute('aria-label', immersive ? '退出全屏' : '全屏播放');
  }

  var HIDE_IN_IMMERSIVE = [
    '#playTools', '.pp-toolbar', '#settingsPanel', '#lineBar', '.tabbar',
    /* 站点头栏：播放页的 `pageHead({title: show.title})` 就是那条「返回 + 片名 + 菜单」。
       它不在播放器里，但同样会压在画面上，必须一起收。 */
    '.page-head', '.topbar',
    '.dm-input', '#dmInputWrap', '#pipBtn', '#nextEpBtn', '#iosFullBtn',
    '#player .p-label', '.pp-hint', '#playHint'
  ];

  function hideImmersiveControls() {
    for (var h = 0; h < HIDE_IN_IMMERSIVE.length; h++) {
      var nodes = document.querySelectorAll ? document.querySelectorAll(HIDE_IN_IMMERSIVE[h]) : [];
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (!el || el.__iosImmersiveState !== undefined) continue;
        /* hidden 是布尔反射属性：默认 false，不是 undefined，恢复时也要按布尔写回 */
        el.__iosImmersiveState = { hidden: !!el.hidden, display: el.style ? el.style.display : '' };
        el.hidden = true;
        if (el.style) el.style.display = 'none';
      }
    }
  }

  function restoreImmersiveControls() {
    for (var h = 0; h < HIDE_IN_IMMERSIVE.length; h++) {
      var nodes = document.querySelectorAll ? document.querySelectorAll(HIDE_IN_IMMERSIVE[h]) : [];
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (!el || el.__iosImmersiveState === undefined) continue;
        var state = el.__iosImmersiveState;
        el.hidden = !!state.hidden;
        if (el.style) el.style.display = state.display;
        el.__iosImmersiveState = undefined;
      }
    }
  }

  function applyImmersive() {
    var root = document.documentElement;
    if (!root || typeof root.setAttribute !== 'function') return;
    /* 标准全屏（站点的全屏按钮）也要算沉浸态：此时页面被系统铺满，
       注入层必须同步收起标题/工具条，并为退出全屏保留恢复状态。 */
    var nativeFullscreen = !!(document && document.fullscreenElement);
    var immersive = nativeFullscreen || userFullscreen || (activePlayback && landscape() && !explicitInline);
    if (immersive) root.setAttribute('data-ios-immersive', '');
    else root.removeAttribute('data-ios-immersive');
    if (immersive) {
      /* 进全屏就把上方工具条的面板都收起来：CSS 已经隐藏它们，
         这里把状态也置回关闭，退出全屏时不会突然弹出一个旧面板。 */
      closeRateMenu();
      closeCastMenu();
      var panels = ['settingsPanel', 'lineBar'];
      for (var i = 0; i < panels.length; i++) {
        var panel = document.getElementById(panels[i]);
        if (!panel) continue;
        /* hidden 是反射属性，赋值等于把 hidden 属性也写上 */
        panel.hidden = true;
      }
      hideImmersiveControls();
    } else {
      restoreImmersiveControls();
    }
    syncCtrlVisibility();
    syncFullButton();
    applyFitGeometry();
    syncFitBar();
  }

  /* ---------- 画面填充：默认 / 拉伸 / 平铺（规格 §1） ----------
     只在全屏 + 暂停时出现在屏幕顶部；恢复播放随控制栏一起收起；记住上次选择。

     为什么不再用 object-fit：真机报告「拉伸、平铺点了画面没变化」。排查结论是
     0.1.15 只把档位写到 CSS 的 object-fit 上，而注入层那条 `#player video` 的
     沉浸态规则与站点自己的宽高/内联样式同优先级、后写者胜 —— 一旦站点重渲染播放器
     或内联样式回写，object-fit 就被顶掉；更根本的是 object-fit 只在「元素盒子」与
     视频宽高比不一致时才有效果，站点给的是 100%/100% 的盒子时它形同虚设。
     这个 App 里没有自己的 AVPlayerLayer（视频由 WKWebView 的 <video> 播），
     所以 videoGravity 的等价物就是**元素自身的真实几何**：按 videoWidth/videoHeight
     算出盒子的像素宽高与居中位置直接写上去，渲染层必须照做，没有第二条样式能覆盖。 */
  var FIT_PREF = 'kj-ios-fit';
  var FIT_MODES = ['contain', 'fill', 'cover'];
  /* 规格里的三个名字对应 AVPlayerLayer 的三种 gravity */
  var FIT_LABELS = { contain: '默认', fill: '拉伸', cover: '平铺' };
  var fitMode = 'contain';

  function readFitPref() {
    var stored = '';
    try { stored = String(localStorage.getItem(FIT_PREF) || ''); } catch (error) { stored = ''; }
    return FIT_MODES.indexOf(stored) >= 0 ? stored : 'contain';
  }

  /// 真正改可见画面：把 <video> 自己的盒子算成目标几何（默认=等比装进屏幕、拉伸=铺满变形、
  /// 平铺=等比放大到盖满屏幕）。容器裁掉溢出部分，所以平铺是「裁边填满」而不是留黑边。
  function applyFitGeometry() {
    var video = document.getElementById('video');
    var player = document.getElementById('player');
    if (!video || !player || !video.style) return;
    fitMode = readFitPref();
    var vw = Number(video.videoWidth) || 0;
    var vh = Number(video.videoHeight) || 0;
    var boundsNode = immersiveNow() ? document.documentElement : player;
    var rect = boundsNode && boundsNode.getBoundingClientRect ? boundsNode.getBoundingClientRect() : null;
    var cw = rect ? Number(rect.width) || 0 : 0;
    var ch = rect ? Number(rect.height) || 0 : 0;
    /* 还没拿到画面尺寸就先按容器铺满，等 loadedmetadata 再算 */
    if (!vw || !vh || !cw || !ch) {
      video.style.width = '100%';
      video.style.height = '100%';
      if (typeof video.setAttribute === 'function') video.setAttribute('data-ios-fit-box', fitMode);
      return;
    }
    var width = cw;
    var height = ch;
    if (fitMode === 'contain') {
      var fit = Math.min(cw / vw, ch / vh);
      width = vw * fit;
      height = vh * fit;
    } else if (fitMode === 'cover') {
      var cover = Math.max(cw / vw, ch / vh);
      width = vw * cover;
      height = vh * cover;
    }
    /* fill（拉伸）：盒子就是容器，画面被非等比拉满 —— 和 .resize 一致 */
    video.style.width = Math.round(width) + 'px';
    video.style.height = Math.round(height) + 'px';
    if (typeof video.setAttribute === 'function') video.setAttribute('data-ios-fit-box', fitMode);
    /* 下拉按钮的文字由 syncFitBar 统一维护（这里不再直接摸旧的三按钮） */
  }

  function chooseFit(mode) {
    if (FIT_MODES.indexOf(mode) < 0) return;
    try { localStorage.setItem(FIT_PREF, mode); } catch (error) { /* 存不了就只在本次生效 */ }
    fitMode = mode;
    applyFitGeometry();
    syncFitBar();
    announce('画面：' + (FIT_LABELS[mode] || '默认'));
  }

  /// 全屏顶部栏与它的下拉、左右侧按钮、第二排：只在沉浸态出现，
  /// 并且按规格「点屏幕或暂停时出现，播放几秒后自动隐藏」跟随控制栏一起收放。
  function syncFitBar() {
    var video = document.getElementById('video');
    var paused = !video || video.paused !== false;
    var visible = immersiveNow() && (paused || !ctrlHidden);
    var top = document.getElementById('iosFsTop');
    if (top) top.className = visible ? 'on' : '';
    var side = document.getElementById('iosFsSide');
    if (side) side.className = visible ? 'on' : '';
    var left = document.getElementById('iosFsSideLeft');
    if (left) left.className = 'left' + (visible ? ' on' : '');
    var right = document.getElementById('iosFsSideRight');
    if (right) right.className = 'right' + (visible ? ' on' : '');
    var row2 = document.getElementById('iosFsRow2');
    if (row2) row2.className = visible ? 'on' : '';
    if (!visible) {
      var menu = document.getElementById('iosFsMenu');
      if (menu) menu.className = '';
    }
    /* 下拉按钮的文字就是当前档位（默认 ▾ / 拉伸 ▾ / 平铺 ▾） */
    fitMode = readFitPref();
    var label = document.getElementById('iosFsFitBtn');
    if (label) label.textContent = (FIT_LABELS[fitMode] || '默认') + ' ▾';
    var menu = document.getElementById('iosFsMenu');
    if (menu && menu.querySelectorAll) {
      var options = menu.querySelectorAll('button');
      for (var i = 0; i < options.length; i++) {
        var mode = options[i].getAttribute ? options[i].getAttribute('data-fit') : '';
        options[i].className = mode === fitMode ? 'on' : '';
      }
    }
    /* 顶部剧名 = 剧名 + 第几集 */
    var title = document.getElementById('iosFsTitle');
    if (title) {
      var meta = showMeta();
      var ep = episodeLabel();
      title.textContent = (meta.title || '正在播放') + (ep ? ' · ' + ep : '');
    }
  }

  /// 全屏顶部栏：左 返回 + 剧名 + 画面模式下拉，右 投屏 / 分享 / 更多
  function mountFsTop() {
    var player = document.getElementById('player');
    if (!player || typeof player.appendChild !== 'function') return false;
    if (document.getElementById('iosFsTop')) { syncFitBar(); return true; }
    var top = document.createElement('div');
    top.id = 'iosFsTop';
    top.innerHTML = ''
      + '<button class="iosfs-btn" type="button" data-ios-act="back" aria-label="返回">‹</button>'
      + '<span class="iosfs-title" id="iosFsTitle"></span>'
      + '<button class="iosfs-fit" type="button" id="iosFsFitBtn" aria-label="画面模式">默认 ▾</button>'
      + '<button class="iosfs-btn" type="button" data-ios-act="cast" aria-label="投屏">投屏</button>'
      + '<button class="iosfs-btn" type="button" data-ios-act="share" aria-label="分享">分享</button>'
      + '<button class="iosfs-btn" type="button" data-ios-act="play-settings" aria-label="更多">···</button>';
    player.appendChild(top);

    var menu = document.createElement('div');
    menu.id = 'iosFsMenu';
    for (var i = 0; i < FIT_MODES.length; i++) {
      (function (mode) {
        var option = document.createElement('button');
        option.type = 'button';
        option.textContent = FIT_LABELS[mode];
        option.setAttribute('data-fit', mode);
        option.setAttribute('aria-label', '画面' + FIT_LABELS[mode]);
        menu.appendChild(option);
      }(FIT_MODES[i]));
    }
    player.appendChild(menu);

    var left = document.createElement('div');
    left.id = 'iosFsSideLeft';
    left.className = 'left';
    left.innerHTML = '<button type="button" data-ios-act="lock" aria-label="锁屏">🔒</button>';
    player.appendChild(left);

    var right = document.createElement('div');
    right.id = 'iosFsSideRight';
    right.className = 'right';
    right.innerHTML = '<button type="button" data-ios-act="shot" aria-label="截图">📷</button>';
    player.appendChild(right);

    var row2 = document.createElement('div');
    row2.id = 'iosFsRow2';
    row2.innerHTML = ''
      + '<button type="button" data-ios-act="subtitle" aria-label="字幕">字幕</button>'
      + '<button type="button" data-ios-act="rate" aria-label="倍速">倍速</button>'
      + '<button type="button" data-ios-act="quality" aria-label="画质">720P</button>'
      + '<button type="button" data-ios-act="episodes" aria-label="选集">选集</button>'
      + '<button type="button" data-ios-act="next" aria-label="下一集">下一集 ⏭</button>';
    player.appendChild(row2);

    /* 侧栏两个元素共用 .on 控制显隐 */
    left.id = 'iosFsSideLeft';
    right.id = 'iosFsSideRight';
    syncFitBar();
    return true;
  }

  /* ---------- 全屏里控制栏“点一下才出来，几秒后自己收起” ----------
     用户要的是全屏只剩画面：不点屏幕时不能留底栏、渐变或任何遮罩。
     所以进沉浸态（正在播放）就直接收起，点画面再拿出来，3 秒后自动消失。 */
  var CTRL_HIDE_MS = 3000;
  var ctrlHideTimer = null;
  var ctrlHidden = false;
  var ctrlShownAt = 0;

  function immersiveNow() {
    var root = document.documentElement;
    return !!(root && typeof root.hasAttribute === 'function' && root.hasAttribute('data-ios-immersive'));
  }

  function clearCtrlTimer() {
    if (ctrlHideTimer) clearTimeout(ctrlHideTimer);
    ctrlHideTimer = null;
  }

  function setCtrlHidden(hidden) {
    ctrlHidden = !!hidden;
    var bar = document.getElementById('ppCtrl');
    if (!bar) return;
    bar.className = 'pp-ctrl' + (hidden ? ' pc-hidden' : '');
  }

  function hideCtrlSoon() {
    clearCtrlTimer();
    if (!immersiveNow()) return;
    var video = document.getElementById('video');
    /* 暂停时把控制栏留给用户：这时收起来就点不到播放键了。 */
    if (video && video.paused !== false) return;
    ctrlHideTimer = setTimeout(function () {
      ctrlHideTimer = null;
      if (immersiveNow()) setCtrlHidden(true);
    }, CTRL_HIDE_MS);
  }

  /* autoHide === false 时只拿出来、不计时（比如暂停态） */
  function showCtrl(autoHide) {
    setCtrlHidden(false);
    ctrlShownAt = Date.now();
    clearCtrlTimer();
    if (autoHide === false) return;
    hideCtrlSoon();
  }

  /* 容器尺寸变了（旋转、进出全屏、键盘收起）就按新的容器重新算一遍画面几何：
     三档写的是像素宽高，不重算就会停在旧尺寸上。 */
  function refitSoon() {
    applyFitGeometry();
    syncFitBar();
    setTimeout(function () { applyFitGeometry(); syncFitBar(); }, 180);
  }

  function syncCtrlVisibility() {
    if (!immersiveNow()) {
      clearCtrlTimer();
      setCtrlHidden(false);
      return;
    }
    var video = document.getElementById('video');
    if (video && video.paused === false) {
      /* 进沉浸态、并且正在播：直接收起，不等 3 秒。用户要的是“画面先干净”。
         例外：刚被用户点出来的那一瞬，可能迁到一个 play 事件，别把它闪没。 */
      clearCtrlTimer();
      if (ctrlHidden || Date.now() - ctrlShownAt > 600) setCtrlHidden(true);
      else hideCtrlSoon();
    } else {
      showCtrl(false);
    }
  }

  function setUserFullscreen(on) {
    var wasPlaying = activePlayback;
    userFullscreen = !!on;
    /* 退出全屏后不要被「横屏播放自动沉浸」当场拉回去；
       这个标记只挡当下这一次重算，新的播放/再次转屏会清掉它，
       否则横屏播放会永远留在页内布局，片名标题一直压在画面上。 */
    explicitInline = !userFullscreen;
    // 进场时补一个播放态，退出时清掉，避免刚退出又被「横屏播放自动沉浸」拉回去
    if (userFullscreen) activePlayback = true;
    applyImmersive();
    postNative({ action: userFullscreen ? 'fullscreen' : 'inline' });
    if (!userFullscreen && wasPlaying) {
      var video = document.getElementById('video');
      if (video && typeof video.play === 'function') {
        try { video.play().catch(function () {}); } catch (error) { /* 恢复方向不依赖播放 promise */ }
      }
    }
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

  function handleFullscreenBack(event) {
    if (!immersiveNow()) return false;
    var back = event.target && event.target.closest ? event.target.closest('#iosTopBar [data-ios-act="back"],#iosFsTop [data-ios-act="back"]') : null;
    if (!back) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    toggleFullscreen();
    return true;
  }

  document.addEventListener('click', handleFullscreenBack, true);

  /* ---------- 播放控制栏：进度 / 倍速 / 外放 / 全屏 ---------- */
  /* iOS 原生控件改不了位置：全屏键固定在左上角，倍速菜单也只到 2×。
     所以应用内自带一条控制栏：播放 · 时间 · 进度条 · 外放 · 倍速 · 全屏，
     全屏正好落在进度条右端，和倍速挨着。 */
  var ctrlMounted = false;
  var settingsSheet = null;

  /* 下载状态跨页面保留：原生下载在 WKWebView 外面跑，换页只换网页。
     进度落 localStorage，回到首页也看得到；原生回传的事件在新页面继续接。 */
  var DOWNLOAD_STORE = 'kj-ios-download';
  var EXT_PLAYER_PREF = 'kj-ios-ext-player';

  function readStore(key) {
    try { return localStorage.getItem(key); } catch (error) { return null; }
  }

  function writeStore(key, value) {
    try { localStorage.setItem(key, value); } catch (error) { /* 隐私模式 */ }
  }

  /* 进度事件一秒能来好几次，而 localStorage 是同步写：限流，但状态转变（开始/完成/失败）
     必须立刻落地，否则换页回来看到的是上一次的旧进度。 */
  var lastSaveAt = 0;
  function saveDownload(force) {
    var now = Date.now();
    if (!force && now - lastSaveAt < 500) return;
    lastSaveAt = now;
    var phase = downloadState.busy ? 'running' : (downloadState.path ? 'done' : (downloadState.error ? 'failed' : 'idle'));
    writeStore(DOWNLOAD_STORE, JSON.stringify({
      id: downloadState.id, name: downloadState.name, path: downloadState.path,
      show: downloadState.show || '', ep: downloadState.ep || '',
      busy: !!downloadState.busy, percent: downloadState.percent || 0,
      total: Number(downloadState.total) || 0, received: Number(downloadState.received) || 0,
      error: downloadState.error || '', state: phase,
      /* 换页/重启后原生才回「完成」时，也要能把这一集归到正确的剧名下 */
      meta: pendingMeta || null,
    }));
  }

  function restoreDownload() {
    var raw = readStore(DOWNLOAD_STORE);
    if (!raw) return;
    var saved = null;
    try { saved = JSON.parse(raw); } catch (error) { return; }
    if (!saved || typeof saved !== 'object') return;
    /* 上次留下的「正在下载」要保留：原生层还在传，进度事件会接着送到新页面。 */
    downloadState = {
      id: saved.id || '',
      name: saved.name || '',
      show: saved.show || '',
      ep: saved.ep || '',
      path: saved.path || '',
      busy: !!saved.busy && !saved.path,
      percent: Number(saved.percent) || 0,
      total: Number(saved.total) || 0, received: Number(saved.received) || 0,
      error: saved.state === 'failed' ? (saved.error || '下载中断') : '',
    };
    if (saved.meta && typeof saved.meta === 'object' && saved.meta.title) pendingMeta = saved.meta;
  }

  /* ---------- 已下载片库数据 ----------
     原生下载一次只跑一集，网页侧拿不到文件夹列表；所以每次下载完成就把
     「剧名 / 封面 / 这一集」记到 localStorage。分组用站点自己的媒体 id
     （播放页地址的 ?id=），拿不到 id 时退回剧名，同一部剧不会碎成两条。 */
  var LIBRARY_STORE = 'kj-ios-downloads';

  function readLibrary() {
    var parsed = null;
    try { parsed = JSON.parse(readStore(LIBRARY_STORE) || 'null'); } catch (error) { parsed = null; }
    var shows = parsed && parsed.shows;
    if (!shows || typeof shows.length !== 'number') return { shows: [] };
    var clean = [];
    for (var i = 0; i < shows.length; i++) {
      var show = shows[i];
      if (!show || !show.title) continue;
      var source = show.eps && typeof show.eps.length === 'number' ? show.eps : [];
      var eps = [];
      for (var e = 0; e < source.length; e++) {
        var ep = source[e];
        if (!ep) continue;
        eps.push({
          key: ep.key === undefined || ep.key === null ? '' : String(ep.key),
          label: String(ep.label || ''),
          name: String(ep.name || ''),
          path: String(ep.path || ''),
          size: Number(ep.size) || 0,
          at: Number(ep.at) || 0,
        });
      }
      if (!eps.length) continue;
      /* 0.1.13 及以前的记录名是「追剧AI 第19集」：有真实剧名和集号就补名，
         只改显示名，不动 path、不移动文件、不覆盖同名文件；重复执行结果一样。 */
      for (var m = 0; m < eps.length; m++) {
        var oldName = eps[m].name || '';
        if (!/^追剧AI(?:_|\s|$)/.test(oldName)) continue;
        var extMatch = /\.(mp4|m4v|mov|mkv|ts)$/i.exec(oldName);
        var migrated = safeName(String(show.title) + (eps[m].label ? ' ' + eps[m].label : ''));
        eps[m].name = migrated + (extMatch ? '.' + extMatch[1].toLowerCase() : '.mp4');
      }
      clean.push({
        id: String(show.id || show.title),
        title: String(show.title),
        cover: String(show.cover || ''),
        /* 0 表示「站点没告诉我们总集数」：界面只写「已下载 N 集」，绝不编一个分母。 */
        total: Number(show.total) || 0,
        eps: eps,
      });
    }
    return { shows: clean };
  }

  function writeLibrary(library) {
    writeStore(LIBRARY_STORE, JSON.stringify({ shows: library.shows || [] }));
  }

  /* 播放页能拿到的真实媒体标识：站点地址的 ?id=、详情标题、海报、总集数。 */
  function episodeTotal() {
    var more = document.getElementById('epMore');
    if (more && typeof more.textContent === 'string') {
      var fromMore = /(\d+)\s*集/.exec(more.textContent);
      if (fromMore) return Number(fromMore[1]) || 0;
    }
    var buttons = document.querySelectorAll ? document.querySelectorAll('#epGrid .ep') : [];
    if (buttons && buttons.length) return buttons.length;
    /* 没有选集按钮的（电影/单集）就只有一集正片 */
    var any = document.querySelector ? document.querySelector('.ep') : null;
    return any ? 0 : 1;
  }

  function showMeta() {
    var id = '';
    try { id = new URLSearchParams(window.location.search).get('id') || ''; } catch (error) { id = ''; }
    var title = '';
    var heading = document.querySelector ? document.querySelector('.detail-info h1') : null;
    if (heading && heading.textContent) title = String(heading.textContent).trim();
    if (!title) title = String(document.title || '').replace(/\s*[-–—|]\s*看剧AI\s*$/, '').trim();
    if (!title) {
      var head = document.querySelector ? document.querySelector('.ph-title') : null;
      if (head && head.textContent) title = String(head.textContent).trim();
    }
    var cover = '';
    var poster = document.querySelector ? document.querySelector('.detail-poster img') : null;
    if (poster && typeof poster.getAttribute === 'function') cover = poster.getAttribute('src') || '';
    if (!cover) {
      var video = document.getElementById('video');
      if (video && typeof video.getAttribute === 'function') cover = video.getAttribute('poster') || '';
    }
    return { id: id || title, title: title, cover: cover, total: episodeTotal() };
  }

  /* 下载完成：把这一集记到对应剧名下（同一集重下就覆盖，不留重复）。 */
  function recordDownloaded(payload, meta) {
    var info = meta || {};
    var title = String(info.title || '').trim();
    if (!title) return;
    /* 不伪造完成：只有原生真的把文件落到沙盒、回传了 path 才记进片库 */
    var savedPath = String((payload && payload.path) || '');
    if (!savedPath) return;
    var id = String(info.id || title);
    var library = readLibrary();
    var shows = library.shows;
    var show = null;
    for (var i = 0; i < shows.length; i++) {
      if (shows[i].id === id || shows[i].title === title) { show = shows[i]; break; }
    }
    if (!show) {
      show = { id: id, title: title, cover: String(info.cover || ''), total: Number(info.total) || 0, eps: [] };
      shows.unshift(show);
    }
    if (info.cover) show.cover = String(info.cover);
    if (Number(info.total) > 0) show.total = Number(info.total);
    var key = info.epKey === undefined || info.epKey === null ? '' : String(info.epKey);
    var record = {
      key: key,
      label: String(info.epLabel || (payload && payload.ep) || ''),
      name: String((payload && payload.name) || ''),
      path: savedPath,
      size: Number(payload && payload.size) || 0,
      at: Date.now(),
    };
    var replaced = false;
    for (var e = 0; e < show.eps.length; e++) {
      if (show.eps[e].key === record.key) {
        /* 重复回传（换页/重启/again）只更新一次：同集同路径同大小直接跳过 */
        if (show.eps[e].path === record.path && Number(show.eps[e].size) === record.size) return;
        show.eps[e] = record;
        replaced = true;
        break;
      }
    }
    if (!replaced) show.eps.push(record);
    show.eps.sort(function (a, b) {
      var left = Number(a.key), right = Number(b.key);
      if (isFinite(left) && isFinite(right) && left !== right) return left - right;
      return (a.at || 0) - (b.at || 0);
    });
    /* 最近下过的那部剧排在最前面 */
    shows.sort(function (a, b) { return latestAt(b) - latestAt(a); });
    writeLibrary({ shows: shows });
  }

  function latestAt(show) {
    var latest = 0;
    for (var i = 0; i < show.eps.length; i++) latest = Math.max(latest, show.eps[i].at || 0);
    return latest;
  }

  function renderDownloadLibrary() {
    var page = document.getElementById('iosMinePage');
    if (page && !page.hidden) renderMinePage();
    return true;
  }
  /// 真的删除：先把记录从片库里去掉，再让原生删掉那个文件（只删这一行）
  function deleteDownloaded(showId, key) {
    var library = readLibrary();
    var shows = library.shows;
    var removed = [];
    for (var s = 0; s < shows.length; s++) {
      if (String(shows[s].id) !== String(showId)) continue;
      var keep = [];
      for (var e = 0; e < shows[s].eps.length; e++) {
        if (String(shows[s].eps[e].key) === String(key)) removed.push(shows[s].eps[e]);
        else keep.push(shows[s].eps[e]);
      }
      shows[s].eps = keep;
    }
    var next = [];
    for (var i = 0; i < shows.length; i++) if (shows[i].eps.length) next.push(shows[i]);
    writeStore(LIBRARY_STORE, JSON.stringify({ shows: next }));
    renderDownloadLibrary();
    if (!removed.length) {
      announce('这条记录已经不在了');
      return false;
    }
    var path = String(removed[0].path || '');
    if (path) postNative({ action: 'deleteLocal', path: path, name: removed[0].name || '' });
    announce(path ? '已删除这一集和它的文件' : '已删除这一集（没有本地文件）');
    return true;
  }

  function deleteRowAt(node) {
    var cursor = node;
    while (cursor) {
      if (cursor.getAttribute && cursor.getAttribute('data-dl-key') !== null) {
        return deleteDownloaded(String(cursor.getAttribute('data-dl-show') || ''), String(cursor.getAttribute('data-dl-key')));
      }
      cursor = cursor.parentNode;
    }
    return false;
  }

  /* ---------- 设置面板：任何页面都能打开，首页也有 ---------- */
  function ensureSettingsSheet() {
    if (settingsSheet) return settingsSheet;
    if (!document.body || typeof document.body.appendChild !== 'function') return null;
    var sheet = document.createElement('div');
    sheet.id = 'iosSettingsSheet';
    sheet.className = 'ios-settings-sheet';
    sheet.hidden = true;
    if (typeof sheet.setAttribute === 'function') sheet.setAttribute('hidden', '');
    var card = document.createElement('div');
    card.id = 'iosSettingsCard';
    var head = document.createElement('div');
    head.id = 'iosSettingsHead';
    var title = document.createElement('span');
    title.textContent = '设置';
    head.appendChild(title);
    var close = document.createElement('button');
    close.id = 'iosSettingsClose';
    close.type = 'button';
    close.textContent = '✕';
    close.setAttribute('aria-label', '关闭设置');
    head.appendChild(close);
    card.appendChild(head);
    var content = document.createElement('div');
    content.id = 'iosSettingsBody';
    content.innerHTML = '<section class="ios-set-group"><h3><span aria-hidden="true">♙</span>账号</h3><div class="ios-set-card">'
      + '<button class="ios-set-row" data-setting-action="profile"><span><b>个人资料</b><small id="iosSettingAccount">即将上线</small></span><span>›</span></button>'
      + '<button class="ios-set-row" data-setting-action="security"><span><b>账号安全</b><small>修改密码 · 即将上线</small></span><span>›</span></button></div></section>'
      + '<section class="ios-set-group"><h3><span aria-hidden="true">◐</span>外观</h3><div class="ios-set-card"><div class="ios-set-row"><b>界面主题</b>'
      + '<span class="ios-set-seg"><button type="button" data-theme-setting="light">浅色</button><button type="button" data-theme-setting="dark">深色</button></span></div></div></section>'
      + '<section class="ios-set-group"><h3><span aria-hidden="true">▷</span>播放</h3><div class="ios-set-card">'
      + '<label class="ios-set-row"><span><b>默认播放倍速</b><small>下次打开视频时使用</small></span><select id="iosSettingSpeed">'
      + '<option>0.5</option><option>0.75</option><option>1</option><option>1.25</option><option>1.5</option><option>1.75</option><option>2</option><option>2.5</option><option>3</option></select></label>'
      + '<button class="ios-set-row" data-setting-toggle="kj-skip-intro"><span><b>跳过片头</b><small>使用影片已设置的时间点</small></span><i></i></button>'
      + '<button class="ios-set-row" data-setting-toggle="kj-skip-outro"><span><b>跳过片尾</b><small>使用影片已设置的时间点</small></span><i></i></button>'
      + '<button class="ios-set-row" data-setting-toggle="kj-hq"><span><b>画质增强</b><small>下次打开视频时使用</small></span><i></i></button>'
      + '<button class="ios-set-row" data-setting-toggle="kj-dm"><span><b>显示弹幕</b><small>关闭后隐藏视频弹幕</small></span><i></i></button>'
      + '<button class="ios-set-row" id="iosDanmakuExpand" aria-expanded="false" aria-controls="iosDanmakuSettings"><span><b>弹幕设置</b><small>透明度、字号、速度和显示区域</small></span><span>›</span></button>'
      + '<div id="iosDanmakuSettings" hidden><label>透明度 <input type="range" min="0.2" max="1" step="0.1" data-dm-setting="kj-dm-opacity"></label>'
      + '<label>字号 <input type="range" min="12" max="28" step="1" data-dm-setting="kj-dm-size"></label>'
      + '<label>速度 <input type="range" min="4" max="14" step="1" data-dm-setting="kj-dm-speed"></label>'
      + '<label>显示区域 <select data-dm-setting="kj-dm-area"><option value="25">1/4 画面</option><option value="50">1/2 画面</option><option value="75">3/4 画面</option><option value="100">全画面</option></select></label></div></div></section>';
    card.appendChild(content);
    sheet.appendChild(card);
    document.body.appendChild(sheet);
    settingsSheet = sheet;
    syncSettingsSheet();
    return sheet;
  }

  function openSettingsSheet() {
    var sheet = ensureSettingsSheet();
    if (!sheet) return false;
    sheet.hidden = false;
    if (typeof sheet.removeAttribute === 'function') sheet.removeAttribute('hidden');
    sheet.className = 'ios-settings-sheet on';
    syncSettingsSheet();
    return true;
  }

  function closeSettingsSheet() {
    if (!settingsSheet) return;
    settingsSheet.hidden = true;
    if (typeof settingsSheet.setAttribute === 'function') settingsSheet.setAttribute('hidden', '');
    settingsSheet.className = 'ios-settings-sheet';
  }

  settingValue = function (key) {
    var value = readStore(key);
    return value === null || value === '' ? SETTING_DEFAULTS[key] : value;
  }

  setSettingValue = function (key, value) {
    writeStore(key, String(value));
    applySettingChange(key);
  }

  function applySettingChange(key) {
    if (key === 'kj-speed') applySpeed();
    if (key === 'kj-hq') applyEnhancePreference(document.getElementById('video'));
    if (key.indexOf('kj-dm') === 0) applyDanmakuPreference();
    if (key === 'kj-theme') document.documentElement.setAttribute('data-theme', readStore(key) || 'dark');
    syncSettingsSheet();
    syncPlaySettings();
  }

  function syncSettingsSheet() {
    var body = document.getElementById('iosSettingsBody');
    if (!body) return;
    var account = document.getElementById('iosSettingAccount');
    var user = cachedUser();
    if (account) account.textContent = (user ? (user.nickname || user.username) + ' · ' : '') + '即将上线';
    var speed = document.getElementById('iosSettingSpeed');
    if (speed) speed.value = String(savedSpeed());
    var playerSpeed = document.getElementById('kjSettingSpeed');
    if (playerSpeed) playerSpeed.value = String(savedSpeed());
    var themes = body.querySelectorAll('[data-theme-setting]');
    var theme = document.documentElement.getAttribute ? (document.documentElement.getAttribute('data-theme') || 'dark') : 'dark';
    for (var i = 0; i < themes.length; i++) themes[i].className = themes[i].getAttribute('data-theme-setting') === theme ? 'on' : '';
    var toggles = body.querySelectorAll('[data-setting-toggle]');
    for (var t = 0; t < toggles.length; t++) {
      var key = toggles[t].getAttribute('data-setting-toggle');
      var enabled = settingValue(key) !== '0';
      toggles[t].className = 'ios-set-row' + (enabled ? ' on' : '');
      toggles[t].setAttribute('aria-pressed', String(enabled));
    }
    var sliders = body.querySelectorAll('[data-dm-setting]');
    for (var s = 0; s < sliders.length; s++) sliders[s].value = settingValue(sliders[s].getAttribute('data-dm-setting'));
  }

  function applyEnhancePreference(video) {
    if (video && video.style) video.style.filter = settingValue('kj-hq') === '1' ? 'contrast(1.08) saturate(1.08)' : '';
  }

  function applyDanmakuPreference() {
    var root = document.documentElement;
    if (settingValue('kj-dm') === '0') root.setAttribute('data-ios-dm-off', '');
    else root.removeAttribute('data-ios-dm-off');
    if (!root.style || !root.style.setProperty) return;
    root.style.setProperty('--ios-dm-opacity', settingValue('kj-dm-opacity'));
    root.style.setProperty('--ios-dm-size', settingValue('kj-dm-size') + 'px');
    root.style.setProperty('--ios-dm-duration', (18 - Number(settingValue('kj-dm-speed'))) + 's');
    root.style.setProperty('--ios-dm-area', settingValue('kj-dm-area') + '%');
  }

  function handleSettingsClick(target) {
    var action = target && target.closest ? target.closest('[data-setting-action]') : null;
    if (action) {
      announce('即将上线');
      return true;
    }
    var theme = target && target.closest ? target.closest('[data-theme-setting]') : null;
    if (theme) {
      var mode = theme.getAttribute('data-theme-setting');
      setSettingValue('kj-theme', mode);
      return true;
    }
    var toggle = target && target.closest ? target.closest('[data-setting-toggle]') : null;
    if (toggle) {
      var key = toggle.getAttribute('data-setting-toggle');
      setSettingValue(key, settingValue(key) === '0' ? '1' : '0');
      return true;
    }
    var expand = target && target.closest ? target.closest('#iosDanmakuExpand') : null;
    if (expand) {
      var panel = document.getElementById('iosDanmakuSettings');
      if (panel) {
        panel.hidden = !panel.hidden;
        expand.setAttribute('aria-expanded', String(!panel.hidden));
      }
      return true;
    }
    return false;
  }

  window.addEventListener('storage', function (event) {
    if (event.key && event.key.indexOf('kj-') === 0) applySettingChange(event.key);
  });

  /* 站点的设置按钮只会弹「即将上线」：拦下来换成我们自己的面板 */
  function settingsTriggerHit(node) {
    var list = document.querySelectorAll ? document.querySelectorAll('[data-action="settings"]') : [];
    for (var index = 0; index < list.length; index++) {
      var cursor = node;
      while (cursor) {
        if (cursor === list[index]) return list[index];
        cursor = cursor.parentNode;
      }
    }
    return null;
  }

  function hit(node, id) {
    var cursor = node;
    while (cursor) {
      if (cursor.id === id) return cursor;
      cursor = cursor.parentNode;
    }
    return null;
  }

  function clockText(seconds) {
    var total = Math.max(0, Math.floor(Number(seconds) || 0));
    var minutes = Math.floor(total / 60);
    var rest = total % 60;
    return minutes + ':' + (rest < 10 ? '0' + rest : rest);
  }

  function announce(text) {
    /* 只走悬浮 toast，不动页面里的提示行：
       #playHint 在正常文档流里，每次改写都会把它下面的标题/选集区整块挤动，
       真机上看起来就是「上下滑时位置跳动」。提示行另用固定高度兜底。 */
    var box = document.getElementById('iosToast');
    if (!box && document.body && typeof document.createElement === 'function') {
      box = document.createElement('div');
      box.id = 'iosToast';
      box.className = 'ios-toast';
      document.body.appendChild(box);
    }
    if (!box) return;
    box.textContent = text;
    box.setAttribute('data-show', '');
    clearTimeout(announce.timer);
    announce.timer = setTimeout(function () { box.removeAttribute('data-show'); }, 2600);
  }

  function routeNativeFullscreen(video) {
    if (!video || video.__iosFullscreenRouted) return;
    /* 原生全屏的退出键固定在左上角，状态栏和安全区都不受控；
       统一改走页面内全屏 + 原生锁方向，位置交给自己的控制栏。 */
    video.__iosFullscreenRouted = true;
    if (typeof video.webkitEnterFullscreen === 'function') {
      video.webkitEnterFullscreen = function () { setUserFullscreen(true); };
    }
  }

  function mountCtrlBar() {
    if (ctrlMounted) return true;
    var player = document.getElementById('player');
    var video = document.getElementById('video');
    if (!player || !video || typeof player.appendChild !== 'function') return false;
    if (document.getElementById('ppCtrl')) {
      ctrlMounted = true;
      routeNativeFullscreen(video);
      return true;
    }

    var bar = document.createElement('div');
    bar.id = 'ppCtrl';
    bar.className = 'pp-ctrl' + (ctrlHidden && immersiveNow() ? ' pc-hidden' : '');

    function barButton(id, label, aria) {
      var element = document.createElement('button');
      element.id = id;
      element.type = 'button';
      element.className = 'pc-btn';
      element.textContent = label;
      element.setAttribute('aria-label', aria);
      bar.appendChild(element);
      return element;
    }

    barButton('ppPlay', '播放', '播放 / 暂停');
    var time = document.createElement('span');
    time.id = 'ppTime';
    time.className = 'pc-time';
    time.textContent = '0:00 / 0:00';
    bar.appendChild(time);
    var seek = document.createElement('input');
    seek.id = 'ppSeek';
    seek.className = 'pc-seek';
    seek.type = 'range';
    seek.setAttribute('min', '0');
    seek.setAttribute('max', '1000');
    seek.setAttribute('step', '1');
    seek.setAttribute('value', '0');
    seek.setAttribute('aria-label', '播放进度');
    bar.appendChild(seek);
    barButton('ppCast', '外放', '用其他 App 播放或投屏');
    barButton('ppRate', '1×', '倍速');
    /* 画面档位放在全屏左边：全屏仍然是控制栏最右端那一个（真机上习惯的位置）。 */
    barButton('ppFull', '全屏', '全屏播放');

    /* 外放菜单：第三方播放器、分享和复制播放地址 */
    var castMenu = document.createElement('div');
    castMenu.id = 'ppCastMenu';
    castMenu.className = 'pc-cast-menu';
    /* 第三方播放器排在第一行：这是用户默认想走的那条路（不需要先下载）。 */
    castMenu.appendChild(castRow('ppPlayExternal', '用第三方播放器播放', '当前线路'));
    castMenu.appendChild(castRow('ppShareLink', '分享播放地址', '系统面板'));
    castMenu.appendChild(castRow('ppCopyLink', '复制播放地址', '手动粘贴'));
    bar.appendChild(castMenu);

    var menu = document.createElement('div');
    menu.id = 'ppRateMenu';
    menu.className = 'pc-rate-menu';
    for (var index = 0; index < speeds.length; index++) {
      var option = document.createElement('button');
      option.type = 'button';
      option.className = 'pc-rate-opt';
      option.setAttribute('data-rate', String(speeds[index]));
      if (option.dataset) option.dataset.rate = String(speeds[index]);
      option.textContent = speeds[index] + '×';
      menu.appendChild(option);
    }
    bar.appendChild(menu);

    player.appendChild(bar);
    ctrlMounted = true;
    /* 自己的控制栏挂上之后才收起原生控件，避免两条控制栏叠在一起 */
    try {
      video.removeAttribute('controls');
      video.controls = false;
    } catch (error) { /* 老内核 */ }
    routeNativeFullscreen(video);
    syncCtrl();
    syncDownloadRow();
    syncCtrlVisibility();
    return true;
  }

  function syncCtrl() {
    var video = document.getElementById('video');
    if (!video) return;
    var duration = Number(video.duration) || 0;
    var current = Number(video.currentTime) || 0;
    var time = document.getElementById('ppTime');
    if (time) time.textContent = clockText(current) + ' / ' + (duration ? clockText(duration) : '0:00');
    var seek = document.getElementById('ppSeek');
    if (seek && (!document.activeElement || document.activeElement !== seek)) {
      seek.value = duration ? String(Math.round(current / duration * 1000)) : '0';
    }
    var play = document.getElementById('ppPlay');
    if (play) play.textContent = video.paused === false ? '暂停' : '播放';
    syncRateLabel();
    syncFullButton();
  }

  function effectiveRate() {
    var video = document.getElementById('video');
    var rate = video ? Number(video.playbackRate) : 1;
    return isFinite(rate) && rate > 0 ? rate : 1;
  }

  function syncRateLabel() {
    var real = effectiveRate();
    var saved = Number(savedSpeed());
    if (Math.abs(real - saved) > 0.001) real = saved;
    var label = document.getElementById('ppRate');
    if (label) label.textContent = real + '×';
    var menu = document.getElementById('ppRateMenu');
    if (!menu || !menu.children) return;
    for (var index = 0; index < menu.children.length; index++) {
      var option = menu.children[index];
      var value = Number(option.dataset && option.dataset.rate);
      option.className = Math.abs(value - real) < 0.001 ? 'pc-rate-opt on' : 'pc-rate-opt';
    }
  }

  function closeRateMenu() {
    var menu = document.getElementById('ppRateMenu');
    if (menu) menu.className = 'pc-rate-menu';
  }

  function toggleRateMenu() {
    var menu = document.getElementById('ppRateMenu');
    if (!menu) return;
    closeCastMenu();
    var open = String(menu.className).indexOf('pc-rate-menu on') >= 0;
    menu.className = open ? 'pc-rate-menu' : 'pc-rate-menu on';
  }

  function setRate(value) {
    var video = document.getElementById('video');
    var wanted = Number(value);
    if (speeds.indexOf(wanted) < 0) return savedSpeed();
    if (video) {
      try {
        video.defaultPlaybackRate = wanted;
        video.playbackRate = wanted;
      } catch (error) { /* 这条线路不可调速 */ }
    }
    /* 系统可能把倍速夹回去（比如只允许到 2×）：读回真实值再显示，不许谎报 */
    var actual = video ? effectiveRate() : wanted;
    var stored = speeds.indexOf(actual) >= 0 ? actual : wanted;
    setSettingValue('kj-speed', String(stored));
    var real = actual;
    syncRateLabel();
    closeRateMenu();
    if (Math.abs(real - wanted) > 0.05) announce('本机最高只支持 ' + real + '×，' + wanted + '× 被系统夹回');
    else announce('已切到 ' + real + '×');
    return real;
  }

  function togglePlay() {
    var video = document.getElementById('video');
    if (!video) return;
    if (video.paused === false) {
      video.pause();
      return;
    }
    syncNowPlaying();
    var promise = video.play();
    if (promise && typeof promise.catch === 'function') {
      promise.catch(function () { announce('播放没有启动，再点一次试试'); });
    }
  }

  function seekTo(ratio) {
    var video = document.getElementById('video');
    if (!video) return;
    var duration = Number(video.duration);
    if (!duration || !isFinite(duration)) return;
    var next = Math.min(Math.max(Number(ratio) || 0, 0), 1) * duration;
    try { video.currentTime = next; } catch (error) { /* 还没到可跳转的状态 */ }
  }

  /* 真正能交给外部 App 的地址；同时把「还没有地址」和「地址不可交」分开。
     - 空 <source src> 会被浏览器解析成当前页面地址，必须挡掉；
     - 换集重渲染会把 <video> 整块换掉或清空 src，按钮此时不能说「还没解析出直链」——
       同一集内记住最后一次真实见过的 http(s) 片源（m3u8 也记住，虽然不能整集下载，
       但能如实提示「分片线路不可下载」，而不是冤枉页面没解析）。 */
  var mediaMemo = { url: '', ep: '' };

  function episodeKey() {
    var active = document.querySelector ? document.querySelector('.ep.on') : null;
    /* 电影和单集内容不会渲染 .ep 选集按钮；它们的唯一一集索引固定为 0。 */
    if (!active) return '0';
    var ep = active && active.dataset ? active.dataset.ep : '';
    return ep === undefined || ep === null ? '' : String(ep);
  }

  function isPageUrl(url) {
    var page = String(window.location && window.location.href || '').split('#')[0].split('?')[0];
    return !!page && String(url).split('#')[0].split('?')[0] === page;
  }

  function mediaCandidates(video) {
    var list = [];
    if (!video) return list;
    if (video.currentSrc) list.push(video.currentSrc);
    if (video.src) list.push(video.src);
    if (typeof video.getAttribute === 'function') list.push(video.getAttribute('src'));
    var source = video.querySelector ? video.querySelector('source') : null;
    if (source && typeof source.getAttribute === 'function') list.push(source.getAttribute('src'));
    return list;
  }

  function rememberMedia() {
    var list = mediaCandidates(document.getElementById('video'));
    for (var i = 0; i < list.length; i++) {
      var url = list[i] || '';
      if (/^https?:/i.test(url) && !isPageUrl(url)) {
        mediaMemo = { url: url, ep: episodeKey() };
        return;
      }
    }
  }

  function mediaState() {
    var video = document.getElementById('video');
    var list = mediaCandidates(video);
    for (var i = 0; i < list.length; i++) {
      var url = list[i] || '';
      if (/^https?:/i.test(url) && !isPageUrl(url)) return { url: url, reason: '' };
    }
    /* 元素被换掉/清空后，同一集内用记忆里的地址兜底 */
    if (mediaMemo.url && mediaMemo.ep === episodeKey()) return { url: mediaMemo.url, reason: '' };
    var blob = video && String(video.currentSrc || video.src || '').indexOf('blob:') === 0;
    return { url: '', reason: blob ? 'opaque' : 'none' };
  }

  function mediaUrl() {
    return mediaState().url;
  }

  function mediaReason() {
    return mediaState().reason === 'opaque'
      ? LINK_UNSUPPORTED
      : '还没拿到直链：先点播放让这一集解析出地址，再试。';
  }

  /* ---------- 外放 / 下载菜单 ---------- */
  var downloadState = { id: '', name: '', show: '', ep: '', path: '', busy: false, percent: 0 };
  /* 这一集的剧名/封面/总集数/集号：下载完成时才能把「哪部剧的哪一集」记进片库。 */
  var pendingMeta = null;
  var LINK_UNSUPPORTED = '这条线路是加密或临时流，没法交给其他 App；换一条线路再试。';

  /* 登录门控的唯一依据：站点自己的账号 token（注入层与站点同源，读的是同一份）。 */
  function signedIn() {
    try { return !!localStorage.getItem('kj-auth-token'); } catch (error) { return false; }
  }

  function askLogin() {
    announce('登录后才能下载本集');
    /* 不另做一套账号 UI：打开站点自己的登录弹窗，用户登完再点一次下载。 */
    var trigger = document.querySelector ? document.querySelector('[data-action="login"]') : null;
    if (trigger && typeof trigger.click === 'function') {
      try { trigger.click(); } catch (error) { /* 打不开弹窗时只留提示 */ }
    }
  }

  function episodeLabel() {
    var active = document.querySelector ? document.querySelector('.ep.on') : null;
    var text = active && active.textContent ? String(active.textContent).trim() : '';
    return text.replace(/\s+/g, '').slice(0, 16);
  }

  /* 真实剧名：站点标题优先，绝不用 App 名冒充（REG-009） */
  function showTitle() {
    var meta = showMeta();
    var title = String(meta.title || '').replace(/\s+/g, ' ').trim();
    if (!title || /^追剧AI$/.test(title)) return '';
    return title;
  }

  /* 安全文件名：只换掉文件系统真的不接受的字符，不动中文和空格，不损真实剧名 */
  function safeName(raw) {
    var name = String(raw || '')
      .replace(/[\/\:*?"<>|]/g, '_')
      /* eslint-disable-next-line no-control-regex */
      .replace(/[ -]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[. ]+/, '')
      .trim();
    return name.slice(0, 80);
  }

  /* 文件名：真实剧名 + 集号，扩展名来自直链；原生层还会再清洗一次 */
  function downloadName() {
    var url = mediaUrl();
    var match = /\.(mp4|m4v|mov|mkv|ts)(?:[?#]|$)/i.exec(url || '');
    var ext = match ? '.' + match[1].toLowerCase() : '.mp4';
    var title = showTitle();
    var label = episodeLabel();
    var base = title || '未命名';
    if (label) base += ' ' + label;
    else if (Number(showMeta().total) === 1 || !showMeta().total) base += ' 正片';
    return safeName(base) + ext;
  }

  /* 锁屏/通知里的「现在播放」：走真实媒体会话元数据，iOS 读的是它，不是 DOM */
  function syncNowPlaying() {
    try {
      var session = navigator.mediaSession;
      if (!session || typeof MediaMetadata !== 'function') return;
      var meta = showMeta();
      var label = episodeLabel();
      var artwork = meta.cover && /^https?:/i.test(meta.cover) ? [{ src: meta.cover }] : [];
      session.metadata = new MediaMetadata({
        title: showTitle() || '追剧AI',
        artist: label || '',
        album: '',
        artwork: artwork,
      });
    } catch (error) { /* 媒体会话是增强项，失败不影响播放和下载 */ }
  }

  function castRow(id, label, note) {
    var row = document.createElement('button');
    row.id = id;
    row.type = 'button';
    row.className = 'pc-menu-row';
    var text = document.createElement('span');
    text.className = 'pc-menu-label';
    text.textContent = label;
    row.appendChild(text);
    var hint = document.createElement('small');
    hint.className = 'pc-menu-note';
    hint.textContent = note || '';
    row.appendChild(hint);
    return row;
  }

  function syncDownloadRow() {
    renderDownloadLibrary();
    syncTencentUI();
    saveDownload(false);
  }

  function closeCastMenu() {
    var menu = document.getElementById('ppCastMenu');
    if (menu) menu.className = 'pc-cast-menu';
  }

  function toggleCastMenu() {
    var menu = document.getElementById('ppCastMenu');
    if (!menu) return false;
    closeRateMenu();
    var open = String(menu.className).indexOf('pc-cast-menu on') >= 0;
    menu.className = open ? 'pc-cast-menu' : 'pc-cast-menu on';
    if (!open) syncDownloadRow();
    return true;
  }

  /* 交接前先停掉网页里的播放：不停的话 App 会继续用手机外放出声，
     用户听到的还是这一台手机在放，以为根本没交接出去。 */
  function stopInAppPlayback() {
    var video = document.getElementById('video');
    if (!video || typeof video.pause !== 'function') return;
    if (video.paused === false) {
      try { video.pause(); } catch (error) { /* 已经停了 */ }
    }
  }

  /* 第三方播放器：默认路径。一次点击把当前线路的 https 直链交给系统播放器列表，
     不需要先下载（HLS 线路也能交给 VLC 这类播放器）。 */
  function playExternal() {
    var url = mediaUrl();
    closeCastMenu();
    if (!url) { announce(mediaReason()); return false; }
    stopInAppPlayback();
    writeStore(EXT_PLAYER_PREF, '1');
    syncExtToggle();
    var title = document.title || '追剧AI';
    var bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.iosPlayer;
    if (bridge) {
      postNative({ action: 'share', url: url, title: title });
      announce('已交给系统播放器列表：选一个播放器接着看，App 内已暂停');
      return true;
    }
    var nav = typeof navigator === 'undefined' ? null : navigator;
    if (nav && typeof nav.share === 'function') {
      try { nav.share({ title: title, url: url }); } catch (error) { /* 用户取消 */ }
      announce('已打开系统分享，选一个播放器接着看');
      return true;
    }
    copyLink();
    return true;
  }

  function extPlayerDefault() {
    return readStore(EXT_PLAYER_PREF) !== '0';
  }

  function setExtPlayerDefault(on) {
    writeStore(EXT_PLAYER_PREF, on ? '1' : '0');
    syncExtToggle();
    announce(on ? '以后点「外放」直接用第三方播放器' : '以后点「外放」先打开菜单');
  }

  function syncExtToggle() {
    var toggle = document.getElementById('iosExtToggle');
    if (toggle) toggle.textContent = '播放方式：' + (extPlayerDefault() ? '第三方播放器' : 'App 内播放');
  }

  /* 分享直链：应用内原生分享面板 -> navigator.share -> AirPlay 选择器 */
  function shareLink() {
    var url = mediaUrl();
    closeCastMenu();
    if (!url) { announce(mediaReason()); return; }
    stopInAppPlayback();
    var title = document.title || '追剧AI';
    var bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.iosPlayer;
    if (bridge) {
      postNative({ action: 'share', url: url, title: title });
      announce('已打开系统分享面板');
      return;
    }
    var nav = typeof navigator === 'undefined' ? null : navigator;
    if (nav && typeof nav.share === 'function') {
      var shared = nav.share({ title: title, url: url });
      if (shared && typeof shared.then === 'function') {
        shared.then(function () { /* 交给用户选目标 App */ }, function () { /* 用户取消 */ });
      }
      return;
    }
    var video = document.getElementById('video');
    if (video && typeof video.webkitShowPlaybackTargetPicker === 'function') {
      try {
        video.webkitShowPlaybackTargetPicker();
        return;
      } catch (error) { /* 落到复制 */ }
    }
    copyLink();
  }

  function copyLink() {
    var url = mediaUrl();
    closeCastMenu();
    if (!url) { announce(mediaReason()); return; }
    var nav = typeof navigator === 'undefined' ? null : navigator;
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      nav.clipboard.writeText(url).then(function () {
        announce('播放地址已复制，粘到播放器 App 里即可');
      }, function () {
        announce('复制失败，地址：' + url.slice(0, 56));
      });
      return;
    }
    announce('这台设备没有剪贴板通道，地址：' + url.slice(0, 56));
  }

  function megabyte(bytes) {
    var size = Number(bytes) || 0;
    return (size / 1048576).toFixed(1) + ' MB';
  }

  /* ---------- 持久下载队列 ---------- */
  var BATCH_STORE = 'kj-ios-batch';
  var QUEUE_STORE = 'kj-ios-queue';
  var queueTasks = [];

  function readBatchShows() {
    var parsed = null;
    try { parsed = JSON.parse(readStore(BATCH_STORE) || 'null'); } catch (error) { parsed = null; }
    return parsed && typeof parsed.length === 'number' ? parsed : [];
  }

  function rememberBatchShow(show) {
    var list = readBatchShows();
    var id = String(show.id || show.title || '');
    if (!id) return;
    var next = [];
    var found = false;
    for (var i = 0; i < list.length; i++) {
      if (!list[i]) continue;
      if (String(list[i].id) === id) {
        next.push({
          id: id,
          title: show.title || list[i].title,
          cover: show.cover || list[i].cover,
          total: Number(show.total) || Number(list[i].total) || 0,
          at: Date.now()
        });
        found = true;
      } else {
        next.push(list[i]);
      }
    }
    if (!found) {
      next.unshift({ id: id, title: show.title || '', cover: show.cover || '', total: Number(show.total) || 0, at: Date.now() });
    }
    writeStore(BATCH_STORE, JSON.stringify(next.slice(0, 30)));
  }

  function restoreQueue() {
    var parsed = null;
    try { parsed = JSON.parse(readStore(QUEUE_STORE) || 'null'); } catch (error) { parsed = null; }
    if (parsed && typeof parsed.length === 'number') queueTasks = parsed;
  }

  function saveQueue() {
    writeStore(QUEUE_STORE, JSON.stringify(queueTasks.slice(0, 300)));
  }

  function updateQueueProgress(payload) {
    if (!payload || !payload.id) return;
    for (var index = 0; index < queueTasks.length; index++) {
      if (String(queueTasks[index].id) !== String(payload.id)) continue;
      queueTasks[index].status = 'running';
      queueTasks[index].total = Number(payload.total) || 0;
      queueTasks[index].received = Number(payload.received) || 0;
      saveQueue();
      return;
    }
  }

  function updateMineProgress(total, received) {
    var page = document.getElementById('iosMinePage');
    if (!page || page.hidden) return;
    var meta = document.getElementById('iosMineRunningMeta');
    if (meta) {
      var percent = total > 0 ? Math.min(100, Math.round(received / total * 100)) : 0;
      meta.textContent = '接收中 · ' + (total > 0 ? percent + '% · ' : '') + megabyte(received);
    }
    var progress = document.getElementById('iosMineRunningProgress');
    if (progress) {
      progress.max = total || 1;
      progress.value = total > 0 ? Math.min(received, total) : 0;
      progress.hidden = total <= 0;
    }
  }

  function removeQueueTask(id) {
    if (!id) return;
    var next = [];
    for (var index = 0; index < queueTasks.length; index++) {
      if (String(queueTasks[index].id) !== String(id)) next.push(queueTasks[index]);
    }
    queueTasks = next;
    saveQueue();
  }

  function epNodes() {
    return document.querySelectorAll ? document.querySelectorAll('#epGrid .ep') : [];
  }

  function epKeyOf(node) {
    if (!node || !node.dataset || node.dataset.ep === undefined || node.dataset.ep === null) return '';
    return String(node.dataset.ep);
  }

  function currentEpIndex() {
    var episodes = epNodes();
    for (var index = 0; index < episodes.length; index++) {
      if (String(episodes[index].className).split(' ').indexOf('on') >= 0) return index;
    }
    return 0;
  }

  function epLabelOf(node) {
    var text = node && node.textContent ? String(node.textContent).trim() : '';
    return text.replace(/\s+/g, '').slice(0, 16);
  }

  function currentLine() {
    var active = document.querySelector ? document.querySelector('.line.on') : null;
    if (active && active.dataset && active.dataset.line) return String(active.dataset.line);
    try { return new URLSearchParams(window.location.search).get('line') || ''; } catch (error) { return ''; }
  }

  function extensionOf(url) {
    var match = /\.(mp4|m4v|mov|mkv|ts)(?:[?#]|$)/i.exec(String(url || ''));
    return match ? '.' + match[1].toLowerCase() : '.mp4';
  }

  /* 每集都向站点接口要真实片源（show + ep + 线路），并核对 showId/集号/verified；
     播放页 URL、HLS 清单、不匹配的集一律不下载，只给出原因。 */
  function resolveEpisodeUrl(showIdValue, key, line) {
    var query = '/api/play?show=' + encodeURIComponent(showIdValue) + '&ep=' + encodeURIComponent(key)
      + (line ? '&line=' + encodeURIComponent(line) : '');
    batchResolving += 1;
    return window.fetch(query).then(function (response) {
      if (!response || !response.ok) return { reason: '第' + key + '集解析失败（' + (response ? response.status : '无响应') + '）' };
      return response.json();
    }).then(function (data) {
      if (!data || data.error) return { reason: '第' + key + '集没有可用片源' };
      if (String(data.showId) !== String(showIdValue) || Number(data.idx) !== Number(key) || data.verified !== true) {
        return { reason: '第' + key + '集片源与选集不匹配，已跳过' };
      }
      if (data.kind === 'hls') return { reason: '第' + key + '集是 HLS 分片线路，不能整集下载' };
      if (data.kind !== 'mp4') return { reason: '第' + key + '集线路类型不支持下载' };
      var media;
      try { media = new URL(data.url); } catch (error) { return { reason: '第' + key + '集地址无效' }; }
      if (!allowedMediaOrigin(media) || isPageUrl(media.href)) return { reason: '第' + key + '集没有解析到真实视频地址' };
      if (/\.m3u8(?:[?#]|$)/i.test(media.href)) return { reason: '第' + key + '集是 HLS 分片线路，不能整集下载' };
      return { url: media.href, reason: '' };
    }).catch(function () { return { reason: '第' + key + '集解析失败' }; }).then(function (result) {
      batchResolving = Math.max(0, batchResolving - 1);
      return result;
    }, function (error) {
      batchResolving = Math.max(0, batchResolving - 1);
      return { reason: '第' + key + '集解析失败' };
    });
  }

  /* 批量入队：先逐集解析真实片源，再把整批交给原生那条队列（并发/去重都在原生层）。 */
  function startBatch(nodes) {
    if (!signedIn()) { askLogin(); return Promise.resolve(0); }
    if (!nodes || !nodes.length) { announce('先选几集再下载'); return Promise.resolve(0); }
    var meta = showMeta();
    var id = String(meta.id || meta.title || '');
    var line = currentLine();
    var total = epNodes().length || Number(meta.total) || 0;
    rememberBatchShow({ id: id, title: meta.title, cover: meta.cover, total: total });
    announce('正在解析 ' + nodes.length + ' 集的片源…');
    var jobs = [];
    for (var i = 0; i < nodes.length; i++) {
      (function (node) {
        var key = epKeyOf(node);
        jobs.push(resolveEpisodeUrl(id, key, line).then(function (result) {
          if (!result.url) return { reason: result.reason, key: key };
          return { url: result.url, key: key, label: epLabelOf(node) || ('第' + key + '集') };
        }));
      }(nodes[i]));
    }
    return Promise.all(jobs).then(function (results) {
      var items = [];
      var skipped = [];
      for (var r = 0; r < results.length; r++) {
        if (!results[r].url) { skipped.push(results[r].reason); continue; }
        var key = results[r].key;
        var label = results[r].label;
        items.push({
          id: 'dl' + Date.now() + '-' + key,
          showId: id,
          epKey: key,
          epLabel: label,
          title: meta.title || '',
          url: results[r].url,
          name: safeName(String(meta.title || '未命名') + ' ' + label) + extensionOf(results[r].url)
        });
      }
      if (!items.length) { announce(skipped[0] || '这些集都没有可下载的片源'); return 0; }
      postNative({
        action: 'downloadBatch',
        signedIn: true,
        show: { id: id, title: meta.title || '', cover: meta.cover || '', total: total },
        items: items
      });
      announce('已加入下载队列：' + items.length + ' 集'
        + (skipped.length ? '，跳过 ' + skipped.length + ' 集（' + skipped[0] + '）' : '')
        + '；同时最多下 2 集');
      return items.length;
    });
  }

  /* 原生 done 事件自带 showId / 集号 / 剧名；旧版事件没有剧名时，
     从「一键全集」记住的剧信息和最近一次队列快照里补齐，绝不靠当前页面猜。 */
  function metaFromDone(payload) {
    var batch = null;
    var batches = readBatchShows();
    for (var b = 0; b < batches.length; b++) {
      if (String(batches[b].id) === String(payload.showId || '')) batch = batches[b];
    }
    var task = null;
    for (var t = 0; t < queueTasks.length; t++) {
      if (String(queueTasks[t].id) === String(payload.id || '')) task = queueTasks[t];
    }
    var meta = showMeta();
    return {
      id: String(payload.showId || (batch && batch.id) || meta.id || ''),
      title: String(payload.title || (batch && batch.title) || (task && task.title) || meta.title || ''),
      cover: String(payload.cover || (batch && batch.cover) || (task && task.cover) || meta.cover || ''),
      total: Number(payload.showTotal) || (batch && Number(batch.total)) || (pendingMeta && Number(pendingMeta.total)) || Number(meta.total) || 0,
      epKey: String(payload.epKey || (task && task.epKey) || ''),
      epLabel: String(payload.ep || (task && task.epLabel) || '')
    };
  }

  /* 这条 done 是不是刚刚下完的「当前这一集」：批量任务的 id 和单集任务不同，
     只能靠集号（epKey / 集标签）比对，绝不按「队列里还有别的集」猜。 */
  function isCurrentEp(payload) {
    var list = epNodes();
    if (!list || !list.length) return false;
    var node = list[currentEpIndex()];
    var key = epKeyOf(node);
    var label = epLabelOf(node);
    var doneKey = payload.epKey === undefined || payload.epKey === null ? '' : String(payload.epKey);
    var doneLabel = String(payload.ep || '').replace(/\s+/g, '');
    if (doneKey && key) return doneKey === String(key);
    return !!doneLabel && !!label && doneLabel === label;
  }

  /* 原生层回传：同一个 id 才认，避免换集之后旧任务改乱新状态 */
  window.__zhuijuDownload = function (payload) {
    if (!payload) return;
    var event = payload.event;
    /* 批量任务的 id 和「当前单集」不是同一个：完成事件仍要写进片库。
       只认带真实落盘路径的 done，按 showId + 集号去重且幂等。 */
    if (event === 'done' && payload.path && (payload.showId || payload.epKey)) {
      recordDownloaded(payload, metaFromDone(payload));
    }
    /* 单集进度条只对当前这一集响应；其它任务照常入库，不改本集状态 */
    if (!downloadState.id || payload.id !== downloadState.id) {
      /* 批量把这一集下完，脚下那行不能还写着「尚未下载」：
         文件是真的、就是这一集，按当前集的真实落盘结果更新这一行。 */
      if (event === 'done' && payload.path && !downloadState.busy && !downloadState.path && isCurrentEp(payload)) {
        var doneMeta = metaFromDone(payload);
        downloadState.id = String(payload.id || '');
        downloadState.name = String(payload.name || '');
        downloadState.show = doneMeta.title;
        downloadState.ep = doneMeta.epLabel;
        downloadState.path = String(payload.path || '');
        downloadState.busy = false;
        downloadState.percent = 100;
        downloadState.error = '';
        pendingMeta = doneMeta;
        syncDownloadRow();
        saveDownload(true);
        return;
      }
      if (event === 'progress') {
        updateQueueProgress(payload);
        updateMineProgress(Number(payload.total) || 0, Number(payload.received) || 0);
        var downloadPage = document.getElementById('iosDlPage');
        if (downloadPage && !downloadPage.hidden) syncDownloadPage();
      }
      if (event === 'done' || event === 'failed' || event === 'cancelled') removeQueueTask(payload.id);
      if (event === 'done') { syncDownloadRow(); renderMinePageIfOpen(); }
      return;
    }
    if (event === 'progress') {
      var total = Number(payload.total) || 0;
      var received = Number(payload.received) || 0;
      updateQueueProgress(payload);
      downloadState.busy = true;
      downloadState.percent = total > 0 ? Math.min(100, Math.round(received / total * 100)) : 0;
      downloadState.total = total;
      downloadState.received = received;
      downloadState.path = payload.path || downloadState.path || '';
      saveDownload(false);
      updateMineProgress(total, received);
      var downloadPage = document.getElementById('iosDlPage');
      if (downloadPage && !downloadPage.hidden) syncDownloadPage();
      return;
    }
    if (event === 'done') {
      /* 没有 showId/集号的老式单集事件走原来的 pendingMeta 路径 */
      if (!payload.showId && !payload.epKey) recordDownloaded(payload, pendingMeta);
      pendingMeta = null;
      removeQueueTask(payload.id);
      downloadState.busy = false;
      downloadState.percent = 100;
      downloadState.total = Number(payload.total) || downloadState.total || 0;
      downloadState.received = Number(payload.received) || downloadState.received || 0;
      downloadState.path = payload.path || '';
      syncDownloadRow();
      saveDownload(true);
      renderMinePageIfOpen();
      announce('已下载 ' + (payload.name || downloadState.name) + '（' + megabyte(payload.size) + '），点「用其他播放器播放」选择 App');
      return;
    }
    downloadState.busy = false;
    removeQueueTask(payload.id);
    downloadState.percent = 0;
    downloadState.error = event === 'cancelled' ? '已取消' : (payload.reason || '下载失败');
    downloadState.path = '';
    pendingMeta = null;
    syncDownloadRow();
    saveDownload(true);
    renderMinePageIfOpen();
    if (event === 'cancelled') announce('已取消下载');
    else announce('下载失败：' + (payload.reason || '网络不给力，稍后再试'));
  };

  /* 原生队列快照：整部剧的进度、排队/暂停/失败状态都从这份快照来（重启后也一样） */
  window.__zhuijuDownloads = function (kind, tasks) {
    if (kind !== 'snapshot' || !tasks || typeof tasks.length !== 'number') return;
    queueTasks = tasks;
    saveQueue();
    renderDownloadLibrary();
    syncDownloadPage();
    syncTencentUI();
    renderMinePageIfOpen();
  };

  /// 这一集在共享队列里的状态（同一集可能有多条历史记录，取最「活跃」的一条）。
  function dlTaskState(showId, key) {
    var rank = { running: 5, queued: 4, paused: 3, failed: 2, cancelled: 1, done: 0 };
    var best = null;
    var bestRank = -1;
    for (var i = 0; i < queueTasks.length; i++) {
      var task = queueTasks[i];
      if (!task || String(task.showId || '') !== String(showId)) continue;
      var taskKey = task.epKey === undefined || task.epKey === null ? '' : String(task.epKey);
      if (taskKey !== String(key)) continue;
      var status = String(task.status || '');
      var value = rank[status] === undefined ? 0 : rank[status];
      if (value > bestRank) { best = task; bestRank = value; }
    }
    return best;
  }

  /// 这一集是否已经在片库里（下载完成过）。
  function dlDownloaded(showId, key) {
    var library = readLibrary();
    for (var s = 0; s < library.shows.length; s++) {
      var show = library.shows[s];
      if (String(show.id) !== String(showId)) continue;
      for (var e = 0; e < show.eps.length; e++) {
        if (String(show.eps[e].key) === String(key)) return true;
      }
    }
    return false;
  }

  /// 每集那一行的状态文字：先看队列（在跑/排队优先于历史完成），再看片库。
  function dlStateText(showId, key) {
    var task = dlTaskState(showId, key);
    var status = task ? String(task.status || '') : '';
    if (status === 'running') {
      var total = Number(task.total) || 0;
      var received = Number(task.received) || 0;
      /* 总长度未知就只写「下载中」，绝不编一个百分比 */
      return total > 0 ? '下载中 ' + Math.min(100, Math.round(received / total * 100)) + '%' : '下载中';
    }
    if (status === 'queued') return '排队中';
    if (status === 'paused') return '已暂停';
    if (status === 'failed') return '失败';
    if (status === 'cancelled') return '已取消';
    if (dlDownloaded(showId, key)) return '已下载';
    if (status === 'done') return '已下载';
    return '未下载';
  }

  function dlShowId() {
    var meta = showMeta();
    return String(meta.id || meta.title || '');
  }

  /// 点一格：立刻入队（单集），格子马上变「下载中」并给一句轻提示。
  function startEpisodeDownload(key) {
    var nodes = epNodes();
    for (var i = 0; i < nodes.length; i++) {
      if (epKeyOf(nodes[i]) !== key) continue;
      announce('已加入下载');
      startBatch([nodes[i]]);
      return true;
    }
    return false;
  }

  function dlRowKeyOf(node) {
    var cursor = node;
    while (cursor) {
      var key = '';
      if (typeof cursor.getAttribute === 'function') {
        try { key = cursor.getAttribute('data-dl-ep'); } catch (error) { key = ''; }
      }
      if (key !== null && key !== undefined && String(key) !== '') return String(key);
      cursor = cursor.parentNode;
    }
    return '';
  }

  /* ==================== 0.1.17 五屏 UI（ios/UX_SPEC.md） ====================
     只借布局与交互，图标全用文字/自绘；没有会员、广告、弹幕、二创、VIP 角标。
     所有新节点都带 data-ios-act，点击统一走下面的 handleTencentUI 分发，
     这样不用往原有那一长串 if 里再插分支。 */

  var PLAY_PREF = 'kj-ios-play-settings';
  var QUALITY_PREF = 'kj-ios-quality';
  var FOLLOW_STORE = 'kj-ios-follow';
  var loopMode = 'off';
  var subtitleOn = false;
  var epTitleOn = true;
  var sleepTimer = '';

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (error) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) { /* 存不了只影响记忆 */ }
  }
  function readPlayPrefs() {
    var prefs = readJSON(PLAY_PREF, null) || {};
    loopMode = prefs.loop || 'off';
    subtitleOn = !!prefs.subtitle;
    epTitleOn = prefs.epTitle === undefined ? true : !!prefs.epTitle;
  }
  function savePlayPrefs() {
    writeJSON(PLAY_PREF, { loop: loopMode, subtitle: subtitleOn, epTitle: epTitleOn });
  }
  function quality() {
    var stored = '';
    try { stored = String(localStorage.getItem(QUALITY_PREF) || ''); } catch (error) { stored = ''; }
    return stored || '720P';
  }
  function setQuality(next) {
    try { localStorage.setItem(QUALITY_PREF, next); } catch (error) { /* 忽略 */ }
    var label = document.getElementById('iosFsQuality');
    if (label) label.textContent = next;
  }
  function followed() {
    var list = readJSON(FOLLOW_STORE, []) || [];
    return list.indexOf(dlShowId()) >= 0;
  }
  function toggleFollow() {
    var id = dlShowId();
    var list = readJSON(FOLLOW_STORE, []) || [];
    var at = list.indexOf(id);
    if (at >= 0) list.splice(at, 1);
    else list.push(id);
    writeJSON(FOLLOW_STORE, list);
    var button = document.getElementById('iosFollow');
    if (button) {
      button.className = at >= 0 ? '' : 'on';
      button.textContent = at >= 0 ? '追剧' : '已追剧';
    }
    announce(at >= 0 ? '已取消追剧' : '已加入追剧');
  }

  /* ---- 剩余空间：真实取一次设备容量（拿不到就如实写「未知」，不编数字） ---- */
  function storageText() {
    var quota = navigator.storage && navigator.storage.estimate ? navigator.storage.estimate() : null;
    if (!quota || typeof quota.then !== 'function') return { used: '', free: '剩余空间未知' };
    var box = { used: '', free: '剩余空间未知' };
    quota.then(function (info) {
      var usage = Number(info && info.usage) || 0;
      var total = Number(info && info.quota) || 0;
      if (total > 0) {
        box.used = '已使用 ' + megabyte(usage);
        box.free = '剩余 ' + megabyte(Math.max(0, total - usage)) + ' 可用';
      }
      var footer = document.getElementById('iosDlFree');
      if (footer) footer.textContent = box.free;
      var footer2 = document.getElementById('iosMineUsage');
      if (footer2) footer2.textContent = (box.used ? box.used + ' · ' : '') + box.free;
    }).catch(function () { /* 保底文案已经写着「未知」 */ });
    return box;
  }

  /* ---- ① 播放页：顶部 返回/投屏/分享/更多，剧名旁 追剧/下载，信息行，选集标题 ---- */
  function mountPlayerChrome() {
    var player = document.getElementById('player');
    if (player && typeof player.appendChild === 'function' && !document.getElementById('iosTopBar')) {
      var top = document.createElement('div');
      top.id = 'iosTopBar';
      top.innerHTML = ''
        + '<button type="button" data-ios-act="back" aria-label="返回">‹</button>'
        + '<span class="iostb-title" id="iosTopTitle"></span>'
        + '<button type="button" data-ios-act="cast" aria-label="投屏">投屏</button>'
        + '<button type="button" data-ios-act="share" aria-label="分享">分享</button>'
        + '<button type="button" data-ios-act="play-settings" aria-label="更多">···</button>';
      player.appendChild(top);
    }
    var grid = document.getElementById('epGrid');
    var host = grid && grid.parentNode;
    if (!host) return false;
    var meta = showMeta();
    /* 剧名 + 追剧 / 下载（点 ⬇ 打开整页的下载页，规格 §2） */
    if (!document.getElementById('iosTitleRow')) {
      var row = document.createElement('div');
      row.id = 'iosTitleRow';
      row.innerHTML = ''
        + '<span class="iostr-name" id="iosTitleName"></span>'
        + '<button type="button" id="iosFollow" aria-label="追剧">追剧</button>'
        + '<button type="button" id="iosTitleDownload" data-ios-act="open-download" aria-label="下载">下载 ⬇</button>';
      host.insertBefore(row, host.firstChild);
    }
    var titleName = document.getElementById('iosTitleName');
    if (titleName) titleName.textContent = meta.title || '正在播放';
    var follow = document.getElementById('iosFollow');
    if (follow && !follow.__iosSynced) {
      follow.__iosSynced = true;
      var on = followed();
      follow.className = on ? 'on' : '';
      follow.textContent = on ? '已追剧' : '追剧';
    }
    /* 信息行：类型 · 评分 · 标签 · 简介 › —— 站点给了什么就显示什么，没有的字段不编 */
    if (!document.getElementById('iosInfoRow')) {
      var info = document.createElement('div');
      info.id = 'iosInfoRow';
      info.innerHTML = '<span id="iosInfoText"></span>'
        + '<button class="iosir-more" type="button" data-ios-act="intro" aria-label="简介">简介 ›</button>';
      host.insertBefore(info, document.getElementById('iosTitleRow').nextSibling);
    }
    var infoText = document.getElementById('iosInfoText');
    if (infoText && !infoText.__iosSynced) {
      infoText.__iosSynced = true;
      var bits = [];
      var tags = document.querySelectorAll ? document.querySelectorAll('.detail-tags span,.detail-info .tag') : [];
      for (var t = 0; t < tags.length && bits.length < 3; t++) {
        var text = String(tags[t].textContent || '').trim();
        if (text) bits.push(text);
      }
      if (Number(meta.total) > 0) bits.push('全 ' + meta.total + ' 集');
      infoText.textContent = bits.length ? bits.join(' · ') : '剧集信息';
    }
    /* 选集标题：选集 全N集 ›（点开展开全部集数） */
    if (!document.getElementById('iosEpHead')) {
      var head = document.createElement('div');
      head.id = 'iosEpHead';
      head.innerHTML = '<button class="ioseh-title" type="button" data-ios-act="expand-eps" id="iosEpHeadBtn"></button>';
      host.insertBefore(head, grid);
    }
    var headBtn = document.getElementById('iosEpHeadBtn');
    if (headBtn) headBtn.textContent = '选集 全' + (Number(meta.total) || epNodes().length) + '集 ›';
    return true;
  }

  /* ---- ② 下载页（整页推入） ---- */
  function ensureDownloadPage() {
    if (document.getElementById('iosDlPage')) return document.getElementById('iosDlPage');
    if (!document.body) return null;
    var page = document.createElement('div');
    page.id = 'iosDlPage';
    page.className = 'ios-page';
    page.hidden = true;
    page.innerHTML = ''
      + '<div class="ip-head">'
      + '  <button type="button" data-ios-act="dl-back" aria-label="返回">‹</button>'
      + '  <span class="ip-title">点击集数即可下载</span>'
      + '</div>'
      + '<div class="ip-body">'
      + '  <div class="ip-row"><span class="ip-label">下载画质</span>'
      + '    <button type="button" id="iosDlQuality" data-ios-act="quality">720P ›</button></div>'
      + '  <div class="ip-sub" id="iosDlCount"></div>'
      + '  <div id="iosDlGrid6"></div>'
      + '</div>'
      + '<div class="ip-foot">'
      + '  <button type="button" id="iosDlListBtn" data-ios-act="open-mine">查看下载列表</button>'
      + '  <span id="iosDlFree">剩余空间未知</span>'
      + '</div>';
    document.body.appendChild(page);
    return page;
  }

  function openDownloadPage() {
    var page = ensureDownloadPage();
    if (!page) return false;
    page.hidden = false;
    if (typeof page.removeAttribute === 'function') page.removeAttribute('hidden');
    var qualityBtn = document.getElementById('iosDlQuality');
    if (qualityBtn) qualityBtn.textContent = quality() + ' ›';
    syncDownloadPage();
    storageText();
    return true;
  }
  function closeDownloadPage() {
    var page = document.getElementById('iosDlPage');
    if (!page) return;
    page.hidden = true;
    if (typeof page.setAttribute === 'function') page.setAttribute('hidden', '');
  }

  /// 每行 6 格；点一格立刻下载（规格 §2，不做下载全部）
  function syncDownloadPage() {
    var grid = document.getElementById('iosDlGrid6');
    if (!grid) return;
    var nodes = epNodes();
    var showId = dlShowId();
    var count = document.getElementById('iosDlCount');
    if (count) count.textContent = '共 ' + nodes.length + ' 集 · 点一下立即加入下载';
    for (var i = 0; i < nodes.length; i++) {
      var key = epKeyOf(nodes[i]);
      var label = epLabelOf(nodes[i]) || ('第' + key + '集');
      var state = dlStateText(showId, key);
      var cell = document.getElementById('iosDlCell6-' + key);
      if (!cell) {
        cell = document.createElement('button');
        cell.type = 'button';
        cell.id = 'iosDlCell6-' + key;
        cell.className = 'ip-cell';
        cell.setAttribute('data-ios-act', 'download-episode');
        cell.setAttribute('data-dl-ep', key);
        var nameNode = document.createElement('span');
        nameNode.textContent = /^第\d+集$/.test(label) ? label : label;
        cell.appendChild(nameNode);
        var stateNode = document.createElement('span');
        stateNode.className = 'ip-cell-state';
        cell.appendChild(stateNode);
        cell.__iosState = stateNode;
        grid.appendChild(cell);
      }
      if (cell.__iosState) cell.__iosState.textContent = state === '已下载' ? '已下载' : state;
      cell.className = 'ip-cell'
        + (state === '已下载' ? ' done' : '')
        + (state.indexOf('下载中') === 0 || state === '排队中' ? ' busy' : '');
      cell.setAttribute('aria-label', label + ' ' + state);
    }
  }

  /* ---- ③ 我的下载（正在下载 + 按剧分组 + 左滑删除 + 底部占用） ---- */
  function ensureMinePage() {
    if (document.getElementById('iosMinePage')) return document.getElementById('iosMinePage');
    if (!document.body) return null;
    var page = document.createElement('div');
    page.id = 'iosMinePage';
    page.className = 'ios-page';
    page.hidden = true;
    page.innerHTML = ''
      + '<div class="ip-head">'
      + '  <button type="button" data-ios-act="mine-back" aria-label="返回下载页">‹</button>'
      + '  <span class="ip-title">我的下载</span>'
      + '  <button type="button" data-ios-act="mine-edit" aria-label="编辑">编辑</button>'
      + '</div>'
      + '<div class="ip-body" id="iosMineBody"></div>'
      + '<div class="ip-foot"><span id="iosMineUsage">剩余空间未知</span></div>';
    document.body.appendChild(page);
    return page;
  }

  function openMinePage() {
    var page = ensureMinePage();
    if (!page) return false;
    var downloadPage = document.getElementById('iosDlPage');
    page.__iosReturnToDownloads = !!(downloadPage && !downloadPage.hidden);
    page.hidden = false;
    if (typeof page.removeAttribute === 'function') page.removeAttribute('hidden');
    renderMinePage();
    storageText();
    return true;
  }
  function closeMinePage() {
    var page = document.getElementById('iosMinePage');
    if (!page) return;
    page.hidden = true;
    if (typeof page.setAttribute === 'function') page.setAttribute('hidden', '');
  }

  function renderMinePageIfOpen() {
    var page = document.getElementById('iosMinePage');
    if (page && !page.hidden) renderMinePage();
  }

  function renderMinePage() {
    var body = document.getElementById('iosMineBody');
    if (!body) return;
    body.innerHTML = '';
    var showId = dlShowId();
    /* 正在下载：队列里 running / queued 的集 */
    var running = [];
    for (var q = 0; q < queueTasks.length; q++) {
      var task = queueTasks[q];
      var status = String(task && task.status || '');
      if (status === 'running' || status === 'queued') running.push(task);
    }
    if (running.length || downloadState.busy) {
      var row = document.createElement('div');
      row.id = 'iosMineRunning';
      var currentTask = running.length ? running[0] : downloadState;
      var activeDownload = running.length ? currentTask : {
        total: downloadState.total,
        received: downloadState.received
      };
      var total = Number(activeDownload.total) || 0;
      var received = Number(activeDownload.received) || 0;
      var percent = total > 0 ? Math.min(100, Math.round(received / total * 100)) : 0;
      row.innerHTML = ''
        + '<div class="imr-main">'
        + '  <div class="imr-title" id="iosMineRunningTitle"></div>'
        + '  <div class="imr-meta" id="iosMineRunningMeta"></div>'
        + '  <progress class="imr-progress" id="iosMineRunningProgress" max="1"></progress>'
        + '  <code class="imr-path" id="iosMineRunningPath"></code>'
        + '</div>';
      var badge = document.createElement('span');
      badge.textContent = '正在下载 ' + Math.max(running.length, 1) + ' 集';
      row.appendChild(badge);
      body.appendChild(row);
      var t = document.getElementById('iosMineRunningTitle');
      if (t) t.textContent = (currentTask.title || currentTask.show || showMeta().title || '') + ' ' + (currentTask.epLabel || currentTask.ep || '');
      var m = document.getElementById('iosMineRunningMeta');
      if (m) {
        m.textContent = '接收中 · ' + (total > 0 && received > 0 ? percent + '% · ' : '')
          + megabyte(received) + (running.length > 1 ? ' · 其余 ' + (running.length - 1) + ' 集排队' : '');
      }
      var progress = document.getElementById('iosMineRunningProgress');
      if (progress) {
        progress.max = total || 1;
        progress.value = total > 0 ? Math.min(received, total) : 0;
        progress.hidden = total <= 0;
      }
      var path = document.getElementById('iosMineRunningPath');
      if (path) path.textContent = '保存位置：追剧AI App「我的」-「我的下载」';
    }
    /* 已下载：按剧分组，每部下面一行一集，左滑删除 */
    var shows = readLibrary().shows;
    if (!shows.length) {
      var empty = document.createElement('div');
      empty.className = 'ip-sub';
      empty.textContent = '还没有下载完成的剧集';
      body.appendChild(empty);
    }
    for (var i = 0; i < shows.length; i++) {
      var show = shows[i];
      var size = 0;
      for (var e = 0; e < show.eps.length; e++) size += Number(show.eps[e].size) || 0;
      var block = document.createElement('div');
      block.setAttribute('data-show', show.id);
      var head = document.createElement('div');
      head.className = 'ip-show';
      if (show.cover) {
        var img = document.createElement('img');
        img.src = show.cover;
        img.alt = show.title;
        head.appendChild(img);
      }
      var main = document.createElement('div');
      main.className = 'ips-main';
      var name = document.createElement('div');
      name.className = 'ips-title';
      name.textContent = show.title;
      main.appendChild(name);
      var meta = document.createElement('div');
      meta.className = 'ips-meta';
      meta.textContent = '已下载 ' + show.eps.length + ' 集 · ' + megabyte(size);
      main.appendChild(meta);
      head.appendChild(main);
      block.appendChild(head);
      for (var k = 0; k < show.eps.length; k++) {
        (function (ep) {
          var epRow = document.createElement('div');
          epRow.className = 'ip-eprow';
          epRow.setAttribute('data-dl-show', show.id);
          epRow.setAttribute('data-dl-key', String(ep.key));
          epRow.setAttribute('aria-label', (ep.label || ('第' + ep.key + '集')) + ' 已下载，左滑可删除');
          var body2 = document.createElement('div');
          body2.className = 'ip-epbody';
          var title = document.createElement('span');
          title.className = 'ip-eptitle';
          title.textContent = ep.label || ('第' + ep.key + '集');
          body2.appendChild(title);
          var sizeNode = document.createElement('span');
          sizeNode.className = 'ip-epsize';
          sizeNode.textContent = ep.size ? megabyte(ep.size) : '';
          body2.appendChild(sizeNode);
          epRow.appendChild(body2);
          var del = document.createElement('button');
          del.className = 'ip-epdel';
          del.type = 'button';
          del.textContent = '删除';
          del.setAttribute('data-dl-delete', '1');
          epRow.appendChild(del);
          block.appendChild(epRow);
        }(show.eps[k]));
      }
      body.appendChild(block);
    }
    bindMineSwipe(body);
  }

  var mineSwipe = null;
  function bindMineSwipe(body) {
    if (!body || body.__iosMineSwipe || typeof body.addEventListener !== 'function') return;
    body.__iosMineSwipe = true;
    function rowOf(node) {
      var cursor = node;
      while (cursor) {
        if (cursor.className && String(cursor.className).split(' ').indexOf('ip-eprow') >= 0) return cursor;
        cursor = cursor.parentNode;
      }
      return null;
    }
    function shift(row, dx) {
      var inner = row.children ? row.children[0] : null;
      if (!inner || !inner.style) return;
      var limit = 84;
      var offset = Math.max(-limit, Math.min(0, dx));
      inner.style.transform = offset ? 'translateX(' + offset + 'px)' : '';
    }
    body.addEventListener('touchstart', function (event) {
      var touch = event.touches && event.touches[0];
      if (!touch) return;
      mineSwipe = { x: touch.clientX, y: touch.clientY, row: rowOf(event.target) };
    }, { passive: true });
    body.addEventListener('touchmove', function (event) {
      if (!mineSwipe || !mineSwipe.row) return;
      var touch = event.touches && event.touches[0];
      if (!touch) return;
      var dx = touch.clientX - mineSwipe.x;
      var dy = touch.clientY - mineSwipe.y;
      if (Math.abs(dy) > Math.abs(dx) + 6) { mineSwipe = null; return; }
      if (dx > 0) return;
      shift(mineSwipe.row, dx);
    }, { passive: true });
    body.addEventListener('touchend', function () {
      if (!mineSwipe || !mineSwipe.row) return;
      var row = mineSwipe.row;
      mineSwipe = null;
      var inner = row.children ? row.children[0] : null;
      var moved = inner && inner.style ? /translateX\(/.test(String(inner.style.transform)) : false;
      shift(row, moved ? -84 : 0);
    }, { passive: true });
  }

  /* ---- ⑤ 播放设置面板（从右侧滑出） ---- */
  function ensurePlaySettings() {
    if (document.getElementById('iosPlaySettings')) return document.getElementById('iosPlaySettings');
    if (!document.body) return null;
    var panel = document.createElement('div');
    panel.id = 'iosPlaySettings';
    panel.innerHTML = ''
      + '<div class="ips-card">'
      + '  <div class="ips-head"><span class="ips-title">播放设置</span>'
      + '    <button type="button" data-ios-act="ps-close" aria-label="关闭">✕</button></div>'
      + '  <div class="ips-icons">'
      + '    <button type="button" data-ios-act="ps-download" aria-label="下载">下载</button>'
      + '    <button type="button" data-ios-act="ps-fill" aria-label="撑满全屏">撑满全屏</button>'
      + '    <button type="button" data-ios-act="ps-pip" aria-label="画中画">画中画</button>'
      + '    <button type="button" data-ios-act="ps-audio" aria-label="音频播放">音频播放</button>'
      + '  </div>'
      + '  <div class="ips-list">'
      + '    <div class="ips-item"><span class="ips-name">定时关闭</span>'
      + '      <span class="ips-val" id="ipsSleep">未开启 ›</span></div>'
      + '    <div class="ips-item"><span class="ips-name">循环播放</span>'
      + '      <button type="button" data-ios-act="ps-loop" id="ipsLoop" style="appearance:none;border:0;background:transparent;color:inherit;font-size:12px;font-weight:600"></button></div>'
      + '    <div class="ips-item"><span class="ips-name">跳过片头片尾</span>'
      + '      <button type="button" data-ios-act="ps-skip" id="ipsSkip" style="appearance:none;border:0;background:transparent;color:inherit;font-size:12px;font-weight:600"></button></div>'
      + '    <div class="ips-item"><span class="ips-name">分集标题</span>'
      + '      <button type="button" data-ios-act="ps-eptitle" id="ipsEpTitle" style="appearance:none;border:0;background:transparent;color:inherit;font-size:12px;font-weight:600"></button></div>'
      + '  </div>'
      + '</div>';
    document.body.appendChild(panel);
    return panel;
  }

  function syncPlaySettings() {
    readPlayPrefs();
    var loop = document.getElementById('ipsLoop');
    if (loop) loop.textContent = loopMode === 'one' ? '单集' : (loopMode === 'list' ? '列表' : '关闭');
    var skip = document.getElementById('ipsSkip');
    if (skip) {
      var introEnabled = settingValue('kj-skip-intro') === '1';
      var outroEnabled = settingValue('kj-skip-outro') === '1';
      skip.textContent = introEnabled && outroEnabled ? '开' : (introEnabled ? '仅片头' : (outroEnabled ? '仅片尾' : '关'));
    }
    var epTitle = document.getElementById('ipsEpTitle');
    if (epTitle) epTitle.textContent = epTitleOn ? '开' : '关';
    var sleep = document.getElementById('ipsSleep');
    if (sleep) sleep.textContent = (sleepTimer ? sleepTimer : '未开启') + ' ›';
    var subtitle = document.querySelector ? document.querySelector('[data-ios-act="subtitle"]') : null;
    if (subtitle) subtitle.className = subtitleOn ? 'on' : '';
  }

  function openPlaySettings() {
    var panel = ensurePlaySettings();
    if (!panel) return false;
    panel.className = 'on';
    syncPlaySettings();
    return true;
  }
  function closePlaySettings() {
    var panel = document.getElementById('iosPlaySettings');
    if (panel) panel.className = '';
  }

  /* ---- 统一分发：所有 0.1.17 的节点都带 data-ios-act ---- */
  function actionOf(node) {
    var cursor = node;
    while (cursor) {
      var act = '';
      if (typeof cursor.getAttribute === 'function') {
        try { act = cursor.getAttribute('data-ios-act') || ''; } catch (error) { act = ''; }
      }
      if (act) return String(act);
      cursor = cursor.parentNode;
    }
    return '';
  }

  function handleTencentUI(target, event) {
    var act = actionOf(target);
    if (act === 'back' && immersiveNow() && hit(target, 'iosFsTop')) act = 'fullscreen-back';
    if (target && target.id === 'iosDlListBtn') act = 'open-mine';
    if (!act) return false;
    /* 集数格子：网格是一格一集，点一格立刻下载（§2） */
    if (act === '') return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (act === 'fullscreen-back') { toggleFullscreen(); return true; }
    if (act === 'open-download') { closeMinePage(); openDownloadPage(); return true; }
    if (act === 'back' || act === 'dl-back' || act === 'mine-back') {
      if (document.getElementById('iosMinePage') && !document.getElementById('iosMinePage').hidden) {
        var minePage = document.getElementById('iosMinePage');
        var returnToDownloads = minePage.__iosReturnToDownloads;
        closeMinePage();
        if (returnToDownloads) openDownloadPage();
      } else if (document.getElementById('iosDlPage') && !document.getElementById('iosDlPage').hidden) {
        closeDownloadPage();
      }
      else if (immersiveNow()) toggleFullscreen();
      else if (window.history && window.history.length > 1) window.history.back();
      return true;
    }
    if (act === 'cast') { postNative({ action: 'share', url: mediaUrl(), title: showMeta().title || '' }); return true; }
    if (act === 'share') { postNative({ action: 'share', url: mediaUrl(), title: showMeta().title || '' }); return true; }
    if (act === 'play-settings') { openPlaySettings(); return true; }
    if (act === 'download-episode') { startEpisodeDownload(dlRowKeyOf(target)); return true; }
    if (act === 'ps-download') { var currentNodes = epNodes(); if (currentNodes.length) startEpisodeDownload(epKeyOf(currentNodes[currentEpIndex()])); return true; }
    if (act === 'ps-close') { closePlaySettings(); return true; }
    if (act === 'intro') { announce(showMeta().title ? (showMeta().title + '：暂无更多简介') : '暂无简介'); return true; }
    if (act === 'expand-eps') { var btn = document.getElementById('iosEpMore'); if (btn && typeof btn.click === 'function') btn.click(); announce('已展开全部集数'); return true; }
    if (act === 'lock') { announce('已锁定控制栏'); return true; }
    if (act === 'shot') { announce('截图请用手机侧键'); return true; }
    if (act === 'subtitle') { subtitleOn = !subtitleOn; savePlayPrefs(); syncPlaySettings(); announce(subtitleOn ? '字幕开' : '字幕关'); return true; }
    if (act === 'rate') { var rateBtn = document.getElementById('ppRate'); if (rateBtn && typeof rateBtn.click === 'function') rateBtn.click(); return true; }
    if (act === 'quality') {
      var next = quality() === '720P' ? '1080P' : '720P';
      setQuality(next);
      var q2 = document.getElementById('iosDlQuality');
      if (q2) q2.textContent = next + ' ›';
      announce('下载画质：' + next);
      return true;
    }
    if (act === 'episodes') { openDownloadPage(); return true; }
    if (act === 'next') { var nextBtn = document.getElementById('nextEpBtn'); if (nextBtn && typeof nextBtn.click === 'function') nextBtn.click(); else announce('已经是最后一集'); return true; }
    if (act === 'ps-fill') {
      var modes = FIT_MODES;
      var at = modes.indexOf(fitMode);
      chooseFit(modes[(at + 1) % modes.length]);
      return true;
    }
    if (act === 'ps-pip') { announce('画中画请在系统控制中心开启'); return true; }
    if (act === 'ps-audio') { announce('音频播放：锁屏后仍会继续播放'); return true; }
    if (act === 'ps-loop') {
      loopMode = loopMode === 'off' ? 'one' : (loopMode === 'one' ? 'list' : 'off');
      savePlayPrefs();
      syncPlaySettings();
      announce('循环播放：' + (loopMode === 'one' ? '单集' : (loopMode === 'list' ? '列表' : '关闭')));
      return true;
    }
    if (act === 'ps-skip') {
      var enabled = settingValue('kj-skip-intro') === '1' && settingValue('kj-skip-outro') === '1';
      setSettingValue('kj-skip-intro', enabled ? '0' : '1');
      setSettingValue('kj-skip-outro', enabled ? '0' : '1');
      return true;
    }
    if (act === 'ps-eptitle') { epTitleOn = !epTitleOn; savePlayPrefs(); syncPlaySettings(); var lbl = document.getElementById('playerLabel'); if (lbl) lbl.hidden = !epTitleOn; return true; }
    if (act === 'open-mine') { openMinePage(); return true; }
    if (act === 'mine-download') { closeMinePage(); openDownloadPage(); return true; }
    if (act === 'mine-edit') { announce('左滑任意一集即可删除'); return true; }
    return false;
  }

  /// 0.1.17 的所有节点在每次状态变化后同步一次（队列/片库/全屏/暂停都在调）
  function syncTencentUI() {
    syncDownloadPage();
    var mine = document.getElementById('iosMinePage');
    if (mine && !mine.hidden) renderMinePage();
    var ps = document.getElementById('iosPlaySettings');
    if (ps && ps.className === 'on') syncPlaySettings();
  }

  /// 规格要求移除的入口：弹幕按钮已在 0.1.13 让位给下载，这里再兜一层，
  /// 顺手把会员/广告/VIP 角标收掉（只按文案/类名匹配，不删节点）。
  function hideRemovedEntries() {
    var patterns = [/^VIP$/i, /会员/, /^广告$/, /^\d+s?广告$/, /^预告$/, /^弹幕/];
    var nodes = document.querySelectorAll ? document.querySelectorAll('span,div,i,em,button,a') : [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node || !node.textContent) continue;
      if (node.id && node.id.indexOf('pp') === 0) continue;
      if (typeof node.closest === 'function' && node.closest('#ppCtrl,#iosTopBar,#iosFsTop,#iosSettingsSheet,.ios-page')) continue;
      var text = String(node.textContent).replace(/\s+/g, '');
      if (text.length > 8) continue;
      for (var p = 0; p < patterns.length; p++) {
        if (patterns[p].test(text)) {
          node.hidden = true;
          if (node.style) node.style.display = 'none';
          break;
        }
      }
    }
    var danmaku = document.getElementById('dmBtn');
    if (danmaku) {
      danmaku.hidden = true;
      if (danmaku.style) danmaku.style.display = 'none';
    }
  }

  function mountTencentUI() {
    readPlayPrefs();
    applyDanmakuPreference();
    var theme = readStore('kj-theme');
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    mountPlayerChrome();
    ensureDownloadPage();
    ensureMinePage();
    ensurePlaySettings();
    hideRemovedEntries();
    syncTencentUI();
    return true;
  }

  /* 旧的调用点仍然叫 mountFitBar（挂载 / 重试两处），这里只是个别名。 */
  function mountFitBar() {
    return mountFsTop();
  }

  function handleCtrlClick(event) {
    var target = event.target;
    if (!target) return false;
    if (hit(target, 'iosFsFitBtn')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      var fitMenu = document.getElementById('iosFsMenu');
      if (fitMenu) fitMenu.className = fitMenu.className === 'on' ? '' : 'on';
      return true;
    }
    if (hit(target, 'iosFsMenu')) {
      var fitOption = target;
      while (fitOption) {
        var fitModeOption = fitOption.getAttribute ? fitOption.getAttribute('data-fit') : '';
        if (fitModeOption) {
          event.preventDefault();
          event.stopImmediatePropagation();
          chooseFit(String(fitModeOption));
          var openFitMenu = document.getElementById('iosFsMenu');
          if (openFitMenu) openFitMenu.className = '';
          return true;
        }
        fitOption = fitOption.parentNode;
      }
    }
    if (handleTencentUI(target, event)) return true;
    /* 选集页「选择」模式：点选集卡片是选中/取消，不再跳集 */
    if (hit(target, 'iosTitleDownload')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openDownloadPage();
      return true;
    }
    if (target && target.getAttribute && String(target.getAttribute('data-dl-delete') || '') === '1') {
      event.preventDefault();
      event.stopImmediatePropagation();
      deleteRowAt(target);
      return true;
    }
    if (dlRowKeyOf(target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      startEpisodeDownload(dlRowKeyOf(target));
      return true;
    }
    if (hit(target, 'iosSettingsSheet') && !hit(target, 'iosSettingsCard')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeSettingsSheet();
      return true;
    }
    if (hit(target, 'iosSettingsClose')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeSettingsSheet();
      return true;
    }
    if (hit(target, 'iosExtToggle')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setExtPlayerDefault(!extPlayerDefault());
      return true;
    }
    if (hit(target, 'ppPlayExternal')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      playExternal();
      return true;
    }
    if (hit(target, 'ppPlay')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      togglePlay();
      return true;
    }
    if (hit(target, 'ppFull')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleFullscreen();
      return true;
    }
    if (hit(target, 'ppCast')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      /* 默认就把这一集交给第三方播放器：用户要的是「点一下就换播放器」，
         不是每次都先进菜单；长按「外放」或关掉这个默认值就回到菜单。 */
      if (extPlayerDefault() && mediaUrl()) {
        /* 长按刚把菜单打开，这一次点击不应该又把它交接出去 */
        if (castLongPress) { castLongPress = false; return true; }
        playExternal();
        return true;
      }
      if (!toggleCastMenu()) shareLink();
      return true;
    }
    if (hit(target, 'ppShareLink')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      shareLink();
      return true;
    }
    if (hit(target, 'ppCopyLink')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      copyLink();
      return true;
    }
    if (hit(target, 'ppRate')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleRateMenu();
      return true;
    }
    if (hit(target, 'ppRateMenu') && target.dataset && target.dataset.rate) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setRate(target.dataset.rate);
      return true;
    }
    /* 全屏里点一下画面 = 拿出控制栏；再点一下收起。
       点在控制栏（包括倍速/外放菜单）上不算“点画面”：
       这里只把自动收起的计时重新排上。 */
    if (immersiveNow()) {
      if (hit(target, 'ppCtrl')) { hideCtrlSoon(); return false; }
      if (ctrlHidden) showCtrl(true);
      else setCtrlHidden(true);
      syncCtrl();
    }
    return false;
  }

  ['timeupdate', 'durationchange', 'loadedmetadata', 'seeked', 'play', 'pause', 'ended', 'ratechange'].forEach(function (name) {
    document.addEventListener(name, function (event) {
      if (!event.target || event.target.id !== 'video') return;
      syncCtrl();
      /* 全屏里播放时把控制栏收起来，暂停时再拿出来：用户不碰屏幕就只剩画面。 */
      if (name === 'pause') showCtrl(false);
      else if (name === 'play') hideCtrlSoon();
      /* 画面档位那排只在「全屏 + 暂停」出现（规格 §1）；换集/首帧后重新按新宽高算几何 */
      applyFitGeometry();
      syncFitBar();
    }, true);
  });
  document.addEventListener('input', function (event) {
    if (!event.target || event.target.id !== 'ppSeek') return;
    seekTo(Number(event.target.value) / 1000);
  }, true);
  ['loadedmetadata', 'play', 'durationchange'].forEach(function (name) {
    document.addEventListener(name, function (event) {
      if (!event.target || event.target.id !== 'video') return;
      rememberMedia();
    }, true);
  });

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
    /* 新的一次播放就是新的会话：把「退出全屏后留在页内」的标记清掉，
       否则横屏播放时标题栏/工具条再也不会自动收起。 */
    explicitInline = false;
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
  /* 站点自己的「全屏」优先走标准全屏 API：这条路不经过「原生全屏」事件，
     必须跟着 fullscreenchange 同步沉浸态，才能把片名标题和工具条收起来。 */
  document.addEventListener('fullscreenchange', function () {
    applyImmersive();
  }, true);
  document.addEventListener('webkitfullscreenchange', function () {
    applyImmersive();
  }, true);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && userFullscreen) setUserFullscreen(false);
  }, true);
  function onWindow(name, handler) {
    if (window && typeof window.addEventListener === 'function') window.addEventListener(name, handler);
  }
  onWindow('resize', function () {
    applyImmersive();
    refitSoon();
  });
  onWindow('orientationchange', function () {
    if (!landscape()) explicitInline = false;
    applyImmersive();
    refitSoon();
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
  /* 记住日期条该停在哪：用户没动过就停今天，动过就保留用户的位置。
     站点后台刷新重建 #days 会把 scrollLeft 重置成 0 —— 不补回去就是真机上
     「日期条自己漂走」；每次都重算又会反复强制布局，所以只在真的偏了才写。 */
  var stripMemory = { left: 0 };

  function clampScroll(value, max) {
    return Math.min(max, Math.max(0, value));
  }

  /* 今天那张卡的偏移量与当前 scrollLeft 无关，所以重复算出来的目标值一致（幂等） */
  function todayOffset(days, active) {
    var stripRect = days.getBoundingClientRect();
    var activeRect = active.getBoundingClientRect();
    /* 日期条是 scroll-snap 容器（每张卡一个 snap 点），居中会被吸附回卡片边界，
       所以把今天对齐到可视区起点，结果稳定 */
    return days.scrollLeft + (activeRect.left - stripRect.left);
  }

  function centerTodayStrip() {
    var days = document.getElementById('days');
    if (!days || typeof days.querySelector !== 'function') return false;
    var active = days.querySelector('.day.on');
    if (!active) return false;
    var max = Math.max(0, days.scrollWidth - days.clientWidth);
    if (max <= 0) return true;
    var target = clampScroll(stripTouched ? stripMemory.left : todayOffset(days, active), max);
    if (Math.abs(days.scrollLeft - target) > 4) days.scrollLeft = target;
    stripMemory.left = days.scrollLeft;
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
    /* 观察器一开始就挂上：站点先渲染骨架、再按接口数据填充时，
       只靠几次定时器会错过真正那次渲染。childList 变化不会因为我们写 scrollLeft 再触发，
       所以不会自激。 */
    watchStrip();
    var delays = [0, 250, 700, 1500, 3000];
    for (var i = 0; i < delays.length; i++) {
      (function (delay) {
        setTimeout(function () {
          centerTodayStrip();
          watchStrip();
        }, delay);
      }(delays[i]));
    }
  }

  /* 只有用户真的拨过，才把他的位置记下来。
     记录的时机要延后一拍：站点后台刷新重建 #days 时浏览器会把 scrollLeft 归零，
     这个 0 也会派发 scroll 事件 —— 立刻记下去就等于把用户的位置抹掉了。
     延迟一拍后，观察器里的恢复已经把位置写回来了，最终记下的是用户看的那一天。 */
  document.addEventListener('scroll', function (event) {
    if (!event.target || event.target.id !== 'days' || !stripTouched) return;
    stripMemory.left = event.target.scrollLeft;
  }, true);
  document.addEventListener('touchstart', markStripTouched, true);
  document.addEventListener('pointerdown', markStripTouched, true);
  scheduleStripCentering();
  onWindow('popstate', scheduleStripCentering);

  /* ---------- 选集区横滑切页（投屏/讨论/反馈） ----------
     这些标签页现在只能点，真机上横滑多次没反应。横滑手势明显压过纵向时切换相邻页。 */
  var tabSwipe = null;

  function tabRow() {
    return document.querySelector ? document.querySelector('.pp-tabs') : null;
  }

  document.addEventListener('touchstart', function (event) {
    var row = tabRow();
    if (!row || !event.touches || event.touches.length !== 1) return;
    var target = event.target;
    if (target !== row && !(row.contains && row.contains(target))) return;
    tabSwipe = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }, true);

  document.addEventListener('touchend', function (event) {
    if (!tabSwipe || !event.changedTouches || !event.changedTouches.length) return;
    var start = tabSwipe;
    tabSwipe = null;
    var touch = event.changedTouches[0];
    var dx = touch.clientX - start.x;
    var dy = touch.clientY - start.y;
    if (Math.abs(dx) < 44 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
    var row = tabRow();
    if (!row) return;
    var tabs = row.querySelectorAll ? row.querySelectorAll('.pp-tab') : [];
    if (!tabs || !tabs.length) return;
    var current = 0;
    for (var i = 0; i < tabs.length; i++) {
      if (String(tabs[i].className).indexOf('pp-tab on') >= 0) current = i;
    }
    var next = Math.min(tabs.length - 1, Math.max(0, current + (dx < 0 ? 1 : -1)));
    if (next === current) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    /* 站点层也在监听同一个手势：标记住，避免一次滑动跳两页 */
    try { event.__zhuijuSwipeHandled = true; } catch (error) { /* 只读事件对象 */ }
    if (typeof tabs[next].click === 'function') tabs[next].click();
  }, true);
  document.addEventListener('touchcancel', function () {
    tabSwipe = null;
  }, true);

  /* ---------- 账号状态：同一屏不能同时出现「已登录 kenzhao11」和「游客账号」 ----------
     站点的侧栏里「成长」卡片写死成游客账号，登录后 sb-name 换了用户名，下面还是「游客账号」。
     这里把两处统一成同一来源；站点层模板同步修（src/shell.js）。 */
  function cachedUser() {
    try {
      var raw = localStorage.getItem('kj-auth-user');
      var user = raw ? JSON.parse(raw) : null;
      return user && user.username ? user : null;
    } catch (error) { return null; }
  }

  function syncAccountLabels() {
    var user = cachedUser();
    var name = user ? user.username : '游客账号';
    var pairs = [
      ['.sb-name', name],
      ['.acct-name', name],
      ['.sb-sub', user ? '已登录 · 观看记录跨设备同步' : '本设备使用中 · 游客账号']
    ];
    for (var p = 0; p < pairs.length; p++) {
      var nodes = document.querySelectorAll ? document.querySelectorAll(pairs[p][0]) : [];
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].textContent !== pairs[p][1]) nodes[i].textContent = pairs[p][1];
      }
    }
    var episodeCast = document.querySelectorAll ? document.querySelectorAll('.ep-head [data-action="cast"]') : [];
    for (var c = 0; c < episodeCast.length; c++) {
      episodeCast[c].hidden = true;
      if (episodeCast[c].setAttribute) episodeCast[c].setAttribute('aria-hidden', 'true');
    }
  }

  function scheduleAccountSync() {
    syncAccountLabels();
    setTimeout(syncAccountLabels, 600);
    setTimeout(syncAccountLabels, 1800);
  }

  document.addEventListener('kj-auth-changed', scheduleAccountSync);
  document.addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target.closest('[data-action="login"],[data-action="logout"]') : null;
    if (target) scheduleAccountSync();
  }, true);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleAccountSync, { once: true });
  } else {
    scheduleAccountSync();
  }

  /* 长按「外放」：临时打开菜单（复制/下载/分享）；默认值是第三方播放器时
     单点会直接交接，菜单只能靠这一下拿到。 */
  var castPress = null;
  var castLongPress = false;
  document.addEventListener('touchstart', function (event) {
    if (!event.target) return;
    var cast = hit(event.target, 'ppCast');
    if (!cast || !extPlayerDefault() || !mediaUrl()) return;
    castPress = setTimeout(function () {
      castPress = null;
      castLongPress = true;
      toggleCastMenu();
    }, 650);
  }, true);
  ['touchend', 'touchcancel', 'touchmove'].forEach(function (name) {
    document.addEventListener(name, function () {
      if (!castPress) return;
      clearTimeout(castPress);
      castPress = null;
    }, true);
  });

  /* 恢复旧版单集回调元数据，避免迟到的原生完成事件丢失剧名和集号。 */
  restoreDownload();
  restoreQueue();
  /* 问一次原生：后台下载可能在我们不知情时跑完了 */
  setTimeout(function () { postNative({ action: 'downloadSync' }); }, 800);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', prepareLayout, { once: true });
  } else {
    prepareLayout();
  }
  /* 站点是 SPA：换集或重渲染可能整块换掉 #player，几次补挂 */
  [0, 400, 1200, 2600].forEach(function (delay) {
    setTimeout(function () { mountCtrlBar(); mountFitBar(); mountTencentUI(); }, delay);
  });
  /* 首页/播放页的站点渲染是异步的：面板和状态晚一步再补一次 */
  [0, 600, 1600].forEach(function (delay) {
    setTimeout(function () {
      mountFitBar();
      mountTencentUI();
      syncExtToggle();
      syncDownloadRow();
    }, delay);
  });
}());
