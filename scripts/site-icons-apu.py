"""把站点图标换成阿噗影视的 App 图标（favicon / 主屏图标 / PWA manifest 图标）。

源图：iOS App 的 1024 图标（ios/ZhuijuAI/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png），
没有就退到 ios/scripts/appicon-source.png。只动图标与 manifest，不碰功能、样式、域名与后端。

产出（都在 public/ 下，构建后落在站点根路径）：
    favicon.ico                        16/32/48，取头像特写（小尺寸下才看得清）
    favicon-16x16.png / favicon-32x32.png  同上
    apple-touch-icon.png               180x180，整张 App 图标（主屏图标与 App 一致）
    apple-touch-icon-precomposed.png   180x180，同图，老 iOS 的预置路径
    icons/icon-192.png, icons/icon-512.png  manifest 图标

顺带把六个入口页里那条绿色小电视的 data:image/svg+xml 图标换成真图标链接，
并给 public/manifest.webmanifest 补 icons 数组。已经在位就跳过（可重复执行）。

用法（仓库根目录）：
    python scripts/site-icons-apu.py --dry-run
    python scripts/site-icons-apu.py
"""

import io
import json
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SOURCES = [
    "ios/ZhuijuAI/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png",
    "ios/scripts/appicon-source.png",
]

HTML_PAGES = [
    "index.html",
    "player/index.html",
    "playlists/index.html",
    "download/index.html",
    "library/history/index.html",
    "library/sessions/index.html",
]

# 头像特写（整图缩小到 16px 只剩一团色块，所以小尺寸用裁切）
FACE_BOX = (170, 40, 860, 730)

ICON_LINKS = """    <link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
    <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />"""

MANIFEST_ICONS = [
    {"src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
    {"src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
]


def read(path):
    with io.open(path, "r", encoding="utf-8", newline="") as fh:
        return fh.read()


def write(path, text):
    with io.open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def source_image():
    for rel in SOURCES:
        path = os.path.join(ROOT, rel)
        if os.path.exists(path):
            return path
    raise SystemExit("no app icon source found: %s" % ", ".join(SOURCES))


def make_icons(dry):
    src_path = source_image()
    src = Image.open(src_path).convert("RGB")
    face = src.crop(FACE_BOX).resize((512, 512), Image.LANCZOS)
    out = []

    def png(im, rel, size):
        out.append((rel, size, "image/png"))
        if dry:
            return
        path = os.path.join(ROOT, "public", rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        im.save(path, "PNG", optimize=True)

    # ICO：Pillow 从一张 256 底板缩放出 16/32/48 三个尺寸装进同一个文件
    if not dry:
        tmp = os.path.join(ROOT, "public", ".favicon-master.png")
        os.makedirs(os.path.dirname(tmp), exist_ok=True)
        face.resize((256, 256), Image.LANCZOS).save(tmp, "PNG")
    out.append(("favicon.ico", "16/32/48", "image/x-icon"))
    if not dry:
        master = Image.open(tmp)
        master.save(os.path.join(ROOT, "public", "favicon.ico"), format="ICO",
                    sizes=[(16, 16), (32, 32), (48, 48)])
        os.remove(tmp)

    png(face.resize((16, 16), Image.LANCZOS), "favicon-16x16.png", "16x16")
    png(face.resize((32, 32), Image.LANCZOS), "favicon-32x32.png", "32x32")

    touch = src.resize((180, 180), Image.LANCZOS)
    png(touch, "apple-touch-icon.png", "180x180")
    png(touch, "apple-touch-icon-precomposed.png", "180x180")

    png(src.resize((192, 192), Image.LANCZOS), "icons/icon-192.png", "192x192")
    png(src.resize((512, 512), Image.LANCZOS), "icons/icon-512.png", "512x512")
    return out


def rewrite_pages(dry):
    touched = []
    for rel in HTML_PAGES:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            continue
        text = read(path)
        if '<link rel="apple-touch-icon"' in text:
            continue
        lines = text.split("\n")
        replaced = False
        for i, line in enumerate(lines):
            if 'rel="icon"' in line and "data:image/svg+xml" in line:
                lines[i] = ICON_LINKS
                replaced = True
                break
        if not replaced:
            for i, line in enumerate(lines):
                if "</title>" in line:
                    lines.insert(i + 1, ICON_LINKS)
                    replaced = True
                    break
        if not replaced:
            raise SystemExit("%s: no </title> and no svg icon link, refusing to guess" % rel)
        if not dry:
            write(path, "\n".join(lines))
        touched.append(rel + ("  (替换 SVG 图标)" if 'data:image/svg+xml' in text else "  (新增图标链接)"))
    return touched


def rewrite_manifest(dry):
    path = os.path.join(ROOT, "public", "manifest.webmanifest")
    if not os.path.exists(path):
        raise SystemExit("public/manifest.webmanifest missing; run scripts/brand-rename-apu.py first")
    data = json.loads(read(path))
    if data.get("icons") == MANIFEST_ICONS:
        return []
    data["icons"] = MANIFEST_ICONS
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if not dry:
        write(path, text)
    return ["public/manifest.webmanifest  (+ icons)"]


def main():
    dry = "--dry-run" in sys.argv
    icons = make_icons(dry)
    pages = rewrite_pages(dry)
    manifest = rewrite_manifest(dry)

    head = "would write " if dry else "wrote       "
    for rel, size, kind in icons:
        print(head + "public/" + rel + "  " + size + "  " + kind)
    for line in pages + manifest:
        print(head + line)
    print("source: " + os.path.relpath(source_image(), ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())