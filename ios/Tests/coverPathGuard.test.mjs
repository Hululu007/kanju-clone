// REG-037：封面文件的身份不能被符号链接改写。
//
// 这里用真实文件系统对照两版 guard：旧版（42104b6）把文件名那一段也做了符号链接解析，
// 于是「A 的封面是指向 B 封面的链接」时拿到的路径就是 B —— 删 A 会删 B、写 A 会覆盖 B。
// 新版只解析目录段，文件名段原样保留，并先认链接再判类型。
//
// 跑法：node --test ios/Tests/coverPathGuard.test.mjs
// 注意：Windows 上创建符号链接需要管理员权限或开发者模式。没有该权限的机器上，
// 需要建链接的用例会明确标注「跳过（系统不允许建链接）」而不是失败——断言本身不动，
// 在 macOS 上（普通用户即可建链接）照常全部执行。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const COVER_DIR = 'DownloadCovers';

/** FileManager 等价物（iOS 上 Documents 本身常常是 /var → /private/var 的链接）。 */
const resolveReal = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.normalize(p);
  }
};
const fileExistsFollowing = (p) => fs.existsSync(p);
const attributesType = (p) => {
  const stat = fs.lstatSync(p);
  if (stat.isSymbolicLink()) return 'link';
  if (stat.isDirectory()) return 'dir';
  return stat.isFile() ? 'file' : 'other';
};
const linkTarget = (p) => fs.readlinkSync(p);

function insideCoverDirectory(root, target) {
  const rel = path.relative(root, target);
  return !!rel && !rel.startsWith('..') && !rel.includes(path.sep);
}

function coverURLOld(dir, raw) {
  const text = String(raw ?? '').trim();
  if (!text || !text.startsWith(COVER_DIR + '/')) return null;
  const name = path.basename(text);
  if (!name || name === '.' || name === '..') return null;
  const root = resolveReal(dir);
  const target = resolveReal(path.join(dir, name));
  if (!insideCoverDirectory(root, target)) return null;
  if (!fileExistsFollowing(target)) return { path: target, exists: false };
  if (attributesType(target) !== 'file') return null;
  return { path: target, exists: true };
}

function coverURLNew(dir, raw) {
  const text = String(raw ?? '').trim();
  if (!text || !text.startsWith(COVER_DIR + '/')) return null;
  const name = path.basename(text);
  if (!name || name === '.' || name === '..') return null;
  const root = resolveReal(dir);          // 只解析目录段
  const target = path.join(root, name);   // 文件名段原样，不解析
  if (!insideCoverDirectory(root, target)) return null;
  let isLink = false;
  try { linkTarget(target); isLink = true; } catch { isLink = false; }
  if (isLink) return null;
  if (!fileExistsFollowing(target)) return { path: target, exists: false };
  if (attributesType(target) !== 'file') return null;
  return { path: target, exists: true };
}

/**
 * 这套用例靠真实符号链接复现「封面身份被链接改写」。Windows 非管理员、未开开发者模式时
 * symlink 会直接 EPERM，那是机器能力不足，不是代码回归：标跳过并打印原因，断言不改。
 */
function requireSymlink(t) {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-link-probe-'));
  try {
    const target = path.join(probe, 'a.img');
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, path.join(probe, 'b.img'));
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
      t.skip('系统不允许创建符号链接（' + error.code + '），本用例需在 macOS 或开发者模式下执行');
      return false;
    }
    throw error;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

function makeSandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-guard-'));
  const documents = path.join(base, 'Documents');
  const covers = path.join(documents, COVER_DIR);
  fs.mkdirSync(covers, { recursive: true });
  fs.writeFileSync(path.join(covers, 'cover-b.img'), 'IMG-B');
  fs.writeFileSync(path.join(documents, 'other.img'), 'OTHER');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { documents, covers };
}

test('普通封面：新旧两版解析到同一个文件', (t) => {
  const { covers } = makeSandbox(t);
  const regular = path.join(covers, 'cover-regular.img');
  fs.writeFileSync(regular, 'IMG-REGULAR');
  assert.strictEqual(coverURLNew(covers, 'DownloadCovers/cover-regular.img').path, resolveReal(regular));
  assert.strictEqual(coverURLOld(covers, 'DownloadCovers/cover-regular.img').path, resolveReal(regular));
});

test('旧版缺陷：A 封面链接到 B 封面时，删 A 真的会删掉 B', (t) => {
  const { covers } = makeSandbox(t);
  const a = path.join(covers, 'cover-a.img');
  const b = path.join(covers, 'cover-b.img');
  if (!requireSymlink(t)) return;
  fs.symlinkSync(b, a);
  const resolved = coverURLOld(covers, 'DownloadCovers/cover-a.img');
  assert.strictEqual(resolveReal(resolved.path), resolveReal(b));
  fs.rmSync(resolved.path, { force: true });
  assert.strictEqual(fs.existsSync(b), false);
});

test('新版：同样的链接被拒绝，删除与写入都碰不到 B 封面', (t) => {
  const { covers } = makeSandbox(t);
  const a = path.join(covers, 'cover-a.img');
  const b = path.join(covers, 'cover-b.img');
  if (!requireSymlink(t)) return;
  fs.symlinkSync(b, a);
  assert.strictEqual(coverURLNew(covers, 'DownloadCovers/cover-a.img'), null);
  assert.strictEqual(fs.readFileSync(b, 'utf8'), 'IMG-B');
});

test('封面链接指向封面目录之外：新旧两版都拒绝', (t) => {
  const { documents, covers } = makeSandbox(t);
  const a = path.join(covers, 'cover-a.img');
  if (!requireSymlink(t)) return;
  fs.symlinkSync(path.join(documents, 'other.img'), a);
  assert.strictEqual(coverURLOld(covers, 'DownloadCovers/cover-a.img'), null);
  assert.strictEqual(coverURLNew(covers, 'DownloadCovers/cover-a.img'), null);
});

test('悬空链接：旧版当「还没落盘」放行、写入会跑到目录外，新版拒绝', (t) => {
  const { documents, covers } = makeSandbox(t);
  const a = path.join(covers, 'cover-a.img');
  const leak = path.join(documents, 'leak.img');
  if (!requireSymlink(t)) return;
  fs.symlinkSync(leak, a);
  assert.deepStrictEqual(coverURLOld(covers, 'DownloadCovers/cover-a.img'), { path: path.normalize(a), exists: false });
  fs.writeFileSync(a, 'LEAKED');
  assert.strictEqual(fs.existsSync(leak), true);
  assert.strictEqual(coverURLNew(covers, 'DownloadCovers/cover-a.img'), null);
});

test('首次落盘：新版放行，路径落在封面目录里', (t) => {
  const { covers } = makeSandbox(t);
  const result = coverURLNew(covers, 'DownloadCovers/cover-new.img');
  assert.strictEqual(result.exists, false);
  assert.strictEqual(path.dirname(result.path), resolveReal(covers));
});

test('目标是目录：新旧两版都拒绝，不会顺着 removeItem 删子树', (t) => {
  const { covers } = makeSandbox(t);
  const a = path.join(covers, 'cover-a.img');
  fs.mkdirSync(a);
  fs.writeFileSync(path.join(a, 'inner.txt'), 'x');
  assert.strictEqual(coverURLOld(covers, 'DownloadCovers/cover-a.img'), null);
  assert.strictEqual(coverURLNew(covers, 'DownloadCovers/cover-a.img'), null);
});

test('写法边界：封面目录本身与裸文件名都拒绝', (t) => {
  const { covers } = makeSandbox(t);
  assert.strictEqual(coverURLNew(covers, 'DownloadCovers'), null);
  assert.strictEqual(coverURLNew(covers, 'cover-b.img'), null);
});

test('整剧删除流程：存在链接时不误删别剧封面', (t) => {
  const { covers } = makeSandbox(t);
  const a = path.join(covers, 'cover-a.img');
  const b = path.join(covers, 'cover-b.img');
  if (!requireSymlink(t)) return;
  fs.symlinkSync(b, a);
  assert.strictEqual(coverURLNew(covers, 'DownloadCovers/cover-a.img'), null);
  assert.strictEqual(fs.readFileSync(b, 'utf8'), 'IMG-B');
});