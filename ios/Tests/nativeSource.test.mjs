import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/* Swift 在 Windows 上既编不了也跑不了：这里只钉住 WebViewController.swift 里的守卫条件，
   证明「路径边界 / 普通文件 / 类型处理」不会被以后的无意改动删掉。
   真机行为仍然只在 iOS 上验证，Node 通过不代表系统菜单里真的能播。 */
const source = await readFile(new URL('../ZhuijuAI/WebViewController.swift', import.meta.url), 'utf8');

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
