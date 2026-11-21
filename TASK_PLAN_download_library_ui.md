# iOS 原生「我的下载」任务计划

## 目标
在设置面板最上方提供原生离线「我的下载」入口，飞行模式无需远端网页加载即可按剧查看全库、离线播放及将已完成单文件分享给其他 App。

## 范围与边界
- 只实现 UI、设置入口、列表聚合、磁盘占用/可用空间展示、本地播放/分享调用。
- 不实现第二份下载持久化；以开发一的原生下载记录快照和通知为唯一数据源。
- 不改 MediaDownloader、HLSDownloader、下载文件命名/目录、后台引擎或 Info.plist。
- 下载进行中的集置顶并呈现进度；仅已完成且存在的下载文件可离线播放和分享。
- 分享仅单个真实下载文件 URL；不传远端 URL、HLS 清单、目录、未完成文件。iPad 提供 popover 锚点；失败/准备状态明确反馈。
- 一级按剧聚合并展示已完成集数与剧占用空间；二级按集列出；仅左滑删除，一级删整剧、二级删单集。
- 用户指定免新增/运行测试、免云端/模拟器/UI smoke；必要时可做受 memcap 限制的本地编译，但 Windows 无 Xcode。

## 文件所有权
- 本分支 `ios/ZhuijuAI/DownloadLibraryViewController.swift`：开发二独占新增原生列表 UI。
- 计划与续接状态：`TASK_PLAN_download_library_ui.md`、`current_task_download_library_ui.md`。
- `WebViewController.swift` 是原生面板入口和下载器桥接的合理位置，待开发一确认编辑边界；不要让两人同时修改。
- `MediaDownloader.swift` / `HLSDownloader.swift`：仅开发一修改；若快照缺少文件 URL、节目元信息或批量删除 API，由开发一实现并告知接口。

## 进度
- 已定位仓库：`C:\Users\kenzh\Documents\deepseek-harness\default-workspace\kanju-clone`。
- 独立工作树：`C:\Users\kenzh\AppData\Local\Temp\kj-native-ui`，分支 `feature/ios-native-library-ui`，基于 `00d1553`（方案二后台下载实现）。
- 已确认现分支还没有 `DownloadLibrary.swift`；`MediaDownloader.snapshotForPage()` 暴露快照，包含状态、showId、集号、标题、文件相对路径和 size。当前 AppBootstrap.js 有在线下载片库，但依赖网页运行，不满足断网需求。
- 已读 `ios/REGRESSIONS.md` 与 `TASK_PLAN_bg_download.md`；此任务明确免测试，不新增回归条目。
- 2026-11-21：指挥把开发二这条线并入开发一，开发二无新增业务代码/commit，只剩这份计划文件。
- 已完成（build 29，分支 `feature/ios-native-library-ui`）：
  `ios/ZhuijuAI/DownloadLibraryViewController.swift`（一级按剧 / 二级按集 / 左滑删除 / 长按分享 / 占用与剩余空间）、
  `WebViewController` 的 `myDownloads` 动作与断网页离线入口、`AppBootstrap.js` 设置面板最上方的原生入口、
  build 28→29 与出包断言、REGRESSIONS.md REG-033。
- Node 全量 139/139 通过；Swift 编译由 packaging-only 工作流验证；真机验收项见 REG-033。
