# 追剧AI iOS 0.1.2 修复记录（2026-11-17）

在 0.1.1 的基础上修用户反馈的四个问题，并换掉 iOS 图标。App 仍然是 WKWebView 壳，所以能用客户端兼容层修的优先放在 `AppBootstrap.js` / `WebViewController.swift`（不需要重新部署站点）；站点源码里的根因也一并修掉，部署后兼容层自动变成空操作。

## 1. 无法全屏播放、无法横屏

- 现象：播放页视频只在页面中间一条，点系统控件里的全屏后仍是竖屏上下大黑边。
- 根因：站点播放器只有 `<video controls playsinline>`，没有自己的全屏入口；`playsinline` 下系统全屏跟随设备方向，手机开着竖屏锁定或用户不转手机就永远出不来横屏；0.1.1 的注入 CSS 只在 `@media(orientation:landscape)` 生效，竖屏没有任何变化。
- 修复：
  - `AppBootstrap.js` 在播放页工具栏插入「全屏」按钮（在「画中画」后面），进入沉浸模式时 `#player` 固定铺满整屏（竖屏也铺满，横屏 `object-fit: contain` 无黑边），工具栏/线路/显示设置浮在播放器上，正文滚动被锁定，按钮变成「退出全屏」。
  - 播放中旋转到横屏也会自动进入沉浸模式（原行为保留），`ended / emptied / error / Escape` 都会退出。
  - `WebViewController.swift` 增加 `iosPlayer` 消息通道：网页进入全屏时锁横屏（iOS 16+ 用 `requestGeometryUpdate`，iOS 15 用 `UIDevice` KVC 兜底）、隐藏状态栏与底部小白条、把 WKWebView 约束从安全区切到整屏；退出时解锁并转回竖屏。

## 2. 「更新至第 N 集」溢出、内容挤在一起

- 现象：首页各分类（电视剧/动漫/综艺/电影）里，卡片右侧的「更新至第 N 集」被裁掉，相邻卡片文字叠在一起。
- 根因：`styles.css` 末尾把 `.cat-list` 改成 `grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr)`，但 `.ccard` 在手机上有固定宽度。4 张卡片平分容器宽度后每列只有约 84px，卡片却仍是 166px 宽，于是每张卡片压在后一张上，文字被 `.ccard{overflow:hidden}` 硬裁。
- 修复：列宽改成卡片实际宽度（`grid-template-columns: none` + `grid-auto-columns: 168px`），手机保留横向滑动、不重叠。站点 `src/styles.css` 和客户端注入样式都改了。

## 3. 白色主题下底部按钮文字不可见

- 现象：浅色主题时底栏「短剧 / 历史 / 片单」几乎看不到，只剩当前项。
- 根因：`.tabbar .tab{color:rgba(255,255,255,.62)}` 只在深色底栏上可读，浅色主题把底栏背景换成白色后没有覆盖文字颜色，变成白底白字。
- 修复：补 `html[data-theme='light'] .tabbar .tab / .tab.on / .tab.center .tb-label / .tab-circle` 的深色文字与浅绿选中态。站点 CSS 与客户端注入样式都改了。
- 顺带：全屏工具条在浅色主题下也改成白底，避免深色文字压在深色面板上（同一类问题）。

## 4. 搜索搜不到影片

- 根因（已核实，不是网络问题）：`src/runtime.js` 的 `proxyList()` 接收 `q`，但函数签名里没有 `q`，构造请求参数时也没写 `q`。`home.js` 把关键词传进 `proxyList` 后被直接丢掉，后端 `/api/list` 收到的只是 `sort/limit/page`，于是按热度返回一批与关键词无关的影片——用户看到的就是「搜索没反应/搜错片」。
- 修复：
  - 站点根因：`proxyList({... q ...})` 增加 `q` 参数并写入查询串（`/api/list?q=关键词`）。后端 `server/proxy.mjs` 本来就有 `title/genres/actors/description LIKE` 的搜索分支，不用改接口。
  - 客户端兜底：`AppBootstrap.js` 在 `/api/list` 请求没有 `q` 时，用首页搜索框里的关键词补上（关键词来自用户输入，已带 `q` 的请求不重复追加）。站点部署修复后这段兜底自动失效。

## 5. 图标

- 用户提供的图（`ios/scripts/appicon-source.png`）→ `scripts/make-icon.ps1` 去掉外圈白边、生成 1024×1024 RGB 无 alpha 的 `AppIcon-1024.png`。iOS 自己裁圆角，图标本身不能带白边。

## 版本

`MARKETING_VERSION 0.1.2`、`CURRENT_PROJECT_VERSION 3`，User-Agent 同步为 `追剧AI/0.1.2 iOS`。

## 已验证 / 未验证

- 已验证（本机 Windows）：`node --test ios/Tests/bootstrap.test.mjs` 16 项全过；`node --check` 语法检查；在 Chrome 里以 393×852 / 852×393 视口加载站点并注入 0.1.2 的 `AppBootstrap.js`，实测全屏铺满、退出、浅色底栏可读、分类卡片不重叠、搜索请求带 `q`。
- 未验证：Swift 侧改动本机没有 Xcode，未编译、未过 XCTest；真机上的锁横屏、state bar/小白条隐藏、WKWebView 约束切换需要 iPhone 验收（云端 CI 的 XCTest 也覆盖不到真实旋转）。站点源码里的 CSS/JS 改动要等重新部署才在线上生效，未部署。
