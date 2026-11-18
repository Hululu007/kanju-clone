# 出包关卡：真机 App + 逐张截图（XCUITest）

`ios-unsigned.yml` 在出 IPA 之后多跑一段 **真 App 的 UI 冒烟**：启动模拟器里的 App 本体
（不是测试里另建的 WKWebView），真点播放 / 下载 / 全屏三档画面 / 设置里的下载列表，每一步
`XCUIScreen.main.screenshot()` 留一张原图，导出成 PNG 随这一轮 run 一起上传。

页面来自**同机受控夹具站**，没有账号、不连公网：

| 组成 | 位置 | 作用 |
| --- | --- | --- |
| 夹具站 | `ios/UITests/Fixtures/fixture_server.py` | 静态页 + `/api/play` + 支持 `Range` 的视频 |
| 站点页 | `ios/UITests/Fixtures/site/` | 播放页/首页骨架，节点名与真站点一致（注入层照常挂载） |
| 片源 | 工作流里 `ffmpeg` 现生成 `media/fixture.mp4`（640×480，6 秒） | 截图里必须有真画面，4:3 才能看出三档差别 |
| 起始地址 | `KJTestLaunch` ← 环境变量 `KJ_TEST_HOME_URL` | **只在 Debug 构建生效**，Release 包永远走站点首页 |
| 用例 | `ios/UITests/DisplaySmokeUITests.swift`、`BatchDownloadSmokeUITests.swift` | 点页面 + 截图 |

## 跑一趟

```bash
# 默认（带 UI 冒烟）；集成分支
gh workflow run ios-unsigned.yml --repo kenzhao11/kanju-clone \
  --ref fix/ios-0.1.14-final

# 只出 IPA，不跑 UI 冒烟（不能用来出包）
gh workflow run ios-unsigned.yml --repo kenzhao11/kanju-clone \
  --ref fix/ios-0.1.14-final -f ui_smoke=false

gh run list --workflow ios-unsigned.yml --limit 5
gh run view <RUN_ID> --log-failed
```

## 取截图（独立审核用）

artifact 名固定为 `ZhuijuAI-ui-smoke-<完整commit sha>-run<RUN_ID>`：

```bash
RUN=<RUN_ID>
SHA=$(gh run view "$RUN" --json headSha --jq .headSha)
gh run download "$RUN" -n "ZhuijuAI-ui-smoke-${SHA}-run${RUN}" -D ./ui-smoke-$RUN
ls -l ./ui-smoke-$RUN/ui-screenshots
cat ./ui-smoke-$RUN/ui-screenshots/INDEX.txt
```

`INDEX.txt` 首行写明 `run=` / `sha=`，每张图一行：
`文件 → 附件名 → 证明什么 → 必读断言 → 对应测试函数`。
九张必需图之外的 `diagnostic-*` 图、`*-tree-*` 文本是断言失败时自动留的现场，
**不计入通过**，也不能替代最终图。

## 九张必需图（断言成功后才拍；少一张导出即失败）

| 文件 | 证明什么 | 通过前必须成立的断言 |
| --- | --- | --- |
| `01-playing` | 真片源在真 App 里开始播放 | 时间轴从 `0:00 / 0:00` 走到 `/ 0:06`（不使用常驻的「播放 / 暂停」aria-label 蒙混） |
| `02-download-episode` | 原位「下载本集」真的入队/完成 | 进度行离开 尚未下载/需登录/失败，出现百分比/正在连接/「用其他播放器播放 + 已下载」 |
| `03-fullscreen-adapt` | 进入全屏 + 适应档：完整画面、留黑边 | 真点「全屏播放」后等到真「退出全屏」；档位标签为适应（object-fit=contain 由 `FitModeTests` 验） |
| `04-fullscreen-cover` | 裁剪填满：等比放大裁边 | 点真「画面比例」后标签变裁剪（object-fit=cover 由 `FitModeTests` 验） |
| `05-fullscreen-fill` | 拉伸填满：不等比铺满 | 再点后标签变拉伸（object-fit=fill 由 `FitModeTests` 验） |
| `06-settings-download-list` | 设置面板里的真下载记录：剧名/封面/已下载集数/进度 | 证据来自下载片库本身（正在下载 测试剧·第19集 或 已下载 N 集），不是页面自己的选集列表 |
| `07-fit-cover-before-relaunch` | 杀进程前选的是裁剪 | 档位标签变裁剪后才拍 |
| `08-fit-remembered-after-relaunch` | 杀进程重进后仍是裁剪 | 重进后档位标签仍为裁剪（localStorage `kj-ios-fit` 由 `FitModeTests` 验） |
| `09-batch-download` | 批量下载真入队、按剧汇总 | 设置面板出现原生队列行「任务 x/y 集 · 进行中 n · 排队 n」，total ≥ 2，片库有「测试剧」且 ≥ 2 条集记录 |

编号说明：当前矩阵沿用前几轮 run 与审核目录已固定的命名——**03 是「全屏+适应」，09 是「批量」**。
Lead 交底里的 03=批量 / 09=重进持久与此不同，但 Ken 明确要求的五项（播放、单集下载、批量、
全屏三档、设置下载列表）一张不少；若要重编号请先确认，避免把旧证据的索引改串。

导出时会再核一遍：九张必需图少一张、或其中某张是纯色/空白（亮度跨度 < 12），
`export-ui-screenshots.py` 就以非零退出，workflow 那一步跟着红。XCTest 自动生成的
Synthesized-Event 附件和失败诊断图不参与这个检查，但会一起上传供逐张看。

## 两条已知假红的根因（已修，别再按老猜测改）

1. **全屏后找不到「退出全屏」/「画面比例」**（run 44292507284）：
   片源只有 6 秒，点全屏时视频已播完。注入层既有规则是「暂停/结束时控制栏常显」，
   旧探针却盲点画面中心，正好把控制栏**收起**（诊断附件 missing-fit-button 的可访问性树里
   连 `#ppCtrl` 都没有）。现在播完 01 先用真的「播放 / 暂停」按钮暂停，进全屏后
   `ensureControlsVisible` 只在真的没有控件时才点一次，且两次失败即留诊断判红。
2. **批量点完看不到队列**（run 44292507284）：
   旧代码在 `.any` 里找第一个含「一键全集/批量」的节点，实际 tap 到「从本集往后」；
   随后又用 `CONTAINS "设置"` 点到了「显示设置」（站点自己的面板），而按剧汇总的队列行
   渲染在注入层设置面板里。现在只按 button role + 精确 label 找真按钮。

## 夹具站端口

XCTest 步骤也会在 8765 起 `python3 -m http.server`（根目录 `ios/Tests`）。
出包关卡起夹具站前会先 `lsof -ti tcp:8765 | xargs -r kill -9`，并要求
`/player/index.html` 与 `/media/fixture.mp4` 都是 200，否则这一步直接红
（run 44272465791 就是端口冲突导致 App 加载 404 页的假红）。

## 本轮刻意不做的事

- **不 skip 批量下载**：`BatchDownloadSmokeUITests` 在入口不存在、队列不到、截图不齐时都直接
  `XCTFail`（不会 `XCTSkip`），并留下可访问性树。
- **不改设备 Release 签名**：模拟器仍是 Xcode 默认 ad-hoc（`CODE_SIGN_IDENTITY=-`），
  设备 Release 仍 `CODE_SIGNING_ALLOWED=NO`；只在公开仓库的免费 `macos-15` runner 上跑。
- **不拿 Node/静态 DOM 冒充实机**：`ios/Tests/` 那层证明注入层逻辑，这一层证明真 App。

## 本地排查

```bash
cd ios
python3 UITests/Fixtures/fixture_server.py --root UITests/Fixtures/site --port 8765 &
xcodegen generate
xcodebuild -project ZhuijuAI.xcodeproj -scheme ZhuijuAI \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO INFOPLIST_FILE=FixtureInfo.plist \
  -only-testing:ZhuijuAIUITests test
```
