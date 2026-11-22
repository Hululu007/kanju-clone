# Worker 官方线出口返修证据（2026-11-22）

对应审核：`dc462b2` 四条 P1（限流被判死线、空标签缓存冒充语言版本、软失败覆盖已验证记录、固定探 8 条）。
用户范围：只做第 2 项（官方线 Worker 出口），第 1 项（4 部综艺原站默认集缺库）按用户要求不动。

## 红（在 `dc462b2` 上运行新增测试）

命令：`python C:/Users/kenzh/hark_tasks/memcap.py 2048 node --test Tests/worker-egress-review.test.mjs Tests/worker-egress.test.mjs`

- 5 红：
  - `a rate-limited origin default is unknown, not dead, and the fallback is flagged`：默认线 status=`dead`，无 `originDefaultStatus`。
  - `an HLS default with an unreachable first segment stays an unverified candidate`：选到 `other`，默认线 `first_segment_*` 被判硬失败。
  - `an unlabelled cached source cannot stand in for a labelled origin default`：空标签缓存被当作默认线复用，`sourceFromCache:true`。
  - `a soft probe failure never overwrites a previously verified source`：行变成 `status='fetch_failed'`、`fingerprint=null`。
  - `probing continues past eight failed lines when a later line is playable`：第 9 条没探，返回「线路解析失败」。
- 1 绿：预算守卫（旧版在该夹具下也恰好低于 50）。

## 绿（修复后）

- `python .../memcap.py 2048 node --test Tests/*.test.mjs` → 88 通过 / 0 失败 / 0 跳过。
- `node --check`：`index.js`、`source-selection.js`、`origin-default.js`、`playback-probe.js`、`probe-budget.js`、两份测试文件，全过。
- 新增 6 条全部通过；原有 82 条未删、未跳过、未改断言（`worker-egress.test.mjs` 的预算用例只把
  「只数官方线解析请求」改成了「数所有 fetch」，阈值仍是 50）。

## 改动文件

- `worker/api/src/probe-budget.js`（新增）：真实 fetch 计数，上限 44。
- `worker/api/src/source-selection.js`：软失败分类、线路状态判定、可重试失败集合。
- `worker/api/src/origin-default.js`：重试判定共用可重试集合。
- `worker/api/src/playback-probe.js`：媒体探测每个请求过预算，首片请求预算耗尽单独上报。
- `worker/api/src/index.js`：预算贯穿解析/探测；限流不再标死线；缓存标签精确匹配；软失败不写 sources；取消固定 8 条；响应带 `originDefaultStatus`。
- `Tests/worker-egress-review.test.mjs`（新增）、`Tests/worker-egress.test.mjs`、`ios/REGRESSIONS.md`。
