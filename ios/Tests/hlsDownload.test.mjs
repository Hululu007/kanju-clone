import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/* build25：站上真实线路是 HLS，整集下载要自己解析清单、逐片下载、解密、合成。
   Swift 在 Windows 上既编不了也跑不了，这里钉住的是「这些规则和边界不能被删掉」，
   外加夹具清单本身的结构。真机/真实线路的行为仍然只能在 iPhone 上验证。 */
const parser = await readFile(new URL('../ZhuijuAI/HLSManifest.swift', import.meta.url), 'utf8');
const downloader = await readFile(new URL('../ZhuijuAI/HLSDownloader.swift', import.meta.url), 'utf8');
const media = await readFile(new URL('../ZhuijuAI/MediaDownloader.swift', import.meta.url), 'utf8');
const appDelegate = await readFile(new URL('../ZhuijuAI/AppDelegate.swift', import.meta.url), 'utf8');
const bootstrap = await readFile(new URL('../ZhuijuAI/AppBootstrap.js', import.meta.url), 'utf8');

function section(source, startMark, endMark) {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start + startMark.length);
  assert.ok(start >= 0 && end > start, '找不到段落: ' + startMark);
  return source.slice(start, end);
}

test('HLS 主清单：按带宽挑最高的一路，带宽相同看分辨率', () => {
  const body = section(parser, 'static func bestVariant', 'static func parse(');
  assert.ok(body.includes('variant.bandwidth > current.bandwidth'));
  assert.ok(body.includes('variant.width * variant.height > current.width * current.height'));
  assert.ok(parser.includes('#EXT-X-STREAM-INF:'));
  assert.ok(parser.includes('BANDWIDTH'));
  assert.ok(parser.includes('RESOLUTION'));
});

test('HLS 相对地址和查询串：分片不带 query 时继承清单自己的 query', () => {
  const body = section(parser, 'static func resolve', 'static func parseByteRange');
  assert.ok(body.includes('URL(string: text, relativeTo: base)'));
  assert.ok(body.includes('base.query'));
  assert.ok(body.includes('percentEncodedQuery'));
});

test('HLS 加密与初始化段：只认 AES-128，IV 缺省按媒体序号补', () => {
  assert.ok(parser.includes('#EXT-X-KEY:'));
  assert.ok(parser.includes('#EXT-X-MAP:'));
  assert.ok(parser.includes('#EXT-X-BYTERANGE:'));
  assert.ok(parser.includes('caseInsensitiveCompare("AES-128")'));
  const iv = section(parser, 'static func defaultIV', 'static func data(fromHex');
  assert.ok(iv.includes('UInt64(max(0, sequence))'));
  assert.ok(iv.includes('Data(count: 16)'));
});

test('HLS 下载器：分片走后台会话，并发 4、每片重试 3 次', () => {
  assert.ok(downloader.includes('static let backgroundIdentifier = "org.dpdns.zhuiju.ios.hls"'));
  assert.ok(downloader.includes('static let maxSegmentConcurrency = 4'));
  assert.ok(downloader.includes('static let maxSegmentRetries = 3'));
  const start = section(downloader, 'private static func startSegment', 'private static func retry');
  assert.ok(start.includes('backgroundSession().downloadTask(with: request)'));
  assert.ok(!start.includes('dataTask'), '分片不能改用前台 dataTask，切后台会断');
  assert.ok(start.includes('"Referer"'));
  assert.ok(start.includes('"User-Agent"'));
  assert.ok(start.includes('"Range"'), 'EXT-X-BYTERANGE 要用 Range 请求');
});

test('HLS 分片进度：按已完成的分片折算，长剧集不会提前跳到 100%', () => {
  const report = section(downloader, 'private static func report(id: String)', '// MARK: - 解密 / 合成');
  assert.ok(report.includes('for segment in job.segments where segment.done'));
  assert.ok(report.includes('job.totalDuration'));
  assert.ok(report.includes('MediaDownloader.hlsProgress(id: id'));
  const hook = section(media, 'static func hlsProgress', 'static func hlsComplete');
  assert.ok(hook.includes('"event": "progress"'));
  assert.ok(hook.includes('eventSink?([event])'));
});

test('HLS 合成：解密用 CommonCrypto，按分片顺序写进下载目录', () => {
  assert.ok(downloader.includes('import CommonCrypto'));
  assert.ok(downloader.includes('kCCDecrypt'));
  assert.ok(downloader.includes('kCCOptionPKCS7Padding'));
  const body = section(downloader, 'private static func finalize', 'private static func decrypt');
  assert.ok(body.includes('for (index, segment) in job.segments.enumerated()'));
  assert.ok(body.includes('MediaDownloader.directory()'));
  assert.ok(body.includes('MediaDownloader.hlsComplete(id: id'));
  assert.ok(body.includes('removeItem(at: directoryOfSegments)'), '合成完要清掉分片缓存');
});

test('HLS 边界：DRM 线路明确拒绝，暂停/删除/重启都不从头再下', () => {
  assert.ok(downloader.includes('加密，App 不能整集下载'));
  assert.ok(downloader.includes('static func pause(id: String)'));
  assert.ok(downloader.includes('static func discard(id: String)'));
  assert.ok(downloader.includes('static func resume(id: String)'));
  assert.ok(downloader.includes('NSURLErrorCancelled'), '用户暂停不算分片失败');
  assert.ok(downloader.includes('static let jobsKey = "kj-ios-hls-jobs"'));
  assert.ok(downloader.includes('job.segments[index].done = true'));
});

test('整文件下载不再拒绝 HLS，并且接到分片下载器', () => {
  const rejection = section(media, 'static func rejection(of url: URL)', 'static func planStarts');
  assert.ok(rejection.includes('path.hasSuffix(".m3u8")'));
  assert.ok(rejection.includes('return nil'), 'm3u8 要放行');
  assert.ok(!rejection.includes('HLS 分片线路没法整集下载'));
  assert.ok(media.includes('HLSDownloader.isHLSSource(url: record.url, kind: record.meta["kind"])'));
  assert.ok(media.includes('HLSDownloader.shared.start(record: record)'));
  const reconcile = section(media, 'private static func reconcile', 'private static func pageEvents');
  assert.ok(reconcile.includes('HLSDownloader.hasJob(id: records[index].id)'));
  assert.ok(reconcile.includes('HLSDownloader.resume(id: records[index].id)'));
  const remove = section(media, 'private static func deleteEpisode', 'func pause(showId: String)');
  assert.ok(remove.includes('HLSDownloader.discard(id: record.id)'));
});

test('网页侧把 HLS 线路交给原生，并带上 Referer', () => {
  const resolve = section(bootstrap, 'function resolveEpisodeUrl', 'function startBatch');
  assert.ok(!resolve.includes('HLS 分片线路，不能整集下载'));
  assert.ok(resolve.includes("data.kind !== 'mp4' && data.kind !== 'hls'"));
  assert.ok(resolve.includes("kind: isHls ? 'hls' : 'mp4'"));
  assert.ok(bootstrap.includes('kind: results[r].kind'));
  assert.ok(bootstrap.includes('referer: window.location.origin'));
  assert.ok(bootstrap.includes("results[r].kind === 'hls' ? '.mp4'"));
});

test('AppDelegate 接住 HLS 那条后台会话', () => {
  assert.ok(appDelegate.includes('_ = HLSDownloader.shared'));
  assert.ok(appDelegate.includes('identifier == HLSDownloader.backgroundIdentifier'));
  assert.ok(appDelegate.includes('HLSDownloader.adoptBackgroundEvents(completion: completionHandler)'));
});

test('夹具清单结构自检：主清单三类码率、AES-128、EXT-X-MAP、纯 TS', async () => {
  const master = await readFile(new URL('./Fixtures/hls/master.m3u8', import.meta.url), 'utf8');
  const fmp4 = await readFile(new URL('./Fixtures/hls/media-1080p-fmp4.m3u8', import.meta.url), 'utf8');
  const ts = await readFile(new URL('./Fixtures/hls/media-ts.m3u8', import.meta.url), 'utf8');
  assert.equal(master.split('#EXT-X-STREAM-INF:').length - 1, 3);
  assert.ok(master.includes('BANDWIDTH=5000000'), '要有一条最高码率');
  assert.ok(fmp4.includes('METHOD=AES-128'));
  assert.ok(fmp4.includes('IV=0x'));
  assert.ok(fmp4.includes('#EXT-X-MAP:URI="init.mp4"'));
  assert.ok(fmp4.includes('#EXT-X-MEDIA-SEQUENCE:12'));
  assert.equal(fmp4.split('#EXTINF:').length - 1, 4);
  assert.ok(fmp4.includes('seg-13.m4s?token=abc'), '要有一条自带 query 的分片');
  assert.ok(ts.includes('#EXT-X-ENDLIST'));
  assert.equal(ts.split('#EXTINF:').length - 1, 3);
  assert.ok(!ts.includes('#EXT-X-KEY:'), '纯 TS 夹具不加密');
});
test('HLS 重试票：失败分片只由自己的定时器拉起，pump 不抢跑、旧票作废', () => {
  assert.ok(downloader.includes('private static var retryScheduled: [String: Int] = [:]'));
  assert.ok(downloader.includes('private static var retryTicket = 0'));
  const pump = section(downloader, 'private static func pump', 'private static func startSegment');
  assert.ok(pump.includes('retryScheduled[key] != nil'), '有重试票的分片，pump 必须跳过');
  const retry = section(downloader, 'private static func retry', 'private static func finish');
  assert.ok(retry.includes('retryScheduled[key] = ticket'), '重试要先挂票');
  assert.ok(retry.includes('guard retryScheduled[key] == ticket else { return }'), '票号对不上的旧定时器不能动手');
  assert.ok(retry.includes('retryScheduled.removeValue(forKey: key)'), '到点先摘票再拉起');
  assert.ok(retry.includes('guard attempts <= maxSegmentRetries'), '仍然最多初次 + 3 次重试');
  const start = section(downloader, 'private static func startSegment', 'private static func retry');
  assert.ok(start.includes('retryScheduled.removeValue(forKey: key)'), '分片真起来了要把旧票作废');
  const cancel = section(downloader, 'private static func cancelTasks', '// MARK: - 小工具');
  assert.ok(cancel.includes('retryScheduled.removeValue(forKey: key)'), '暂停/删除要让还没到点的重试票失效');
});

test('HLS 接管后台任务与晚到回调：先核对持久记录，删掉/完成/暂停的分片一律丢弃', () => {
  const adopt = section(downloader, 'static func adoptBackgroundEvents', '// MARK: - 会话');
  assert.ok(adopt.includes('job.phase == "segments"'));
  assert.ok(adopt.includes('split.index < job.segments.count'));
  assert.ok(adopt.includes('!job.segments[split.index].done'));
  assert.ok(adopt.includes('!paused.contains(split.id)'));
  assert.ok(adopt.includes('task.cancel()'), '核对不上的系统任务要取消');
  const finish = section(downloader, 'private static func finish', '/// 进度按');
  assert.ok(finish.includes('guard !paused.contains(id), !job.segments[index].done else { return }'), '晚到回调不能给已完成/已停用的分片写缓存或进度');
});

test('HLS BYTERANGE 契约：长度>0、偏移非负、加法防溢出、按完整资源地址续算', () => {
  const body = section(parser, 'static func parseByteRange', 'static func parseKey');
  assert.ok(body.includes('length > 0'), '长度必须大于 0');
  assert.ok(body.includes('offset >= 0'), '偏移必须非负');
  assert.ok(body.includes('parts.count <= 2'));
  const parse = section(parser, 'static func parse(', '/// 属性串');
  assert.ok(parse.includes('let resource = url.absoluteString'), '续算 key 用解析后的完整资源地址');
  assert.ok(parse.includes('rangeCursor[resource]'), '游标按资源身份存');
  assert.ok(!parse.includes('rangeEnd[line]'), '不能拿原始 URI 字符串当 key');
  const helper = section(parser, 'static func rangeEnd', 'static func parseKey');
  assert.ok(helper.includes('addingReportingOverflow'), '偏移 + 长度要防溢出');
});

test('BYTERANGE 夹具：同一资源省略偏移接着数，换 query 当成另一份资源', async () => {
  const raw = await readFile(new URL('./Fixtures/hls/media-byterange.m3u8', import.meta.url), 'utf8');
  assert.equal(raw.split('#EXT-X-BYTERANGE:2048').length - 1, 2, '一条写明偏移、一条省略偏移');
  assert.equal(raw.split('media.ts?token=abc').length - 1, 2, '同一资源连续两段');
  assert.ok(raw.includes('media.ts?token=xyz'), '要有一条换 query 的分片');
  assert.ok(raw.includes('#EXT-X-ENDLIST'));
});
