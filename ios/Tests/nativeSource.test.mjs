import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/* Swift 在 Windows 上既编不了也跑不了：这里只钉住 WebViewController.swift 里的守卫条件，
   证明「路径边界 / 普通文件 / 类型处理」不会被以后的无意改动删掉。
   真机行为仍然只在 iOS 上验证，Node 通过不代表系统菜单里真的能播。 */
const source = await readFile(new URL('../ZhuijuAI/WebViewController.swift', import.meta.url), 'utf8');
const downloaderSource = await readFile(new URL('../ZhuijuAI/MediaDownloader.swift', import.meta.url), 'utf8');

function openInSection() {
  const start = source.indexOf('fileprivate func presentOpenInMenu');
  const end = source.indexOf('func documentInteractionController(', start);
  assert.ok(start > 0 && end > start, '找不到 presentOpenInMenu');
  return source.slice(start, end);
}

test('the open-in hand-off only accepts regular files inside the real download folder', () => {
  const section = openInSection();
  assert.match(section, /isInDownloadDirectory\(fileURL\)/);
  assert.doesNotMatch(section, /hasPrefix\(documents/, '不能再按 Documents 字符串前缀判断');
  const helper = source.slice(
    source.indexOf('private func isInDownloadDirectory'),
    source.indexOf('private func externalPlayerType')
  );
  assert.match(helper, /MediaDownloader\.directory\(\)/, '要用下载器实际落盘的 Documents/Downloads');
  assert.match(helper, /resolvingSymlinksInPath\(\)/);
  assert.match(helper, /rootComponents/, '要按完整路径组件比较，不能只比字符串前缀');
  assert.match(helper, /count > rootComponents\.count/, '下载目录本身不算文件');
  assert.match(section, /isDirectory: &isDirectory/, '要拒绝目录');
  assert.match(section, /!isDirectory\.boolValue/);
});

test('the open-in hand-off gives every allowed format a real type or a clear refusal', () => {
  const section = openInSection();
  const helper = source.slice(
    source.indexOf('fileprivate static let externalPlayerExtensions'),
    source.indexOf('fileprivate func presentOpenInMenu')
  );
  assert.match(helper, /\["mp4", "m4v", "mov", "mkv", "ts"\]/, '只处理下载器真的会落盘的格式');
  assert.match(helper, /UTType\(filenameExtension: ext\)/);
  assert.match(helper, /conforms\(to: \.movie\)/);
  assert.match(helper, /UTType\(tag: ext, tagClass: \.filenameExtension, conformingTo: \.movie\)/, '没有声明类型时派生 conforming 类型');
  assert.doesNotMatch(
    section,
    /controller\.uti = UTType\(filenameExtension: fileURL\.pathExtension\)\?\.identifier/,
    '不能拿可能为 nil 的扩展名类型直接开菜单'
  );
  assert.match(section, /controller\.uti = type\.identifier/);
  assert.match(section, /这个格式不能交给其他播放器/, '不支持的格式要明确提示');
});

test('the native notice bridge inserts the escaped message instead of a literal variable', () => {
  const start = source.indexOf('private func notifyPlayerNotice');
  assert.ok(start > 0, '找不到 notifyPlayerNotice');
  const section = source.slice(start, source.indexOf('fileprivate func presentLocalFile', start));
  assert.ok(section.includes('window.__zhuijuPlayerNotice(\\(quoted)'), '要用 Swift 插值把转义后的字面量拼进脚本');
  assert.ok(!section.includes('window.__zhuijuPlayerNotice((quoted)'), '不能把 ((quoted)) 当字面量写进脚本，否则网页读到未定义变量');
});

test('native records are the single source and deleted rows never come back', () => {
  assert.ok(downloaderSource.includes('var deletedAt: Double?'), 'native record has deletion tombstone');
  assert.ok(downloaderSource.includes('records.filter { !Self.isDeleted($0) }.map'), 'snapshot filters deleted records');
  assert.ok(downloaderSource.includes('func deleteEpisode(id: String?'), 'native per-episode delete exists');
  assert.ok(downloaderSource.includes('func removeDownloadedFile(at path: String?)'), 'delete really removes the file');
  assert.ok(downloaderSource.includes('rootComponents'), 'full path component check');
  assert.ok(source.includes('case "deleteDownload"'), 'web delete reaches native handler');
  assert.ok(source.includes('let fileURL = body["path"] as? String'), 'native delete passes real file path');
  assert.ok(source.includes('sendDownloadSnapshot()'), 'snapshot refreshed after delete');
});

/* 复审阻塞 1：删除必须真的删文件（不是挪进 .trash），删不掉要保留记录并回失败。 */
test('deleting an episode really removes the file and never pretends success', () => {
  const start = downloaderSource.indexOf('static func removeDownloadedFile(at path: String?)');
  const end = downloaderSource.indexOf('private static func deleteEpisode(id: String?', start);
  assert.ok(start > 0 && end > start, '找不到 removeDownloadedFile');
  const section = downloaderSource.slice(start, end);
  assert.match(section, /try fileManager\.removeItem\(at: source\)/, '要真的 removeItem，删了才释放空间');
  assert.doesNotMatch(section, /\bmoveItem\(/, '删除不能变成移动到回收站');
  assert.match(section, /resolvingSymlinksInPath\(\)/);
  assert.match(section, /count == rootComponents\.count \+ 1/, '只认下载目录的直接子项');
  assert.match(section, /!isDirectory\.boolValue/, '目录不删');
  assert.match(section, /return false/, '删不掉要返回 false');

  const handlerStart = source.indexOf('fileprivate func deleteDownloadedEpisode');
  const handlerEnd = source.indexOf('private func downloadRecord', handlerStart);
  assert.ok(handlerStart > 0 && handlerEnd > handlerStart, '找不到 deleteDownloadedEpisode');
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(handler, /guard downloader\.removeDownloadedFile\(at: fileURL\) else \{/, '先删文件');
  assert.match(handler, /sendDeleteResult\(ok: false/, '删失败要回传失败');
  assert.match(handler, /sendDeleteResult\(ok: true/, '删成功才回成功');
  assert.ok(handler.indexOf('removeDownloadedFile') < handler.indexOf('deleteEpisode('), '删成功后才删记录');
});

/* 复审阻塞 2：墓碑要独立持久化，任务记录被 suffix(400) 裁掉后仍然挡得住旧快照。 */
test('the tombstone store keeps blocking after the task records are trimmed', () => {
  assert.match(downloaderSource, /private static let tombstoneStoreKey = "[^"]+"/, '墓碑单独一个存储键');
  assert.match(
    downloaderSource,
    /for key in defaults\.dictionaryRepresentation\(\)\.keys where key\.hasPrefix\(tombstonePrefix\)/,
    'build24 之前的一删一键墓碑要枚举出来迁移'
  );
  assert.match(downloaderSource, /private static func deletedKeys\(\) -> Set<String> \{ Set\(tombstones\(\)\.keys\) \}/);
  assert.match(
    downloaderSource,
    /return tombstones\(\)\[key\(showId: showId, epKey: epKey\)\] != nil/,
    '记录被裁掉也要按墓碑判定已删除'
  );
  assert.match(downloaderSource, /tombstoneLimit = 2000/, '墓碑要有界清理');

  const persistStart = downloaderSource.indexOf('private static func persist(force: Bool)');
  const persistEnd = downloaderSource.indexOf('private static let tombstonePrefix', persistStart);
  assert.ok(persistStart > 0 && persistEnd > persistStart, '找不到 persist');
  const persist = downloaderSource.slice(persistStart, persistEnd);
  assert.match(persist, /suffix\(400\)/);
  assert.doesNotMatch(persist, /tombstone/, '裁剪任务记录不能碰墓碑存储');

  const cleanupStart = downloaderSource.indexOf('for deadKey in tombstones where !requestedKeys.contains(deadKey)');
  const cleanupEnd = downloaderSource.indexOf('var rejected:', cleanupStart);
  assert.ok(cleanupStart > 0 && cleanupEnd > cleanupStart, '找不到入队清理' );
  const cleanup = downloaderSource.slice(cleanupStart, cleanupEnd);
  assert.doesNotMatch(cleanup, /removeObject\(forKey: tombstoneKey/, '入队时不能顺手删墓碑');
  assert.match(cleanup, /records\.removeAll/, '旧记录可以清掉，墓碑留着');
});

/* ---------- REG-029 下载记录删不掉 ---------- */

/* 旧记录里存的是「/var/mobile/Containers/Data/Application/<UUID>/Documents/Downloads/x.mp4」。
   换一次容器（重装/换包）这个绝对路径就不存在了，旧实现按完整路径比较，
   直接判「路径越界」返回 false，那一行永远删不掉。
   修法：只取最后一段文件名，拼到**当前** Documents/Downloads 下，再照旧做边界检查。 */
test('a stored path from an old app container still resolves inside the current downloads folder', () => {
  /* 解析入口只认文件名，拼到当前 Downloads；删除直接走它，不再拿旧绝对路径去比较。 */
  const resolveStart = downloaderSource.indexOf('static func fileURL(forStoredPath');
  const resolveEnd = downloaderSource.indexOf('private static func storedFileName', resolveStart);
  assert.ok(resolveStart > 0 && resolveEnd > resolveStart, '找不到 fileURL(forStoredPath');
  const resolver = downloaderSource.slice(resolveStart, resolveEnd);
  assert.match(resolver, /lastPathComponent/, '只取旧路径的最后一段文件名');
  assert.match(resolver, /appendingPathComponent\(name/, '按文件名拼到当前 Documents/Downloads');
  assert.match(resolver, /count == root\.pathComponents\.count \+ 1/, '边界检查仍然要有');

  const start = downloaderSource.indexOf('static func removeDownloadedFile(at path: String?)');
  const end = downloaderSource.indexOf('private static func deleteEpisode(id: String?', start);
  assert.ok(start > 0 && end > start, '找不到 removeDownloadedFile');
  const section = downloaderSource.slice(start, end);
  assert.doesNotMatch(section, /URL\(fileURLWithPath: raw\)/, '不能再拿旧记录的绝对路径当文件地址');
  assert.match(section, /fileURL\(forStoredPath: raw\)/, '删除也要走同一个拼路径入口');
  assert.match(section, /guard fileManager\.fileExists\(atPath: source\.path, isDirectory: &isDirectory\) else \{ return true \}/, '文件本来就不在了也算清理成功');
  assert.doesNotMatch(section, /\bmoveItem\(/, '删除不能变成移动');
});

test('download records only persist a relative path and rebuild the absolute one on use', () => {
  assert.match(downloaderSource, /static let downloadsFolder = "Downloads"/, '下载目录名只写一处');
  assert.match(downloaderSource, /static func relativePath\(for /, '记录落盘前要转成相对路径');
  const completeStart = downloaderSource.indexOf('private static func complete(id: String');
  const completeEnd = downloaderSource.indexOf('private static func fail(', completeStart);
  assert.ok(completeStart > 0 && completeEnd > completeStart, '找不到 complete');
  const complete = downloaderSource.slice(completeStart, completeEnd);
  assert.match(complete, /relativePath\(for:/, '完成时只存相对路径');
  assert.doesNotMatch(complete, /record\.path = payload\["path"\] as\? String/, '不能再把沙盒绝对路径原样存进记录');
  assert.match(downloaderSource, /static func fileURL\(forStoredPath/, '播放/外放/删除共用同一个拼路径入口');
  for (const name of ['presentLocalPlayback', 'presentOpenInMenu']) {
    const start = source.indexOf('fileprivate func ' + name);
    assert.ok(start > 0, '找不到 ' + name);
    const body = source.slice(start, start + 1400);
    assert.match(body, /MediaDownloader\.fileURL\(forStoredPath: |MediaDownloader\.removeDownloadedFile\(at: /, name + ' 要按当前下载目录解析相对路径');
  }
});

test('deleting the episode that is playing offline stops the player before removing the file', () => {
  const start = source.indexOf('fileprivate func deleteDownloadedEpisode');
  const end = source.indexOf('private func downloadRecord', start);
  assert.ok(start > 0 && end > start, '找不到 deleteDownloadedEpisode');
  const handler = source.slice(start, end);
  assert.match(handler, /stopLocalPlayback/, '删除前要先停掉正在播的离线文件');
  assert.ok(
    handler.indexOf('stopLocalPlayback') < handler.indexOf('removeDownloadedFile'),
    '先停播，再删文件'
  );
  assert.match(source, /private (weak )?var localPlayerController/, '要记住当前离线播放器才能停');
  assert.match(source, /private (weak )?var localPlayerFileURL/, '要记住当前正在播的是哪个文件');
});

test('deleting a running job cancels the task, drops its cache and frees the queue slot', () => {
  const start = downloaderSource.indexOf('private static func deleteEpisode(id: String?');
  const end = downloaderSource.indexOf('func pause(showId: String)', start);
  assert.ok(start > 0 && end > start, '找不到 deleteEpisode');
  const body = downloaderSource.slice(start, end);
  assert.match(body, /task\.cancel\(\)/, '先取消底层任务');
  assert.match(body, /HLSDownloader\.discard\(id:/, 'HLS 分片缓存和任务一起清掉');
  assert.match(body, /rememberTombstone/, '写墓碑，晚到回调不能复活记录');
  assert.match(body, /records\[index\]\.path = ""/, '记录里的路径也清空');
  assert.match(body, /pump\(\)/, '删完要调度下一条，释放的并发名额不能空着');
});

test('a cancelled job callback never writes a deleted record back', () => {
  const section = downloaderSource.slice(
    downloaderSource.indexOf('func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?)'),
    downloaderSource.indexOf('func urlSessionDidFinishEvents')
  );
  assert.match(section, /current\.status == "running", !Self\.isDeleted\(current\)/, '只有还在下载且没被删的记录才写终态');
});
