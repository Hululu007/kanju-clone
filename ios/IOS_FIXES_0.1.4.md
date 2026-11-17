# 追剧AI iOS 0.1.4 改动记录（2026-11-17）

基线：`0.1.3` / build 4（commit `92ba5b8`）。本轮按真机反馈的五点改造，版本升到 **0.1.4 / build 5**，
UA 标记 `ZhuijuAI/0.1.4 iOS`。**未提交、未推送、未触发 CI、未打包、未安装到手机。**

## 1. 全屏键：从「够不到的左上角」搬到进度条右端

原来的问题不在我们能不能加按钮，而在 **iOS 原生 video 控件不可改布局**：进全屏后的退出键固定在左上角，
在握持姿势下是死角；而跳出去看站点自己的工具条，全屏键又落在第二行最左边。

做法：**页内自带一条控制栏**（`#ppCtrl`），顺序是

```
[播放/暂停] [00:00 / 00:00] [───── 进度条 ─────] [外放] [倍速] [全屏]
```

- 全屏按钮在进度条右端，倍速紧挨它左边（实测间距 6px，同一行）；
- 自带控制栏挂上之后才执行 `video.removeAttribute('controls')`，把原生控件收起来 —— 这样就不会有第二条
  控制栏叠在上面，也不再有左上角那个入口；
- 0.1.3 加在工具条里的 `#iosFullBtn` 已删除，另外补一条 `#iosFullBtn{display:none}` 兜底；
- 页面内全屏继续走 0.1.3 的沉浸层（`html[data-ios-immersive]` + 原生锁方向），横屏下控制栏贴在底部安全区之上；
- 额外把 `video.webkitEnterFullscreen` 改写到页内全屏，任何原生入口都统一到同一条路径。

## 2. 倍速：1 / 1.5 / 2 / 2.5 / 3

菜单就是这五档。选完立刻把 `video.playbackRate` **读回来**校验：

- 如果系统把倍速夹回去（iOS 对部分媒体链路只允许到 2×），按钮显示的是真实生效值，并提示
  「本机最高只支持 2×，3× 被系统夹回」—— 宁可说实话，也不假装已经 3×；
- 选择存进 `localStorage['kj-speed']`，和站点原有的记忆键一致，换集/重进页面都会恢复。

> 这一点只有真机能给结论：桌面 Chrome 不夹，模拟器跑的媒体也不是同一条链路。已按「读回真实值」处理，
> 若真机上 2.5×/3× 被夹，界面会明说，不会静默失效。

## 3. 用别的 App 播放（外放）

iOS 上的合法路径只有系统自己的能力，本轮按优先级串起来，**不引入任何第三方 SDK、不需要登录**：

1. **应用内原生分享**：网页 `postMessage({action:'share', url, title})` → `WebViewController` 用
   `UIActivityViewController` 弹系统分享面板。装了 VLC / Infuse / nPlayer / 迅雷等接受 URL 的 App 就会出现在面板里；
2. **系统分享（浏览器环境）**：`navigator.share({title, url})`；
3. **AirPlay**：`video.webkitShowPlaybackTargetPicker()`（iOS 原生外部播放通道）；
4. **兜底**：复制播放地址到剪贴板，并提示粘到播放器里。

**能力边界（明确写清，不虚称已支持）**：

- 只交出 **https 直链**。HLS/MSE 的 `blob:` 流、需要鉴权头或带签名时效的地址**不能**这样交出去，
  这时按钮会直接说「这条线路是加密或临时流，没法交给其他 App；换一条线路再试」；
- 不看 DRM：受保护内容任何外部播放器都打不开，我们也不做绕过；
- 分享面板里出现哪些 App 由系统决定，只与用户设备上已安装、且声明了接收 URL 的 App 有关；
- 外放后播控仍在原 App（除非目标 App 自己接管），进度回传取决于目标 App，我们不承诺同步。

## 4. 两处 Logo 换成用户提供的图

同一张图（用户附件，498×498 WebP）出现在两处：

| 位置 | 选择器 | 处理 |
| --- | --- | --- |
| 顶栏「追剧AI」左边 | `.brand .brand-mark` | 30×30 圆角 9px，背景图铺满，原 SVG `display:none` |
| 底栏中间的绿色分享键 | `.tabbar .tab.center .tab-circle` | 46×46 圆形，背景图铺满，原箭头 SVG `display:none` |

用 160×160 的 WebP（8.4 KB）以 **data URI 内联**：站点没部署新资源时，App 注入层也能立刻换掉旧 Logo。
图只内联**一次**——`html{--brand-logo:url("data:...")}` 一条自定义属性，两处规则都引用 `var(--brand-logo)`；
否则 8.4 KB 的图会被塞三遍（最初版本就是这样，`AppBootstrap.js` 一度涨到 80 KB，改完 44 KB）。
站点层同一套选择器，部署后表现一致。旧 Logo 的绿色投影 `filter` 已取消，避免和新图配色打架。

## 5. 两层一致性

| 能力 | 站点层 | App 注入层 |
| --- | --- | --- |
| 控制栏 | `src/player-ctrl.js` + `src/pages/player.js` 调用 | `ios/ZhuijuAI/AppBootstrap.js` 内同名实现 |
| 样式 | `src/styles.css` 末尾 `#ppCtrl` 段 | `iosShellStyle` 同段规则 |
| 品牌图 | 同一条 CSS（data URI） | 同一条 CSS（data URI） |
| 外放 | 系统分享 → AirPlay → 复制 | 先走原生 `UIActivityViewController` |

两层用**相同的 id / class**（`#ppCtrl`、`#ppPlay`、`#ppSeek`、`#ppCast`、`#ppRate`、`#ppFull`、`.pc-rate-opt`）：
注入层发现 `#ppCtrl` 已存在就不再重复挂载，所以站点部署新版之后不会出现两条控制栏。

## 6. 验证（全部输出在 `outputs-0.1.4/`）

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| `node --check` ×4 | 通过 | `node-check.log` |
| `node --test ios/Tests/bootstrap.test.mjs` | **35/35 通过**（新增 9 条） | `node-test.log` |
| `npx vite build` | 通过 | `vite-build.log` |
| 构建产物规则 12 条 | 全部命中 | `build-content-check.log` |
| 浏览器端到端（站点源码 / 部署版+注入层） | 22 项全过 | `browser-verification.log` |

新增回归测试：

- `fullscreen sits at the right end of the control bar and drives native rotation`
- `native fullscreen requests are rerouted to the in-page bar`
- `rate menu offers 2.5x and 3x and applies the chosen one`
- `a clamped playback rate is reported instead of pretending 3x works`
- `control bar follows playback position and seeking`
- `external playback hands the direct url to the native share sheet`
- `external playback refuses blob streams and says why`
- `external playback without the app bridge falls back to the system share sheet`
- `both brand logos use the supplied artwork and hide the old svg`（含「data URI 只内联一次」）
- Swift：`ShareTests.swift` — `shareableURL` 只认 https 直链，`http:`、`blob:`、`data:`、`file:`、无 host 一律 nil

浏览器实测（393×852 触屏模拟）：进度条 x=132、倍速 x=285、全屏 x=328（最右），三者同一行中心线 424；
控制栏落在视频区域内（y 403–445 / 视频 240–446）；`video.controls === false`；点 2.5× → `playbackRate 2.5`、
点 3× → `3`；两处 Logo 背景均为 `data:image/webp` 且原 SVG 为 `display:none`。横屏 844×390 沉浸态下控制栏
贴底（y=347，高 42），「退出全屏」在最右端。

截图：`shot-player-dev-ctrl.png`、`shot-player-dist-ctrl.png`、`shot-player-immersive-ctrl.png`、
`shot-home-dev-logo.png`、`shot-home-dist-logo.png`。

## 7. 本机无法验证的部分

- **Swift 编译与 XCTest**：这台机器是 Windows，没有 `xcodebuild`。本轮把地址校验抽成纯函数
  `WebViewController.shareableURL（https-only）` 并配了 `ShareTests.swift`，但仍需在 CI/macOS 上编译确认；
- **模拟器播放回归**：同上，未跑；
- **真机行为**：外放面板里到底列出哪些 App、iOS 是否夹 2.5×/3×、横屏沉浸下的安全区，都需真机确认；
- **站点部署**：站点层改动未部署，App 端表现全部由注入层提供。
