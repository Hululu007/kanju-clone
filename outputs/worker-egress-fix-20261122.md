# Worker 出口 / 官方默认线路修复证据（2026-11-22）

## 根因

`/api/play` 旧实现把原站返回的 20~30 条线路全部送去 `/v1/playback/resolve-line` 解析并探测首片。
Cloudflare 免费版每次 Worker 调用最多 50 个子请求（实测错误文本：
`Error 1102: Too many subrequests by single Worker invocation`）。跑到后段时：

- `getGuest` / `resolve-line` 开始抛子请求超限，统一被报成 `resolve_failed`，默认线路被判死；
- 媒体探测拿到 `fetch_failed` / `probe_timeout`；
- 上游 429 也没有重试（本地客户端有），会话过期强制刷新被 5 分钟节流挡住。

结果：排序对、但起播回退别家线路，和原站不一致。

## 改动

分支 `fix/worker-official-egress`，文件 `worker/api/src/index.js`：

1. `resolveTicket` 有界重试：普通线 2 次尝试，原站默认线 3 次；429/403/5xx 退避；
   会话过期立即强制刷新访客 cookie（绕过 5 分钟节流）；撞到子请求上限不再重试。
2. `playUrl` 有界探测：原站默认线路移到最前，最多探测 8 条；其余保留为
   `deferred / probe_budget_exceeded`，前端状态仍是「未知」而不是「死线」。
3. 429 或子请求上限时，查 D1 `sources` 里同 show + 同集 + 同 provider + 同标签、7 天内验证过的直链复用。
4. 默认线路已解析出地址但 Worker 出口探测失败（`probe_timeout` / `fetch_failed` 等软失败）时，
   作为 `verified:false` + `probeDegraded:true` 的候选返回给浏览器；不写 `sources` 冒充已验证。

## 测试

先写 `Tests/worker-egress.test.mjs` 6 条，旧实现 5 红 1 绿（上面的失败输出见下）：

- 429 重试后仍选官方线
- Worker 出口超时的默认线保留为未验证候选
- 429 时复用上次验证过的直链
- 子请求上限时复用上次验证过的直链
- 20 条线路时解析调用不超过 8 次
- 对照组：HTTP 403 硬失败仍回退到已验证备用线

修复后：`node --test Tests/*.test.mjs` → **82 通过 / 0 失败 / 0 跳过**（内存上限 2048 MB）。
`node --check worker/api/src/index.js` 通过。本次没有改前端，未跑 vite build。

## 线上诊断实例验证

临时实例 `kanju-api-diag-ken`（部署后已删除），对照 `migrate-v11.sql` 前 14 部逐部实看过的默认线路：

- 修前抽查《走马上任》：`1080P-官方Z = resolve_Too many subrequests by single Worker in…`，
  最终选到别的线路。
- 修后同一部：`chosen=1080P-官方Z`、`verified:false`、`probeDegraded:true`，不再换线。
- 修后 14 部中 10 部拿到响应，**10/10 命中原站默认线路**（3 部为未验证候选）；
  其余 4 部是诊断实例偶发 503，直连生产实例同类请求正常 200。
- 抽查《嫁金钗》：默认线 `1080P-官方V` 命中，`verified:false`、`probeDegraded:true`，
  `tried[0].reason=fetch_failed`（Worker 出口拿不到，交浏览器判断）。

## 仍未覆盖

- 浏览器里是否真的能播这些未验证候选，取决于用户侧网络；播放器已有失败自动换线兜底。
- 综艺缺集问题（4 部）按用户指示不处理。
