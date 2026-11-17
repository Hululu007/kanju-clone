# 追剧AI iOS 0.1.3 — 真机回归后的第二轮修复

真机两轮取证跑的都是 **0.1.1 的 IPA**（本机只有 `追剧AI-iOS-0.1.1-未签名.ipa`，0.1.2/0.1.3 从未产出可安装包）。
所以真机看到的问题要么是 0.1.1 本身的行为，要么需要 0.1.2/0.1.3 的源码落地才能消失。

版本号 0.1.3 (build 4)，UA `ZhuijuAI/0.1.3 iOS` —— 真机装完一眼可验。

## 一、三个 P1

| 真机现象（0.1.1） | 根因 | 状态 |
| --- | --- | --- |
| 搜「今天是太阳雨」得到 24 部无关热度榜 | `proxyList()` 签名里没有 `q`，关键词被丢掉；`BROWSE_PAGE = 24` 与真机「24 部」一致 | 站点已补 `q`，注入层补 `q` + `?q=` 兜底 |
| 控制栏/设置里没有全屏按钮 | 站点没有全屏入口；0.1.1 的沉浸样式只在横屏媒体查询里生效 | 注入层插「全屏」+ 页面级沉浸 + 原生锁横屏 |
| 白色主题底栏文字几乎看不见 | `.tabbar .tab{color:rgba(255,255,255,.62)}` 在白底上失效 | 站点与注入层都补了浅色主题文字色 |

## 二、真机第二轮取证后的判定（本轮修改以此为准）

### 1. 「第17集文字异常加粗」= 触屏粘住的 `:hover`，已修

真机截图里选集第 17 集文字发黑、看着比邻集粗。像素级测量（`zhaoju_0111_episodes_after.png`，背景/字色/墨量）：

| 位置 | 背景灰度 | 文字最暗 | 墨量占比 |
| --- | --- | --- | --- |
| 第1集（真正的当前集 `.on`） | 238 | 101 | 0.0665 |
| **第17集** | **237** | **16** | 0.0395 |
| 第18集 | 255 | 95 | 0.0438 |
| 第19集 | 255 | 95 | 0.0437 |

第17集的墨量**低于**邻集（0.0395 < 0.0438），说明它没有加粗；变的是背景和字色 —— 正好是浅色主题
`html[data-theme='light'] .ep:hover{color:var(--ink);background:rgba(15,20,24,.08)}` 这两个值。
iOS 点一下就停在同一位置，`:hover` 会粘住不褪，于是「最后一次点过的位置」上那一集一直显示成 hover 态，
看着像被单独加了粗。第17集的位置正对上「显示全部 189 集」按钮被点掉之前的位置。

修法（两处，故意都做）：
- 站点 `src/styles.css`：把 `.ep:hover` 与浅色主题的 `.ep:hover` 包进 `@media (hover: hover) and (pointer: fine)`；
- 注入层 `AppBootstrap.js`：`@media (hover:none)` 里把 `#epGrid .ep:hover` 按回常态，并单独保住 `.ep.on:hover`
  （当前集的绿色必须还在）。
- 回归测试：`touch devices get the sticky episode hover reset`（断言重置存在、且不抹掉 `.on`）。

验证（Chrome 用 `(hover:none)/(pointer:coarse)` 真媒体模拟 + 真实鼠标移入）：

- 站点源码（Vite dev 5178）：指针移入 → color/background 不变；切回桌面指针 → hover 正常。
- 已部署构建 `dist/` + 0.1.3 注入层：同上，说明**不部署站点也能修好**。

### 2. 选集网格错位：真机未复现，保留加固，不声称修复

真机两张截图里选集网格是规整的 4 列，行与行对齐，无溢出。0.1.2 起的加固（`min-height` + `padding` +
`overflow-wrap:anywhere` + `grid-auto-rows`）保留：它防的是「第100集 / 第2集 预告」这类长标签换行压字，
不是已复现的故障。真正的「阶梯式错位」在真机上出现的是**分类卡片**那一块（列宽 84.75px 对卡片 166px），
0.1.2 已改为固定 168px 列宽，本轮在部署版构建上复测仍是 4×168px 无重叠。

### 3. 黑屏：间歇、本轮未复现，只保留可观测

真机播「遮天 第1集」8 秒正常出画、时间在走。此前记录的黑屏无法稳定复现，因此：
- 不写「已修复」；
- 保留 0.1.3 的两层兜底：站点 `startPlayback()` 捕获 `play()` 拒绝 → 提示「点一下画面重试」→ 下次触摸重试一次 →
  仍失败把错误名写出来；注入层再包一层 `HTMLMediaElement.prototype.play`，站点没部署也生效。
- 已有的片源侧观察（900MB 级 mp4、`mdat` 在 `moov` 之前、Range 206 正常）只作为“为什么可能卡在加载”的线索，
  不作为结论。

### 4. 全屏按钮：确认落在真实注入目标 + 有回归测试 + 不挤占原有那排

部署版 `dist/` + 注入层实测（428×926）：

```
settingsBtn y=478 x=12    lineBtn y=478 x=112   dmBtn y=478 x=168
pipBtn      y=478 x=240   nextEpBtn y=478 x=308
iosFullBtn  y=515 x=12    ← 单独一行，文案「全屏」
```

0.1.1 那五个按钮（显示设置/线路/弹幕/画中画/下一集）宽度刚好占满一行，插在中间会把「下一集」挤到第二行。
所以按钮固定接在 `#nextEpBtn` 后面（没有就接在 `#pipBtn` 后面），原有那排布局完全不变，多出来的「全屏」落到下一行。
回归测试 `fullscreen button toggles immersive mode and drives native rotation` 断言顺序为
`['pipBtn','nextEpBtn','iosFullBtn']`，并验证点击后 `data-ios-immersive` 与 `iosPlayer` 消息。

### 5. 首页日期条：一进来就停在今天（已按用户要求实现）

用户要求首页自动显示今天，本轮实现为「日期条一进来就把今天对齐到可视区起点」：

- 站点 `src/pages/home.js`：`loadHomeFeed()` 渲染完 `#days` 后调用 `centerSelectedDay(days)`；
- 注入层 `AppBootstrap.js`：`centerTodayStrip()` + 5 次限时重试（0/250/700/1500/3000ms）+ `MutationObserver`
  监听 `#days` 的 childList —— 因为站点会用缓存先渲染一次、网络回来再渲染一次，第二次会把 `scrollLeft` 重置为 0；
- **只在条内横向定位，不调用 `scrollIntoView`**（那会把整页滚走，就是之前记录过的“坐标漂移”来源）；
- **保留用户手动浏览**：任何 `touchstart`/`pointerdown` 落在日期条上之后就不再自动定位；
  已处理过的卡片会带 `data-ios-centred` 标记，同一张卡不会被反复拨动。

为什么是「对齐到起点」而不是「居中」：`.days` 是 `scroll-snap-type: x proximity` 容器，
每张卡 `scroll-snap-align:start`。实测居中值 54px 会被浏览器吸附回 76px（第 2 张卡的 snap 点），
所以按「对齐到天」处理，结果稳定可复现。

浏览器实测（把平台日期后移 2 天，让今天落在周中；428×926 触屏模拟）：

| 场景 | 今天 | scrollLeft | 今天是否完全可见 | 手动回拨 3.6 秒后 |
| --- | --- | --- | --- | --- |
| 站点源码（5178） | 周三 19日 | 120（= max，公式值 120） | 是 | 76 不变 |
| 部署版 dist + 注入层 | 周三 19日 | 120（= max） | 是 | 76 不变 |
| 真实日期（部署版+注入层） | 周二 17日 | 76（= 今天的内容偏移） | 是 | 76 不变 |

回归：`home date strip starts centred on today`、`home date strip keeps the position the user swiped to`、
`home date strip is not yanked back after it was centred`、`home date strip re-centres after the site re-renders the days`。

### 5b. 原来那条「日期条自己横向位移」的归因（保留说明）

真机时代码里没有任何 scroll 调用，部署版 6 秒采样 `scrollLeft` 恒为 0；测到的位移 42.7pt 不落在任何 snap 点上。
现在这一条被上面的实现覆盖了：加载后会主动把今天对齐好，即使之后站点二次渲染也不会再漂。

### 6. 撤回上轮的「首页/详情页持续自动滚动」表述

真机证据显示首页主内容 10 秒内位置不变，只在日期条这一条横向滚动区里有位移。
因此不再声称页面自动滚动；`WebViewController` 里关掉外层 `WKScrollView` 回弹（`bounces=false`、
`contentInsetAdjustmentBehavior = .never`）保留为预防性收敛，不算已修复的问题。

## 三、改动文件

| 文件 | 内容 |
| --- | --- |
| `ios/ZhuijuAI/AppBootstrap.js` | 全屏按钮（接在下一集之后）、沉浸样式、浅色底栏、分类卡片 168px、选集卡片加固、触屏 hover 复位、播放兜底、`?q=` 兜底 |
| `ios/ZhuijuAI/WebViewController.swift` | `iosPlayer` 通道、锁横屏、全屏/安全区约束切换、scrollView 收敛、UA 0.1.3 |
| `src/styles.css` | `.ep` 改最小高度、hover 仅在可 hover 设备生效、浅色底栏、`.cat-list` 168px |
| `src/pages/player.js` | `startPlayback()` 不再吞异常、展开选集保留当前集 |
| `src/runtime.js` | `proxyList` 补 `q` |
| `ios/Tests/bootstrap.test.mjs` | 23 项回归（含触屏 hover 复位、全屏按钮顺序） |
| `ios/project.yml` | 0.1.3 / build 4 |
| `ios/ZhuijuAI/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png` | 用户提供的图标 |

## 四、CI 结果（2026-11-17）

- 提交：`9109c63`（0.1.3 主体）+ `9d128ea`（首个 WKWebView 冷启动超时从 15s 放宽到 60s）
- 运行：run 44015817232，workflow「Build unsigned iOS IPA」，branch main，**success**
- 首轮 run 44014826116 失败在 1 个用例：`setUp` 里等 `loadHTMLString` 的 `didFinish` 超时，
  发生在任何 App 代码执行之前（冷启动 + runner 排队），放宽到 60s 后 7 项全过。
- Node 回归（CI 内）：27 项通过
- XCTest（iOS Simulator）：7 项执行，0 失败，13.054 秒，`"result": "Passed"`
- 产物：`ZhuijuAI-unsigned-ipa`（4,283,038 字节）
  - IPA 内容核对：`CFBundleShortVersionString 0.1.3`、`CFBundleVersion 4`、`MinimumOSVersion 15.0`、
    `UISupportedInterfaceOrientations` 含左右横屏、含 `AppBootstrap.js` / `NativeHls.js` / `hls.min.js`
  - SHA-256：`a8b32b8a8b78bb7aece7bea143b6a988ab21a54964723c9312c66810453d0e2f`（CI 产出的 .sha256 与本地重算一致）

## 五、打包与真机复测

本机（Windows）无法产出 IPA，路径只有 GitHub Actions `.github/workflows/ios-unsigned.yml`
（macos-15，先跑 23 项 Node 回归、再跑模拟器播放回归，最后产出 `ZhuijuAI-unsigned.ipa` + sha256），
需要授权推送或手动 `workflow_dispatch`。

真机复测确认三件事：版本号 0.1.3 (4)、站点看到的 UA 是 `ZhuijuAI/0.1.3 iOS`、四个现象是否消失。
