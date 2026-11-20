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
    /* 站点自己的下载入口有两处：新版播放页的 [data-pw-act="dl"]，
       以及站点控制栏里那个「下载本集」菜单行 #ppDownload。
       网页版在浏览器里只能「抓整段再存盘」，App 里统一改走原生队列（能后台、能离线播）。 */
    var downloadTrigger = target.closest ? target.closest('[data-pw-act="dl"], #ppDownload') : null;
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
    if (handleAppClick(target, event)) return;
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
    if (event.target.id === 'iosSettingSpeed') setSettingValue('kj-speed', event.target.value);
    var key = event.target && event.target.getAttribute ? event.target.getAttribute('data-dm-setting') : null;
    if (key) setSettingValue(key, event.target.value);
  }, true);
  document.addEventListener('input', function (event) {
    var key = event.target && event.target.getAttribute ? event.target.getAttribute('data-dm-setting') : null;
    if (key && key !== 'kj-dm-area') setSettingValue(key, event.target.value);
  }, true);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'hidden') {
      /* 回到前台：让原生把后台会话里的最新进度/终态补回来 */
      postNative({ action: 'downloadSync' });
      return;
    }
    pendingPlayback = null;
    var video = document.getElementById('video');
    if (video && !video.webkitDisplayingFullscreen && video.webkitPresentationMode !== 'picture-in-picture') video.pause();
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
      '.ios-page .ip-cell progress{display:block;width:100%;height:4px;accent-color:#16e09d}',
      '.ios-page .ip-cell progress[hidden]{display:none}',
      '.ios-page .ip-cell progress:not([hidden]){display:block}',
      '.ios-page .ip-cell.busy,.ios-page .ip-cell.done{border-color:rgba(22,224,157,.6);background:rgba(22,224,157,.18);color:#16e09d}',
      '.ios-page .ip-cell.busy .ip-cell-state,.ios-page .ip-cell.done .ip-cell-state{color:#16e09d}',
      '.ios-page #iosDlListBtn{flex:1 1 auto;appearance:none;border:0;border-radius:10px;background:#16e09d;color:#04241a;font-size:14px;font-weight:800;padding:12px;min-height:46px}',
      '.ios-page .ip-sub{font-size:12px;color:rgba(232,241,245,.62);margin:2px 0 10px}',
      '.ios-page #iosMineQueue{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}',
      '.ios-page .ios-dl-task{padding:10px 12px;border-radius:10px;background:rgba(22,224,157,.12)}',
      '.ios-page .ios-dl-task-head{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700}',
      '.ios-page .ios-dl-task-title{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ios-page .ios-dl-task-state{flex:none;font-size:12px;font-weight:700;color:#16e09d}',
      '.ios-page .ios-dl-task progress{display:block;width:100%;height:6px;margin-top:8px;accent-color:#16e09d}',
      '.ios-page .ios-dl-task progress[hidden]{display:none!important}',
      '.ios-page .ios-dl-task-meta{margin-top:6px;font-size:11px;color:rgba(232,241,245,.66)}',
      "html[data-theme='light'] .ios-page .ios-dl-task{background:rgba(18,153,111,.12)}",
      '.ios-page .ip-show{display:flex;gap:10px;align-items:center;padding:12px 0;border-bottom:1px solid rgba(255,255,255,.06)}',
      '.ios-page .ip-show img{width:44px;height:62px;border-radius:6px;object-fit:cover;background:#182028;flex:none}',
      '.ios-page .ip-show .ips-main{flex:1 1 auto;min-width:0}',
      '.ios-page .ip-show .ips-title{font-size:14px;font-weight:700}',
      '.ios-page .ip-show .ips-meta{font-size:11px;color:rgba(232,241,245,.62);margin-top:3px}',
      '.ios-page .ip-eprow{position:relative;overflow:hidden;border-radius:9px;margin-top:8px;background:rgba(255,255,255,.05)}',
      '.ios-page .ip-eprow .ip-epbody{display:flex;align-items:center;gap:10px;padding:11px 12px;transition:transform .16s ease;will-change:transform;touch-action:pan-y}',
      '.ios-page .ip-eprow .ip-epext{flex:none;padding:4px 9px;border-radius:11px;background:rgba(76,141,255,.16);color:#8fb6ff;font-size:11px;font-weight:600}',
      '.ios-page .ip-eprow .ip-eptitle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600}',
      '.ios-page .ip-eprow .ip-epsize{font-size:11px;color:rgba(232,241,245,.6)}',
      '.ios-page .ip-eprow .ip-epdel{position:absolute;right:0;top:0;bottom:0;width:82px;border:0;background:#e5484d;color:#fff;font-size:13px;font-weight:700}',
      /* 播放设置面板：从右侧滑出 */
      "html[data-theme='light'] .ios-page{background:#f6f7f9;color:#151b20}",
      "html[data-theme='light'] .ios-page .ip-head button,html[data-theme='light'] .ios-page .ip-cell{color:#151b20}",
      /* 首页没有站点面板（只有一句「设置面板即将上线」），注入层自带一个：
         下载进度和播放方式都在里面，任何页面都能打开。 */
      '#iosSettingsSheet{position:fixed;left:0;right:0;top:0;bottom:0;z-index:12000;display:flex;align-items:flex-end;background:rgba(4,8,11,.62)}',
      '@media(min-width:620px) and (min-height:610px){#iosSettingsSheet{align-items:center;justify-content:center}#iosSettingsCard{width:560px;max-height:88%;padding:16px;border-radius:16px}}',
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
      '.ios-page .ios-dl-queue-note{font-size:11px;color:rgba(232,241,245,.58);margin:2px 0 10px}',
      "html[data-theme='light'] .ios-page .ios-dl-queue-note{color:rgba(15,20,24,.55)}",
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
      /* 提示的 z-index 要高于设置面板（12000）：面板里切「播放方式」时要看得到反馈 */
      '#iosToast{position:fixed;left:50%;bottom:calc(96px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);max-width:82vw;padding:10px 14px;border-radius:12px;background:rgba(8,12,15,.94);color:#fff;font-size:13px;line-height:1.35;z-index:13000;opacity:0;pointer-events:none;transition:opacity .18s ease;text-align:center}',
      '#iosToast[data-show]{opacity:1}',
      '.brand .brand-mark{width:30px;height:30px;background-image:var(--brand-logo);background-size:cover;background-position:center;border-radius:9px;overflow:hidden;filter:none}',
      '.brand .brand-mark>svg{display:none}',
      '.tabbar .tab.center .tab-circle{background-image:var(--brand-logo);background-size:cover;background-position:center;overflow:hidden}',
      '.tabbar .tab.center .tab-circle>svg{display:none}',
      '.dm-layer{contain:layout paint;transform:translateZ(0);opacity:var(--ios-dm-opacity,1);clip-path:inset(0 0 calc(100% - var(--ios-dm-area,100%)) 0)}',
      'html[data-ios-dm-off] .dm-layer{display:none!important}',
      '.dm-item{left:0!important;font-size:var(--ios-dm-size,18px)!important;animation:dm-fly-x var(--ios-dm-duration,var(--dur,9s)) linear forwards!important;will-change:transform!important}',
      '@keyframes dm-fly-x{from{transform:translateX(100vw)}to{transform:translateX(-100%)}}',
      /* App 内场景：固定/粘性顶栏的 backdrop-filter 在 iOS 的 WebKit 里滚动时每帧重算，
         长列表明显掉帧。换成等效的半透明底色（观感基本不变）。 */
      '.topbar,.page-head{-webkit-backdrop-filter:none!important;backdrop-filter:none!important;background:linear-gradient(180deg,rgba(10,20,28,.97),rgba(10,20,28,.9))!important}',
      'html[data-theme=\'light\'] .topbar,html[data-theme=\'light\'] .page-head{background:linear-gradient(180deg,rgba(255,255,255,.97),rgba(255,255,255,.92))!important}',
      /* 首页顶栏保持 0.1.17 的样子：App 不往顶栏塞设置齿轮，设置只从「我的」菜单进。 */
      '.topbar [data-action="settings"]{display:none!important}',
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
    ensureDownloadPage();
    ensureMinePage();
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
  function postNative(payload) {
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.iosPlayer) {
        window.webkit.messageHandlers.iosPlayer.postMessage(payload);
      }
    } catch (error) { /* 原生通道不可用时静默忽略：全屏仍由站点播放器自己处理 */ }
  }

  /* 全屏分两步：先把站点的「容器元素全屏」改道到系统原生视频全屏（见下面的
     routeFullscreenToNativeVideo），再只汇报「进 / 出」让原生锁方向。
     不改页面几何、不藏站点控件、不自己画全屏层，页面也不重建，
     所以退出全屏后详情页位置和播放进度都保持原样。 */
  var playerFullscreenOn = null;

  /* 系统原生视频全屏当前锁定的视频。iOS 15.0–15.3 的 WKWebView 没有 Element 全屏 API，
     站点自己也可能没有可调的全屏方法；这里记住是哪段视频在全屏，补出来的
     document.exitFullscreen 才有东西可退。 */
  var nativeVideoFullscreen = null;

  /* 同一时间只跟一个原生视频全屏请求：站点连点两次时第二个请求明确拒绝，
     不会堆成两条 pending，也就不会出现「一次 begin 把两个请求都算成功」。
     token 就是 request 对象本身；定时器只认自己那一次，结束后绝不会动后来的请求。 */
  var pendingFullscreenRequest = null;
  var reportingSynthesizedChange = false;

  function settleFullscreenRequest(request, started) {
    if (!request || request !== pendingFullscreenRequest) return;
    pendingFullscreenRequest = null;
    if (request.timer) clearTimeout(request.timer);
    request.timer = null;
    if (started) request.resolve();
    else request.reject(new TypeError('Fullscreen was not started'));
  }

  /* 公开属性 webkitDisplayingFullscreen 在部分系统上没有：有才拿来做宽限核对，
     没有就只认 begin / end 事件。不读 WebKit 私有控制器，也不靠屏幕方向反推退出。 */
  function nativeFullscreenSupported(video) {
    return !!(video && typeof video.webkitDisplayingFullscreen === 'boolean');
  }

  function startNativeVideoFullscreen(video) {
    if (nativeVideoFullscreen === video) return Promise.resolve();
    if (pendingFullscreenRequest) return Promise.reject(new TypeError('Fullscreen request already pending'));
    var request = { video: video, resolve: null, reject: null, timer: null };
    var promise = new Promise(function (resolve, reject) {
      request.resolve = resolve;
      request.reject = reject;
    });
    pendingFullscreenRequest = request;
    var finish = function (started) { settleFullscreenRequest(request, started); };
    try {
      video.webkitEnterFullscreen();
    } catch (error) {
      finish(false);
      return promise;
    }
    /* 系统不回事件（手势被拒、解码器忙）时按失败处理，站点可以自己提示。 */
    request.timer = setTimeout(function () { finish(false); }, 1500);
    if (nativeFullscreenSupported(video)) {
      /* 事件还没来但系统其实已经全屏：给一个很短的宽限核对，成功就不用干等。 */
      setTimeout(function () {
        if (request !== pendingFullscreenRequest) return;
        if (video.webkitDisplayingFullscreen) finish(true);
      }, 300);
    }
    return promise;
  }

  function reportPlayerFullscreen(active) {
    var on = !!active;
    if (playerFullscreenOn === on) return;
    playerFullscreenOn = on;
    postNative({ action: 'playerFullscreen', on: on });
  }

  function currentFullscreenElement() {
    if (nativeVideoFullscreen) return nativeVideoFullscreen;
    if (document.fullscreenElement) return document.fullscreenElement;
    if (document.webkitFullscreenElement) return document.webkitFullscreenElement;
    return null;
  }

  /* 站点播放器走标准 Fullscreen API：进 / 出都会派发 fullscreenchange。 */
  document.addEventListener('fullscreenchange', function () {
    /* 我们自己补发的事件只是给站点看的：退出时页面可能还残留 document.fullscreenElement，
       不能再拿它判断一次「进全屏」，否则原生方向会被重新切成横屏。 */
    if (reportingSynthesizedChange) return;
    reportPlayerFullscreen(!!currentFullscreenElement());
  }, true);
  document.addEventListener('webkitfullscreenchange', function () {
    if (reportingSynthesizedChange) return;
    reportPlayerFullscreen(!!currentFullscreenElement());
  }, true);

  /* 原生视频全屏退出后，如果站点是靠 fullscreenchange 收尾的，也让它收到一次退出事件；
     否则站点可能把沉浸态样式或退出按钮留在页面上。只补事件，不动 DOM、不改样式。 */
  function notifyNativeFullscreenEnded() {
    if (typeof document.dispatchEvent !== 'function') return;
    reportingSynthesizedChange = true;
    try {
      if (typeof window.Event === 'function') {
        document.dispatchEvent(new window.Event('fullscreenchange'));
        document.dispatchEvent(new window.Event('webkitfullscreenchange'));
      }
    } catch (error) { /* 站点没有事件构造器时忽略：退出本身已经完成 */ }
    finally { reportingSynthesizedChange = false; }
  }

  /* <video> 直接调 webkitEnterFullscreen 时只派发这两个事件，而且不冒泡，只能在 document 上捕获。
     begin / end 只认「这次请求的视频」或「当前在全屏的视频」，别的视频一律忽略。 */
  document.addEventListener('webkitbeginfullscreen', function (event) {
    var video = event && event.target && event.target.tagName === 'VIDEO' ? event.target : null;
    if (!video) return;
    var matchesPending = pendingFullscreenRequest && pendingFullscreenRequest.video === video;
    var matchesCurrent = nativeVideoFullscreen === video;
    if (!matchesPending && !matchesCurrent && (pendingFullscreenRequest || nativeVideoFullscreen)) return;
    if (matchesPending) settleFullscreenRequest(pendingFullscreenRequest, true);
    nativeVideoFullscreen = video;
    reportPlayerFullscreen(true);
  }, true);
  document.addEventListener('webkitendfullscreen', function (event) {
    var video = event && event.target && event.target.tagName === 'VIDEO' ? event.target : null;
    if (!video) return;
    if (pendingFullscreenRequest && pendingFullscreenRequest.video === video) {
      /* 还没开始就结束：这次请求算失败，但全局状态没变，不动方向。 */
      settleFullscreenRequest(pendingFullscreenRequest, false);
      return;
    }
    /* 另一段视频退出：跟当前这次全屏无关，不能清状态、也不能报「回竖屏」。 */
    if (nativeVideoFullscreen !== video) return;
    nativeVideoFullscreen = null;
    reportPlayerFullscreen(false);
    notifyNativeFullscreenEnded();
  }, true);

  /* 页面回到前台时核对一次：end 事件丢了的话，这里补一次退出，避免原生一直停在横屏。
     只在 webkitDisplayingFullscreen 可用时做；属性不存在就只依赖事件（真机风险见文档）。 */
  function reconcileNativeFullscreen() {
    if (!nativeVideoFullscreen) return;
    if (!nativeFullscreenSupported(nativeVideoFullscreen)) return;
    if (nativeVideoFullscreen.webkitDisplayingFullscreen) return;
    nativeVideoFullscreen = null;
    reportPlayerFullscreen(false);
    notifyNativeFullscreenEnded();
  }
  onWindow('pageshow', reconcileNativeFullscreen);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') reconcileNativeFullscreen();
  }, true);

  /* 站点全屏是「把整个播放器容器 requestFullscreen」。iOS 的 WKWebView 对这种容器元素全屏
     会丢掉视频图层：画面全黑、只剩声音，站点自己的退出按钮也跟着被盖住，看起来像退不出去。
     这里只改「用哪套全屏」：容器（或 video 自己）的全屏请求改道到内部 <video>.webkitEnterFullscreen()，
     由系统原生视频播放器接管 —— 有画面、自带 Done 和下滑退出；页面不重建，退出后回到原位继续播。
     不搬动视频节点、不写全屏 CSS、不做旋转，非视频元素的请求仍走原来的实现。 */
  function nativeVideoInside(element) {
    if (!element) return null;
    if (element.tagName === 'VIDEO') return element;
    var inside = element.querySelector ? element.querySelector('video') : null;
    if (inside) return inside;
    /* 只在请求的就是包含主视频的根节点时才兜底，避免把无关元素的全屏也换成视频全屏。 */
    var main = document.getElementById('video');
    if (!main || typeof element.contains !== 'function') return null;
    return element.contains(main) ? main : null;
  }

  function routeFullscreenToNativeVideo() {
    var proto = window.Element && window.Element.prototype;
    if (!proto || proto.__zhuijuNativeVideoFullscreen) return;
    proto.__zhuijuNativeVideoFullscreen = true;
    var names = ['requestFullscreen', 'webkitRequestFullscreen'];
    for (var index = 0; index < names.length; index++) {
      (function (name) {
        var original = proto[name];
        /* 老系统（iOS 15.0–15.3）上根本没有这个方法，也一并补出来：
           否则站点一检测到「没有全屏 API」，就干脆不显示全屏按钮，改道根本没机会执行。
           补的方法对没有视频的元素返回被拒绝的 Promise，和浏览器不支持时表现一致。 */
        proto[name] = function () {
          var video = nativeVideoInside(this);
          if (video) {
            /* 有视频就只走系统原生视频全屏，这条路上绝不回退到会黑屏的容器元素全屏。 */
            if (typeof video.webkitEnterFullscreen !== 'function') {
              return Promise.reject(new TypeError('Fullscreen is not supported'));
            }
            return startNativeVideoFullscreen(video);
          }
          if (typeof original === 'function') return original.apply(this, arguments);
          return Promise.reject(new TypeError('Fullscreen is not supported'));
        };
      }(names[index]));
    }
  }

  /* 站点通常先看 document.fullscreenEnabled 才决定显不显示全屏按钮，退出时调 document.exitFullscreen。
     iOS 15.0–15.3 这两个能力都不存在，但系统原生视频全屏本来就能用：补上最小的状态，
     让全屏按钮出现、退出时能关掉系统播放器。只补状态和方法，不动页面样式。 */
  function exposeNativeFullscreenState() {
    try {
      Object.defineProperty(document, 'fullscreenEnabled', {
        configurable: true,
        get: function () { return true; }
      });
    } catch (error) { /* document 不允许改写时保持 WebKit 原值 */ }
    var names = ['exitFullscreen', 'webkitExitFullscreen'];
    for (var index = 0; index < names.length; index++) {
      (function (name) {
        var original = document[name];
        document[name] = function () {
          if (nativeVideoFullscreen && typeof nativeVideoFullscreen.webkitExitFullscreen === 'function') {
            try {
              nativeVideoFullscreen.webkitExitFullscreen();
              return Promise.resolve();
            } catch (error) { /* 交给下面的原实现 */ }
          }
          if (typeof original === 'function') return original.apply(document, arguments);
          return Promise.reject(new TypeError('No fullscreen element'));
        };
      }(names[index]));
    }
  }

  routeFullscreenToNativeVideo();
  exposeNativeFullscreenState();

  var settingsSheet = null;

  /* 下载状态跨页面保留：原生下载在 WKWebView 外面跑，换页只换网页。
     进度落 localStorage，回到首页也看得到；原生回传的事件在新页面继续接。 */
  var DOWNLOAD_STORE = 'kj-ios-download';

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
    var count = document.getElementById('pwEpCount');
    if (count && typeof count.textContent === 'string') {
      var fromCount = /共\s*(\d+)\s*集/.exec(count.textContent);
      if (fromCount) return Number(fromCount[1]) || 0;
    }
    var more = document.getElementById('epMore');
    if (more && typeof more.textContent === 'string') {
      var fromMore = /(\d+)\s*集/.exec(more.textContent);
      if (fromMore) return Number(fromMore[1]) || 0;
    }
    var buttons = epNodes();
    if (buttons && buttons.length) return buttons.length;
    /* 没有选集按钮的（电影/单集）就只有一集正片 */
    var any = document.querySelector ? document.querySelector('.ep') : null;
    return any ? 0 : 1;
  }

  function showMeta() {
    var id = '';
    try { id = new URLSearchParams(window.location.search).get('id') || ''; } catch (error) { id = ''; }
    var title = '';
    var heading = document.querySelector ? document.querySelector('.pw-title, .detail-info h1, .ph-title') : null;
    if (heading && heading.textContent) title = String(heading.textContent).replace(/\s*›\s*$/, '').trim();
    if (!title) title = String(document.title || '').replace(/\s*[-–—|]\s*(看剧AI|阿噗影视)\s*$/, '').trim();
    var cover = '';
    var card = document.querySelector ? document.querySelector('.pw-card-bg') : null;
    if (card && typeof card.getAttribute === 'function') {
      var background = String(card.getAttribute('style') || '');
      var fromStyle = /background-image:\s*url\(['"]?([^'")]+)/i.exec(background);
      if (fromStyle) cover = fromStyle[1];
    }
    var poster = document.querySelector ? document.querySelector('.detail-poster img') : null;
    if (!cover && poster && typeof poster.getAttribute === 'function') cover = poster.getAttribute('src') || '';
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

  /* 原生「打开方式」面板的结果（缺文件 / 没有可用播放器 / 用户取消）回到网页，
     用同一个 toast 说一句，不给站点页面塞任何节点。 */
  window.__zhuijuPlayerNotice = function (message) {
    announce(String(message || ""));
  };

  function isPageUrl(url) {
    var page = String(window.location && window.location.href || '').split('#')[0].split('?')[0];
    return !!page && String(url).split('#')[0].split('?')[0] === page;
  }


  /* ---------- 外放 / 下载菜单 ---------- */
  var downloadState = { id: '', name: '', show: '', ep: '', path: '', busy: false, percent: 0 };
  /* 这一集的剧名/封面/总集数/集号：下载完成时才能把「哪部剧的哪一集」记进片库。 */
  var pendingMeta = null;

  /* 安全文件名：只换掉文件系统真的不接受的字符，不动中文和空格，不损真实剧名 */
  function safeName(raw) {
    var name = String(raw || '')
      .replace(/[\/\:*?"<>|]/g, '_')
      /* eslint-disable-next-line no-control-regex */
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[. ]+/, '')
      .trim();
    return name.slice(0, 80);
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
    var task = null;
    for (var index = 0; index < queueTasks.length; index++) {
      if (String(queueTasks[index].id) !== String(payload.id)) continue;
      task = queueTasks[index];
      break;
    }
    if (!task) {
      task = { id: String(payload.id) };
      queueTasks.push(task);
    }
    task.status = 'running';
    task.total = Number(payload.total) || 0;
    task.received = Number(payload.received) || 0;
    if (payload.showId) task.showId = String(payload.showId);
    if (payload.epKey !== undefined) task.epKey = String(payload.epKey);
    if (payload.epLabel) task.epLabel = String(payload.epLabel);
    if (payload.title) task.title = String(payload.title);
    saveQueue();
    syncDownloadPage();
    renderMinePageIfOpen();
  }

  /* 下载中的一集：剧名 + 第几集 + 进度条 + 百分比。 */
  var QUEUE_RANK = { running: 0, queued: 1, paused: 2 };
  var QUEUE_TEXT = { running: '下载中', queued: '排队中', paused: '已暂停' };

  function batchShowOf(showId) {
    var list = readBatchShows();
    for (var i = 0; i < list.length; i++) {
      if (String(list[i] && list[i].id) === String(showId)) return list[i];
    }
    return null;
  }

  /* 剧名优先级：原生事件带的 > 「一键全集」记住的 > 片库里的 > 当前页面。 */
  function taskShowTitle(task) {
    var title = String((task && task.title) || '').trim();
    if (title) return title;
    if (task && downloadState.id && String(task.id) === String(downloadState.id) && downloadState.show) {
      return String(downloadState.show);
    }
    var batch = batchShowOf(task && task.showId);
    if (batch && batch.title) return String(batch.title);
    var shows = readLibrary().shows;
    for (var i = 0; i < shows.length; i++) {
      if (String(shows[i].id) === String(task && task.showId)) return String(shows[i].title);
    }
    var meta = showMeta();
    return String(meta.title || '');
  }

  function taskEpisodeLabel(task) {
    var label = String((task && (task.epLabel || task.ep)) || '').trim();
    if (label) return label;
    if (task && downloadState.id && String(task.id) === String(downloadState.id) && downloadState.ep) {
      return String(downloadState.ep);
    }
    if (task && task.epKey !== undefined && task.epKey !== null && String(task.epKey) !== '') {
      return '第' + task.epKey + '集';
    }
    return '';
  }

  function queueTaskRows() {
    var rows = [];
    var seen = {};
    for (var i = 0; i < queueTasks.length; i++) {
      var task = queueTasks[i];
      if (!task || !task.id) continue;
      var status = String(task.status || '');
      if (status !== 'running' && status !== 'queued') continue;
      seen[String(task.id)] = true;
      rows.push(task);
    }
    /* 单集下载还没进快照时，用网页手里的当前状态补一行，进度不会断档。 */
    if (downloadState.busy && downloadState.id && !seen[String(downloadState.id)]) {
      rows.unshift({
        id: downloadState.id,
        status: 'running',
        title: downloadState.show,
        epLabel: downloadState.ep,
        received: downloadState.received,
        total: downloadState.total
      });
    }
    rows.sort(function (left, right) {
      var a = QUEUE_RANK[String(left.status)];
      var b = QUEUE_RANK[String(right.status)];
      return (a === undefined ? 9 : a) - (b === undefined ? 9 : b);
    });
    return rows;
  }

  /* 正在下载区：一集一行，实时刷新进度条和百分比；排队中的集也列出来。 */
  function renderQueueRows(body) {
    var rows = queueTaskRows();
    if (!rows.length) return 0;
    var box = document.createElement('div');
    box.id = 'iosMineQueue';
    for (var i = 0; i < rows.length; i++) {
      var task = rows[i];
      var status = String(task.status || 'running');
      var total = Number(task.total) || 0;
      var received = Number(task.received) || 0;
      var percent = total > 0 ? Math.min(100, Math.round(received / total * 100)) : 0;
      var row = document.createElement('div');
      row.className = 'ios-dl-task';
      /* 剧名可能带中文：把非法字符编成唯一后缀，避免不同剧的同一集撞成同一个 DOM id。 */
      var safeId = String(task.id).replace(/[^A-Za-z0-9_-]/g, function (ch) { return '_' + ch.charCodeAt(0).toString(16); });
      row.id = 'iosMineTask-' + (safeId || ('row' + i));
      row.setAttribute('data-dl-task', String(task.id));
      var head = document.createElement('div');
      head.className = 'ios-dl-task-head';
      var title = document.createElement('span');
      title.className = 'ios-dl-task-title';
      title.textContent = (taskShowTitle(task) + ' ' + taskEpisodeLabel(task)).replace(/\s+/g, ' ').trim() || '这一集';
      var state = document.createElement('span');
      state.className = 'ios-dl-task-state';
      state.textContent = status === 'running' && total > 0 ? percent + '%' : (QUEUE_TEXT[status] || '下载中');
      head.appendChild(title);
      head.appendChild(state);
      row.appendChild(head);
      var progress = document.createElement('progress');
      progress.className = 'ios-dl-task-progress';
      progress.max = total || 1;
      if (status === 'running' && total > 0) progress.value = Math.min(received, total);
      else progress.removeAttribute('value');
      progress.hidden = status !== 'running';
      progress.setAttribute('aria-label', title.textContent + ' ' + state.textContent);
      row.appendChild(progress);
      var meta = document.createElement('div');
      meta.className = 'ios-dl-task-meta';
      if (status === 'running') {
        meta.textContent = (total > 0 ? percent + '% · ' : '') + megabyte(received)
          + (total > 0 ? ' / ' + megabyte(total) : '');
      } else {
        meta.textContent = QUEUE_TEXT[status] || '';
      }
      row.appendChild(meta);
      box.appendChild(row);
    }
    body.appendChild(box);
    var note = document.createElement('div');
    note.className = 'ios-dl-queue-note';
    note.textContent = '同时最多下载 2 集 · 共 ' + rows.length + ' 集在队列里';
    body.appendChild(note);
    return rows.length;
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
    var list = document.querySelectorAll('#pwEpList .ep');
    if (!list.length) list = document.querySelectorAll('#pwEpGrid .ep');
    if (!list.length) list = document.querySelectorAll('#epGrid .ep');
    return list;
  }

  function epKeyOf(node) {
    if (!node || !node.dataset || node.dataset.ep === undefined || node.dataset.ep === null) return '';
    return String(node.dataset.ep);
  }

  function currentEpNode() {
    var episodes = epNodes();
    for (var index = 0; index < episodes.length; index++) {
      if (String(episodes[index].className).split(' ').indexOf('on') >= 0) return episodes[index];
    }
    return episodes[0] || null;
  }

  function epLabelOf(node) {
    var text = node && node.textContent ? String(node.textContent).trim() : '';
    return text.replace(/\s+/g, '').slice(0, 16);
  }

  function currentLine() {
    var active = document.querySelector('.pl-line.on') || document.querySelector('.line.on');
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
          id: 'dl-' + (id || 'ep') + '-' + key,
          showId: id,
          epKey: key,
          epLabel: label,
          title: meta.title || '',
          url: results[r].url,
          name: safeName(String(meta.title || '未命名') + ' ' + label) + extensionOf(results[r].url)
        });
      }
      if (!items.length) { announce(skipped[0] || '这些集都没有可下载的片源'); return 0; }
      /* 新站没有 App 登录态，队列请求不再带 signedIn；原生侧也不再拿它当门槛 */
      postNative({
        action: 'downloadBatch',
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
    var node = currentEpNode();
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
        syncDownloadPage();
        renderMinePageIfOpen();
        saveDownload(true);
        return;
      }
      if (event === 'progress') {
        updateQueueProgress(payload);
        var downloadPage = document.getElementById('iosDlPage');
        if (downloadPage && !downloadPage.hidden) syncDownloadPage();
        renderMinePageIfOpen();
      }
      if (event === 'done' || event === 'failed' || event === 'cancelled') removeQueueTask(payload.id);
      if (event === 'done') { syncDownloadPage(); renderMinePageIfOpen(); }
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
      var downloadPage = document.getElementById('iosDlPage');
      if (downloadPage && !downloadPage.hidden) syncDownloadPage();
      renderMinePageIfOpen();
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
      syncDownloadPage();
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
    syncDownloadPage();
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

  /// 这一集在片库里的记录（下载完成过才有）。
  function dlDownloadedEntry(showId, key) {
    var library = readLibrary();
    for (var s = 0; s < library.shows.length; s++) {
      var show = library.shows[s];
      if (String(show.id) !== String(showId)) continue;
      for (var e = 0; e < show.eps.length; e++) {
        if (String(show.eps[e].key) === String(key)) return show.eps[e];
      }
    }
    return null;
  }

  function dlDownloaded(showId, key) {
    return !!dlDownloadedEntry(showId, key);
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
      var existing = dlTaskState(dlShowId(), key);
      var saved = dlDownloadedEntry(dlShowId(), key);
      if (saved && saved.path) {
        postNative({ action: 'playLocal', path: saved.path });
        return true;
      }
      if (existing && (existing.status === 'queued' || existing.status === 'running')) return true;
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

  /* ==================== 下载页 / 我的下载 ==================== */

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
        var progressNode = document.createElement('progress');
        progressNode.hidden = true;
        progressNode.max = 1;
        cell.appendChild(progressNode);
        cell.__iosProgress = progressNode;
        grid.appendChild(cell);
      }
      cell.__iosLabel = label;
      if (cell.__iosState) cell.__iosState.textContent = state === '已下载' ? '已下载' : state;
      var task = dlTaskState(showId, key);
      var total = Number(task && task.total) || 0;
      var received = Number(task && task.received) || 0;
      if (cell.__iosProgress) {
        cell.__iosProgress.hidden = !task || task.status !== 'running';
        cell.__iosProgress.max = total || 1;
        if (total > 0) cell.__iosProgress.value = Math.min(received, total);
        else cell.__iosProgress.removeAttribute('value');
        cell.__iosProgress.setAttribute('aria-label', total > 0
          ? '下载进度 ' + Math.min(100, Math.round(received / total * 100)) + '%'
          : '正在下载');
      }
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
    /* 正在下载：一集一行，剧名 + 集号 + 进度条 + 百分比（实时刷新） */
    var downloading = renderQueueRows(body);
    /* 已下载：按剧分组，每部下面一行一集，左滑删除 */
    var shows = readLibrary().shows;
    if (!shows.length && !downloading) {
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
          var body2 = document.createElement('button');
          body2.type = 'button';
          body2.className = 'ip-epbody';
          body2.disabled = !ep.path;
          if (ep.path) {
            body2.setAttribute('data-ios-act', 'play-local');
            body2.setAttribute('data-dl-path', ep.path);
            body2.setAttribute('aria-label', '离线播放 ' + (ep.label || ('第' + ep.key + '集')));
          }
          var title = document.createElement('span');
          title.className = 'ip-eptitle';
          title.textContent = ep.label || ('第' + ep.key + '集');
          body2.appendChild(title);
          /* 已完成的一集：除了 App 内播放，还能交给系统「打开方式」里的其他播放器。
             下载中 / 没下完的集没有 path，压根不出现这个入口。
             用 span 而不是 button：body2 本身是 button，按钮不能套按钮。 */
          if (ep.path) {
            var ext = document.createElement('span');
            ext.className = 'ip-epext';
            ext.setAttribute('role', 'button');
            ext.textContent = '外部播放';
            ext.setAttribute('data-ios-act', 'open-in-player');
            ext.setAttribute('data-dl-path', ep.path);
            ext.setAttribute('aria-label', '用其他播放器打开 ' + (ep.label || ('第' + ep.key + '集')));
            body2.appendChild(ext);
          }
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

  function handleAppClick(target, event) {
    if (hit(target, 'iosSettingsClose') || (hit(target, 'iosSettingsSheet') && !hit(target, 'iosSettingsCard'))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeSettingsSheet();
      return true;
    }
    var deleteButton = target.closest('[data-dl-delete]');
    if (deleteButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      deleteRowAt(deleteButton);
      return true;
    }
    var act = actionOf(target);
    if (!act) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (act === 'download-episode') startEpisodeDownload(dlRowKeyOf(target));
    if (act === 'open-mine') openMinePage();
    if (act === 'dl-back') closeDownloadPage();
    if (act === 'mine-back') {
      var mine = document.getElementById('iosMinePage');
      closeMinePage();
      if (mine.__iosReturnToDownloads) openDownloadPage();
    }
    if (act === 'mine-edit') announce('左滑任意一集即可删除');
    if (act === 'play-local') {
      var entry = target.closest('[data-dl-path]');
      if (entry) postNative({ action: 'playLocal', path: entry.getAttribute('data-dl-path') });
    }
    if (act === 'open-in-player') {
      var external = target.closest('[data-dl-path]');
      if (external) postNative({ action: 'openInOtherPlayer', path: external.getAttribute('data-dl-path') });
    }
    return true;
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
  function onWindow(name, handler) {
    if (window && typeof window.addEventListener === 'function') window.addEventListener(name, handler);
  }
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
}());
