import { u, n as authReady, o as fetchShowProgress, i as icon, l as posterCard, a as initTheme, s as shell, p as pageHead, b as bindShell, c as showToast, r as resolvePlay, q as saveProgress, t as flushSavedProgress, v as proxyShowFresh, w as fetchComments, e as proxyReady, x as fetchLines, y as fetchDanmaku, z as sendDanmaku } from './shell-ChO2yRT0.js';
import { f as findShow, s as shows } from './data-_Nu6DFBL.js';

const id = new URLSearchParams(location.search).get('id');
const resumeParams = new URLSearchParams(location.search);
let resumeIdx = Number(resumeParams.get('ep'));
let resumeTime = Math.max(0, Number(resumeParams.get('t')) || 0);
let lastSavedSecond = -10;
const KIND_CAT = { series: 'tv', short_drama: 'tv', movie: 'movie', anime: 'anime', animation: 'anime', variety: 'variety', documentary: 'variety' };
const KIND_LABEL = { series: '电视剧', short_drama: '短剧', movie: '电影', anime: '动漫', animation: '动漫', variety: '综艺', documentary: '纪录片' };

// 静态片库里没有的 id（后端新同步进来的）→ 回源到片源服务
async function loadRemoteShow(showId) {
  const s = await proxyShowFresh(showId);
  if (!s) return null
  const eps = (s.episodes || []).map((e) => ({ idx: e.idx, label: e.label, url: '', quality: e.quality, line: e.line }));
  return {
    id: s.id,
    title: s.title,
    originalTitle: '',
    year: s.year || '',
    cat: KIND_CAT[s.kind] || 'tv',
    kindLabel: KIND_LABEL[s.kind] || '影视',
    area: s.area || '中国大陆',
    language: s.language || '国语',
    genres: s.genres?.length ? s.genres : ['剧情'],
    actors: s.actors || [],
    directors: s.directors || [],
    badge: s.remarks || '最新上线',
    remarks: s.remarks || '',
    headline: '',
    synopsis: s.synopsis || '',
    desc: s.synopsis || '',
    poster: s.poster || '',
    backdrop: s.backdrop || '',
    heat: '',
    heatValue: s.heatValue || 0,
    playbackCount: 0,
    episodeCount: s.episodeCount || eps.length,
    availableEpisodeCount: s.availableEpisodeCount || eps.length,
    playableCount: eps.length,
    episodes: eps,
    groups: [],
    availability: { state: 'playable', label: '可播放', playable: true },
    vip: false,
    hue: 210,
  }
}

const staticShow = findShow(id);
const remoteShow = id ? await loadRemoteShow(id) : null;
const show = remoteShow
  ? { ...(staticShow || {}), ...remoteShow, episodes: remoteShow.episodes }
  : staticShow;
if (!show) {
  location.replace(u('/'));
  throw new Error('show not found')
}
let eps = show.episodes || [];
if (await authReady) {
  const saved = await fetchShowProgress(show.id).catch(() => null);
  if (saved && Number.isInteger(Number(saved.idx))) {
    if (!resumeParams.has('ep')) resumeIdx = Number(saved.idx);
    if (!resumeParams.has('t') && Number(saved.idx) === Number(resumeIdx)) {
      resumeTime = Math.max(0, Number(saved.position) || 0);
    }
  }
}
document.title = `${show.title} - 追剧AI`;

const related = shows.filter((s) => s.id !== show.id && s.cat === show.cat).slice(0, 10);
const rest = related.length >= 6 ? related : shows.slice(6, 16);

const EP_SHOW = 120;
const mins = (s) => (s ? Math.round(s / 60) + ' 分钟' : '—');
const first = eps[0];
(first?.url || '').split('/')[2] || 'archive.org';

const body = `<section class="page-body"><div class="wrap page p-player2" style="--h:${show.hue}">
  <div class="pp-top">
    <div class="pp-title">
      <h1>${show.title}</h1>
      <div class="pp-sub">
        ${show.year ? show.year + ' · ' : ''}${show.area} · ${show.kindLabel}
        ${show.remarks ? ` · ${show.remarks}` : ''}
      </div>
    </div>
    <div class="pp-actions">
      <button class="btn-mint" type="button" data-play="1">${icon('play', 16)}${resumeTime > 0 ? '继续观看' : '开始播放'}</button>
      <button class="btn-ghost" type="button" data-fav>${icon('bookmark', 16)}加入片单</button>
      <button class="btn-ghost" type="button" data-detail>查看影片详情</button>
      <button class="btn-ghost" type="button" data-cast>投屏</button>
      <a class="btn-ghost" href="${u('/download/')}">${icon('phone', 16)}下载APP</a>
      <button class="btn-ghost" type="button" data-action="share">${icon('share', 16)}分享</button>
    </div>
  </div>

  <div class="pp-layout">
    <div class="pp-main">
      <section class="player" id="player">
        <video id="video" controls playsinline preload="metadata"
          poster="${show.poster || ''}" style="width:100%;display:block;aspect-ratio:16/9;background:#000">
          <source id="vsrc" src="${first?.url || ''}" type="video/mp4" />
          你的浏览器不支持 HTML5 播放。
        </video>
        <div class="dm-layer" id="dmLayer"></div>
        <button class="skip-btn" id="skipIntro" type="button" hidden>跳过片头</button>
        <button class="skip-btn" id="skipOutro" type="button" hidden>跳过片尾</button>
        <span class="p-label" id="playerLabel">${show.title} · ${first?.label || '正片'}</span>
      </section>

      <div class="pp-toolbar" id="playTools">
        <button class="pp-tool" id="settingsBtn" type="button">${icon('settings', 15)}显示设置</button>
        <button class="pp-tool" id="lineBtn" type="button">线路</button>
        <button class="pp-tool on" id="dmBtn" type="button">弹幕 开</button>
        <button class="pp-tool" id="pipBtn" type="button">画中画</button>
        <button class="pp-tool" id="nextEpBtn" type="button">下一集</button>
        <div class="dm-input" id="dmInputWrap">
          <input id="dmText" type="text" maxlength="60" placeholder="发条弹幕…" autocomplete="off" />
          <button id="dmSend" type="button">发送</button>
        </div>
      </div>

      <div class="pp-settings" id="settingsPanel" hidden>
        <div class="pp-set-row"><span>播放速度</span><div class="speed-bar" id="speedBar"></div></div>
        <div class="pp-set-row"><span>画面填充</span>
          <div class="fill-bar" id="fillBar">
            <button class="tool-btn on" type="button" data-fill="contain">默认</button>
            <button class="tool-btn" type="button" data-fill="cover">铺满</button>
            <button class="tool-btn" type="button" data-fill="fill">拉伸</button>
          </div>
        </div>
        <div class="pp-set-row"><span>增强与网络</span>
          <button class="pp-tool" id="hqBtn" type="button">画质增强</button>
          <button class="pp-tool" id="p2pBtn" type="button">P2P</button>
        </div>
      </div>

      <div class="line-bar" id="lineBar" hidden></div>
      <p class="pp-hint" id="playHint">点播放即可观看，线路失败会自动切换下一条。</p>

      <div class="pp-info" id="detailInfo">
        ${show.synopsis ? `<h3>简介</h3><p class="synopsis">${show.synopsis}</p>` : ''}
        ${
          (show.directors?.length || show.actors?.length)
            ? `<h3>主创</h3><p class="pp-crew">
                ${show.directors?.length ? `导演：${show.directors.slice(0, 3).join('、')}` : ''}
                ${show.directors?.length && show.actors?.length ? ' · ' : ''}
                ${show.actors?.length ? `主演：${show.actors.slice(0, 8).join('、')}` : ''}
              </p>`
            : ''
        }
        <p class="pp-genres">${show.genres.slice(0, 5).map((g) => `<span class="tag">${g}</span>`).join('')}</p>
      </div>
    </div>

    <aside class="pp-side">
      <div class="pp-tabs" role="tablist">
        <button class="pp-tab on" type="button" data-tab="eps">选集</button>
        <button class="pp-tab" type="button" data-tab="cast">投屏</button>
        <button class="pp-tab" type="button" data-tab="talk">讨论 <span class="pp-tab-count">99+</span></button>
        <button class="pp-tab" type="button" data-tab="fb">反馈</button>
      </div>
      <div class="pp-pane" id="paneEps">
        <div class="pp-pane-head">选集 <span>共 ${eps.length} 集</span></div>
        <div class="ep-grid" id="epGrid">
          ${eps
            .slice(0, EP_SHOW)
            .map((e, i) => `<button class="ep ${i === 0 ? 'on' : ''}" type="button" data-ep="${e.idx}">${e.label}</button>`)
            .join('')}
        </div>
        ${eps.length > EP_SHOW ? `<button class="btn-ghost" type="button" id="epMore" style="margin-top:10px">显示全部 ${eps.length} 集</button>` : ''}
      </div>
      <div class="pp-pane" id="paneCast" hidden>
        <div class="pp-empty">投屏请在 TV / 手机 App 内使用</div>
      </div>
      <div class="pp-pane" id="paneTalk" hidden>
        <div class="pp-comments" id="commentList">加载中…</div>
      </div>
      <div class="pp-pane" id="paneFb" hidden>
        <div class="pp-empty">反馈请通过 App 内「反馈」提交</div>
      </div>
    </aside>
  </div>

  <section class="row" style="margin-top:26px">
    <div class="row-head">
      <div><h2>相关推荐</h2><p class="sub">同类片库里还有这些</p></div>
    </div>
    <div class="strip">${rest.map((s) => posterCard(s)).join('')}</div>
  </section>
</div></section>`;

initTheme();
document.getElementById('app').innerHTML = shell({
  body,
  active: '',
  tabActive: '首页',
  top: false,
  head: pageHead({ title: show.title, nav: '', back: u('/') }),
});
bindShell();

const epMore = document.getElementById('epMore');
if (epMore) {
  epMore.addEventListener('click', () => {
    const grid = document.getElementById('epGrid');
    grid.innerHTML = eps
      .map((e, i) => `<button class="ep ${i === 0 ? 'on' : ''}" type="button" data-ep="${e.idx}">${e.label}</button>`)
      .join('');
    epMore.remove();
    const cur = document.querySelector('.ep.on');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  });
}

const video = document.getElementById('video');
const label = document.getElementById('playerLabel');
const hint = document.getElementById('playHint');

// ---- 倍速 ----
const SPEEDS = [1, 1.5, 2, 2.5, 3];
const speedBar = document.getElementById('speedBar');
let rate = Number(localStorage.getItem('kj-speed') || 1);
if (!SPEEDS.includes(rate)) rate = 1;

// ---- 画质增强 / 弹幕 / 跳过片头片尾 ----
const hqBtn = document.getElementById('hqBtn');
const dmBtn = document.getElementById('dmBtn');
const dmLayer = document.getElementById('dmLayer');
const dmInputWrap = document.getElementById('dmInputWrap');
const dmText = document.getElementById('dmText');
const dmSend = document.getElementById('dmSend');
const skipIntroBtn = document.getElementById('skipIntro');
const skipOutroBtn = document.getElementById('skipOutro');
const lineBtn = document.getElementById('lineBtn');
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const fillBar = document.getElementById('fillBar');
const nextEpBtn = document.getElementById('nextEpBtn');
const pipBtn = document.getElementById('pipBtn');
const p2pBtn = document.getElementById('p2pBtn');
const ppTabs = document.querySelector('.pp-tabs');
const commentList = document.getElementById('commentList');
let talkLoaded = false;

let hq = localStorage.getItem('kj-hq') === '1';
let dmOn = localStorage.getItem('kj-dm') !== '0';
let skipInfo = null;
let dmList = [];
let dmCursor = 0;
let lastT = 0;
let dmLane = 0;

function applyHQ() {
  video.style.filter = hq ? 'contrast(1.06) saturate(1.08) brightness(1.02)' : '';
  hqBtn.classList.toggle('on', hq);
}

function applyDm() {
  dmBtn.classList.toggle('on', dmOn);
  dmBtn.textContent = dmOn ? '弹幕 开' : '弹幕 关';
  dmInputWrap.style.display = dmOn ? '' : 'none';
  if (!dmOn) dmLayer.innerHTML = '';
}

function spawnDm(d) {
  const el = document.createElement('span');
  el.className = 'dm-item';
  el.textContent = d.text;
  if (d.color) el.style.color = d.color;
  dmLane = (dmLane + 1) % 7;
  el.style.top = 6 + dmLane * 11 + '%';
  el.style.setProperty('--dur', 8 + Math.min(6, d.text.length * 0.12) + 's');
  dmLayer.appendChild(el);
  setTimeout(() => el.remove(), 16000);
}

function pumpDm() {
  if (!dmOn) return
  const t = video.currentTime || 0;
  if (t < lastT - 1) {
    dmCursor = 0;
    dmLayer.innerHTML = '';
  }
  lastT = t;
  while (dmCursor < dmList.length) {
    const d = dmList[dmCursor];
    if (d.t > t) break
    if (d.t > t - 2) spawnDm(d);
    dmCursor++;
  }
}

async function loadDm(epIdx) {
  dmList = [];
  dmCursor = 0;
  lastT = 0;
  dmLayer.innerHTML = '';
  const j = await fetchDanmaku(show.id, epIdx).catch(() => null);
  if (j?.items?.length) {
    dmList = j.items.map((x) => ({ t: Number(x.t) || 0, text: String(x.text || ''), color: x.color || '' })).filter((x) => x.text);
  }
}

async function sendDm() {
  const text = dmText.value.trim();
  if (!text) return
  const epIdx = Number(document.querySelector('.ep.on')?.dataset.ep ?? eps[0]?.idx ?? 0);
  const t = video.currentTime || 0;
  const ok = await sendDanmaku(show.id, epIdx, t, text);
  if (!ok) {
    hint.textContent = '弹幕发送失败，稍后再试';
    return
  }
  dmText.value = '';
  if (dmOn) {
    dmList.push({ t, text, color: '' });
    dmList.sort((a, b) => a.t - b.t);
    dmCursor = dmList.findIndex((x) => x.t >= lastT);
    if (dmCursor < 0) dmCursor = dmList.length;
    spawnDm({ text });
  }
}

function updateSkip() {
  if (!skipInfo) {
    skipIntroBtn.hidden = true;
    skipOutroBtn.hidden = true;
    return
  }
  const t = video.currentTime || 0;
  const d = video.duration || 0;
  skipIntroBtn.hidden = !(skipInfo.introEnd && t < skipInfo.introEnd - 1);
  skipOutroBtn.hidden = !(skipInfo.outroFrom && d > 0 && d - t <= skipInfo.outroFrom);
}

// ---- 顶部工具条 / 右侧面板 ----
const escHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const timeAgo = (iso) => {
  const t = Date.parse(iso);
  if (!t) return ''
  const d = Date.now() - t;
  if (d < 3600e3) return Math.max(1, Math.round(d / 60e3)) + ' 分钟前'
  if (d < 86400e3) return Math.round(d / 3600e3) + ' 小时前'
  return Math.round(d / 86400e3) + ' 天前'
};

async function loadComments() {
  if (!commentList) return
  commentList.innerHTML = '加载中…';
  const j = await fetchComments(show.id, 0, 30).catch(() => null);
  if (!j?.items?.length) {
    commentList.innerHTML = '<div class="pp-empty">还没有讨论</div>';
    return
  }
  commentList.innerHTML = j.items
    .map(
      (c) => `<div class="cmt">
        <p class="cmt-body">${escHtml(c.content)}</p>
        <div class="cmt-meta"><span>${escHtml(c.author)}</span><span>${timeAgo(c.at)}</span><span>👍 ${c.up || 0}</span></div>
      </div>`
    )
    .join('');
}

lineBtn?.addEventListener('click', () => {
  lineBar.hidden = !lineBar.hidden;
});
settingsBtn?.addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
});
nextEpBtn?.addEventListener('click', () => {
  const cur = Number(document.querySelector('.ep.on')?.dataset.ep ?? eps[0]?.idx ?? 0);
  const nxt = eps.find((e) => e.idx > cur);
  if (nxt) play(nxt.idx);
  else showToast('已经是最后一集了');
});
pipBtn?.addEventListener('click', async () => {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (document.pictureInPictureEnabled && video.requestPictureInPicture) await video.requestPictureInPicture();
    else showToast('当前浏览器不支持画中画');
  } catch { showToast('暂时无法开启画中画'); }
});
p2pBtn?.addEventListener('click', () => showToast('当前片源线路未提供 P2P 加速'));
document.querySelector('[data-detail]')?.addEventListener('click', () => {
  document.getElementById('detailInfo')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
document.querySelector('[data-cast]')?.addEventListener('click', () => {
  const castTab = document.querySelector('[data-tab="cast"]');
  castTab?.click();
  document.querySelector('.pp-side')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
fillBar?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-fill]');
  if (!b) return
  video.style.objectFit = b.dataset.fill;
  fillBar.querySelectorAll('.tool-btn').forEach((x) => x.classList.toggle('on', x === b));
  localStorage.setItem('kj-fill', b.dataset.fill);
});
{
  const saved = localStorage.getItem('kj-fill') || 'contain';
  video.style.objectFit = saved;
  fillBar?.querySelector(`[data-fill="${saved}"]`)?.classList.add('on');
  fillBar?.querySelectorAll('.tool-btn').forEach((x) => x.classList.toggle('on', x.dataset.fill === saved));
}
ppTabs?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return
  ppTabs.querySelectorAll('.pp-tab').forEach((x) => x.classList.toggle('on', x === b));
  const map = { eps: 'paneEps', cast: 'paneCast', talk: 'paneTalk', fb: 'paneFb' };
  for (const [k, id] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.hidden = k !== b.dataset.tab;
  }
  if (b.dataset.tab === 'talk' && !talkLoaded) {
    talkLoaded = true;
    loadComments();
  }
});

function renderSpeed() {
  if (!speedBar) return
  speedBar.innerHTML =
    `<span class="speed-title">倍速</span>` +
    SPEEDS.map(
      (v) => `<button class="speed-btn ${v === rate ? 'on' : ''}" type="button" data-speed="${v}">${v}x</button>`
    ).join('');
}

function applyRate() {
  try {
    video.playbackRate = rate;
    const real = video.playbackRate;
    // iOS 等平台可能把 >2x 钳制到 2x，界面按真实值回显
    if (real && Math.abs(real - rate) > 0.01) {
      rate = real;
      localStorage.setItem('kj-speed', String(rate));
      renderSpeed();
    }
  } catch {
    /* iOS 可能不支持 >2x，会静默钳制 */
  }
}

function setRate(v) {
  rate = Number(v) || 1;
  localStorage.setItem('kj-speed', String(rate));
  renderSpeed();
  applyRate();
}

function remember(idx) {
  const position = video.currentTime || 0;
  const duration = video.duration || null;
  const label = eps.find((episode) => Number(episode.idx) === Number(idx))?.label || `第${Number(idx) + 1}集`;
  try {
    const hist = JSON.parse(localStorage.getItem('kj-history') || '[]');
    localStorage.setItem('kj-history', JSON.stringify([show.id, ...hist.filter((x) => x !== show.id)].slice(0, 12)));
  } catch {}
  try {
    const progress = JSON.parse(localStorage.getItem('kj-progress') || '{}');
    progress[show.id] = {
      idx,
      label,
      position,
      duration,
      updated: Date.now(),
    };
    localStorage.setItem('kj-progress', JSON.stringify(progress));
  } catch {}
  void saveProgress({ showId: show.id, idx, position, duration });
}

// ---- 播放器：mp4 直连；m3u8 用原生或按需加载 hls.js ----
let hls = null;
let hlsLoading = null;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls)
  if (!hlsLoading) {
    hlsLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
      s.onload = () => resolve(window.Hls);
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  return hlsLoading
}

const isHlsUrl = (u) => /\.m3u8(\?|$)/i.test(String(u || ''));

function attach(url) {
  if (hls) { hls.destroy(); hls = null; }
  if (!url) return
  // Chrome 的 canPlayType 对 HLS 会撒谎（返回 maybe 但播不了），有 MediaSource 就统一走 hls.js
  if (isHlsUrl(url) && typeof window.MediaSource !== 'undefined') {
    hint.textContent = '正在加载 HLS 线路…';
    loadHls()
      .then((Hls) => {
        hls = new Hls({ maxBufferLength: 30 });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data?.fatal) return
          hint.textContent = '这条 HLS 线路播不动，换一集或稍后再试。';
        });
        hls.loadSource(url);
        hls.attachMedia(video);
      })
      .catch(() => { hint.textContent = 'HLS 线路加载失败。'; });
    return
  }
  video.src = url;
  video.load();
  applyRate();
}

// ---- 线路选择（与原站一致：官方 / 普通两组）----
const lineBar = document.getElementById('lineBar');
const linesByEp = new Map();
const STATUS_TIP = {
  dup: '该线路串集，已停用',
  dead: '线路不可用',
  empty: '线路为空',
  member: '需要会员或更高等级',
  unknown: '',
  ok: '',
};

function renderLines(epIdx, currentProvider = '') {
  if (!lineBar) return
  const data = linesByEp.get(Number(epIdx));
  if (!data || !data.options?.length) {
    lineBar.innerHTML = '';
    return
  }
  const groups = { official: [], normal: [] };
  for (const o of data.options) (groups[o.group] || groups.normal).push(o);
  const option = (o) => `<option value="${escHtml(o.provider)}" ${o.provider === currentProvider ? 'selected' : ''} ${o.status === 'dup' || o.status === 'dead' ? 'disabled' : ''}>${escHtml(o.label)}${o.status && o.status !== 'ok' ? ` · ${STATUS_TIP[o.status] || ''}` : ''}</option>`;
  lineBar.innerHTML = `
    <span class="line-title">线路</span>
    <select class="line-select" id="lineSelect" aria-label="选择播放线路">
      ${groups.official.length ? `<optgroup label="官方线路">${groups.official.map(option).join('')}</optgroup>` : ''}
      ${groups.normal.length ? `<optgroup label="普通线路">${groups.normal.map(option).join('')}</optgroup>` : ''}
    </select>`;
  document.getElementById('lineSelect')?.addEventListener('change', (event) => {
    const cur = Number(document.querySelector('.ep.on')?.dataset.ep ?? eps[0]?.idx ?? 0);
    play(cur, true, event.currentTarget.value);
  });
}

async function ensureLines(epIdx) {
  if (linesByEp.has(Number(epIdx))) return
  await proxyReady;
  if (linesByEp.has(Number(epIdx))) return
  const j = await fetchLines(show.id, epIdx).catch(() => null);
  if (j) linesByEp.set(Number(epIdx), j);
}

async function play(idx, autoplay = true, preferred = '') {
  const ep = eps.find((e) => e.idx === Number(idx)) || eps[0];
  if (!ep) return
  document.querySelectorAll('.ep').forEach((b) => b.classList.toggle('on', Number(b.dataset.ep) === ep.idx));
  label.textContent = `${show.title} · ${ep.label}`;
  hint.textContent = '正在换取片源…';
  await ensureLines(ep.idx);
  renderLines(ep.idx, preferred);
  // 静态页面里的直链会过期：优先让本地片源服务现场解析一条新的
  const fresh = await resolvePlay(show.id, ep.idx, preferred).catch(() => null);
  if (!fresh) {
    hint.textContent = '片源服务响应超时或未连接，请确认 npm run proxy 已启动，然后重试本集。';
    return
  }
  if (fresh?.error === 'login_required') {
    hint.textContent = '这一集在原站是会员片源，匿名拿不到地址。换一部标着「可播放」的片子就能直接看。';
    return
  }
  const url = fresh?.url || ep.url;
  if (fresh?.error) {
    hint.textContent = '这一集的片源暂时取不到（线路维护或需要会员），换一集或换一部试试。';
    return
  }
  if (!url) {
    hint.textContent = '这一集暂时取不到片源（可能是会员片源或线路维护），换一集或换一部试试。';
    return
  }
  attach(url);
  skipInfo = fresh?.skip || null;
  updateSkip();
  loadDm(ep.idx);
  if (fresh?.options?.length) {
    linesByEp.set(Number(ep.idx), { options: fresh.options });
    renderLines(ep.idx, fresh.provider);
  }
  hint.textContent = fresh
    ? `正在播放 第${fresh.episodeNumber ?? ep.idx + 1} 集 · 线路 ${fresh.line || '官方'} · ${fresh.kind === 'hls' ? 'HLS' : 'MP4'}${fresh.verified ? ' · 内容指纹已校验' : ''}`
    : '使用缓存的片源线路（可能已过期）';
  if (resumeTime > 0 && Number(ep.idx) === resumeIdx) {
    const seekResume = () => {
      video.currentTime = Math.min(resumeTime, Math.max(0, video.duration - 1));
      video.removeEventListener('loadedmetadata', seekResume);
      remember(ep.idx);
    };
    if (video.readyState >= 1) seekResume();
    else video.addEventListener('loadedmetadata', seekResume, { once: true });
  }
  if (autoplay) {
    video.play().catch(() => {});
    if (!(resumeTime > 0 && Number(ep.idx) === resumeIdx)) remember(ep.idx);
  }
}

// 线路失败时绝不自动跳到下一集：那正是「点第19集却看到第2集」的来源。
// 片源服务已经会在同集内换线，浏览器仍失败就提示用户重试本集。
video.addEventListener('error', () => {
  hint.textContent = '这条线路在浏览器里播不动。请再点一次本集（会自动换线），或换一条线路。';
});
video.addEventListener('loadedmetadata', () => {
  applyRate();
  updateSkip();
  hint.textContent = video.duration ? `时长 ${mins(video.duration)} · 当前线路可直接播放` : '当前线路可直接播放';
});
video.addEventListener('pause', () => {
  const activeEp = document.querySelector('.ep.on');
  if (!activeEp || !(video.currentTime > 0)) return
  void saveProgress(
    {
      showId: show.id,
      idx: Number(activeEp.dataset.ep),
      position: video.currentTime || 0,
      duration: video.duration || null,
    },
    { force: true }
  );
});
video.addEventListener('timeupdate', () => {
  pumpDm();
  updateSkip();
  const activeEp = document.querySelector('.ep.on');
  const second = Math.floor(video.currentTime);
  if (activeEp && second > 0 && second - lastSavedSecond >= 10) {
    lastSavedSecond = second;
    remember(Number(activeEp.dataset.ep));
  }
});

document.addEventListener('click', (e) => {
  const sp = e.target.closest('[data-speed]');
  if (sp) {
    setRate(sp.dataset.speed);
    return
  }
  const ln = e.target.closest('[data-line]');
  if (ln) {
    const cur = Number(document.querySelector('.ep.on')?.dataset.ep ?? eps[0]?.idx ?? 0);
    play(cur, true, ln.dataset.line);
    return
  }
  const ep = e.target.closest('[data-ep]');
  if (ep) return play(Number(ep.dataset.ep))
  const p = e.target.closest('[data-play]');
  if (p) {
    play(resumeTime > 0 ? resumeIdx : eps[0]?.idx ?? 0);
    video.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return
  }
  if (e.target.closest('[data-fav]')) showToast(`已把《${show.title}》加入默认片单`);
});

if (!eps.length) {
  hint.textContent = '这部暂时没有可播放文件。';
}

// 进页面先把第 1 集的线路列出来，和原站一致
if (eps.length) {
  const initialEp = eps.find((episode) => Number(episode.idx) === resumeIdx) || eps[0];
  ensureLines(initialEp.idx).then(() => renderLines(initialEp.idx));
  if (resumeParams.has('ep')) play(initialEp.idx, true);
}
renderSpeed();
applyHQ();
applyDm();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return
  const activeEp = document.querySelector('.ep.on');
  if (!activeEp || !(video.currentTime > 0)) return
  void saveProgress(
    {
      showId: show.id,
      idx: Number(activeEp.dataset.ep),
      position: video.currentTime || 0,
      duration: video.duration || null,
    },
    { force: true }
  );
});
window.addEventListener('pagehide', () => void flushSavedProgress());

hqBtn?.addEventListener('click', () => {
  hq = !hq;
  localStorage.setItem('kj-hq', hq ? '1' : '0');
  applyHQ();
});
dmBtn?.addEventListener('click', () => {
  dmOn = !dmOn;
  localStorage.setItem('kj-dm', dmOn ? '1' : '0');
  applyDm();
});
dmSend?.addEventListener('click', (e) => {
  e.preventDefault();
  sendDm();
});
dmText?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendDm();
  }
});
skipIntroBtn?.addEventListener('click', () => {
  if (skipInfo?.introEnd) video.currentTime = skipInfo.introEnd;
});
skipOutroBtn?.addEventListener('click', () => {
  if (video.duration) video.currentTime = Math.max(0, video.duration - 0.5);
});
