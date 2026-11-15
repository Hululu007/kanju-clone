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
    style.textContent = '@media(orientation:landscape){html[data-ios-playing] #player{position:fixed!important;inset:0!important;width:100%!important;height:100%!important;z-index:10000!important;border-radius:0!important;margin:0!important;background:#000}html[data-ios-playing] #player video{width:100%!important;height:100%!important;aspect-ratio:auto!important;object-fit:contain}html[data-ios-playing]{overflow:hidden!important}html[data-ios-playing] #playTools{position:fixed!important;top:8px!important;right:12px!important;z-index:10001!important;background:#10181cee;padding:6px}html[data-ios-playing] #playTools .dm-input{display:none!important}html[data-ios-playing] #lineBar,html[data-ios-playing] #settingsPanel{position:fixed!important;top:64px!important;right:12px!important;z-index:10002!important;max-height:65vh!important;overflow:auto;background:#10181c;padding:12px}html[data-ios-playing] #lineBar[hidden],html[data-ios-playing] #settingsPanel[hidden]{display:none!important}}';
    document.head.appendChild(style);
  }
  document.addEventListener('play', function (event) {
    if (event.target.id === 'video') document.documentElement.setAttribute('data-ios-playing', '');
  }, true);
  ['ended', 'emptied', 'error'].forEach(function (name) {
    document.addEventListener(name, function (event) {
      if (event.target.id === 'video') document.documentElement.removeAttribute('data-ios-playing');
    }, true);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', prepareLayout, { once: true });
  else prepareLayout();
}());
