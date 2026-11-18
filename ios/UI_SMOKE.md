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
# 默认（带 UI 冒烟）
gh workflow run ios-unsigned.yml --ref fix/ios-0.1.14-display-smoke

# 只出 IPA，不跑 UI 冒烟
gh workflow run ios-unsigned.yml --ref fix/ios-0.1.14-display-smoke -f ui_smoke=false

# 看这一轮
gh run list --workflow ios-unsigned.yml --limit 5
gh run view <RUN_ID> --log-failed
```

## 取截图（审核用）

artifact 名固定为 `ZhuijuAI-ui-smoke-<完整commit sha>-run<RUN_ID>`：

```bash
RUN=<RUN_ID>
gh run view "$RUN" --json artifacts --jq '.artifacts[].name'
gh run download "$RUN" -n "ZhuijuAI-ui-smoke-$(gh run view "$RUN" --json headSha --jq .headSha)-run$RUN" \
  -D ./ui-smoke-$RUN
ls -l ./ui-smoke-$RUN/ui-screenshots
cat ./ui-smoke-$RUN/ui-screenshots/INDEX.txt
```

固定文件名（少一张，`export-ui-screenshots.py` 就非零退出，artifact 里也会缺图）：

| 文件 | 证明什么 |
| --- | --- |
| `01-playing` | 真片源在真 App 里开始播放（控制栏变成「暂停」） |
| `02-download-episode` | 工具条那一格永远是「下载本集」，所以证据是「下载进度：」离开 尚未下载/需登录/失败，且第19集出现在真实队列状态里（截图前先断言） |
| `03-fullscreen-adapt` | 全屏 + 适应档：完整画面、留边不裁 |
| `04-fullscreen-cover` | 裁剪档：铺满屏幕、等比裁边 |
| `05-fullscreen-fill` | 拉伸档：不等比铺满 |
| `06-settings-download-list` | 设置面板里的真下载记录：先断言 测试剧 + 第19集 + 状态（已下载/正在下载/下载进度）都出现，再截图 |
| `07-fit-cover-before-relaunch` | 杀进程前选的是「裁剪」 |
| `08-fit-remembered-after-relaunch` | 杀进程重进后仍是「裁剪」（记住上次选择） |
| `09-batch-download` | 批量真的入队：先等到「任务 x/y 集 · 进行中 n · 排队 n」再拍（不再 tap 完立刻拍） |

导出时会再核一遍：必需图（01–09）少一张、或某张是纯色/空白（亮度跨度 < 12），
`export-ui-screenshots.py` 就以非零退出，workflow 那一步跟着红——不会出现「图和包都缺了但流程是绿的」。

夹具站端口注意：XCTest 步骤也会在 8765 起一个 `python3 -m http.server`（根目录是 `ios/Tests`）。
出包关卡起夹具站前会先杀掉占 8765 的进程，并要求 `page`/`media` 都是 200，否则这一步直接红。
不然 App 会加载到一个 404 页，然后报「找不到开始播放测试片 / 批量入口」这种看起来像产品 bug 的红
（run 44272465791 就是这么红的）。

## 本轮刻意不做的事

- **不 skip 批量下载**：`BatchDownloadSmokeUITests` 在入口不存在时直接失败并留下可访问性树。
  下载队列合入前这一条红是如实结果；合入后它必须真绿，不许改成跳过。
- **不改设备 Release 签名**：模拟器仍是 Xcode 默认 ad-hoc（`CODE_SIGN_IDENTITY=-`），
  设备 Release 仍 `CODE_SIGNING_ALLOWED=NO`；不在付费 runner 上跑。
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
