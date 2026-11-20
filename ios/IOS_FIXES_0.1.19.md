# 追剧AI iOS 0.1.19：播放器只留网站那一套，下载链路修通

版本：0.1.19（build 21）　分支：`fix/ios-0.1.19-player-download`

## 一句话结论

上一版真机上「点下载没任何反应」不是网络问题，是三处叠加：注入层自己的登录门控在新站永远判「没登录」、
原生层又把网站发来的下载请求静默丢掉、下载页刷新时调用的是上一轮已经删掉的函数。
播放器那边是「网站自己的控制栏」和「注入层仿出来的控制栏」同时挂着，全屏时 App 还锁着竖屏，所以看起来两套播放器、转屏也不对。

这一版删掉注入层那一整套原生叠加控件（顶部条、全屏浮层、画面档位、倍速菜单、投屏/外放菜单、复制链接），
画面和全屏都交回网站自己的播放器；方向不再锁，横竖屏跟着系统转。
下载改成只认一条队列：网站上的下载入口 → 原生批量队列 → 下载页格子进度 → 我的下载进度条和百分比 → 完成后离线播放。

## 根因一：点下载没任何反应

1. **原生层把请求丢了。** 网站播放页的下载入口发来的消息只有 `{action:'download', url, name}`，
   而 `WebViewController.beginDownload` 要求 `signedIn === true` 并且带 `id`，两条都不满足就 `return`，
   不回事件、不提示，用户在界面上看到的就是「点了没反应」。
2. **注入层自己还拦了一道登录。** `startBatch` 先看 `localStorage['kj-auth-token']`，
   新站（阿噗影视）根本不写这个 key，所以即使请求走到了注入层，也会被「登录后才能下载本集」挡回去，队列一条都进不去。
3. **下载页的刷新函数已经被删了。** 删原生界面时 `syncDownloadRow()`、`syncTencentUI()` 一起删了，
   但下载完成、进度推送的路径还在调它们，运行期直接抛错，格子状态永远停在第一次渲染。

## 根因二：进度看不到

下载页格子只在「打开下载页」时同步一次；之后原生的 `progress` 事件虽然到了网页，
但真正的刷新入口（`syncDownloadPage()` + `renderMinePageIfOpen()`）没被调用，
「我的下载」页也就一直是空的或旧状态。这一版把三条路径都接回同一个刷新入口：
进度事件、完成事件、回到前台时原生补发的快照。

## 根因三：两套播放器 / 横竖屏错乱

1. 网站自己的播放页有 `#ppCtrl` 这一套控制栏（`src/player-ctrl.js`），注入层又仿了一套同名控件，
   视觉上就是「两层播放器叠在一起」。
2. 注入层还写了 `#playTools,.pp-toolbar,#btnFull,#btnGear,#btnPip{display:none!important}`，
   把网站自己的工具条（显示设置/线路/弹幕/画中画/下一集）整条藏掉，用户只能看到注入的那套。
3. 全屏是注入层自己接管的：进全屏发 `fullscreen` 消息让原生锁竖屏、改约束；
   网站自己的全屏走 `requestFullscreen` / `data-ios-immersive`，两条路互相打架，
   所以出全屏之后标题栏、工具条、方向都回不到正常状态。

## 这次改了什么

### `ios/ZhuijuAI/AppBootstrap.js`

- 删掉整套原生叠加控件与它们的 CSS：顶部条、全屏浮层、画面档位几何计算、倍速菜单、投屏/外放菜单、复制链接、
  沉浸态（`data-ios-immersive`）规则。现在不再有 `#iosTopBar`、`#iosFullBtn`、`#ppCtrl` 这些注入节点。
- 删掉 `#playTools`、`.pp-toolbar`、`#btnFull` 等「隐藏网站按钮」的规则；网站工具条原样显示。
- 删掉 `signedIn()` / `askLogin()` 门控：新站没有 App 登录态，点下载直接入队。
- 下载入口认两处：新版播放页的 `[data-pw-act="dl"]`，和网站控制栏里的「下载本集」`#ppDownload`。
- 集数、标题、封面改读新站的 `.pw-title` / `#pwEpCount` / `.pw-card-bg`，并保留旧站的选择器兜底。
- 修正运行期错误调用：`syncDownloadRow()` / `syncTencentUI()` → `syncDownloadPage()`；
  当集下载完成后补一次 `renderMinePageIfOpen()`，避免「我的下载」停在旧状态。
- `dlDownloaded` 拆成 `dlDownloadedEntry` + 包装，离线播放能拿到真实落盘路径。

### `ios/ZhuijuAI/WebViewController.swift`

- 删掉全屏接管：`PlayerAction.fullscreen/inline`、全屏约束、`setPlayerFullscreen`、`requestRotation`、
  状态栏/指示条隐藏的覆盖。`orientationMask(isFullscreen:)` 恒为 `.allButUpsideDown`，App 不再锁方向。
- `beginDownload` 不再要求 `signedIn`；缺 `id` 时用 `dl-<uuid>` 补，不再静默丢弃。
- `beginBatchDownload` 改成 `signedIn != false`（网页不再带这个字段）。
- 新增 `playLocal`：离线播放走 `AVPlayerViewController` 全屏播本地文件（网站播放器放不了本地文件，这条只能原生做）。

### 其他

- `ios/project.yml`：`MARKETING_VERSION 0.1.19`、`CURRENT_PROJECT_VERSION 21`。
- `ios/Tests/*.test.mjs`：夹具换成新站的下载入口与集数网格；删掉只为已删控件存在的用例；
  新增「点站点下载入口打开下载页」「不再注入任何原生叠加控件」「点下载不再要登录」等用例。
- `ios/Tests/InjectedUITests.swift`：删掉 6 条只测已删控件的用例（沉浸态横屏、标准全屏规则、投屏一键外放、外放菜单、
  外放开关、全屏铺满）；保留下载、设置面板、我的下载这几条，点击目标改成站点自己的下载入口。
- `ios/UITests/Fixtures/site/player/index.html` 及两个内联夹具：补一个站点样式的下载按钮（`#ppDownload` + `data-pw-act=dl`）。

## 下载链路现在怎么走

1. 播放页点站点自己的下载入口（`[data-pw-act=dl]` 或「下载本集」）→ 注入层拦下，打开整页下载页。
2. 下载页每行 6 格列出这一部剧的所有集；点一格 = 只下这一集。
3. 注入层向 `/api/play?show=…&ep=…` 取真实片源并核对 `showId` / 集号 / `verified`；
   HLS 分片、blob、播放页地址一律拒绝并写明原因。
4. 通过后发一条 `downloadBatch` 给原生，原生队列并发 2、可后台、断点续传。
5. 原生 `progress` → 格子显示「下载中 N%」，进度条跟着走；`done` → 格子「已下载」。
6. 「查看下载列表」→「我的下载」按剧分组，顶部是正在下载的进度条 + 百分比 + 已收字节。
7. 点已下载的一集 → `playLocal` → 原生全屏播放器播本地文件。

## 验证

本机（Windows）跑过的：

```powershell
node --check ios/ZhuijuAI/AppBootstrap.js
node --test ios/Tests/*.test.mjs
```

结果：`node --check` 通过；Node 回归 **62 条全过**（日志：`C:\Users\kenzh\AppData\Local\Temp\ios-0.1.19-node-checks.log`）。

没做、也不该假装做过的：

- **Swift 没在本机编译**（Windows 上没有 Xcode）。改动是人工逐段核对的，编译错误只能等 macOS 上第一次构建暴露。
- **没跑 GitHub 云测试**（按规矩：出包前不在云端跑模拟器回归）。
- **没上真机**。下面这些只有真机能确认：
  1. 真实播放页的下载入口到底是 `[data-pw-act=dl]` 还是控制栏里的「下载本集」——两个都认，但只有真机能确认命中；
  2. 新站的集数网格是否仍是 `#epGrid .ep[data-ep]`（本地能看到的最新站点源码是这样，线上可能更新）；
  3. 网站播放器自己 `requestFullscreen` 在 WKWebView 里的实际表现，以及转屏后画面是否真的铺满；
  4. 原生下载的进度、后台续传、离线播放。

## 顺手删掉的功能（Ken 要知道）

这些都在注入层那套原生控件里，控件一删它们就没了：

- 倍速菜单（站点自己的控制栏没有倍速时，就没有倍速入口了）
- 「外放 / 用其他播放器播放 / 复制直链」这一组
- 沉浸态全屏（横屏自动铺满）——改由网站自己的全屏按钮负责
- 顶部悬浮条、画面档位下拉、全屏浮层按钮

如果后面还想要回其中某一项，正确做法是把它做进网站自己的控制栏（`src/player-ctrl.js`），
而不是再往 App 里加一层。