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
