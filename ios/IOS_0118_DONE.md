
# 追剧AI iOS build24 下载修复（审核后返工稿）

分支：`fix/ios-0.1.19-build24-downloads`
提交：`21f88224d3e6cc5f31857b712d1bc185b57d3784`（分支 `fix/ios-0.1.19-build24-downloads`，未合 main、未出包）

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

**真机待办**：等 build24 桌面包生成、Ken 安装并确认后，才由 Lead 派手机测试；测试前先核对 build 24。当前没有真机证据，不说“修好了”。
