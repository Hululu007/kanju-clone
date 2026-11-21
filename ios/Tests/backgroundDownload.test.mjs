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

test('后台事件收尾：认领与收尾分开，回调等这一轮事件处理完才在 urlSessionDidFinishEvents 里归还', () => {
  const adopt = section(downloader, 'static func adoptBackgroundEvents', '/// 给收尾回调上保险');
  assert.ok(!adopt.includes('systemTasks.isEmpty'),
    '一集有 400~1400 片，队列永远不空；等空了才还回调，系统就不再为这条会话唤醒 App');
  assert.ok(!adopt.includes('finishBackgroundEvents'),
    '被唤醒 ≠ 这一轮事件处理完：在对账回调里提前归还，会让 App 在分片搬盘、状态落库前被挂起');
  assert.ok(adopt.includes('armFinishEventsDeadline(attempt: 0)'), '要留兜底，绝不把系统晾在那儿等回调');

  const deadline = section(downloader, 'private static func armFinishEventsDeadline', '/// 跟系统对账');
  assert.ok(deadline.includes('finishEventsTicket'), '兜底要凭票号，不能提前还掉下一轮的回调');

  const adoptTasks = section(downloader, 'private static func adoptIfNeeded', '/// 本进程还没跟系统对过账');
  assert.ok(!adoptTasks.includes('finishBackgroundEvents'), '认领系统任务不等于这一轮事件处理完，不能顺手归还');

  const finish = section(downloader, 'private static func finishBackgroundEvents', '/// 磁盘对账');
  assert.ok(finish.includes('pendingCompletions = []'), '收尾时把攒下的票一起取走，每张只还一次');
  assert.ok(finish.includes('for completion in pending'), '攒了多张票（连续两次唤醒）必须逐张归还，不能只还最后一张');
  assert.ok(finish.includes('finishEventsTicket += 1'), '归还后作废没到点的兜底票');

  const delegate = section(downloader, 'func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession)', '\n}');
  assert.ok(delegate.includes('Self.finishBackgroundEvents(delegateSaysRoundDone: true)'),
    '这一轮事件处理完的归宿只有 urlSessionDidFinishEvents');
});

test('连续两次后台唤醒不吞回调：攒成队列，逐张归还', () => {
  assert.ok(downloader.includes('private static var pendingCompletions: [() -> Void] = []'),
    '只存一张回调时，后一次唤醒会直接覆盖前一张，前一张永远不归还，系统最后终止 App');
  assert.ok(!/private static var backgroundCompletion\b/.test(downloader), '不能再用单张回调变量');
  const adopt = section(downloader, 'static func adoptBackgroundEvents', '/// 给收尾回调上保险');
  assert.ok(adopt.includes('pendingCompletions.append(completion)'), '每次唤醒都要追加，不能覆盖');
});

test('代理收尾有轮次校验：本轮一次活动都没见到时，不当成本轮处理完', () => {
  assert.ok(downloader.includes('private static var roundActivity = false'));
  const finish = section(downloader, 'private static func finishBackgroundEvents', '/// 磁盘对账');
  assert.ok(finish.includes('if delegateSaysRoundDone && !roundActivity { return }'),
    'urlSessionDidFinishEvents 没有轮次标识：上一轮超时归还后，迟到的尾巴不能提前结束下一轮');
  const adoptTasks = section(downloader, 'private static func adoptIfNeeded', '/// 本进程还没跟系统对过账');
  assert.ok(adoptTasks.includes('roundActivity = true'), '对账回调到了也算这一轮有活动');
  const finishKey = section(downloader, 'private static func finish(key: String', 'private static func report(id: String)');
  assert.ok(finishKey.includes('roundActivity = true'), '分片代理回调到了也算这一轮有活动');
});

test('兜底不靠单纯超时判定：处理中顺延，到硬上限才还并留下原因', () => {
  const deadline = section(downloader, 'private static func armFinishEventsDeadline', '/// 跟系统对账');
  assert.ok(deadline.includes('let quiet = adoptionQuiet && delegateDepth == 0'),
    '到点只查票号和回调存在还不够：必须确认这一轮没有在跑的分片搬盘、对账也走过了');
  assert.ok(deadline.includes('if !quiet && attempt < 3'), '还在忙就顺延，不能直接还');
  assert.ok(deadline.includes('armFinishEventsDeadline(attempt: attempt + 1)'), '顺延要重新上票，旧票作废');
  assert.ok(deadline.includes('NSLog('), '到硬上限强行归还时必须留下真实原因，供真机排查');
  assert.ok(downloader.includes('private static var delegateDepth = 0'));
  assert.ok(downloader.includes('private static var adoptionQuiet = false'));
  const finishKey = section(downloader, 'private static func finish(key: String', 'private static func report(id: String)');
  assert.ok(finishKey.includes('delegateDepth += 1'), '搬盘/落库期间要能被兜底看见');
  assert.ok(finishKey.includes('defer { delegateDepth -= 1 }'), '异常退出也要复位，否则兜底永远顺延');
  const adoptTasks = section(downloader, 'private static func adoptIfNeeded', '/// 本进程还没跟系统对过账');
  assert.ok(adoptTasks.includes('adoptionQuiet = true'), '对账真正跑完才能算安静');
});

test('分片投递计数走本类自己的节流写，不调用不存在的 update(id:force:)', () => {
  assert.ok(!downloader.includes('force:'),
    'HLSDownloader 的 update 只有 (id, mutate) 两个参数，带 force 的是 MediaDownloader 的同名方法，跨类用不了');
  const bump = section(downloader, 'private static func bumpAttempts', '// MARK: - 开始 / 解析清单');
  assert.ok(bump.includes('attempts += 1'), '投递计数要真的加一（重试上限靠它）');
  assert.ok(bump.includes('persist()'), '内存立即生效，磁盘按秒节流，不能每片整份写盘');
  const startSegment = section(downloader, 'private static func startSegment', '/// 分片失败：给这一片挂一张专属重试票');
  assert.ok(startSegment.includes('bumpAttempts(id: id, index: index)'), 'startSegment 要调本类的 bumpAttempts');
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
