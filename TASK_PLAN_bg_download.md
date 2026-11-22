# 任务：iOS 切后台后 HLS 下载实际停住（build 27 → 28）

## 目标
Ken 真机（build 26/27）下载一部 m3u8 剧，切到别的 App 10 多分钟，回来进度几乎没动。
让 HLS 整集下载在 App 挂起/锁屏期间真正由系统继续传，回来后进度接上、对账一致、不重不漏。

## 范围
- `ios/ZhuijuAI/HLSDownloader.swift`（分片调度、后台会话配置、后台事件收尾、恢复对账）
- `ios/Tests/*`（新增本条的本地源码守卫测试；不改旧断言）
- `ios/REGRESSIONS.md`（加本条目，标「真机」）
- `ios/project.yml` + 打包工作流版本断言（build 号 +1）
- 不动：网页播放器、下载删除 UI 语义、其他任务分支

## 关键文件
- `HLSDownloader.swift`：`pump` / `startSegment` / `backgroundSession` / `adoptBackgroundEvents`
- `MediaDownloader.swift`：`launch`（mp4 直链）、`reconcile`
- `AppDelegate.swift`：`handleEventsForBackgroundURLSession`
- `AppBootstrap.js`：`resolveEpisodeUrl`（不受影响）

## 已证实的根因（源码 + 线上片源探测，非猜测）
1. **分片是串行派发的**：系统里任何时刻只有 ≤4 条分片任务（`pump` 按 `maxSegmentConcurrency - active` 算空位），
   下一片只能在**进程内**完成回调里发。App 挂起后没有代码发新片 → 队列里的 4 条传完就 0 在飞。
2. **后台事件收尾回调没归还**：`adoptBackgroundEvents` 只在 `systemTasks.isEmpty` 时才调
   `handleEventsForBackgroundURLSession` 的 completionHandler。HLS 一集有 400~1400 片，
   队列永远不空 → 系统收不到收尾，会停止为该会话唤醒/续跑 App。
3. `isDiscretionary` 两条会话都已是 `false`（用户疑虑 3 已排除）。
4. `foregroundSession` 只做清单/密钥，媒体分片走的是后台会话（用户疑虑 2 与源码不符）；
   但「plan 阶段被切后台」仍会停住，恢复前台能接上，属可接受边界。
5. 线上片源实测（18 家 36 条线路）：HLS v3 VOD，单集 401~1378 个 `.ts` 分片，
   `hongniu`/`jinying` 用 `AES-128`，其余多为 `METHOD=NONE`，无 `EXT-X-MAP`/`EXT-X-BYTERANGE`。

## 方案选择（方案二，用户已授权）
AVAssetDownloadURLSession（方案一）不采用，理由：
- 现有回归里有 15+ 条源码守卫测试钉住分片引擎（pump/retry/finalize/decrypt），规则不许删测试或改断言；
- `.movpkg` 只能 AVFoundation 播，而 App 的离线播放入口、外部播放器打开、左滑删除、相对路径都按单文件设计；
- 该 API 没有受支持的途径给每个分片请求注入本仓库必需的 Referer/UA（本仓库已有 CDN 403 的实证），
  AES-128 线路的密钥获取也不受我们控制。

方案二实现要点：解析后把**完整媒体计划**（全部分片）一次性投递给系统后台队列，
并发由 `httpMaximumConnectionsPerHost` 限制在 4，**不再**「一片完成才发下一片」；
正确归还后台事件 completionHandler；进程重启/重建会话后按系统任务 + 磁盘已落地分片对账。

## 已完成
- [x] 读 AGENTS.md / ios/REGRESSIONS.md / HLSDownloader / MediaDownloader / AppDelegate
- [x] 线上片源结构实测（见根因 5）
- [x] 写本次计划

- [x] 写复现测试 `ios/Tests/backgroundDownload.test.mjs`，在 build 27 代码上跑红（4 红 2 绿）
- [x] 实现方案二（全量入队 / 收尾回调归还 / 会话对账门 / 磁盘对账），本地全仓 132/132 绿
- [x] 更新 REGRESSIONS.md（REG-032，标真机）；build 27 → 28

## 剩余
- [ ] 送「审核开发」审阅
- [ ] 合并 main、打包 only、IPA 放桌面

## 下一步
送审（附需求、验收、分支、commit、验证输出）。真机四项验收等 Ken 装新包。
