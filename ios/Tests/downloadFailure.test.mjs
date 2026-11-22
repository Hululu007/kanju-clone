import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/* 下载失败 / 永远排队的专项回归（0.1.19 build 27）。
   Windows 上没有 Swift 编译器，这里用「源码守卫」钉住四条会在真机上出事的边界，
   真机行为仍要等到新包安装后验证：

   1. 整文件下载（MP4 直链）必须带 Referer + 浏览器 UA，不能再用裸 `downloadTask(with: url)`；
   2. HLS 分片 / 清单 / 密钥的 UA 不能只有 App 令牌，否则按 UA 白名单的 CDN 一律 403；
   3. 启动对账只接管仍在队列里的任务，孤儿任务和已删除/取消的任务要 cancel，
      否则取消是异步的，下一次对账会把记录复活成 running，永远占着并发名额；
   4. 取消/失败要丢掉 HLS 分片缓存，暂停才保留。 */

const downloader = await readFile(new URL('../ZhuijuAI/MediaDownloader.swift', import.meta.url), 'utf8');
const hls = await readFile(new URL('../ZhuijuAI/HLSDownloader.swift', import.meta.url), 'utf8');
const web = await readFile(new URL('../ZhuijuAI/WebViewController.swift', import.meta.url), 'utf8');
const bootstrap = await readFile(new URL('../ZhuijuAI/AppBootstrap.js', import.meta.url), 'utf8');

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start > 0, `找不到 ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `找不到 ${endMarker}`);
  return source.slice(start, end);
}

test('整文件下载带上页面 Referer 和浏览器 UA，不再发裸请求', () => {
  const launch = section(downloader, 'private static func launch(', '/// 暂停一部剧');
  assert.match(launch, /mediaRequestHeaders\(from: record\.meta\)/, '整文件下载要用统一的请求头');
  assert.doesNotMatch(launch, /downloadTask\(with: url\)/, '不能再把裸 URL 交给后台会话');
  assert.match(launch, /downloadTask\(with: request\)/);
  /* 续传数据里已经带着第一次请求的头，这条保留 */
  assert.match(launch, /downloadTask\(withResumeData: data\)/);
});

test('媒体请求头：有浏览器 UA 就用网页的，只有 App 令牌就退回兜底 UA', () => {
  const headers = section(downloader, 'static func mediaRequestHeaders(', 'static let notifyAskedKey');
  assert.match(headers, /supplied\.contains\("Mozilla\/"\) \? supplied : mediaUserAgent/);
  assert.match(headers, /headers\["Referer"\] = referer/, 'Referer 必须和网页播放一致');
  assert.match(downloader, /static var mediaUserAgent: String = browserUserAgent \+ " " \+ appUserAgentToken/);
  assert.match(downloader, /"Mozilla\/5\.0 \(iPhone;/, '兜底 UA 必须是浏览器 UA，不能只有 App 令牌');
  /* 网页把真实的 navigator.userAgent 交上来 */
  assert.match(web, /evaluateJavaScript\("navigator\.userAgent"\)/);
  assert.match(web, /MediaDownloader\.mediaUserAgent = ua/);
  assert.match(web, /mediaUserAgent/, '下载入队时要带上 UA');
});

test('HLS 分片不用裸 App 令牌当 UA', () => {
  const begin = section(hls, 'private static func begin(', 'private static func plan(');
  assert.match(begin, /supplied\.contains\("Mozilla\/"\) \? supplied : MediaDownloader\.mediaUserAgent/);
  assert.doesNotMatch(begin, /WebViewController\.userAgent/, '不能再把 App 令牌直接当媒体 UA 发出去');
  const segment = section(hls, 'private static func startSegment(', 'private static func retry(');
  assert.match(segment, /setValue\(job\.userAgent, forHTTPHeaderField: "User-Agent"\)/);
  assert.match(segment, /setValue\(job\.referer, forHTTPHeaderField: "Referer"\)/);
});

test('启动对账：只接管队列里的任务，孤儿和终态任务一律 cancel', () => {
  const reconcile = section(downloader, 'private static func reconcile(', 'static func isRunning(id:');
  assert.match(reconcile, /guard !reconciling else \{ completion\?\(\); return \}/, '对账不能重入');
  assert.match(reconcile, /let adoptable = \(records\[index\]\.status == "queued" \|\| records\[index\]\.status == "running"\)/);
  assert.match(reconcile, /!Self\.isDeleted\(records\[index\]\)/);
  /* 记录对不上（孤儿）要取消；终态记录的任务也要取消，且不能把记录改回 running */
  const orphan = reconcile.indexOf('else {');
  assert.ok(orphan > 0);
  assert.match(reconcile, /\/\* 孤儿任务：记录已经不在（删了\/被截断），留着只会占名额。 \*\/\s*\n\s*task\.cancel\(\)/);
  assert.match(reconcile, /if changed \{ persist\(force: true\) \}\s*\n\s*reconciling = false\s*\n\s*\/\* 上次没跑完的队列接着跑/);
  /* 老版本遗留下来的 HLS 僵尸任务（取消时只 pause）要清掉 */
  assert.match(reconcile, /HLSDownloader\.discardZombies\(isLive:/);
});

test('HLS 重启后：没拿到后台回调的 job 也要接着下，不能停成僵尸', () => {
  const adopt = section(hls, 'static func adoptBackgroundEvents(', '// MARK: - 会话');
  assert.match(adopt, /MediaDownloader\.isRunning\(id: id\)/);
  assert.match(adopt, /pump\(id: id\)/);
  assert.match(hls, /static func discardZombies\(isLive: \(String\) -> Bool, isPaused: \(String\) -> Bool\)/);
});

test('取消/失败丢分片缓存，暂停保留（不假装释放空间，也不留孤儿任务）', () => {
  const cancel = section(downloader, 'private static func cancel(showId: String)', '/// 取消全部');
  assert.match(cancel, /HLSDownloader\.discard\(id: record\.id\)/);
  assert.doesNotMatch(cancel, /HLSDownloader\.pause\(id: record\.id\)/);
  const fail = section(downloader, 'private static func fail(id: String, failure: Failure)', 'private extension MediaDownloader.Failure');
  assert.match(fail, /HLSDownloader\.discard\(id: id\)/);
  const pause = section(downloader, 'private static func pause(showId: String)', 'private static func resume(');
  assert.match(pause, /HLSDownloader\.pause\(id: id\)/, '暂停必须保留已下好的分片');
});

test('没有集号的入队请求要落一条失败记录，不能静默丢掉', () => {
  const enqueue = section(downloader, 'private static func enqueue(', 'private static func pump()');
  const guardBlock = enqueue.slice(enqueue.indexOf('if epKey.isEmpty {'), enqueue.indexOf('let episodeKey = key('));
  assert.match(guardBlock, /status: "failed"/);
  assert.match(guardBlock, /这一集缺少集号/, '要给出用户可以理解的原因');
  assert.match(guardBlock, /records\.append\(record\)/);
  /* 落完记录才跳过这一条：不是直接丢掉 */
  assert.ok(guardBlock.indexOf('records.append(record)') < guardBlock.indexOf('continue'), '先落失败记录再 continue');
});

test('暂停的一集不会被启动对账当僵尸清掉：缓存留着，调度停掉', () => {
  const reconcile = section(downloader, 'private static func reconcile(', 'static func isRunning(id:');
  assert.match(reconcile, /\$0\.status == "paused"/, '暂停态要算活任务，否则会被 discardZombies 清缓存');
  assert.match(reconcile, /discardZombies\(isLive:[\s\S]*isPaused:/);
  const zombies = section(hls, 'static func discardZombies(', 'private static func generation(for');
  assert.match(zombies, /let dead = jobs\.keys\.filter \{ !isLive\(\$0\) \}/);
  const deadLoop = zombies.slice(zombies.indexOf('for id in dead'), zombies.indexOf('/* paused'));
  assert.match(deadLoop, /jobs\.removeValue\(forKey: id\)/);
  assert.match(deadLoop, /removeItem\(at: segmentDirectory/);
  const pausedLoop = zombies.slice(zombies.indexOf('for id in jobs.keys where isPaused'));
  assert.match(pausedLoop, /paused\.insert\(id\)/);
  assert.match(pausedLoop, /cancelTasks\(id: id\)/, '暂停任务要停分片，别再调度');
  assert.doesNotMatch(pausedLoop, /jobs\.removeValue|removeItem\(at: segmentDirectory/, '暂停任务的分片缓存必须保留');
});

test('同一 id 换清单：旧清单、密钥、分片回调按代次作废', () => {
  const begin = section(hls, 'private static func begin(', 'private static func plan(');
  assert.match(begin, /bumpGeneration\(id: record\.id\)/, '每次开始都要换一代');
  const plan = section(hls, 'private static func plan(', 'private static func loadPlaylist(');
  assert.match(plan, /planning\[id\] = gen/);
  assert.match(plan, /if planning\[id\] == gen \{ planning\.removeValue\(forKey: id\) \}/, '旧回调不能清掉新清单的解析标记');
  assert.match(plan, /isCurrent\(id: id, gen: gen\)/);
  const apply = section(hls, 'private static func apply(', 'private static func fetchKeys(');
  assert.match(apply, /guard Self\.isCurrent\(id: id, gen: gen\)/);
  assert.match(apply, /guard Self\.isCurrent\(id: id, gen: gen\) else \{ return \}[\s\S]*?job\.segments = segments/, '旧密钥/分片列表不能写进新 job');
  const segment = section(hls, 'private static func startSegment(', 'private static func retry(');
  assert.match(segment, /taskGenerations\[task\.taskIdentifier\] = generation\(for: id\)/);
  const retry = section(hls, 'private static func retry(', 'private static func finish(');
  assert.match(retry, /isCurrent\(id: id, gen: gen\)/, '旧重试票不能拉起新清单');
  const finish = section(hls, 'private static func finish(', '/// 进度按');
  assert.match(finish, /taskGenerations\.removeValue\(forKey: taskIdentifier\)/);
  assert.match(finish, /isCurrent\(id: id, gen: callbackGeneration\)/, '旧分片的晚到回调不能改新任务');
});

test('失败的那一格写清「点一下重试」，点格子会重新解析片源再入队', () => {
  assert.match(bootstrap, /if \(status === 'failed'\) return '失败 · 点一下重试';/);
  const start = section(bootstrap, 'function startEpisodeDownload(key)', 'function dlRowKeyOf(');
  /* 失败/取消的任务不拦，点一下就重新 startBatch（重新解析 /api/play，拿新地址） */
  assert.match(start, /existing\.status === 'queued' \|\| existing\.status === 'running'\)\) return true/);
  assert.match(start, /startBatch\(\[nodes\[i\]\]\)/);
});
