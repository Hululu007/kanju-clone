# iOS 0.1.1 审查记录

## 已发现与修复

1. 网页在存在 MediaSource 时直接使用 hls.js，未判断苹果系统原生 HLS 能力。iOS 新增 NativeHls 适配，优先系统媒体链路，保留内置 hls.js 供其它能力分支使用。
2. 旧网页在异步 HLS attach 完成之前调用 play，拒绝后没有再次启动。包内在已验证媒体的 loadedmetadata/canplay 时补一次启动，失败时要求点击播放器；不会自动播放后台页面。
3. 旧请求可能在快速选集或切线后返回。包内记录选择代数、取消旧请求，并在响应体解析后再次验证当前选择，拒绝过期响应。
4. 客户端缺乏与 TV 一样严格的片源核验。新版校验 showId、idx、verified、可解析的集数、HTTPS、媒体类型和地址中无账号密码。
5. 网站访问门和账号鉴权都可能返回 401。新版识别访问门 unauthorized 后回到访问密码页，不把该响应交给账号清除缓存的分支。
6. 网页画中画仅调用标准 API，未支持苹果 presentation mode。新版补齐 WebKit 入口。
7. 横屏只有声明方向、没有播放器展开样式。新版在播放状态和横屏条件下展开播放器并保留线路和设置。
8. 首页 Array.at 在较旧系统可能不存在，已补兼容。网页模块还使用顶层 await，因此最低系统版本改成 iOS 15，避免 iOS 14 安装后网页模块不能运行。
9. 限制主框架导航在自有 HTTPS 域名，禁止任意 data/blob 主文档。站外链接仅在链接点击时交给系统，关闭无手势自动弹窗。未放宽 TLS 校验。

## 已通过的验证

- 本地 Node 回归 10 项通过：保留登录请求、Bearer 与请求体、同域 Cookie、访问门和账号过期区分、错误片源拒绝、过期请求拒绝、调用方取消、媒体就绪重试、后台状态、存储失败、外站隔离。
- 云端同一组 Node 回归通过。
- 使用 iPhone User-Agent 对线上《尚公主》第 19 集抽测：showId、idx=18、episodeNumber=19、verified=true 一致；媒体返回 HTTP 206、video/mp4；本机 FFmpeg 解出六帧。
- 上述取源与 PC 解码不等于 iPhone 真机播放成功，也不能证明所有线路均可用。

## 尚未完成

- 新增的七项 XCTest/WKWebView 模拟器回归尚未全部通过。早期运行存在测试 API 版本声明、JavaScript 返回类型错误和宿主异常退出；已修正测试声明与返回值，最后观察的运行仍停在模拟器测试步骤。
- 为整个 JavaScript 异步测试增加 15 秒 Promise.race 超时，避免媒体 play() 不结束导致无限等待。此最后修改与失败诊断导出工作流尚未重新推送执行。
- 当前不能宣称新版已通过 iOS 播放验收，不交付或覆盖桌面旧包。
- 没有连接 iPhone；实体设备硬件解码、AirPlay、画中画、横屏操作、真实账号端到端登录和家庭网络未验收。
- 本次修复只修改 ios/ 与 iOS 构建工作流，未发布网页、API 或数据库。

## 后续入口

- 最近已推送提交：a3e1a770512d2e1974de1e1b15cd2579d238bb33。
- 最近观察运行：https://github.com/kenzhao11/kanju-clone/actions/runs/43702714568
- 本地待推送：Tests/PlaybackTests.swift 中异步超时、工作流中的诊断导出、本报告。
- 先读取最新运行结果及 xcresult 诊断，再仅针对失败项修复；全套通过后生成并核验新版 IPA。
- 修改前备份位于 Codex 工作区 outputs/ios-0.1.0-before-review.zip。
