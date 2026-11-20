import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { inspect } from 'node:util';
import { attachFixtureInspect, withDOM } from './fixture-dom.mjs';

/* 下载队列 / 选集批量下载的 Node 夹具回归（0.1.14，下载专题）。
   单独一个文件，不去动共享的 bootstrap.test.mjs：批量下载和原生队列由这条分支独占，
   播放器/画面模式的用例仍留在 bootstrap.test.mjs 里。 */

const source = await readFile(new URL('../ZhuijuAI/AppBootstrap.js', import.meta.url), 'utf8');

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
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        return element.dataset[key] === undefined ? null : element.dataset[key];
      }
      return element[name] === undefined ? null : element[name];
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
      const selectorMatch = /^(?:([\w-]+))?((?:\.[\w-]+)?)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(selector);
      const walk = (current) => {
        for (const child of current.children || []) {
          const isTag = !selectorMatch?.[1] || child.tagName === selectorMatch[1].toUpperCase();
          const isClass = !selectorMatch?.[2] || String(child.className || '').split(' ').includes(selectorMatch[2].slice(1));
          const attribute = selectorMatch?.[3] ? child.getAttribute(selectorMatch[3]) : undefined;
          if (isTag && isClass && (!selectorMatch?.[3] || (selectorMatch[4] === undefined ? attribute !== null : attribute === selectorMatch[4]))) return child;
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(element);
    },
    querySelectorAll(selector) {
      const selectorMatch = /^(?:([\w-]+))?((?:\.[\w-]+)?)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(selector);
      const descendants = (parent) => (parent.children || []).flatMap((child) => [child, ...descendants(child)]);
      return descendants(element).filter((child) => {
        const isTag = !selectorMatch?.[1] || child.tagName === selectorMatch[1].toUpperCase();
        const isClass = !selectorMatch?.[2] || String(child.className || '').split(' ').includes(selectorMatch[2].slice(1));
        const attribute = selectorMatch?.[3] ? child.getAttribute(selectorMatch[3]) : undefined;
        return isTag && isClass && (!selectorMatch?.[3] || (selectorMatch[4] === undefined ? attribute !== null : attribute === selectorMatch[4]));
      });
    },
  };
  /* children / parentNode 不参与 util.inspect：断言失败时 Node 的 assert 用
     `customInspect: false, depth: 1000` 展开 actual，同一个节点既在 parentNode 里又在
     children 里，输出会指数膨胀（2026-11-20 一次失败的断言就这样吃掉 40GB）。
     访问和修改都不受影响，只是打印不再带整棵 DOM。 */
  Object.defineProperty(element, 'children', { value: element.children, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(element, 'parentNode', { value: element.parentNode, writable: true, enumerable: false, configurable: true });
  return withDOM(attachFixtureInspect(element), node);
}

/* 夹具默认把「默认用第三方播放器」关掉（seed 成 '0'）：按钮/菜单类用例关心的是菜单本身，
   每次都先点两下很啰嗦。新用例要验「默认就是第三方播放器」时传 externalPlayerDefault: true，
   此时不写这条偏好，和真机上第一次安装的默认值一致。 */
function fixture({ origin = 'https://zhuiju.dpdns.org', storageThrows = false, landscape = false, keyword = '', search = '?id=fixture', episodes = [], playRejects = false, maxRate = 0, bridge = true, signedIn = false, noSelectedEpisode = false, homePage = false, externalPlayerDefault = false, seed = {} } = {}) {
  const shared = [];
  const listeners = {};
  const replies = [];
  const calls = [];
  const redirects = [];
  const messages = [];
  const attributes = {};
  const selected = { dataset: { ep: '18' }, textContent: '第19集' };
  let videoRate = 1;
  const video = { id: 'video', tagName: 'VIDEO', readyState: 2, currentSrc: 'https://media.example/19.mp4',
    controls: true, paused: true, duration: 120, currentTime: 0, removed: [], style: {},
    load() {}, querySelectorAll() { return []; },
    removeAttribute(name) { video.removed.push(name); },
    pause() { video.paused = true; },
    play() { video.started = (video.started || 0) + 1; video.paused = false; return Promise.resolve(); },
    webkitEnterFullscreen() { video.nativeFullscreen = (video.nativeFullscreen || 0) + 1; } };
  /* 系统可能把倍速夹回去：maxRate 模拟 iOS 只允许到 2× */
  Object.defineProperty(video, 'playbackRate', {
    get() { return videoRate; },
    set(value) { videoRate = maxRate ? Math.min(Number(value) || 1, maxRate) : Number(value) || 1; },
  });
  const player = node('section');
  player.id = 'player';
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
    button.textContent = '第' + (idx + 1) + '集';
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
  epGrid.children.push(...epButtons);
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
  /* 站点播放页自己的「下载」按钮：注入层不再挂原生下载按钮。 */
  const siteDownload = node('button');
  siteDownload.setAttribute('data-pw-act', 'dl');
  siteDownload.setAttribute('aria-label', '下载');
  siteDownload.textContent = '下载';
  body.appendChild(siteDownload);
  /* 选集区要真的在页面上：0.1.14 的批量下载条插在 #epGrid 前面（没有父节点就挂不上） */
  /* 顶栏设置入口：首页用它打开设置面板（站点自己只会弹「即将上线」） */
  const settingsTrigger = node('button');
  settingsTrigger.dataset = { action: 'settings' };
  const idIndex = new Map();
  body.appendChild = (child) => {
    child.parentNode = body;
    body.children.push(child);
    if (child.id) idIndex.set(child.id, child);
    return child;
  };
  /* 选集区和它的批量下载条要真的在页面上 */
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
      /* 首页没有播放器和播放器设置面板：注入层必须在没有任何站点面板时也自带一块 */
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
    createElement(tag) { return node(tag); },
    querySelector(selector) {
      const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
      if (selector === '[data-action="login"]') return loginTrigger;
      if (selector === '[data-pw-act="dl"]') return siteDownload;
      if (selector === '.ep-head [data-action="cast"]') return episodeCast;
      if (attribute) return document.querySelectorAll(selector)[0] || null;
      if (selector === '.ep.on') return noSelectedEpisode ? null : selected;
      if (selector === '.detail-info h1') return homePage ? null : detailTitle;
      if (selector === '.detail-poster img') return homePage ? null : posterImage;
      if (selector === '.pp-tabs') return tabRow;
      if (selector === '[data-action="settings"]') return settingsTrigger;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.ip-eptitle') {
        const page = document.getElementById('iosMineBody');
        const descendants = (parent) => (parent.children || []).flatMap((child) => [child, ...descendants(child)]);
        return page ? descendants(page).filter((element) => String(element.className || '').split(/\s+/).includes('ip-eptitle')) : [];
      }
      if (selector === '.ep-head [data-action="cast"]') return [episodeCast];
      if (selector === '[data-pw-act="dl"]') return [siteDownload];
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
      return [];
    },
    documentElement: {
      setAttribute(name) { attributes[name] = true; },
      removeAttribute(name) { delete attributes[name]; },
      hasAttribute(name) { return !!attributes[name]; },
    } };
  let isLandscape = landscape;
  const window = { location: { origin, protocol: 'https:', hostname: new URL(origin).hostname,
    href: origin + '/player/?id=fixture', pathname: '/player/', search, replace(value) { redirects.push(value); } },
    innerWidth: landscape ? 844 : 390,
    innerHeight: landscape ? 390 : 844,
    matchMedia(query) { return { matches: isLandscape && /landscape/.test(query) }; },
    addEventListener(name, listener) { (listeners[name] ||= []).push(listener); },
    webkit: bridge ? { messageHandlers: { iosPlayer: { postMessage(body) { messages.push(body); } } } } : {},
    HTMLMediaElement: { prototype: mediaProto },
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

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function batchReply(showId, idx) {
  return json({ showId, idx, episodeNumber: idx + 1, verified: true, kind: 'mp4', url: `https://media.example/${idx + 1}.mp4` });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

/* 夹具 DOM 的 textContent 不会把子节点文字拼起来，读文本要自己聚合。 */
const textOf = (el) => (el ? ((el.children || []).map((child) => child.textContent || '').join(' ') || el.textContent || '') : '');
const childWithClass = (el, name) => ((el && el.children ? el.children : []).find((child) => String(child.className || '').split(' ').indexOf(name) >= 0) || null);


/* 0.1.16 规格 §2：下载入口只有选集旁的「下载」按钮 + 它下面那张集数网格。
   点一个格子 = 立刻把这一集加进同一条共享队列（不再有全选/一键全集/下载已选）。 */
test('tapping one cell in the episode grid queues exactly that episode', async () => {
  const state = fixture({ signedIn: true, episodes: [0, 1, 2] });
  state.ready();
  assert.equal(state.document.getElementById('iosBatchBar'), null,
    '批量条（选择/一键全集/从本集往后/下载已选）必须已经删掉');
  state.click(state.siteDownload);
  state.replies.push(batchReply('fixture', 1));

  const cell = state.document.getElementById('iosDlCell6-1');
  assert.ok(cell, '集数网格里没有第二集那一格');
  assert.match(textOf(cell), /第2集|2/, '格子要写集号');
  state.click(cell);
  await settle();

  const message = state.messages.at(-1);
  assert.equal(message.action, 'downloadBatch');
  assert.equal(message.items.length, 1, '点一格只下这一集');
  assert.equal(message.items[0].epKey, '1');
  assert.equal(message.items[0].url, 'https://media.example/2.mp4', '要用站点解析出来的真实片源');
  assert.match(state.toastText(), /已加入下载/, '点完要给一句轻提示');
});

test('the tapped episode appears immediately while its source is still being resolved', async () => {
  const state = fixture({ signedIn: true, episodes: [0, 1, 2] });
  state.ready();
  state.click(state.siteDownload);
  const cell = state.document.getElementById('iosDlCell6-1');
  state.click(cell);
  assert.match(textOf(cell), /排队|下载中/, '点下后不等原生快照也要先显示排队');
  assert.equal(state.storage['kj-ios-queue'], undefined, '乐观行只放内存，旧队列缓存不能再落盘');
  await settle();
});

test('the grid shows each episode state and never offers a batch action', async () => {
  const state = fixture({ signedIn: true, episodes: [0, 1, 2] });
  state.ready();
  state.click(state.siteDownload);
  state.window.__zhuijuDownloads('snapshot', [
    { id: 'b', showId: 'fixture', epKey: '1', epLabel: '第2集', title: '测试剧', status: 'running', received: 40, total: 100, path: '', size: 0, name: 'b.mp4' }
  ]);
  const grid = state.document.getElementById('iosDlGrid6');
  assert.ok(grid, '展开后应当是集数网格');
  const cells = grid.querySelectorAll('.ip-cell');
  assert.equal(cells.length, 3, '每一集一格');
  assert.match(textOf(cells[1]), /下载中/, '正在下载的那一格要显示进度状态');
  assert.match(textOf(cells[0]), /未下载/, '还没下的格子要显示未下载');
  for (const id of ['iosDlAll', 'iosDlClear', 'iosDlStart', 'iosBatchAll', 'iosBatchStart']) {
    assert.equal(state.document.getElementById(id), null, `不该再有 ${id} 这种批量入口`);
  }
});

test('a downloaded row can be deleted on its own, and only that file is asked to be removed', () => {
  const state = fixture({ signedIn: true, episodes: [0, 1] });
  state.ready();
  state.window.__zhuijuDownloads('snapshot', [
    { id: 'a', showId: 'fixture', epKey: '0', epLabel: '第1集', title: '测试剧', status: 'done', received: 10, total: 10, path: '/tmp/a.mp4', size: 10, name: 'a.mp4' },
    { id: 'b', showId: 'fixture', epKey: '1', epLabel: '第2集', title: '测试剧', status: 'done', received: 10, total: 10, path: '/tmp/b.mp4', size: 10, name: 'b.mp4' }
  ]);
  state.window.__zhuijuDownload({ id: 'a', event: 'done', showId: 'fixture', epKey: '0', epLabel: '第1集', title: '测试剧', path: '/tmp/a.mp4', size: 10, name: 'a.mp4' });
  state.window.__zhuijuDownload({ id: 'b', event: 'done', showId: 'fixture', epKey: '1', epLabel: '第2集', title: '测试剧', path: '/tmp/b.mp4', size: 10, name: 'b.mp4' });
  state.click(state.document.getElementById('iosDlListBtn'));
  const list = state.document.getElementById('iosMineBody');
  const rows = list.querySelectorAll('.ip-eprow');
  assert.ok(rows.length >= 2, '已下载列表要一行一集，左滑才有得删');
  const target = rows[0];
  const button = childWithClass(target, 'ip-epdel');
  assert.ok(button, '每一行都要有删除按钮（左滑露出来）');
  button.setAttribute('data-dl-show', 'fixture');
  button.setAttribute('data-dl-key', '0');
  state.click(button);
  const message = state.messages.at(-1);
  assert.equal(message.action, 'deleteDownload', '删除要让原生取消任务、删记录并删文件');
  assert.equal(typeof message.id, 'string', '把原生任务 id 一起带过去');
  assert.equal(message.showId, 'fixture');
  assert.equal(message.epKey, '0');
  assert.equal(message.path, '/tmp/a.mp4', '只删这一行对应的那个文件');
});

test('old snapshots, late done events and app restarts never resurrect a deleted episode', () => {
  const state = fixture({ signedIn: true, episodes: [0, 1] });
  state.ready();
  state.window.__zhuijuDownload({ id: 'a', event: 'done', showId: 'fixture', epKey: '0', epLabel: '第1集', title: '测试剧', path: '/tmp/a.mp4', size: 10, name: 'a.mp4' });
  state.click(state.document.getElementById('iosDlListBtn'));
  const row = state.document.getElementById('iosMineBody').querySelectorAll('.ip-eprow')[0];
  const button = childWithClass(row, 'ip-epdel');
  button.setAttribute('data-dl-show', 'fixture');
  button.setAttribute('data-dl-key', '0');
  state.click(button);
  assert.ok(state.storage['kj-ios-deleted-episodes'], '删除要写墓碑，防止旧事实源回灌');

  assert.equal(state.document.getElementById('iosMineBody').querySelectorAll('.ip-eprow').length, 0, '列表马上不再显示这一集');
  state.window.__zhuijuDownload({ id: 'a', event: 'done', showId: 'fixture', epKey: '0', epLabel: '第1集', title: '测试剧', path: '/tmp/a.mp4', size: 10, name: 'a.mp4' });
  state.window.__zhuijuDownloads('snapshot', [
    { id: 'a', showId: 'fixture', epKey: '0', epLabel: '第1集', title: '测试剧', status: 'done', received: 10, total: 10, path: '/tmp/a.mp4', size: 10, name: 'a.mp4' }
  ]);
  state.window.__zhuijuDownload({ id: 'a', event: 'done', showId: 'fixture', epKey: '0', epLabel: '第1集', title: '测试剧', path: '/tmp/a.mp4', size: 10, name: 'a.mp4' });
  assert.equal(state.document.getElementById('iosMineBody').querySelectorAll('.ip-eprow').length, 0, '晚到回调和重启快照都不能让它复活');
  assert.ok(!state.storage['kj-ios-queue'], '网页不能再把旧队列快照当持久事实源');
});

/* 复审阻塞：删除要等原生确认文件真的删掉；删失败不能装作成功。 */
test('a deleted row is only reported gone after the native confirms the file is removed', () => {
  const state = fixture({ signedIn: true, episodes: [0, 1] });
  state.ready();
  state.window.__zhuijuDownload({ id: 'a', event: 'done', showId: 'fixture', epKey: '0', epLabel: '第1集', title: '测试剧', path: '/tmp/a.mp4', size: 10, name: 'a.mp4' });
  state.click(state.document.getElementById('iosDlListBtn'));
  const row = state.document.getElementById('iosMineBody').querySelectorAll('.ip-eprow')[0];
  const button = childWithClass(row, 'ip-epdel');
  button.setAttribute('data-dl-show', 'fixture');
  button.setAttribute('data-dl-key', '0');
  state.click(button);
  assert.match(state.toastText(), /正在删除/, '点删除先说正在删，不能先报成功');
  state.window.__zhuijuDownloads('deleteResult', { ok: true, id: 'a', showId: 'fixture', epKey: '0' });
  assert.match(state.toastText(), /已删除/, '原生确认后才报删除成功');
  assert.equal(state.document.getElementById('iosMineBody').querySelectorAll('.ip-eprow').length, 0);
});

test('a failed native delete puts the row back and clears the web tombstone', () => {
  const state = fixture({ signedIn: true, episodes: [0, 1] });
  state.ready();
  state.window.__zhuijuDownload({ id: 'a', event: 'done', showId: 'fixture', epKey: '0', epLabel: '第1集', title: '测试剧', path: '/tmp/a.mp4', size: 10, name: 'a.mp4' });
  state.click(state.document.getElementById('iosDlListBtn'));
  const row = state.document.getElementById('iosMineBody').querySelectorAll('.ip-eprow')[0];
  const button = childWithClass(row, 'ip-epdel');
  button.setAttribute('data-dl-show', 'fixture');
  button.setAttribute('data-dl-key', '0');
  state.click(button);
  state.window.__zhuijuDownloads('deleteResult', {
    ok: false, id: 'a', showId: 'fixture', epKey: '0', path: '/tmp/a.mp4', name: 'a.mp4', size: 10,
    title: '测试剧', epLabel: '第1集', reason: '删除本地文件失败，这一集还留在下载列表里'
  });
  const rows = state.document.getElementById('iosMineBody').querySelectorAll('.ip-eprow');
  assert.equal(rows.length, 1, '文件没删掉，这一集必须留在列表里');
  assert.match(state.toastText(), /删除本地文件失败/, '要把失败原因告诉用户');
  const tombstone = state.storage['kj-ios-deleted-episodes'] || '[]';
  assert.equal(tombstone.indexOf('fixture|0') < 0, true, '失败要撤掉网页墓碑，否则这一集再也进不来');
});

/* REG-030：一条失败的断言把夹具 DOM 整棵树展开成字符串，曾经把 node 吃到 40GB。
   children / parentNode 不参与展开后，同一个失败断言只剩几 KB 文本。 */
test('a fixture node prints as one short line so a failed assertion cannot dump the whole DOM', () => {
  const state = fixture({ signedIn: true, episodes: [0, 1] });
  state.ready();
  state.click(state.document.getElementById('iosDlListBtn'));
  const body = state.document.getElementById('iosMineBody');
  const dump = inspect(body);
  assert.match(dump, /^\[fixture /, `夹具节点要有一行摘要，实际：${dump.slice(0, 200)}`);
  assert.ok(dump.length < 120, `夹具节点的摘要不能带上整棵树，实际 ${dump.length} 字符`);
  assert.doesNotMatch(dump, /parentNode/, '摘要里不能出现 DOM 引用');
  assert.throws(() => assert.equal(body, null), (error) => {
    assert.equal(error && error.name, 'AssertionError', '失败的断言仍是 AssertionError');
    assert.ok(String(error.message).length < 10000, `失败断言的报错必须是一小段，实际 ${String(error.message).length} 字符`);
    return true;
  });
});

test('a failed episode never lets the show look complete and an unknown length has no percent', () => {
  const state = fixture({ signedIn: true, episodes: [0, 1] });
  state.ready();
  state.click(state.document.getElementById('iosDlListBtn'));
  state.window.__zhuijuDownloads('snapshot', [
    { id: 'a', showId: 'fixture', epKey: '0', epLabel: '第1集', title: '测试剧', status: 'done', received: 1048576, total: 1048576, path: '/tmp/a.mp4', size: 1048576, name: 'a.mp4' },
    { id: 'b', showId: 'fixture', epKey: '1', epLabel: '第2集', title: '测试剧', status: 'failed', received: 0, total: 0, path: '', size: 0, name: 'b.mp4' },
    { id: 'c', showId: 'fixture', epKey: '2', epLabel: '第3集', title: '测试剧', status: 'paused', received: 1048576, total: 0, path: '', size: 0, name: 'c.mp4' }
  ]);
  const queueNode = state.document.getElementById('iosMineQueue');
  const text = state.document.getElementById('iosMineBody').textContent;
  assert.equal(queueNode, null, '失败或暂停任务不伪装成正在下载');
  assert.match(text, /还没有下载完成的剧集/, text);
  assert.ok(!/全部完成/.test(text), `有一集失败就不能说整部剧完成：${text}`);
  assert.doesNotMatch(text, /全部完成/, '失败任务不应显示全部完成');
});

/* 复审阻塞（REG-013）：批量 3 集全部 done，队列 3/3、100%，片库却还是「已下载 0/3 集」。
   这里直接用原生真实下发的那几条 done（带 path / showId / epKey / 剧名 / 总集数），
   断言片库按剧写成 3/3、逐集可见，并且重送同一批 done 幂等。 */
test('each finished episode lands in my downloads, and replay stays idempotent', async () => {
  const state = fixture({ signedIn: true, episodes: [0, 1, 2] });
  state.ready();
  state.click(state.siteDownload);
  const items = [];
  for (const key of [0, 1, 2]) {
    state.replies.push(batchReply('fixture', key));
    state.click(state.document.getElementById('iosDlCell6-' + key));
    await settle();
    items.push(state.messages.at(-1).items[0]);
  }
  assert.equal(items.length, 3, '三个单集分别排进同一共享队列');
  state.click(state.document.getElementById('iosDlListBtn'));

  const done = (item) => ({
    event: 'done', id: item.id, path: '/tmp/' + item.epKey + '.mp4', name: item.name, size: 2048,
    showId: 'fixture', epKey: item.epKey, ep: item.epLabel, epLabel: item.epLabel,
    title: '测试剧', cover: '', showTotal: '3',
  });
  for (const item of items) state.window.__zhuijuDownload(done(item));

  const libraryItem = state.document.getElementById('iosMineBody').querySelector('.ip-show');
  assert.ok(libraryItem, '3 集下完，片库里一部剧都没有');
  assert.equal(libraryItem.querySelector('.ips-title').textContent, '测试剧', '片库要用真实剧名');
  assert.equal(libraryItem.querySelector('.ips-meta').textContent, '已下载 3 集 · 0.0 MB');
  assert.deepEqual(state.document.getElementById('iosMineBody').querySelectorAll('.ip-eptitle').map((chip) => chip.textContent),
    ['第1集', '第2集', '第3集'], '每个收到原生落盘确认的单集都要能查看');
  /* 当前这一集就是批量里刚下完的那一集：单集进度行不能还写「尚未下载」 */
  assert.equal(state.document.getElementById('iosDownloadLabel'), null,
    '新版单集入口不再保留旧下载进度条');

  /* 换页/重启/重复 backfill 会把同一批 done 再送一遍：不能重复计数，也不能多出集 */
  for (const item of items) state.window.__zhuijuDownload(done(item));
  const replay = state.document.getElementById('iosMineBody').querySelector('.ip-show');
  assert.equal(replay.querySelector('.ips-meta').textContent, '已下载 3 集 · 0.0 MB');
  assert.equal(replay.parentNode.querySelectorAll('.ip-eprow').length, 3, '重送不能多出集记录');
});

/* 片库里已经有一部「测试剧」（id 退回成剧名），真 showId 来自队列快照时，
   同一部剧不能变成两条、队列进度也不能挂丢。上一轮 CI 的 DownloadQueueUITests
   就是因此看不到「任务 x/y 集」和暂停/取消。 */
test('a show already in the library by title keeps its queue progress when the real showId arrives', () => {
  const state = fixture({
    signedIn: true,
    episodes: [0, 1, 2],
    seed: {
      'kj-ios-downloads': JSON.stringify({
        shows: [{
          id: '测试剧', title: '测试剧', cover: '', total: 3,
          eps: [{ key: '18', label: '第19集', path: '/tmp/19.mp4', size: 1, at: 1 }],
        }],
      }),
    },
  });
  state.ready();
  state.click(state.document.getElementById('iosDlListBtn'));
  state.window.__zhuijuDownloads('snapshot', [
    { id: 'a', showId: 'fixture', epKey: '0', epLabel: '第1集', title: '测试剧', status: 'running', received: 1, total: 10, path: '', size: 0, name: 'a.mp4' },
    { id: 'b', showId: 'fixture', epKey: '1', epLabel: '第2集', title: '测试剧', status: 'running', received: 0, total: 10, path: '', size: 0, name: 'b.mp4' },
    { id: 'c', showId: 'fixture', epKey: '2', epLabel: '第3集', title: '测试剧', status: 'queued', received: 0, total: 10, path: '', size: 0, name: 'c.mp4' },
  ]);

  const list = state.document.getElementById('iosMineBody');
  const show = list.querySelector('.ip-show');
  assert.equal(list.querySelectorAll('.ip-show').length, 1, '同一部剧只能有一条');
  assert.ok(state.document.getElementById('iosMineQueue'), '运行队列在我的下载里单独显示');
  assert.equal(state.document.getElementById('iosMineQueue').querySelectorAll('.ios-dl-task').length, 3,
    '两集在跑、一集排队，各自一行，按剧名 + 集号显示');
  assert.equal(show.querySelector('.ips-meta').textContent, '已下载 1 集 · 0.0 MB',
    '已有的第19集不能被队列合并弄丢');
  assert.deepEqual(show.parentNode.querySelectorAll('.ip-eptitle').map((episode) => episode.textContent), ['第19集']);
});
