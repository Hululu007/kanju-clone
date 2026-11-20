# node 测试进程吃满内存（40GB）事件复盘 — 2026-11-20

## 结论（一句话）

不是被测 App 代码死循环：一个**失败的断言**要把夹具 DOM 节点打进报错信息，
Node 的 assert 以 `customInspect: false, depth: 1000` 展开节点，而夹具的 `children` / `parentNode`
互相引用、共享子树被反复展开，报错字符串指数膨胀，把 node 进程吃到 40GB。
失败的根因（草稿版把 failed/paused 渲染进队列）也一并记在下面；修复是让夹具的图边不参与展开。

## 触发版本（保存下来供比对）

| 项 | 值 |
| --- | --- |
| 工作树 | `C:\Users\kenzh\AppData\Local\Temp\kanju-build27`（分支 `fix/ios-0.1.19-build27-downloads`） |
| 被测 AppBootstrap.js | 未提交的草稿补丁 `C:\Users\kenzh\AppData\Local\Temp\kanju-build27-draft-queue.patch`（`index 15f5439..556d9d2`），22:52 落盘；23:57 又被改到 blob `c0a99fc`，两边都复现 |
| 测试文件 | `ios/Tests/downloadQueue.test.mjs` sha256 `e716c38ee27e81362a9d81ab8caaa47174a97bd7896d227cc47d03a092df494c` |
| 夹具 | `ios/Tests/fixture-dom.mjs` sha256 `5691345b1a20eaaa5eade43d5bbb1ec5695d2978d71e87f32efa8c61dcec08f6` |
| Node | v24.22.3，Windows |

草稿版把失败/暂停的任务也渲染进了 `iosMineQueue`（`QUEUE_RANK/QUEUE_TEXT` 加了 `failed`，
`webFailures` 多了可重试行），于是这条用例的第一个断言失败：

```text
assert.equal(queueNode, null, '失败或暂停任务不伪装成正在下载');
```

`queueNode` 是夹具 DOM 节点，不是标量。Node 断言报错会调用 `util.inspect(actual, {
customInspect: false, depth: 1000, maxArrayLength: 1000 })`；节点里 `children` 与 `parentNode`
都可枚举且互相指着，同一个子树在多条路径上重复展开。只有 3 行队列时报错字符串已经
**569,919 字符**；节点再多一点就是几十 GB。进程以
`FATAL ERROR: Committing semi space failed` / `Fatal process out of memory: Worklist::Segment::Create` 结束。

## 对照：正式版本没有这个问题

| 版本 | 命令（全部套 `python C:\Users\kenzh\hark_tasks\memcap.py 2048`） | 结果 |
| --- | --- | --- |
| 4f1b14f（build 26，测试文件 e716c38） | `node --test --test-name-pattern "a failed episode never lets" ios/Tests/downloadQueue.test.mjs` | 1/1 通过，33ms |
| 4f1b14f | `node --test ios/Tests/downloadQueue.test.mjs` | 10/10 通过，3.5s |
| 4712d53（build 27 删除记录，测试文件 e1ee6a27） | 同上单条 | 1/1 通过，44ms |
| 2f3297b（下载失败/队列修复，本分支） | `node --test ios/Tests/*.test.mjs` | 113/113 通过，9.6s |
| 草稿版 AppBootstrap（未提交） | 同上单条 | `memcap` 拦截，1024MB 下 heap OOM、512MB 下 exit `0xC00000FD` |

所以 40GB 报告对应的是**草稿版 + 一条必然失败的断言**，不是当前任何已提交版本；
谁在哪个工作树跑的已经从文件 mtime 和补丁 blob 对上了。

## 修复（本分支 2f3297b 之后）

- `ios/Tests/fixture-dom.mjs`：导出 `describeFixtureNode` / `attachFixtureInspect`，夹具节点打印成
  `[fixture div#iosMineBody]` 这样的单行摘要。
- `ios/Tests/downloadQueue.test.mjs`、`ios/Tests/bootstrap.test.mjs`：每个夹具节点把
  `children` / `parentNode` 改成**不可枚举**（读写行为不变），并挂上单行 inspect 摘要。
  Node 的 assert 虽然忽略自定义 inspect，但不可枚举的图边让它不再展开整棵 DOM。
- 新增回归 `a fixture node prints as one short line so a failed assertion cannot dump the whole DOM`：
  钉住「inspect 是短文本」和「失败断言的报错 < 10000 字符」。旧夹具下同一条断言报错 569,919 字符，
  新夹具下 3,452 字符。没有删测试、跳过测试或放宽断言。

## 修复后的验证（全部套 memcap 2048）

- 本分支 `node --test ios/Tests/*.test.mjs`：113/113 通过。
- 把修复后的夹具复制到草稿版那份代码上再跑同一条失败断言：**52ms 内以普通 AssertionError 失败**，
  内存上限降到 512MB 也只是普通断言失败，不再 OOM —— 红测试还是红，但不会再把机器撑崩。

## 后续规矩

从现在起跑任何测试/脚本/构建都用
`python C:\Users\kenzh\hark_tasks\memcap.py 2048 <原命令>`；
报 `[memcap]` 被杀就按真实死循环/泄漏记为不通过并停止重跑，不调高上限、不用
`--max-old-space-size` 绕开。
