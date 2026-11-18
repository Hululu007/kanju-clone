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
  `#ppToolDownload`：`下载本集` → `下载 43%` → （0.1.11/0.1.12 曾在这里变成「用播放器打开」，
  把下载入口弄丢了 —— 见 REG-008；0.1.13 起这一格只做下载/取消）。
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

## REG-008 工具条上的「下载」被换成了「用播放器打开」

- **现象**（真机原话：「TMD 下载按钮怎么给我换成用播放器打开了！我在哪里下载呢！」）：
  下载完一集之后，播放器下方工具条里原本写着「下载本集」的那一格变成「用播放器打开」，
  点下去是把本地文件交给播放器 App，而不是下载。用户下一次想下载（下一集或重下）时，
  在详情/选集区找不到任何下载入口。
- **复现步骤**：
  1. 登录，进任意剧集播放页，点工具条的「下载本集」下一集 MP4 直链，等它完成。
  2. 回这一集的选集区，看那一格：文字变成「用播放器打开」。
  3. 换一集想再下载：点这一格只会打开播放器，没有下载。
- **引入提交**：`2a2ea5a`（0.1.11「Hide the site page header in fullscreen and put download on
  the tool row」）新增了这一格，`syncToolDownload()` 里 `else if (downloadState.path)` 把文案改成
  「用播放器打开」，点击分支 `if (downloadState.path) openLocal(); else startDownload();` 跟着改道。
  0.1.11 当时把「下完直接给播放器」当成了便利，实际是把下载入口弄丢了。
- **根因**（`ios/ZhuijuAI/AppBootstrap.js`）：同一格承担了两个互斥语义 —— 没有文件时是下载，
  有文件时是「打开」。`downloadState.path` 是「最近一次下载完成」，不是「当前这一集已下载」，
  于是下完一集之后，后面每一集这一格都变成播放器入口。站点详情页历史上**没有**其它下载控件
  （`git log -S"data-download" -- src player` 无结果，批量/全集下载从未实现过），所以这一格就是
  唯一的下载入口，丢了就真的没地方下载。
- **修复**：这一格只做下载（`下载本集` → `下载 N%`，下载中再点=取消），不再随 `downloadState.path`
  变成播放器入口；「用其他播放器播放」保留在「外放」菜单（`#ppOpenLocal`）和设置面板
  （`#iosOpenDownloaded`），不占用下载那一格。
- **测试名**（模拟器，真 WKWebView + 原生桥接）：
  `InjectedUITests.testToolbarDownloadStaysADownloadEntryAfterAFinishedDownload`
  （先用原生回传的 done 造出「已下完」状态，断言文案仍是「下载本集」、位置还在弹幕那一格、
  点击发出 `download` 消息而不是 `openLocal`/`share`、下载中/完成后按钮仍是下载、
  设置-下载列表出现剧名/集号/进度且播放器入口仍单独存在）
- **测试名**（Node 夹具）：`the toolbar download button never turns into the player entry`
- **修复版本**：0.1.13（build 14）
- **验证边界**：真机仍需肉眼确认这一格的位置与点击手感；下载本身的后台行为见 REG-007。

## REG-009 下载文件、列表、通知、锁屏都写着「追剧AI 第X集」

- **现象**：下载下来的文件叫 `追剧AI_第19集.mp4`，设置里的下载列表、完成通知、
  锁屏「现在播放」也都只有 App 名和集号，看不出是哪部剧；换一部剧下载还是一样。
- **复现步骤**：
  1. 登录，进任意剧集播放页，点「下载本集」，等它完成。
  2. 看设置-下载列表里的条目名，或到「文件」App 里看文件名：`追剧AI_第19集.mp4`。
  3. 锁屏看「现在播放」：标题不是剧名。
- **引入提交**：`2a2ea5a`（0.1.11）的 `downloadName()` 一开始就是
  `return '追剧AI' + (label ? '_' + label : '') + ext;` —— 拿 App 名当剧名；
  `MediaDownloader.fileName(from:fallback:)` 还会被直链最后一段（`19.mp4`）顶掉，
  把剧名又丢一次。0.1.13 及以前没有任何媒体会话元数据，锁屏信息来自 WebKit 的兜底。
- **根因**（`ios/ZhuijuAI/AppBootstrap.js` `downloadName()` / `ios/ZhuijuAI/MediaDownloader.swift`
  `fileName(from:fallback:)`）：文件名从来没有读 `showMeta().title`；原生层又会用链接里的
  文件名覆盖调用方给的剧名。
- **修复**：
  - JS 新增 `showTitle()`（取 `.detail-info h1` / `document.title` / `.ph-title`，拒绝 App 名）
    与 `safeName()`（只替换文件系统不接受的字符，保留中文和空格），文件名改成
    `真实剧名 第X集.mp4`；单集没有集号时用「正片」。
  - 原生 `fileName(from:fallback:)` 改为调用方给的名字优先，只有没给名字时才用链接最后一段。
  - 新增 `syncNowPlaying()`：播放开始和下载开始时写 `navigator.mediaSession.metadata`
    （`title` = 真实剧名，`artist` = 第X集，`artwork` = 海报）——iOS 锁屏读的是这份真实媒体会话
    元数据，不是 DOM 标题。
  - 旧记录补名：`readLibrary()` 里把仍是 `追剧AI…` 的名字按 `剧名 + 集号` 改写；只动显示名，
    不动 `path`、不移动/覆盖任何已有文件，重复执行结果一致（幂等）。
- **测试名**（模拟器，真 WKWebView + 原生桥接）：
  `InjectedUITests.testDownloadedFileAndNowPlayingUseTheShowTitle`（断言桥接消息里
  `name == 测试剧 第19集.mp4`，以及 `navigator.mediaSession.metadata.title/artist` 是真实剧名/集号）
- **测试名**（原生单元）：`DownloadTests.testFileNamePrefersTheCallersNameOverTheUrlSegment`
- **测试名**（Node 夹具）：`the download file is named after the show, not the app`
- **修复版本**：0.1.14（build 15）
- **验证边界**：真机锁屏/通知中心的呈现仍需肉眼确认（`navigator.mediaSession` 在模拟器里可读，
  但系统锁屏 UI 不进模拟器截图）；本次不声称已在真机上看过锁屏。

## REG-010 选集页没有批量下载，下载仍是一次一集

- **现象**：详情/选集页只有单集入口（工具条上的「下载本集」），想下一整部剧只能一集一集点；
  没有多选、没有「一键全集」、没有「从本集往后」；也没有任何地方能看到「整部剧下到第几集了」，
  更没法对整部剧暂停/继续/取消。原生层同时只跑一条任务，第二条会顶掉第一条。
- **复现步骤**：
  1. 登录，进任意剧集的详情/选集页。
  2. 看选集区上方：没有任何批量下载入口。
  3. 点工具条「下载本集」，再换一集点一次：第一集被取消（`MediaDownloader.begin` 里先 `stop`）。
  4. 回首页 → 设置：只有一条「下载进度」，看不到「这部剧下了几集、还剩几集」。
- **根因**：
  1. `MediaDownloader` 是单槽（`activeId` / `activeTask`），`start` 第一件事就是 `stop(silent: true)`；
     没有队列、没有并发上限、没有按剧聚合，也没有暂停（`cancel(byProducingResumeData:)` 从未用过）。
  2. 网页侧 `startDownload()` 只处理「当前这一集」：用 `mediaUrl()` 拿正在播放的地址，
     没有逐集解析（`/api/play?show=&ep=&line=`），也没有选集页的批量入口与队列进度面板。
- **修复**：
  - 原生：`MediaDownloader` 改成持久队列。`queued/running/paused/done/failed/cancelled` 六态落
    `kj-ios-download-tasks`；并发上限 `maxConcurrent = 2`（`planStarts`）；按 `showId + epKey` 去重
    （`duplicateIndex`，只挡排队/下载/暂停，完成或失败过的集还能重下）；暂停用
    `cancel(byProducingResumeData:)` 拿真实 resumeData 落盘、继续时 `downloadTask(withResumeData:)`；
    取消只停任务、只改状态，**不删除已下载文件**；`reconcile` 把不在系统里的 running 标「系统中断」并把
    排队任务重新调度；`summary` 让「有一集失败」永远不等于「整部剧完成」；总字节未知时 `knownBytes=false`。
  - 原生：`rejection(of:)` 如实拒绝 HLS（`.m3u8`）、`.html` 播放页、明文 http、图片等非视频扩展名，
    并留一条 `failed` 记录说明原因（不静默丢弃）。
  - 原生：新增桥接 `downloadBatch` / `downloadPause` / `downloadResume` / `downloadCancel`，
    以及 `window.__zhuijuDownloads('snapshot', tasks)` 队列快照（重启后网页也能对齐状态）。
  - 网页：选集区上方新增批量条 `#iosBatchBar`（`iosBatchSelect` 选择 / `iosBatchAll` 一键全集 /
    `iosBatchForward` 从本集往后 / `iosBatchStart` 下载已选）；每一集先用
    `/api/play?show=&ep=&line=` 解析真实片源并核对 `showId/idx/verified`，HLS、播放页 URL、
    不匹配的集跳过并给出原因（不把播放网页当视频）。
  - 网页：设置面板的下载列表按剧显示「任务 N/M 集 · 进行中 · 排队 · 已暂停 · 失败 · 总进度」，
    并带「暂停整部剧 / 继续下载 / 取消整部剧」；总字节未知时只写「已收 X MB」，不编百分比。
  - 原位「下载本集」（工具条那一格）保持不变，和批量走同一条队列（REG-008 不回退）。
- **测试名**（模拟器 XCTest，队列纯逻辑 + 落盘状态机）：
  - `DownloadQueueTests.testTheQueueNeverRunsMoreThanTwoDownloadsAtOnce`
  - `DownloadQueueTests.testTheSameShowEpisodeIsNeverQueuedTwiceWhileItIsStillActive`
  - `DownloadQueueTests.testAFinishedOrFailedEpisodeCanBeDownloadedAgain`
  - `DownloadQueueTests.testOneFailedEpisodeNeverLetsTheWholeShowLookComplete`
  - `DownloadQueueTests.testAnUnknownLengthNeverProducesAFabricatedPercentage`
  - `DownloadQueueTests.testHlsPagesAndPlainHttpAreRejectedWithARealReason`
  - `DownloadQueueTests.testPauseMarksQueuedEpisodesPausedAndResumePutsThemBackInTheQueue`
  - `DownloadQueueTests.testCancelStopsTheTasksButKeepsFilesThatAreAlreadyDownloaded`
  - `DownloadQueueTests.testQueuedEpisodesAreScheduledAgainAfterARelaunch`
  - `DownloadQueueTests.testANewQueueRecordCarriesTheShowAndEpisodeForDeduplication`
- **测试名**（模拟器，真 WKWebView）：`InjectedUITests.testEpisodePageHasBatchDownloadEntryAndSelectionMode`
- **测试名**（Node 夹具）：
  - `one tap batch download resolves every episode to its real media url before queueing`
  - `an HLS or page-url episode is skipped with a reason instead of being downloaded`
  - `download from the current episode onward starts at the selected episode`
  - `the selection mode picks episodes for a chosen batch without leaving the page`
  - `the settings sheet shows the whole show queue with pause, resume and cancel`
  - `a failed episode never lets the show look complete and an unknown length has no percent`
- **修复版本**：0.1.14（build 15）
- **验证边界**：暂停的续传效果取决于片源服务器是否支持 Range；拿不到 resumeData 时继续会从 0 重下
  （如实重置进度，不谎报）。真机锁屏/强杀后的队列恢复仍需肉眼验收。

## REG-011 全屏只有一种画面比例，没有适应/裁剪/拉伸

- **现象**：全屏只能看到固定的一种画面比例；4:3 或超宽片源在「适应」下留着大片黑边，
  想看满屏也没有任何入口；换集、旋转、杀掉 App 重进之后同样没有记忆。
- **复现步骤**：
  1. 进任意剧集播放页，点播放，点「全屏」进横屏。
  2. 找遍控制栏：只有 播放 / 进度 / 外放 / 倍速 / 全屏，没有画面比例。
  3. 想铺满屏幕只能忍着黑边。
- **根因**（`ios/ZhuijuAI/AppBootstrap.js`）：注入层只写死了一条
  `html[data-ios-immersive] #player video{object-fit:contain!important}`，没有档位、没有控件、没有持久化。
- **修复**：
  - 控制栏新增 `#ppFit`，放在「倍速」与「全屏」之间（全屏仍是控制栏最右端那一个，老位置不变），
    点一下按 适应 → 裁剪 → 拉伸 循环，按钮文字与 `aria-label` 跟着走。
  - 选择落 `localStorage['kj-ios-fit']`，由 `html[data-ios-fit=contain|cover|fill]` 三条样式
    （写在沉浸态那条之后，同优先级下后写者胜）落到真正的 `#player video` 计算样式上。
  - `applyFit()` 在挂载、`applyImmersive()`（进/退全屏、旋转）与每次 `play` 时重新应用，
    所以换集、旋转、重进 App 都保持记住的那一档。
  - 不动控制栏自动收起、点一下画面调出/收起、安全区与全屏遮罩（REG-001/REG-005 的断言仍在）。
- **测试名**（模拟器，真 WKWebView）：
  - `FitModeTests.testTheFitButtonCyclesContainCoverAndFillAndRemembersTheChoice`
  - `FitModeTests.testARememberedFitAppliesToANewEpisodeAndSurvivesANewPage`
  - `FitModeTests.testRemovingTheFitAttributeFallsBackToTheSiteDefault`（反向对照：拿掉 `data-ios-fit`
    必须退回站点默认的 contain，证明前两条断言真由这条样式驱动）
- **测试名**（出包关卡，真 App + 真点击 + 截图）：
  - `DisplaySmokeUITests.testTheAppPlaysDownloadsAndShootsEveryFitMode`
  - `DisplaySmokeUITests.testTheChosenFitModeSurvivesARelaunch`
  - 截图：`03-fullscreen-adapt` / `04-fullscreen-cover` / `05-fullscreen-fill` / `08-fit-remembered-after-relaunch`
- **修复版本**：0.1.14（build 15）
- **验证边界**：模拟器能证明 `object-fit` 真落到 video 的计算样式、真 App 里三档各截一张；
  4:3 / 2.35:1 / 竖屏片源在真机上的观感与刘海安全区不被裁仍需肉眼验收。

## REG-012 暂停后立刻继续，旧任务的续传数据会写进新任务

- **现象**：下载中先暂停、马上点继续，队列看起来在跑，但下一次续传会拿错数据：
  要么进度跳回旧任务的位置，要么直接失败；暂停后改成取消时，晚到的回调还会把记录改回
  「暂停」并留下续传数据。
- **复现步骤**：
  1. 选一集开始下载（要真的跑起来、有已收字节）。
  2. 点「暂停整部剧」，立刻点「继续下载」（中间不留间隔）。
  3. 看设置里的下载列表：这条记录的 `resumeData` 属于已经被取消的旧任务，
     `taskIdentifier` 已经是新任务。
- **根因**（`ios/ZhuijuAI/MediaDownloader.swift`）：旧实现是
  `task.cancel(byProducingResumeData:)` 的回调里直接
  `update(id) { $0.resumeData = data.base64EncodedString() }`——
  既不核对当前是否还是「暂停」状态，也不核对回调属于哪一条任务。用户连点时新任务
  已经建好，旧回调后到，于是把旧任务的续传数据写进了新记录。
- **修复**：
  - 每条记录带 `generation`，每次真正 `downloadTask.resume()` 时 +1。
  - 暂停时捕获当前 `generation`，回调统一切回主队列，交给 `storeResumeData`：
    必须同时满足「状态还是 paused」且「generation 没变」才落盘，否则整条丢弃。
  - 系统没给 resumeData（片源不支持 Range / 数据为空）时保持 paused、`resumeData` 为空，
    继续时从 0 重下，进度如实归零，不伪造续传。
- **测试名**（模拟器，真实后台 task + 进程外受控慢速源）：
  - `DownloadQueueTests.testPauseThenImmediateResumeNeverWritesTheOldTasksResumeDataIntoTheNewTask`
  - `DownloadQueueTests.testPauseAndResumeWithoutResumeDataStillRestartsFromZeroAndNeverStalls`
  - `DownloadQueueTests.testRepeatedPauseAndResumeKeepsOneRecordPerEpisodeAndNeverExceedsTheLimit`
  - `DownloadQueueTests.testCancelWhileThePauseCallbackIsStillPendingStaysCancelled`
- **测试环境（0.1.14 第 2 轮修的）**：受控片源原来在测试宿主进程里用 `NWListener` 起，
  iOS 14+ 的本地网络隐私会拦掉外部对 App 自身监听 socket 的入站连接——日志里就是
  `nw_listener_socket_inbox_create_socket setsockopt SO_NECP_LISTENUUID failed` 加 20 秒
  `received=0`，服务端连 GET 都没收到。现在改由 CI 在进程外启动
  `ios/Tests/Fixtures/controlled_source.py`（支持 Range，先发 64KB 再每 0.5 秒吐 8KB；
  `/norange-*.mp4` 不提供 Range），传输照旧由系统的 `nsurlsessiond` 后台会话执行。
  迟到回调的顺序由 `#if DEBUG` 的 `MediaDownloader.testResumeDataCallbackDelay` 控制，
  Release 不编译这段，产品规则没放宽。
- **验证记录**（0.1.14 第 2 轮）：
  - 红（旧 `storeResumeData`，测试不变）：[run44287326899](https://github.com/kenzhao11/kanju-clone/actions/runs/44287326899)
    —— `testALateResumeDataPayloadFromAnOlderTaskIsAlwaysDiscarded` 两条断言红：
    generation 3 的 resumeData 被写进 generation 4 的记录、取消后的记录还留着 resumeData。
  - 绿（本修复）：[run44290938803](https://github.com/kenzhao11/kanju-clone/actions/runs/44290938803)
    —— XCTest 62 条全绿、Node 89 项全绿；同一轮 UI 出包关卡另有两条待修（见下）。
  - 受控源在 CI 里由 `ios/Tests/Fixtures/controlled_source.py` 提供，日志里有
    `controlled-source health 200`，四条竞态测试都跑在真实后台传输上。
- **修复版本**：0.1.14（build 15）
- **验证边界**：模拟器能证明状态机在真实传输上的行为；但模拟器里的后台会话**不保证**
  第二次取消时给出 resumeData（实测 `testLastResumeDataBytes = -1`），所以「有数据的旧任务
  晚到」这条路径由确定性状态机测试钉住，真实传输那条只断言「没被污染」。真机上长时间暂停、
  系统杀掉 App 后再续传仍要肉眼验收。

## REG-013 批量全部完成时片库仍是「已下载 0/N 集」

- **现象**：模拟器 09 显示队列 5/5、总进度 100%，但设置里的片库写着「已下载 0/5 集」，
  下载进度行还是「尚未下载」；5 集明明都落盘了，列表里一部剧都找不到。
- **复现步骤**：
  1. 登录，进有 5 集的详情页，点「一键全集」。
  2. 等 5 条任务全部 `done`（原生记录里 5 条都有真实 path）。
  3. 打开首页设置 → 下载列表：仍是空的。
- **根因**：
  1. `window.__zhuijuDownload` 开头就 `if (!downloadState.id || payload.id !== downloadState.id) return;`
     批量任务的 id 和「当前单集」的 `downloadState.id` 不是一个，5 条 `done` 全在入口被丢掉；
  2. 即使收到，`recordDownloaded(payload, pendingMeta)` 用的 `pendingMeta` 只在单集
     `startDownload()` 里赋值，批量路径没有设置它 → `title` 为空直接 `return`；
  3. 原生 `done` 事件只带 path/name/size/showId/epKey/ep，不带剧名/总集数/封面，
     换页或重启后网页侧无从把完成项并回同一部剧。
- **修复**：
  - 原生：两条下发路径（`eventsForPage` 与 `emitStateEvents`）的 `done` 事件补上
    `title / epLabel / cover / showTotal`（总集数用独立字段，不占用字节 `total`）。
  - 网页：所有 `done`（包括 id 与当前单集不匹配的批量任务）只要带真实 `path`，就经
    `metaFromDone()` 从事件字段 → 「一键全集」记住的剧信息 → 队列快照补齐元数据，
    再调用同一个 `recordDownloaded()` 写片库；没有 path 一律不记，绝不伪造完成文件。
  - 若这条 `done` 正好是**当前这一集**（按 `epKey` / 集标签比对），同时把单集进度行
    改成本集真实落盘结果，不再出现「队列 5/5、片库 5/5、脚下写着尚未下载」。
  - `recordDownloaded()` 按 `showId + epKey` 去重；同集同 path 同 size 的重复回传直接跳过，
    换页/重启/重复 backfill 都幂等，不会重复通知或重复写盘。
  - 片库列表合成时「标题相同也算同一部」并收下队列里的真 `showId`：过去只按 id 比，
    同一部剧会成两条、`queueSummary(show.id)` 找不到任务（run 44324188770 的
    `DownloadQueueUITests` 因此看不到任务数与暂停/取消）。
  - 单集老路径（无 showId/epKey 的 done）仍走 `pendingMeta`，REG-009 不回退。
- **测试名**（模拟器，真 WKWebView + 原生真实 done 事件）：
  `LibraryDoneTests.testAllFiveFinishedBatchEpisodesAppearInTheDownloadLibrary`
  （真点一键全集 → 写 5 条真实落盘记录 → 用 `MediaDownloader.eventsForPage()` 生成的 done 事件
  交给网页 → 断言设置面板「已下载 5/5 集」、剧名与 5 个集号齐全；再把同一批 done 重送一遍，
  断言仍是 5/5、不多出集）
- **沙盒夹具**：`downloadQueue.test.mjs` 的
  `every finished batch episode lands in the settings library, and replay stays idempotent`
  （同一批 done → 片库 3/3 + 逐集可见 + 重送幂等；不修真就红）与
  `a show already in the library by title keeps its queue progress when the real showId arrives`
  （片库里已有同名剧、队列带真 showId 时不能变成两条，任务数与暂停/取消不能丢）
- **真实模拟器出包关卡**：`BatchDownloadSmokeUITests`（第 09 张图）现在要求真队列跑到
  「全部完成」、片库「已下载 5/5 集」、第19~23集逐集可见、单集进度行不再是「尚未下载」。
  旧断言只要求「片库 >= 2 条集记录」，队列 5/5 而片库 0/5 也能过（run 44300418982 的图 09 就是现场）。
- **红/绿证据**（都在 `fix/ios-0.1.14-final` 上，没改 main）：

| 运行 | 代码 | 结果 |
| --- | --- | --- |
| [44310127444](https://github.com/kenzhao11/kanju-clone/actions/runs/44310127444) | 只加了 `LibraryDoneTests`（修复前） | **红**：`已下载 1/1 集` ≠ `已下载 5/5 集`，5 个批量集号一个都没进片库 |
| 44300418982 的图 09（`dbb3581`） | 修复前的出包关卡 | 现场就是队列 `任务 5/5 集 · 总进度 100% · 全部完成` + 片库 `已下载 0/5 集` + `下载进度：尚未下载` |
| [44310316242](https://github.com/kenzhao11/kanju-clone/actions/runs/44310316242) / [44318702236](https://github.com/kenzhao11/kanju-clone/actions/runs/44318702236) | 修复提交 | **红，但不是代码**：`The job was not acquired by Runner of type hosted`（macOS 队列容量），改 workflow_dispatch 重跑 |
| [44324188770](https://github.com/kenzhao11/kanju-clone/actions/runs/44324188770) | 修复 + 加严的出包关卡 | 出包关卡与 9 张图**全过**（图 09 已显示 5/5），但两条 XCTest 红：`DownloadQueueUITests` 看不到任务数（同剧两 id），`LibraryDoneTests` 算出 6/5（别的用例遗留的 第19集）|
| [44330227019](https://github.com/kenzhao11/kanju-clone/actions/runs/44330227019) | `2f75521` | **全绿**：模拟器 **63 条** + Node **91 项** + UI 冒烟 **3 条** + Release 包编译通过；9 张图导出 `export-exit=0`；IPA sha256 `ca804e77f231092fb832eacc1e8869f3a0e65aa6dbc4c08fd050c7d4b9d32a87` |
| [44334040691](https://github.com/kenzhao11/kanju-clone/actions/runs/44334040691) | `88dc610`（含批量入口先滚动再点） | **全绿**，同一组数字；图 09 仍为 `已下载 5/5 集` + 第19~23集逐集可见 |
| [44337773903](https://github.com/kenzhao11/kanju-clone/actions/runs/44337773903) | **最终 `38ee701`** | **全绿**：模拟器 **63 条** + Node **91 项** + UI 冒烟 **3 条** + Release 包编译通过；9 张图导出 `export-exit=0`；图 09/06 都显示 `测试剧 · 已下载 5/5 集 · 第19~第23集 · 任务 5/5 集 · 总进度 100% · 全部完成`；IPA sha256 `2ec0cf74116b7d559e664d1c5e63fbf4ca7717ea907cfe4a689f55491071955a` |
- **修复版本**：0.1.14（build 15）
- **验证边界**：断言的是网页片库与原生完成事件的绑定；真实片源下载与后台传输由
  `BackgroundTransferIntegrationTests` 覆盖，真机锁屏/通知仍属真机项。

## REG-014 选集旁的「投屏」占了下载的位置，下载只能绕到工具条上

- **现象**：播放页视频下方、选集标题旁边是一个「投屏」入口。App 里没有投屏能力，
  点它只会弹出一个不属于这里的菜单；用户想下一整部剧时，这个最顺手的位置上没有下载，
  只能去工具条找那一格「下载本集」，或者先展开选集再慢慢挑。
- **复现步骤**：
  1. 进任意剧集播放页，看视频下方、选集标题右侧。
  2. 那里写着「投屏」；点它没有任何可用的下载动作。
- **根因**：这一格是站点模板渲染的投屏入口，注入层从没接管过它；
  0.1.14 的批量下载挂在选集区上方的一条批量条上，和「选集」这个位置是分开的。
- **修复**：
  - 注入层新增 `castEntryNode()` / `mountDlEntry()`：把站点那个投屏入口隐藏
    （`data-ios-hidden="cast"`，不删节点）、在**同一位置**换成 `#iosDlButton`「下载」。
  - 点它**不跳页、不弹层**：`#iosDlPanel` 是按钮下面普通文档流里的一块，
    就地展开可下载的集数列表（`选集下载 · 共 N 集`），把下方内容推开而不是盖住画面。
  - 每一条是 `#iosDlRow<集号>`，带状态文字：`已下载`（片库里有这一集）/ `下载中 N%`
    （队列里这一集在跑，总长度未知时只写「下载中」，不编百分比）/ `排队中` / `已暂停` /
    `失败` / `已取消` / `未下载`。状态优先看共享队列，其次看片库。
  - 单选 = 点条目；`全选` / `清空` / `下载已选 (k)` 与选集网格上的选中状态是**同一份**，
    入队走 `startBatch()`，也就是 0.1.14 那条原生持久队列（并发上限 2、按 showId+集号去重、
    暂停/继续/取消都在原生层）。网页侧没有第二条下载通道。
  - 0.1.14 的批量条 `#iosBatchBar` 原样保留（REG-010 的入口不回退），两处共享选中与队列。
- **测试名**（模拟器，真 App + 真点击 + 截图）：
  - `EpisodeDownloadSheetUITests.testTheCastEntryNextToTheEpisodesIsADownloadButtonThatExpandsInPlace`
    （投屏入口消失、下载按钮在原位、展开前没有列表、点开后同一页面里出现「共 5 集」与每集状态、
    原播放页元素仍在即没有跳页）
  - `EpisodeDownloadSheetUITests.testSelectingEpisodesQueuesThemAndShowsDownloadedAndDownloadingStates`
    （单选 1 集 → 全选 5 集 → 下载已选 → 队列真的出现下载中/排队 → 有集变成已下载）
  - 截图：`010-download-entry`、`011-download-panel`、`012-download-panel-all-selected`、
    `013-download-queue-states`、`014-download-final-states`
- **修复版本**：0.1.15（build 16）
- **验证边界**：模拟器能证明入口替换、就地展开、选中状态与真实入队；真机上仍需确认
  站点实际投屏按钮的命中（不同模板可能用不同的文案/类名，`castEntryNode()` 按文字、
  无障碍名和 cast/dlna/airplay 类名三路识别，认不出时会退回挂在选集网格上方，不会瞎挡功能）。

## REG-015 全屏画面填充点了没变化（拉伸/平铺无效）

- **现象**：全屏下点「拉伸」「平铺」，画面没有任何变化；三档控件还一直挂在控制栏上，
  竖屏页内也能看到，恢复了播放也不收起。
- **复现步骤**：进播放页 → 全屏 → 点「拉伸」/「平铺」→ 画面比例不变（始终是等比留黑边）。
- **根因**（0.1.15，`ios/ZhuijuAI/AppBootstrap.js`）：档位只写了 CSS
  `html[data-ios-fit=...] #player video{object-fit:...!important}`。三个问题叠在一起：
  1. 注入层自己的沉浸态规则 `html[data-ios-immersive] #player video{...object-fit:contain!important}`
     与这三条**同优先级**，站点重渲染播放器或回写内联样式时谁后写谁赢，档位会被顶回 contain；
  2. `object-fit` 只在「元素盒子」与视频宽高比不一致时才产生效果，站点给的是 100%×100% 的盒子，
     一旦容器和视频比例接近，它本来就看不出变化；
  3. 这个 App **没有自己的 AVPlayerLayer**（视频由 WKWebView 的 `<video>` 播，全仓无 AVPlayer/AVPlayerLayer），
     所以「改 videoGravity」在这里唯一可靠的等价物是**改元素自身的几何**，改 CSS 属性不够。
- **修复**：
  - 三档改成按 `video.videoWidth/videoHeight` 与容器尺寸算**像素几何**：默认=等比装进屏幕、
    拉伸=盒子铺满（非等比）、平铺=等比放大到盖满并被容器裁边；直接写 `width/height` 到 `<video>`，
    渲染层必须照做，没有第二条样式能覆盖它（`applyFitGeometry()`）。
  - 容器尺寸变化（旋转、进出全屏）与换集/首帧后重算（`refitSoon()`、`loadedmetadata`/`play` 钩子）。
  - 控件按规格挪到**屏幕顶部**，只在「全屏 + 暂停」出现（`#iosFitBar`，当前项高亮），
    恢复播放随控制栏一起收起；控制栏里原来那一格删掉，竖屏/设置面板都不再出现。
  - 选择落 `localStorage['kj-ios-fit']`（contain/fill/cover = 默认/拉伸/平铺），重进保持。
- **测试名**：本次按 HARK-SMALL-UI-EXEMPT（Ken 2026-11-19 03:08）不新增 XCUITest、不跑模拟器；
  代码层确认见下。
- **代码层确认**：`applyFitGeometry()` 是唯一写入画面几何的地方，写入对象是
  `document.getElementById('video')`（当下可见的那个 `<video>`），三档分别算出不同的
  `style.width/height` 像素值；`syncFitBar()` 只决定控件显隐与高亮，不参与渲染。
  **未在真机验证**，需手机自测。
- **修复版本**：0.1.16（build 17）
- **验证边界**：本次只做到编译通过 + 本地 Node 夹具；像素几何在真机上的观感（尤其刘海与安全区）
  必须真机确认。

## REG-016 下载要绕两步，且已下载的集没法单独删掉

- **现象**：①选集旁的下载入口点开后是一排「全选 / 一键全集 / 从本集往后 / 下载已选」，
  想下某一集要先选再确认；设置面板里还有整部剧的队列进度与暂停/继续/取消。
  ②已下载列表只能看，删不掉；想清掉某一集只能去「文件」App 里翻。
- **复现步骤**：播放页 → 下载 → 选出「下载已选」→ 两步才入队；设置 → 已下载 → 没有任何删除入口。
- **根因**：0.1.14 的批量下载把「多选 + 二次确认」当成了唯一入口；片库只写不删，
  网页侧没有删文件的原生通道（`MediaDownloader` 只下载不删）。
- **修复**（照 ios/UX_SPEC.md §2 §3）：
  - 集数网格替代批量条：一行 5 格，每格标状态（可下载 / 下载中 N% / 已下载）；
    **点一格立刻入队**并提示「已加入下载」，可以连续点多集，走同一条共享队列（并发/去重不变）。
  - 删掉 `#iosBatchBar`（选择 / 一键全集 / 从本集往后 / 下载已选）与面板里的 `全选/清空/下载已选`；
    设置面板里的整部剧队列块（暂停整部剧 / 继续 / 取消整部剧）一并删除。
  - 已下载列表改「一行一集」，支持左滑露出红色「删除」；删除时先删片库记录，再让原生
    `deleteLocal` 删掉**这一行对应的那个文件**（路径必须落在 App 的 Documents 里，越界拒绝）。
    没有一键全部删除，也没有多选。
- **测试名**（Node 夹具，随本次改动更新）：
  `tapping one cell in the episode grid queues exactly that episode`、
  `the grid shows each episode state and never offers a batch action`、
  `a downloaded row can be deleted on its own, and only that file is asked to be removed`；
  同时删除已不存在的批量条用例（一键全集 / 选择模式 / 从本集往后 / 整部剧暂停继续取消）。
- **修复版本**：0.1.16（build 17）
- **验证边界**：左滑手势走 touch 事件，模拟器/真机手感与删除后文件是否真的消失需真机确认。

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
| [44247573395](https://github.com/kenzhao11/kanju-clone/actions/runs/44247573395) | 0.1.13 只含新回调测试（修复前） | **红**：`text=用播放器打开`、点击发出 `openLocal` 而不是 `download`（REG-008） |
| [44248933173](https://github.com/kenzhao11/kanju-clone/actions/runs/44248933173) | 本分支（0.1.13 / build 14） | 模拟器 **40 条全绿** + Node **82 项全绿** + Release 包编译通过；IPA sha256 `abca8058b32931e7e0ad18fa213a45dc49a9ecf619fca3671e3586e2130d66a6` |

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
