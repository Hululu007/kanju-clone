# 0.1.14 下载队列专题交接（fix/ios-0.1.14-downloads）

这条分支只负责**下载**：选集批量下载、统一持久队列（并发 2）、整部剧进度/暂停/继续/取消、
去重与后台恢复、失败隔离、真实剧名（REG-009 四出口）。画面模式（适应/裁剪/拉伸）与
XCUITest 截图通道归开发2，不在本分支。

## 文件归属

| 文件 | 本分支 | 说明 |
| --- | --- | --- |
| `ios/ZhuijuAI/MediaDownloader.swift` | 改 | 单槽 → 持久队列 |
| `ios/ZhuijuAI/WebViewController.swift` | 改 | batch/pause/resume/cancel 桥接、队列快照、DEBUG 测试入口 |
| `ios/ZhuijuAI/AppBootstrap.js` | 改（仅下载相关） | 批量条、逐集解析、队列面板、队列快照接收 |
| `ios/Tests/DownloadQueueTests.swift` | 新增 | 队列纯逻辑 + 落盘状态机（10 条） |
| `ios/Tests/downloadQueue.test.mjs` | 新增 | 批量下载/队列面板 Node 夹具（6 条） |
| `ios/DOWNLOAD_QUEUE_0.1.14.md` | 新增 | 本文件（含 REG-010 正式文本） |
| `ios/REGRESSIONS.md` | **未改** | 集成时把下面 REG-010 整段并入 |
| `ios/Tests/InjectedUITests.swift` | **未改** | 批量条的真 WKWebView 用例建议集成时并入 |
| `ios/project.yml` / `.github/workflows/*` | **未改** | 截图通道归开发2 |

## 与开发2的重叠与集成

- `AppBootstrap.js`：本分支只改下载/选集/剧名相关函数（`BATCH_STORE` / `queueTasks` /
  `resolveEpisodeUrl` / `startBatch` / `batchActionOf` / `libraryItem` 的队列区）。
  画面模式（`FIT_STORE` / `applyFit` / `ppFit` / `data-ios-fit` CSS）**已从本分支移除**，归开发2。
- `WebViewController.swift`：包含两处 **DEBUG 测试入口**作为候选实现，集成时二选一，不双改：
  1. `Site.testHome`（`KJ_TEST_HOME_URL` 环境变量覆盖起始地址，仅 `#if DEBUG`）；
  2. `shareableURL` 对回环 http 的放行（仅测试构建、仅 `127.0.0.1/localhost/::1`、且必须是视频扩展名）。
  `AppBootstrap.js` 顶部的 `window.__zhuijuTestOrigin` 守卫与之配套（同样只在原生注入时成立）。
- 旧测试断言：若集成时把 `ppFit` 放进控制栏，`bootstrap.test.mjs` 里
  `fullscreen sits at the right end of the control bar...` 的按钮顺序断言需要加上 `ppFit`
  （需求理由：新增画面适配键；不是为凑绿放宽断言）。本分支不改这条。

## 队列规则（实现即契约）

- 并发上限 `MediaDownloader.maxConcurrent = 2`；`planStarts` 只挑最早的排队任务。
- 去重键 `showId + epKey`：排队/下载/暂停时拒绝重复入队；完成/失败/取消过的集可以重下。
- 状态 `queued/running/paused/done/failed/cancelled` 全部落 `kj-ios-download-tasks`（保留最近 400 条）。
- 暂停：`cancel(byProducingResumeData:)` 落真实 resumeData，继续时 `downloadTask(withResumeData:)`；
  拿不到 resumeData 就从 0 重来并重置进度（不谎报）。
- 取消：只停任务、只改状态，**不删除已下载文件**；取消的任务不带完成路径。
- 重启：`reconcile` 把系统里已不存在的 running 标「下载被系统中断」，并把 queued 重新调度。
- 整部剧进度：`summary` 区分 `finished`（没有排队/在跑）与 `allDone`（还要没有失败/取消）；
  总字节未知时 `knownBytes=false`，网页只写「已收 X MB」，不造百分比。
- 支持范围：https 的 mp4/m4v/mov/mkv/ts；HLS(.m3u8)、播放页路由、其它扩展名如实拒绝并留 failed 记录。
  回环 http 只在 DEBUG 测试构建放行（受控源），Release 永远只收 https。
- 网页逐集解析：`/api/play?show=&ep=&line=`，核对 `showId/idx/verified/kind`，播放页 URL 与 m3u8 不入队。
- 原位「下载本集」入口保持不变（REG-008 不回退），与批量共用同一条队列。

## 验证

```
node --test ios/Tests/downloadQueue.test.mjs      # 6 条批量/队列夹具
```

CI 全量（XCTest + Node）见分支最新 run，详细结果与失败日志路径见交接回报。


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
