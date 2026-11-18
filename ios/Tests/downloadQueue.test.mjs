import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

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
    setAttribute(name, value) { if (name === 'hidden') element.hidden = true; else element[name] = value; },
    getAttribute(name) { return element[name]; },
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
    closest(selector) { return selector === '#' + element.id ? element : null; },
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
  return element;
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
  const document = { readyState: 'loading', visibilityState: 'visible', head, body,
    title: '测试剧 - 看剧AI',
    addEventListener(name, listener) { (listeners[name] ||= []).push(listener); },
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
      if (selector === '.ep.on') return noSelectedEpisode ? null : selected;
      if (selector === '.detail-info h1') return homePage ? null : detailTitle;
      if (selector === '.detail-poster img') return homePage ? null : posterImage;
      if (selector === '[data-action="login"]') return loginTrigger;
      if (selector === '.pp-tabs') return tabRow;
      if (selector === '[data-action="settings"]') return settingsTrigger;
      return null;
    },
    querySelectorAll(selector) {
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
    pageHead, dmButton, phTitle,
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
      const event = { target, preventDefault() {}, stopImmediatePropagation() {} };
      for (const listener of listeners['click'] || []) listener(event);
    },
    emit(name, event) { for (const listener of listeners[name] || []) listener(event); } };
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function batchReply(showId, idx) {
  return json({ showId, idx, episodeNumber: idx + 1, verified: true, kind: 'mp4', url: `https://media.example/${idx}.mp4` });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

test('one tap batch download resolves every episode to its real media url before queueing', async () => {
  const state = fixture({ signedIn: true, episodes: [0, 1, 2] });
  state.ready();
  const bar = state.document.getElementById('iosBatchBar');
  assert.ok(bar, '选集区没有批量下载条');
  state.replies.push(batchReply('fixture', 0), batchReply('fixture', 1), batchReply('fixture', 2));

  state.click(state.document.getElementById('iosBatchAll'));
  await settle();

  const message = state.messages.at(-1);
  assert.equal(message.action, 'downloadBatch');
  assert.equal(message.signedIn, true);
  assert.equal(message.items.length, 3, `三集都要入队：${JSON.stringify(message)}`);
  assert.equal(message.items.map((item) => item.url).join(','),
    'https://media.example/0.mp4,https://media.example/1.mp4,https://media.example/2.mp4',
    '每一集都要用站点解析出来的真实片源，不能拿播放页地址顶替');
  assert.ok(message.items.every((item) => item.url !== 'https://zhuiju.dpdns.org/player/?id=fixture'),
    '播放页 URL 不是视频');
  assert.equal(message.items.map((item) => item.epKey).join(','), '0,1,2', 'showId + 集号是原生队列的去重键');
  assert.equal(message.items.map((item) => item.showId).join(','), 'fixture,fixture,fixture');
  assert.equal(message.items[0].title, '测试剧');
  assert.equal(message.items[1].name, '测试剧 第2集.mp4', '批量下载的文件名也是真实剧名 + 集号');
});

test('an HLS or page-url episode is skipped with a reason instead of being downloaded', async () => {
  const state = fixture({ signedIn: true, episodes: [0, 1, 2] });
  state.ready();
  state.replies.push(
    batchReply('fixture', 0),
    json({ showId: 'fixture', idx: 1, episodeNumber: 2, verified: true, kind: 'hls', url: 'https://media.example/1.m3u8' }),
    json({ showId: 'fixture', idx: 2, episodeNumber: 3, verified: true, kind: 'mp4', url: 'https://zhuiju.dpdns.org/player/?id=fixture&ep=2' })
  );

  state.click(state.document.getElementById('iosBatchAll'));
  await settle();

  const message = state.messages.at(-1);
  assert.equal(message.action, 'downloadBatch');
  assert.equal(message.items.length, 1, `只有真正解析出视频的那一集能入队：${JSON.stringify(message)}`);
  assert.equal(message.items[0].epKey, '0');
  assert.match(state.toastText(), /跳过 2 集/, '跳过的集要如实告诉用户');
});

test('download from the current episode onward starts at the selected episode', async () => {
  const state = fixture({ signedIn: true, episodes: [0, 1, 2, 3, 4] });
  state.ready();
  for (const button of state.epButtons) button.className = 'ep';
  state.epButtons[2].className = 'ep on';
  state.replies.push(batchReply('fixture', 2), batchReply('fixture', 3), batchReply('fixture', 4));

  state.click(state.document.getElementById('iosBatchForward'));
  await settle();

  const message = state.messages.at(-1);
  assert.equal(message.action, 'downloadBatch');
  assert.equal(message.items.map((item) => item.epKey).join(','), '2,3,4',
    '从本集往后：当前集和它后面的每一集，前面的不重复下');
});

test('the selection mode picks episodes for a chosen batch without leaving the page', async () => {
  const state = fixture({ signedIn: true, episodes: [0, 1, 2] });
  state.ready();
  state.click(state.document.getElementById('iosBatchSelect'));
  state.click(state.epButtons[1]);
  assert.match(state.epButtons[1].className, /ios-pick/, '选中的集要有可见标记');
  assert.equal(state.document.getElementById('iosBatchStart').textContent, '下载已选 (1)');
  state.replies.push(batchReply('fixture', 1));

  state.click(state.document.getElementById('iosBatchStart'));
  await settle();
  const message = state.messages.at(-1);
  assert.equal(message.action, 'downloadBatch');
  assert.equal(message.items.map((item) => item.epKey).join(','), '1', '只下用户选中的那一集');
});

test('the settings sheet shows the whole show queue with pause, resume and cancel', () => {
  const state = fixture({ signedIn: true, episodes: [0, 1, 2] });
  state.ready();
  state.click(state.settingsTrigger);
  state.window.__zhuijuDownloads('snapshot', [
    { id: 'a', showId: 'fixture', epKey: '0', epLabel: '第1集', title: '测试剧', status: 'done', received: 100, total: 100, path: '/tmp/a.mp4', size: 100, name: 'a.mp4' },
    { id: 'b', showId: 'fixture', epKey: '1', epLabel: '第2集', title: '测试剧', status: 'running', received: 40, total: 100, path: '', size: 0, name: 'b.mp4' },
    { id: 'c', showId: 'fixture', epKey: '2', epLabel: '第3集', title: '测试剧', status: 'queued', received: 0, total: 100, path: '', size: 0, name: 'c.mp4' }
  ]);
  const item = state.document.getElementById('iosDlShows').children[0];
  assert.ok(item, '队列里的剧要出现在设置面板里');
  const queueNode = item.querySelector('.ios-dl-queue');
  assert.ok(queueNode, '设置里要有整部剧的队列进度');
  const text = queueNode.textContent;
  assert.match(text, /任务 1\/3 集/, `要按整部剧汇总：${text}`);
  assert.match(text, /进行中 1/, text);
  assert.match(text, /排队 1/, text);
  assert.match(text, /总进度 47%/, `总进度按真实字节算：${text}`);
  const actions = item.querySelector('.ios-dl-actions');
  assert.ok(actions && actions.children.length >= 2, '要能暂停整部剧/取消整部剧');
  const pause = actions.children[0];
  state.click(pause);
  assert.equal(state.messages.at(-1).action, 'downloadPause');
  assert.equal(state.messages.at(-1).showId, 'fixture');
});

test('a failed episode never lets the show look complete and an unknown length has no percent', () => {
  const state = fixture({ signedIn: true, episodes: [0, 1] });
  state.ready();
  state.click(state.settingsTrigger);
  state.window.__zhuijuDownloads('snapshot', [
    { id: 'a', showId: 'fixture', epKey: '0', epLabel: '第1集', title: '测试剧', status: 'done', received: 1048576, total: 1048576, path: '/tmp/a.mp4', size: 1048576, name: 'a.mp4' },
    { id: 'b', showId: 'fixture', epKey: '1', epLabel: '第2集', title: '测试剧', status: 'failed', received: 0, total: 0, path: '', size: 0, name: 'b.mp4' },
    { id: 'c', showId: 'fixture', epKey: '2', epLabel: '第3集', title: '测试剧', status: 'paused', received: 1048576, total: 0, path: '', size: 0, name: 'c.mp4' }
  ]);
  const queueNode = state.document.getElementById('iosDlShows').children[0].querySelector('.ios-dl-queue');
  assert.ok(queueNode, '设置里要有整部剧的队列进度');
  const text = queueNode.textContent;
  assert.match(text, /失败 1/, text);
  assert.match(text, /已暂停 1/, text);
  assert.ok(!/全部完成/.test(text), `有一集失败就不能说整部剧完成：${text}`);
  assert.match(text, /已收 2\.0 MB/, '总长度未知时只报实收字节');
  assert.ok(!/%/.test(text), `不知道总长度就不许造百分比：${text}`);
});

/* 复审阻塞（REG-013）：批量 3 集全部 done，队列 3/3、100%，片库却还是「已下载 0/3 集」。
   这里直接用原生真实下发的那几条 done（带 path / showId / epKey / 剧名 / 总集数），
   断言片库按剧写成 3/3、逐集可见，并且重送同一批 done 幂等。 */
test('every finished batch episode lands in the settings library, and replay stays idempotent', async () => {
  const state = fixture({ signedIn: true, episodes: [0, 1, 2] });
  state.ready();
  state.replies.push(batchReply('fixture', 0), batchReply('fixture', 1), batchReply('fixture', 2));

  state.click(state.document.getElementById('iosBatchAll'));
  await settle();
  const message = state.messages.at(-1);
  assert.equal(message.action, 'downloadBatch');
  state.click(state.settingsTrigger);

  const done = (item) => ({
    event: 'done', id: item.id, path: '/tmp/' + item.epKey + '.mp4', name: item.name, size: 2048,
    showId: 'fixture', epKey: item.epKey, ep: item.epLabel,
    title: '测试剧', epLabel: item.epLabel, cover: '', showTotal: '3',
  });
  for (const item of message.items) state.window.__zhuijuDownload(done(item));

  const libraryItem = state.document.getElementById('iosDlShows').children[0];
  assert.ok(libraryItem, '3 集下完，片库里一部剧都没有');
  assert.equal(libraryItem.querySelector('.ios-dl-name').textContent, '测试剧', '片库要用真实剧名');
  assert.equal(libraryItem.querySelector('.ios-dl-count').textContent, '已下载 3/3 集',
    '完成 3 集就得写进片库：' + libraryItem.querySelector('.ios-dl-count').textContent);
  assert.deepEqual(libraryItem.querySelector('.ios-dl-eps').children.map((chip) => chip.textContent),
    ['第1集', '第2集', '第3集'], '每一集都要能单独点开');
  /* 当前这一集就是批量里刚下完的那一集：单集进度行不能还写「尚未下载」 */
  assert.equal(state.document.getElementById('iosDownloadLabel').textContent,
    '下载进度：已完成 · 点下方选择播放器', '批量下完的当前集，单集进度行也要显示已完成');

  /* 换页/重启/重复 backfill 会把同一批 done 再送一遍：不能重复计数，也不能多出集 */
  for (const item of message.items) state.window.__zhuijuDownload(done(item));
  const replay = state.document.getElementById('iosDlShows').children[0];
  assert.equal(replay.querySelector('.ios-dl-count').textContent, '已下载 3/3 集');
  assert.equal(replay.querySelector('.ios-dl-eps').children.length, 3, '重送不能多出集记录');
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
  state.click(state.settingsTrigger);
  state.window.__zhuijuDownloads('snapshot', [
    { id: 'a', showId: 'fixture', epKey: '0', epLabel: '第1集', title: '测试剧', status: 'running', received: 1, total: 10, path: '', size: 0, name: 'a.mp4' },
    { id: 'b', showId: 'fixture', epKey: '1', epLabel: '第2集', title: '测试剧', status: 'running', received: 0, total: 10, path: '', size: 0, name: 'b.mp4' },
    { id: 'c', showId: 'fixture', epKey: '2', epLabel: '第3集', title: '测试剧', status: 'queued', received: 0, total: 10, path: '', size: 0, name: 'c.mp4' },
  ]);

  const list = state.document.getElementById('iosDlShows');
  assert.equal(list.children.length, 1, '同一部剧只能有一条：' + list.children.length);
  const queue = list.children[0].querySelector('.ios-dl-queue');
  assert.ok(queue, '队列进度要挂到已有的片库条目上');
  assert.match(queue.textContent, /任务 0\/3 集/, queue.textContent);
  assert.equal(list.children[0].querySelector('.ios-dl-count').textContent, '已下载 1/3 集',
    '已有的 第19集 不能被队列合并弄丢');
  assert.ok(list.children[0].querySelector('.ios-dl-actions'), '还要能暂停整部剧');
});
