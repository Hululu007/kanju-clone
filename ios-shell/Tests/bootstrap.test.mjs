import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// ios-shell 的 AppBootstrap.js 是 android/app/src/phone/assets/app-bootstrap.js 的移植。
// 这个测试盯住唯一会静默坏掉的东西：/api 请求必须被改写成本源请求。
const source = await readFile(new URL('../ZhuijuH5/AppBootstrap.js', import.meta.url), 'utf8');

function makeElement(tag = 'div') {
  return {
    tagName: String(tag).toUpperCase(),
    textContent: '',
    style: {},
    closest() { return null; },
    setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; },
  };
}

function run({ origin = 'https://zhuiju.dpdns.org', topSelf = true, extra = {} } = {}) {
  const calls = [];
  const listeners = [];
  const documentElement = makeElement('html');
  const head = { appendChild(child) { documentElement.headChild = child; return child; } };
  const document = {
    documentElement,
    head,
    createElement: (tag) => makeElement(tag),
    addEventListener: (name, handler) => listeners.push({ name, handler }),
    readyState: 'complete',
  };
  const window = {
    location: { origin, href: origin + '/' },
    fetch: (input, options) => {
      calls.push({ input, options });
      return Promise.resolve({ ok: true });
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    addEventListener() {},
  };
  window.top = topSelf ? window : { other: true };
  const context = vm.createContext({
    window,
    document,
    URL,
    Request: class Request {
      constructor(url, init) { this.url = String(url); this.init = init; }
    },
    AbortController,
    DOMException,
    setTimeout,
    clearTimeout,
    Object,
    String,
    Array,
    ...extra,
  });
  vm.runInContext(source, context, { filename: 'AppBootstrap.js' });
  return { window, document, calls, listeners };
}

// 1. 站点源：/api 请求改写成本源，并强制 credentials: same-origin
{
  const { window, calls } = run();
  assert.equal(typeof window.fetch, 'function', 'fetch 应该被包装');
  window.fetch('https://kanju-api.kenzhao123.workers.dev/api/home?x=1', { headers: { a: 'b' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'https://zhuiju.dpdns.org/api/home?x=1');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.headers.a, 'b', '原有 options 不能被丢掉');
}

// 2. 非 /api 路径的跨域请求原样放行
{
  const { window, calls } = run();
  window.fetch('https://kanju-api.kenzhao123.workers.dev/health');
  assert.equal(calls[0].input, 'https://kanju-api.kenzhao123.workers.dev/health');
  assert.equal(calls[0].options, undefined);
}

// 3. 同源 /api 请求不动
{
  const { window, calls } = run();
  window.fetch('/api/list');
  assert.equal(calls[0].input, '/api/list');
}

// 4. 老 WebKit 没有 AbortSignal.timeout，脚本要补上（页面里 fetch 依赖它）
{
  let aborted = null;
  function AbortSignalStub() {}
  run({
    extra: {
      AbortSignal: AbortSignalStub,
      AbortController: class {
        constructor() {
          this.signal = { addEventListener() {} };
        }
        abort(reason) { aborted = reason; }
      },
    },
  });
  assert.equal(typeof AbortSignalStub.timeout, 'function', 'AbortSignal.timeout 应该被补齐');
  const signal = AbortSignalStub.timeout(5);
  assert.ok(signal && typeof signal.addEventListener === 'function');
  assert.equal(aborted, null, '超时前不应该 abort');
}

// 5. 横屏布局接管：只在 #player 内的 video 真正播放时给 html 打标记
{
  const { document, listeners } = run();
  assert.ok(document.documentElement.headChild, '应该注入横屏布局样式');
  assert.ok(String(document.documentElement.headChild.textContent).includes('data-app-landscape'));
  const play = listeners.filter((listener) => listener.name === 'play');
  assert.equal(play.length, 1, '应该监听 play 事件');
}

// 6. 非站点源（例如在 Safari 里打开同一个 js）直接退出，不动 fetch
{
  const { window, calls } = run({ origin: 'https://example.com' });
  window.fetch('https://kanju-api.kenzhao123.workers.dev/api/home');
  assert.equal(calls[0].input, 'https://kanju-api.kenzhao123.workers.dev/api/home');
}

// 7. 被 iframe 加载时也退出（只服务主框架）
{
  const { window, calls } = run({ topSelf: false });
  window.fetch('https://kanju-api.kenzhao123.workers.dev/api/home');
  assert.equal(calls[0].input, 'https://kanju-api.kenzhao123.workers.dev/api/home');
}

console.log('ios-shell bootstrap: 7 checks passed');
