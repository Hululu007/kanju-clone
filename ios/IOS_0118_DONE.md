
# 追剧AI iOS build24 下载修复（已出包，待真机）

分支：`fix/ios-0.1.19-build24-downloads`
提交：代码修复 `21f8822`（审核通过），打包提交 `01014b5`（main）

这份只说 build24 的下载修复。全屏和首页齿轮保持 build23 原样，本轮没碰。

## 三处根因（大白话）

1. **下载状态有两本账**：原生 App 有一份持久下载记录，网页自己又存了一份。点下载后页面有时刻只看网页这本账，所以不会马上出现；删除时只删了网页那本账，原生那本还在，重启又把它写回来，看起来像“删了又活”。
2. **删除没有墓碑**：旧任务晚到的完成回调、重启后的旧快照，都不知道这一集已经被用户删了，于是又把“已完成”写回片库。
3. **点集后要等解析才显示**：原来要先解析到真实视频地址才把这一集放进下载页，解析期间下载页看起来没有反应。

## 这次改了什么

- 下载队列改为**原生记录唯一说了算**；网页不再把旧 `kj-ios-queue` 缓存当事实源，启动时清掉旧缓存。
- 点某一集后，网页先在内存里放一条“排队中”，下载页和“我的下载”马上能看到；原生快照随后覆盖成真实进度。
- 左滑删除走 `deleteDownload`：原生**先真删** `Documents/Downloads` 里这一个文件（不再挪进 `.trash`），删成功才取消任务、写墓碑、清记录；删不掉就保留记录、回传失败原因，网页把这一行放回列表并提示失败。
- 墓碑改成独立持久存储（`kj-ios-download-tombstones-v1`）：不再靠下载记录里的 `deletedAt`，记录被 400 条上限裁掉也不会让已删的集被旧快照、晚到回调带回来；旧的一删一键墓碑会迁移过来，保留最近 2000 条。
- 主动重下同一集时明确清掉对应墓碑，并用新任务 id 建记录；老任务晚到的回调匹配不到新记录，不会把新任务弄乱。

## 复审修复（审核不通过的两条）

1. **删除不是真删**：旧实现把文件挪进 `Documents/Downloads/.trash`，看着删了其实还占空间。
   现在 `removeDownloadedFile` 只认下载目录里的直接子文件，用 `removeItem` 真删；
   路径越界、目标是目录、删除失败都返回失败。网页删除改成“先删文件，删成功才取消任务、
   写墓碑、清记录”，失败时把这一行放回列表并提示原因，不假装成功。
2. **墓碑会随记录裁掉**：旧实现只从 `kj-ios-download-tasks` 记录里读墓碑，记录被 400 条上限裁掉后
   屏障就没了。现在墓碑单独一个持久键（`kj-ios-download-tombstones-v1`），首次读取会把旧的“一删一键”
   墓碑和记录里的 `deletedAt` 一起迁移进来，保留最近 2000 条；入队清理旧记录时不再顺手删墓碑。


## 改了哪些文件

- `ios/ZhuijuAI/AppBootstrap.js`：网页唯一数据源、乐观入队、墓碑与删除桥接。
- `ios/ZhuijuAI/MediaDownloader.swift`：原生墓碑、删除记录、删除文件、晚回调过滤、重下用新 id。
- `ios/ZhuijuAI/WebViewController.swift`：接 `deleteDownload`，删记录与文件后立即回传快照。
- `ios/Tests/bootstrap.test.mjs` / `downloadQueue.test.mjs` / `nativeSource.test.mjs`：下载队列、删除复活、删除失败回滚、真删文件与墓碑持久化的回归与源码守卫。
- `ios/REGRESSIONS.md`：新增 REG-026。

## 本地验证

- `node --check ios/ZhuijuAI/AppBootstrap.js`：通过
- `node --test ios/Tests/*.test.mjs`：89/89 通过
- `git diff --check`：通过
- 完整日志：`C:\Users\kenzh\AppData\Local\Temp\build24-logs\review-fix.log`（审核后修复这一轮）、`...\local-checks.log`（上一轮）
- Windows 本机无 Xcode，Swift 没有本地编译；只做了源码守卫测试。

## 回归逐条结论

- A 下载：本地已过“单集立即列表 + 进度、完成、删除后重启不现、已下载显示系统打开方式入口”；真机未测。
- B 全屏：本轮未改，build23 代码保持；真机未测。
- C 首页无齿轮 / 仅网站播放器：本轮未改，本地相关回归通过；真机未测。
- D 账号组与已删入口：本轮未改，本地相关回归通过。

## 出包记录（build24，只打包不跑云端测试）

- 打包提交（工作流实际 checkout SHA）：`01014b52580f57a589f2770ab6b2fe08a2841f61`
- 工作流：`.github/workflows/ios-ipa-only.yml`（packaging-only），run id `44695952484`，结论 success
- 产物（仓库工作流内名）：`ZhuijuAI-0.1.19-build24-unsigned.ipa`
- 桌面副本：`C:\Users\kenzh\Desktop\ZhuijuAI-0.1.18-build24-unsigned.ipa`（按 Ken 指定文件名）
- 包内版本：`CFBundleShortVersionString=0.1.19`、`CFBundleVersion=24`、`CFBundleIdentifier=org.dpdns.zhuiju.ios`、`MinimumOSVersion=15.0`
- 大小：4,424,784 字节；zip 完整性 testzip=ok（12 项）
- SHA256（源产物与桌面副本复算一致）：`33362f2be56bf4306fc9b41d33e684df461ce74d6b133066abd504550091be34`
- 审核：21f8822 通过（复核 d2e22ae）；本地 Node 89/89 通过；日志见 `C:\Users\kenzh\AppData\Local\Temp\build24-logs\review-fix.log` 与 `ipa-verify-44695952484.log`
- 推 main 触发的旧测试工作流（Build unsigned iOS IPA，run 44695872098）已按规则先后发起 cancel / force-cancel，未修改或禁用任何 workflow。

## 出包前清单 A-D（源码证据，真机未测）

- A 下载：本轮唯一改动面（MediaDownloader.swift / WebViewController.swift / AppBootstrap.js 下载段 + 测试 + 版本号）。本地 Node 覆盖：单集点击立刻出现在列表、进度百分比、完成入库、删除后重启/旧快照不复活、已完成行带外部播放入口。真机未测。
- B 全屏：`git diff c2b688a..01014b5` 没有改全屏相关代码（WKWebView 全屏状态机、方向处理保持 build23 审核通过版本）。真机未测。
- C 首页无齿轮 / 仅网站播放器：同一 diff 没有改首页顶栏、播放器注入层或原生叠加控件；相关 Node 断言仍全过。真机未测。
- D 账号组与菜单：同一 diff 没有改账号/设置菜单，也没有加回讨论、反馈、等级、P2P、内容偏好、我的用量、全部下载。真机未测。

**真机待办**：等 build24 桌面包生成、Ken 安装并确认后，才由 Lead 派手机测试；测试前先核对 build 24。当前没有真机证据，不说“修好了”。
