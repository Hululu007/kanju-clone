# 0.1.5 真机反馈修复说明

基线：0.1.4（build 5）。本版 0.1.5 / build 6。

三条真机反馈，逐条记清「改了什么、为什么这样改、哪些还没证明」。

---

## 1. 全屏时右侧那排按钮盖住画面

### 现象

真机截图：横屏全屏下，画面右上角悬着一排「显示设置 / 线路 / 弹幕 / 画中画 / 下一集」，正好压在字幕和前几行画面上，观影基本没法看。

### 根因

这排按钮就是站点的 `#playTools`（`src/pages/player.js:118`）。0.1.3 为了让它们在沉浸态里有个位置，注入层把它们**固定到了右上角**：

```
html[data-ios-immersive] #playTools{position:fixed;top:...;right:12px;...}
```

也就是说，这排按钮出现在画面里不是意外，是当时刻意钉上去的——钉错了位置。沉浸态本来只需要底部控制栏。

### 改法

- 沉浸态下 `#playTools`、`#settingsPanel`、`#lineBar` 一律 `display:none`，不进画面；
- 进入全屏时顺手把面板的 `hidden` 状态置回关闭，退出全屏不会突然弹出一个旧面板；
- 底部控制栏在沉浸态提高层级（`z-index:10003`）、加大行高（按钮 `min-height:42px`、进度条 30px 高），底部内边距用 `env(safe-area-inset-bottom)`，Home 条和小白条区域也能点到；
- 跳过片头/片尾按钮上移到 `58px + safe-area`，不再和控制栏叠；
- 全屏里保留的正是用户点名的五项：**播放 · 进度（含时间）· 外放 · 倍速 · 退出全屏**。

两层一致：注入层 `AppBootstrap.js` 与站点层 `src/styles.css` 用同一批选择器；站点层 `player.js` 的 `onFullscreen` 回调也把面板收起。

---

## 2. 外放：分享面板里没有 SenPlayer

### 先查清事实

- 仓库里没有任何 SenPlayer/第三方播放器的既有适配（`grep -ri senplayer` 零命中），**没有可复用的既有能力**。
- 想给 SenPlayer 直接发 URL scheme，必须拿到它公开的 scheme。本轮在本机尝试检索其公开文档失败（搜索通道返回挑战页/302，拿不到可引用的一手文档）。
- 因此**没有实现任何第三方 URL scheme**，也没有把「支持 SenPlayer」写进任何文案——猜一个 scheme 写进去，结果只会是点了没反应。

### 真正的机制（决定了谁能出现在面板里）

`UIActivityViewController` 里出现哪些 App，由系统按「谁能处理这个 item 的类型」筛：

- 我们交出去的是 **`public.url`**（一条 https 地址）。只有实现了**分享扩展**并声明接受 URL 的 App 才会出现。
- 只声明了视频文件类型（`public.movie` / `public.mpeg-4`）的播放器，**不会**因为一条 URL 就出现——它等的是文件。

所以「URL 直接唤起某个播放器」不是 iOS 的合法通用能力，任何声称能做到的实现，要么依赖该 App 私有的 scheme，要么在骗人。

### 改法

「外放」现在弹一个菜单，三件事分开做，不再一个按钮硬猜：

| 行 | 做什么 | 边界 |
| --- | --- | --- |
| 分享播放地址 | 原生 `UIActivityViewController`，item 是标准 `NSURL`，并带 `LPLinkMetadata`（`originalURL` / `title`），面板认得出这是媒体链接而不只是一段文本 | 只接受 https 直链；`blob:`、MSE 加密流、HLS 清单、页面地址一律拒绝并说明原因 |
| 复制播放地址 | `navigator.clipboard.writeText`，粘到任何播放器里都能用 | 同上；没有直链时说「还没解析出直链」 |
| 下载本集 | 见第 3 节；下载完出现第四行「用其他播放器打开」 | 需登录 |

第四行是本轮真正解决「SenPlayer 看不到」的地方：它把**本地文件**交给系统（`UIActivityViewController` + 文件 URL，UTI 由扩展名推断为 `public.mpeg-4`）。声明了视频文档类型的播放器——SenPlayer、VLC、Infuse、nPlayer 这类——在这条路径上才会出现。这是 iOS 允许的、唯一不猜私有 scheme 的做法。

想让它更省事，用户可以在面板里选「存储到文件」，之后从播放器自己的文件列表打开。

### 说清楚没做到的

- **不能**强制让某个指定 App 出现在面板里；面板内容由系统决定，我方只决定交出去的是什么类型。
- **没有**验证 SenPlayer 到底是否实现了分享扩展。真机上它出不出现，取决于它自己的注册情况；本轮没有在真机上看到过，因此不作承诺。

---

## 3. 下载：登录门控 + 单任务 + 明确的失败原因

### 门控

- 判断依据是站点自己的账号 token（`localStorage['kj-auth-token']`），注入层与站点同源，读的是同一份，不另做一套账号体系。
- 未登录点「下载本集」：只弹「登录后才能下载本集」，并顺手打开站点自己的登录弹窗；**不发任何网络请求**（回归测试断言 `fetch` 调用数为 0、原生桥消息数为 0）。
- 原生层（`WebViewController.beginDownload`）再核一次 `signedIn == true`，收到匿名下载请求直接丢弃——门控不靠单层。

### 传输

- 地址只取当前正在播的 https 直链；`blob:`/MSE、`data:`、HLS 清单（`.m3u8`）分别给出不同理由，不假装能下。
- **一次只下一集**：新任务先取消旧的，没有队列、没有批量抓取、没有后台遍历。`MediaDownloader` 里 `URLSessionConfiguration.timeoutIntervalForRequest = 30`，不会挂着一个任务无限期占着网络。
- 传输在原生层做（`URLSession` 下载任务），不像网页那样把整集读进内存再 `Blob`。
- 落盘到沙盒 `Documents/Downloads/<名字>`，文件名经过清洗（路径分隔符、控制字符换掉，补视频扩展名），不越出沙盒。

### 反馈

- 下载中：控制栏的「外放」按钮变成「下载 43%」，菜单里该行显示百分比；
- 再点一次同一行 = 取消，回「已取消下载」；
- 失败：HTTP 状态、网络错误、写盘错误各给一句人话（`片源服务器返回 403`、`网络中断`…），按钮回到可用状态；
- 完成：提示「已下载 名字（xx MB）」，菜单出现「用其他播放器打开」。
- 进度回传用 `window.__zhuijuDownload`，按任务 id 过滤：换集之后旧任务的消息不会改乱新状态（有回归测试）。

### 站点层的等价实现

站点层（`src/player-ctrl.js`）用 `fetch` + `ReadableStream` 累计进度，最后 `Blob` + `<a download>` 存盘，同样登录门控、同样拒绝 m3u8/blob、同样可取消。已知差异：片源服务器不带 CORS 头时网页端 `fetch` 会失败，此时如实提示「片源服务器不允许网页直接下载，请在 App 内下载这一集」——App 走原生网络栈，没有这个限制。

---

## 4. 顺手修掉的一个真问题

浏览器验证时发现：站点还没解析出直链时，`<video><source src=""></video>` 里的空 `src` 会被浏览器解析成**当前页面地址**，原来的 `mediaUrl()` 于是把 `https://zhuiju.dpdns.org/player/?id=...` 当成片源，复制/分享出去的是一条网页地址。

改法：`<source>` 读原始属性（`getAttribute('src')`）而不是解析后的 `.src`，再把「等于当前页面地址」的情况挡掉；同时把「还没有地址」和「地址不可加密流」分成两种提示。两层都改了，回归测试各一条。

---

## 5. 两层一致性

| 能力 | 站点层 | 注入层（App 内实际生效） |
| --- | --- | --- |
| 全屏收起上方工具条 | `src/styles.css` + `player.js` 回调 | `AppBootstrap.js` 注入样式 + `applyImmersive()` |
| 控制栏本体 | `src/player-ctrl.js` | `AppBootstrap.js`（同 id/class，站点层已挂则跳过） |
| 外放菜单 | `#ppCastMenu` / `ppShareLink` / `ppCopyLink` / `ppDownload` / `ppOpenLocal` | 同名同结构 |
| 下载 | 网页 `fetch` + `<a download>` | 原生 `URLSession`（`MediaDownloader`） |
| 登录门控 | `localStorage['kj-auth-token']` | 同上（同源同一份） |

App 注入层仍是真机上的生效层：站点没部署前，`src/` 的改动不会自动到手机上，但注入层已经带了全部三条修复。

---

## 6. 回归

- `node --test ios/Tests/bootstrap.test.mjs`：**46 项全过**（新增 11 项：全屏收起面板、外放菜单四行、复制直链、未登录不下发、登录后下发、进度/完成回传、取消与失败、拒绝 HLS、拒绝 blob、旧任务消息不串台、页面地址不当片源 ×2）。
- XCTest：`PlaybackTests` 7 项 + `ShareTests` 2 项 + 新增 `DownloadTests` 5 项（文件名清洗、m3u8 不冒充视频、沙盒目录）。
- 构建产物核对 22 条规则（CSS/JS 双份都命中）。
- 浏览器端到端（站点源码 + 已部署构建 + 注入层）：52 项全过，含横屏沉浸态截图。

---

## 6b. CI 结果（2026-11-17）

- 提交：`c0b91ab`（0.1.5 主体）+ `82286b7`（文件名规则修正）
- 运行：run **44037471793**，workflow「Build unsigned iOS IPA」，branch main，**success**
- CI 内 Node 回归：**46 项全过**
- CI 内 XCTest：**14 项 0 失败**，21.646 秒（PlaybackTests 7 + ShareTests 2 + DownloadTests 5）
- 首轮 run **44036102454 失败**，失败点是我自己写的断言：
  `fileName("https://media.example/", "")` 产出 `".mp4"`（隐藏文件），
  以及 `.../play/19` 会把网页算好的集名丢掉变成 `19.mp4`。
  改法：只有当 URL 末段真的带视频扩展名时才采用它，否则保留网页给的集名；
  只剩扩展名时退回 `video.mp4`。第二轮通过。
  - 失败日志：`outputs-0.1.5/ci-run-44036102454-failed.log`
- 产物：`ZhuijuAI-unsigned-ipa`（4,322,375 字节）
  - 包内核对：`0.1.5` / build `6` / MinimumOSVersion 15.0 / `org.dpdns.zhuiju.ios`
  - 包内 `AppBootstrap.js` 53,531 字节，含全屏收起工具条规则、外放菜单、复制地址、下载入口、
    `kj-auth-token` 门控、页面地址拦截
  - **SHA-256 `475a6d251d34aaedec2d8b8246a54390283d7214f70a9cf755cd0ca5e79c92c4`**
    （CI 的 `.sha256` 与本地重算一致）

## 7. 本机无法验证 / 不声称已验证

1. **原生分享面板里到底列出哪些 App**——取决于机子装了哪些 App 及其注册方式；WebView 里的 `navigator.share` 与原生 `UIActivityViewController` 的真实列表都没有在真机上看过。
2. **SenPlayer 是否出现**：未验证，也未适配其私有 scheme。
3. **下载的真实传输**：进度、取消、落盘、`Documents` 里的文件能否被其他 App 打开，都需要真机；本机只能保证编译通过（CI）与纯逻辑单测。
4. **倍速是否被 iOS 夹回**：0.1.4 遗留问题，本轮未复测。
5. **横屏沉浸态的安全区**：只有 Chrome 模拟，`env(safe-area-inset-bottom)` 在真机刘海/Home 条上的实际值未验证。
6. **整集播完是否黑屏**：0.1.3 遗留的间歇问题，本轮未触碰，也未声称修复。
