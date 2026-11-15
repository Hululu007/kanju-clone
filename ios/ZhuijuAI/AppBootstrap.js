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

  try {
    localStorage.setItem('kj-proxy', window.location.origin);
  } catch (error) { /* 隐私模式或存储已满时保持站点默认行为 */ }

  var originalFetch = window.fetch;
  window.fetch = function (input, options) {
    var address = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    try {
      var url = new URL(address, window.location.href);
      var isApi = url.pathname === '/api' || url.pathname.indexOf('/api/') === 0;
      if (isApi && url.origin === 'https://kanju-api.kenzhao123.workers.dev') {
        var target = window.location.origin + url.pathname + url.search;
        var next = Object.assign({}, options || {}, { credentials: 'same-origin' });
        if (input instanceof Request) {
          return originalFetch.call(window, new Request(target, input), next);
        }
        return originalFetch.call(window, target, next);
      }
    } catch (error) { /* 非标准请求交给原始 fetch 处理 */ }
    return originalFetch.call(window, input, options);
  };

  var speeds = [1, 1.5, 2, 2.5, 3];
  function savedSpeed() {
    var value = Number(localStorage.getItem('kj-speed') || 1);
    return speeds.indexOf(value) >= 0 ? value : 1;
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
}());
