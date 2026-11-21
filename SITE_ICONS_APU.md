# 站点图标接入 iOS App 的「阿噗」图标（zhuiju-web）

`https://zhuiju.dpdns.org` 的图标原来是一个绿色小电视的 data:image/svg+xml。这次换成 iOS App 的
1024 图标（那只抱着爆米花的阿噗），并给主屏/PWA 补齐 touch icon 与 manifest 图标。
只动图标与密码门的放行规则：域名、`kanju-api`、D1、站点功能与样式、iOS/Android App 都没动。

## 产出

源图：`ios/ZhuijuAI/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png`（缺失则退到
`ios/scripts/appicon-source.png`）。生成脚本：`python scripts/site-icons-apu.py`（`--dry-run` 只报告）。

| 文件（`public/` 下，构建后落在站点根） | 尺寸 | 用哪张 |
| --- | --- | --- |
| `favicon.ico` | 16 / 32 / 48 三帧 | 头像特写 |
| `favicon-16x16.png` / `favicon-32x32.png` | 16 / 32 | 头像特写 |
| `apple-touch-icon.png` | 180×180 | 整张 App 图标 |
| `apple-touch-icon-precomposed.png` | 180×180 | 整张 App 图标（同上，只是老 iOS 的另一条路径） |
| `icons/icon-192.png` / `icons/icon-512.png` | 192 / 512 | 整张 App 图标 |
| `manifest.webmanifest` | — | 新增 `icons` 数组，指向上面两张 |

小尺寸 favicon 用「头像特写」（`FACE_BOX = (170, 40, 860, 730)`）：整张图缩到 16px 只剩一团色块，
特写还能看出是那只白色小圆脸；180/192/512 留给主屏和安装面板，用整张 App 图标，跟 App 里的图标一致。

六个入口页（`index.html`、`player/`、`playlists/`、`download/`、`library/history/`、`library/sessions/`）
原来只有首页挂了一条 SVG 图标，其余五页没有。脚本把首页那条换成真图标链接，给其余五页补上同样四条：

```html
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
```

## 密码门放行规则（`cloud/web/src/index.js`，基线里没有这个文件，用 patch）

浏览器拿 favicon、iOS 抓主屏图标、以及 manifest 与里面的图标，都是**不带 cookie** 的请求。
以前 `/favicon.ico` 直接被回成 204，其它图标路径会掉进密码页。现在把这些路径放到密码门前，
只放行图标与 manifest，且只允许 GET/HEAD：

```diff
--- a/cloud/web/src/index.js
+++ b/cloud/web/src/index.js
@@
 //   GET  /robots.txt   禁止收录（无需登录即可读，爬虫才看得见）
+//   GET  /favicon*  /apple-touch-icon*  /manifest.webmanifest  /icons/*  图标与 manifest（无需登录，仅 GET/HEAD）
@@
 const NOINDEX = { 'x-robots-tag': 'noindex, nofollow, noarchive' }
+
+// 图标与 PWA manifest：浏览器 / iOS 主屏在未登录状态下就会抓，必须放在密码门前
+const PUBLIC_ASSETS = new Set([
+  '/manifest.webmanifest',
+  '/favicon.ico',
+  '/favicon-16x16.png',
+  '/favicon-32x32.png',
+  '/apple-touch-icon.png',
+  '/apple-touch-icon-precomposed.png',
+])
+
+function isPublicAsset(path) {
+  if (PUBLIC_ASSETS.has(path)) return true
+  if (path.startsWith('/favicon')) return true // 其它 favicon 变体
+  if (path.startsWith('/icons/')) return true // manifest 里的 192/512 图标
+  return false
+}
@@
-    if (path === '/favicon.ico' && method === 'GET') {
-      // 避免未登录时浏览器狂刷密码页
-      return new Response(null, { status: 204, headers: NOINDEX })
-    }
+    // 图标 / manifest：匿名可读，但不带任何站点内容（也不下发 cookie）
+    if (isPublicAsset(path)) {
+      if (method !== 'GET' && method !== 'HEAD') {
+        return new Response('Method Not Allowed', { status: 405, headers: { ...NOINDEX, allow: 'GET, HEAD' } })
+      }
+      const asset = await env.ASSETS.fetch(request)
+      const headers = new Headers(asset.headers)
+      for (const [k, v] of Object.entries(NOINDEX)) headers.set(k, v)
+      headers.set('cache-control', 'public, max-age=86400')
+      return new Response(asset.body, { status: asset.status, headers })
+    }
```

放行范围只有：六个具名文件、`/favicon*`、`/icons/` 目录（里面只有这两张图标）。
`/api/*`、页面、`/assets/*` 仍然要 cookie，未登录一律是密码页；`/icons/../index.html`
这种绕行由 URL 归一化 + 上面的白名单一起挡住（实测仍是密码页）。

## 复算与部署

```bash
cd /path/to/kanju-clone          # 发布用的那份工作副本（线上 dist 就是从它构建的）
python scripts/site-icons-apu.py --dry-run
python scripts/site-icons-apu.py
VITE_PROXY_BASE=https://zhuiju.dpdns.org npx vite build
cd cloud/web && npx wrangler deploy
```

## 验证（2026-11-18，全部请求不带 cookie）

线上版本 `f14b02cf-ee77-4017-9183-4b6c7ff359be`（deployment
`77434f10-25c3-4838-9682-e8b5d0181244`，100%）：

| 路径 | 状态 | content-type | 字节 | 实测尺寸 |
| --- | --- | --- | --- | --- |
| `/` | 200 | text/html | 1598 | 仍是密码页「需要密码 · 阿噗影视」 |
| `/favicon.ico` | 200 | image/vnd.microsoft.icon | 8501 | ICO 16/32/48 |
| `/favicon-16x16.png` | 200 | image/png | 782 | 16×16 |
| `/favicon-32x32.png` | 200 | image/png | 2514 | 32×32 |
| `/apple-touch-icon.png` | 200 | image/png | 62507 | 180×180 |
| `/apple-touch-icon-precomposed.png` | 200 | image/png | 62507 | 180×180 |
| `/manifest.webmanifest` | 200 | application/manifest+json | 471 | JSON，name/short_name=阿噗影视，icons 两条 |
| `/icons/icon-192.png` | 200 | image/png | 69987 | 192×192 |
| `/icons/icon-512.png` | 200 | image/png | 355284 | 512×512 |

受保护内容没被连带放开：`/api/health` 仍是 401 `{"error":"unauthorized"}`；`/player/`、
`/assets/*.js`、`/icons/../index.html` 仍是密码页；`POST /favicon.ico` 是 405。

部署前还在本机用 `wrangler dev`（同一份 Worker 代码 + 同一份 dist）跑过一遍同样的清单，
静态资源与门禁行为一致。