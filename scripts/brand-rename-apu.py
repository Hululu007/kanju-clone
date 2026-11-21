"""把网站站名改为「阿噗影视」。

只动品牌字符串与主屏/PWA 元数据，不碰功能、样式、域名与后端。
每一组「旧写法」必须正好命中一个变体、且只出现一次；命中情况不对就报错退出，
所以它既能改线上那份工作副本，也能改已提交的基线，改错会立刻停下。

用法（仓库根目录）：
    python scripts/brand-rename-apu.py --dry-run   # 只报告会改哪些
    python scripts/brand-rename-apu.py             # 真正改文件

基线里还没有的文件（例如此前未提交的 src/player-ctrl.js、cloud/web/src/index.js）
会被跳过并点名；那两个文件的具体改动见 BRAND_RENAME_APU.md。
"""

import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRAND = "阿噗影视"

HTML_PAGES = [
    "index.html",
    "player/index.html",
    "playlists/index.html",
    "download/index.html",
    "library/history/index.html",
    "library/sessions/index.html",
]

# 每组 = 同一个位置的几种历史写法；正好命中其中一种、且只出现一次才算对。
# 旧站名在不同版本里写作「追剧AI」「看剧AI」，密码门那一页单独写作「追剧」。
EDITS = [
    ("index.html", [("<title>追剧AI</title>", "<title>阿噗影视</title>"),
                    ("<title>看剧AI</title>", "<title>阿噗影视</title>"),
                    ("<title>看剧AI - KANJU.AI</title>", "<title>阿噗影视</title>")]),
    ("index.html", [('<meta name="description" content="追剧AI：', '<meta name="description" content="阿噗影视：'),
                    ('<meta name="description" content="看剧AI：', '<meta name="description" content="阿噗影视：')]),
    ("player/index.html", [("<title>播放 - 追剧AI</title>", "<title>播放 - 阿噗影视</title>"),
                           ("<title>播放 - 看剧AI</title>", "<title>播放 - 阿噗影视</title>")]),
    ("playlists/index.html", [("<title>片单 - 追剧AI</title>", "<title>片单 - 阿噗影视</title>"),
                              ("<title>片单 - 看剧AI</title>", "<title>片单 - 阿噗影视</title>")]),
    ("download/index.html", [("<title>应用下载 - 追剧AI</title>", "<title>应用下载 - 阿噗影视</title>"),
                             ("<title>应用下载 - 看剧AI</title>", "<title>应用下载 - 阿噗影视</title>")]),
    ("library/history/index.html", [("<title>播放历史 - 追剧AI</title>", "<title>播放历史 - 阿噗影视</title>"),
                                    ("<title>播放历史 - 看剧AI</title>", "<title>播放历史 - 阿噗影视</title>")]),
    ("library/sessions/index.html", [("<title>会话记录 - 追剧AI</title>", "<title>会话记录 - 阿噗影视</title>"),
                                     ("<title>会话记录 - 看剧AI</title>", "<title>会话记录 - 阿噗影视</title>")]),
    # 页面里显示的站名
    ("src/pages/player.js", [("document.title = `${show.title} - 追剧AI`", "document.title = `${show.title} - 阿噗影视`"),
                             ("document.title = `${show.title} - 看剧AI`", "document.title = `${show.title} - 阿噗影视`")]),
    ("src/pages/home.js", [("<h1>追剧AI</h1>", "<h1>阿噗影视</h1>"),
                           ("<h1>看剧AI</h1>", "<h1>阿噗影视</h1>")]),
    ("src/shell.js", [('<span class="brand-text">追剧AI</span>', '<span class="brand-text">阿噗影视</span>'),
                      ('<span class="brand-text">看剧AI</span>', '<span class="brand-text">阿噗影视</span>')]),
    ("src/shell.js", [("<h2>登录追剧AI</h2>", "<h2>登录阿噗影视</h2>"),
                      ("<h2>登录看剧AI</h2>", "<h2>登录阿噗影视</h2>")]),
    ("src/shell.js", [('<span class="notice-kicker">追剧AI · 站内通知</span>', '<span class="notice-kicker">阿噗影视 · 站内通知</span>'),
                      ('<span class="notice-kicker">看剧AI · 站内通知</span>', '<span class="notice-kicker">阿噗影视 · 站内通知</span>')]),
    ("src/shell.js", [('<h2 id="noticeTitle">欢迎来到追剧AI</h2>', '<h2 id="noticeTitle">欢迎来到阿噗影视</h2>'),
                      ('<h2 id="noticeTitle">欢迎来到看剧AI</h2>', '<h2 id="noticeTitle">欢迎来到阿噗影视</h2>')]),
    # 下载页的站名。卡片上的「下载XX-TV」是指 TV 那个 App 本身，不在此列，原样保留。
    ("src/pages/download.js", [('aria-label="追剧AI应用下载"', 'aria-label="阿噗影视应用下载"'),
                               ('aria-label="看剧AI应用下载"', 'aria-label="阿噗影视应用下载"')]),
    ("src/pages/download.js", [("</span>追剧AI</p>", "</span>阿噗影视</p>"),
                               ("</span>看剧AI</p>", "</span>阿噗影视</p>")]),
    ("src/pages/download.js", [('<h1 class="dl-main-title">追剧AI应用下载</h1>', '<h1 class="dl-main-title">阿噗影视应用下载</h1>'),
                               ('<h1 class="dl-main-title">看剧AI应用下载</h1>', '<h1 class="dl-main-title">阿噗影视应用下载</h1>')]),
    # 播放器：外放兜底标题 + 浏览器下载文件名的站名前缀
    ("src/player-ctrl.js", [("const title = document.title || '追剧AI'", "const title = document.title || '阿噗影视'"),
                            ("const title = document.title || '看剧AI'", "const title = document.title || '阿噗影视'")]),
    ("src/player-ctrl.js", [("return `追剧AI${label ? `_${label}` : ''}${ext}`", "return `阿噗影视${label ? `_${label}` : ''}${ext}`"),
                            ("return `看剧AI${label ? `_${label}` : ''}${ext}`", "return `阿噗影视${label ? `_${label}` : ''}${ext}`")]),
    # 密码门那一页（zhuiju-web 自己渲染的 HTML）
    ("cloud/web/src/index.js", [("<title>需要密码 · 追剧</title>", "<title>需要密码 · 阿噗影视</title>"),
                                ("<title>需要密码 · 看剧</title>", "<title>需要密码 · 阿噗影视</title>")]),
    ("cloud/web/src/index.js", [("  <h1>追剧</h1>", "  <h1>阿噗影视</h1>"),
                                ("  <h1>看剧</h1>", "  <h1>阿噗影视</h1>")]),
]

MANIFEST = """{
  "name": "阿噗影视",
  "short_name": "阿噗影视",
  "lang": "zh-CN",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#0b1f2b",
  "theme_color": "#0b1f2b"
}
"""

HEAD_ADDITION = (
    '<meta name="apple-mobile-web-app-title" content="' + BRAND + '" />\n    '
    '<link rel="manifest" href="/manifest.webmanifest" />'
)


def read(path):
    with io.open(path, "r", encoding="utf-8", newline="") as fh:
        return fh.read()


def write(path, text):
    with io.open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def main():
    dry = "--dry-run" in sys.argv
    problems, applied, skipped = [], [], []

    for rel, variants in EDITS:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            skipped.append(rel)
            continue
        text = read(path)
        hits = [(old, new) for old, new in variants if old in text]
        if len(hits) != 1:
            problems.append("%s: %d variant(s) matched (%s), expected exactly 1"
                            % (rel, len(hits), [old[:40] for old, _ in hits]))
            continue
        old, new = hits[0]
        if text.count(old) != 1:
            problems.append("%s: %r appears %d time(s), expected 1" % (rel, old, text.count(old)))
            continue
        if not dry:
            write(path, text.replace(old, new))
        applied.append("%s  %s" % (rel, old[:56]))

    for rel in HTML_PAGES:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            skipped.append(rel)
            continue
        text = read(path)
        if 'name="apple-mobile-web-app-title"' in text:
            problems.append("%s: apple-mobile-web-app-title already present" % rel)
            continue
        anchor = '<meta name="theme-color" content="#0b1f2b" />'
        if text.count(anchor) != 1:
            problems.append("%s: theme-color anchor appears %d time(s)" % (rel, text.count(anchor)))
            continue
        if not dry:
            write(path, text.replace(anchor, anchor + "\n    " + HEAD_ADDITION))
        applied.append("%s  apple title + manifest link" % rel)

    manifest_path = os.path.join(ROOT, "public", "manifest.webmanifest")
    if not os.path.exists(manifest_path):
        if not dry:
            os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
            write(manifest_path, MANIFEST)
        applied.append("public/manifest.webmanifest  created")
    elif read(manifest_path).strip() != MANIFEST.strip():
        problems.append("public/manifest.webmanifest: content differs from the expected brand file")

    for line in applied:
        print(("would edit  " if dry else "edited      ") + line)
    if skipped:
        print("skipped (not in this tree/checkout): " + ", ".join(sorted(set(skipped))))
    print("problems: %d" % len(problems))
    for problem in problems:
        print("  " + problem)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())