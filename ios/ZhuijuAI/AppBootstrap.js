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
    /* 站点的设置按钮只会弹「设置面板即将上线」：换成注入层的设置面板，
       下载进度和播放方式在首页也看得到。 */
    if (settingsTriggerHit(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openSettingsSheet();
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
      'html[data-ios-immersive] #player{position:fixed!important;inset:0!important;width:100%!important;height:100%!important;z-index:10000!important;border-radius:0!important;margin:0!important;background:#000!important;display:flex!important;align-items:center!important;justify-content:center!important}',
      'html[data-ios-immersive] #player video{width:100%!important;height:100%!important;aspect-ratio:auto!important;object-fit:contain!important;background:#000}',
      /* 画面档位：三条写在沉浸态那条之后，同样的优先级下由它们覆盖 contain。
         适应=完整画面（可留边），裁剪=等比铺满（裁边），拉伸=不等比铺满。 */
      'html[data-ios-fit="contain"] #player video{object-fit:contain!important}',
      'html[data-ios-fit="cover"] #player video{object-fit:cover!important}',
      'html[data-ios-fit="fill"] #player video{object-fit:fill!important}',
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
      'html[data-ios-immersive] .main{position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;width:100%!important;height:100%!important;margin:0!important;padding:0!important;overflow:hidden!important;-webkit-overflow-scrolling:auto!important;transform:none!important;z-index:9998!important}',
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
      '#ppCtrl #ppFit{background:rgba(255,255,255,.16)}',
      '#iosDownloadStatus{margin:12px 0;padding:12px;border:1px solid rgba(255,255,255,.14);border-radius:10px;background:rgba(0,0,0,.12);color:inherit;font-size:13px}',
      /* 首页没有站点面板（只有一句「设置面板即将上线」），注入层自带一个：
         下载进度和播放方式都在里面，任何页面都能打开。 */
      '#iosSettingsSheet{position:fixed;left:0;right:0;top:0;bottom:0;z-index:12000;display:flex;align-items:flex-end;background:rgba(4,8,11,.62)}',
      '#iosSettingsSheet[hidden]{display:none!important}',
      '#iosSettingsCard{width:100%;max-height:76vh;overflow:auto;padding:16px 16px calc(20px + env(safe-area-inset-bottom,0px));background:#0c1216;color:#f4f7f8;border-radius:16px 16px 0 0;font-size:13px;line-height:1.4}',
      '#iosSettingsHead{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:15px;font-weight:700;margin-bottom:10px}',
      '#iosSettingsClose{border:0;background:rgba(255,255,255,.14);color:#fff;border-radius:9px;padding:10px 14px;font-size:13px;min-height:40px}',
      '#iosExtToggle{display:block;width:100%;margin:12px 0 0;padding:13px 14px;border:0;border-radius:10px;background:#16e09d;color:#04241a;font-weight:700;font-size:13px;text-align:left;min-height:44px}',
      '#iosDownloadTrack{height:6px;margin-top:9px;overflow:hidden;border-radius:4px;background:rgba(127,127,127,.3)}',
      '#iosDownloadFill{width:0;height:100%;border-radius:inherit;background:#16e09d;transition:width .15s linear}',
      '#iosOpenDownloaded{margin-top:10px;padding:8px 12px;border-radius:8px;background:#16e09d;color:#04241a;font-weight:700}',
      '#iosOpenDownloaded[hidden]{display:none!important}',
      /* 设置里的下载：按剧列出封面/片名/下了哪几集，再跟正在下载的进度 */
      '#iosDownloadLibrary{margin:2px 0 12px}',
      '#iosDownloadLibrary[hidden]{display:none!important}',
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
      /* 整部剧的队列进度 + 暂停/继续/取消：按钮在设置面板的下载列表里 */
      '.ios-dl-queue{margin-top:6px;font-size:12px;color:#b8f5dd;line-height:1.4}',
      '.ios-dl-actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}',
      '.ios-dl-actions button{border:0;border-radius:8px;padding:9px 12px;font-size:12px;font-weight:700;background:rgba(255,255,255,.14);color:#f4f7f8;min-height:38px}',
      '.ios-dl-actions button[data-batch-action="cancel"]{background:rgba(255,86,86,.22);color:#ffd9d9}',
      /* 选集页的批量下载条：选择 / 一键全集 / 从本集往后 / 下载已选 */
      '#iosBatchBar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0;padding:8px;border-radius:10px;background:rgba(255,255,255,.06)}',
      '#iosBatchBar button{border:0;border-radius:8px;padding:9px 11px;font-size:12px;font-weight:700;background:rgba(255,255,255,.14);color:#f4f7f8;min-height:38px}',
      '#iosBatchBar button#iosBatchStart{background:#16e09d;color:#04241a}',
      '#iosBatchBar span{font-size:12px;color:rgba(244,247,248,.76)}',
      '#epGrid .ep.ios-pick{outline:2px solid #16e09d!important;outline-offset:-2px}',
      'html[data-theme=\'light\'] #iosBatchBar{background:rgba(15,20,24,.06)}',
      'html[data-theme=\'light\'] #iosBatchBar button{background:rgba(15,20,24,.1);color:#141a1e}',
      'html[data-theme=\'light\'] #iosBatchBar span{color:rgba(15,20,24,.66)}',
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
      '.dm-layer{contain:layout paint;transform:translateZ(0)}',
      '.dm-item{left:0!important;animation:dm-fly-x var(--dur,9s) linear forwards!important;will-change:transform!important}',
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
    mountDownloadPanel();
    mountBatchBar();
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
    applyFit();
  }

  /* ---------- 画面模式：适应 / 裁剪 / 拉伸 ----------
     4:3 或 2.35:1 的片源在「适应」下会留黑边，用户可能想铺满。三档写到
     html[data-ios-fit] 上，由样式表落到真正的 #player video；选择落 localStorage，
     换集/旋转/重进 App 都按记住的那一档来，不重置回默认值。 */
  var FIT_PREF = 'kj-ios-fit';
  var FIT_MODES = ['contain', 'cover', 'fill'];
  var FIT_LABELS = { contain: '适应', cover: '裁剪', fill: '拉伸' };
  var fitMode = 'contain';

  function readFitPref() {
    var stored = '';
    try { stored = String(localStorage.getItem(FIT_PREF) || ''); } catch (error) { stored = ''; }
    return FIT_MODES.indexOf(stored) >= 0 ? stored : 'contain';
  }

  function applyFit() {
    fitMode = readFitPref();
    var root = document.documentElement;
    if (root && typeof root.setAttribute === 'function') root.setAttribute('data-ios-fit', fitMode);
    var button = document.getElementById('ppFit');
    if (!button) return;
    var label = FIT_LABELS[fitMode] || '适应';
    button.textContent = label;
    if (typeof button.setAttribute === 'function') {
      button.setAttribute('aria-label', '画面比例：' + label + '，点击切换');
    }
  }

  function cycleFit() {
    var next = FIT_MODES[(FIT_MODES.indexOf(fitMode) + 1) % FIT_MODES.length];
    try { localStorage.setItem(FIT_PREF, next); } catch (error) { /* 存不了就只在本次生效 */ }
    applyFit();
    announce('画面：' + (FIT_LABELS[fitMode] || '适应'));
    return fitMode;
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

  /* ---------- 播放控制栏：进度 / 倍速 / 外放 / 全屏 ---------- */
  /* iOS 原生控件改不了位置：全屏键固定在左上角，倍速菜单也只到 2×。
     所以应用内自带一条控制栏：播放 · 时间 · 进度条 · 外放 · 倍速 · 全屏，
     全屏正好落在进度条右端，和倍速挨着。 */
  var ctrlMounted = false;
  var downloadPanelMounted = false;
  var downloadBox = null;
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
      error: saved.state === 'failed' ? (saved.error || '下载中断') : '',
    };
    if (saved.meta && typeof saved.meta === 'object' && saved.meta.title) pendingMeta = saved.meta;
  }

  /* ---------- 已下载的片库：设置里按剧列出「下了哪几集 / 共几集」 ----------
     原生下载一次只跑一集，网页侧拿不到文件夹列表；所以每次下载完成就把
     「剧名 / 封面 / 这一集」记到 localStorage。分组用站点自己的媒体 id
     （播放页地址的 ?id=），拿不到 id 时退回剧名，同一部剧不会碎成两条。 */
  var LIBRARY_STORE = 'kj-ios-downloads';
  var libraryBox = null;

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

  function downloadLibraryElement() {
    if (libraryBox) return libraryBox;
    var box = document.createElement('div');
    box.id = 'iosDownloadLibrary';
    box.className = 'ios-dl-lib';
    var heading = document.createElement('div');
    heading.className = 'ios-dl-heading';
    heading.textContent = '下载';
    box.appendChild(heading);
    var running = document.createElement('div');
    running.id = 'iosDlRunning';
    running.className = 'ios-dl-running';
    running.hidden = true;
    if (typeof running.setAttribute === 'function') running.setAttribute('hidden', '');
    box.appendChild(running);
    var list = document.createElement('div');
    list.id = 'iosDlShows';
    list.className = 'ios-dl-shows';
    box.appendChild(list);
    libraryBox = box;
    return box;
  }

  function librarySig(shows) {
    var parts = [downloadState.busy ? 'run' : 'idle', String(downloadState.percent || 0), downloadState.show || '', downloadState.ep || '', downloadState.name || ''];
    for (var i = 0; i < shows.length; i++) {
      parts.push(shows[i].id + '|' + shows[i].title + '|' + shows[i].cover + '|' + shows[i].total + '|' + shows[i].eps.length);
    }
    /* 队列状态变化也要重渲染：暂停/排队/失败都要马上看到 */
    for (var q = 0; q < queueTasks.length; q++) {
      parts.push('q:' + queueTasks[q].id + ':' + queueTasks[q].status + ':' + queueTasks[q].received + ':' + queueTasks[q].total);
    }
    return parts.join(';');
  }

  /* 已下载片库 + 正在下载的那一集：设置面板打开时就能看清「下了哪些、下到哪」。 */
  function renderDownloadLibrary() {
    var root = downloadRoot();
    if (!root || typeof root.appendChild !== 'function') return false;
    var box = downloadLibraryElement();
    if (box.parentNode !== root) root.appendChild(box);

    var running = document.getElementById('iosDlRunning');
    if (running) {
      var busy = !!downloadState.busy;
      running.hidden = !busy;
      if (typeof running.removeAttribute === 'function' && busy) running.removeAttribute('hidden');
      else if (typeof running.setAttribute === 'function') running.setAttribute('hidden', '');
      if (busy) {
        var who = downloadState.show || '';
        var which = downloadState.ep || downloadState.name || '本集';
        running.textContent = '正在下载 ' + (who ? who + ' · ' : '') + which + ' · '
          + (downloadState.percent ? downloadState.percent + '%' : '准备中');
      }
    }

    var list = document.getElementById('iosDlShows');
    if (!list) return false;
    var shows = readLibrary().shows;
    /* 排队中的剧也要出现在这里：还没下完一集时，也要能暂停/继续/取消整部剧 */
    var batches = readBatchShows();
    for (var b = 0; b < batches.length; b++) {
      var batch = batches[b];
      if (!batch || !batch.id) continue;
      if (!queueSummary(batch.id).total) continue;
      var known = false;
      for (var k = 0; k < shows.length; k++) if (String(shows[k].id) === String(batch.id)) known = true;
      if (known) continue;
      shows.push({ id: String(batch.id), title: String(batch.title || ''), cover: String(batch.cover || ''), total: Number(batch.total) || 0, eps: [] });
    }
    /* 只在队列里（还没下完一集）的剧也要列出来，否则用户看不到进度也暂停不了 */
    for (var t = 0; t < queueTasks.length; t++) {
      var task = queueTasks[t];
      var taskShow = String(task.showId || '');
      if (!taskShow) continue;
      var listed = false;
      for (var s3 = 0; s3 < shows.length; s3++) if (String(shows[s3].id) === taskShow) listed = true;
      if (listed) continue;
      shows.push({ id: taskShow, title: String(task.title || ''), cover: '', total: 0, eps: [] });
    }
    /* 没下过东西也没在下载：不挂一个空的「下载」标题在那儿 */
    box.hidden = !shows.length && !downloadState.busy;
    if (typeof box.setAttribute === 'function') {
      if (box.hidden) box.setAttribute('hidden', '');
      else box.removeAttribute('hidden');
    }
    var signature = librarySig(shows);
    if (list.__iosLibrarySig === signature) return true;
    list.__iosLibrarySig = signature;
    if (typeof list.removeChild === 'function') {
      while (list.firstChild) list.removeChild(list.firstChild);
    } else if (list.children) {
      list.children.length = 0;
    }
    for (var s = 0; s < shows.length; s++) {
      list.appendChild(libraryItem(shows[s]));
    }
    return true;
  }

  function libraryItem(show) {
    var item = document.createElement('div');
    item.className = 'ios-dl-show';
    if (typeof item.setAttribute === 'function') item.setAttribute('data-show', show.id);
    if (show.cover) {
      var cover = document.createElement('img');
      cover.className = 'ios-dl-cover';
      cover.src = show.cover;
      cover.alt = show.title;
      item.appendChild(cover);
    }
    var meta = document.createElement('div');
    meta.className = 'ios-dl-meta';
    var name = document.createElement('div');
    name.className = 'ios-dl-name';
    name.textContent = show.title;
    meta.appendChild(name);
    var count = document.createElement('div');
    count.className = 'ios-dl-count';
    /* 总集数不知道就不写分母：宁可少写，也不编一个错的。 */
    count.textContent = '已下载 ' + show.eps.length + (show.total > 0 ? '/' + show.total : '') + ' 集';
    meta.appendChild(count);
    var eps = document.createElement('div');
    eps.className = 'ios-dl-eps';
    for (var e = 0; e < show.eps.length; e++) {
      var chip = document.createElement('span');
      chip.className = 'ios-dl-ep';
      chip.textContent = show.eps[e].label || ('第' + show.eps[e].key + '集');
      eps.appendChild(chip);
    }
    meta.appendChild(eps);
    /* 整部剧的队列进度 + 暂停 / 继续 / 取消（取消只停任务，不删已下载文件） */
    var summary = queueSummary(show.id);
    if (summary.total) {
      var queue = document.createElement('div');
      queue.className = 'ios-dl-queue';
      queue.textContent = queueText(summary);
      meta.appendChild(queue);
      var actions = document.createElement('div');
      actions.className = 'ios-dl-actions';
      if (summary.running + summary.queued > 0) actions.appendChild(queueActionButton(show.id, 'pause', '暂停整部剧'));
      if (summary.paused > 0) actions.appendChild(queueActionButton(show.id, 'resume', '继续下载'));
      if (summary.busy) actions.appendChild(queueActionButton(show.id, 'cancel', '取消整部剧'));
      if (actions.children.length) meta.appendChild(actions);
    }
    item.appendChild(meta);
    return item;
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
    close.textContent = '关闭';
    head.appendChild(close);
    card.appendChild(head);
    var content = document.createElement('div');
    content.id = 'iosSettingsBody';
    card.appendChild(content);
    var toggle = document.createElement('button');
    toggle.id = 'iosExtToggle';
    toggle.type = 'button';
    card.appendChild(toggle);
    sheet.appendChild(card);
    document.body.appendChild(sheet);
    settingsSheet = sheet;
    syncExtToggle();
    return sheet;
  }

  function openSettingsSheet() {
    var sheet = ensureSettingsSheet();
    if (!sheet) return false;
    sheet.hidden = false;
    if (typeof sheet.removeAttribute === 'function') sheet.removeAttribute('hidden');
    sheet.className = 'ios-settings-sheet on';
    /* 面板打开后再搬进度块：它要出现在用户眼前这一块里，
       而不是留在被面板盖住的播放器设置里。 */
    mountDownloadPanel();
    syncDownloadRow();
    return true;
  }

  function closeSettingsSheet() {
    if (!settingsSheet) return;
    settingsSheet.hidden = true;
    if (typeof settingsSheet.setAttribute === 'function') settingsSheet.setAttribute('hidden', '');
    settingsSheet.className = 'ios-settings-sheet';
    /* 面板收起后进度块回到能看见的地方（播放器设置面板，没有就留在面板里） */
    mountDownloadPanel();
  }

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

  function downloadBoxElement() {
    if (downloadBox) return downloadBox;
    var box = document.createElement('div');
    box.id = 'iosDownloadStatus';
    box.className = 'ios-download-status';
    box.setAttribute('aria-live', 'polite');
    var label = document.createElement('div');
    label.id = 'iosDownloadLabel';
    label.textContent = '下载进度：尚未下载';
    box.appendChild(label);
    var track = document.createElement('div');
    track.id = 'iosDownloadTrack';
    var fill = document.createElement('div');
    fill.id = 'iosDownloadFill';
    track.appendChild(fill);
    box.appendChild(track);
    var open = document.createElement('button');
    open.id = 'iosOpenDownloaded';
    open.type = 'button';
    open.textContent = '用其他播放器播放';
    open.hidden = true;
    if (typeof open.setAttribute === 'function') open.setAttribute('hidden', '');
    box.appendChild(open);
    downloadBox = box;
    return box;
  }

  /* 进度块只有一个，跟着用户看的那一面走：
     设置面板开着就放进面板，否则放回播放器页的「显示设置」。
     这样不会出现两份状态对不上，也不需要在页面里用重复 id。 */
  function downloadRoot() {
    if (settingsSheet && settingsSheet.hidden === false) {
      var body = document.getElementById('iosSettingsBody');
      if (body) return body;
    }
    return document.getElementById('settingsPanel') || document.getElementById('iosSettingsBody');
  }

  /* 播放器页塞进站点自己的「显示设置」面板；首页没有那个面板，塞进注入层的设置面板。 */
  function mountDownloadPanel() {
    var container = downloadRoot();
    if (!container || typeof container.appendChild !== 'function') return false;
    /* 先片库（下了哪些剧、哪几集），再正在下载的进度条：从上往下读就是用户想问的顺序。 */
    var lib = downloadLibraryElement();
    if (lib.parentNode !== container) container.appendChild(lib);
    var box = downloadBoxElement();
    if (box.parentNode !== container) container.appendChild(box);
    downloadPanelMounted = true;
    renderDownloadLibrary();
    return true;
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
    /* 工具条上的「下载」不依赖播放器，先补上再说 */
    mountToolDownload();
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
    barButton('ppFit', '适应', '画面比例：适应，点击切换');
    barButton('ppFull', '全屏', '全屏播放');

    /* 外放菜单：分享直链 / 复制直链 / 下载（登录后）/ 用其他播放器打开（下载后） */
    var castMenu = document.createElement('div');
    castMenu.id = 'ppCastMenu';
    castMenu.className = 'pc-cast-menu';
    /* 第三方播放器排在第一行：这是用户默认想走的那条路（不需要先下载）。 */
    castMenu.appendChild(castRow('ppPlayExternal', '用第三方播放器播放', '当前线路'));
    castMenu.appendChild(castRow('ppShareLink', '分享播放地址', '系统面板'));
    castMenu.appendChild(castRow('ppCopyLink', '复制播放地址', '手动粘贴'));
    castMenu.appendChild(castRow('ppDownload', '下载本集', '需登录'));
    var progressRow = castRow('ppDownloadProgress', '下载进度', '尚未下载');
    progressRow.setAttribute('aria-live', 'polite');
    castMenu.appendChild(progressRow);
    var localRow = castRow('ppOpenLocal', '用其他播放器播放', '已下载');
    if (typeof localRow.setAttribute === 'function') localRow.setAttribute('hidden', '1');
    localRow.hidden = true;
    castMenu.appendChild(localRow);
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
    var wanted = Number(value) || 1;
    if (video) {
      try { video.playbackRate = wanted; } catch (error) { /* 这条线路不可调速 */ }
    }
    /* 系统可能把倍速夹回去（比如只允许到 2×）：读回真实值再显示，不许谎报 */
    var real = effectiveRate();
    try { localStorage.setItem('kj-speed', String(real)); } catch (error) { /* 隐私模式 */ }
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

  function noteOf(id, text) {
    var row = document.getElementById(id);
    if (!row) return;
    var note = row.querySelector ? row.querySelector('.pc-menu-note') : null;
    if (note) note.textContent = text;
    else row.textContent = text;
  }

  function downloadNote() {
    if (downloadState.busy) return downloadState.percent ? downloadState.percent + '%' : '准备中';
    if (downloadState.path) return '已下载';
    if (!signedIn()) return '需登录';
    var state = mediaState();
    if (!state.url) return state.reason === 'opaque' ? '线路不可下载' : '还没拿到直链';
    if (/\.m3u8(?:[?#]|$)/i.test(state.url)) return '分片线路不可下载';
    return '开始下载';
  }

  function syncDownloadRow() {
    mountDownloadPanel();
    var row = document.getElementById('ppDownload');
    if (row) row.className = 'pc-menu-row' + (downloadState.busy ? ' busy' : '');
    var open = document.getElementById('ppOpenLocal');
    if (open) {
      var has = !!downloadState.path;
      if (typeof open.removeAttribute === 'function' && has) open.removeAttribute('hidden');
      else if (typeof open.setAttribute === 'function') open.setAttribute('hidden', '');
      open.hidden = !has;
    }
    var cast = document.getElementById('ppCast');
    if (cast) {
      cast.textContent = downloadState.busy
        ? '下载 ' + (downloadState.percent ? downloadState.percent + '%' : '0%')
        : '外放';
    }
    noteOf('ppDownload', downloadNote());
    noteOf('ppDownloadProgress', downloadProgressNote());
    var downloadLabel = document.getElementById('iosDownloadLabel');
    var downloadFill = document.getElementById('iosDownloadFill');
    var downloadOpen = document.getElementById('iosOpenDownloaded');
    if (downloadLabel) downloadLabel.textContent = '下载进度：' + downloadProgressNote();
    if (downloadFill) downloadFill.style.width = (downloadState.busy ? downloadState.percent : (downloadState.path ? 100 : 0)) + '%';
    if (downloadOpen) {
      downloadOpen.hidden = !downloadState.path;
      if (typeof downloadOpen.removeAttribute === 'function' && downloadState.path) downloadOpen.removeAttribute('hidden');
      else if (typeof downloadOpen.setAttribute === 'function') downloadOpen.setAttribute('hidden', '');
    }
    syncToolDownload();
    renderDownloadLibrary();
    saveDownload();
  }

  /* 播放器下方那排工具里，「弹幕」按钮给换成「下载」：
     下载入口原来藏在「外放」里（而外放默认又交给了第三方播放器），真机上根本找不到。 */
  var toolDownloadMounted = false;

  function mountToolDownload() {
    var tools = document.getElementById('playTools');
    if (!tools) return false;
    var dm = document.getElementById('dmBtn');
    if (dm) {
      /* 弹幕按钮让位：宝免占着那行的位置，但不能删除站点节点 */
      dm.hidden = true;
      if (dm.style) dm.style.display = 'none';
    }
    if (document.getElementById('ppToolDownload')) {
      toolDownloadMounted = true;
      syncToolDownload();
      return true;
    }
    if (typeof tools.appendChild !== 'function') return false;
    var button = document.createElement('button');
    button.id = 'ppToolDownload';
    button.type = 'button';
    button.className = 'pp-tool';
    button.textContent = '下载本集';
    if (dm && dm.parentNode === tools && typeof tools.insertBefore === 'function') tools.insertBefore(button, dm);
    else tools.appendChild(button);
    toolDownloadMounted = true;
    syncToolDownload();
    return true;
  }

  function syncToolDownload() {
    var button = document.getElementById('ppToolDownload');
    if (!button) return;
    if (downloadState.busy) {
      button.textContent = '下载 ' + (downloadState.percent ? downloadState.percent + '%' : '0%');
      button.className = 'pp-tool on';
      return;
    }
    /* 这一格永远是「下载本集」：已经下过一集也不能变成「用播放器打开」，
       否则下一集就再也找不到下载入口（0.1.12 的真机回归，REG-008）。
       「用其他播放器播放」继续留在「外放」菜单和设置面板里。 */
    button.textContent = '下载本集';
    button.className = 'pp-tool';
  }

  function downloadProgressNote() {
    if (downloadState.busy) return downloadState.percent ? downloadState.percent + '%' : '正在连接';
    if (downloadState.path) return '已完成 · 点下方选择播放器';
    if (downloadState.error) return downloadState.error;
    return '尚未下载';
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

  /* 下载：登录门控 + 一次只下一个；真正的传输在原生层做，避免 Blob 把内存拖爆 */
  function startDownload() {
    if (!signedIn()) {
      closeCastMenu();
      askLogin();
      return;
    }
    if (downloadState.busy) {
      cancelDownload();
      return;
    }
    var url = mediaUrl();
    if (!url) {
      closeCastMenu();
      var state = mediaState();
      announce(state.reason === 'opaque' ? LINK_UNSUPPORTED
        : '还没拿到直链：先点播放让这一集解析出地址，再回来下载。');
      return;
    }
    if (/\.m3u8(?:[?#]|$)/i.test(url)) {
      closeCastMenu();
      announce('HLS 分片线路没法整集下载；换一条 MP4 线路再试。');
      return;
    }
    var bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.iosPlayer;
    closeCastMenu();
    if (!bridge) {
      announce('当前环境没有下载通道');
      return;
    }
    var name = downloadName();
    var meta = showMeta();
    meta.epKey = episodeKey();
    meta.epLabel = episodeLabel() || (meta.total === 1 ? '正片' : '');
    pendingMeta = meta;
    syncNowPlaying();
    downloadState = { id: 'dl' + Date.now(), name: name, show: meta.title, ep: meta.epLabel, path: '', busy: true, percent: 0 };
    syncDownloadRow();
    saveDownload(true);
    postNative({
      action: 'download', id: downloadState.id, url: url, name: name, signedIn: true,
      /* 原生层只有拿到这组元数据，才能在 App 被回收后把这一集归到正确的剧名下 */
      meta: {
        id: meta.id || '', title: meta.title || '', cover: meta.cover || '',
        total: meta.total || 0, epKey: meta.epKey === undefined ? '' : String(meta.epKey),
        epLabel: meta.epLabel || '',
      },
    });
    announce('开始下载 ' + name);
  }

  function cancelDownload() {
    if (!downloadState.busy || !downloadState.id) return;
    postNative({ action: 'cancelDownload', id: downloadState.id });
    announce('已取消下载');
  }

  function openLocal() {
    if (!downloadState.path) {
      announce('这一集还没下载完');
      return;
    }
    stopInAppPlayback();
    closeCastMenu();
    closeSettingsSheet();
    postNative({ action: 'openLocal', path: downloadState.path, name: downloadState.name });
    announce('正在打开系统应用列表');
  }

  function megabyte(bytes) {
    var size = Number(bytes) || 0;
    return (size / 1048576).toFixed(1) + ' MB';
  }

  /* ---------- 选集批量下载：多选 / 一键全集 / 从本集往后 ----------
     单集和批量共用原生那条持久队列（并发 2、按 showId+集号去重）。
     每一集都从站点接口解析真实媒体地址，绝不把播放页地址当成视频。 */
  var BATCH_STORE = 'kj-ios-batch';
  var QUEUE_STORE = 'kj-ios-queue';
  var batchSelecting = false;
  var batchPicked = [];
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

  function queueFor(showIdValue) {
    var list = [];
    for (var i = 0; i < queueTasks.length; i++) {
      if (String(queueTasks[i].showId || '') === String(showIdValue)) list.push(queueTasks[i]);
    }
    return list;
  }

  /* 整部剧的总体进度：总字节未知时不算百分比，只报已经收了多少（不造 100%）。 */
  function queueSummary(showIdValue) {
    var tasks = queueFor(showIdValue);
    var summary = { total: tasks.length, done: 0, failed: 0, cancelled: 0, running: 0, queued: 0, paused: 0, received: 0, bytesTotal: 0, unknown: 0 };
    for (var i = 0; i < tasks.length; i++) {
      var task = tasks[i];
      var status = String(task.status || '');
      if (summary[status] !== undefined) summary[status] += 1;
      if (status === 'cancelled') continue;
      summary.received += Number(task.received) || 0;
      summary.bytesTotal += Number(task.total) || 0;
      /* 只要有一条没拿到总长度，整部剧就不能算百分比 */
      if ((Number(task.total) || 0) <= 0) summary.unknown += 1;
    }
    summary.busy = summary.running + summary.queued + summary.paused > 0;
    summary.finished = !summary.busy && summary.done > 0;
    summary.allDone = summary.finished && !summary.failed && !summary.cancelled;
    return summary;
  }

  function queueText(summary) {
    if (!summary.total) return '';
    var parts = ['任务 ' + summary.done + '/' + summary.total + ' 集'];
    if (summary.running) parts.push('进行中 ' + summary.running);
    if (summary.queued) parts.push('排队 ' + summary.queued);
    if (summary.paused) parts.push('已暂停 ' + summary.paused);
    if (summary.failed) parts.push('失败 ' + summary.failed);
    if (summary.cancelled) parts.push('已取消 ' + summary.cancelled);
    if (summary.bytesTotal > 0 && !summary.unknown) {
      parts.push('总进度 ' + Math.min(100, Math.round(summary.received / summary.bytesTotal * 100)) + '%');
    } else if (summary.received > 0) {
      /* 服务器没给总长度：只说实收字节，不编百分比 */
      parts.push('已收 ' + megabyte(summary.received));
    }
    if (summary.allDone) parts.push('全部完成');
    else if (summary.finished && summary.failed) parts.push('部分失败');
    return parts.join(' · ');
  }

  function queueActionButton(showIdValue, action, label) {
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (typeof button.setAttribute === 'function') {
      button.setAttribute('data-batch-action', action);
      button.setAttribute('data-show-id', String(showIdValue));
    }
    if (button.dataset) {
      button.dataset.batchAction = action;
      button.dataset.showId = String(showIdValue);
    }
    return button;
  }

  function batchActionOf(node) {
    var cursor = node;
    while (cursor) {
      var action = cursor.dataset && cursor.dataset.batchAction ? cursor.dataset.batchAction : '';
      if (!action && typeof cursor.getAttribute === 'function') action = cursor.getAttribute('data-batch-action') || '';
      if (action) {
        var showIdValue = cursor.dataset && cursor.dataset.showId ? cursor.dataset.showId : '';
        if (!showIdValue && typeof cursor.getAttribute === 'function') showIdValue = cursor.getAttribute('data-show-id') || '';
        return { action: String(action), showId: String(showIdValue || '') };
      }
      cursor = cursor.parentNode;
    }
    return null;
  }

  function handleBatchAction(info) {
    if (!info || !info.showId) return false;
    if (info.action === 'pause') {
      postNative({ action: 'downloadPause', showId: info.showId });
      announce('已暂停这部剧的下载');
      return true;
    }
    if (info.action === 'resume') {
      postNative({ action: 'downloadResume', showId: info.showId });
      announce('继续下载这部剧');
      return true;
    }
    if (info.action === 'cancel') {
      postNative({ action: 'downloadCancel', showId: info.showId });
      announce('已取消这部剧的下载（已下载的文件保留）');
      return true;
    }
    return false;
  }

  function epNodes() {
    return document.querySelectorAll ? document.querySelectorAll('#epGrid .ep') : [];
  }

  function epKeyOf(node) {
    if (!node || !node.dataset || node.dataset.ep === undefined || node.dataset.ep === null) return '';
    return String(node.dataset.ep);
  }

  function epLabelOf(node) {
    var text = node && node.textContent ? String(node.textContent).trim() : '';
    return text.replace(/\s+/g, '').slice(0, 16);
  }

  function epNodeOf(node) {
    var cursor = node;
    while (cursor) {
      if (cursor.className && String(cursor.className).split(' ').indexOf('ep') >= 0 && cursor.dataset && cursor.dataset.ep !== undefined) return cursor;
      cursor = cursor.parentNode;
    }
    return null;
  }

  function currentEpIndex() {
    var list = epNodes();
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].className).split(' ').indexOf('on') >= 0) return i;
    }
    return 0;
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

  function syncPickClass(node, on) {
    var parts = String(node.className || '').split(' ').filter(function (part) { return part && part !== 'ios-pick'; });
    if (on) parts.push('ios-pick');
    node.className = parts.join(' ');
  }

  function togglePick(node) {
    var key = epKeyOf(node);
    if (!key) return;
    var at = batchPicked.indexOf(key);
    if (at >= 0) batchPicked.splice(at, 1);
    else batchPicked.push(key);
    syncPickClass(node, at < 0);
    syncBatchBar();
  }

  function batchBarNote() {
    if (!batchSelecting) return '选择后可批量下载（单集下载仍在工具条上）';
    return batchPicked.length ? '已选 ' + batchPicked.length + ' 集' : '点选集卡片选中要下载的集';
  }

  function syncBatchBar() {
    var bar = document.getElementById('iosBatchBar');
    if (!bar) return;
    var pick = document.getElementById('iosBatchSelect');
    if (pick) pick.textContent = batchSelecting ? '完成选择' : '选择';
    var start = document.getElementById('iosBatchStart');
    if (start) start.textContent = batchPicked.length ? '下载已选 (' + batchPicked.length + ')' : '下载已选';
    var note = document.getElementById('iosBatchNote');
    if (note) note.textContent = batchBarNote();
  }

  function mountBatchBar() {
    var grid = document.getElementById('epGrid');
    if (!grid || !grid.parentNode) return false;
    if (document.getElementById('iosBatchBar')) { syncBatchBar(); return true; }
    var bar = document.createElement('div');
    bar.id = 'iosBatchBar';
    function barButton(id, label) {
      var button = document.createElement('button');
      button.id = id;
      button.type = 'button';
      button.textContent = label;
      bar.appendChild(button);
      return button;
    }
    barButton('iosBatchSelect', '选择');
    barButton('iosBatchAll', '一键全集');
    barButton('iosBatchForward', '从本集往后');
    barButton('iosBatchStart', '下载已选');
    var note = document.createElement('span');
    note.id = 'iosBatchNote';
    bar.appendChild(note);
    grid.parentNode.insertBefore(bar, grid);
    syncBatchBar();
    return true;
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

  function pickedNodes() {
    var list = [];
    var nodes = epNodes();
    for (var i = 0; i < nodes.length; i++) {
      if (batchPicked.indexOf(epKeyOf(nodes[i])) >= 0) list.push(nodes[i]);
    }
    return list;
  }

  function allEpNodes() {
    var list = [];
    var nodes = epNodes();
    for (var i = 0; i < nodes.length; i++) list.push(nodes[i]);
    return list;
  }

  function forwardEpNodes() {
    var nodes = allEpNodes();
    var start = currentEpIndex();
    return nodes.slice(start);
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
      total: Number(payload.showTotal) || (batch && Number(batch.total)) || (task && Number(task.total)) || Number(meta.total) || 0,
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
      if (event === 'done') syncDownloadRow();
      return;
    }
    if (event === 'progress') {
      var total = Number(payload.total) || 0;
      var received = Number(payload.received) || 0;
      downloadState.busy = true;
      downloadState.percent = total > 0 ? Math.min(100, Math.round(received / total * 100)) : 0;
      syncDownloadRow();
      return;
    }
    if (event === 'done') {
      /* 没有 showId/集号的老式单集事件走原来的 pendingMeta 路径 */
      if (!payload.showId && !payload.epKey) recordDownloaded(payload, pendingMeta);
      pendingMeta = null;
      downloadState.busy = false;
      downloadState.percent = 100;
      downloadState.path = payload.path || '';
      syncDownloadRow();
      saveDownload(true);
      announce('已下载 ' + (payload.name || downloadState.name) + '（' + megabyte(payload.size) + '），点「用其他播放器播放」选择 App');
      return;
    }
    downloadState.busy = false;
    downloadState.percent = 0;
    downloadState.error = event === 'cancelled' ? '已取消' : (payload.reason || '下载失败');
    downloadState.path = '';
    pendingMeta = null;
    syncDownloadRow();
    saveDownload(true);
    if (event === 'cancelled') announce('已取消下载');
    else announce('下载失败：' + (payload.reason || '网络不给力，稍后再试'));
  };

  /* 原生队列快照：整部剧的进度、排队/暂停/失败状态都从这份快照来（重启后也一样） */
  window.__zhuijuDownloads = function (kind, tasks) {
    if (kind !== 'snapshot' || !tasks || typeof tasks.length !== 'number') return;
    queueTasks = tasks;
    saveQueue();
    renderDownloadLibrary();
    syncBatchBar();
  };

  function handleCtrlClick(event) {
    var target = event.target;
    if (!target) return false;
    /* 选集页「选择」模式：点选集卡片是选中/取消，不再跳集 */
    if (batchSelecting) {
      var epNode = epNodeOf(target);
      if (epNode) {
        event.preventDefault();
        event.stopImmediatePropagation();
        togglePick(epNode);
        return true;
      }
    }
    if (hit(target, 'iosBatchSelect')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      batchSelecting = !batchSelecting;
      if (!batchSelecting) {
        var nodes = epNodes();
        for (var n = 0; n < nodes.length; n++) syncPickClass(nodes[n], false);
        batchPicked = [];
      }
      syncBatchBar();
      return true;
    }
    if (hit(target, 'iosBatchAll')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      startBatch(allEpNodes());
      return true;
    }
    if (hit(target, 'iosBatchForward')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      startBatch(forwardEpNodes());
      return true;
    }
    if (hit(target, 'iosBatchStart')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      startBatch(pickedNodes());
      return true;
    }
    if (hit(target, 'iosOpenDownloaded')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openLocal();
      return true;
    }
    /* 点面板外面的深色底也能关，不必非得找「关闭」按钮 */
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
    var batchAction = batchActionOf(target);
    if (batchAction && handleBatchAction(batchAction)) return true;
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
    if (hit(target, 'ppFit')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      cycleFit();
      hideCtrlSoon();
      return true;
    }
    var batchAction = batchActionOf(target);
    if (batchAction) {
      event.preventDefault();
      event.stopImmediatePropagation();
      handleBatchAction(batchAction);
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
    if (hit(target, 'ppDownload')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      startDownload();
      return true;
    }
    if (hit(target, 'ppToolDownload')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      /* 这一格只做下载/取消下载；把文件交给播放器是菜单里那一行和设置里的按钮。 */
      startDownload();
      return true;
    }
    if (hit(target, 'ppOpenLocal')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openLocal();
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
  });
  onWindow('orientationchange', function () {
    if (!landscape()) explicitInline = false;
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

  /* 下载状态先恢复：换页/重启后原生下载还在跑，进度条要接着显示 */
  restoreDownload();
  restoreQueue();
  if (downloadState.id || downloadState.busy || downloadState.path) {
    ensureSettingsSheet();
    mountDownloadPanel();
    syncDownloadRow();
  }
  /* 问一次原生：后台下载可能在我们不知情时跑完了 */
  setTimeout(function () { postNative({ action: 'downloadSync' }); }, 800);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', prepareLayout, { once: true });
  } else {
    prepareLayout();
  }
  /* 站点是 SPA：换集或重渲染可能整块换掉 #player，几次补挂 */
  [0, 400, 1200, 2600].forEach(function (delay) {
    setTimeout(function () { mountCtrlBar(); mountToolDownload(); mountBatchBar(); }, delay);
  });
  /* 首页/播放页的站点渲染是异步的：面板和状态晚一步再补一次 */
  [0, 600, 1600].forEach(function (delay) {
    setTimeout(function () {
      mountDownloadPanel();
      mountToolDownload();
      syncExtToggle();
      syncDownloadRow();
    }, delay);
  });
}());
