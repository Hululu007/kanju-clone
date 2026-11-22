# 官方线 Worker 出口 · 第四轮返修证据（2026-11-22）

分支 `fix/worker-official-egress`，基线 `2341950`。只处理第 2 项；第 1 项（4 部综艺原站默认集缺库）按用户要求未动。

## 审核开发二在 `2341950` 上给的两条 P1

1. HLS 密钥明确 404 被归为软失败，抢占已验证的备用线。
2. 预算耗尽后重试丢掉已经解析出的官方地址：首次探测有地址、重试没有地址时，空结果覆盖了首次结果。

## 复现（先在旧代码上确认红）

新增 3 条用例（`Tests/worker-egress-review.test.mjs`），在 `2341950` 上：

- `an HLS key with a definite HTTP 404 is dead, not an unverified default` — 旧实现返回官方线 `verified:false`、`probeDegraded:true`，默认线状态 `unknown`；期望应改用已验证备用线。红。
- `an origin-default retry with no address keeps the first resolved URL` — 首次解析拿到地址但探测遇预算失败，重试限流无地址后，接口返回备用线 `other.mp4`、官方线状态 `unknown`。红。
- `mergeOriginRetry only replaces the first probe when the retry has an address or a definite failure` — 直接调用合并函数，首次 `url` 被空重试结果清掉。红。

复现夹具走 `/api/play` 真实调用链（D1 内存库 + fetch mock），不是只测谓词。

## 根因与修复

1. `worker/api/src/playback-probe.js`：密钥/初始化片段请求的 catch 把 `http_404` 折叠成 `playlist_dependencies_unavailable`；后者在软失败集合里，于是线路被当「Worker 出口问题」保留为未验证候选，抢在可播备用线前。现在所有明确 HTTP 状态码原样带出为 `playlist_dependencies_http_<status>`；`worker/api/src/source-selection.js` 把其中 4xx（除 429）列为硬失败，429/5xx 仍是软失败。
2. `worker/api/src/origin-default.js` 的 `mergeOriginRetry`：重试在预算耗尽或限流时可能连地址都没拿到，旧实现无条件覆盖首次结果。现在仅当重试「没有任何地址且只是软失败/未知状态」、而首次结果有地址时保留首次结果；会员、403 这类明确失败仍然替换，避免把线路误报成超时。

## 验证

- 3 条新增用例在 `2341950` 上 3 红；修复后 3 绿。
- 全套 `node --test Tests/*.test.mjs`：**98 通过 / 0 失败 / 0 跳过**（`python C:/Users/kenzh/hark_tasks/memcap.py 2048`）。未删测试、未跳过、未改旧断言。
- `node --check`（playback-probe.js / source-selection.js / origin-default.js / index.js）通过；`npm run build` 通过。
- 未部署生产、未做浏览器实播；第 1 项综艺缺集未处理。
