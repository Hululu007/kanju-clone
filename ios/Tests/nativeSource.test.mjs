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
