# 站名改为「阿噗影视」（zhuiju-web 前端，0.1.14 之外独立小改）

`https://zhuiju.dpdns.org` 的站名从「追剧AI」改为「阿噗影视」。只改品牌字符串与
主屏/PWA 元数据：域名、后端 `kanju-api`、D1、站点功能与样式、iOS/Android App 名称都没动。

## 改了哪些

| 位置 | 改什么 |
| --- | --- |
| 六个入口页 `index.html`、`player/`、`playlists/`、`download/`、`library/history/`、`library/sessions/` | `<title>` 里的站名；首页 `description`；新增 `<meta name="apple-mobile-web-app-title" content="阿噗影视">` 与 `rel="manifest"` |
| `public/manifest.webmanifest` | **新增**（此前站点没有 manifest）：`name` / `short_name` 都是「阿噗影视」，`start_url`/`theme_color` 取站点现有值 |
| `src/shell.js` | 顶栏品牌字、登录弹窗标题、站内通知标题与欢迎语 |
| `src/pages/home.js` | 首页大标题 |
| `src/pages/player.js` | 播放页 `document.title` 的后缀 |
| `src/pages/download.js` | 下载页的小标、`aria-label`、主标题（指着 TV App 的「下载XX-TV」按钮**保留**，那是 App 名称，不在改名范围） |
| `src/player-ctrl.js` | 外放兜底标题、浏览器下载文件名前缀（`追剧AI_第19集.mp4` → `阿噗影视_第19集.mp4`） |
| `cloud/web/src/index.js` | 密码门那一页的 `<title>` 与 `<h1>`（「追剧」→「阿噗影视」） |

改法是一个可复算的脚本：`python scripts/brand-rename-apu.py`（`--dry-run` 只报告）。
每一组旧写法必须**正好命中一个变体、且只出现一次**，否则脚本报错退出 —— 所以它不会
误伤功能代码，也能安全地在「线上那份工作副本」和「已提交基线」上分别执行。

## 与 main 的关系（重要）

线上 `zhuiju-web` 的构建来源是仓库根目录那份**工作副本**的 `dist/`，而那份工作副本里有
大量**尚未提交**的内容：`cloud/`（zhuiju-web 与 probe worker）、`src/player-ctrl.js`、
`src/auth.js` 等都不在 `main` 里；`main` 上的站名当时还写着「看剧AI」。也就是说
**`main` 当前无法构建出线上这个站点**。

所以这次的做法是：

1. 以线上那份工作副本为准做改动（只有品牌字符串，`diff` 确认过 12 个文件、无其他差异），
   `vite build` 后部署 `zhuiju-web`；
2. 把与基线无关的产物提交到本分支：`scripts/brand-rename-apu.py`、`public/manifest.webmanifest`、本文件；
3. 两个「基线里还没有」的文件（`src/player-ctrl.js`、`cloud/web/src/index.js`）的改动，
   以 patch 形式留在下面，等那份工作提交之后直接 `git apply` 即可。

## 未提交文件的补丁

```diff
--- a/src/player-ctrl.js
+++ b/src/player-ctrl.js
@@ -253,7 +253,7 @@
     const url = mediaUrl()
     if (!url) { say(mediaReason()); return }
-    const title = document.title || '追剧AI'
+    const title = document.title || '阿噗影视'
     const bridge = window.webkit?.messageHandlers?.iosPlayer
@@ -291,7 +291,7 @@
     const ext = match ? `.${match[1].toLowerCase()}` : '.mp4'
     const label = episodeLabel()
-    return `追剧AI${label ? `_${label}` : ''}${ext}`
+    return `阿噗影视${label ? `_${label}` : ''}${ext}`
   }
--- a/cloud/web/src/index.js
+++ b/cloud/web/src/index.js
@@ -155,7 +155,7 @@
 <meta name="robots" content="noindex,nofollow">
-<title>需要密码 · 追剧</title>
+<title>需要密码 · 阿噗影视</title>
@@ -175,7 +175,7 @@
 <form class="card" method="post" action="/__login">
-  <h1>追剧</h1>
+  <h1>阿噗影视</h1>
```

## 怎么复算与部署

```bash
# 1) 改（在要发布的那份工作副本里执行）
python scripts/brand-rename-apu.py --dry-run
python scripts/brand-rename-apu.py

# 2) 构建（仓库根目录，base 用 "/"，与 zhuiju-web 的 assets 目录一致）
VITE_PROXY_BASE=https://zhuiju.dpdns.org npx vite build

# 3) 发布（只发布 zhuiju-web）
cd cloud/web && npx wrangler deploy
```

## 验证

- **构建增量**：改动前后各构建一次，把新站名反归一、并把带哈希的产物文件名归一之后，
  15 个产物（6 个 HTML + 8 个 JS/CSS）与改动前**逐一内容相同**；唯一新增的是
  `manifest.webmanifest`。也就是说这次发布只换了品牌字符串。
- **线上**：部署后 `curl` 实际请求 `https://zhuiju.dpdns.org`，密码门页面已是
  「需要密码 · 阿噗影视」、`<h1>阿噗影视</h1>`。
- 站点在密码门后面，登录后页面里的 `<title>` / `apple-mobile-web-app-title` /
  `manifest` 需要带 cookie 才能 `curl`；命令见回报，密码只有主人有。