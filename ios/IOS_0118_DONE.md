# 追剧AI iOS 0.1.19 / build 23：全屏黑屏怎么修的

分支：`fix/ios-0.1.19-build23-fullscreen`　版本：0.1.19（build 23）

这份给 Ken 看大白话：build 22 在手机上点全屏会黑屏、只剩声音、退不出去，这次说明原因、改法和真机要确认的事。

## 一、真机上看到的事（build 22）

点站点播放器自己的全屏后：画面全黑，声音还在；站点自己的退出按钮也找不到，像卡在全屏里。

这一条是 Ken 在 build 22 上的反馈。Pinky 手机测试还没跑（Pinky 没开），所以这次没有 tester 的复现记录，第五节仍然算待测。

## 二、根因（大白话）

1. **站点是按“整块播放器容器”去全屏的**，不是只把视频本身放大。它调的是浏览器标准的
   `requestFullscreen()`，iOS 的 WKWebView 会把整块容器交给系统的“元素全屏”。
2. **iOS 对这种“容器元素全屏”会丢掉视频画面。** 容器进去了，但里面的 video 图层没有被正确渲染，
   于是只剩声音、画面全黑——这不是解码问题，是选错了全屏方式。
3. **退出按钮画在这个容器里**，它跟着容器一起被系统全屏层盖住或失效，所以看起来退不出去。
   build 22 只做了“进/出全屏时把屏幕切横屏/竖屏”，没有换掉“用哪套全屏”，所以方向对了、画面还是黑的。

## 三、这次怎么改

- **把全屏改道到系统原生视频全屏**：注入层在页面脚本之前，把容器的
  `requestFullscreen` / `webkitRequestFullscreen` 包了一层；只要请求的元素（或它里面的 video）
  有视频，就改成调 `video.webkitEnterFullscreen()`。这样由 iOS 原生视频播放器接管：
  画面正常、自带 Done 和下滑退出，退出后视频回到详情页原位继续播。
- **不搬动视频、不写全屏 CSS、不做旋转、不重布局**：页面不重建，所以详情页位置、选集和播放进度都保持原样。
  不是主视频的普通元素，仍然走浏览器原来的全屏实现。
- **退出后补一个退出事件**：如果站点是靠 `fullscreenchange` 收尾的，原生全屏退出后会补发一次，
  让站点把自己的沉浸态样式/退出按钮收回去；补发期间注入层自己不再拿残留的
  document.fullscreenElement 判断状态，避免原生方向又横过去。
- **Promise 不撒谎**：站点调 requestFullscreen() 时，只有系统真的报出“视频全屏开始”才算成功；
  调用失败或系统 1.5 秒没反应就返回失败，站点可以自己提示。有视频的请求只走原生播放器，
  失败也不回退到会黑屏的容器全屏。
- **iOS 15.0–15.3 也能用**：这几个系统的 WKWebView 没有 Element 全屏 API（开关从 15.4 才有），
  注入层把 requestFullscreen / document.fullscreenEnabled 补出来，全屏按钮照常出现并改道到
  系统原生视频全屏；退出时 document.exitFullscreen 也转成原生退出。
  系统原生的 video.webkitEnterFullscreen 不受这个开关限制（WebKit 源码里没有门控）。
- **iframe**：注入只作用于主页面。站点的播放器、剧集网格、下载按钮都在主文档里
  （注入层的选集/下载在真机上一直能用；跨域 iframe 里读不到这些节点），所以没有为猜测的
  iframe 场景加代码。
- **方向逻辑保持不变**：进入全屏 → 横屏铺满，退出 → 回竖屏原位（build 22 的两态策略照旧）。
- 版本号：build 22 → **build 23**；MARKETING_VERSION 仍是 0.1.19。

## 四、本机验证

- `node --check ios/ZhuijuAI/AppBootstrap.js`：通过
- `node --test ios/Tests/bootstrap.test.mjs ios/Tests/downloadQueue.test.mjs`：**72 条全过**，
  新增 4 条全屏用例：容器全屏改道、Promise 契约与失败不回退、退出不回头、iOS 15 老系统补 API
- `git diff --check`：通过
- 日志：`C:\Users\kenzh\AppData\Local\Temp\ios-build23-node.log`
- 本机是 Windows、没有 Xcode：Swift 侧本次没有改；App 编译和出包只能在打包工作流里验证。

## 五、真机要逐条确认（build 23）

1. 详情页点站点播放器的全屏 → 有画面、横屏铺满。
2. 全屏里始终有退出方式：系统播放器的 Done，或下滑退出。
3. 退出后回到详情页原位，播放进度没变，可以接着播。
4. 再点一次全屏，重复 1–3 仍然正常（不能只第一次生效）。
5. 暂停状态下点全屏也要有画面、能退出。

## 六、第二项（外部播放器）与交付状态

- 用户澄清不限定 SenPlayer，只要能交给“其他播放器”。核实结论：VLC / Infuse / nPlayer / SenPlayer
  都受同一个限制——别的 App 读不到我们沙盒里的文件，URL scheme 只能跳转、不能把 file:// 递过去；
  127.0.0.1 本地服务会在切走后被 iOS 挂起，供不了整集。
- 唯一可靠的是系统“打开方式”面板（UIActivityViewController / UIDocumentInteractionController），
  由系统把文件复制进目标 App，之后完全离线播放；需要用户点一下，也就是现在被禁止的那个面板。
  证据、链接和最小方案都写在 ios/IOS_EXTERNAL_PLAYER_HANDOFF.md，等这个约束的决定。
  下载本身落盘就是一个完整文件（HLS 已被拒绝），没有分片合并问题。
- 当前状态：修复提交在 `fix/ios-0.1.19-build23-fullscreen`，**尚未合 main、尚未出包**；
  审核通过后合并并只跑 `ios-ipa-only.yml`（只打包，不跑测试 job）。
- **真机未测**：上面第五节要在手机上逐条走一遍才算这版可用。
