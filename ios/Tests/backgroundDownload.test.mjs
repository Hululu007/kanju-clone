import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/* REG-032：切到后台后 HLS 下载实际停住（build 27 报，build 28 修）。
   Windows 上编不了也跑不了 Swift，这里守住的是「后台不再靠进程一片一片派发」、
   「后台事件收尾回调必须归还」、「重启按系统任务 + 磁盘对账」这三条契约本身。
   真机行为只能在 Ken 的 iPhone 上验收（见 ios/REGRESSIONS.md 的 REG-032）。 */
const downloader = await readFile(new URL('../ZhuijuAI/HLSDownloader.swift', import.meta.url), 'utf8');
const media = await readFile(new URL('../ZhuijuAI/MediaDownloader.swift', import.meta.url), 'utf8');

function section(source, startMark, endMark) {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark, start + startMark.length);
  assert.ok(start >= 0 && end > start, '找不到段落: ' + startMark);
  return source.slice(start, end);
}

test('分片全量入队：pump 把剩下的分片一次性交给系统队列，不再按空位在进程内派发', () => {
  const pump = section(downloader, 'private static func pump(id: String)', 'private static func startSegment');
  assert.ok(!pump.includes('slots'), '旧实现按 maxSegmentConcurrency - active 算空位，一次只发 4 条');
  assert.ok(!pump.includes('guard slots > 0'), '不能因为「没有空位」就不发下一片：App 挂起后没人再发');
  assert.ok(pump.includes('for index in job.segments.indices'), '要把所有未完成分片都投递出去');
  assert.ok(pump.includes('inFlight.contains(key)'), '同一片不许发两条系统任务');
  assert.ok(pump.includes('retryScheduled[key] != nil'), '有重试票的分片由它自己的定时器拉起，pump 必须跳过');
  assert.ok(pump.includes('ensureAdoption()'), '还没跟系统对过账就先对账，别重复下载');
});

test('后台会话并发上限交给系统：整集分片一次入队，仍在 4 条连接内排队', () => {
  const background = section(downloader, 'private static func backgroundSession', '/// 清单/密钥');
  assert.ok(background.includes('httpMaximumConnectionsPerHost = maxSegmentConcurrency'),
    '全量入队后靠系统连接数限流，不能靠进程内空位');
  assert.ok(background.includes('configuration.isDiscretionary = false'), '不能被系统延后调度');
  assert.ok(background.includes('sessionSendsLaunchEvents = true'));
});

test('后台事件收尾：completionHandler 必须归还，不能等「系统任务空了」才还', () => {
  const adopt = section(downloader, 'static func adoptBackgroundEvents', '// MARK: - 会话');
  assert.ok(!adopt.includes('systemTasks.isEmpty'),
    '一集有 400~1400 片，队列永远不空；等空了才还回调，系统就不再为这条会话唤醒 App');
  assert.ok(adopt.includes('finishBackgroundEvents()'), '事件处理完就要把收尾回调交回系统');
  const finish = section(downloader, 'private static func finishBackgroundEvents', '// MARK: - 会话');
  assert.ok(finish.includes('backgroundCompletion = nil'), '收尾回调只许调一次');
  assert.ok(finish.includes('pending()'));
});

test('重启对账：先认回系统里在跑的分片再发新任务，磁盘上已完成的分片不重下', () => {
  assert.ok(downloader.includes('private static var sessionAdopted = false'));
  const resume = section(downloader, 'static func resume(id: String)', 'static func adoptBackgroundEvents');
  assert.ok(resume.includes('reconcileDisk(id: id)'), '恢复时先跟磁盘对账');
  const disk = section(downloader, 'static func reconcileDisk(id: String)', '// MARK: - 会话');
  assert.ok(disk.includes('".part"'), '分片缓存按 seg-<序号>.part 命名');
  assert.ok(disk.includes('current.segments[index].done = true'), '磁盘上已经在的分片直接记完成');
  assert.ok(disk.includes('finalize(id: id)'), '全部落地就直接合成，不停在「其实已经下完」的活儿上');
});

test('暂停/删除照样停掉已经投递进系统队列的全部分片', () => {
  const cancel = section(downloader, 'private static func cancelTasks', '// MARK: - 小工具');
  assert.ok(cancel.includes('tasks[identifier]?.cancel()'));
  assert.ok(cancel.includes('inFlight.remove(key)'));
  assert.ok(cancel.includes('taskKeys.removeValue(forKey: identifier)'));
});

test('mp4 直链仍然走真正的后台会话', () => {
  const launch = section(media, 'private static func launch(_ record: Record)', '/// 暂停一部剧');
  assert.ok(launch.includes('sessionInstance()'));
  assert.ok(launch.includes('downloadTask(with: request)'));
  assert.ok(media.includes('URLSessionConfiguration.background(withIdentifier: backgroundIdentifier)'));
  assert.ok(media.includes('configuration.isDiscretionary = false'));
});
