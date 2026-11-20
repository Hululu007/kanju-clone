# 追剧AI iOS 0.1.19 / build 23 交付说明

分支：`fix/ios-0.1.19-build23-fullscreen`
审核通过提交：`c22894362dd9cf4c9fbc85034e9908d8befab42e`（reviewer 只读审核通过，无新增源码阻断）
main 合并/推送：已快进推送到 `origin/main`，main 现在就是上面的 SHA。

这份用大白话说明 build 23 修了什么、包在哪里、怎么验收。

## 一、两个问题的根因

1. **全屏黑屏、只剩声音、退不出去**：站点点全屏时，原本让整个播放器容器进全屏；iOS 的 WKWebView 对这种“容器元素全屏”会丢掉 video 画面，只剩声音，站点画在容器里的退出按钮也被盖住。build 22 只切换了横竖屏方向，没有换掉“用哪套全屏”，所以方向对了但画面还是黑的。
2. **下载完成后要能交给别的播放器**：iOS 上别的 App 读不到我们 App 沙盒里的文件；URL scheme 只能跳过去，传不了真实的本地视频文件；自己架本地 HTTP 服务，切到别的 App 后会被系统挂起，供不了整集。Ken 已明确授权出现一次系统“打开方式”菜单，所以 build 23 用系统文档交接，把本地文件复制给播放器。

## 二、这次改了什么

- **全屏改走系统原生视频播放器**：站点请求全屏时，不再让整块容器进全屏，而是调 `video.webkitEnterFullscreen()`。画面由 iOS 原生播放器渲染；系统播放器自带 Done / 下滑退出；退出后回到详情页原位，页面不重建，播放进度和选集状态保持不变。
- **状态机只认一个请求、一个视频**：同一时间只跟一个全屏请求；另一个请求直接拒绝，不排队。公开属性 `webkitDisplayingFullscreen` 可用时做 300ms 宽限核对和回到前台核对；核对发现“其实已经全屏”时，和收到 begin 事件走同一条成功路径：记住当前视频、让原生切横屏、兑现这次请求。这样退出事件和 `document.exitFullscreen` 都找得到视频。
- **外部播放入口**：「我的下载」里已完成的那一集显示「外部播放」；下载中的集没有入口。点击后由系统弹出“打开方式”，用户选已安装的播放器（VLC / Infuse / nPlayer / SenPlayer 等），系统把本地文件复制过去，之后完全离线播放。点整行仍然是 App 内 AVPlayer 播放，两条路并存。
- **严格守卫**：只允许 `Documents/Downloads` 这个真实下载目录里的普通文件；目标与根目录都解析符号链接后按完整路径组件比较，`Documents-evil` 这类同前缀兄弟目录、目录本身、符号链接逃逸都会拒绝。类型只处理下载器实际允许的 mp4/m4v/mov/mkv/ts；系统有声明且属于视听类型就用它，mkv/ts 没有声明时用同扩展名、conforming 到 public.movie 的动态类型；找不到类型就明确提示，不用 nil UTI 开菜单。缺文件、取消、无接收 App 都有 toast 提示。
- **冻结项**：下载进度渲染和首页无设置齿轮都没改。

## 三、包与交付信息

- 桌面包：`C:\Users\kenzh\Desktop\ZhuijuAI-0.1.18-build23-unsigned.ipa`
- 文件大小：4410400 bytes
- 包内实际版本：`CFBundleShortVersionString=0.1.19`，`CFBundleVersion=23`，`CFBundleIdentifier=org.dpdns.zhuiju.ios`（文件名沿用 Ken 指定的 0.1.18 前缀，包内内容以这三个字段为准）
- SHA256：`f1d6997001ff972735cb8647a3706a1381b7108e803378370139ec1ddd1070c1`
- 审核：reviewer 对 `c228943` 整体只读审核通过；此前认可项沿用，无新增源码阻断。
- 打包 workflow：只运行 `ios-ipa-only.yml` package job，run `44684378544`，`code_ref=c22894362dd9cf4c9fbc85034e9908d8befab42e`；workflow `build-info.log` / `ipa-info.log` 里的 checkout SHA 与目标一致，没有运行任何测试 job。
- 推送 main 自动触发的旧 `Build unsigned iOS IPA` run `44684329726` 已按禁止云测指令取消；没有删除或禁用 workflow 配置。

## 四、本机验证

- `node --check ios/ZhuijuAI/AppBootstrap.js`：通过，日志 `C:\Users\kenzh\AppData\Local\Temp\build23-logs\node-check.log`
- `node --test ios/Tests/*.test.mjs`：82/82 通过，日志 `C:\Users\kenzh\AppData\Local\Temp\build23-logs\node-test.log`
- `git diff --check`：通过，日志 `C:\Users\kenzh\AppData\Local\Temp\build23-logs\diff-check.log`
- 打包与校验日志文件夹：`C:\Users\kenzh\AppData\Local\Temp\build23-delivery-logs\`（git push、workflow run/watch、下载、桌面 SHA256、Info.plist 复算都在里面）
- Windows 本机没有 Xcode，Swift 侧不能本地编译；云端只打包 workflow 已成功编译出 IPA。

## 五、真机待办（必须 Ken 安装 build 23 后再做）

1. 详情页点站点播放器全屏 → 有画面、横屏铺满。
2. 系统播放器 Done 或下滑退出 → 回到详情页原位，播放进度不变。
3. 重复进/出全屏、暂停时点全屏都要正常。
4. 我的下载里已完成的一集点「外部播放」→ 系统“打开方式”列出已安装播放器；选一个能离线播完整集。
5. 下载中的集没有「外部播放」；删掉文件后点，应有提示。
6. mkv / ts 是否真能被播放器接住，要在真机上核实；本机没有验证。

**真机尚未测试**：以上只是代码审核、本地 Node 回归和云端 packaging-only 编译通过。等 Ken 安装桌面 build 23 包并确认后，才由 Lead 派手机测试； tester 要先核对版本/build 23。iOS 15.0–15.3、iframe 结构、系统 Done 事件丢失这几项仍是证据缺口，不声称已通过。
