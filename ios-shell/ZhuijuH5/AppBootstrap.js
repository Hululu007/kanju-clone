// 移植自 android/app/src/phone/assets/app-bootstrap.js（Android 手机版同一份外壳脚本）。
// 作用有两个：
//   1. 把发往 kanju-api.kenzhao123.workers.dev 的 /api 请求改写成本源请求，
//      这样 App 内的登录态、Cookie 和浏览器里完全一致；
//   2. 横屏播放时接管 #player 的布局（网页侧只有一份 CSS，外壳补上铺满屏幕的那部分）。
// iOS 不需要 hls.js（系统原生支持 HLS），所以这份脚本里没有任何播放器补丁。
// 由 WebViewController 以 WKUserScript / atDocumentStart 注入，必须早于页面首个 fetch。
(function () {
  'use strict';
  if (window.location.origin !== 'https://zhuiju.dpdns.org' || window.top !== window) return;
  if (window.__zhuijuAppReady) return;
  window.__zhuijuAppReady = true;

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

  var originalFetch = window.fetch;
  window.fetch = function (input, options) {
    var address = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    var url = new URL(address, window.location.href);
    var isApi = url.pathname === '/api' || url.pathname.indexOf('/api/') === 0;
    if (isApi && url.origin === 'https://kanju-api.kenzhao123.workers.dev') {
      var target = window.location.origin + url.pathname + url.search;
      var nextOptions = Object.assign({}, options || {}, { credentials: 'same-origin' });
      if (input instanceof Request) {
        return originalFetch.call(window, new Request(target, input), nextOptions);
      }
      return originalFetch.call(window, target, nextOptions);
    }
    return originalFetch.call(window, input, options);
  };

  if (typeof document === 'undefined' || typeof window.matchMedia !== 'function') return;
  var landscape = window.matchMedia('(orientation: landscape)');
  var activeVideo = null;
  var screenStyle = document.createElement('style');
  screenStyle.textContent = 'html[data-app-landscape] #player{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;margin:0!important;border-radius:0!important;z-index:10000!important;background:#000!important}' +
    'html[data-app-landscape] #player video{width:100%!important;height:100%!important;max-height:none!important;aspect-ratio:auto!important;object-fit:contain}' +
    'html[data-app-landscape]{overflow:hidden!important}' +
    'html[data-app-landscape] #playTools{position:fixed!important;top:8px!important;right:12px!important;z-index:10001!important;background:#10181cdd;padding:6px;border-radius:8px}' +
    'html[data-app-landscape] #playTools .dm-input{display:none!important}' +
    'html[data-app-landscape] #lineBar,html[data-app-landscape] #settingsPanel{position:fixed!important;top:68px!important;right:12px!important;z-index:10002!important;max-height:65vh;overflow:auto;background:#10181c;padding:12px}' +
    'html[data-app-landscape] #lineBar[hidden],html[data-app-landscape] #settingsPanel[hidden]{display:none!important}';
  document.head.appendChild(screenStyle);
  function syncLayout() {
    var expanded = landscape.matches && activeVideo && !activeVideo.ended && !activeVideo.error && activeVideo.isConnected;
    if (expanded) document.documentElement.setAttribute('data-app-landscape', '');
    else document.documentElement.removeAttribute('data-app-landscape');
  }
  document.addEventListener('play', function (event) {
    if (event.target.tagName === 'VIDEO' && event.target.closest('#player')) {
      activeVideo = event.target;
      syncLayout();
    }
  }, true);
  ['ended', 'error', 'emptied', 'loadedmetadata'].forEach(function (name) {
    document.addEventListener(name, function (event) { if (event.target === activeVideo) syncLayout(); }, true);
  });
  if (landscape.addEventListener) landscape.addEventListener('change', syncLayout);
  else landscape.addListener(syncLayout);
  window.addEventListener('resize', syncLayout);
}());
