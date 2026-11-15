import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../ZhuijuAI/AppBootstrap.js', import.meta.url), 'utf8');
function fixture({ origin = 'https://zhuiju.dpdns.org', storageThrows = false } = {}) {
  const listeners = {};
  const replies = [];
  const calls = [];
  const redirects = [];
  const selected = { dataset: { ep: '18' }, textContent: '第19集' };
  const video = { id: 'video', tagName: 'VIDEO', readyState: 2, currentSrc: 'https://media.example/19.mp4', playbackRate: 1,
    pause() {}, load() {}, removeAttribute() {}, querySelectorAll() { return []; },
    play() { video.started = (video.started || 0) + 1; return Promise.resolve(); } };
  const document = { readyState: 'loading', visibilityState: 'visible',
    addEventListener(name, listener) { (listeners[name] ||= []).push(listener); },
    getElementById(id) { return id === 'video' ? video : { textContent: '' }; },
    querySelector() { return selected; },
    documentElement: { setAttribute() {}, removeAttribute() {} } };
  const window = { location: { origin, protocol: 'https:', hostname: new URL(origin).hostname,
    href: origin + '/player/?id=fixture', pathname: '/player/', search: '?id=fixture', replace(value) { redirects.push(value); } },
    async fetch(input, options) {
      calls.push({ input, options });
      return await (replies.shift() || new Response('{}', { headers: { 'content-type': 'application/json' } }));
    } };
  window.top = window;
  const context = vm.createContext({ window, document, URL, Request, Response, AbortSignal, AbortController, DOMException,
    setTimeout, clearTimeout, localStorage: { getItem() { if (storageThrows) throw Error('denied'); return '2'; } } });
  vm.runInContext(source, context);
  return { window, document, replies, calls, redirects, selected, video,
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
