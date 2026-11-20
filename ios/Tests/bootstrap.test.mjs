import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { withDOM } from './fixture-dom.mjs';

const source = await readFile(new URL('../ZhuijuAI/AppBootstrap.js', import.meta.url), 'utf8');
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function node(tag = 'div') {
  const element = {
    tagName: String(tag).toUpperCase(),
    id: '',
    children: [],
    parentNode: null,
    textContent: '',
    value: '',
    /* 真实 DOM 里 style.display 默认是空串，不是 undefined */
    style: { display: '' },
    dataset: {},
    /* 真实 DOM 的 appendChild 会把节点从原来的父节点上摘下来（移动而不是复制）：
       注入层靠这个把进度块在两个面板之间搬来搬去，夹具必须照做。 */
    appendChild(child) {
      if (child.parentNode && child.parentNode.children) {
        const siblings = child.parentNode.children;
        const at = siblings.indexOf(child);
        if (at >= 0) siblings.splice(at, 1);
      }
      child.parentNode = element;
      element.children.push(child);
      return child;
    },
    insertBefore(child, reference) {
      const index = element.children.indexOf(reference);
      child.parentNode = element;
      element.children.splice(index < 0 ? element.children.length : index, 0, child);
      return child;
    },
    setAttribute(name, value) {
      if (name === 'hidden') element.hidden = true;
      else if (name === 'class') element.className = value;
      else if (name.startsWith('data-')) element.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      else element[name] = value;
    },
    getAttribute(name) {
      if (name.startsWith('data-')) return element.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())];
      return element[name];
    },
    removeAttribute(name) { if (name === 'hidden') element.hidden = false; else delete element[name]; },
    get nextSibling() {
      const siblings = element.parentNode ? element.parentNode.children : [];
      const index = siblings.indexOf(element);
      return index >= 0 ? siblings[index + 1] : undefined;
    },
    get firstChild() { return element.children.length ? element.children[0] : null; },
    removeChild(child) {
      const at = element.children.indexOf(child);
      if (at >= 0) element.children.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    hasAttribute(name) { return name === 'hidden' ? !!element.hidden : name in element; },
    closest(selector) {
      const matches = (candidate, part) => {
        if (part[0] === '#') return candidate.id === part.slice(1);
        if (part[0] === '.') return String(candidate.className || '').split(/\s+/).includes(part.slice(1));
        const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
        if (!attribute) return candidate.tagName === part.toUpperCase();
        const value = candidate.getAttribute(attribute[1]);
        return value !== undefined && value !== null && (attribute[2] === undefined || value === attribute[2]);
      };
      let candidate = element;
      while (candidate) {
        if (String(selector).split(',').some((part) => matches(candidate, part.trim()))) return candidate;
        candidate = candidate.parentNode;
      }
      return null;
    },
    querySelector(selector) {
      const want = String(selector).replace(/^\./, '');
      const walk = (current) => {
        for (const child of current.children || []) {
          if (String(child.className || '').split(' ').includes(want)) return child;
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(element);
    },
    querySelectorAll(selector) {
      const name = String(selector).replace(/^\./, '');
      return element.children.filter((child) => String(child.className || '').split(' ').includes(name));
    },
  };
  return withDOM(element, node);
}

/* 夹具默认把「默认用第三方播放器」关掉（seed 成 '0'）：按钮/菜单类用例关心的是菜单本身，
   每次都先点两下很啰嗦。新用例要验「默认就是第三方播放器」时传 externalPlayerDefault: true，
   此时不写这条偏好，和真机上第一次安装的默认值一致。 */
function fixture({ origin = 'https://zhuiju.dpdns.org', storageThrows = false, landscape = false, keyword = '', search = '?id=fixture', episodes = [], playRejects = false, maxRate = 0, bridge = true, signedIn = false, noSelectedEpisode = false, homePage = false, externalPlayerDefault = false, newDownloadUI = false, noElementFullscreen = false, seed = {} } = {}) {
  const shared = [];
  const listeners = {};
  const replies = [];
  const calls = [];
  const redirects = [];
  const messages = [];
  const attributes = {};
  const selected = { dataset: { ep: '18' }, textContent: '第19集' };
  let videoRate = 1;
  const video = { id: 'video', tagName: 'VIDEO', style: {}, readyState: 2, currentSrc: 'https://media.example/19.mp4',
    controls: true, paused: true, duration: 120, currentTime: 0, videoWidth: 1920, videoHeight: 1080, removed: [],
    attributes: {},
    setAttribute(name, value) { video.attributes[name] = String(value); },
    getAttribute(name) { return video.attributes[name]; },
    load() {}, querySelectorAll() { return []; },
    removeAttribute(name) { video.removed.push(name); delete video.attributes[name]; },
    pause() { video.paused = true; },
    play() { video.started = (video.started || 0) + 1; video.paused = false; return Promise.resolve(); },
    webkitEnterFullscreen() { video.nativeFullscreen = (video.nativeFullscreen || 0) + 1; },
    webkitExitFullscreen() { video.nativeExit = (video.nativeExit || 0) + 1; } };
  /* 系统可能把倍速夹回去：maxRate 模拟 iOS 只允许到 2× */
  Object.defineProperty(video, 'playbackRate', {
    get() { return videoRate; },
    set(value) { videoRate = maxRate ? Math.min(Number(value) || 1, maxRate) : Number(value) || 1; },
  });
  const player = node('section');
  player.id = 'player';
  player.style.aspectRatio = '16 / 9';
  player.getBoundingClientRect = () => ({ width: 390, height: 219 });
  player.appendChild(video);
  const head = node('head');
  const toolbar = node('div');
  toolbar.id = 'playTools';
  /* 站点的工具条顺序：显示设置 / 线路 / 弹幕 / 画中画 / 下一集。弹幕按钮要让位给下载。 */
  const dmButton = node('button');
  dmButton.id = 'dmBtn';
  dmButton.className = 'pp-tool on';
  dmButton.textContent = '弹幕 开';
  toolbar.appendChild(dmButton);
  const pipButton = node('button');
  pipButton.id = 'pipBtn';
  toolbar.appendChild(pipButton);
  /* 0.1.1 的工具条是 显示设置/线路/弹幕/画中画/下一集，刚好占满一行 */
  const nextButton = node('button');
  nextButton.id = 'nextEpBtn';
  toolbar.appendChild(nextButton);
  /* 首页日期条（本周追剧）：7 天 68px + 8px 间距，可视宽 416 → 最大可滚 120px；第 4 天是今天 */
  const days = node('div');
  days.id = 'days';
  days.dataset = {};
  /* 浏览器里写 scrollLeft 会异步派发 scroll：夹具照这个来，
     否则分不清「用户自己拨的」和「重建把它归零」 */
  let stripLeft = 0;
  /* 浏览器里 scroll 事件不在赋值当下派发，而是等下一次渲染机会：
     这个时序决定了「重建把位置归零」和「观察器把位置放回去」谁先谁后，
     夹具必须照实模拟，否则测不出真实行为。 */
  Object.defineProperty(days, 'scrollLeft', {
    get() { return stripLeft; },
    set(value) {
      stripLeft = Number(value) || 0;
      days.writes = (days.writes || 0) + 1;
      setTimeout(() => {
        for (const listener of listeners['scroll'] || []) listener({ target: days });
      }, 0);
    },
  });
  days.writes = 0;
  days.scrollWidth = 536;
  days.clientWidth = 416;
  days.getBoundingClientRect = () => ({ left: 0, width: 416 });
  days.contains = (child) => days.children.includes(child);
  const dayButtons = [0, 1, 2, 3, 4, 5, 6].map((index) => {
    const button = node('button');
    button.className = index === 3 ? 'day on' : 'day';
    button.dataset = {};
    button.getBoundingClientRect = () => ({ left: index * 76, width: 68 });
    days.appendChild(button);
    return button;
  });
  days.querySelector = (selector) => (selector === '.day.on' ? dayButtons[3] : null);
  days.querySelectorAll = (selector) => (selector === '.day' ? dayButtons : []);
  const searchInput = node('textarea');
  searchInput.id = 'q';
  searchInput.value = keyword;
  /* 播放页详情头：片库要拿它当剧名和封面（比文件名靠谱，也不用猜） */
  const detailTitle = node('h1');
  detailTitle.textContent = '测试剧';
  const posterImage = node('img');
  posterImage.src = 'https://zhuiju.dpdns.org/posters/fixture.jpg';
  const hint = node('p');
  hint.id = 'playHint';
  hint.textContent = '';
  const epMore = node('button');
  epMore.id = 'epMore';
  const settingsPanel = node('div');
  settingsPanel.id = 'settingsPanel';
  settingsPanel.hidden = false;
  /* 播放页顶栏：pageHead({title: show.title, back:'/'}) —— 真机上压在画面上的就是它。 */
  const pageHead = node('header');
  pageHead.className = 'page-head';
  pageHead.hidden = false;
  const phTitle = node('h1');
  phTitle.className = 'ph-title';
  phTitle.textContent = '测试剧';
  pageHead.appendChild(phTitle);
  const tabbar = node('nav'); tabbar.className = 'tabbar';
  const lineBar = node('div');
  lineBar.id = 'lineBar';
  lineBar.hidden = false;
  const epButtons = episodes.map((idx) => {
    const button = node('button');
    button.className = idx === 0 ? 'ep on' : 'ep';
    button.dataset = { ep: String(idx) };
    button.textContent = '第' + (Number(idx) + 1) + '集';
    button.classList = {
      toggle(name, force) {
        const on = button.className.split(' ').filter(Boolean).includes(name);
        const next = force === undefined ? !on : !!force;
        const rest = button.className.split(' ').filter((c) => c && c !== name);
        button.className = (next ? [...rest, name] : rest).join(' ');
      },
    };
    return button;
  });
  const epGrid = node('div');
  epGrid.id = 'epGrid';
  for (const episode of epButtons) epGrid.appendChild(episode);
  const mediaProto = {
    play() {
      mediaProto.attempts = (mediaProto.attempts || 0) + 1;
      return playRejects ? Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) : Promise.resolve();
    },
  };
  /* 站点的登录入口：注入层不自己做账号 UI，只负责把站点弹窗点开 */
  const loginTrigger = node('button');
  loginTrigger.opens = 0;
  loginTrigger.click = () => { loginTrigger.opens += 1; };
  /* 站点侧栏的账号卡片：模板把「成长」那张写死成游客账号，登录后用户名在对上那一行 */
  const sbName = node('p');
  sbName.className = 'sb-name';
  sbName.textContent = '游客账号';
  const sbSub = node('p');
  sbSub.className = 'sb-sub';
  sbSub.textContent = '本设备使用中 · 游客账号';
  const acctName = node('p');
  acctName.className = 'acct-name';
  acctName.textContent = '游客账号';
  /* 选集区上方的标签行：选集 / 投屏 / 讨论 / 反馈 */
  const tabRow = node('div');
  tabRow.className = 'pp-tabs';
  tabRow.contains = (child) => tabRow.children.includes(child);
  const clicked = [];
  const tabButtons = ['eps', 'cast', 'talk', 'fb'].map((key, index) => {
    const button = node('button');
    button.className = index === 0 ? 'pp-tab on' : 'pp-tab';
    button.dataset = { tab: key };
    button.click = () => {
      clicked.push(key);
      for (const other of tabButtons) other.className = other.dataset.tab === key ? 'pp-tab on' : 'pp-tab';
    };
    tabRow.appendChild(button);
    return button;
  });
  tabRow.querySelectorAll = (selector) => (selector === '.pp-tab' ? tabButtons : []);
  const body = node('body');
  /* 站点播放页自己的「下载」按钮：新注入层不再挂原生下载按钮，只接这个入口。 */
  const siteDownload = node('button');
  siteDownload.setAttribute('data-pw-act', 'dl');
  siteDownload.setAttribute('aria-label', '下载');
  siteDownload.textContent = '下载';
  body.appendChild(siteDownload);
  /* 顶栏设置入口：首页用它打开设置面板（站点自己只会弹「即将上线」） */
  const settingsTrigger = node('button');
  settingsTrigger.dataset = { action: 'settings' };
  const idIndex = new Map();
  body.appendChild = (child) => {
    if (child.parentNode && child.parentNode.children) {
      const previous = child.parentNode.children;
      const index = previous.indexOf(child);
      if (index >= 0) previous.splice(index, 1);
    }
    child.parentNode = body;
    body.children.push(child);
    if (child.id) idIndex.set(child.id, child);
    return child;
  };
  body.appendChild(epGrid);
  const episodeHead = node('div');
  episodeHead.className = 'ep-head';
  const episodeCast = node('button');
  episodeCast.dataset = { action: 'cast' };
  episodeCast.textContent = '投屏';
  episodeHead.appendChild(episodeCast);
  body.appendChild(episodeHead);
  const document = { readyState: 'loading', visibilityState: 'visible', head, body,
    title: '测试剧 - 看剧AI',
    addEventListener(name, listener, capture) {
      (listeners[name] ||= []).push(name === 'click' ? { listener, capture: capture === true } : listener);
    },
    removeEventListener(name, listener) {
      const list = listeners[name] || [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    },
    getElementById(id) {
      if (idIndex.has(id)) return idIndex.get(id);
      if (id === 'video') return homePage ? null : video;
      if (id === 'playTools') return homePage ? null : toolbar;
      if (id === 'q') return searchInput;
      if (id === 'playHint') return hint;
      if (id === 'epMore') return epMore;
      if (id === 'settingsPanel') return homePage ? null : settingsPanel;
      if (id === 'lineBar') return lineBar;
      if (id === 'dmBtn') return dmButton;
      if (id === 'epGrid') return epGrid;
      if (id === 'days') return days;
      if (id === 'player') return homePage ? null : player;
      if (id === 'ppCtrl') return player.children.find((child) => child.id === 'ppCtrl') || null;
      const walk = (element) => {
        for (const child of element.children || []) {
          if (child.id === id) return child;
          if (child.children && child.children.length) {
            const found = walk(child);
            if (found) return found;
          }
        }
        return null;
      };
      return walk(toolbar) || walk(player) || walk(settingsPanel) || walk(body);
    },
    /* 站点的标准全屏 API 路径：document.fullscreenElement 为真时页面进入原生全屏 */
    fullscreenElement: null,
    dispatched: [],
    dispatchEvent(event) {
      document.dispatchLog = document.dispatchLog || [];
      document.dispatchLog.push(event && event.type);
      for (const listener of listeners[event && event.type] || []) listener(event);
      return true;
    },
    createElement(tag) { return node(tag); },
    querySelector(selector) {
      const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
      if (selector === '[data-action="login"]') return loginTrigger;
      if (selector === '[data-pw-act="dl"]') return siteDownload;
      if (attribute) return document.querySelectorAll(selector)[0] || null;
      if (selector === '.ep.on') return noSelectedEpisode ? null : selected;
      if (selector === '.detail-info h1') return homePage ? null : detailTitle;
      if (selector === '.detail-poster img') return homePage ? null : posterImage;
      if (selector === '.pp-tabs') return tabRow;
      if (selector === '[data-action="settings"]') return settingsTrigger;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '#epGrid .ep') return epButtons;
      if (selector === '.detail-tags span,.detail-info .tag') return [];
      const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
      if (attribute) {
        const roots = [settingsTrigger, loginTrigger, ...body.children, ...toolbar.children, ...player.children];
        const descendants = (parent) => (parent.children || []).flatMap((child) => [child, ...descendants(child)]);
        return [...roots, ...roots.flatMap(descendants)].filter((element) => {
          if (typeof element.getAttribute !== 'function') return false;
          const value = element.getAttribute(attribute[1]);
          return value !== undefined && value !== null && (attribute[2] === undefined || value === attribute[2]);
        });
      }
      if (selector === '.ep') return epButtons;
      if (selector === '#epGrid .ep') return epButtons;
      if (selector === '.detail-tags span,.detail-info .tag') return [];
      if (selector === '[data-action="login"]') return [loginTrigger];
      if (selector === '[data-pw-act="dl"]') return [siteDownload];
      if (selector === 'button,a,[role="button"]') return [loginTrigger, settingsTrigger, ...toolbar.children, ...player.children];
      if (selector === '.detail-info h1') return homePage ? [] : [detailTitle];
      if (selector === '.detail-poster img') return homePage ? [] : [posterImage];
      if (selector === '.pp-tabs') return [tabRow];
      if (selector === '.ep-head [data-action="cast"]') return [episodeCast];
      if (selector === '.pp-tab') return tabButtons;
      if (selector === '.sb-name') return [sbName];
      if (selector === '.sb-sub') return [sbSub];
      if (selector === '.acct-name') return [acctName];
      if (selector === '#playTools') return [toolbar];
      if (selector === '#settingsPanel') return [settingsPanel];
      if (selector === '.tabbar') return [tabbar];
      if (selector === '.page-head') return [pageHead];
      if (selector === '.topbar') return [];
      if (selector === '#lineBar') return [lineBar];
      if (selector === '#pipBtn') return [pipButton];
      if (selector === '#nextEpBtn') return [nextButton];
      if (selector === '#player .p-label') return [];
      if (selector === '.pp-toolbar' || selector === '.dm-input' || selector === '#dmInputWrap') return [];
      if (selector === '.pp-hint' || selector === '#playHint') return [hint];
      if (selector === '[data-action="settings"]') return [settingsTrigger];
      if (selector === '.pp-tab') return tabButtons;
      if (selector === '.sb-name') return [sbName];
      if (selector === '.sb-sub') return [sbSub];
      if (selector === '.acct-name') return [acctName];
      if (selector === '#playTools') return [toolbar];
      if (selector === '#settingsPanel') return [settingsPanel];
      if (selector === '.tabbar') return [tabbar];
      if (selector === '.page-head') return [pageHead];
      if (selector === '.topbar') return [];
      if (selector === '#lineBar') return [lineBar];
      if (selector === '.tabbar') return [tabbar];
      if (selector === '#pipBtn') return [pipButton];
      if (selector === '#nextEpBtn') return [nextButton];
      if (selector === '#player .p-label') return [];
      if (selector === '.pp-toolbar' || selector === '.dm-input' || selector === '#dmInputWrap') return [];
      if (selector === '.pp-hint' || selector === '#playHint') return [hint];
      if (selector === '[data-action="settings"]') return [settingsTrigger];
      if (selector === 'button,a,[role="button"]') return [loginTrigger, settingsTrigger, ...toolbar.children, ...player.children];
      return [];
    },
    documentElement: {
      style: { setProperty() {} },
      getBoundingClientRect() { return { width: window.innerWidth || 390, height: window.innerHeight || 844 }; },
      setAttribute(name) { attributes[name] = true; },
      removeAttribute(name) { delete attributes[name]; },
      hasAttribute(name) { return !!attributes[name]; },
    } };
  let isLandscape = landscape;
  /* 站点的全屏按钮走标准 Fullscreen API：给 Element.prototype 一份可观察的原实现，
     验证注入层把它改道到原生视频全屏，而不是真去进会黑屏的容器全屏。 */
  let elementFullscreenCalls = 0;
  /* noElementFullscreen 模拟 iOS 15.0–15.3 的 WKWebView：连 Element 全屏 API 都没有。 */
  const elementProto = noElementFullscreen ? {} : {
    requestFullscreen() { elementFullscreenCalls += 1; return Promise.resolve(); },
    webkitRequestFullscreen() { elementFullscreenCalls += 1; return Promise.resolve(); },
  };
  const window = { location: { origin, protocol: 'https:', hostname: new URL(origin).hostname,
    href: origin + '/player/?id=fixture', pathname: '/player/', search, replace(value) { redirects.push(value); } },
    innerWidth: landscape ? 844 : 390,
    innerHeight: landscape ? 390 : 844,
    matchMedia(query) { return { matches: isLandscape && /landscape/.test(query) }; },
    addEventListener(name, listener, capture) {
      (listeners[name] ||= []).push(name === 'click' ? { listener, capture: capture === true } : listener);
    },
    webkit: bridge ? { messageHandlers: { iosPlayer: { postMessage(body) { messages.push(body); } } } } : {},
    HTMLMediaElement: { prototype: mediaProto },
    Event: class { constructor(type) { this.type = type; } },
    Element: { prototype: elementProto },
    async fetch(input, options) {
      calls.push({ input, options });
      return await (replies.shift() || new Response('{}', { headers: { 'content-type': 'application/json' } }));
    } };
  window.top = window;
  const observers = [];
  class MockMutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() { this.observing = true; }
    disconnect() { this.observing = false; }
  }
  const navigator = {
    share(payload) { shared.push(payload); return Promise.resolve(); },
    clipboard: { writeText(value) { shared.push({ copied: value }); return Promise.resolve(); } },
  };
  const storage = { 'kj-speed': '2', ...seed };
  /* 夹具默认走「外放=菜单」这条老路径，见文件头的说明 */
  if (!externalPlayerDefault && !Object.prototype.hasOwnProperty.call(storage, 'kj-ios-ext-player')) {
    storage['kj-ios-ext-player'] = '0';
  }
  if (signedIn) {
    storage['kj-auth-token'] = 'test-token';
    storage['kj-auth-user'] = JSON.stringify({ id: 7, username: 'kenzhao11' });
  }
  const context = vm.createContext({ window, document, navigator, URL, URLSearchParams, Request, Response, AbortSignal, AbortController, DOMException,
    MutationObserver: MockMutationObserver,
    setTimeout, clearTimeout, localStorage: {
      getItem(key) { if (storageThrows) throw Error('denied'); return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
      setItem(key, value) { if (storageThrows) throw Error('denied'); storage[key] = String(value); },
      removeItem(key) { if (storageThrows) throw Error('denied'); delete storage[key]; },
    } });
  vm.runInContext(source, context);
  return { window, document, replies, calls, redirects, selected, video, messages, attributes, head, toolbar, searchInput, shared, player,
    hint, epButtons, epGrid, epMore, mediaProto, days, dayButtons, observers, loginTrigger, storage,
    elementProto, get elementFullscreenCalls() { return elementFullscreenCalls; },
    settingsPanel, lineBar, tabRow, tabButtons, clicked, sbName, sbSub, acctName, tabbar, settingsTrigger,
    pageHead, dmButton, phTitle, siteDownload,
    /* 下载进度控件由注入层自己建（0.1.9 之后不再依赖站点预设的节点），
       所以按 id 现取，不让夹具自己造一份同名节点。 */
    get downloadLabel() { return document.getElementById('iosDownloadLabel'); },
    get downloadFill() { return document.getElementById('iosDownloadFill'); },
    get downloadOpen() { return document.getElementById('iosOpenDownloaded'); },
    /* 转屏：真机上 matchMedia 和 innerWidth 会同时跟着变 */
    setLandscape(next) {
      isLandscape = !!next;
      window.innerWidth = isLandscape ? 844 : 390;
      window.innerHeight = isLandscape ? 390 : 844;
    },
    sheet() { return document.getElementById('iosSettingsSheet'); },
    /* 悬浮提示：注入层只写 #iosToast，不再改写文档流里的 #playHint */
    toastText() {
      const box = document.getElementById('iosToast');
      return box && box.textContent ? box.textContent : '';
    },
    touch(type, target, x, y) {
      const point = { clientX: x, clientY: y };
      const event = { target, touches: type === 'touchend' ? [] : [point], changedTouches: [point],
        preventDefault() { event.defaultPrevented = true; } };
      for (const listener of listeners[type] || []) listener(event);
      return event;
    },
    ready() { for (const listener of listeners['DOMContentLoaded'] || []) listener({}); },
    click(target) {
      let stopped = false;
      const event = { target, preventDefault() {}, stopImmediatePropagation() { stopped = true; } };
      const clickListeners = listeners['click'] || [];
      for (const entry of [...clickListeners].sort((left, right) => Number(right.capture) - Number(left.capture))) {
        (typeof entry === 'function' ? entry : entry.listener)(event);
        if (stopped) break;
      }
    },
    emit(name, event) { for (const listener of listeners[name] || []) listener(event); } };
}
const valid = { showId: 'fixture', idx: 18, episodeNumber: 19, verified: true, kind: 'mp4', url: 'https://media.example/19.mp4' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const play = 'https://kanju-api.kenzhao123.workers.dev/api/play?show=fixture&ep=18&line=official';

test('login and authenticated Request preserve body, token and same-origin cookies', async () => {
  const state = fixture();
  await state.window.fetch(new Request('https://kanju-api.kenzhao123.workers.dev/api/user/progress', {
    method: 'PUT', headers: { Authorization: 'Bearer test-token' }, body: '{"idx":18}' }));
  const { input, options } = state.calls[0];
  assert.equal(input.url, 'https://zhuiju.dpdns.org/api/user/progress');
  assert.equal(input.method, 'PUT');
  assert.equal(input.headers.get('Authorization'), 'Bearer test-token');
  assert.equal(await input.text(), '{"idx":18}');
  assert.equal(options.credentials, 'same-origin');
});
test('site-gate expiration redirects without passing a 401 to account-cache cleanup', async () => {
  const state = fixture(); state.replies.push(json({ error: 'unauthorized' }, 401));
  await assert.rejects(state.window.fetch('https://zhuiju.dpdns.org/api/auth/me'));
  assert.match(state.redirects[0], /^\/__login\?next=/);
});
test('account expiration remains an account 401', async () => {
  const state = fixture(); state.replies.push(json({ error: 'session_expired' }, 401));
  assert.equal((await state.window.fetch('https://zhuiju.dpdns.org/api/auth/me')).status, 401);
  assert.equal(state.redirects.length, 0);
});
test('reject mismatched title, index, episode, unverified result, credentials and HTTP', async () => {
  for (const patch of [{ showId: 'other' }, { idx: 1 }, { episodeNumber: 2 }, { verified: false }, { kind: 'html' },
    { url: 'http://media.example/19.mp4' }, { url: 'https://user:password@media.example/19.mp4' }]) {
    const state = fixture(); state.replies.push(json({ ...valid, ...patch }));
    await assert.rejects(state.window.fetch(play));
  }
});
test('late first response cannot replace a newer request', async () => {
  const state = fixture(); let release;
  state.replies.push(new Promise(resolve => { release = resolve; }));
  const first = state.window.fetch(play).then(() => false, () => true);
  state.replies.push(json(valid));
  await state.window.fetch(play);
  release(json(valid));
  assert.equal(await first, true);
});
test('caller cancellation is preserved', async () => {
  const state = fixture(); const controller = new AbortController(); controller.abort();
  state.replies.push(json(valid));
  await assert.rejects(state.window.fetch(play, { signal: controller.signal }));
});
test('media-ready starts once at saved speed and hidden app does not autoplay', async () => {
  const state = fixture(); state.replies.push(json(valid)); await state.window.fetch(play);
  state.emit('canplay', { target: state.video }); state.emit('canplay', { target: state.video });
  assert.equal(state.video.started, 1); assert.equal(state.video.playbackRate, 2);
  state.replies.push(json(valid)); await state.window.fetch(play);
  state.document.visibilityState = 'hidden'; state.emit('visibilitychange', {});
  state.emit('canplay', { target: state.video }); assert.equal(state.video.started, 1);
});
test('restricted storage does not break ready handler', async () => {
  const state = fixture({ storageThrows: true }); state.emit('play', { target: state.video });
  assert.equal(state.video.playbackRate, 1);
});
test('external origin is not injected', () => { assert.equal(fixture({ origin: 'https://outside.example' }).window.__zhuijuIOSReady, undefined); });
test('media URL is not rewritten', async () => {
  const state = fixture(); await state.window.fetch('https://media.example/19.mp4');
  assert.equal(state.calls[0].input, 'https://media.example/19.mp4');
});

test('layout fallback keeps the light tabbar and category cards without touching site tools', () => {
  const state = fixture(); state.ready();
  const style = state.head.children.find((child) => child.id === 'iosShellStyle');
  assert.ok(style, 'injected style is missing');
  assert.doesNotMatch(style.textContent, /\.topbar \.tb-right/,
    '站点顶栏右侧按钮（搜索 / 历史 / 菜单）不能再被藏掉');
  assert.doesNotMatch(style.textContent, /\.page-head \[data-action="settings"\]/,
    '其他页面原有的菜单设置入口不能被误隐藏');
  assert.match(style.textContent, /html\[data-theme='light'\] \.tabbar \.tab\{color:rgba\(15,20,24/);
  assert.match(style.textContent, /grid-auto-columns:168px/);
  assert.doesNotMatch(style.textContent, /data-ios-immersive/,
    '沉浸态全屏 CSS 必须整段删掉，画面尺寸交给网站自己的播放器');
  assert.doesNotMatch(style.textContent, /#playTools[^}]*display:none/,
    '站点自己的工具条不能被 CSS 藏掉');
  assert.match(style.textContent, /safe-area-inset-bottom/);
  const cast = state.document.querySelectorAll('.ep-head [data-action="cast"]')[0];
  assert.ok(cast, '夹具里要有站点自己的投屏入口');
  assert.ok(!cast.hidden, '站点的投屏入口不能被注入层藏掉');
  assert.notEqual(cast.getAttribute('aria-hidden'), 'true', '也不能被标成 aria-hidden');
});

test('the injected layer reports site fullscreen state without touching the page', () => {
  const state = fixture({ episodes: [0] }); state.ready();
  const attributesBefore = Object.keys(state.attributes).length;
  state.document.fullscreenElement = state.player;
  state.emit('fullscreenchange', { target: state.document });
  const enter = state.messages.filter((message) => message.action === 'playerFullscreen');
  assert.equal(enter.length, 1, '进入全屏只通知原生一次');
  assert.equal(enter[0].on, true, '进入全屏要让原生切横屏');
  assert.equal(Object.keys(state.attributes).length, attributesBefore,
    '注入层不能在全屏时写 data-ios-immersive 之类的属性');
  assert.equal(state.document.documentElement.hasAttribute('data-ios-immersive'), false);
  /* WebKit 进全屏时 fullscreenchange / webkitfullscreenchange 会各来一次，不能重复通知 */
  state.emit('webkitfullscreenchange', { target: state.document });
  assert.equal(state.messages.filter((message) => message.action === 'playerFullscreen').length, 1);
  state.document.fullscreenElement = null;
  state.emit('fullscreenchange', { target: state.document });
  const events = state.messages.filter((message) => message.action === 'playerFullscreen');
  assert.equal(events.length, 2);
  assert.equal(events[1].on, false, '退出全屏要让原生回竖屏原位');
  const style = state.head.children.find((child) => child.id === 'iosShellStyle');
  assert.doesNotMatch(style.textContent, /:fullscreen/, '注入层不写任何全屏样式');
  assert.doesNotMatch(style.textContent, /data-ios-immersive/, '也不写沉浸态几何样式');
});

test('a native video fullscreen also reports enter and exit exactly once', () => {
  const state = fixture({ episodes: [0] }); state.ready();
  state.emit('webkitbeginfullscreen', { target: state.video });
  state.emit('webkitendfullscreen', { target: state.video });
  const events = state.messages.filter((message) => message.action === 'playerFullscreen');
  assert.deepEqual(events.map((message) => message.on), [true, false],
    'video.webkitEnterFullscreen 这条路也要让原生横屏后再回竖屏');
});

test('a site fullscreen request on the player uses the native video player, not the black element fullscreen', async () => {
  const state = fixture({ episodes: [0] }); state.ready();
  Object.setPrototypeOf(state.player, state.elementProto);
  const entered = state.player.requestFullscreen();
  state.emit('webkitbeginfullscreen', { target: state.video });
  await entered;
  assert.equal(state.video.nativeFullscreen, 1, '容器全屏要改走系统原生视频全屏');
  assert.equal(state.elementFullscreenCalls, 0, '不能再进入会丢画面、退不出的容器元素全屏');

  Object.setPrototypeOf(state.video, state.elementProto);
  const again = state.video.requestFullscreen();
  state.emit('webkitbeginfullscreen', { target: state.video });
  await again;
  assert.equal(state.video.nativeFullscreen, 2, 'video 自己的全屏请求也走原生');

  const other = node('div');
  Object.setPrototypeOf(other, state.elementProto);
  other.requestFullscreen();
  assert.equal(state.elementFullscreenCalls, 1, '不包含视频的元素仍走原来的全屏实现');
  assert.equal(state.video.nativeFullscreen, 2, '无关元素不能误触发视频全屏');
  state.emit('webkitbeginfullscreen', { target: state.video });
  state.emit('webkitendfullscreen', { target: state.video });
  assert.deepEqual(state.document.dispatchLog, ['fullscreenchange', 'webkitfullscreenchange'],
    '原生全屏退出后要补一次退出事件，站点才能收起沉浸态');
});

test('a native video fullscreen only resolves after the system reports it started', async () => {
  const state = fixture({ episodes: [0] }); state.ready();
  Object.setPrototypeOf(state.player, state.elementProto);
  let outcome = 'pending';
  const entered = state.player.requestFullscreen().then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
  assert.equal(outcome, 'pending', '系统还没回事件前不能先报成功');
  state.emit('webkitbeginfullscreen', { target: state.video });
  await entered;
  assert.equal(outcome, 'resolved');
});

test('a native video fullscreen failure rejects and never falls back to the black element fullscreen', async () => {
  const state = fixture({ episodes: [0] }); state.ready();
  Object.setPrototypeOf(state.player, state.elementProto);
  state.video.webkitEnterFullscreen = () => { throw new Error('gesture rejected'); };
  const failed = await state.player.requestFullscreen().then(() => 'resolved', () => 'rejected');
  assert.equal(failed, 'rejected', '调用失败要按 requestFullscreen 的契约拒绝');
  assert.equal(state.elementFullscreenCalls, 0, '失败也不能退回会黑屏的容器元素全屏');

  const silent = fixture({ episodes: [0] }); silent.ready();
  Object.setPrototypeOf(silent.player, silent.elementProto);
  silent.video.webkitEnterFullscreen = () => {};
  const timedOut = await silent.player.requestFullscreen().then(() => 'resolved', () => 'rejected');
  assert.equal(timedOut, 'rejected', '系统一直不回事件时按失败处理，不能假装成功');
});

test('leaving the native player keeps portrait even if the page still reports a fullscreen element', () => {
  const state = fixture({ episodes: [0] }); state.ready();
  state.emit('webkitbeginfullscreen', { target: state.video });
  /* 退出后页面可能残留旧值：补发的事件不能把它当成「又进全屏」再横过去 */
  state.document.fullscreenElement = state.player;
  state.emit('webkitendfullscreen', { target: state.video });
  const events = state.messages.filter((message) => message.action === 'playerFullscreen');
  assert.deepEqual(events.map((message) => message.on), [true, false], '退出只能报一次 false');
  assert.deepEqual(state.document.dispatchLog, ['fullscreenchange', 'webkitfullscreenchange'],
    '站点仍要收到退出事件');
});

test('iOS 15.0-15.3 without the element fullscreen API still reaches the native video player', async () => {
  const state = fixture({ episodes: [0], noElementFullscreen: true });
  state.ready();
  assert.equal(state.document.fullscreenEnabled, true,
    '站点先看 document.fullscreenEnabled 才显示全屏按钮，老系统上也要为真');
  assert.equal(typeof state.elementProto.requestFullscreen, 'function',
    '老系统没有全屏方法时，注入层要补出来，否则站点连按钮都不显示');

  Object.setPrototypeOf(state.player, state.elementProto);
  const entered = state.player.requestFullscreen();
  state.emit('webkitbeginfullscreen', { target: state.video });
  assert.equal(await entered.then(() => 'resolved', () => 'rejected'), 'resolved');
  assert.equal(state.video.nativeFullscreen, 1, '补出来的方法照样改走系统原生视频全屏');

  const other = node('div');
  Object.setPrototypeOf(other, state.elementProto);
  const rejected = await other.requestFullscreen().then(() => 'resolved', () => 'rejected');
  assert.equal(rejected, 'rejected', '没有视频的元素不能假装进了全屏');

  state.emit('webkitbeginfullscreen', { target: state.video });
  await state.document.exitFullscreen();
  assert.equal(state.video.nativeExit, 1, '站点调 document.exitFullscreen 时要能退出系统原生全屏');
});
test('the home top bar carries no app settings gear and settings stay in the menu', () => {
  const state = fixture({ homePage: true }); state.ready();
  const style = state.head.children.find((child) => child.id === 'iosShellStyle');
  assert.match(style.textContent, /\.topbar \[data-action="settings"\]\{display:none!important\}/,
    '站点顶栏自带的齿轮在 App 里要隐藏，恢复 0.1.17 的干净顶栏');
  assert.equal(state.document.getElementById('iosTopBar'), null, '注入层不能再往顶栏塞自己的条');
  assert.equal(state.document.querySelectorAll('[data-ios-act="settings"]').length, 0,
    '注入层不许自己造一个设置齿轮');
  state.click(state.settingsTrigger);
  const sheet = state.sheet();
  assert.ok(sheet, '站点菜单里的设置入口仍然要能打开设置面板');
  assert.equal(sheet.hidden, false);
});

test('tapping the same episode twice reuses the same download id', async () => {
  const state = fixture({ episodes: [0], newDownloadUI: true }); state.ready();
  state.click(state.siteDownload);
  state.replies.push(json({ ...valid, idx: 0, episodeNumber: 1 }));
  state.click(state.document.getElementById('iosDlCell6-0'));
  await settle();
  const first = state.messages.at(-1).items[0].id;
  state.replies.push(json({ ...valid, idx: 0, episodeNumber: 1 }));
  state.click(state.document.getElementById('iosDlCell6-0'));
  await settle();
  const second = state.messages.at(-1).items[0].id;
  assert.match(first, /^dl-/, '入队请求要带 id');
  assert.equal(first, second, '同一集重复点下载必须用同一个 id，续传 / 暂停才接得上');
});

test('both brand logos use the supplied artwork and hide the old svg', () => {
  const state = fixture(); state.ready();
  const css = state.head.children.find((child) => child.id === 'iosShellStyle').textContent;
  /* 图只内联一次：--brand-logo 一条，两处规则都引用它，避免把 11KB 的图塞三遍 */
  assert.match(css, /html\{--brand-logo:url\("data:image\/webp;base64,[^"]+"\)\}/);
  assert.equal((css.match(/data:image\/webp;base64/g) || []).length, 1, 'data URI 只应内联一次');
  assert.match(css, /\.brand \.brand-mark\{[^}]*background-image:var\(--brand-logo\)/);
  assert.match(css, /\.brand \.brand-mark>svg\{display:none\}/);
  assert.match(css, /\.tabbar \.tab\.center \.tab-circle\{[^}]*background-image:var\(--brand-logo\)/);
  assert.match(css, /\.tabbar \.tab\.center \.tab-circle>svg\{display:none\}/);
});

test('search request carries the keyword typed into the search box', async () => {
  const state = fixture({ keyword: '火影' });
  await state.window.fetch('https://kanju-api.kenzhao123.workers.dev/api/list?sort=heat&limit=6&page=1');
  const url = new URL(state.calls[0].input);
  assert.equal(url.origin, 'https://zhuiju.dpdns.org');
  assert.equal(url.pathname, '/api/list');
  assert.equal(url.searchParams.get('q'), '火影');
  assert.equal(url.searchParams.get('page'), '1');
});

test('empty search box adds no keyword and an existing keyword is kept once', async () => {
  const blank = fixture();
  await blank.window.fetch('https://kanju-api.kenzhao123.workers.dev/api/list?sort=heat&limit=6&page=1');
  assert.equal(new URL(blank.calls[0].input).searchParams.get('q'), null);

  const filled = fixture({ keyword: '谷雨' });
  await filled.window.fetch('https://kanju-api.kenzhao123.workers.dev/api/list?sort=heat&limit=6&page=1&q=谷雨');
  const url = new URL(filled.calls[0].input);
  assert.deepEqual(url.searchParams.getAll('q'), ['谷雨']);
});

test('injected styles keep episode cards from squeezing or overflowing', () => {
  const state = fixture(); state.ready();
  const css = state.head.children[0].textContent;
  assert.match(css, /\.ep\{min-height:38px!important;height:auto!important/);
  assert.match(css, /\.ep-grid\{grid-auto-rows:minmax\(38px,auto\)!important\}/);
  assert.match(css, /\.pp-tabs\{touch-action:pan-y;overscroll-behavior-x:contain\}/,
    '标签行处理横向切页，纵向滚动仍由页面原生接管');
});

test('touch devices get the sticky episode hover reset', () => {
  const state = fixture(); state.ready();
  const css = state.head.children[0].textContent;
  const coarse = css.slice(css.indexOf('@media (hover:none)'), css.indexOf('@media (hover:none)') + 900);
  assert.ok(coarse.length > 0, 'coarse-pointer hover reset is missing');
  /* iOS 粘住的 :hover 会让“某一集文字发黑加粗”；这里要把它按回常态 */
  assert.match(coarse, /#epGrid \.ep:hover\{color:var\(--ink-66\)!important/);
  assert.match(coarse, /html\[data-theme='light'\] #epGrid \.ep:hover\{color:var\(--ink-66\)!important/);
  /* 当前集（.on）不能被这条重置抹掉：仍要是绿色、仍要是粗体（粗体来自站点 .ep.on） */
  assert.match(coarse, /#epGrid \.ep\.on:hover\{color:var\(--mint-text\)!important/);
  assert.match(coarse, /html\[data-theme='light'\] #epGrid \.ep\.on:hover\{color:#0b8a5f!important/);
});

test('playback guard retries on the next touch and then reports the reason', async () => {
  const state = fixture({ playRejects: true }); state.ready();
  const media = Object.create(state.window.HTMLMediaElement.prototype);
  await media.play().catch(() => {});
  assert.equal(state.mediaProto.attempts, 1);
  assert.equal(state.hint.textContent, '播放器还没开始播放，点一下画面重试。');
  state.emit('touchend', { target: state.video });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.mediaProto.attempts, 2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(state.hint.textContent, /播放器没有开始播放（NotAllowedError）/);
});

test('successful playback is left alone by the guard', async () => {
  const state = fixture(); state.ready();
  const media = Object.create(state.window.HTMLMediaElement.prototype);
  await media.play();
  assert.equal(state.mediaProto.attempts, 1);
  assert.equal(state.hint.textContent, '');
});

test('expanding the episode list keeps the playing episode highlighted', async () => {
  const state = fixture({ episodes: [0, 1, 17, 18, 19] }); state.ready();
  state.click(state.epMore);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const on = state.epButtons.filter((button) => button.className.split(' ').includes('on'));
  assert.deepEqual(on.map((button) => button.dataset.ep), ['18']);
});

test('home date strip starts centred on today', async () => {
  const state = fixture(); state.ready();
  await new Promise((resolve) => setTimeout(resolve, 10));
  /* 今天（.day.on）在第 4 列：内容偏移 228，最大可滚 120 → 夹到 120，今天落进可视区 */
  assert.equal(state.days.scrollLeft, 120, '日期条应一进来就把今天拨进可视区');
  assert.equal(state.observers.length, 1, '居中成功后应挂上观察器，等站点重新渲染后再居中');
});

test('a parked date strip is not rewritten by every retry timer', async () => {
  const state = fixture(); state.ready();
  await new Promise((resolve) => setTimeout(resolve, 3400));
  /* 5 个补挂定时器（0/250/700/1500/3000）里只有真的偏了才写 scrollLeft，
     否则每次都强制一次布局，滚动就发涩。目标值不变时不该重复写。 */
  assert.equal(state.days.scrollLeft, 120, '今天仍然停在可视区起点');
  assert.equal(state.days.writes, 1, '目标位置没变就不该再写 scrollLeft');
});

test('home date strip keeps the position the user swiped to', async () => {
  const state = fixture(); state.ready();
  state.emit('touchstart', { target: state.dayButtons[1] });
  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.equal(state.days.scrollLeft, 0, '用户先动手浏览过的日期条不应被自动拨动');
});

test('home date strip is not yanked back after the user panned it', async () => {
  const state = fixture(); state.ready();
  await new Promise((resolve) => setTimeout(resolve, 10));
  /* 真机上横滑一定先有 touchstart，之后滚动的就是用户的位置 */
  state.emit('touchstart', { target: state.dayButtons[1] });
  state.days.scrollLeft = 7;
  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.equal(state.days.scrollLeft, 7, '用户自己拨到的位置不能被自动居中覆盖');
});

test('a background refresh puts the user date position back instead of jumping to today', async () => {
  const state = fixture(); state.ready();
  await new Promise((resolve) => setTimeout(resolve, 10));
  state.emit('touchstart', { target: state.dayButtons[1] });
  state.days.scrollLeft = 40;
  await new Promise((resolve) => setTimeout(resolve, 20));
  /* 站点后台刷新（本周追剧计数变了）：整批卡片重建，浏览器把 scrollLeft 归零 */
  state.days.scrollLeft = 0;
  state.observers[0].callback();
  assert.equal(state.days.scrollLeft, 40, '刷新后应该回到用户看的那一天，而不是漂回今天');
});

test('danmaku is animated on the compositor instead of re-laying-out every frame', async () => {
  const state = fixture(); state.ready();
  const css = state.head.children.map((child) => child.textContent || '').join('\n');
  assert.match(css, /\.dm-item\{[^}]*animation:dm-fly-x/, '弹幕动画应改成 transform 版本');
  assert.match(css, /@keyframes dm-fly-x\{from\{transform:translateX/, '新动画只动 transform');
  assert.doesNotMatch(css, /@keyframes dm-fly\{/, '不要再引入按 left 逐帧布局的动画');
});

test('scrolling surfaces drop expensive blur and smooth positioning', async () => {
  const state = fixture(); state.ready();
  const css = state.head.children.map((child) => child.textContent || '').join('\n');
  assert.match(css, /\.topbar,\.page-head\{-webkit-backdrop-filter:none!important/, '顶栏不再逐帧重算模糊');
  assert.match(css, /\.tabbar\{-webkit-backdrop-filter:none!important/, '底栏同样处理');
  assert.match(css, /\.p-badge,\.p-heat\{-webkit-backdrop-filter:none!important/,
    '首页海报上的多组模糊角标不能在惯性滚动中反复合成');
  assert.match(css, /\.days,\.strip,\.cat-list,\.line-group\{scroll-behavior:auto!important\}/,
    '横滑条不接受平滑滚动，否则重建后一设 scrollLeft 就整条滑过去');
  assert.match(css, /#playHint,\.pp-hint\{min-height:2\.6em/, '提示行预留高度，文案变化不推动下方内容');
  assert.match(css, /html\{background-color:#07131b!important;background-image:/,
    'App 内固定渐变背景绘制在根视图，不再保留全屏伪元素 GPU 图层');
  assert.match(css, /html\[data-theme='light'\]\{background-color:#eef1f4!important;background-image:/,
    '静态根背景继续适配浅色主题');
  assert.match(css, /body:before,body:after\{content:none!important;display:none!important\}/,
    '去掉滚动时会被 WebKit GPU 回收的两张全屏 fixed 背景层');
  assert.match(css, /\.pcard-link\{isolation:auto!important;transition:none!important;transform:none!important\}/,
    'iOS 卡片不可 hover，不应因每张卡 isolation/transform 生成 GPU 合成层');
});

test('swiping the tab row switches to the next tab', async () => {
  const state = fixture(); state.ready();
  await new Promise((resolve) => setTimeout(resolve, 5));
  /* 向左滑 = 往后一页：选集 → 投屏 */
  const start = state.touch('touchstart', state.tabButtons[0], 300, 500);
  const end = state.touch('touchend', state.tabButtons[0], 180, 505);
  assert.deepEqual(state.clicked, ['cast'], '横滑应切到下一页');
  assert.equal(end.defaultPrevented, true, '切换后要压掉这次松手造成的点击');
  assert.ok(start);
  /* 纵向滑不能误判成切页 */
  state.touch('touchstart', state.tabButtons[1], 300, 500);
  state.touch('touchend', state.tabButtons[1], 262, 380);
  assert.deepEqual(state.clicked, ['cast'], '纵向滚动不能被当成切页手势');
});

test('cancelling a tab-row touch clears the pending swipe', () => {
  const state = fixture(); state.ready();
  state.touch('touchstart', state.tabButtons[0], 300, 500);
  state.emit('touchcancel', { target: state.tabButtons[0] });
  state.touch('touchend', state.tabButtons[0], 150, 500);
  assert.deepEqual(state.clicked, [], '系统取消手势后，后续无关触摸不能触发标签切页');
});

test('home date strip re-centres after the site re-renders the days', async () => {
  const state = fixture(); state.ready();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(state.days.scrollLeft, 120);
  /* 站点二次渲染：整批 .day 换新元素，scrollLeft 被浏览器重置为 0 */
  state.days.scrollLeft = 0;
  for (const button of state.dayButtons) delete button.dataset.iosCentred;
  state.observers[0].callback();
  assert.equal(state.days.scrollLeft, 120, '重新渲染后应再次把今天拨进可视区');
});

test('search keyword falls back to the query string when the box is empty', async () => {
  const state = fixture({ search: '?q=%E4%BB%8A%E5%A4%A9%E6%98%AF%E5%A4%AA%E9%98%B3%E9%9B%A8' });
  await state.window.fetch('https://kanju-api.kenzhao123.workers.dev/api/list?sort=heat&limit=24&page=1');
  assert.equal(new URL(state.calls[0].input).searchParams.get('q'), '今天是太阳雨');
});

test('returning from my downloads reveals the episode download page', () => {
  const state = fixture({ episodes: [18] }); state.ready();
  state.click(state.siteDownload);
  state.click(state.document.getElementById('iosDlListBtn'));
  state.click(state.document.getElementById('iosMinePage').children[0].children[0]);
  assert.equal(state.document.getElementById('iosDlPage').hidden, false);
});

test('download page opens without an app login and queues the tapped episode', async () => {
  const state = fixture({ episodes: [0], newDownloadUI: true }); state.ready();
  state.click(state.siteDownload);
  const cell = state.document.getElementById('iosDlCell6-0');
  assert.ok(cell, '下载页要列出当前集');
  state.replies.push(json({ ...valid, idx: 0, episodeNumber: 1 }));
  state.click(cell);
  await settle();
  assert.equal(state.messages.at(-1).action, 'downloadBatch',
    '新站没有 App 登录态，点下载就该直接入队');
  assert.equal(state.messages.at(-1).items.length, 1);
  assert.equal(state.loginTrigger.opens, 0, '不该再拿旧登录态拦人');
});

test('the site own download menu row opens the native download page', () => {
  const state = fixture({ episodes: [0, 1], newDownloadUI: true }); state.ready();
  const row = node('button');
  row.id = 'ppDownload';
  row.textContent = '下载本集';
  state.document.body.appendChild(row);
  const page = state.document.getElementById('iosDlPage');
  page.hidden = true;
  state.click(row);
  assert.equal(page.hidden, false, '点站点菜单里的下载本集要打开原生下载页');
  assert.ok(state.document.getElementById('iosDlCell6-1'), '下载页要列出每一集');
});

test('no native player overlay is injected any more', () => {
  const state = fixture({ episodes: [0] }); state.ready();
  const ids = [];
  const walk = (element) => {
    for (const child of element.children || []) {
      if (child.id) ids.push(child.id);
      walk(child);
    }
  };
  walk(state.document.body);
  walk(state.player);
  walk(state.toolbar);
  for (const gone of ['ppCtrl', 'ppCast', 'ppRate', 'ppFull', 'iosTopBar', 'iosFullBtn', 'iosTitleDownload', 'iosDlEntry']) {
    assert.equal(ids.includes(gone), false, '原生叠加控件不能再注入：' + gone);
  }
  assert.equal(state.messages.length, 0, '注入层不再给原生发任何播放器界面消息');
});

test('website download button opens the real episode list and queues the selected episode', async () => {
  const state = fixture({ signedIn: true, episodes: [0, 1], newDownloadUI: true }); state.ready();
  const entry = node('button');
  entry.setAttribute('data-pw-act', 'dl');
  state.document.body.appendChild(entry);
  const select = state.document.querySelectorAll.bind(state.document);
  state.document.querySelectorAll = (selector) => {
    if (selector === '#pwEpList .ep') return state.epButtons;
    if (selector === '#epGrid .ep') return [];
    return select(selector);
  };
  state.click(entry);
  assert.equal(state.document.getElementById('iosDlPage').hidden, false);
  state.replies.push(json({ ...valid, idx: 1, episodeNumber: 2 }));
  state.click(state.document.getElementById('iosDlCell6-1'));
  await settle();
  const message = state.messages.at(-1);
  assert.equal(message.action, 'downloadBatch');
  assert.equal(message.items.length, 1);
  assert.equal(message.items[0].url, valid.url);
  assert.equal(message.items[0].epKey, '1');
  assert.equal(message.items[0].name, '测试剧 第2集.mp4');
  assert.equal(state.loginTrigger.opens, 0, '已登录就不要再弹登录');
});

test('download progress appears in the download page and a completed episode joins my downloads', () => {
  const state = fixture({ signedIn: true, episodes: [0], newDownloadUI: true }); state.ready();
  state.click(state.siteDownload);
  state.window.__zhuijuDownloads('snapshot', [
    { id: 'task-a', showId: 'fixture', epKey: '0', epLabel: '第1集', title: '测试剧', status: 'running', received: 43, total: 100 },
  ]);
  assert.equal(state.document.getElementById('iosDlCell6-0').__iosState.textContent, '下载中 43%');
  assert.equal(state.document.getElementById('iosDlCell6-0').__iosProgress.hidden, false);
  assert.equal(state.document.getElementById('iosDlCell6-0').__iosProgress.value, 43);
  assert.equal(state.document.getElementById('iosDlCell6-0').__iosProgress.max, 100);
  state.window.__zhuijuDownload({ id: 'task-a', event: 'progress', showId: 'fixture', epKey: '0', epLabel: '第1集', title: '测试剧', received: 60, total: 100 });
  assert.equal(state.document.getElementById('iosDlCell6-0').__iosProgress.value, 60);
  assert.equal(state.document.getElementById('iosDlCell6-0').__iosState.textContent, '下载中 60%');
  state.click(state.document.getElementById('iosDlListBtn'));
  assert.equal(state.document.getElementById('iosMinePage').hidden, false);
  const runningRow = state.document.getElementById('iosMineTask-task-a');
  assert.ok(runningRow, '下载中的一集必须有自己的那一行');
  assert.match(runningRow.textContent, /测试剧/);
  assert.match(runningRow.textContent, /第1集/);
  assert.match(runningRow.textContent, /60%/);
  assert.equal(runningRow.querySelectorAll('.ios-dl-task-progress')[0].value, 60);
  state.window.__zhuijuDownload({ id: 'task-a', event: 'done', showId: 'fixture', epKey: '0', ep: '第1集', epLabel: '第1集', title: '测试剧', path: '/tmp/追剧AI_第1集.mp4', name: '测试剧 第1集.mp4', size: 104857600 });
  assert.match(state.document.getElementById('iosMineBody').textContent, /已下载 1 集/);
  const deleteButton = state.document.getElementById('iosMineBody').querySelector('.ip-epdel');
  assert.ok(deleteButton);
  deleteButton.setAttribute('data-dl-show', 'fixture');
  deleteButton.setAttribute('data-dl-key', '0');
  state.click(deleteButton);
  assert.equal(state.messages.at(-1).action, 'deleteLocal', '列表删除只删除该集文件');
});

/* 多集一起下：每集一行，写清剧名 + 集号 + 百分比；进度事件按 id 只更新自己那一行。 */
test('every downloading episode shows its show, episode and live percent in my downloads', () => {
  const state = fixture({ episodes: [0, 1], newDownloadUI: true }); state.ready();
  state.click(state.siteDownload);
  state.window.__zhuijuDownloads('snapshot', [
    { id: 'dl-fixture-0', showId: 'fixture', epKey: '0', epLabel: '第1集', title: '测试剧', status: 'running', received: 45, total: 100 },
    { id: 'dl-fixture-1', showId: 'fixture', epKey: '1', epLabel: '第2集', title: '测试剧', status: 'queued', received: 0, total: 0 },
  ]);
  state.click(state.document.getElementById('iosDlListBtn'));
  const running = state.document.getElementById('iosMineTask-dl-fixture-0');
  const queued = state.document.getElementById('iosMineTask-dl-fixture-1');
  assert.ok(running && queued, '两集各占一行，不能只显示一条笼统的总进度');
  assert.match(running.textContent, /测试剧/);
  assert.match(running.textContent, /第1集/);
  assert.match(running.textContent, /45%/);
  assert.equal(running.querySelectorAll('.ios-dl-task-progress')[0].value, 45);
  assert.match(queued.textContent, /测试剧/);
  assert.match(queued.textContent, /第2集/);
  assert.match(queued.textContent, /排队中/);
  state.window.__zhuijuDownload({ id: 'dl-fixture-0', event: 'progress', showId: 'fixture', epKey: '0', epLabel: '第1集', title: '测试剧', received: 80, total: 100 });
  const moved = state.document.getElementById('iosMineTask-dl-fixture-0');
  assert.match(moved.textContent, /80%/, '进度要实时进到这一集自己的行');
  assert.equal(moved.querySelectorAll('.ios-dl-task-progress')[0].value, 80);
  assert.ok(state.document.getElementById('iosMineTask-dl-fixture-1'), '别的集进度更新不能把排队那一行弄丢');
});

test('a failed single-episode queue task reports its failure state', async () => {
    const state = fixture({ signedIn: true, episodes: [18], newDownloadUI: true }); state.ready();
  state.click(state.siteDownload);
  state.replies.push(json({ ...valid, idx: 18, episodeNumber: 19 }));
  state.click(state.document.getElementById('iosDlCell6-18'));
  await settle();
  state.window.__zhuijuDownloads('snapshot', [
    { id: 'failed-task', showId: 'fixture', epKey: '18', epLabel: '第19集', title: '测试剧', status: 'failed' },
  ]);
  assert.match(state.document.getElementById('iosDlCell6-18').textContent, /失败/);
});

test('download refuses a resolved player page url instead of saving the page', async () => {
  const state = fixture({ episodes: [0], newDownloadUI: true }); state.ready();
  state.click(state.siteDownload);
  state.replies.push(json({ ...valid, idx: 0, episodeNumber: 1, url: 'https://zhuiju.dpdns.org/player/?id=fixture' }));
  state.click(state.document.getElementById('iosDlCell6-0'));
  await settle();
  assert.equal(state.messages.length, 0, '播放页地址不是片源，不能交给原生下载');
  assert.match(state.toastText(), /没有解析到真实视频地址/);
});

test('download refuses HLS playlists and encrypted streams', async () => {
  const hls = fixture({ signedIn: true, episodes: [0], newDownloadUI: true }); hls.ready();
  hls.video.currentSrc = 'https://media.example/19.m3u8';
  hls.replies.push(json({ ...valid, idx: 0, kind: 'hls', url: hls.video.currentSrc }));
  hls.click(hls.siteDownload);
  hls.click(hls.document.getElementById('iosDlCell6-0'));
  await settle();
  assert.equal(hls.messages.length, 0);
  assert.match(hls.toastText(), /HLS/);

  const blob = fixture({ signedIn: true, episodes: [0], newDownloadUI: true }); blob.ready();
  blob.video.currentSrc = 'blob:https://zhuiju.dpdns.org/9f1c';
  blob.replies.push(json({ ...valid, idx: 0, kind: 'mp4', url: blob.video.currentSrc }));
  blob.click(blob.siteDownload);
  blob.click(blob.document.getElementById('iosDlCell6-0'));
  await settle();
  assert.equal(blob.messages.length, 0);
  assert.match(blob.toastText(), /没有解析到真实视频地址/);
});

test('a stale queue snapshot cannot replace current single-download state', () => {
  const state = fixture({ signedIn: true, episodes: [18], newDownloadUI: true }); state.ready();
  state.click(state.siteDownload);
  state.window.__zhuijuDownloads('snapshot', [
    { id: 'old-task', showId: 'other', epKey: '18', status: 'done', path: '/tmp/old.mp4' },
  ]);
  assert.equal(state.document.getElementById('iosDlCell6-18').__iosState.textContent, '未下载');
});

test('a signed-in sidebar never also says it is a guest account', async () => {
  const guest = fixture();
  guest.ready();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(guest.acctName.textContent, '游客账号');
  assert.equal(guest.sbName.textContent, '游客账号');

  /* 登录后：侧栏两处名字必须是同一个用户名，不能一处「已登录 kenzhao11」一处「游客账号」 */
  const mine = fixture({ signedIn: true });
  mine.ready();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(mine.sbName.textContent, 'kenzhao11');
  assert.equal(mine.acctName.textContent, 'kenzhao11', '成长卡片不能还写着游客账号');
  assert.doesNotMatch(mine.acctName.textContent, /游客/);
  assert.match(mine.sbSub.textContent, /已登录/);
});

/* ---------- 0.1.9 回归：下载进度要看得到（首页设置面板） ---------- */

/* 站点首页顶栏只有一个设置图标，点开只弹「设置面板即将上线」；
   下载进度原先只塞进播放页的 #settingsPanel，一离开播放页就什么都看不到。 */
test('the home page settings panel contains no download management', () => {
  const state = fixture({ homePage: true }); state.ready();
  const trigger = state.document.querySelector('[data-action="settings"]');
  assert.ok(trigger, '首页必须有设置入口');
  assert.equal(state.sheet(), null, '还没点之前不该有面板盖在页面');

  state.click(trigger);
  const sheet = state.sheet();
  assert.ok(sheet, '首页也要有能打开的设置面板');
  assert.equal(sheet.hidden, false, '点了设置就要打开');
  assert.ok(sheet.className.includes('on'));
  assert.equal(state.document.getElementById('iosDownloadLabel'), null);
  assert.equal(state.document.getElementById('iosDownloadLibrary'), null);

  state.click(state.document.getElementById('iosSettingsClose'));
  assert.equal(sheet.hidden, true, '关闭按钮要能收起面板');
});

/* 下载在原生层跑，换页不会停；进度必须先落到 localStorage，再在新页面接上，
   否则从播放页回首页时进度条永远是「尚未下载」。 */
test('a running download restores its state and appears in my downloads', () => {
  const state = fixture({
    homePage: true,
    seed: { 'kj-ios-download': JSON.stringify({ id: 'dl9', name: '追剧AI_第3集.mp4', busy: true, percent: 42, state: 'running' }) },
  });
  state.ready();
  state.click(state.document.getElementById('iosDlListBtn'));
  assert.match(state.document.getElementById('iosMineBody').textContent, /下载中/);

  state.window.__zhuijuDownloads('snapshot', [
    { id: 'dl9', showId: 'fixture', epKey: '2', epLabel: '第3集', title: '测试剧', status: 'running', received: 60, total: 100 },
  ]);
  assert.match(state.document.getElementById('iosMineBody').textContent, /60%/);

  state.window.__zhuijuDownloads('snapshot', [
    { id: 'dl9', showId: 'fixture', epKey: '2', epLabel: '第3集', title: '测试剧', status: 'running', received: 60, total: 100 },
  ]);
  const restored = state.document.getElementById('iosMineTask-dl9');
  assert.ok(restored, '刷新后的那一集还要有自己的进度行');
  assert.match(restored.textContent, /测试剧/);
  assert.match(restored.textContent, /第3集/);
  assert.match(restored.textContent, /60%/);
  state.window.__zhuijuDownloads('snapshot', [
    { id: 'dl9', showId: 'fixture', epKey: '2', epLabel: '第3集', title: '测试剧', status: 'done', received: 100, total: 100, path: '/tmp/追剧AI_第3集.mp4', size: 104857600 },
  ]);
  state.window.__zhuijuDownload({ id: 'dl9', event: 'done', showId: 'fixture', epKey: '2', epLabel: '第3集', title: '测试剧', path: '/tmp/追剧AI_第3集.mp4', name: '测试剧 第3集.mp4', size: 104857600 });
  state.window.__zhuijuDownload({ id: 'dl9', event: 'done', showId: 'fixture', epKey: '2', epLabel: '第3集', title: '测试剧', path: '/tmp/追剧AI_第3集.mp4', name: '测试剧 第3集.mp4', size: 104857600 });
  state.window.__zhuijuDownload({ id: 'dl9', event: 'done', showId: 'fixture', epKey: '2', epLabel: '第3集', title: '测试剧', path: '/tmp/追剧AI_第3集.mp4', name: '测试剧 第3集.mp4', size: 104857600 });
  assert.match(state.document.getElementById('iosMineBody').textContent, /已下载 1 集/);
});

/* ---------- 0.1.9 回归：默认用第三方播放器 ---------- */

/* 用户的原话是「默认用第三方播放器播放，不要都卡在外放那里」：
   点「外放」就该直接把这一集交给系统播放器列表，而不是再进一层菜单。 */
test('the replacement settings panel exposes account and playback controls', () => {
  const state = fixture({ externalPlayerDefault: true }); state.ready();
  state.click(state.settingsTrigger);
  assert.equal(state.document.getElementById('iosSettingAccount').textContent, '即将上线');
  assert.equal(state.document.getElementById('iosSettingSpeed').value, '2');
  assert.equal(state.document.getElementById('iosDownloadLibrary'), null);
  assert.equal(state.document.getElementById('iosExtToggle'), null);
});

/* 进度块只有一个，必须跟着用户眼前那一面走：设置面板开着就在面板里，
   收起后回到播放器的「显示设置」，不能出现两份对不上的状态。 */
test('download management remains separate from the settings panel', () => {
  const state = fixture({ episodes: [0] }); state.ready();
  state.click(state.siteDownload);
  state.window.__zhuijuDownloads('snapshot', [
    { id: 'task-a', showId: 'fixture', epKey: '0', status: 'running', received: 30, total: 100 },
  ]);
  assert.equal(state.document.getElementById('iosDlCell6-0').__iosState.textContent, '下载中 30%');
  state.click(state.settingsTrigger);
  const body = state.document.getElementById('iosSettingsBody');
  assert.ok(body);
  assert.equal(state.document.getElementById('iosDownloadStatus'), null);
  assert.equal(state.document.getElementById('iosDownloadLibrary'), null);
  assert.equal(state.document.getElementById('iosMinePage').hidden, true);
});

test('tapping the dimmed backdrop closes the settings panel', () => {
  const state = fixture({ homePage: true }); state.ready();
  state.click(state.settingsTrigger);
  const sheet = state.sheet();
  assert.equal(sheet.hidden, false);
  state.click(sheet);
  assert.equal(sheet.hidden, true, '点深色底要能关掉面板');
});

/* 进度事件一秒能来很多次，写 localStorage 必须限流；但「完成」这一次状态转变
   无论如何都要落地，否则换页回来还是上一次的旧进度。 */
test('replayed queue completion is reflected once in the downloads list', () => {
  const state = fixture({ homePage: true }); state.ready();
  const task = { id: 'task-a', showId: 'fixture', epKey: '18', epLabel: '第19集', title: '测试剧', status: 'done', path: '/tmp/19.mp4', size: 10 };
  state.window.__zhuijuDownloads('snapshot', [task]);
  const completion = { ...task, event: 'done' };
  state.window.__zhuijuDownload(completion);
  state.click(state.document.getElementById('iosDlListBtn'));
  assert.match(state.document.getElementById('iosMineBody').textContent, /已下载 1 集/);
  state.window.__zhuijuDownloads('snapshot', [task]);
  state.window.__zhuijuDownload(completion);
  assert.match(state.document.getElementById('iosMineBody').textContent, /已下载 1 集/);
});

/* 真机上压在画面顶上的不是播放器里那行小字，而是站点头栏 `pageHead()`：
   返回箭头 + 片名 + 主题 + 菜单。0.1.10 漏了它，横屏全屏里「百日谎言」一直挂着。 */
test('a single-episode cell queues its verified media in the native downloader', async () => {
  const state = fixture({ signedIn: true, episodes: [18], newDownloadUI: true }); state.ready();
  state.click(state.siteDownload);
  const button = state.document.getElementById('iosDlCell6-18');
  assert.ok(button, '下载页要列出当前集');
  state.replies.push(json({ ...valid, idx: 18, episodeNumber: 19 }));
  state.click(button);
  await settle();
  const message = state.messages.at(-1);
  assert.equal(message.action, 'downloadBatch');
  assert.equal(message.items.length, 1);
  assert.equal(message.items[0].url, valid.url);
  state.window.__zhuijuDownloads('snapshot', [{ ...message.items[0], status: 'running' }]);
  assert.match(button.textContent, /下载中/);
});

test('a single-episode download queues without any login state', async () => {
  const state = fixture({ episodes: [18], newDownloadUI: true }); state.ready();
  state.click(state.siteDownload);
  state.replies.push(json({ ...valid, idx: 18, episodeNumber: 19 }));
  state.click(state.document.getElementById('iosDlCell6-18'));
  await settle();
  assert.equal(state.messages.at(-1).action, 'downloadBatch');
  assert.equal(state.loginTrigger.opens, 0);
});

/* ---------- REG-006 「我的下载」按剧展示片库 ---------- */

const librarySeed = {
  shows: [
    {
      id: 'show-a', title: '百日谎言', cover: 'https://zhuiju.dpdns.org/posters/a.jpg', total: 12,
      eps: [
        { key: '18', label: '第19集', name: '追剧AI_第19集.mp4', path: '/tmp/a19.mp4', size: 1, at: 20 },
        { key: '19', label: '第20集', name: '追剧AI_第20集.mp4', path: '/tmp/a20.mp4', size: 1, at: 21 },
      ],
    },
    {
      id: 'movie-b', title: '某部电影', cover: '', total: 0,
      eps: [{ key: '0', label: '正片', name: '追剧AI_正片.mp4', path: '/tmp/b.mp4', size: 2, at: 10 }],
    },
  ],
};

test('the download library is listed in my downloads with covers, episodes and totals', () => {
  const state = fixture({ homePage: true, newDownloadUI: true, seed: { 'kj-ios-downloads': JSON.stringify(librarySeed) } });
  state.ready();
  state.click(state.document.getElementById('iosDlListBtn'));

  const library = state.document.getElementById('iosMinePage');
  assert.ok(library, '「我的下载」页要有下载片库');
  assert.equal(library.hidden, false, '有下载记录时片库必须显示');
  const list = state.document.getElementById('iosMineBody');
  const items = list.querySelectorAll('.ip-show');
  assert.equal(items.length, 2, '两部片子各占一条');

  const show = items[0];
  const cover = show.querySelector('img');
  assert.ok(cover, '片名旁边要有封面');
  assert.equal(cover.src, 'https://zhuiju.dpdns.org/posters/a.jpg');
  assert.equal(cover.alt, '百日谎言');
  assert.equal(show.querySelector('.ips-title').textContent, '百日谎言');
  assert.equal(show.querySelector('.ips-meta').textContent, '已下载 2 集 · 0.0 MB');
  const chips = show.parentNode.querySelectorAll('.ip-eptitle');
  assert.deepEqual(chips.map((chip) => chip.textContent), ['第19集', '第20集'], '每部剧要列出下了哪几集');

  const movie = items[1];
  assert.equal(movie.querySelector('img'), null, '没有封面就不摆一张假图');
  assert.match(movie.querySelector('.ips-meta').textContent, /已下载 1 集/, '总集数未知时不许编一个分母');
  assert.equal(movie.parentNode.querySelector('.ip-eptitle').textContent, '正片');
});
test('a finished episode offers the system player hand-off, a running one does not', () => {
  const state = fixture({ homePage: true, newDownloadUI: true, seed: { 'kj-ios-downloads': JSON.stringify(librarySeed) } });
  state.ready();
  state.click(state.document.getElementById('iosDlListBtn'));
  const entries = state.document.querySelectorAll('[data-ios-act="open-in-player"]');
  assert.equal(entries.length, 3, '每集已下载的都要有自己的外部播放入口');
  const ext = entries[0];
  assert.equal(ext.textContent, '外部播放');
  assert.equal(ext.getAttribute('data-dl-path'), '/tmp/a19.mp4', '入口要带这集真实的本地文件路径');
  state.click(ext);
  assert.equal(state.messages.at(-1).action, 'openInOtherPlayer');
  assert.equal(state.messages.at(-1).path, '/tmp/a19.mp4');

  const running = fixture({ episodes: [0], newDownloadUI: true });
  running.ready();
  running.window.__zhuijuDownloads('snapshot', [
    { id: 'task-b', showId: 'fixture', epKey: '0', epLabel: '第1集', title: '测试剧', status: 'running', received: 10, total: 100 },
  ]);
  running.click(running.document.getElementById('iosDlListBtn'));
  assert.equal(running.document.querySelectorAll('[data-ios-act="open-in-player"]').length, 0,
    '下载中 / 没下完的集不能出现外部播放入口');
});

test('the native open-in result is shown as a toast', () => {
  const state = fixture({ episodes: [0] }); state.ready();
  state.window.__zhuijuPlayerNotice('没有找到能打开这个视频的播放器');
  assert.match(state.toastText(), /没有找到能打开这个视频的播放器/);
});

test('the download library stays out of the way when nothing was downloaded', () => {
  const state = fixture({ homePage: true, newDownloadUI: true });
  state.ready();
  state.click(state.document.getElementById('iosDlListBtn'));
  assert.equal(state.document.getElementById('iosMineBody').textContent, '还没有下载完成的剧集');
});

test('a finished download joins the library with its show, episode and total', () => {
  const state = fixture({ signedIn: true, episodes: ['18'], newDownloadUI: true });
  state.ready();
  state.click(state.siteDownload);
  state.window.__zhuijuDownload({ id: 'done-18', event: 'done', showId: 'fixture', epKey: '18', ep: '第19集', epLabel: '第19集', title: '测试剧', path: '/tmp/x.mp4', name: '测试剧 第19集.mp4', size: 10485760 });

  const saved = JSON.parse(state.storage['kj-ios-downloads']);
  assert.equal(saved.shows.length, 1, '下完一集就要记进片库');
  assert.equal(saved.shows[0].title, '测试剧', '用详情页标题当剧名，不用文件名');
  assert.equal(saved.shows[0].cover, 'https://zhuiju.dpdns.org/posters/fixture.jpg');
  assert.equal(saved.shows[0].total, 1, '选集按钮数就是已知总集数');
  assert.equal(saved.shows[0].eps[0].label, '第19集');
  assert.equal(saved.shows[0].eps[0].path, '/tmp/x.mp4');

  state.click(state.document.getElementById('iosDlListBtn'));
  const item = state.document.getElementById('iosMineBody').querySelector('.ip-show');
  assert.equal(item.querySelector('.ips-meta').textContent, '已下载 1 集 · 10.0 MB');

  /* 换页/重启：状态落在 localStorage，新页面靠它把片库摆回来 */
  const reloaded = fixture({ homePage: true, newDownloadUI: true, seed: { 'kj-ios-downloads': state.storage['kj-ios-downloads'] } });
  reloaded.ready();
  reloaded.click(reloaded.document.getElementById('iosDlListBtn'));
  const again = reloaded.document.getElementById('iosMineBody').querySelector('.ip-show');
  assert.ok(again, '重启后片库还要在');
  assert.equal(again.querySelector('.ips-meta').textContent, '已下载 1 集 · 10.0 MB');
});

test('the running download shows its show, episode and percent in the library', () => {
  const state = fixture({
    homePage: true,
    seed: {
      'kj-ios-download': JSON.stringify({
        id: 'dl9', name: '追剧AI_第21集.mp4', show: '百日谎言', ep: '第21集',
        busy: true, percent: 42, state: 'running',
        /* 真机上这段是开始下载时就落盘的：换页后完成事件靠它归到正确的剧名下 */
        meta: { id: 'show-a', title: '百日谎言', cover: 'https://zhuiju.dpdns.org/posters/a.jpg', total: 12, epKey: '20', epLabel: '第21集' },
      }),
      'kj-ios-downloads': JSON.stringify(librarySeed),
    },
  });
  state.ready();
  state.click(state.document.getElementById('iosDlListBtn'));
  const running = state.document.getElementById('iosMineTask-dl9');
  assert.ok(running, '正在下载的那一集要有一行');
  assert.equal(state.document.getElementById('iosMinePage').hidden, false);
  assert.match(running.textContent, /百日谎言/, '要说是哪部剧');
  assert.match(running.textContent, /第21集/, '还要说是哪一集');
  assert.match(running.textContent, /下载中/, '总长度未知时只显示接收状态');

  state.window.__zhuijuDownload({ id: 'dl9', event: 'progress', received: 60, total: 100 });
  const moved = state.document.getElementById('iosMineTask-dl9');
  assert.match(moved.textContent, /60%/, '进度要实时进到这一集自己的行');
  assert.match(moved.textContent, /百日谎言/, '进度事件不丢剧名');
  assert.match(moved.textContent, /第21集/, '进度事件不丢集号');
  state.window.__zhuijuDownloads('snapshot', [
    { id: 'dl9', showId: 'show-a', epKey: '20', epLabel: '第21集', title: '百日谎言', status: 'running', received: 60, total: 100 },
  ]);

  state.window.__zhuijuDownload({ id: 'dl9', event: 'done', epKey: '20', ep: '第21集', epLabel: '第21集', showId: 'show-a', title: '百日谎言', path: '/tmp/a21.mp4', name: '追剧AI_第21集.mp4', size: 3 });
  state.window.__zhuijuDownloads('snapshot', []);
  const saved = JSON.parse(state.storage['kj-ios-downloads']);
  const show = saved.shows.find((entry) => entry.title === '百日谎言');
  assert.equal(show.total, 12, '下载字节数不能冒充剧集总数');
  assert.deepEqual(show.eps.map((entry) => entry.label), ['第19集', '第20集', '第21集'], '按集号排队，不丢旧记录');
});

/* ---------- REG-007 后台下载：网页要把「哪部剧的哪一集」交给原生 ---------- */

async function queueCurrentEpisode(state) {
  state.click(state.siteDownload);
  state.replies.push(json(valid));
  state.click(state.document.getElementById('iosDlCell6-18'));
  await settle();
  const message = state.messages.at(-1);
  assert.equal(message.action, 'downloadBatch');
  assert.equal(message.items.length, 1);
  return { show: message.show, item: message.items[0] };
}

test('the download request carries the show info the native side needs after a relaunch', async () => {
  const state = fixture({ signedIn: true, episodes: ['18'] });
  state.ready();
  const { show, item } = await queueCurrentEpisode(state);
  assert.equal(show.title, '测试剧');
  assert.equal(show.cover, 'https://zhuiju.dpdns.org/posters/fixture.jpg');
  assert.equal(show.total, 1, '总集数来自选集按钮');
  assert.equal(item.showId, show.id);
  assert.equal(item.epLabel, '第19集');
  assert.equal(item.epKey, '18');
});

/* ---------- REG-008 下载入口不会变成播放器入口 ---------- */

test('the title download button never turns into the player entry', async () => {
  const state = fixture({ signedIn: true, episodes: ['18'] });
  state.ready();
  const button = state.siteDownload;
  assert.equal(button.getAttribute('aria-label'), '下载');
  assert.equal(state.document.getElementById('ppToolDownload'), null);
  const { item } = await queueCurrentEpisode(state);
  state.window.__zhuijuDownload({ ...item, event: 'done', path: '/tmp/x.mp4', size: 10 });
  state.click(state.document.getElementById('iosDlListBtn'));
  state.click(state.document.getElementById('iosMinePage').querySelector('[data-ios-act="mine-back"]'));
  state.click(button);
  assert.equal(state.document.getElementById('iosDlPage').hidden, false);
  assert.match(state.document.getElementById('iosDlCell6-18').textContent, /已下载/);
  assert.ok(!state.messages.some((message) => message.action === 'openLocal'));
});

/* ---------- REG-009 文件名/列表/通知用真实剧名 ---------- */

test('the download file is named after the show, not the app', async () => {
  const state = fixture({ signedIn: true, episodes: ['18'] });
  state.ready();
  const { item } = await queueCurrentEpisode(state);
  assert.equal(item.name, '测试剧 第19集.mp4');
  assert.ok(!/追剧AI/.test(item.name), '文件名里不能再用 App 名冒充剧名');
});
