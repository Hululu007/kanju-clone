# iOS 回归清单

每次修完真机问题都往这里加一条。**先写复现测试并确认它在修复前失败，再改代码**，然后更新本表。
「修复版本」写这次修复随包的版本号；`测试名` 是 `node --test ios/Tests/*.test.mjs` 里的用例名，
能直接用 `--test-name-pattern` 单独跑。

跑法：

```bash
node --test ios/Tests/bootstrap.test.mjs
# 只跑一条
node --test --test-name-pattern='landscape playback goes immersive again' ios/Tests/bootstrap.test.mjs
```

两层验证：

| 层 | 位置 | 能证明什么 |
| --- | --- | --- |
| Node 夹具 | `ios/Tests/bootstrap.test.mjs` | 逻辑分支、状态机、消息内容（假 DOM，跑得最快） |
| 模拟器 WKWebView | `ios/Tests/InjectedUITests.swift`，CI `ios-unsigned.yml` | 真 DOM、真 CSS 计算值、真点击链路、真原生消息通道（不联网、不需签名、不需站点密码） |
| 真机 | 见每条条目的「验证边界」 | 真实片源解码、后台音频、画中画、系统播放器列表、音频焦点 |

## REG-001 横屏全屏里影视标题不消失

- **现象**：横屏全屏播放时，画面上方仍压着「片名 · 第N集」和整条页眉工具条；必须反复点两次全屏才偶尔消失。
- **复现步骤**：
  1. 打开任意剧集的播放页，开始播放。
  2. 点底部控制栏「全屏」，进入横屏全屏。
  3. 点「退出全屏」，等回到竖屏页内布局。
  4. 把手机转成横屏继续播放（或再点一次播放/换一集）。
  5. 观察：标题和上方工具条留在画面上，只能再点两次全屏才收起。
- **根因**（`ios/ZhuijuAI/AppBootstrap.js`）：
  1. `setUserFullscreen(false)` 把 `explicitInline = true` 记住「用户要留在页内」，但只有再次点全屏
     或转回竖屏才会清掉它。之后横屏播放时 `applyImmersive()` 里
     `activePlayback && landscape() && !explicitInline` 永远为假，沉浸态再也进不来 —— 标题就挂在画面上。
  2. 站点自带的「全屏」按钮优先走标准全屏 API（`player.requestFullscreen`），这条路不触发
     `data-ios-immersive`，注入层也没有 `fullscreenchange` 监听和 `:fullscreen` 样式，所以标题同样不被隐藏。
- **修复**：
  - 新的 `play` 事件（换集/重新播放）清掉 `explicitInline`；`orientationchange` 转回横屏时也清掉。
  - 新增 `fullscreenchange` / `webkitfullscreenchange` 监听，标准全屏期间按沉浸态处理（`applyImmersive()` 把
    `document.fullscreenElement` 计入沉浸判断）。
  - 追加 `#player:fullscreen .p-label` / `:-webkit-full-screen` 与工具条、底栏、弹幕输入的兜底样式
    （两条分开写，不认识 `-webkit-` 别名内核不会整条丢弃）。
- **测试名**（Node 夹具）：
  - `landscape playback goes immersive again after a fullscreen round trip`
  - `rotating back to landscape during playback restores immersive mode`
  - `the standard fullscreen api hides the title and keeps immersion in sync`
- **测试名**（模拟器，真 WKWebView）：
  - `InjectedUITests.testLandscapePlaybackHidesTheTitleAndSurvivesAFullscreenRoundTrip`（横屏帧尺寸下真点两次全屏、再播一次，读 `getComputedStyle` 确认标题 `display:none`）
  - `InjectedUITests.testStandardFullscreenRulesHideTheTitle`（`:fullscreen` 规则真的进了样式表：写错字符会被整条丢掉）
- **修复版本**：0.1.10
- **验证边界**：三条都是注入层行为，可在 Node 夹具里完整验证；真机上仍需确认 1) iOS 16+ 的
  `requestGeometryUpdate` 之后 `resize/orientationchange` 的触发顺序，2) 刘海屏安全区下控制栏不被裁。

## REG-002 首页设置面板看不到下载进度

- **现象**：下载在跑，但只有播放页的「显示设置」里能看到进度；回到首页点顶栏设置图标只弹「设置面板即将上线」，
  下载状态、完成后的「用其他播放器播放」都找不到。中途换页后进度条重置成「尚未下载」。
- **复现步骤**：
  1. 登录，播放一集 MP4 线路，点「外放 → 下载本集」。
  2. 下载进行中返回首页。
  3. 点顶栏设置图标。
  4. 观察：只有一句「设置面板即将上线」，没有任何下载进度；重新进播放页也是「尚未下载」。
- **根因**（`ios/ZhuijuAI/AppBootstrap.js`）：
  1. `mountDownloadPanel()` 只往站点的 `#settingsPanel`（播放页才有的节点）里塞进度块，
     首页没有这个节点就直接 `return false`，注入层也没有自己的设置面板。
  2. 下载状态只存在内存里的 `downloadState`，而原生 `URLSession` 在网页外面跑：换页后
     新页面无从得知已有任务，`window.__zhuijuDownload` 的进度事件也对不上 id。
- **修复**：
  - 新增注入层设置面板 `#iosSettingsSheet`（底部弹层，带关闭按钮、点深色底可关），
    拦截站点的 `[data-action="settings"]` 点击，不再落到「即将上线」的 toast。
  - 进度块 `#iosDownloadStatus` 只有一个实例，跟着当前打开的面板走：面板开着就在面板里，
    收起后回到播放器的「显示设置」，避免两份状态对不上。
  - 下载状态落 `localStorage['kj-ios-download']`（id / name / path / busy / percent / error），
    页面加载时恢复，原生回传的 `progress` / `done` / `failed` 事件按 id 继续接到新页面。
- **测试名**（Node 夹具）：
  - `the home page settings panel shows the download progress`
  - `a running download keeps reporting progress after going back home`
  - `the download block follows whichever settings panel is open`
  - `tapping the dimmed backdrop closes the settings panel`
  - `a burst of progress events never loses the finished state on disk`（写盘限流不能吞掉最后一次状态转变）
- **测试名**（模拟器，真 WKWebView）：
  - `InjectedUITests.testSettingsSheetShowsTheRunningDownload`（点击顶栏设置 → 面板可见、进度块在面板里、42% → 55% → 完成，且完成状态已落盘）
  - `InjectedUITests.testSettingsSheetCanBeClosedAndReopened`
- **修复版本**：0.1.10
- **验证边界**：进度事件的端到端链路仍要求真机/模拟器里真跑 `MediaDownloader`（Node 夹具只能模拟回传）。

## REG-003 默认卡在「外放」菜单，不能直接用第三方播放器

- **现象**：想看别的播放器必须点「外放」→ 再点一行菜单，等于每次两步；播放器 App 里打开了，
  手机这边还在外放出声，用户以为没交接出去。
- **复现步骤**：
  1. 播放一集，点底部控制栏「外放」。
  2. 观察：只弹出菜单（分享/复制/下载/进度），没有「直接交给播放器」的路径。
  3. 即使选了分享把地址交给播放器，App 内视频仍在继续播放、继续出声。
- **根因**（`ios/ZhuijuAI/AppBootstrap.js`）：
  1. 「外放」按钮没有任何默认行为，永远只 `toggleCastMenu()`，第三方播放器藏在菜单第二层，
     而且菜单里只有「分享播放地址」这种间接说法。
  2. `shareLink()` 交接前不停 `video`，原生播放器接管后本机仍在外放。
- **修复**：
  - 菜单顶部新增第一行「用第三方播放器播放」(`#ppPlayExternal`)，当前 https 直链直接交给系统播放器列表；
    HLS 线路也能交（播放器认得 m3u8），只是不能整集下载。
  - 默认值 `kj-ios-ext-player`（未设置时视为开启）：点「外放」= 直接交接，一步到位；
    长按「外放」仍可打开完整菜单（复制/下载/分享），设置面板里的 `#iosExtToggle` 可切回「先开菜单」。
  - `playExternal()` / `shareLink()` / `openLocal()` 交接前先 `video.pause()`，避免交接后手机自己还在放。
- **测试名**（Node 夹具）：
  - `the cast button hands the episode to a third-party player in one tap by default`
  - `a long press on the cast button still opens the full menu`
  - `the cast menu always starts with the third-party player row`
  - `HLS lines can still be played by an external player even though they cannot be downloaded`
  - `the settings panel can switch the default player back to the app`
- **测试名**（模拟器，真 WKWebView）：
  - `InjectedUITests.testCastButtonHandsTheLinkToTheSystemPlayerInOneTap`（点一下就发出 `share` 消息、且先调了 `pause`）
  - `InjectedUITests.testCastMenuLeadsWithTheExternalPlayerRow`（长按才开菜单，第一行是第三方播放器）
  - `InjectedUITests.testSettingsSheetCanTurnTheOneTapHandoffOff`
- **修复版本**：0.1.10
- **验证边界**：**必须真机验收**。模拟器和 Node 夹具只能证明「直链按 `share` 动作交给了原生层」，
  证明不了系统分享面板里到底列出哪些播放器 App（取决于安装了哪些 App 及其声明的 UTI），
  也证明不了本机音频焦点确实交出去了。验收清单：装了 VLC/Infuse 的机器上点一次「外放」，
  应在系统播放器列表里看到它们；选中后手机不再外放出声；返回 App 后播放器控制栏仍可用。

## 模拟器验收记录

`InjectedUITests` 在 GitHub Actions 的 `macos-15` + iOS 模拟器上跑（`ios-unsigned.yml` 的
“Run WKWebView playback regression on simulator” 步骤），不联网、不签名、不需要站点密码。

| 运行 | 代码 | 结果 |
| --- | --- | --- |
| [44215579006](https://github.com/kenzhao11/kanju-clone/actions/runs/44215579006) | 0.1.9 的 `AppBootstrap.js`（临时对照分支，已删） | **7 条全红**，失败信息就是本次的三个 bug |
| [44214561047](https://github.com/kenzhao11/kanju-clone/actions/runs/44214561047) | 本分支（0.1.10） | 7 条全绿 + Node 接口测试全绿 + Release 包编译通过 |

0.1.9 那次的具体失败（可直接对照现象）：

```
landscape=true playing=true/none/none fullscreen=true/none/none exited=false/inline/block replayed=false/inline/block
  → 退出一次全屏后再播，标题回到 display:inline，工具条 block（REG-001）
{"label":0,"toolbar":0,"tabbar":0}
  → 标准全屏的 :fullscreen 规则一条都没有（REG-001 第二条路）
TypeError: null is not an object (evaluating 'sheet.hidden')
  → 注入层自己的设置面板压根不存在（REG-002）
{"pauseCalls":0,"menuOpen":true,"preference":null}
  → 「外放」只弹菜单、没暂停、也没记住使用方式（REG-003）
```

## 历史条目

0.1.1~0.1.9 的问题与修复过程记录在 `IOS_FIXES_0.1.2.md` ~ `IOS_FIXES_0.1.6.md`、`IOS_REVIEW_0.1.1.md`；
本表从 0.1.10 起作为新增回归的正式清单。
