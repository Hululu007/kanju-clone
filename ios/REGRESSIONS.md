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

## REG-017 全屏画面模式改成顶部下拉后仍然要真的改画面（拉伸/平铺复检）

- **现象**：0.1.16 已把三档改成像素几何，但控件是一排居中按钮；0.1.17 按新规格把它挪到
  全屏顶部「剧名旁」的下拉里。挪位置本身不会修 bug，所以这条记的是**复检**：
  换了控件之后，三档必须仍然落到当下可见的 `<video>` 的真实像素宽高上。
- **根因（历史）**：见 REG-015 —— 只改 CSS `object-fit`；本 App 没有自己的 AVPlayerLayer，
  唯一可靠的等价实现是把几何算出来写到当前可见的 `<video>` 上。
- **本次做法**：
  - 下拉只有三个选项（默认/拉伸/平铺），按钮文字就是当前档位；选项立即调用
    `chooseFit()` → `applyFitGeometry()`。
  - `applyFitGeometry()` 仍然只写 `document.getElementById('video')` 的
    `style.width/height`（像素），默认=`min` 缩放、拉伸=容器宽高、平铺=`max` 缩放并裁边；
    旋转、进出全屏、换集首帧（`loadedmetadata`/`play`）都会 `refitSoon()` 重算。
  - 控件显隐跟着「点屏幕或暂停」：`syncFitBar()` 把顶部栏、左右侧按钮、第二排统一
    `on/off`，播放且控制栏收起时一起藏起来（规格 §4）。
- **测试名**：本次按 HARK-SMALL-UI-EXEMPT 不新增 XCUITest、不跑模拟器；
  代码层确认：三档分支产生不同像素值，写入对象是当前可见的 `<video>`。
- **修复版本**：0.1.17（build 18）
- **验证边界**：**未在真机验证**。真机上要确认：下拉展开/收起、锁屏与截图位不挡画面、
  4:3 与 2.35:1 片源在三档下的观感、横屏安全区不被裁。

## REG-018 五屏布局按规格重排（腾讯视频布局，非素材）

- **现象**：播放页/下载/我的下载/全屏控件/播放设置这五处与规格不一致：没有顶部返回+投屏/分享/更多，
  剧名旁没有追剧与下载，没有「选集 全N集 ›」与信息行；下载只能从选集面板里点；
  全屏没有锁屏/截图位与第二排（字幕/倍速/画质/选集）；没有从右侧滑出的播放设置面板。
- **修复（照 ios/UX_SPEC.md，仅布局与交互，未使用任何腾讯 logo/图标/素材）**：
  - 播放页：`#iosTopBar`（返回 ‹ / 剧名 / 投屏 / 分享 / ···）；`#iosTitleRow`（剧名 + 追剧 + 下载 ⬇）；
    `#iosInfoRow`（类型/评分/标签 · 简介 ›）；`#iosEpHead`（`选集 全N集 ›`，点开展开全部）。
  - 下载页 `#iosDlPage`：整页推入，标题「点击集数即可下载」、`下载画质 720P ›`、
    **每行 6 格**的集数网格（点一格立刻入队并变青）、底部 `查看下载列表` + 剩余空间；
    **没有下载全部**。
  - 我的下载 `#iosMinePage`：`正在下载` 行（剧名+集号+进度/已收+角标集数）、按剧分组
    （海报/剧名/已下载几集/占用）、每行左滑删除（删记录+删文件）、底部已用/剩余。
  - 全屏：`#iosFsTop`（返回 / 剧名+第几集 / 画面模式下拉 / 投屏 / 分享 / ···）、
    左右居中的锁屏与截图、`#iosFsRow2`（字幕/倍速/画质/选集/下一集）。
  - 播放设置 `#iosPlaySettings`：从右侧滑出，图标排（下载/撑满全屏/画中画/音频播放）+
    列表（定时关闭/循环播放/跳过片头片尾/分集标题）+ ✕。
  - 移除：弹幕按钮、会员/广告/VIP/预告角标（按文案匹配隐藏，不删站点节点）。
- **测试名**：按 HARK-SMALL-UI-EXEMPT 不新增 XCUITest；下载页/我的下载的旧 Node 用例同步到新契约。
- **修复版本**：0.1.17（build 18）
- **验证边界**：**未在真机验证**。以下需要手机自测：投屏/分享是否调到系统面板、
  锁屏（目前只提示，不真的禁用触摸）、截图项（提示用侧键）、画质切换（仅记录选择，
  片源由站点决定）、相关推荐横排（站点没有该数据，本次未生成，避免编造内容）。

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

## REG-019 单集下载页与设置账号状态

- **现象**：下载入口曾分散在播放器工具栏、选集内嵌区域与设置下载库，用户无法确认点一次究竟下载什么；设置里的账号入口也没有未开放状态。
- **复现步骤**：打开播放页，点剧名旁「下载」，点一集并打开「查看下载列表」；另从设置面板检查个人资料与账号安全行。
- **根因**：旧版同时保留批量下载交互和多处下载入口；新版账号资料接口尚未开放。
- **对应测试名**：`EpisodeDownloadSheetUITests.testSiteDownloadEntryOpensTheStandaloneEpisodeGrid`、`EpisodeDownloadSheetUITests.testTappingAnEpisodeDownloadsOnlyThatEpisode`、`BatchDownloadSmokeUITests.testTheEpisodePageOffersSingleDownloadAndShowsItsLibraryEntry`、`InjectedUITests.testSettingsSheetShowsTheRunningDownload`。
- **修复版本**：0.1.18（build 19）；账号两行暂显示「即将上线」。

0.1.1~0.1.9 的问题与修复过程记录在 `IOS_FIXES_0.1.2.md` ~ `IOS_FIXES_0.1.6.md`、`IOS_REVIEW_0.1.1.md`；
本表从 0.1.10 起作为新增回归的正式清单。

## REG-020 点下载没反应、进度不进格子、两套播放器叠在一起（0.1.19）

- **现象**：真机上点网站的下载按钮，什么都不发生；下载页/我的下载一条队列都看不到。
  播放页同时出现网站自己的控制栏和 App 注入的那套控件；进全屏后标题栏收起异常，转屏方向也跟系统对不上。
- **复现步骤**：
  1. 打开任意剧集播放页，点网站上的下载入口。
  2. 观察：没有任何提示，下载页的集数格子没有状态，我的下载为空。
  3. 播放任意一集，点网站控制栏的全屏，再转屏。
  4. 观察：画面上同时有一套站点控件和一套注入控件，退出全屏后标题/工具条/方向都可能回不来。
- **根因**：
  1. `WebViewController.beginDownload` 要求 `signedIn == true` 且必须有 `id`，网站发来的消息两者都没有，被静默丢弃。
  2. 注入层 `startBatch` 读 `localStorage['kj-auth-token']` 做登录门控，新站没有这个 key，即使请求走到注入层也被挡回。
  3. 下载页刷新调用已被删除的 `syncDownloadRow()` / `syncTencentUI()`，运行期抛错，格子状态不再更新；
     当集完成时也没有重渲染「我的下载」。
  4. 注入层仿了站点 `#ppCtrl` 一套控件，还用 `#playTools,.pp-toolbar,#btnFull,…{display:none!important}` 藏掉站点自己的工具条；
     全屏由注入层发 `fullscreen/inline` 让原生锁竖屏、改约束，与站点自己的 `requestFullscreen` / `data-ios-immersive` 互相打架。
- **修复**：
  - **播放器控件全删，全屏方向改由原生配合**：删除注入层自建的控件、全屏浮层、`PlayerAction.fullscreen/inline`、
    `requestRotation`、页面几何与状态栏覆盖。build 21 先试过「App 完全不锁方向」，真机点全屏仍停在竖屏；
    build 22 起改成两态策略（平时竖屏、站点全屏时横屏铺满、退出回原位），细节见 REG-021。
  - **不再画第二套播放器**：删掉注入层自建的顶部条、全屏浮层、画面档位下拉、倍速 / 外放 / 投屏菜单、复制链接按钮，
    以及全部 `data-ios-immersive` 全屏样式与几何计算。站点自己的工具条、顶栏右侧按钮、选集投屏入口一律不再隐藏。
  - **下载不再被登录态或 id 拦掉**：`beginDownload` / `beginBatchDownload` 不再要求 `signedIn`，也不因缺 id 静默返回；
    缺 id 时按「剧号 + 集号」补一个稳定 id（`dl-<剧号>-<集号>`），全空才用一次性 UUID。
  - **单集消息也带身份**：`beginDownload` 把 `showId` / `epKey` / `epLabel` / 剧名补进 meta，
    下载页格子、「我的下载」和离线播放才能按同一部剧、同一集对上。
  - **网页侧 id 稳定**：`startBatch` 原来用 `'dl' + Date.now() + '-' + key`，同一集再点一次会变成新 id、续传数据接不上；
    改成 `dl-<剧号>-<集号>`。
  - **进度 / 完成 / 回前台**三条路径都走 `syncDownloadPage()` + `renderMinePageIfOpen()`；
    队列快照 `__zhuijuDownloads('snapshot')` 负责下载页格子的进度条与「我的下载」的百分比。
  - 新增 `playLocal`：离线播放用原生播放器播本地已下载文件。
- **测试名**（Node 夹具，`ios/Tests/bootstrap.test.mjs`、`ios/Tests/downloadQueue.test.mjs`）：
  - `the site own download menu row opens the native download page`
  - `download page opens without an app login and queues the tapped episode`
  - `a single-episode download queues without any login state`
  - `download progress appears in the download page and a completed episode joins my downloads`
  - `each finished episode lands in my downloads, and replay stays idempotent`
  - `no native player overlay is injected any more`
  - `layout fallback keeps the light tabbar and category cards without touching site tools`
    （站点顶栏右侧按钮、选集投屏入口都不再被隐藏）
  - `the injected layer reports site fullscreen state without touching the page`（全屏只发一条方向消息、不写属性、不写全屏样式）
  - `a native video fullscreen also reports enter and exit exactly once`（video 原生全屏这条路也只发方向消息）
  - `tapping the same episode twice reuses the same download id`（同一集重复点下载 id 稳定）
  - `tapping one cell in the episode grid queues exactly that episode`
- **测试名**（Swift 单元，`ios/Tests/VersionTests.swift`；本机无 Xcode，未能在 Windows 上编译）：
  - `testRotationStaysFreeInEveryDirection`
  - `testDownloadIdentifierIsStableForTheSameEpisode`
  - `testDownloadIdentifierKeepsTheIDThePageSent`
  - `testDownloadIdentifierFallsBackToTheFileNameAndThenAUUID`
- **随功能退役的用例**（只退役「被删掉的注入层功能」自己的用例，不是退役用户看得见的问题）：
  - 控件本身已不存在：注入层的全屏按钮、画面档位下拉、倍速菜单、外放菜单、投屏菜单、复制链接，
    以及「注入层自造沉浸态」这条实现路径。对应
    `landscape playback becomes immersive without forcing rotation`、
    `portrait playback stays inline until the fullscreen button is used`、
    `explicit exit wins over automatic landscape immersion`、
    `landscape playback goes immersive again after a fullscreen round trip`、
    `rotating back to landscape during playback restores immersive mode`、
    `the standard fullscreen api hides the title and keeps immersion in sync`、
    `fullscreen hides every floating control and restores them on exit`、
    `entering fullscreen closes the top toolbar panels`、
    `fullscreen fit dropdown selects and remembers the requested mode`、
    `portrait playback keeps video sizing untouched and immersive fit geometry is restored`、
    `fullscreen sits at the right end of the control bar and drives native rotation`、
    `native fullscreen requests are rerouted to the in-page bar`、
    `rate menu offers 2.5x and 3x and applies the chosen one`、
    `a clamped playback rate is reported instead of pretending 3x works`、
    `control bar follows playback position and seeking`、
    `external playback hands the direct url to the native share sheet`、
    `external playback refuses blob streams and says why`、
    `external playback without the app bridge falls back to the system share sheet`、
    `cast menu lists playback actions without download or local-player entries`、
    `the cast button hands the episode to a third-party player in one tap by default`、
    `a long press on the cast button still opens the full menu`、
    `the cast menu keeps playback actions and excludes downloads`、
    `HLS lines can still be played by an external player even though they cannot be downloaded`、
    `copy link puts the direct url on the clipboard`、
    `a played episode keeps its direct url after the player element is rebuilt`、
    `an unresolved episode is not mistaken for a media url`、
    `the player page url is refused even when it fills the source tag`（页面地址这条改成
    `download refuses a resolved player page url instead of saving the page`）、
    `immersive hides the site page header that carries the film title`。
  - 模拟器侧同时退役 `InjectedUITests` 的六条（横屏沉浸、标准全屏规则、投屏一键外放、外放菜单、外放开关、全屏铺满）。
  - **仍然适用的站点全屏 / 头栏回归**：REG-001、REG-005、REG-011、REG-015、REG-017 讲的是用户看得见的要求
    （全屏时头栏与工具条不能压在画面上、画面比例不能被裁、退出全屏要能回上一页）。这些要求**不退役**，
    只是实现从「注入层隐藏 + 像素几何」换成「站点播放器自己的 Fullscreen API + 系统方向」：
    真实全屏只渲染播放器元素，站点头栏本来就不在画面里。具体按真机复核，并由 REG-021 钉住
    「平时竖屏、站点全屏时横屏铺满、退出回原位；注入层只报方向、不接管全屏」这条策略。
  - REG-003 / REG-014 里「注入层的外放菜单 / 投屏让位」随注入控件删除而退役；站点自己的投屏入口不再被隐藏，
    投屏回到站点原生行为（属于站点功能，不在 App 回归清单里）。
- **修复版本**：0.1.19（build 21 起步；方向策略在 build 22 按 REG-021 修正）
- **验证边界**：Node 夹具能证明逻辑与消息（build 22 本机 67 条全过）；Swift 未在本机编译（Windows 无 Xcode），
  真站选择器、WKWebView 里的网站全屏与旋转、原生下载进度、离线播放都必须真机复核。

## REG-021 网页播放器全屏与横竖屏（build 22 定稿为两态）

- **要求（Ken 2026-11-20 真机实测后确认）**：全屏只有两种状态，没有中间态：
  1. **窗口模式（默认）**：竖屏，视频在详情页原来的位置小窗播放，下面的选集、简介照常显示和滚动；
  2. **全屏模式**：点站点播放器自己的全屏按钮 → 横屏铺满整个屏幕。
  点站点退出按钮或返回退出后，必须回到详情页视频原来的位置继续播放，详情页内容和播放进度都不变；
  不允许「竖屏全屏」或半屏之类的中间状态。播放器只保留站点自己那一套，App 不再往里加控件。
- **复现 / 复核步骤**：
  1. 进详情页，确认视频在原来的位置小窗播放，下面选集 / 简介都在（竖屏）。
  2. 点站点播放器全屏 → 屏幕转成横屏、画面铺满，站点自己的控制栏还在。
  3. 点退出全屏 / 返回 → 回到详情页原位，进度没跳、选集没丢，可以继续播。
  4. 再点一次全屏，重复第 2、3 步仍然正常（不能只第一次生效）。
- **根因（build 21 真机现象）**：
  1. iPhone 的 `WKWebView` 默认关闭「元素全屏」（`WKPreferences.isElementFullscreenEnabled` 默认 false），
     站点播放器调 `element.requestFullscreen()` 会被直接拒绝，点全屏看起来就像没反应；
  2. build 21 把注入层的全屏接管全删了，`WebViewController` 又对所有方向一律放行，
     没有任何东西把界面切到横屏；手机竖着拿时系统自然不会转，于是停在竖屏；
  3. WebKit 自己弹出的网页全屏控制器是系统控制器，不看我们 VC 的 `supportedInterfaceOrientations`，
     只认 `AppDelegate.application(_:supportedInterfaceOrientationsFor:)` 返回的全局掩码。
- **本次保证**：
  - `WebViewController` 打开 `isElementFullscreenEnabled`（iOS 15.4+），并实现两态方向：
    `interfaceOrientations(forFullscreen: false) == .portrait`、`true == .landscape`；
    网页报告进入全屏 → `requestGeometryUpdate(.iOS(interfaceOrientations: .landscape))`（iOS 16+），
    退出 → 回 `.portrait`；iOS 15 用 `attemptRotationToDeviceOrientation()` 让系统重新评估。
  - `AppDelegate` 实现 `supportedInterfaceOrientationsFor`，和 VC 共用同一份掩码，系统全屏控制器也吃这条。
  - 注入层只在 `fullscreenchange` / `webkitfullscreenchange` / `webkitbeginfullscreen` / `webkitendfullscreen`
    时发一条 `{action:'playerFullscreen', on:true|false}`；**不写 `data-ios-immersive`、不改页面几何、
    不加 `:fullscreen` 样式、不藏站点控件、不重建页面**。退出后页面没被重建，详情页位置和进度自然保持原样。
  - build 23 起：站点对「播放器容器」的 requestFullscreen 会改道到系统原生视频全屏
    （video.webkitEnterFullscreen()），避免容器元素全屏黑屏；细节见 REG-024。
- **测试名**：
  - Node：`the injected layer reports site fullscreen state without touching the page`、
    `a native video fullscreen also reports enter and exit exactly once`、
    `no native player overlay is injected any more`、
    `layout fallback keeps the light tabbar and category cards without touching site tools`
  - Swift：`VersionTests.testFullscreenSwitchesBetweenPortraitAndLandscape`
- **修复版本**：0.1.19（build 22）
- **验证边界**：**真机**（模拟器测不准 WKWebView 里网站全屏的真行为）：旋转时序、刘海安全区、
  退出全屏后能否回到详情页原位继续播放、iOS 15 上的退路。

## REG-022 下载列表要按「剧名 + 集数」逐条显示进度（build 22）

- **现象（Ken 真机 build 21）**：下载列表只看到一条笼统的「正在下载 N 集」，看不出是哪部剧的哪一集，
  也没有逐集进度条；多集一起下时分不清谁在跑、谁在排队。
- **复现步骤**：详情页点某集下载 → 点「查看下载列表」→「我的下载」；再批量下 3 集重复看。
- **根因**：
  1. `renderMinePage()` 只渲染 `running[0]` 这一条大行，其余集只写一句「其余 N 集排队」，没有逐集的行和进度条；
  2. 进度只更新那一行的文字；批量任务的剧名 / 集号只在快照里，首包进度到达时行上常常没有剧名；
  3. 下载页和「我的下载」没有按任务逐行重建，完成一集后看起来像卡住。
- **修复**：
  - 「我的下载」的下载区改成**一集一行**：`剧名 + 第N集` + 进度条 + 百分比 + 已下载 / 总大小；
    排队中的集也列出来并写「排队中」；行 id 用任务 id，进度事件按 id 只更新自己那一行。
  - 剧名 / 集号三级兜底：原生事件带的 → 「一键全集」记住的 → 片库 / 当前页；
    进度事件每 0.25 秒到达一次，每次都会重渲染这一区（实时刷新）。
  - 完成事件带 `path` 才写入片库；点已下载的一集走 `playLocal` 用原生播放器播本地文件。
- **测试名**（Node）：`download progress appears in the download page and a completed episode joins my downloads`、
  `every downloading episode shows its show, episode and live percent in my downloads`、
  `a running download restores its state and appears in my downloads`、
  `the running download shows its show, episode and percent in the library`、
  `each finished episode lands in my downloads, and replay stays idempotent`
- **修复版本**：0.1.19（build 22）
- **验证边界**：**真机**：真实的 URLSession 进度、后台切回、多集并发、离线播放。

## REG-023 首页顶栏不要 App 的设置齿轮（build 22）

- **要求**：首页顶栏保持 0.1.17 的样子，不放 App 自己加的设置按钮；设置入口只从站点「我的」菜单进。
- **根因**：0.1.18 的注入层往首页顶栏塞过自己的控件，用户看到两个入口、样式也和站点不一致。
- **本次保证**：注入层不再创建任何顶栏按钮（`#iosTopBar` 不复活），并隐藏站点顶栏自带的
  `[data-action="settings"]` 齿轮；站点菜单里的设置入口仍然能打开 App 的设置面板。
- **测试名**：`the home top bar carries no app settings gear and settings stay in the menu`
- **修复版本**：0.1.19（build 22）

## REG-024 点全屏黑屏 / 只剩声音 / 退不出去（build 22 真机，build 23 修）

- **现象（Ken 真机 build 22）**：点站点播放器的全屏后画面全黑，声音还在；站点自己的退出按钮也找不到，
  像卡在全屏里出不来。
- **复现步骤**：详情页播放任意一集 → 点站点播放器自己的全屏 → 观察画面和退出入口。
- **根因**：站点播放入口走标准 Fullscreen API，而且是把「播放器容器」整个元素 requestFullscreen()。
  build 22 打开了 WKWebView 的 isElementFullscreenEnabled，于是 WebKit 用系统「元素全屏」控制器接管；
  iOS 上这种容器元素全屏会丢掉 video 的视频图层（只剩声音、画面全黑），站点画在容器里的退出按钮
  也跟着被盖住或失效，所以看起来退不出去。播放内核本身没问题，是「全屏用错了哪套」。
- **修复（build 23）**：注入层在页面脚本之前把 Element.prototype.requestFullscreen /
  webkitRequestFullscreen 包一层：请求的元素（或它内部的 video）有视频时，改成调
  video.webkitEnterFullscreen()，由系统原生视频播放器接管 —— 画面正常、自带 Done 和下滑退出；
  不搬动视频节点、不写全屏 CSS、不做旋转、不重布局。
  - 返回的 Promise 按 Fullscreen 契约兑现：等 webkitbeginfullscreen 才算成功；调用抛错或 1.5 秒内
    系统没回事件就拒绝，不会假装进了全屏（站点自己能提示）。
  - 同一时间只保留**一个**原生全屏请求（token 就是这次请求对象）：已经在这个视频的全屏里，
    新请求直接 resolve；已有请求在等结果时，新请求明确 reject，不按 video 堆队列，
    也不会出现一次 begin 把多个请求一起算成功。旧请求的定时器只认自己的 token，不会误伤后一次。
  - begin / end 只认「这次请求的视频」或「当前在全屏的视频」：别的 video 进退全屏一律忽略，
    不清全局状态、不报方向。
  - 有视频的元素只走原生播放器这条路，**失败也不回退**到会黑屏的容器元素全屏。
  - iOS 15.0–15.3 的 WKWebView 没有 Element 全屏 API（isElementFullscreenEnabled 从 15.4 才有），
    注入层会补出 requestFullscreen / webkitRequestFullscreen 和 document.fullscreenEnabled，
    让站点的全屏按钮照常出现并改道到原生视频全屏；document.exitFullscreen 也转成原生退出。
    video.webkitEnterFullscreen 本身不受这个开关管：WebKit 源码 HTMLVideoElement.idl 里
    webkitEnterFullscreen / webkitExitFullscreen 没有 EnabledBySetting 门控。
    **这条兼容层没有真机证据**（手上没有 15.0–15.3 的设备），只按公开 API 可用性实现，按未验证处理。
  - 退出后补发的 fullscreenchange / webkitfullscreenchange 只发给站点；补发期间注入层不再根据
    残留的 document.fullscreenElement 判断「进全屏」，避免原生方向又横过去。
  - 只注入主 frame（forMainFrameOnly: true）。**播放器到底在不在主 frame，仓库里没有证据**：
    站点播放页要口令，首页拿不到；下载地址来自站点 API，不能反推 <video> 的位置。
    所以这里不猜 iframe、也不加跨 frame 逻辑，列为待真机核实的缺口。
  - 公开属性 webkitDisplayingFullscreen 可用时做两件事：调用后 300ms 宽限核对一次，以及页面回到
    前台（pageshow / visibilitychange）时核对一次（属性说不是全屏就补一次退出）。
    重点：300ms 核对发现已在全屏时不能再只兑现 Promise，必须和 begin 事件走同一条成功路径
    （enterNativeVideoFullscreen：记当前视频 + 发一次 playerFullscreen(true) + 兑现这次 token）。
    否则方向还停在竖屏、后面的 end 事件被当成无关视频丢掉、document.exitFullscreen 也找不到视频。
    属性不存在就只认 begin / end 事件，风险如实记在这里。
  - 原生兜底：页面开始新导航或网页进程被杀时，把全局方向状态复位回竖屏；它只处理换页/崩溃，
    **不能代替系统播放器 Done / 下滑退出**的事件兜底。
  原来「进 / 出全屏 → 原生锁横屏 / 回竖屏」的两态方向处理保持不动；退出后页面没有重建，
  详情页位置和播放进度都保持原样。
- **测试名**（Node）：
  a site fullscreen request on the player uses the native video player, not the black element fullscreen、
  a native video fullscreen also reports enter and exit exactly once、
  a native video fullscreen only resolves after the system reports it started、
  a native video fullscreen failure rejects and never falls back to the black element fullscreen、
  leaving the native player keeps portrait even if the page still reports a fullscreen element、
  a second fullscreen request while one is pending is rejected instead of stacking up、
  another video ending never ends the fullscreen video、
  the public webkitDisplayingFullscreen property can confirm a started fullscreen、
  coming back to the page clears a fullscreen the system already ended、
  iOS 15.0-15.3 without the element fullscreen API still reaches the native video player、
  the injected layer reports site fullscreen state without touching the page
- **修复版本**：0.1.19（build 23）
- **验证边界**：**真机**：容器全屏确实走原生视频全屏、横屏铺满、退出回原位续播；
  Node 用例只证明注入层行为。未验证项：iOS 15.0–15.3 的实际表现、播放器是否在 iframe 里、
  真实设备上是否保留用户手势、以及 system Done 退出时事件会不会丢；这几项都不声称已通过。

## REG-025 已下载的集交给其他播放器离线播放（build 23）

- **需求（Ken 2026-11-20 授权）**：已下载完成的一集能点「外部播放」，用 iOS「打开方式」菜单交给
  已安装的播放器（VLC / Infuse / nPlayer / SenPlayer 等），播的是本地文件、完全离线；
  不跳在线地址、不做后台 HTTP 服务、不在 App 内换播放内核。
- **入口**：「我的下载」里某部剧的某一集（已完成）行内「外部播放」；下载中 / 未完成的集没有 path，
  不显示这个入口。点整行仍然是 App 内 AVPlayer 播放，两条路并存。
- **原生**：WebViewController.presentOpenInMenu 用 UIDocumentInteractionController：
  路径必须是下载器**真实落盘目录**（MediaDownloader.directory() = Documents/Downloads）里的**普通文件**；
  目标和根都做 standardizedFileURL + resolvingSymlinksInPath，再按**完整路径组件**比较，
  `.../Documents-evil/x.mp4` 这种同前缀兄弟目录、目录本身、符号链接逃逸都拒绝。
  类型只处理下载器实际允许的 mp4/m4v/mov/mkv/ts：系统有声明类型且 conforms 到 movie / audiovisualContent 就用它；
  mkv/ts 在部分系统上没有声明类型，改用同扩展名、conforming 到 public.movie 的动态类型，
  不把所有扩展名硬套成 public.movie；取不到类型就明确提示「这个格式不能交给其他播放器」，不开菜单。
  iPad 用屏幕中间的小矩形做 popover 锚点；控制器由 documentInteraction 强引用，菜单关闭后释放。
- **反馈**：文件不在 / 文件已删 / 格式不支持 / 没有能接收的 App / 用户取消，都用网页 toast 说一句；
  用户真的选了 App 就直接切走，不再多弹提示。
- **提示链路**：notifyPlayerNotice 用 Swift 插值把 JSON 转义后的字符串拼进 evaluateJavaScript。
  复审揪出过一次：写成字面量便成了网页里的未定义变量，上面这些提示一条都发不出去。
- **测试名**（Node）：
  a finished episode offers the system player hand-off, a running one does not、
  the native open-in result is shown as a toast、
  the native notice bridge inserts the escaped message instead of a literal variable、
  the open-in hand-off only accepts regular files inside the real download folder、
  the open-in hand-off gives every allowed format a real type or a clear refusal
- **修复版本**：0.1.19（build 23）
- **验证边界**：**真机**：系统菜单里实际出现哪些播放器、对方能否完整读取并离线播放、
  mkv / ts 是否真能被某个播放器接住、iPad 锚点位置。本机是 Windows，Swift 既编不了也跑不了，
  presentOpenInMenu 的路径与类型逻辑**没有本机编译/运行证据**；Node 用例只钉源码守卫，不能替代真机。

## REG-026 build24 单集下载状态双源与删除复活

- **现象**：详情页点某一集下载，下载页不能马上看到这一集；删除后重启或重新进页，已删除的集又出现在片库。
- **根因**：原生下载器用 `kj-ios-download-tasks` 作为持久队列，网页同时把 `kj-ios-queue` / `kj-ios-downloads` 当状态源。左滑删除只删网页片库和本地文件，原生任务和晚到回调还在；重新进页时旧快照和 done 事件又写回片库。
- **修复（build24）**：
  - 原生记录成为唯一事实源：网页不再读写 `kj-ios-queue`，只接收原生 `__zhuijuDownloads('snapshot')`；启动时清掉旧缓存。
  - 点集先在内存里放一条 `queued` 乐观行，下载页/我的下载立刻显示排队；原生快照到达后按同一 `showId + epKey` 覆盖。
  - 左滑删除发 `deleteDownload`：原生先真删本地文件（`removeItem`，不再挪进 `.trash`），删成功才取消任务、写墓碑、清记录；文件删不掉就保留记录，回传 `deleteResult` 失败原因，网页撤掉自己的墓碑并把这一行放回列表；网页同步写墓碑，过滤晚到进度和旧快照。
  - 墓碑改成**独立持久存储**（`kj-ios-download-tombstones-v1`，`showId|epKey -> 删除时间`）：之前只从 `kj-ios-download-tasks` 记录里读墓碑，记录被 `suffix(400)` 裁掉后屏障就没了。现在旧的“一删一键”墓碑会迁移并清掉，记录里的 `deletedAt` 也并进来；保留最近 2000 条（有界）。主动重下同一集时明确清掉对应墓碑，并用新任务 id 建记录；集合清理旧记录时不再顺手删墓碑。
- **测试名**（Node）：tapping one cell in the episode grid queues exactly that episode、the tapped episode appears immediately while its source is still being resolved、a downloaded row can be deleted on its own, and only that file is asked to be removed、old snapshots, late done events and app restarts never resurrect a deleted episode、a deleted row is only reported gone after the native confirms the file is removed、a failed native delete puts the row back and clears the web tombstone、native records are the single source and deleted rows never come back、deleting an episode really removes the file and never pretends success、the tombstone store keeps blocking after the task records are trimmed
- **修复版本**：0.1.19（build 24，待出包）
- **验证边界**：本地 Node 89/89 通过（含上述两条删除路径与两条 Swift 源码守卫）；真机待 Ken 安装 build24 后验收。Windows 无 Xcode，Swift 未本地编译。

## REG-027 站上真实线路是 HLS，点下载却整条被拒（build 25）

- **现象**：详情页点某一集下载，下载页/我的下载里这一集直接失败或者根本没有进度，永远下不完。
- **根因（源码可证）**：
  - 网页侧 `resolveEpisodeUrl` 对 `data.kind === 'hls'` 直接返回「HLS 分片线路，不能整集下载」，
    地址以 `.m3u8` 结尾的再拒一次；
  - 原生侧 `MediaDownloader.rejection(of:)` 对 `.m3u8/.m3u` 同样直接拒绝，只收 https 的 MP4/M4V/MOV/MKV/TS 直链；
  - 之前所有的「下载通过」验证用的都是 DEBUG 受控源（127.0.0.1 回环 MP4），跟站上真实线路不是一回事。
- **修复（build 25）**：
  - 网页：`kind=hls` 或以 `.m3u8` 结尾的线路照常入队，并带上 `kind: 'hls'` 与页面 `referer`；MP4 直链仍走整文件下载。
  - 原生：`rejection` 放行 HLS 清单；`MediaDownloader.launch` 识别到 HLS 记录就交给 `HLSDownloader`。
  - `HLSManifest.swift`（新增，纯解析）：主清单按带宽（相同再看分辨率）挑最高一路；媒体清单解析 `#EXTINF`、
    `#EXT-X-MEDIA-SEQUENCE`、`#EXT-X-KEY`（AES-128 / IV）、`#EXT-X-MAP`（fMP4 初始化段排最前）、
    `#EXT-X-BYTERANGE`、`#EXT-X-ENDLIST`；相对 URI 按清单地址解析，分片没带 query 时继承清单的 query。
  - `HLSDownloader.swift`（新增）：分片走单独一条后台会话（`org.dpdns.zhuiju.ios.hls`），并发 ≤ 4、
    每片失败最多重试 3 次；请求带 Referer / User-Agent / Range；AES-128 用 CommonCrypto 解码（PKCS7）；
    fMP4 合成 `.mp4`、纯 TS 合成 `.ts`，写进 `Documents/Downloads` 后走原来的「完成」路径。
  - 进度：已下好的分片按字节汇总，再按「已完成时长 / 总时长」折算总量，网页百分比就是「已完成的分片 / 总片数」。
  - 中断恢复：任务状态、分片清单、已下分片（缓存目录）都持久化；暂停只停任务、删除才清缓存；
    重启后接着下，不从 0 重来；用户暂停/删除造成的取消不算分片失败，也不消耗重试次数。
  - DRM：SAMPLE-AES 等非 AES-128 线路明确失败并给出原因。
  - **复审补强（第一轮审核打回的三处，同一轮修完）**：
    - 分片失败改成挂一张「专属重试票」：有票期间 `pump` 不再抢跑；定时器要核对票号
      （`retryScheduled[key] == ticket`）才允许动手，被新一轮重试、暂停或删除顶掉的旧票直接作废；
      仍然是初次 + 最多 3 次重试；暂停/删除时把还没到点的票一并清掉。
    - 接管系统交回的后台任务前先核对持久记录（任务还在、阶段是 segments、分片下标有效、该片还没下完、没被暂停），
      对不上的直接 `cancel()`，不进内存；晚到的完成回调如果任务已删/已暂停/该片已完成就直接丢弃，
      不写缓存、不改进度，删掉的任务不会因为晚回调复活。
    - `EXT-X-BYTERANGE`：长度必须大于 0、给了偏移就必须非负、偏移 + 长度用 `addingReportingOverflow` 防溢出；
      省略偏移时按「解析后的完整资源地址（含 query）」续算上一段结束位置，不再拿原始 URI 字符串当 key。
- **测试名**（Node）：HLS 主清单：按带宽挑最高的一路，带宽相同看分辨率、HLS 相对地址和查询串：分片不带 query 时继承清单自己的 query、
  HLS 加密与初始化段：只认 AES-128，IV 缺省按媒体序号补、HLS 下载器：分片走后台会话，并发 4、每片重试 3 次、
  HLS 分片进度：按已完成的分片折算，长剧集不会提前跳到 100%、HLS 合成：解密用 CommonCrypto，按分片顺序写进下载目录、
  HLS 边界：DRM 线路明确拒绝，暂停/删除/重启都不从头再下、整文件下载不再拒绝 HLS，并且接到分片下载器、
  网页侧把 HLS 线路交给原生，并带上 Referer、AppDelegate 接住 HLS 那条后台会话、
  夹具清单结构自检：主清单三类码率、AES-128、EXT-X-MAP、纯 TS、
  download sends HLS playlists to native as hls and still refuses blob streams、
  HLS 重试票：失败分片只由自己的定时器拉起，pump 不抢跑、旧票作废、
  HLS 接管后台任务与晚到回调：先核对持久记录，删掉/完成/暂停的分片一律丢弃、
  HLS BYTERANGE 契约：长度>0、偏移非负、加法防溢出、按完整资源地址续算、
  BYTERANGE 夹具：同一资源省略偏移接着数，换 query 当成另一份资源
- **修复版本**：0.1.19（build 25）
- **验证边界**：**真实线路未验证**。站点 `/` 与 `/api/play` 需要访问口令，手上没有凭据，
  「两部不同来源的剧各下一集 + ffprobe 核对」这一条没有做，也不拿回环源冒充。Windows 本机没有 Xcode，
  新增的 Swift 文件没有本地编译；Node 用例（本轮 104/104）只钉源码守卫与夹具结构，不是 Swift 行为测试。**真机**待办：真实 HLS 的清单解析、AES 解密、
  fMP4/TS 合成、切后台续下、完成后播放。
  **已知限制**：纯 TS 合成出来的 `.ts` 系统播放器打不开（AVFoundation 不支持 MPEG-TS），App 内会提示改用「用其他播放器打开」；
  fMP4 合成的 `.mp4` 可以 App 内直接播。

## REG-028 App 显示名与文案从「追剧AI」改为「阿噗影视」（build 26）

- **现象**：手机桌面图标下的名字、系统里显示的 App 名仍是旧的「追剧AI」，与站上的「阿噗影视」不一致。
- **根因**：`ios/ZhuijuAI/Info.plist` 的 `CFBundleDisplayName` 写死 `追剧AI`，`CFBundleName` 取自
  `$(PRODUCT_NAME)`（`ZhuijuAI`）；H5 外壳 `ios-shell/ZhuijuH5` 的显示名与离线提示也还是旧名。
- **修复（build 26）**：
  - `ios/ZhuijuAI/Info.plist`：`CFBundleDisplayName` = `阿噗影视`，`CFBundleName` = `阿噗影视`（字面值，不再取 PRODUCT_NAME）。
  - `ios-shell/ZhuijuH5/Info.plist`：显示名 `追剧AI H5` → `阿噗影视 H5`；`WebViewController.swift` 离线提示
    `连不上 追剧AI` → `连不上 阿噗影视`。
  - 不动 Bundle ID（`org.dpdns.zhuiju.ios` / `org.dpdns.zhuiju.h5`）、target/工程名（`ZhuijuAI`）、
    `PRODUCT_NAME`（可执行文件与 `ZhuijuAI.app` 产物名）、包内类名与变量名、UA 里的 `ZhuijuAI/<版本>`（站点按该前缀识别 App）、
    站点域名与接口。App 内网页部分的站名来自已上线的站点，站点已经是「阿噗影视」，注入层无需改。
- **测试名**：无（Ken 2026-11-19 的 HARK-SMALL-UI-EXEMPT：只改显示名的文案类改动不新增/不跑测试，编译通过即可出包）。
- **修复版本**：0.1.19（build 26）
- **验证边界**：Windows 本机没有 Xcode，`xcodebuild` 只在云端打包时跑；真机桌面名与「设置」里的 App 名需 Ken 装新包后核对。

## REG-029 部分影视下载直接失败 / 取消过一集后队列永远排队（build 27）

- **现象**（Ken 真机反馈）：
  1. 站上能正常播放的剧，点下载立刻失败（提示片源服务器返回 403 / 网络中断），换几部都下不了；
  2. 「一键全集」里排队的集一直停在「排队中」，一集都不往下走；取消或删过一集之后更容易复现，杀 App 重开也不动。
- **根因（代码 + 实测证据，不照抄“绝对路径”那套假说）**：
  1. **整文件（MP4 直链）下载发的是裸请求**：`MediaDownloader.launch` 用 `session.downloadTask(with: url)`，
     后台会话默认 UA 是 `App名/版本 CFNetwork/...`；**HLS 的 UA 也只有 `ZhuijuAI/<版本> iOS`**
     （`record.meta["userAgent"] ?? WebViewController.userAgent`），整文件连 Referer 都没带。
     网页播放器用的是真 Safari UA + 站点 Referer，片源 CDN 按 UA/防盗链放行，播放能过、下载不能过。
     实测（`ios/scripts/probe_matrix.py`，同一批 DB 里判定 `ok` 的真实线路，只记状态码不记签名）：
     | 线路（脱敏域名） | 无 UA | App 令牌 UA | Safari UA + Referer |
     | --- | --- | --- | --- |
     | svip.xgplay12.com（xigua） | 403 | 200 | 200 |
     | cdn5.ryplay5.com（ruyi） | 连接被拒 | 200 | 200 |
     | ukzy.ukubf3.com（uku） | 000/403 | 403 | 403 |
     | sign.site.zshtys888.com（official-r，DB 判 ok） | 402 | 402 | 402 |
     结论：**UA 是最直接的差异**；`sign.site…` 这类“当时 ok、现在 402”的是令牌过期，重试必须重新解析。
  2. **取消/删除后记录会被启动对账“复活”**：`MediaDownloader.reconcile` 对上系统里还在的任务时
     无条件 `records[index].status = "running"`，不看记录是否已 cancelled / 已删除 / failed。
     `URLSessionTask.cancel()` 是异步的，取消后的下一次对账（页面加载、回到前台、切页各一次）
     会把它写回 running，而那条任务再也不会发终态回调 —— 于是两个并发名额被僵尸永久占住，
     后面的集全部停在「排队中」。孤儿后台任务（记录已删）以前也从不 `cancel()`。
  3. **没有集号的入队请求被静默丢掉**：`enqueue` 里 `if epKey.isEmpty { continue }`，
     网页已经先画了一行「排队中」（乐观行），原生既没有记录也没有失败事件 → 永远排队、实际没下。
  4. **取消用的是 `HLSDownloader.pause`**：分片任务和分片缓存都留着，重启后与本地队列对不上，成为僵尸。
- **修复（build 27，只动下载底层，不碰改名/播放/界面）**：
  - `MediaDownloader`：新增 `mediaUserAgent`（浏览器 UA + `ZhuijuAI/<版本> iOS` 令牌）与
    `mediaRequestHeaders(from:)`；整文件下载改成 `URLRequest`，带 `Referer` / `User-Agent` / `Accept`。
    网页加载完由 `WebViewController.captureMediaUserAgent` 把真实 `navigator.userAgent` 交给原生（兜底才是常量 UA）。
  - `HLSDownloader`：清单/分片/密钥统一用同一份浏览器 UA（只在网页给的是真浏览器 UA 时照用），
    同一个 id 换了清单地址时先丢旧分片缓存；重启对账时把“记录还在下、但没拿到后台回调”的 job 重新 `pump`。
  - `reconcile`：加防重入；**只接管 queued/running 且未删除的记录**，终态记录对应的任务与孤儿任务一律 `cancel()`；
    同时清掉旧版本遗留的 HLS 僵尸 job（`HLSDownloader.discardZombies`）。
  - `enqueue`：缺集号的请求落一条 `failed` 记录（原因：这一集缺少集号，没法下载），不再静默丢。
  - 取消/失败 → `HLSDownloader.discard`（连分片缓存一起清），暂停才 `pause`（保留已下分片继续续传）。
  - 网页：失败的那一格写「失败 · 点一下重试」，点格子会重新解析 `/api/play`（拿新地址）再入队。
- **测试名**（Node，`ios/Tests/downloadFailure.test.mjs`，10 条源码守卫）：整文件下载带上页面 Referer 和浏览器 UA，
  不再发裸请求、媒体请求头：有浏览器 UA 就用网页的，只有 App 令牌就退回兜底 UA、HLS 分片不用裸 App 令牌当 UA、
  启动对账：只接管队列里的任务，孤儿和终态任务一律 cancel、HLS 重启后：没拿到后台回调的 job 也要接着下，
  不能停成僵尸、取消/失败丢分片缓存，暂停保留、没有集号的入队请求要落一条失败记录，不能静默丢掉、
  暂停的一集不会被启动对账当僵尸清掉：缓存留着，调度停掉、同一 id 换清单：旧清单、密钥、分片回调按代次作废、
  失败的那一格写清「点一下重试」，点格子会重新解析片源再入队。
- **审核第一轮意见（已修，仍是 build 27 同一交付）**：
  1. `discardZombies` 原来只把 queued/running 当活任务，暂停中的 HLS job 被当僵尸，
     切页/回前台/重启一次对账就把已下好的分片删掉，续传变重下。现在 MediaDownloader 对账把 paused
     算活任务，`discardZombies(isLive:isPaused:)` 对暂停 job 只停分片调度、保留 job 与分片缓存；
     进程重启后 `paused` 内存态为空，也从记录把暂停态同步回来。
  2. 同一 id 换清单时旧回调会污染新任务：清单/密钥请求仍可能晚到，`planning` 被旧回调清掉后还能双开，
     密钥与分片回调只按 id 查找就写进新 job。现在每次 `begin`/`discard`/`fail`/合成完成都换代次，
     清单、密钥、分片下载和重试定时器全部带代次校验，旧回调既不能清解析标记，也不能写进度或缓存。
     新增两条源码守卫测试（暂停对账保留缓存、换清单代次作废旧回调）。Swift 行为仍需**真机**验证。
- **修复版本**：0.1.19（build 27）
- **验证边界**：Windows 上既没有 Swift 编译器也跑不了 iOS 模拟器；Swift 这几处只有源码守卫 + 审核目视，
  **编译门禁是 packaging-only 的 xcodebuild**，真正行为要等新包安装后**真机**验证（UA/Referer 是否过 CDN、
  取消后队列是否继续、重启后是否续下、失败格是否可重试）。3 部真实样本（谷雨 / 倾世锦鳞谷雨来 / 古玉劫后香）
  是数据库 + 源站探测证据，**不是**真机下载成功证据。

## REG-030 下载记录删不掉（build 27）【真机】

- **现象**：我的下载里某些历史条目，左滑点「删除」后提示删除失败，条目一直留着；重装或换包（build 号变化）后更容易出现。
  下载中 / 排队 / 失败的集在列表里根本没有删除入口，失败的集连行都不显示；失败的集还一直占着队列名额。
- **根因（代码可证，非猜测）**：
  - 记录里存的是**沙盒绝对路径** `/var/mobile/Containers/Data/Application/<UUID>/Documents/Downloads/x.mp4`
    （网页 `recordDownloaded` 直接存 `payload.path`，原生 `complete(id:)` 也直接存 `payload["path"]`）。
  - `MediaDownloader.removeDownloadedFile(at:)` 当时把这条绝对路径 `resolvingSymlinksInPath()` 后，
    与**当前** `Documents/Downloads` 做 `pathComponents` 前缀比较；App 换一次容器，旧记录里的 `<UUID>` 就不再等于当前容器，
    前缀必然不匹配，函数直接 `return false`（`refuse to delete file outside download directory`），
    网页把失败原样显示回来 —— 于是这一行永远删不掉。
  - 同一份绝对路径还喂给离线播放和「其他播放器打开」，换容器后同样失效（表现为「文件不在了」）。
  - 删除入口只挂在已下载片库行（`.ip-eprow`）上：`data-dl-task` 的下载中/排队行没有删除键，
    `queueTaskRows()` 也只收 `running/queued`，`failed` 行既不显示也无处清理。
- **修复（build 27）**：
  - 只持久化**相对路径** `Downloads/<文件名>`：网页 `relativeDownloadPath()`、原生 `MediaDownloader.relativePath(for:)`；
    `downloadsFolder` 只写一处。`loadRecords()` 读到旧绝对路径就就地迁移成相对路径（只改写法，不动文件）。
  - 新增唯一解析入口 `MediaDownloader.fileURL(forStoredPath:)`：先校验来路（只认裸文件名、`Downloads/<文件名>`、
    旧容器 `…/Documents/Downloads/<文件名>`），再取最后一段文件名拼到**当前** `Documents/Downloads`，
    仍做「必须是下载目录直接子项」的边界检查（`..`、`.`、空串、目录一律拒绝）。
    删除、App 内离线播放、外部播放器打开、删除后回填都走这一个入口。
    网页侧 `relativeDownloadPath()` 用同一套写法校验：`/tmp/x.mp4`、`../../outside.mp4`、`Downloads/子目录/x.mp4`
    这类越界路径一律归一成空串（记录仍可删，文件不动），不再凭文件名映射到下载目录里的同名文件。
  - `removeDownloadedFile(at:)` 不再拿旧绝对路径去比较；文件本来就不存在视为**清理成功**并清记录；
    真实权限/磁盘错误仍返回失败并把原因回给网页，不虚报释放空间。
  - 下载中 / 排队 / 失败三种行都能左滑删：网页 `deleteQueuedTask()` 写墓碑后发 `deleteDownload`（`path` 为空表示没有文件要删）；
    原生 `deleteEpisode` 先 `task.cancel()`、`HLSDownloader.discard(id:)`、清 `path`、写墓碑，再 `pump()` 释放并发名额；
    取消回调 / 旧快照 / 晚到 done 都被墓碑挡住，不会复活记录。
  - 删除正在 App 内播放的那一集：`WebViewController` 记住当前播放器和文件，先 `pause()` + 收起播放器，再删文件。
  - 已下载列表仍然只有左滑删除一个入口，没有新增其它删除按钮；队列行的删除键沿用同一套左滑露出。
- **改动文件**：`ios/ZhuijuAI/MediaDownloader.swift`、`ios/ZhuijuAI/WebViewController.swift`、
  `ios/ZhuijuAI/AppBootstrap.js`、`ios/Tests/bootstrap.test.mjs`、`ios/Tests/downloadQueue.test.mjs`、`ios/Tests/nativeSource.test.mjs`。
- **测试名（Node）**：a downloaded row saved with an old app-container path can still be deleted、a new download is stored as a relative path, never the absolute sandbox path、downloading, queued and failed rows can all be deleted and never come back、deleting a running row asks native for that task only and lets the queue move on、a stored path from an old app container still resolves inside the current downloads folder、download records only persist a relative path and rebuild the absolute one on use、deleting the episode that is playing offline stops the player before removing the file、deleting a running job cancels the task, drops its cache and frees the queue slot、a cancelled job callback never writes a deleted record back、a stored path outside the downloads folder is never mapped onto a same-named file、the native path resolver only accepts paths that really point into downloads。
- **审核第一轮意见（已修）**：只取文件名归一，会把任意来源的路径（包括越界路径）也落到下载目录里的同名文件，删除时可能误删。
  已加与原生一致的写法校验，并补两条测试（网页侧行为测试 + 原生源码测试）；旧测试里用 `/tmp/...` 伪路径当原生 done 回传的夹具
  改成真实沙盒 `…/Documents/Downloads/...` 形式（只改夹具数据，断言一条未改）。
- **本地验证**：套内存硬上限跑 `python C:\Users\kenzh\hark_tasks\memcap.py 2048 node --test Tests/*.test.mjs` → 删除线单独 **115/115 通过**；
  两条线合并后同一命令 **126/126 通过**（0 失败，未触发 memcap）。Windows 无 Xcode，Swift 未本地编译，
  编译只在 packaging-only 工作流里发生。
- **验收边界**：以下都要**真机**（Ken 装新包后）核对：旧记录（换过容器的绝对路径）能删、删完文件真的不在了、
  下载中/排队/失败左滑删后队列继续走、删正在播的那一集先停播、删除失败时条目留在列表里。
  本轮未做云端测试、未跑模拟器/XCUITest/UI smoke/截图门禁（HARK-NO-CLOUD-TEST）。
- **已知限制**：记录只存文件名，两条不同记录若文件名恰好相同会指向同一个文件（现网文件名带剧名+集号，未发现撞名）；
  这不是跨目录映射：非下载目录的路径已按上一条校验拒绝解析。

## REG-031 一条失败的测试断言把 node 进程吃到 40GB（夹具 DOM 展开）

- **现象**：跑 `Tests/downloadQueue.test.mjs` 的 `a failed episode never lets the show look complete...` 时，node 进程涨到 40GB，把电脑撑死，被 Hark 杀掉；`--max-old-space-size` 完全拦不住。
- **根因（已复现，按版本对过）**：触发版本是 `kanju-build27` 工作树里**未提交的草稿 AppBootstrap**（补丁 `Temp/kanju-build27-draft-queue.patch`，blob `556d9d2`，后被改成 `c0a99fc`，两者都复现），不是任何已提交版本（4f1b14f / 4712d53 / 2f3297b 全部通过）。草稿把 failed/paused 也渲染进 `iosMineQueue`，测试断言 `assert.equal(queueNode, null, ...)` 必然失败；Node 的 assert 用 `customInspect:false, depth:1000` 展开 actual，而夹具节点的 `children` / `parentNode` 都可枚举且互相引用，共享子树被反复展开，报错字符串指数膨胀：只有 3 行队列就 **569,919 字符**，规模再大就是几十 GB。进程死于 `Committing semi space failed` / `Fatal process out of memory: Worklist::Segment::Create`。不是 App 代码的死循环。
- **修复**：`Tests/fixture-dom.mjs` 新增夹具节点单行 inspect 摘要；`downloadQueue.test.mjs` / `bootstrap.test.mjs` 把每个夹具节点的 `children` / `parentNode` 改为不可枚举（读写行为不变），assert 展开时不再遍历整棵 DOM；新增一条回归钉住「报错必须是小段文本」。没有删测试、跳测试或放宽断言。
- **测试名**：`a fixture node prints as one short line so a failed assertion cannot dump the whole DOM`（Node，`Tests/downloadQueue.test.mjs`）。
- **修复版本**：0.1.19（build 27，本分支 2f3297b 之后）
- **验证**：全部套 `python C:/Users/kenzh/hark_tasks/memcap.py 2048`：本分支 113/113 通过；同一条失败断言在草稿代码上修复前 OOM、修复后 52ms 内以普通 AssertionError 失败，内存降到 512MB 也不会 OOM。触发版本 hash、复现命令和完整证据见 `ios/DOWNLOAD_TEST_MEMORY_20261120.md`。
- **验证边界**：这是 Node 夹具/测试基础设施问题，不涉及 Swift 编译或真机行为。

## REG-032 切到后台后 HLS 下载实际停住（build 27 报，build 28 修）【真机】

- **现象**（Ken 真机 build 26/27）：一部剧下载中，切到其他 App 看 10 多分钟，回来进度几乎没动。
- **复现步骤**：选一部 HLS 线路的剧（绝大多数线路都是 HLS）→ 点下载 → 立刻切到别的 App（或锁屏）→ 等 10 分钟 →
  回到 App 看「我的下载」那一行的进度；同样条件下锁屏 10 分钟再回来看。
- **根因（源码可证，两条，非猜测）**：
  1. **分片派发是进程内串行的**。`HLSDownloader.pump` 用 `maxSegmentConcurrency - active` 算「空位」，
     系统里任何时刻最多只有 4 条分片任务，下一片必须**等进程内收到完成回调**才发。
     App 被挂起后没有代码继续发任务，这 4 条传完队列就空了 —— 分片任务本身在后台会话里，
     但「发下一片」这一步绑在 App 进程上，这就是进度不动的原因。
     线上片源实测：单集 401~1378 个分片（`hongniu`/`jinying` 用 AES-128，其余多为 `METHOD=NONE`），
     一部剧要几百次「完成回调 → 发下一片」的接力，挂起期间不可能完成。
  2. **后台事件收尾回调没有归还**。`adoptBackgroundEvents` 只在 `systemTasks.isEmpty` 时才调用
     `handleEventsForBackgroundURLSession` 给的 completionHandler。一集有几百片时系统任务几乎从不空，
     回调就一直没交回系统；iOS 据此认为 App 还在处理事件，不再为这条会话唤醒/续跑，分片彻底停住。
  - **用户初步判断的核对结果**：`isDiscretionary` 两条后台会话早已是 `false`（疑虑 3 排除）；
     `foregroundSession` 只做清单/密钥，媒体分片走的是后台会话 `org.dpdns.zhuiju.ios.hls`（疑虑 2 与源码不符），
     **但「一片完成才发下一片」这条已确认，是主因**。
- **修复（build 28，采用方案二：全量计划一次入队）**：
  - `pump` 不再算空位：解析完清单后把**所有未完成分片一次性投递**进系统后台队列；
    并发改由 `URLSessionConfiguration.httpMaximumConnectionsPerHost = maxSegmentConcurrency`（4）限制，
    任务归系统所有，App 挂起/锁屏都由系统继续传，不再依赖进程内回调接力。
  - `adoptBackgroundEvents` 重写：认领系统任务 → 记「本进程已对账」→ 磁盘对账 → 再补发缺失分片。
    **认领与收尾分开**：这趟只负责接管和补发，收尾回调不在这儿归还。
    completionHandler 改为在 `urlSessionDidFinishEvents` 里归还（这一轮事件真的处理完才还）。
    **第二次送审后强化（审核 2026-11-21 第 2 轮）**：
    1. 回调改用 `pendingCompletions` 数组排队：上一轮还没还完系统又唤醒一次时，两张票都留下来逐张归还；
       旧版用单个变量，后一次唤醒会覆盖前一次，前一张永远不还，系统最后会终止 App。
    2. **整条删掉超时兜底**（`armFinishEventsDeadline` / `finishEventsTicket` / `adoptionQuiet` / `delegateDepth`，第 3 轮审核）。
       原因：分片代理和兜底定时器都在主队列上跑，定时器触发时同步的 `finish(key:…)` 已退出、`delegateDepth` 必为 0，
       它根本看不见「还在排队、还没送达」的回调；`adoptionQuiet` 首次对账后也一直为 true。
       「到点」永远证明不了「事件已送完」，这条机制不能加固，只能删。
       现在归还的唯一路径是 `urlSessionDidFinishEvents` —— 系统在那里保证本轮事件已全部送达。
    3. **轮次改用唤醒票，不用单个布尔值**（`roundActivity` 已删，第 3 轮审核）。旧版会被这种交错骗过：
       「上一轮超时归还 → 下一轮登记 completion → 上一轮迟到分片进 `finish` → 置 true →
       上一轮迟到的 `urlSessionDidFinishEvents` 取走下一轮全部 completion」。
       现在 `handleEventsForBackgroundURLSession` 每登记一张唤醒票 `wakeTickets += 1`，
       `urlSessionDidFinishEvents` 每次只销一张、只还最早登记的那一张；没有票就是迟到的尾巴，直接忽略；
       连续两次唤醒时两次收尾各还一张，后登记的那张不会被本轮还没送完的事件提前还掉。
       迟到分片回调的归属仍由原有代次/任务号校验拦下。
    `ensureAdoption()` 让首次发包前必先对账，避免进程重建后给同一片再发一条任务。
  - 新增 `reconcileDisk(id:)`：`seg-<序号>.part` 是整片下完才改名的，存在即视为已完成；
    进程死在落库前也不重下，整集齐了直接 `finalize`，不会停在「其实已经下完」的活儿上。
  - `startSegment` 增加 `inFlight` 兜底（同一片绝不发两条系统任务）；投递计数改走本类新增的
    `bumpAttempts`（内存立即加一、落盘按秒节流）。
    **修正**：送审版误用了 `update(id, force: false)`，而这个签名只存在于 `MediaDownloader`，
    `HLSDownloader` 自己的 `update` 只有 `(id, mutate)` —— 跨类用不了，会直接编译失败（审核 2026-11-21 第 1 条）。
  - 暂停/恢复/取消/删除语义不变：`pause` 仍保留已下分片、`cancel`/`discard` 仍清缓存并取消全部已投递任务，
    代次校验与墓碑语义沿用（晚到回调不会复活已删记录）。
  - mp4 直链原本就走后台会话，未改动。
- **改动文件**：`ios/ZhuijuAI/HLSDownloader.swift`、`ios/Tests/backgroundDownload.test.mjs`（新增）、
  `ios/project.yml`（build 27→28）、`.github/workflows/ios-ipa-only.yml`（产物 build 断言 28）、`ios/REGRESSIONS.md`。
- **测试名**（Node，`ios/Tests/backgroundDownload.test.mjs`，10 条）：分片全量入队：pump 把剩下的分片一次性交给系统队列，
  不再按空位在进程内派发、后台会话并发上限交给系统：整集分片一次入队，仍在 4 条连接内排队、
  后台事件收尾：认领与收尾分开，归还只由 `urlSessionDidFinishEvents` 触发、
  **连续两次后台唤醒不吞回调：攒成队列，逐张归还**、
  **迟到的收尾碰不到下一轮：按唤醒票数逐张归还，不用单个布尔值表示轮次**、
  **不设超时兜底：源码里没有任何「到点就还收尾回调」的路径**、
  分片投递计数走本类自己的节流写，不调用不存在的 `update(id:force:)`、重启对账：先认回系统里在跑的分片再发新任务，
  磁盘上已完成的分片不重下、暂停/删除照样停掉已经投递进系统队列的全部分片、mp4 直链仍然走真正的后台会话。
- **本地验证**：套内存硬上限 `python C:\Users\kenzh\hark_tasks\memcap.py 2048 node --test ios/Tests/*.test.mjs Tests/*.test.mjs`：
  首次送审版（`746527f`）6 条里 4 条红；第 1 轮审核打回后新增 1 条编译签名守卫，改完 **133/133**。
  第 2 轮审核打回后改契约、补 3 条（连续两次唤醒、轮次校验、兜底判定）：回退到 `00aeaac` 时 **4 条红**，
  改完后全仓 **136/136 通过**（0 失败）。
  第 3 轮审核打回后（超时兜底、单个布尔值轮次两条）：先把测试改成新契约，对 `f562b4d` 跑 **4 条红**
  （收尾契约、两次唤醒逐张还、唤醒票、无超时路径），改完后全仓 **139/139 通过**（0 失败，未触发 memcap）。
  旧测试未删、未跳；四处断言修改都是审核指出契约错之后改的（第 1 轮：只在 `urlSessionDidFinishEvents` 归还；
  第 2 轮：单张回调改队列；第 3 轮：超时兜底整条删除、轮次改唤醒票），改后断言比旧版更严，不是放宽。
- **修复版本**：0.1.19（build 28）
- **为什么没选方案一（AVAssetDownloadURLSession）**：
  1. 现有回归有 15+ 条源码守卫钉住分片引擎（pump/retry/finalize/decrypt），规则不许删测试或改断言；
  2. `.movpkg` 只能 AVFoundation 播，而 App 的离线播放入口、外部播放器打开、左滑删除、相对路径都按单文件设计，
     换方案要重做整条播放/删除/片库链路；
  3. 该 API 没有受支持的途径给每个分片请求注入本仓库必需的 Referer/UA（本仓库已有 CDN 403 实证），
     AES-128 线路的密钥获取也不受我们控制。
- **验证边界（真机待验收，未提前声称通过）**：Windows 上没有 Swift 编译器，Swift 只做了源码守卫 + 打包阶段编译；
  以下四项必须在 Ken 装 build 28 后真机核对：
  1. m3u8 剧下载中切到别的 App 10 分钟，回来进度明显前进或已完成；
  2. 锁屏 10 分钟，回来进度继续；
  3. 完成后断网，App 内离线播放正常（AES-128 线路也要能播）；
  4. 左滑删除能真删掉文件，队列继续走、记录不复活。
  已知平台边界：解密与合成必须在 App 进程里做，后台只保证「传输」；如果全部片段在后台传完，
  合成会在回到前台时进行。
  收尾回调按 iOS 的平台约定归还：`handleEventsForBackgroundURLSession` 登记、`urlSessionDidFinishEvents` 收尾，
  一一配对，**不再设任何超时兜底**（上一版的 14 秒硬上限已删除）。若系统始终不调 `urlSessionDidFinishEvents`，
  回调会一直挂着，最终由系统终止 App —— 这是 iOS 已定义的边界；App 内部没有办法更早、更安全地自证
  「事件已送完」，不做超出平台契约的承诺。

## REG-033 原生「我的下载」：断网也能按剧看全库、离线播放、长按分享单集（build 29）

- **需求（Ken）**：设置面板最上方要一个**原生**离线「我的下载」入口；飞行模式下不加载远端网页也能按剧看全库、
  离线播放，并把已完成的单个文件分享给其他 App；一级按剧分组（集数 + 占用）、二级按集；只左滑删除，
  一级删整剧、二级删单集；下载中的集置顶并显示进度。
- **改动文件**：
  - `ios/ZhuijuAI/DownloadLibraryViewController.swift`（新增）：一级按剧列表 + 二级集列表 + 长按分享 + 左滑删除 + 底部真实占用/剩余空间；
  - `ios/ZhuijuAI/WebViewController.swift`：新增 `myDownloads` 原生动作、`presentDownloadLibrary()`、断网页的离线入口按钮，
    并在转发下载事件的同时广播 `downloadLibraryDidChange`（`eventSink` 仍归网页独占，没有第二个静态回调）；
  - `ios/ZhuijuAI/AppBootstrap.js`：设置面板**最上方**新增「下载 → 我的下载」一行，点击关闭面板后交给原生；
  - `ios/project.yml`、`.github/workflows/ios-ipa-only.yml`：build 28→29 与出包断言同步。
- **数据源**：只有一份 —— `MediaDownloader.snapshotForPage()`。没有第二份持久化，也没改下载文件命名 / 目录 / 后台引擎。
  快照没有封面与总集数，所以界面用占位封面、集数只按真实已完成的集算；占用按磁盘枚举（记录里的 `size` 只是字段），
  剩余空间取系统 `volumeAvailableCapacityForImportantUsage`。
- **删除语义**：复用 `removeDownloadedFile(at:)`（安全路径解析、只删下载目录直接子项、目录与越界一律拒绝、
  文件本来不在算成功）与 `deleteEpisode(id:showId:epKey:)`（取消任务、丢 HLS 缓存、写墓碑、pump）。
  顺序是「停同文件播放 → 删文件成功 → 删记录」；文件删不掉时记录保留并弹提示。整剧删除按集循环，
  部分失败只保留失败的那几集并如实告知删掉了几集，不假装整剧原子删除。
- **分享语义**：只分享磁盘上这一个已完成文件（解析后必须落在 `Documents/Downloads` 直接子项、是普通文件、
  扩展名属于 mp4/m4v/mov/mkv/ts）；iPad 有 popover 锚点；缺文件 / 格式不支持 / 删除失败都用原生 alert 明确反馈。
  不复用旧的 `UIDocumentInteractionController`（那是旧「打开方式」入口），也不复用 `presentLocalFile`（它缺严格校验）。
- **验证（本条为功能交付，Ken 指定免新增/运行测试）**：
  - 本地 Node 源码守卫与夹具：`python C:\Users\kenzh\hark_tasks\memcap.py 2048 node --test ios/Tests/*.test.mjs Tests/*.test.mjs`
    → **139/139 通过**，未触发 memcap；旧测试未删、未跳、未改断言。
  - Swift 在 Windows 上编不了，编译由 packaging-only 工作流（`ios-ipa-only.yml`，Release、无签名）验证。
  - **真机待验收**（装 build 29 后核对）：①飞行模式下从报错页进「我的下载」能按剧看到全库；②点已完成集能离线播放；
    ③长按「分享本地文件」把这个文件分享到其他 App，iPad 位置正确；④一级左滑删整剧、二级左滑删单集都能真删掉文件，
    队列继续走、被删的集不复活；⑤底部占用与系统设置里的 App 占用基本一致。
- **审核第 1 轮返修（只读审核列出的 3 条）**：
  1. **删除竞态遗留孤儿文件**：删除不再用确认框打开时的旧快照路径，改为删除时按最新记录重取
     （新增 `MediaDownloader.currentStoredPath(id:showId:epKey:)`，一级整剧、二级单集都走它）。
     另外 `complete(id:payload:)` 对「已被墓碑作废的集」顺手删掉刚落盘的文件：用户删除的那几秒里刚好下完，
     不会再留下没人认领的文件。
  2. **「全库」被 400 条上限截断**：`persist` 改成「已完成且有落盘路径的记录全保留（极端兜底 2000 条，
     最旧的裁掉），其余记录仍只留最近 400 条」。片库不再因为条数裁剪丢已下载的剧集。
     遗留说明：本版之前已被旧逻辑裁掉的记录恢复不了分组（文件仍在磁盘、占用已计入底部），本版起新完成的都会留在片库。
  3. **部分 HLS 下载（.ts）无法 App 内播放**：App 内播放只认可 mp4/m4v/mov（`inAppPlayableExtensions`）；
     `.ts`/`.mkv` 点开时弹出说明并给「用其他应用打开」，二级长按的第一项也变成「用其他应用打开」，
     不再把用户丢进系统播放器的黑屏与 1.5 秒失败提示。
