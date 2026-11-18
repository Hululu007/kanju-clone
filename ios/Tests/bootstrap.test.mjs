import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

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
    controls: true, paused: true, duration: 120, currentTime: 0, removed: [],
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

test('layout fallback carries fullscreen, light tabbar and category-card rules', () => {
  const state = fixture(); state.ready();
  const style = state.head.children.find((child) => child.id === 'iosShellStyle');
  assert.ok(style, 'injected style is missing');
  assert.match(style.textContent, /html\[data-ios-immersive\] #player\{position:fixed/);
  assert.match(style.textContent, /html\[data-theme='light'\] \.tabbar \.tab\{color:rgba\(15,20,24/);
  assert.match(style.textContent, /grid-auto-columns:168px/);
  assert.match(style.textContent, /html\[data-ios-immersive\] #playTools\{display:none!important\}/,
    '全屏时那排上方工具条必须整条收起来');
  assert.match(style.textContent, /html\[data-ios-immersive\] #settingsPanel,html\[data-ios-immersive\] #lineBar\{display:none!important\}/);
  assert.match(style.textContent, /html\[data-ios-immersive\] #ppCtrl\{z-index:10003/,
    '全屏控制栏要压在播放器之上并在安全区内');
  assert.match(style.textContent, /html\[data-ios-immersive\] \.tabbar\{display:none!important;visibility:hidden!important;pointer-events:none!important\}/,
    '全屏时底部导航必须隐藏，不能遮挡进度条');
  assert.match(style.textContent, /safe-area-inset-bottom/);
});

test('fullscreen sits at the right end of the control bar and drives native rotation', () => {
  const state = fixture(); state.ready();
  const bar = state.document.getElementById('ppCtrl');
  assert.ok(bar, '自带控制栏没有挂上');
  assert.deepEqual(bar.children.map((child) => child.id),
    ['ppPlay', 'ppTime', 'ppSeek', 'ppCast', 'ppRate', 'ppFull', 'ppCastMenu', 'ppRateMenu'],
    '全屏必须是进度条后面的最后一个按钮，倍速紧挨着它');
  assert.equal(state.video.controls, false, '自带控制栏挂上后必须收起原生控件');
  assert.ok(state.video.removed.includes('controls'));
  assert.deepEqual(state.toolbar.children.map((child) => child.id), ['ppToolDownload', 'dmBtn', 'pipBtn', 'nextEpBtn'],
    '工具条里那个够不到的全屏键必须消失；弹幕按钮的位置换成下载');
  assert.equal(state.dmButton.hidden, true, '弹幕按钮让位给下载，隐藏而不是删除');

  const button = state.document.getElementById('ppFull');
  assert.equal(button.textContent, '全屏');
  assert.equal(state.video.controls, false);

  state.click(button);
  assert.equal(state.attributes['data-ios-immersive'], true);
  assert.equal(button.textContent, '退出全屏');
  assert.equal(state.messages.at(-1).action, 'fullscreen');

  state.click(button);
  assert.equal(state.attributes['data-ios-immersive'], undefined);
  assert.equal(button.textContent, '全屏');
  assert.equal(state.messages.at(-1).action, 'inline');
  assert.equal(state.video.started, 1, '退出全屏后保持播放，避免方向恢复请求被 WebKit 忽略');
});

test('native fullscreen requests are rerouted to the in-page bar', () => {
  const state = fixture(); state.ready();
  state.video.webkitEnterFullscreen();
  assert.equal(state.attributes['data-ios-immersive'], true, '原生全屏入口必须改走页内全屏');
});

test('rate menu offers 2.5x and 3x and applies the chosen one', () => {
  const state = fixture(); state.ready();
  const menu = state.document.getElementById('ppRateMenu');
  assert.deepEqual(menu.children.map((option) => option.dataset.rate), ['1', '1.5', '2', '2.5', '3']);

  state.click(menu.children[3]);
  assert.equal(state.video.playbackRate, 2.5);
  assert.equal(state.document.getElementById('ppRate').textContent, '2.5×');
  assert.equal(state.toastText(), '已切到 2.5×');

  state.click(state.document.getElementById('ppRate'));
  assert.match(state.document.getElementById('ppRateMenu').className, /on/);
  state.click(menu.children[4]);
  assert.equal(state.video.playbackRate, 3);
  assert.doesNotMatch(state.document.getElementById('ppRateMenu').className, /on/, '选完要收起菜单');
});

test('a clamped playback rate is reported instead of pretending 3x works', () => {
  const state = fixture({ maxRate: 2 }); state.ready();
  state.click(state.document.getElementById('ppRateMenu').children[4]);
  assert.equal(state.video.playbackRate, 2);
  assert.equal(state.document.getElementById('ppRate').textContent, '2×');
  assert.match(state.toastText(), /本机最高只支持 2×/);
});

test('control bar follows playback position and seeking', () => {
  const state = fixture(); state.ready();
  state.video.currentTime = 30;
  state.emit('timeupdate', { target: state.video });
  assert.equal(state.document.getElementById('ppTime').textContent, '0:30 / 2:00');
  assert.equal(state.document.getElementById('ppPlay').textContent, '播放');

  const seek = state.document.getElementById('ppSeek');
  seek.value = '500';
  state.emit('input', { target: seek });
  assert.equal(state.video.currentTime, 60);

  state.video.paused = false;
  state.emit('play', { target: state.video });
  assert.equal(state.document.getElementById('ppPlay').textContent, '暂停');
});

test('external playback hands the direct url to the native share sheet', () => {
  const state = fixture(); state.ready();
  state.click(state.document.getElementById('ppCast'));
  state.click(state.document.getElementById('ppShareLink'));
  const message = state.messages.at(-1);
  assert.equal(message.action, 'share');
  assert.equal(message.url, 'https://media.example/19.mp4');
  assert.match(state.toastText(), /系统分享/);
});

test('external playback refuses blob streams and says why', () => {
  const state = fixture(); state.ready();
  state.video.currentSrc = 'blob:https://zhuiju.dpdns.org/9f1c';
  state.click(state.document.getElementById('ppCast'));
  state.click(state.document.getElementById('ppShareLink'));
  assert.equal(state.messages.length, 0, '加密流不能当成直链交出去');
  assert.match(state.toastText(), /加密或临时流/);
});

test('verified playback resolution keeps its direct url available after iOS swaps the source to blob', async () => {
  const state = fixture(); state.ready(); state.replies.push(json(valid));
  await state.window.fetch(play);
  state.video.currentSrc = 'blob:https://zhuiju.dpdns.org/9f1c';
  state.click(state.document.getElementById('ppCast'));
  state.click(state.document.getElementById('ppShareLink'));
  assert.equal(state.messages.at(-1).url, valid.url,
    '外放应复用当前选集已校验的解析地址，而不是把 blob 误判成未解析');
});

test('a one-episode movie uses episode zero for verified direct-link state', async () => {
  const state = fixture({ noSelectedEpisode: true, signedIn: true }); state.ready();
  state.replies.push(json({ ...valid, idx: 0, episodeNumber: 1 }));
  await state.window.fetch('https://kanju-api.kenzhao123.workers.dev/api/play?show=fixture&ep=0&line=official');
  state.video.currentSrc = 'blob:https://zhuiju.dpdns.org/movie';
  state.click(state.document.getElementById('ppCast'));
  const row = state.document.getElementById('ppDownload');
  assert.match(row.children[1].textContent, /开始下载/,
    '单集电影的下载提示应识别已通过校验的第 0 集直链');
  state.click(state.document.getElementById('ppShareLink'));
  assert.equal(state.messages.at(-1).action, 'share');
  assert.equal(state.messages.at(-1).url, valid.url,
    '单集电影应将已验证的第 0 集直链交给分享面板');
});

test('external playback without the app bridge falls back to the system share sheet', () => {
  const state = fixture({ bridge: false }); state.ready();
  state.click(state.document.getElementById('ppCast'));
  state.click(state.document.getElementById('ppShareLink'));
  assert.equal(state.shared.at(-1).url, 'https://media.example/19.mp4');
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
  assert.match(css, /#iosFullBtn\{display:none!important\}/, '站点样式不能把竖屏右上角旧全屏入口重新显示出来');
  assert.match(css, /video::-webkit-media-controls-fullscreen-button\{display:none!important\}/,
    '原生控制栏挂载前也不能闪出右上角全屏键');
});

test('landscape playback becomes immersive without forcing rotation', () => {
  const state = fixture({ landscape: true }); state.ready();
  state.emit('play', { target: state.video });
  assert.equal(state.attributes['data-ios-immersive'], true);
  assert.equal(state.messages.length, 0, 'automatic landscape mode must not re-lock the device');
  state.emit('ended', { target: state.video });
  assert.equal(state.attributes['data-ios-immersive'], undefined);
});

test('portrait playback stays inline until the fullscreen button is used', () => {
  const state = fixture(); state.ready();
  state.emit('play', { target: state.video });
  assert.equal(state.attributes['data-ios-immersive'], undefined);
  assert.equal(state.attributes['data-ios-playing'], true);
});

test('explicit exit wins over automatic landscape immersion', () => {
  const state = fixture({ landscape: true }); state.ready();
  state.emit('play', { target: state.video });
  assert.equal(state.attributes['data-ios-immersive'], true);
  const button = state.document.getElementById('ppFull');
  state.click(button);
  assert.equal(state.attributes['data-ios-immersive'], true);
  state.click(button);
  assert.equal(state.attributes['data-ios-immersive'], undefined);
  assert.equal(button.textContent, '全屏');
  assert.equal(state.messages.at(-1).action, 'inline');
});

/* 0.1.9 回归：退出全屏留下「显式留在页内」的标记，下一次播放/再次横屏都拿不回来，
   于是横屏播放时片名标题和整页页眉一直压在上面，用户只能反复点全屏才对。 */
test('landscape playback goes immersive again after a fullscreen round trip', () => {
  const state = fixture({ landscape: true }); state.ready();
  const button = state.document.getElementById('ppFull');
  state.emit('play', { target: state.video });
  state.click(button);
  state.click(button);
  assert.equal(state.attributes['data-ios-immersive'], undefined, '刚退出全屏时不抢回去');

  /* 用户接着再点播放（换集或重新播放），横屏里标题必须继续收起 */
  state.emit('pause', { target: state.video });
  state.emit('play', { target: state.video });
  assert.equal(state.attributes['data-ios-immersive'], true,
    '再次播放时横屏必须重新进入沉浸态，标题栏不能留在画面上');
});

test('rotating back to landscape during playback restores immersive mode', () => {
  const state = fixture({ landscape: true }); state.ready();
  const button = state.document.getElementById('ppFull');
  state.emit('play', { target: state.video });
  state.click(button);
  state.click(button);
  assert.equal(state.attributes['data-ios-immersive'], undefined);

  state.setLandscape(false);
  state.emit('orientationchange', {});
  state.setLandscape(true);
  state.emit('orientationchange', {});
  assert.equal(state.attributes['data-ios-immersive'], true, '转回横屏播放时标题栏要重新收起');
});

/* 站点的自带控制栏优先用标准全屏 API（player.requestFullscreen），这条路不经过
   data-ios-immersive，所以标题只能靠 :fullscreen 规则和 fullscreenchange 兜住。 */
test('the standard fullscreen api hides the title and keeps immersion in sync', () => {
  const state = fixture(); state.ready();
  const css = state.head.children.find((child) => child.id === 'iosShellStyle').textContent;
  assert.match(css, /:fullscreen[^{]*\.p-label\{display:none!important\}/, '标准全屏里也要收起片名标题');

  state.document.fullscreenElement = state.player;
  state.emit('fullscreenchange', {});
  assert.equal(state.attributes['data-ios-immersive'], true, '进了标准全屏就要同步沉浸态，隐藏标题和工具条');
  state.document.fullscreenElement = null;
  state.emit('fullscreenchange', {});
  assert.equal(state.attributes['data-ios-immersive'], undefined, '退出标准全屏要恢复页内布局');
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

test('fullscreen hides every floating control and restores them on exit', async () => {
  const state = fixture(); state.ready();
  state.video.currentSrc = 'https://media.example/19.mp4';
  state.emit('play', { target: state.video });
  state.click(state.document.getElementById('ppFull'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (const [name, element] of [['工具条', state.toolbar], ['设置面板', state.settingsPanel], ['底部导航', state.tabbar],
    ['线路面板', state.lineBar], ['提示行', state.hint], ['站点头栏', state.pageHead]]) {
    assert.equal(element.hidden, true, '全屏里 ' + name + ' 应该收起');
    assert.equal(element.style.display, 'none');
  }
  /* 全屏里的全屏键必须改叫「退出全屏」：读屏/自动化不能再看到一个「全屏播放」入口 */
  const full = state.document.getElementById('ppFull');
  assert.equal(full.textContent, '退出全屏');
  assert.equal(full['aria-label'], '退出全屏');
  state.click(full);
  await new Promise((resolve) => setTimeout(resolve, 5));
  /* 工具条和提示行要原样回来 */
  for (const [name, element] of [['工具条', state.toolbar], ['底部导航', state.tabbar], ['提示行', state.hint],
    ['站点头栏', state.pageHead]]) {
    assert.equal(element.hidden, false, '退出全屏后 ' + name + ' 应该恢复');
    assert.equal(element.style.display, '', '恢复时不能留下 display:none 的尾巴');
  }
  /* 设置/线路面板是进全屏时主动关掉的（0.1.4 起就这么做），
     退出后保持关闭，不该被「恢复」逻辑重新弹出来 */
  for (const [name, element] of [['设置面板', state.settingsPanel], ['线路面板', state.lineBar]]) {
    assert.equal(element.hidden, true, name + ' 进全屏被关掉，退出后不应自己弹出来');
  }
  assert.equal(full.textContent, '全屏');
  assert.equal(full['aria-label'], '全屏播放');
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

test('entering fullscreen closes the top toolbar panels', () => {
  const state = fixture(); state.ready();
  assert.equal(state.settingsPanel.hidden, false);
  state.click(state.document.getElementById('ppFull'));
  assert.equal(state.settingsPanel.hidden, true, '全屏里不该留着显示设置面板');
  assert.equal(state.lineBar.hidden, true, '全屏里不该留着线路面板');
  state.click(state.document.getElementById('ppFull'));
  assert.equal(state.settingsPanel.hidden, true, '退出全屏不该自己把面板弹回来');
});

test('cast menu lists share, copy and download, and hides the player row until a file exists', () => {
  const state = fixture(); state.ready();
  const menu = state.document.getElementById('ppCastMenu');
  assert.deepEqual(menu.children.map((row) => row.id),
    ['ppPlayExternal', 'ppShareLink', 'ppCopyLink', 'ppDownload', 'ppDownloadProgress', 'ppOpenLocal'],
    '第三方播放器排第一行，后面才是分享/复制/下载');
  assert.equal(state.document.getElementById('ppOpenLocal').hidden, true, '还没下载就没有「用其他播放器打开」');
  assert.equal(state.document.getElementById('ppCast').textContent, '外放');

  state.click(state.document.getElementById('ppCast'));
  assert.match(state.document.getElementById('ppCastMenu').className, /on/);
  state.click(state.document.getElementById('ppCast'));
  assert.doesNotMatch(state.document.getElementById('ppCastMenu').className, /on/, '再点一次要收起');
});

test('copy link puts the direct url on the clipboard', async () => {
  const state = fixture(); state.ready();
  state.click(state.document.getElementById('ppCast'));
  state.click(state.document.getElementById('ppCopyLink'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(state.shared.at(-1), { copied: 'https://media.example/19.mp4' });
  assert.match(state.toastText(), /播放地址已复制/);
  assert.equal(state.messages.length, 0, '复制不该弹原生面板');
});

test('download without an account asks for login and never starts a transfer', () => {
  const state = fixture(); state.ready();
  state.click(state.document.getElementById('ppCast'));
  state.click(state.document.getElementById('ppDownload'));
  assert.equal(state.messages.length, 0, '未登录不允许发出任何下载请求');
  assert.equal(state.calls.length, 0, '未登录也不许自己发 fetch');
  assert.equal(state.loginTrigger.opens, 1, '要顺手打开站点自己的登录弹窗');
  assert.equal(state.toastText(), '登录后才能下载本集');
  assert.equal(state.document.getElementById('ppCast').textContent, '外放');
});

test('download with an account hands the direct url to the native transfer', () => {
  const state = fixture({ signedIn: true }); state.ready();
  state.click(state.document.getElementById('ppCast'));
  state.click(state.document.getElementById('ppDownload'));
  const message = state.messages.at(-1);
  assert.equal(message.action, 'download');
  assert.equal(message.url, 'https://media.example/19.mp4');
  assert.equal(message.name, '测试剧 第19集.mp4');
  assert.equal(message.signedIn, true);
  assert.ok(message.id, '每个下载任务要有自己的 id');
  assert.equal(state.document.getElementById('ppCast').textContent, '下载 0%');
  assert.equal(state.loginTrigger.opens, 0, '已登录就不要再弹登录');
});

test('download progress appears in settings panel and completion exposes external player choice', () => {
  const state = fixture({ signedIn: true }); state.ready();
  state.click(state.document.getElementById('ppDownload'));
  const { id } = state.messages.at(-1);
  state.window.__zhuijuDownload({ id, event: 'progress', received: 43, total: 100 });
  assert.equal(state.document.getElementById('ppCast').textContent, '下载 43%');
  assert.equal(state.downloadLabel.textContent, '下载进度：43%');
  assert.equal(state.downloadFill.style.width, '43%');

  state.window.__zhuijuDownload({ id, event: 'done', path: '/tmp/追剧AI_第19集.mp4', name: '追剧AI_第19集.mp4', size: 104857600 });
  assert.equal(state.document.getElementById('ppCast').textContent, '外放');
  assert.equal(state.document.getElementById('ppCtrl').children.find((row) => row.id === 'ppCastMenu').children.find((row) => row.id === 'ppOpenLocal').hidden, false, '下载完才能交给播放器 App');
  assert.equal(state.downloadOpen.hidden, false, '设置面板提供系统播放器选择入口');
  assert.equal(state.downloadFill.style.width, '100%');
  assert.match(state.toastText(), /已下载/);
  assert.match(state.toastText(), /100\.0 MB/);
  state.click(state.downloadOpen);
  assert.equal(state.messages.at(-1).action, 'openLocal', '按钮将本地视频交给用户选择播放器的系统面板');
});

test('download failure and cancellation both land back on a usable button', () => {
  const state = fixture({ signedIn: true }); state.ready();
  state.click(state.document.getElementById('ppDownload'));
  const { id } = state.messages.at(-1);

  state.click(state.document.getElementById('ppDownload'));
  assert.equal(state.messages.at(-1).action, 'cancelDownload');
  assert.equal(state.messages.at(-1).id, id);

  state.window.__zhuijuDownload({ id, event: 'failed', reason: '网络中断' });
  assert.equal(state.document.getElementById('ppCast').textContent, '外放');
  assert.match(state.toastText(), /下载失败：网络中断/);
});

test('download refuses HLS playlists and encrypted streams', () => {
  const hls = fixture({ signedIn: true }); hls.ready();
  hls.video.currentSrc = 'https://media.example/19.m3u8';
  hls.click(hls.document.getElementById('ppDownload'));
  assert.equal(hls.messages.length, 0);
  assert.match(hls.toastText(), /HLS/);

  const blob = fixture({ signedIn: true }); blob.ready();
  blob.video.currentSrc = 'blob:https://zhuiju.dpdns.org/9f1c';
  blob.click(blob.document.getElementById('ppDownload'));
  assert.equal(blob.messages.length, 0);
  assert.match(blob.toastText(), /加密或临时流/);
});

test('a stale download id cannot rewrite the current state', () => {
  const state = fixture({ signedIn: true }); state.ready();
  state.click(state.document.getElementById('ppDownload'));
  const { id } = state.messages.at(-1);
  state.window.__zhuijuDownload({ id: id + 'old', event: 'done', path: '/tmp/old.mp4', size: 1 });
  assert.equal(state.document.getElementById('ppCast').textContent, '下载 0%');
  assert.equal(state.document.getElementById('ppOpenLocal').hidden, true);
});

test('a played episode keeps its direct url after the player element is rebuilt', async () => {
  const state = fixture(); state.ready();
  state.video.currentSrc = 'https://media.example/19.mp4';
  state.video.src = 'https://media.example/19.mp4';
  state.emit('loadedmetadata', { target: state.video });
  state.emit('play', { target: state.video });
  /* 站点重新渲染播放器：新的 <video> 还没解析出地址 */
  state.video.currentSrc = '';
  state.video.src = '';
  state.video.removeAttribute('src');
  const player = state.document.getElementById('ppCtrl');
  assert.ok(player, '控制栏应该还在');
  state.click(state.document.getElementById('ppCast'));
  state.click(state.document.getElementById('ppCopyLink'));
  assert.deepEqual(state.shared[0], { copied: 'https://media.example/19.mp4' },
    '同一集内要用记住的直链，不能说「还没解析出直链」');
});

test('an unresolved episode is not mistaken for a media url', () => {
  const state = fixture(); state.ready();
  // 站点还没解析出直链时，空的 <source src=""> 会被浏览器解析成当前页面地址
  state.video.currentSrc = '';
  state.video.src = '';
  state.video.querySelector = (selector) => (selector === 'source' ? { getAttribute: () => '' } : null);
  state.click(state.document.getElementById('ppCopyLink'));
  assert.deepEqual(state.shared, [], '不能把页面地址当成片源复制出去');
  assert.match(state.toastText(), /还没拿到直链/);
});

test('the player page url is refused even when it fills the source tag', () => {
  const state = fixture(); state.ready();
  state.video.currentSrc = '';
  state.video.src = '';
  state.video.querySelector = (selector) =>
    (selector === 'source' ? { getAttribute: () => 'https://zhuiju.dpdns.org/player/?id=fixture' } : null);
  state.click(state.document.getElementById('ppCast'));
  state.click(state.document.getElementById('ppShareLink'));
  assert.equal(state.messages.length, 0, '页面地址不能当片源交给别的 App');
  assert.match(state.toastText(), /还没拿到直链/);
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
test('the home page settings panel shows the download progress', () => {
  const state = fixture({ homePage: true }); state.ready();
  const trigger = state.document.querySelector('[data-action="settings"]');
  assert.ok(trigger, '首页必须有设置入口');
  assert.equal(state.sheet(), null, '还没点之前不该有面板盖在页面');

  state.click(trigger);
  const sheet = state.sheet();
  assert.ok(sheet, '首页也要有能打开的设置面板');
  assert.equal(sheet.hidden, false, '点了设置就要打开');
  assert.ok(sheet.className.includes('on'));
  assert.match(state.document.getElementById('iosDownloadLabel').textContent, /下载进度/);

  state.click(state.document.getElementById('iosSettingsClose'));
  assert.equal(sheet.hidden, true, '关闭按钮要能收起面板');
});

/* 下载在原生层跑，换页不会停；进度必须先落到 localStorage，再在新页面接上，
   否则从播放页回首页时进度条永远是「尚未下载」。 */
test('a running download keeps reporting progress after going back home', () => {
  const state = fixture({
    homePage: true,
    seed: { 'kj-ios-download': JSON.stringify({ id: 'dl9', name: '追剧AI_第3集.mp4', busy: true, percent: 42, state: 'running' }) },
  });
  state.ready();
  assert.match(state.document.getElementById('iosDownloadLabel').textContent, /42%/);
  assert.equal(state.document.getElementById('iosDownloadFill').style.width, '42%');

  state.window.__zhuijuDownload({ event: 'progress', id: 'dl9', received: 60, total: 100 });
  assert.match(state.document.getElementById('iosDownloadLabel').textContent, /60%/);
  assert.equal(state.document.getElementById('iosDownloadFill').style.width, '60%');
  assert.match(JSON.parse(state.storage['kj-ios-download']).percent ? '60' : 'x', /60/);

  state.window.__zhuijuDownload({ event: 'done', id: 'dl9', path: '/tmp/追剧AI_第3集.mp4', name: '追剧AI_第3集.mp4', size: 104857600 });
  assert.equal(state.document.getElementById('iosOpenDownloaded').hidden, false, '下完就要能交给播放器 App');
  assert.equal(JSON.parse(state.storage['kj-ios-download']).state, 'done');

  state.click(state.document.getElementById('iosOpenDownloaded'));
  assert.equal(state.messages.at(-1).action, 'openLocal');
  assert.equal(state.messages.at(-1).path, '/tmp/追剧AI_第3集.mp4');
});

/* ---------- 0.1.9 回归：默认用第三方播放器 ---------- */

/* 用户的原话是「默认用第三方播放器播放，不要都卡在外放那里」：
   点「外放」就该直接把这一集交给系统播放器列表，而不是再进一层菜单。 */
test('the cast button hands the episode to a third-party player in one tap by default', () => {
  const state = fixture({ externalPlayerDefault: true }); state.ready();
  state.emit('play', { target: state.video });
  state.click(state.document.getElementById('ppCast'));

  const message = state.messages.at(-1);
  assert.equal(message.action, 'share', '一次点击就把直链交给系统播放器列表');
  assert.equal(message.url, 'https://media.example/19.mp4');
  assert.equal(state.video.paused, true, '交接后 App 内必须暂停，不能继续在外放出声');
  assert.equal(state.storage['kj-ios-ext-player'], '1', '用过一次要记住这个默认');
  assert.match(state.toastText(), /播放器/);
});

test('a long press on the cast button still opens the full menu', () => {
  const state = fixture({ externalPlayerDefault: true }); state.ready();
  state.emit('play', { target: state.video });
  const cast = state.document.getElementById('ppCast');
  state.touch('touchstart', cast, 300, 700);
  /* 长按计时器到点后打开菜单，暂停的播放不能被当成「已经交接」 */
  return new Promise((resolve) => setTimeout(resolve, 760)).then(() => {
    assert.match(state.document.getElementById('ppCastMenu').className, /on/);
    assert.equal(state.messages.length, 0, '长按只是打开菜单，不要偷偷交接');
  });
});

test('the cast menu always starts with the third-party player row', () => {
  const state = fixture({ signedIn: true }); state.ready();
  const menu = state.document.getElementById('ppCastMenu');
  assert.deepEqual(menu.children.map((row) => row.id),
    ['ppPlayExternal', 'ppShareLink', 'ppCopyLink', 'ppDownload', 'ppDownloadProgress', 'ppOpenLocal'],
    '第三方播放器要排在第一行：这是用户默认想走的那条路');
  assert.equal(state.document.getElementById('ppOpenLocal').hidden, true);

  state.click(state.document.getElementById('ppPlayExternal'));
  const message = state.messages.at(-1);
  assert.equal(message.action, 'share');
  assert.equal(message.url, 'https://media.example/19.mp4');
});

test('HLS lines can still be played by an external player even though they cannot be downloaded', () => {
  const state = fixture({ signedIn: true }); state.ready();
  state.video.currentSrc = 'https://media.example/19.m3u8';
  state.click(state.document.getElementById('ppPlayExternal'));
  assert.equal(state.messages.at(-1).action, 'share', '第三方播放器认得 HLS');
  assert.equal(state.messages.at(-1).url, 'https://media.example/19.m3u8');
});

test('the settings panel can switch the default player back to the app', () => {
  const state = fixture({ externalPlayerDefault: true }); state.ready();
  state.click(state.settingsTrigger);
  assert.equal(state.document.getElementById('iosExtToggle').textContent, '播放方式：第三方播放器');
  state.click(state.document.getElementById('iosExtToggle'));
  assert.equal(state.storage['kj-ios-ext-player'], '0');
  assert.equal(state.document.getElementById('iosExtToggle').textContent, '播放方式：App 内播放');

  state.emit('play', { target: state.video });
  state.click(state.document.getElementById('ppCast'));
  assert.match(state.document.getElementById('ppCastMenu').className, /on/, '关掉默认后「外放」回到菜单');
  assert.equal(state.messages.length, 0);
});

/* 进度块只有一个，必须跟着用户眼前那一面走：设置面板开着就在面板里，
   收起后回到播放器的「显示设置」，不能出现两份对不上的状态。 */
test('the download block follows whichever settings panel is open', () => {
  const state = fixture({ signedIn: true }); state.ready();
  state.click(state.document.getElementById('ppDownload'));
  const { id } = state.messages.at(-1);
  state.window.__zhuijuDownload({ id, event: 'progress', received: 30, total: 100 });
  assert.ok(state.settingsPanel.children.includes(state.document.getElementById('iosDownloadStatus')),
    '平时进度块在播放器的「显示设置」里');

  state.click(state.settingsTrigger);
  const body = state.document.getElementById('iosSettingsBody');
  const box = state.document.getElementById('iosDownloadStatus');
  assert.ok(body.children.includes(box), '面板打开时进度块要在面板里');
  assert.equal(state.document.getElementById('iosDownloadLabel').textContent, '下载进度：30%');
  assert.equal(state.document.getElementById('iosDownloadFill').style.width, '30%');

  state.click(state.document.getElementById('iosSettingsClose'));
  assert.equal(body.children.includes(box), false, '面板收起后不该还占着面板的 DOM');
  assert.ok(state.settingsPanel.children.includes(box), '收起后进度块回到播放器设置里');
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
test('a burst of progress events never loses the finished state on disk', () => {
  const state = fixture({ signedIn: true }); state.ready();
  state.click(state.document.getElementById('ppDownload'));
  const { id } = state.messages.at(-1);
  for (const percent of [5, 17, 33, 48, 66, 84]) {
    state.window.__zhuijuDownload({ id, event: 'progress', received: percent, total: 100 });
  }
  assert.equal(state.document.getElementById('iosDownloadLabel').textContent, '下载进度：84%',
    '界面必须是最新一次进度，不能被限流拖住');

  state.window.__zhuijuDownload({ id, event: 'done', path: '/tmp/追剧AI_第19集.mp4', name: '追剧AI_第19集.mp4', size: 10485760 });
  const saved = JSON.parse(state.storage['kj-ios-download']);
  assert.equal(saved.state, 'done');
  assert.equal(saved.percent, 100);
  assert.equal(saved.path, '/tmp/追剧AI_第19集.mp4');
});

/* 真机上压在画面顶上的不是播放器里那行小字，而是站点头栏 `pageHead()`：
   返回箭头 + 片名 + 主题 + 菜单。0.1.10 漏了它，横屏全屏里「百日谎言」一直挂着。 */
test('immersive hides the site page header that carries the film title', () => {
  const state = fixture({ landscape: true }); state.ready();
  assert.equal(state.pageHead.hidden, false);
  state.emit('play', { target: state.video });
  assert.equal(state.attributes['data-ios-immersive'], true);
  assert.equal(state.pageHead.hidden, true, '横屏播放时片名头栏必须收起');
  assert.equal(state.pageHead.style.display, 'none');
  const css = state.head.children.find((child) => child.id === 'iosShellStyle').textContent;
  assert.match(css, /html\[data-ios-immersive\] \.page-head\{display:none!important\}/,
    '头栏要单独一条规则收起来：它和播放器不在同一个层叠上下文里');
  state.emit('ended', { target: state.video });
  assert.equal(state.pageHead.hidden, false, '退出沉浸后头栏要回来，否则回不去上一页');
  assert.equal(state.pageHead.style.display, '');
});

/* 用户要求：把播放器下方那排工具里的「弹幕」换成「下载」，因为下载入口藏进「外放」后找不到了。 */
test('the toolbar download button takes the danmaku slot and drives the transfer', () => {
  const state = fixture({ signedIn: true }); state.ready();
  const button = state.document.getElementById('ppToolDownload');
  assert.ok(button, '工具条上必须有下载按钮');
  assert.equal(state.dmButton.hidden, true, '弹幕按钮让位');
  assert.equal(state.toolbar.children[0].id, 'ppToolDownload', '下载占用弹幕那一格，位置不变');
  assert.equal(button.textContent, '下载本集');

  state.click(button);
  const message = state.messages.at(-1);
  assert.equal(message.action, 'download');
  assert.equal(message.url, 'https://media.example/19.mp4');
  assert.equal(button.textContent, '下载 0%');

  state.window.__zhuijuDownload({ id: message.id, event: 'progress', received: 43, total: 100 });
  assert.equal(button.textContent, '下载 43%', '进度要显示在按钮上，用户点一下就知道在跑');

  state.window.__zhuijuDownload({ id: message.id, event: 'done', path: '/tmp/追剧AI_第19集.mp4', name: '追剧AI_第19集.mp4', size: 10485760 });
  /* 0.1.12 这里断言的是「变成用播放器打开」——那正是 REG-008 的真机回归，不是需求。
     这一格必须一直是下载入口；播放器入口在「外放」菜单和设置面板里。 */
  assert.equal(button.textContent, '下载本集', '下完一集之后这一格还是下载入口');
  state.click(button);
  assert.equal(state.messages.at(-1).action, 'download', '下完再点也是下载，不是交给播放器');
  assert.equal(state.messages.at(-1).path, undefined);
});

test('the toolbar download button asks for login instead of transferring', () => {
  const state = fixture(); state.ready();
  const button = state.document.getElementById('ppToolDownload');
  state.click(button);
  assert.equal(state.messages.length, 0, '未登录不许发起传输');
  assert.equal(state.loginTrigger.opens, 1, '要顺手打开站点登录弹窗');
  assert.match(state.toastText(), /登录后才能下载/);
});

/* ---------- REG-006 设置里的「下载」要像片库，不是一条临时进度 ---------- */

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

test('the settings sheet lists downloaded shows with covers, episodes and totals', () => {
  const state = fixture({ homePage: true, seed: { 'kj-ios-downloads': JSON.stringify(librarySeed) } });
  state.ready();
  state.click(state.document.querySelector('[data-action="settings"]'));

  const library = state.document.getElementById('iosDownloadLibrary');
  assert.ok(library, '设置面板里要有「下载」片库');
  assert.equal(library.hidden, false, '有下载记录时片库必须显示');
  const list = state.document.getElementById('iosDlShows');
  const items = list.querySelectorAll('.ios-dl-show');
  assert.equal(items.length, 2, '两部片子各占一条');

  const show = items[0];
  const cover = show.querySelector('.ios-dl-cover');
  assert.ok(cover, '片名旁边要有封面');
  assert.equal(cover.src, 'https://zhuiju.dpdns.org/posters/a.jpg');
  assert.equal(cover.alt, '百日谎言');
  assert.equal(show.querySelector('.ios-dl-name').textContent, '百日谎言');
  assert.equal(show.querySelector('.ios-dl-count').textContent, '已下载 2/12 集');
  const chips = show.querySelector('.ios-dl-eps').querySelectorAll('.ios-dl-ep');
  assert.deepEqual(chips.map((chip) => chip.textContent), ['第19集', '第20集'], '每部剧要列出下了哪几集');

  const movie = items[1];
  assert.equal(movie.querySelector('.ios-dl-cover'), null, '没有封面就不摆一张假图');
  assert.equal(movie.querySelector('.ios-dl-count').textContent, '已下载 1 集', '总集数未知时不许编一个分母');
  assert.equal(movie.querySelector('.ios-dl-eps').querySelectorAll('.ios-dl-ep')[0].textContent, '正片');
});

test('the download library stays out of the way when nothing was downloaded', () => {
  const state = fixture({ homePage: true });
  state.ready();
  state.click(state.document.querySelector('[data-action="settings"]'));
  const library = state.document.getElementById('iosDownloadLibrary');
  assert.ok(library, '结构在，但不该占着位置');
  assert.equal(library.hidden, true, '没下过东西就别只挂一个空的「下载」标题');
});

test('a finished download joins the library with its show, episode and total', () => {
  const state = fixture({ signedIn: true, episodes: ['18'] });
  state.ready();
  state.click(state.document.getElementById('ppToolDownload'));
  const message = state.messages.at(-1);
  assert.equal(message.action, 'download');
  state.window.__zhuijuDownload({ id: message.id, event: 'done', path: '/tmp/x.mp4', name: '追剧AI_第19集.mp4', size: 10485760 });

  const saved = JSON.parse(state.storage['kj-ios-downloads']);
  assert.equal(saved.shows.length, 1, '下完一集就要记进片库');
  assert.equal(saved.shows[0].title, '测试剧', '用详情页标题当剧名，不用文件名');
  assert.equal(saved.shows[0].cover, 'https://zhuiju.dpdns.org/posters/fixture.jpg');
  assert.equal(saved.shows[0].total, 1, '选集按钮数就是已知总集数');
  assert.equal(saved.shows[0].eps[0].label, '第19集');
  assert.equal(saved.shows[0].eps[0].path, '/tmp/x.mp4');

  state.click(state.document.querySelector('[data-action="settings"]'));
  const item = state.document.getElementById('iosDlShows').querySelector('.ios-dl-show');
  assert.equal(item.querySelector('.ios-dl-count').textContent, '已下载 1/1 集');

  /* 换页/重启：状态落在 localStorage，新页面靠它把片库摆回来 */
  const reloaded = fixture({ homePage: true, seed: { 'kj-ios-downloads': state.storage['kj-ios-downloads'] } });
  reloaded.ready();
  reloaded.click(reloaded.document.querySelector('[data-action="settings"]'));
  const again = reloaded.document.getElementById('iosDlShows').querySelector('.ios-dl-show');
  assert.ok(again, '重启后片库还要在');
  assert.equal(again.querySelector('.ios-dl-count').textContent, '已下载 1/1 集');
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
  state.click(state.document.querySelector('[data-action="settings"]'));
  const running = state.document.getElementById('iosDlRunning');
  assert.ok(running, '正在下载的那一集要有一行');
  assert.equal(running.hidden, false);
  assert.match(running.textContent, /正在下载/);
  assert.match(running.textContent, /百日谎言/, '要说是哪部剧');
  assert.match(running.textContent, /第21集/, '还要说是哪一集');
  assert.match(running.textContent, /42%/, '进度要实时');

  state.window.__zhuijuDownload({ id: 'dl9', event: 'progress', received: 60, total: 100 });
  assert.match(state.document.getElementById('iosDlRunning').textContent, /60%/);

  state.window.__zhuijuDownload({ id: 'dl9', event: 'done', path: '/tmp/a21.mp4', name: '追剧AI_第21集.mp4', size: 3 });
  const saved = JSON.parse(state.storage['kj-ios-downloads']);
  const show = saved.shows.find((entry) => entry.title === '百日谎言');
  assert.equal(show.total, 12, '站点给过的总集数不能被一次完成事件抹掉');
  assert.deepEqual(show.eps.map((entry) => entry.label), ['第19集', '第20集', '第21集'], '按集号排队，不丢旧记录');
});

/* ---------- REG-007 后台下载：网页要把「哪部剧的哪一集」交给原生 ---------- */

test('the download request carries the show info the native side needs after a relaunch', () => {
  const state = fixture({ signedIn: true, episodes: ['18'] });
  state.ready();
  state.click(state.document.getElementById('ppToolDownload'));
  const message = state.messages.at(-1);
  assert.equal(message.action, 'download');
  assert.ok(message.meta, '下载请求要带剧名/封面/总集数：换页或重启后原生才知道这一集属于哪部剧');
  assert.equal(message.meta.title, '测试剧');
  assert.equal(message.meta.cover, 'https://zhuiju.dpdns.org/posters/fixture.jpg');
  assert.equal(String(message.meta.total), '1', '总集数来自选集按钮，不能编');
  assert.equal(message.meta.epLabel, '第19集');
  assert.equal(String(message.meta.epKey), '18');
});

/* ---------- REG-008 工具条那一格永远是下载，不变播放器入口 ---------- */

test('the toolbar download button never turns into the player entry', () => {
  const state = fixture({ signedIn: true, episodes: ['18'] });
  state.ready();
  const button = state.document.getElementById('ppToolDownload');
  assert.equal(button.textContent, '下载本集');

  state.click(button);
  const message = state.messages.at(-1);
  assert.equal(message.action, 'download');
  state.window.__zhuijuDownload({ id: message.id, event: 'done', path: '/tmp/x.mp4', name: '追剧AI_第19集.mp4', size: 10 });
  assert.equal(button.textContent, '下载本集', '下完一集之后这一格还要是下载入口');

  /* 再点一次仍然是下载（会开一条新任务），不是把文件交给播放器 */
  state.click(button);
  assert.equal(state.messages.at(-1).action, 'download', '下完再点也是下载，不是 openLocal');
  assert.equal(state.messages.at(-1).path, undefined);
  assert.equal(button.textContent, '下载 0%');
});

/* ---------- REG-009 文件名/列表/通知用真实剧名 ---------- */

test('the download file is named after the show, not the app', () => {
  const state = fixture({ signedIn: true, episodes: ['18'] });
  state.ready();
  state.click(state.document.getElementById('ppToolDownload'));
  const message = state.messages.at(-1);
  assert.equal(message.name, '测试剧 第19集.mp4');
  assert.ok(!/追剧AI/.test(message.name), '文件名里不能再用 App 名冒充剧名');
});
