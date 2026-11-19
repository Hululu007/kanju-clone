#!/usr/bin/env python3
"""把 XCUITest 的截图附件从 .xcresult 导成 PNG。

XCUITest 只在 result bundle 里留附件；审核的人要的是能直接看的图，所以这里：

1. `xcrun xcresulttool export attachments` 把附件摊到一个临时目录；
2. 按 manifest 里附件的名字重排成 `01-playing.png` 这种固定名（序号来自测试里给的
   `XCTAttachment.name`，例如 `01-playing`）；
3. 写一份 `INDEX.txt`（文件名 → 附件名 → 功能 → 测试 → run/sha），并检查十张必需图是否齐了。

缺图直接以非零退出码结束：截图通道本身也要能被审，不能「导不出图还说通过」。
失败时测试留下的 `diagnostic-*` 图/树也会一并导出，但**不计入**十张必需图，
也不参与纯色检查（XCTest 自己的 Synthesized-Event 图可能是纯色，不能误伤）。
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

# 出包关卡必须有的截图（少一张就算这一轮没通过）。
# 01-08 覆盖播放、下载页、三档全屏、设置账号状态和模式持久化；09/10 核对单集下载。
REQUIRED = [
    "01-playing",
    "02-download-page",
    "03-fullscreen-adapt",
    "04-fullscreen-cover",
    "05-fullscreen-fill",
    "06-settings-account-status",
    "07-fit-cover-before-relaunch",
    "08-fit-remembered-after-relaunch",
    "09-download-page",
    "10-my-downloads-single-episode",
]

# 每张最终图对应哪个功能、哪条断言、哪个测试函数。INDEX 里逐张写清楚。
SCREEN_MAP = {
    "01-playing": (
        "播放：受控 4:3 真片源在真 App 里播放，时间轴从 0:00 走动",
        "时间轴出现 / 0:06 且不为 0:00 /（不是常驻的「播放 / 暂停」aria-label）",
        "DisplaySmokeUITests.testTheAppPlaysDownloadsAndShootsEveryFitMode",
    ),
    "02-download-page": (
        "下载页：单集下载网格在正确页面显示",
        "打开剧名旁下载入口后出现单集下载网格",
        "DisplaySmokeUITests.testTheAppPlaysDownloadsAndShootsEveryFitMode",
    ),
    "03-fullscreen-adapt": (
        "全屏 + 适应档：真点「全屏播放」，画面铺满且留边不裁",
        "先等到真「退出全屏」出现，控制栏可见；档位标签为适应；object-fit=contain 由 FitModeTests 验",
        "DisplaySmokeUITests.testTheAppPlaysDownloadsAndShootsEveryFitMode",
    ),
    "04-fullscreen-cover": (
        "裁剪填满：等比放大裁边",
        "点真「画面比例」后档位标签变裁剪；object-fit=cover 由 FitModeTests 验",
        "DisplaySmokeUITests.testTheAppPlaysDownloadsAndShootsEveryFitMode",
    ),
    "05-fullscreen-fill": (
        "拉伸填满：不等比铺满",
        "再点后档位标签变拉伸；object-fit=fill 由 FitModeTests 验",
        "DisplaySmokeUITests.testTheAppPlaysDownloadsAndShootsEveryFitMode",
    ),
    "06-settings-account-status": (
        "设置账号状态：资料和账号安全暂未开放",
        "账号设置行显示即将上线，下载页不嵌入设置",
        "DisplaySmokeUITests.testTheAppPlaysDownloadsAndShootsEveryFitMode",
    ),
    "07-fit-cover-before-relaunch": (
        "模式持久化：杀进程前选的是裁剪",
        "档位标签变裁剪后才拍",
        "DisplaySmokeUITests.testTheChosenFitModeSurvivesARelaunch",
    ),
    "08-fit-remembered-after-relaunch": (
        "模式持久化：重进 App 后仍是裁剪",
        "重进后档位标签仍为裁剪；localStorage kj-ios-fit 由 FitModeTests 验",
        "DisplaySmokeUITests.testTheChosenFitModeSurvivesARelaunch",
    ),
    "09-download-page": (
        "新版单集下载页",
        "剧名旁的下载入口打开独立单集网格，没有旧批量入口",
        "BatchDownloadSmokeUITests.testTheEpisodePageOffersSingleDownloadAndShowsItsLibraryEntry",
    ),
    "10-my-downloads-single-episode": (
        "我的下载：逐集显示真实入队记录",
        "下载一集后在我的下载页能看到剧名和集号",
        "BatchDownloadSmokeUITests.testTheEpisodePageOffersSingleDownloadAndShowsItsLibraryEntry",
    ),
}


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


def matched_key(name):
    for key in REQUIRED:
        if name.startswith(key):
            return key
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--xcresult", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--run", default="local", help="GitHub Actions run id，写进 INDEX")
    parser.add_argument("--sha", default="local", help="被测 commit sha，写进 INDEX")
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
            key = matched_key(target_name)
            if key:
                feature, assertion, test_name = SCREEN_MAP[key]
            elif target_name.startswith("diagnostic-"):
                feature = "失败现场诊断（不计入必需图）"
                assertion = "断言失败时自动留图/树/方向"
                test_name = test_id or "ui-smoke"
            else:
                feature = "XCTest 自动附件（不计入必需图）"
                assertion = "-"
                test_name = test_id or "ui-smoke"
            index_lines.append("\t".join([target_name, readable, feature, assertion, test_name]))

        with open(os.path.join(args.output, "INDEX.txt"), "w", encoding="utf-8") as handle:
            handle.write("# run=%s sha=%s\n" % (args.run, args.sha))
            handle.write("# 十张必需图按断言成功后的最终截图计数；diagnostic-* 为失败诊断，不算通过\n")
            handle.write("file\tattachment\tfeature\tassertion\ttest\n")
            handle.writelines(line + "\n" for line in index_lines)

    names = sorted(os.listdir(args.output))
    print("exported %d file(s) into %s" % (len(names), args.output))
    for name in names:
        print("  " + name)

    missing = [item for item in REQUIRED if not any(name.startswith(item) for name in names)]
    if missing:
        print("missing screenshot(s): %s" % ", ".join(missing), file=sys.stderr)
        return 1
    # 图不能是空白/全黑：只核十张最终图。
    try:
        from PIL import Image  # noqa: F401  (有装就核，没装就交给人工看图)
    except ImportError:
        print("Pillow 未安装，像素级空白检查跳过（仍由人工逐张看原图）", file=sys.stderr)
        return 0
    verdict = 0
    for name in names:
        key = matched_key(name)
        if not key or not name.endswith(".png"):
            continue
        path = os.path.join(args.output, name)
        try:
            with Image.open(path) as image:
                gray = image.convert("L").resize((64, 64))
                pixels = list(gray.getdata())
        except Exception as error:  # noqa: BLE001
            print("无法读取 %s: %s" % (name, error), file=sys.stderr)
            verdict = 1
            continue
        span = max(pixels) - min(pixels)
        if span < 12:
            print("最终截图看起来是纯色/空白（亮度跨度 %d）：%s" % (span, name), file=sys.stderr)
            verdict = 1
    return verdict


if __name__ == "__main__":
    sys.exit(main())
