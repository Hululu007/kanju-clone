(function () {
  'use strict';
  if (window.top !== window || window.location.origin !== 'https://zhuiju.dpdns.org' || !window.Hls) return;
  if (!document.createElement('video').canPlayType('application/vnd.apple.mpegurl')) return;
  var OriginalHls = window.Hls;
  function NativeHls() {
    this.video = null;
    this.url = '';
    this.handlers = {};
  }
  Object.getOwnPropertyNames(OriginalHls).forEach(function (key) {
    if (key === 'prototype' || key === 'length' || key === 'name') return;
    try { Object.defineProperty(NativeHls, key, Object.getOwnPropertyDescriptor(OriginalHls, key)); } catch (error) {}
  });
  NativeHls.isSupported = function () { return true; };
  NativeHls.prototype.on = function (name, callback) { (this.handlers[name] || (this.handlers[name] = [])).push(callback); };
  NativeHls.prototype.loadSource = function (url) { this.url = url; };
  NativeHls.prototype.attachMedia = function (video) {
    this.video = video;
    video.src = this.url;
    video.load();
  };
  NativeHls.prototype.destroy = function () {
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    }
    this.video = null;
    this.handlers = {};
  };
  window.Hls = NativeHls;
}());
