
# 追剧AI iOS build24 下载修复（审核前工作稿）

分支：`fix/ios-0.1.19-build24-downloads`
提交：待提交

这份只说 build24 的下载修复。全屏和首页齿轮保持 build23 原样，本轮没碰。

## 三处根因（大白话）

1. **下载状态有两本账**：原生 App 有一份持久下载记录，网页自己又存了一份。点下载后页面有时刻只看网页这本账，所以不会马上出现；删除时只删了网页那本账，原生那本还在，重启又把它写回来，看起来像“删了又活”。
2. **删除没有墓碑**：旧任务晚到的完成回调、重启后的旧快照，都不知道这一集已经被用户删了，于是又把“已完成”写回片库。
3. **点集后要等解析才显示**：原来要先解析到真实视频地址才把这一集放进下载页，解析期间下载页看起来没有反应。

## 这次改了什么

- 下载队列改为**原生记录唯一说了算**；网页不再把旧 `kj-ios-queue` 缓存当事实源，启动时清掉旧缓存。
- 点某一集后，网页先在内存里放一条“排队中”，下载页和“我的下载”马上能看到；原生快照随后覆盖成真实进度。
- 左滑删除现在会走新 `deleteDownload`：原生取消任务、写删除墓碑、按完整路径边界把 `Documents/Downloads` 里的真实文件移到回收目录，并立刻回传快照；网页也写墓碑，旧 done/旧快照都进不来。
- 删除后如果用户主动重新下载同一集，会清掉墓碑并用新任务 id 建记录；老任务晚到的回调匹配不到新记录，不会把新任务弄乱。

## 改了哪些文件

- `ios/ZhuijuAI/AppBootstrap.js`：网页唯一数据源、乐观入队、墓碑与删除桥接。
- `ios/ZhuijuAI/MediaDownloader.swift`：原生墓碑、删除记录、删除文件、晚回调过滤、重下用新 id。
- `ios/ZhuijuAI/WebViewController.swift`：接 `deleteDownload`，删记录与文件后立即回传快照。
- `ios/Tests/bootstrap.test.mjs` / `downloadQueue.test.mjs` / `nativeSource.test.mjs`：下载队列、删除复活、原生源码守卫回归。
- `ios/REGRESSIONS.md`：新增 REG-026。

## 本地验证

- `node --check ios/ZhuijuAI/AppBootstrap.js`：通过
- `node --test ios/Tests/*.test.mjs`：85/85 通过
- `git diff --check`：通过
- 完整日志：`C:\Users\kenzh\AppData\Local\Temp\build24-logs\local-checks.log`
- Windows 本机无 Xcode，Swift 没有本地编译；只做了源码守卫测试。

## 回归逐条结论

- A 下载：本地已过“单集立即列表 + 进度、完成、删除后重启不现、已下载显示系统打开方式入口”；真机未测。
- B 全屏：本轮未改，build23 代码保持；真机未测。
- C 首页无齿轮 / 仅网站播放器：本轮未改，本地相关回归通过；真机未测。
- D 账号组与已删入口：本轮未改，本地相关回归通过。

**真机待办**：等 build24 桌面包生成、Ken 安装并确认后，才由 Lead 派手机测试；测试前先核对 build 24。当前没有真机证据，不说“修好了”。
