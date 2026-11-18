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
  真机复核（0.1.10）又发现更显眼的一处：站点播放页的**顶栏**（返回箭头 + 片名「百日谎言」 + 主题 + 菜单，
  即 `pageHead()` 渲染的 `.page-head`）也一直挂在画面最上面——它不在播放器里，所以第一条修法管不到。
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
  3. 站点头栏 `.page-head` 和播放器不在同一个层叠上下文里（播放器是 `position:fixed;z-index:10000`，
     但头栏照样画在上面），光靠 z-index 压不住；注入层的隐藏清单里当时只有播放器内部的 `.p-label`。
  2. 站点自带的「全屏」按钮优先走标准全屏 API（`player.requestFullscreen`），这条路不触发
     `data-ios-immersive`，注入层也没有 `fullscreenchange` 监听和 `:fullscreen` 样式，所以标题同样不被隐藏。
- **修复**：
  - 新的 `play` 事件（换集/重新播放）清掉 `explicitInline`；`orientationchange` 转回横屏时也清掉。
  - 沉浸态同时收起站点头栏：`.page-head` / `.topbar` / `.ph-back` / `.ph-title` 各一条 `display:none !important`，
    并加进 `HIDE_IN_IMMERSIVE`，退出全屏原样恢复（否则回不到上一页）。
  - 新增 `fullscreenchange` / `webkitfullscreenchange` 监听，标准全屏期间按沉浸态处理（`applyImmersive()` 把
    `document.fullscreenElement` 计入沉浸判断）。
  - 追加 `#player:fullscreen .p-label` / `:-webkit-full-screen` 与工具条、底栏、弹幕输入的兜底样式
    （两条分开写，不认识 `-webkit-` 别名内核不会整条丢弃）。
- **测试名**（Node 夹具）：
  - `landscape playback goes immersive again after a fullscreen round trip`
  - `rotating back to landscape during playback restores immersive mode`
  - `the standard fullscreen api hides the title and keeps immersion in sync`
  - `immersive hides the site page header that carries the film title`（0.1.10 漏掉的那条：头栏必收必还）
- **测试名**（模拟器，真 WKWebView）：
  - `InjectedUITests.testLandscapePlaybackHidesTheTitleAndSurvivesAFullscreenRoundTrip`（横屏帧尺寸下真点两次全屏、再播一次，读 `getComputedStyle` 确认 `.p-label`、工具条和 `.page-head` 头栏都是 `display:none`）
  - `InjectedUITests.testStandardFullscreenRulesHideTheTitle`（`:fullscreen` 规则真的进了样式表：写错字符会被整条丢掉）
- **修复版本**：0.1.10（头栏那部分 0.1.11）
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

## REG-004 下载入口找不到（「弹幕」按钮换成「下载」）

- **现象**：工具条那排是「显示设置 / 线路 / 弹幕 / 画中画 / 下一集」，看不到下载；而「外放」在 0.1.10 起
  默认直接交给第三方播放器，下载只剩「长按外放 → 菜单里那一行」，用户找不到入口（原话：我都找不到在哪里下载了）。
- **复现步骤**：进任意剧集播放页，扫一眼视频下方那排工具按钮；想下载时点「外放」——它直接弹系统播放器列表。
- **根因**：0.1.10 为了「点一下就换播放器」把菜单收进了长按，下载作为菜单第三行被一起藏了；
  工具条那排是站点模板渲染的，注入层只挂了控制栏，没有往工具条里加下载入口。
- **修复**：按用户要求把「弹幕」那一格换成下载 —— 隐藏站点 `#dmBtn`（不删除节点），在同位置插入
  `#ppToolDownload`：`下载本集` → `下载 43%` → `用播放器打开`（点一下就是交给播放器 App）。
  未登录点它仍然只弹站点登录提示；下载中再点是取消（和菜单行为一致）。
- **测试名**（Node 夹具）：
  - `the toolbar download button takes the danmaku slot and drives the transfer`
  - `the toolbar download button asks for login instead of transferring`
- **测试名**（模拟器）：`InjectedUITests.testToolbarDownloadButtonReplacesTheDanmakuSlot`
- **修复版本**：0.1.11
- **验证边界**：按钮位置与状态文案已在模拟器真读 `getComputedStyle` 确认；真实传输进度仍依赖原生
  `MediaDownloader`，靠真机看百分比是否跟着走。

## REG-005 横屏全屏上方那条 60px 深灰遮罩；控制栏一直挂着

- **现象**：横屏全屏播放时画面上方压着一条约 60px 高的深灰色渐变带，把画面顶部整段挡住
  （真机截图 11:12 里就是它）。底部控制栏一直显示并带着黑色渐变底，即使正在播放也不收起。
- **复现步骤**：
  1. 进任意剧集播放页，点播放。
  2. 点底部「全屏」进横屏全屏。
  3. 观察：画面上方有一条深灰带；底部控制栏常显。
  4. 点一下画面：没有任何反应（既不会收起也不会再出现）。
- **根因**（`ios/ZhuijuAI/AppBootstrap.js` + 站点 `src/styles.css`）：
  1. 站点移动端把滚动容器写成 `.main{margin-top:60px;height:calc(100vh - 60px)}`，注入层又给
     `.main` 加了 `-webkit-overflow-scrolling:touch`。WebKit 会把容器里的 `position:fixed`
     收编成相对这个滚动容器定位，于是 `#player` 的 `inset:0` 只铺满了 `.main` 那一块
     （高度正好是 `100vh - 60px`），顶部 60px 漏出 `html` 的渐变背景 —— 就是那条遮罩。
  2. `#ppCtrl` 只有「始终显示」一种状态：点画面不会切换，也没有自动收起，底部渐变一直在。
- **修复**：
  - 沉浸态把 `.main` 本身铺满整屏（`position:fixed;inset:0;height:100%;margin:0;overflow:hidden;
    -webkit-overflow-scrolling:auto`）：不管 fixed 以视口还是以它为参照，`#player` 都正好盖住屏幕。
  - 控制栏新增 `pc-hidden`（整条 `opacity:0;visibility:hidden;pointer-events:none`，不留渐变/遮罩）：
    进全屏且正在播放直接收起；点一下画面叫出来；3 秒不动自动收起；再点一下立即收起；暂停时留着；
    退出全屏恢复常显。
- **测试名**（模拟器，真 WKWebView）：
  - `InjectedUITests.testFullscreenCoversTheWholeScreenAndHidesItsControls`
    （读 `getBoundingClientRect` 确认 `#player` 和 `.main` 都是 0,0,844,390；`elementFromPoint` 确认
    屏幕最上面一行已经是视频、底部没有残留底栏；再验点一下出现 / 再点收起 / 3 秒自动收起 / 退出恢复）
- **修复版本**：0.1.12
- **验证边界**：模拟器里 `position:fixed` **不会**被 `.main` 收编（`#player` 一直是 0,0,844,390），所以真机那条
  60px 遮罩在模拟器上复现成「容器仍是 0,60,844,330 + 控制栏不收」。也就是说这条用例钉住的是修复本身
  （滚动容器必须铺满 + 控制栏收起），不是真机 WebKit 的具体行为了；真机仍需确认顶部没有残留。

## REG-006 设置里的下载只有一条进度，看不到下了哪些剧

- **现象**：设置面板里只有「下载进度：63%」一根条；下过哪些剧、每部下了哪几集、共几集都看不到。
- **复现步骤**：
  1. 下载某一集的 MP4 直链，完成后再换一集、甚至可以换一部剧。
  2. 回首页点顶栏设置图标（或播放页的「显示设置」）。
  3. 观察：只有最近一条进度，没有任何片库信息。
- **根因**：下载状态只有 `kj-ios-download` 这一条「当前任务」；完成事件只更新它，不记录剧名 / 封面 /
  集号 / 总集数；设置面板也只渲染这一个进度块。原生下载一次一集，网页侧没有别的地方能知道下过什么。
- **修复**：新增 `kj-ios-downloads` 片库（按站点媒体 id 分组，拿不到 id 时退回剧名，同一部剧不会碎成两条）。
  下载开始时用 `showMeta()` 记下剧名 / 封面 / 总集数（总集数来自 `#epGrid .ep` 数量或「显示全部 N 集」，
  电影/单集记 1，取不到就记 0），完成时把集号 / 集名 / 路径 / 大小写进去。设置面板按剧渲染：
  封面 + 片名 + 「已下载 N/M 集」+ 每集小签，最上面还有正在下载那一集的剧名 / 集号 / 百分比。
  **总集数未知时只写「已下载 N 集」，不编分母**；没有封面的片子不摆假图。
- **测试名**（Node 夹具）：
  - `the settings sheet lists downloaded shows with covers, episodes and totals`
  - `the download library stays out of the way when nothing was downloaded`
  - `a finished download joins the library with its show, episode and total`（含换页/重启后仍在）
  - `the running download shows its show, episode and percent in the library`
- **测试名**（模拟器）：`InjectedUITests.testSettingsSheetListsDownloadedShowsAndTheRunningTask`
- **修复版本**：0.1.12
- **验证边界**：封面是站点海报 URL，离线时需要联网才显示（离线就是底色块）；真实下载进度仍靠原生回传。

## REG-007 下载一离开前台就停

- **现象**：点下载后切到别的 App 或锁屏，下载停在原处，回来才继续；App 被系统回收后连进度都没了。
- **复现步骤**：
  1. 播放一集 MP4 直链，点「下载本集」。
  2. 立刻回主屏（或锁屏）停留半分钟。
  3. 回到 App：进度没有前进（0.1.11 用的是前台 `URLSession`）。
- **根因**：`MediaDownloader` 用 `URLSessionConfiguration.default`，会话只在 App 前台跑；
  任务和状态只在内存里，进程被回收就全丢；`AppDelegate` 也没有实现后台会话回调，
  后台跑完的事件交不回网页。
- **修复**：
  - 改用 `URLSessionConfiguration.background(withIdentifier: "org.dpdns.zhuiju.ios.downloads")`
    （`isDiscretionary=false`、`sessionSendsLaunchEvents=true`）。
  - 任务 / 进度 / 终态落 `kj-ios-download-tasks`（UserDefaults），`taskDescription` = 网页给的下载 id。
  - `AppDelegate` 实现 `application(_:handleEventsForBackgroundURLSession:completionHandler:)`；
    回到前台（`didBecomeActive`）或网页发 `downloadSync` 时重放状态：进度可重复，完成/失败/取消只交一次。
  - 后台跑完发本地通知（首次下载时请求授权，**拒绝授权不影响下载**）。
  - 进程被回收后重新拉起：`getAllTasks` 对账，任务已经不在了就如实标「下载被系统中断」，
    绝不标完成。取消/失败也不会写成完成。
- **支持范围**：MP4 / M4V / MOV / MKV / TS 的 https 直链可下；HLS（`.m3u8`）仍然如实拒绝、不会标完成。
- **后台传输由谁执行 / 之前为什么测不出来**：`URLSessionConfiguration.background` 的任务由系统的
  `com.apple.nsurlsessiond` 执行。第一次跑集成测试时后台会话立刻以
  `NSCocoaErrorDomain 4097`（connection to service named com.apple.nsurlsessiond）失败，
  看起来像 localhost 不通，其实不是：同一地址的前台请求正常，`launchctl print` 里守护进程
  `state = running`。真正的原因是模拟器测试宿主**没有签名**（CI 一直用
  `CODE_SIGNING_ALLOWED=NO`），nsurlsessiond 的 XPC 连接按代码签名拒了它。
  现在模拟器构建按 Xcode 默认做 ad-hoc 签名（`CODE_SIGN_IDENTITY=-`，设备 Release 包仍然不签名），
  工作流还会 `codesign -dv` 留档；测试里用前台预检把「受控源不可达」单独报出来。
- **测试名**（模拟器 XCTest，**真实后台会话**，系统触发 delegate）：
  - `BackgroundTransferIntegrationTests.testBackgroundSessionTransfersTheControlledFileAndRecordsItConsistently`
    （从 CI 的受控 http 源下载 `sample.mp4`：校验任务 id 来自系统、媒体元数据保留、文件大小与
    SHA-256 和受控源一致、完成记录落盘为 done、重连对账不改状态、终态只交给网页一次）
  - `BackgroundTransferIntegrationTests.testBackgroundSessionReportsProgressBeforeItFinishes`
    （进度由系统回调驱动，最终字节数等于文件大小）
- **测试名**（模拟器 XCTest，单元/状态机）：
  - `DownloadBackgroundTests.testAppDelegateAnswersTheBackgroundSessionCallback`
  - `DownloadBackgroundTests.testStartingADownloadPersistsTheTaskSoItCanBeRecovered`
  - `DownloadBackgroundTests.testDelegateTailMovesTheFileAndRecordsDoneUnit`
    （**只是收尾逻辑的单元测试**，手工调用 delegate；不充当后台传输的集成验证）
  - `DownloadBackgroundTests.testCancelledDownloadIsRecordedAsCancelledNotDone`
  - `DownloadSessionTests.testDownloadSessionIsBackgroundAndNamedForRelaunch`
  - `DownloadSessionTests.testRelaunchMarksOrphanedTasksAsInterruptedInsteadOfDone`
  - `DownloadSessionTests.testFinishedDownloadIsReplayedToThePageOnlyOnce`
  - `DownloadSessionTests.testRunningDownloadKeepsReportingProgress`
  - `DownloadSessionTests.testCompletionDoesNotDependOnNotificationPermission`
- **修复版本**：0.1.12
- **验证边界**（交 phone-test 真机）：模拟器证明了「真后台会话从受控源把文件传完、delegate 由系统触发、
  内容 hash 对得上、完成记录与重连一致」；仍未证明的是锁屏/切后台时系统给多少时间、本地通知在真实通知
  中心的样子、用户强杀 App 后的表现 —— 这些继续列真机项，不能用模拟器结果代替。

## 模拟器验收记录

`InjectedUITests` 在 GitHub Actions 的 `macos-15` + iOS 模拟器上跑（`ios-unsigned.yml` 的
“Run WKWebView playback regression on simulator” 步骤），不联网、不签名、不需要站点密码。

| 运行 | 代码 | 结果 |
| --- | --- | --- |
| [44215579006](https://github.com/kenzhao11/kanju-clone/actions/runs/44215579006) | 0.1.9 的 `AppBootstrap.js`（临时对照分支，已删） | **7 条全红**，失败信息就是本次的三个 bug |
| [44214561047](https://github.com/kenzhao11/kanju-clone/actions/runs/44214561047) | 本分支（0.1.10） | 7 条全绿 + Node 接口测试全绿 + Release 包编译通过 |
| [44222400396](https://github.com/kenzhao11/kanju-clone/actions/runs/44222400396) | 0.1.10 的 `AppBootstrap.js`（对照分支，已删） | 头栏那条**红**：`replayed=true/none/none/block`（片名小签收起了，顶上头栏还是 block）；工具条下载按钮那条也红（按钮不存在） |
| [44221519568](https://github.com/kenzhao11/kanju-clone/actions/runs/44221519568) | 本分支（0.1.11） | 模拟器 26 条全绿 + Node 76 项全绿 + Release 包编译通过 |
| [44233858043](https://github.com/kenzhao11/kanju-clone/actions/runs/44233858043) | **只含新测试**的 0.1.12 分支（修复前） | 模拟器 32 条里 **16 条红**：`main=[0,60,844,330]`、`barHidden=false`、`missing-library`、后台任务没有落盘、AppDelegate 不接后台会话 |
| [44236687669](https://github.com/kenzhao11/kanju-clone/actions/runs/44236687669) | 本分支（0.1.12 / build 13） | 模拟器 **37 条全绿** + Node **81 项全绿** + Release 包编译通过；`ZhuijuAI-unsigned.ipa` sha256 `0704361af0cb12020d132de893de666fe861569cefd8d55059ccc6df2bd96604` |
| [44238897789](https://github.com/kenzhao11/kanju-clone/actions/runs/44238897789) | 加上真后台传输集成测试（未签名宿主） | **红**：后台会话 XPC 4097，传输根本没开始（前台预检通过，说明不是本地网络） |
| [44241110324](https://github.com/kenzhao11/kanju-clone/actions/runs/44241110324) | 本分支第 1 轮整改（ad-hoc 签名的模拟器宿主） | 模拟器 **39 条全绿**（含两条真后台会话传输）+ Node **81 项全绿** + Release 包编译通过；IPA sha256 `caa9e64009be9fa16e238d27008e77b568789257dee320200309d35dd44171a5` |

0.1.9 那次的具体失败（可直接对照现象）：

```
# 0.1.9：连片名小签都没收起（replayed=false/inline/block）
landscape=true playing=true/none/none fullscreen=true/none/none exited=false/inline/block replayed=false/inline/block
  → 退出一次全屏后再播，标题回到 display:inline，工具条 block（REG-001）
{"label":0,"toolbar":0,"tabbar":0}
  → 标准全屏的 :fullscreen 规则一条都没有（REG-001 第二条路）
TypeError: null is not an object (evaluating 'sheet.hidden')
  → 注入层自己的设置面板压根不存在（REG-002）
{"pauseCalls":0,"menuOpen":true,"preference":null}
  → 「外放」只弹菜单、没暂停、也没记住使用方式（REG-003）
```

0.1.10 复核时新增的失败（真机上标题还在的那条）：

```
# 小签和工具条都收起了，但顶上那条头栏还在 —— 就是手机截图里看到的「百日谎言」
landscape=true playing=true/none/none/block fullscreen=true/none/none/block exited=false/inline/block/block replayed=true/none/none/block
  → `.page-head`（返回 + 片名 + 主题 + 菜单）始终 display:block（REG-001 第三条）
testToolbarDownloadButtonReplacesTheDanmakuSlot → missing-button
  → 工具条上根本没有下载按钮（REG-004）
```

## 历史条目

0.1.1~0.1.9 的问题与修复过程记录在 `IOS_FIXES_0.1.2.md` ~ `IOS_FIXES_0.1.6.md`、`IOS_REVIEW_0.1.1.md`；
本表从 0.1.10 起作为新增回归的正式清单。
