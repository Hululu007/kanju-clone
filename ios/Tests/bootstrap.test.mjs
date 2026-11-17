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
    appendChild(child) { child.parentNode = element; element.children.push(child); return child; },
    insertBefore(child, reference) {
      const index = element.children.indexOf(reference);
      child.parentNode = element;
      element.children.splice(index < 0 ? element.children.length : index, 0, child);
      return child;
    },
    setAttribute(name, value) { element[name] = value; },
    getAttribute(name) { return element[name]; },
    removeAttribute(name) { delete element[name]; },
    get nextSibling() {
      const siblings = element.parentNode ? element.parentNode.children : [];
      const index = siblings.indexOf(element);
      return index >= 0 ? siblings[index + 1] : undefined;
    },
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

function fixture({ origin = 'https://zhuiju.dpdns.org', storageThrows = false, landscape = false, keyword = '', search = '?id=fixture', episodes = [], playRejects = false, maxRate = 0, bridge = true, signedIn = false } = {}) {
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
  const hint = node('p');
  hint.id = 'playHint';
  hint.textContent = '';
  const epMore = node('button');
  epMore.id = 'epMore';
  const settingsPanel = node('div');
  settingsPanel.id = 'settingsPanel';
  settingsPanel.hidden = false;
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
  const idIndex = new Map();
  body.appendChild = (child) => {
    child.parentNode = body;
    body.children.push(child);
    if (child.id) idIndex.set(child.id, child);
    return child;
  };
  const document = { readyState: 'loading', visibilityState: 'visible', head, body,
    addEventListener(name, listener) { (listeners[name] ||= []).push(listener); },
    removeEventListener(name, listener) {
      const list = listeners[name] || [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    },
    getElementById(id) {
      if (idIndex.has(id)) return idIndex.get(id);
      if (id === 'video') return video;
      if (id === 'playTools') return toolbar;
      if (id === 'q') return searchInput;
      if (id === 'playHint') return hint;
      if (id === 'epMore') return epMore;
      if (id === 'settingsPanel') return settingsPanel;
      if (id === 'lineBar') return lineBar;
      if (id === 'epGrid') return epGrid;
      if (id === 'days') return days;
      if (id === 'player') return player;
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
      return walk(toolbar) || walk(player);
    },
    createElement(tag) { return node(tag); },
    querySelector(selector) {
      if (selector === '.ep.on') return selected;
      if (selector === '[data-action="login"]') return loginTrigger;
      if (selector === '.pp-tabs') return tabRow;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.ep') return epButtons;
      if (selector === '.pp-tab') return tabButtons;
      if (selector === '.sb-name') return [sbName];
      if (selector === '.sb-sub') return [sbSub];
      if (selector === '.acct-name') return [acctName];
      if (selector === '#playTools') return [toolbar];
      if (selector === '#settingsPanel') return [settingsPanel];
      if (selector === '#lineBar') return [lineBar];
      if (selector === '#pipBtn') return [pipButton];
      if (selector === '#nextEpBtn') return [nextButton];
      if (selector === '#player .p-label') return [];
      if (selector === '.pp-toolbar' || selector === '.dm-input' || selector === '#dmInputWrap') return [];
      if (selector === '.pp-hint' || selector === '#playHint') return [hint];
      return [];
    },
    documentElement: {
      setAttribute(name) { attributes[name] = true; },
      removeAttribute(name) { delete attributes[name]; },
      hasAttribute(name) { return !!attributes[name]; },
    } };
  const window = { location: { origin, protocol: 'https:', hostname: new URL(origin).hostname,
    href: origin + '/player/?id=fixture', pathname: '/player/', search, replace(value) { redirects.push(value); } },
    innerWidth: landscape ? 844 : 390,
    innerHeight: landscape ? 390 : 844,
    matchMedia(query) { return { matches: landscape && /landscape/.test(query) }; },
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
  const storage = { 'kj-speed': '2' };
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
    settingsPanel, lineBar, tabRow, tabButtons, clicked, sbName, sbSub, acctName,
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
  assert.deepEqual(state.toolbar.children.map((child) => child.id), ['pipBtn', 'nextEpBtn'],
    '工具条里那个够不到的全屏键必须消失');

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
  for (const [name, element] of [['工具条', state.toolbar], ['设置面板', state.settingsPanel],
    ['线路面板', state.lineBar], ['提示行', state.hint]]) {
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
  for (const [name, element] of [['工具条', state.toolbar], ['提示行', state.hint]]) {
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
    ['ppShareLink', 'ppCopyLink', 'ppDownload', 'ppOpenLocal']);
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
  assert.equal(message.name, '追剧AI_第19集.mp4');
  assert.equal(message.signedIn, true);
  assert.ok(message.id, '每个下载任务要有自己的 id');
  assert.equal(state.document.getElementById('ppCast').textContent, '下载 0%');
  assert.equal(state.loginTrigger.opens, 0, '已登录就不要再弹登录');
});

test('download progress and completion are reported on the control bar', () => {
  const state = fixture({ signedIn: true }); state.ready();
  state.click(state.document.getElementById('ppDownload'));
  const { id } = state.messages.at(-1);
  state.window.__zhuijuDownload({ id, event: 'progress', received: 43, total: 100 });
  assert.equal(state.document.getElementById('ppCast').textContent, '下载 43%');

  state.window.__zhuijuDownload({ id, event: 'done', path: '/tmp/追剧AI_第19集.mp4', name: '追剧AI_第19集.mp4', size: 104857600 });
  assert.equal(state.document.getElementById('ppCast').textContent, '外放');
  assert.equal(state.document.getElementById('ppOpenLocal').hidden, false, '下载完才能交给播放器 App');
  assert.match(state.toastText(), /已下载/);
  assert.match(state.toastText(), /100\.0 MB/);
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
