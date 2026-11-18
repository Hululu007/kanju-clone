#!/usr/bin/env python3
"""把 XCUITest 的截图附件从 .xcresult 导成 PNG。

XCUITest 只在 result bundle 里留附件；审核的人要的是能直接看的图，所以这里：

1. `xcrun xcresulttool export attachments` 把附件摊到一个临时目录；
2. 按 manifest 里附件的名字重排成 `01-playing.png` 这种固定名（序号来自测试里给的
   `XCTAttachment.name`，例如 `01-playing`）；
3. 写一份 `INDEX.txt`（文件名 → 附件名 → 所属测试），并检查必须有的那几张是否齐了。

缺图直接以非零退出码结束：截图通道本身也要能被审，不能「导不出图还说通过」。
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

# 出包关卡必须有的截图（少一张就算这一轮没通过）
REQUIRED = [
    "01-playing",
    "02-download-episode",
    "03-fullscreen-adapt",
    "04-fullscreen-cover",
    "05-fullscreen-fill",
    "06-settings-download-list",
]


def export_raw(xcresult, workdir):
    subprocess.run(
        ["xcrun", "xcresulttool", "export", "attachments",
         "--path", xcresult, "--output-path", workdir],
        check=True,
    )
    return os.path.join(workdir, "manifest.json")


def walk(node, out):
    """manifest 的结构在不同 Xcode 版本里略有差别，这里只认「文件名 + 可读名」这一对。"""
    if isinstance(node, dict):
        exported = node.get("exportedFileName") or node.get("fileName")
        readable = (node.get("suggestedHumanReadableName")
                    or node.get("name")
                    or node.get("humanReadableName"))
        if exported and readable:
            out.append((str(exported), str(readable), str(node.get("testIdentifier", ""))))
        for value in node.values():
            walk(value, out)
    elif isinstance(node, list):
        for item in node:
            walk(item, out)


def safe(name):
    return re.sub(r"[^0-9A-Za-z._-]+", "-", name).strip("-") or "shot"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--xcresult", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    os.makedirs(args.output, exist_ok=True)
    with tempfile.TemporaryDirectory() as workdir:
        manifest_path = export_raw(args.xcresult, workdir)
        pairs = []
        if os.path.exists(manifest_path):
            with open(manifest_path, encoding="utf-8") as handle:
                walk(json.load(handle), pairs)

        index_lines = []
        used = set()
        for exported, readable, test_id in pairs:
            source = os.path.join(workdir, exported)
            if not os.path.exists(source):
                continue
            target_name = safe(readable) + (os.path.splitext(exported)[1] or ".png")
            stem, ext = os.path.splitext(target_name)
            counter = 2
            while target_name in used:
                target_name = "%s-%d%s" % (stem, counter, ext)
                counter += 1
            used.add(target_name)
            shutil.copyfile(source, os.path.join(args.output, target_name))
            index_lines.append("%s\t%s\t%s" % (target_name, readable, test_id))

        with open(os.path.join(args.output, "INDEX.txt"), "w", encoding="utf-8") as handle:
            handle.write("file\tattachment\t test\n")
            handle.writelines(line + "\n" for line in index_lines)

    names = sorted(os.listdir(args.output))
    print("exported %d file(s) into %s" % (len(names), args.output))
    for name in names:
        print("  " + name)

    missing = [item for item in REQUIRED if not any(name.startswith(item) for name in names)]
    if missing:
        print("missing screenshot(s): %s" % ", ".join(missing), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
