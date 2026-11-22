# 第 2 项（官方线 Worker 出口）第五轮返修证据 — 2026-11-22

分支 `fix/worker-official-egress`，基线 `838d751`，本轮新提交见 git log。第 1 项综艺缺集按用户要求未处理。

## 审核结论中剩下的唯一 P1

审核开发二对 `838d751` 的结论：HLS 密钥明确 404 已通过；「重试丢失已解析地址」未完全修好——
重试解析请求超时或断网时，异常被包装成未识别的 `resolve_<message>`，空结果仍覆盖首次地址，
官方线被误标 `dead` 并切到备用线。

## 根因

- `probeOne`（`worker/api/src/index.js`）解析失败时把无 status 的异常包装成
  `resolve_${String(error.message).slice(0, 40)}`，如 `resolve_fetch failed`、
  `resolve_connect timeout from worker egress`、`resolve_probe_aborted`。
- `mergeOriginRetry`（`worker/api/src/origin-default.js`）用「已知软失败白名单」判断能否保留首次地址，
  未识别的 `resolve_*` 不在白名单内，于是空结果覆盖首次结果，默认线丢地址 → 换别家。
- 同一批未识别的 `resolve_*` 在 `isSoftProbeFailure` 里也被判成硬失败，`probeStatus` 报 `dead`、
  `originDefaultStatus:'unavailable'`，把 Worker 出口问题错报成线路本身死了。

## 修复

1. `worker/api/src/origin-default.js` — `mergeOriginRetry`：
   把「已知软失败白名单」换成「明确失败黑名单」。重试无地址时，只有会员/登录限制、
   解析接口明确 HTTP 4xx（429 限流除外）才覆盖首次结果；超时、断网、连接重置、
   被中止、限流、预算耗尽一律保留首次已解析地址。这样新增一种传输异常也不会再漏。
2. `worker/api/src/source-selection.js` — `isSoftProbeFailure`：
   解析请求自身的传输类 `resolve_*`（非 HTTP 4xx）统一归为软失败，明确 HTTP 4xx 仍为硬失败。
3. 清掉 `origin-default.js` 里不再使用的 `isSoftProbeFailure` 导入。

## 复现证据（先红后绿）

新增 `/api/play` 真实调用链用例：
`an origin-default retry whose resolve request times out keeps the first resolved URL`

- 夹具：首次解析给 official.mp4，探测用掉预算（软失败、保留地址、触发默认线重试）；
  第二次（重试）解析请求直接抛 `connect timeout from worker egress`。
- 在 `838d751` 上实测失败：
  `provider=other`、`url=https://media.example/other.mp4`、`verified=true`、
  `originDefaultStatus=unavailable`、默认线 `status=dead`、`tried.reason=resolve_connect timeout from worker egress`。
- 修复后：仍返回默认线 `official-z` / `official.mp4`、`verified=false`，保留为未验证候选。

同时扩充 `mergeOriginRetry only replaces the first probe when the retry has an address or a definite failure`：
`resolve_fetch failed`、`resolve_connect timeout…`、`resolve_socket hang up` 三种空结果都必须保留首次 URL；
`member` 与 `resolve_http_403` 仍按明确失败替换。

## 验证

- 两条新用例在 `838d751` 上：2 红（含真实调用链 1 红）。
- 修复后 `node --test Tests/*.test.mjs`：**99 通过 / 0 失败 / 0 跳过**（memcap 2048）。
- `node --check`（origin-default.js、source-selection.js、index.js、worker-egress-review.test.mjs）全过。
- `npm run build` 通过（vite built in 3.13s）。
- 未删除旧测试、未改旧断言；未合并 main、未部署生产、未做浏览器实播。
