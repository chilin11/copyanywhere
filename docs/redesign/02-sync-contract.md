# 02 · 同步协议 v2：API / 事件 / 状态契约、加密兼容、安全与迁移

本篇是**规范**。前后端实现以本篇为准；与现有代码不一致处即为要改的地方。
关键词「必须 / 不得 / 可以」按字面理解。

## 1. 设计目标与取舍

| 目标 | 手段 |
|---|---|
| G1 用户能确认「几台设备在同一空间」 | 空间指纹（客户端从 spaceId 派生）+ 在线设备数（服务端按匿名 cid 计数） |
| G2 收：不丢、不假在线，最坏情况有上界 | 每空间单调 `rev` + 进程 `epoch`；可见心跳携带 `rev`；看门狗 + 轮询降级。**任何漏掉的变更最迟一个心跳周期（25 s）内自愈** |
| G3 发：失败可见、可重试、不重复 | 客户端生成条目 id（幂等键）；发件箱状态机；分块续传 |
| G4 可诊断 | 错误码、空间诊断接口、流回环自测、结构化事件日志 |
| G5 不破坏现有数据、配对链接、旧标签页 | 所有改动为**增量**；v2 事件流按查询参数显式启用；磁盘格式不变 |

明确不做（及原因）：
- **短配对码（6–8 位数字）**：短码熵不足，若用它保护密钥传递，服务器可离线穷举，等于放弃「服务器看不到内容」。正确做法需要 PAKE（SPAKE2/CPace），WebCrypto 无原生支持，需引入并审计第三方实现，与「零依赖」冲突。结论：不做，改用「粘贴配对链接加入」。
- **把密钥放进 cookie / 查询参数 / manifest**：都会让密钥到达服务器或中间代理。**禁止**。
- **持久化 `rev`、事件回放（Last-Event-ID）**：快照 + epoch 已能保证正确性，回放只是省一次全量请求（列表上限 500 条），不值得增加状态。
- **WebSocket**：SSE 已满足单向推送，且能穿过现有隧道/CDN；换协议不解决任何已识别的问题。

## 2. 术语

| 名称 | 定义 |
|---|---|
| `epoch` | 服务进程每次 `start()` 生成的 8 字符随机串。变化 ⇒ 客户端的 `rev` 全部作废，必须重新取快照 |
| `rev` | 每个空间的非负整数，进程内单调递增，**不落盘**。每广播一条 `add` 或 `delete` 事件恰好 +1 |
| 快照 | `{epoch, rev, items[…]}`，某一时刻的完整条目列表 |
| `cid` | 客户端匿名标识，16 字符 base64url。`cid = b64u(SHA-256("copyanywhere/cid\n" + did + "\n" + spaceId))` 的前 16 字符。同一浏览器在同一空间稳定；跨空间不可关联；服务器无法反推 `did` |
| 空间指纹 | 仅客户端展示用：`SHA-256("copyanywhere/fp\n" + spaceId)` 前 20 bit，按 Crockford Base32 显示 4 个字符（如 `K7QM`）。只用于人眼比对「是不是同一个空间」，**不是安全机制** |
| 流 | 一条 `GET …/events` 的 SSE 连接。v1 流 = 不带参数；v2 流 = `?v=2&cid=…` |

## 3. 服务端不变式（实现必须保证，测试必须覆盖）

- **I1** `rev` 只在函数 `emit(spaceId, msg)` 内自增；自增与把该事件写入所有流在**同一个同步代码段**内完成（中间不得有 `await`）。⇒ 每条流上的 `rev` 严格连续递增。
- **I2** 条目数组的修改（push / filter）先于对应事件的 `emit`。⇒ 任意时刻取的快照 `S`，凡 `rev ≤ S.rev` 的事件所描述的变更都已体现在 `S.items` 中。
- **I3** 快照中的 `rev` 与 `items` 在同一同步段读取。
- **I4** v1 流的字节序列除 `add`/`delete` 的 JSON 多一个 `rev` 字段外与现状完全一致（仍是 `: ping` 注释心跳，不收到 `hello`/`ping`/`peers`/`echo`）。
- **I5** 同一 `(spaceId, itemId)` 任一时刻至多一个写入者；条目一旦存在，带同一 id 的再次提交不产生新条目、不产生事件。

由 I1–I3 可得客户端规则的正确性：事件 `rev > S.rev` 的变更可能在也可能不在 `S` 中，因此**客户端应用事件必须幂等**（重复 add 忽略、删除不存在的条目忽略）。

## 4. HTTP API

通用约定（现状，保持）：前缀 `/api`；`:id` 为 43 字符空间 ID；所有响应 `Cache-Control: no-store`；访问某空间的凭据就是知道它的 ID。
新增约定：所有错误响应体为 `{"error": "<给人看的英文短语>", "code": "<机器码>"}`，客户端**只能**依据 `status` + `code` 分支，不得匹配 `error` 文本。

### 4.1 既有接口的增量

| 接口 | 增量 |
|---|---|
| `GET /api/config` | 增加 `proto: 2`、`version: "<package.json version>"`、`pingMs: 25000` |
| `POST /api/spaces` | 无变化（除错误码） |
| `GET /api/spaces/:id` | 响应增加 `epoch`、`rev`、`serverTime`（ms）、`peers`（见 §5.3） |
| `GET /api/spaces/:id/items` | 同上；并支持条件查询（§4.2） |
| `POST /api/spaces/:id/items` | 可选请求头 `X-Item-Id`（§4.3）；成功响应增加 `rev` |
| `POST /api/spaces/:id/uploads` | 请求体可选 `itemId`（§4.4）；响应增加 `received` |
| `POST …/uploads/:uid/complete` | 成功响应增加 `rev` |
| `GET /api/spaces/:id/events` | 可选 `?v=2&cid=<cid>` 启用 v2 流（§5） |
| `DELETE` 各接口、`GET …/items/:itemId`、`PUT …/uploads/:uid/:index` | 无变化（除错误码） |
| `POST /share`（Service Worker 未接管时的服务端回退，`server.js:449`） | 仍为 `303`，但 `Location` 由 `/` 改为 `/?share=lost`，页面据此提示「这次分享没有收到，请重新分享」 |

### 4.2 条件快照 `GET /api/spaces/:id/items?epoch=<e>&rev=<n>`
- 两个参数与服务端当前值都相等 → `204 No Content`，无响应体。
- 否则（含参数缺失）→ `200` 完整快照：
```json
{ "epoch": "q3ZkP0aB", "rev": 17, "serverTime": 1790000000000, "peers": 2,
  "items": [ { "id": "…16…", "ts": 1790000000000, "size": 1234, "meta": "…" } ],
  "usage": { "used": 1234, "total": 5368709120 } }
```
`items` 元素结构不变（不含 `rev`）。

### 4.3 幂等的单请求发送 `POST /api/spaces/:id/items`
请求头：`X-Meta`（不变）、`Content-Type: application/octet-stream`、**可选** `X-Item-Id: <16 字符 base64url>`（由客户端用 CSPRNG 12 字节生成）。

| 情况 | 响应 |
|---|---|
| 不带 `X-Item-Id` | 与现状相同：服务端生成 id，`201` |
| `X-Item-Id` 不符合 `^[A-Za-z0-9_-]{16}$` | `400 bad_item_id`（丢弃请求体） |
| 该 id 的条目已存在 | 丢弃请求体，`200 {id, ts, size, meta, "duplicate": true}`；**不**广播、**不**改 `rev` |
| 该 id 正在被另一个请求或分块会话写入 | 丢弃请求体，`409 in_progress` |
| 其他 | 以该 id 落盘，`201 {id, ts, size, meta, rev}`，`rev` 为对应 `add` 事件的 rev |

已知边界（接受）：条目提交成功后立刻被别的设备删除，而发送方因响应丢失又重发，会重新创建该条目。

### 4.4 幂等/可续传的分块上传 `POST /api/spaces/:id/uploads`
请求体：`{ size, chunk, meta, itemId? }`（前三项不变）。

| 情况 | 响应 |
|---|---|
| 不带 `itemId` | 与现状相同，`201 {uploadId, count, received: []}` |
| `itemId` 格式非法 | `400 bad_item_id` |
| 该 id 的条目已存在 | `200 {done: true, item: {id, ts, size, meta}}` |
| 存在同空间同 `itemId` 的会话，且 `size`、`chunk` 都相同 | 刷新其空闲计时，`200 {uploadId, count, received: [已收到的块序号, 升序]}`（`meta` 以首次为准） |
| 同上但 `size` 或 `chunk` 不同 | `409 upload_conflict` |
| 该 id 正在被单请求写入或正在创建会话 | `409 in_progress` |
| 其他 | 新建会话，`201 {uploadId, count, received: []}` |

会话仍只在内存中：空闲 30 分钟或服务重启即消失（`server.js:35`、`server.js:71-74`）。客户端遇到 `404 upload_not_found` 必须用同一 `itemId` 重新 `POST /uploads`：得到 `done:true` 即成功，否则按返回的 `received` 续传。

### 4.5 新增：空间诊断 `GET /api/spaces/:id/diag`
```json
{ "proto": 2, "version": "0.2.0", "epoch": "q3ZkP0aB", "rev": 17,
  "serverTime": 1790000000000, "uptimeSec": 86400,
  "items": 12, "bytes": 3456789, "lastChange": 1789999990000,
  "streams": { "v1": 0, "v2": 2 }, "peers": 2, "pingMs": 25000, "ttlMs": 86400000 }
```
`lastChange` 为本进程内该空间最近一次 `emit` 的时间，没有则为 `0`。不含任何 IP、cid、元数据。

### 4.6 新增：流回环自测 `POST /api/spaces/:id/echo`
请求体 `{ "cid": "<16>", "nonce": "<8–32 字符 base64url>" }`（上限 1 KB）。
服务端向该空间内 `cid` 相同的**每条 v2 流**写入 `{"type":"echo","nonce":…,"t":<serverTime>}`，响应 `200 {ok: true, streams: <写入的流数>}`。
`cid`/`nonce` 非法 → `400 bad_request`。用途：证明事件能从服务器穿过代理实时到达**这个浏览器**。

### 4.7 错误码表

| status | code | 触发 | 客户端动作 |
|---|---|---|---|
| 400 | `bad_request` `bad_json` `bad_space_id` `bad_meta` `bad_item_id` `bad_cid` `bad_size` `bad_chunk_size` `bad_index` `bad_chunk_length` `bad_chunk` `empty_body` `bad_path` | 请求不合法 | 不重试；属于程序错误，记入诊断 |
| 401 | `unauthorized` | 服务器密码错 | 提示密码不正确 |
| 404 | `space_not_found` | 空间不存在 | 进入「空间不存在」流程（03 篇 §2.6）；**唯一**允许触发该流程的条件 |
| 404 | `item_not_found` | 条目不存在 | 从本地移除该条目 |
| 404 | `upload_not_found` | 分块会话不存在 | 按 §4.4 用同一 `itemId` 重新开始 |
| 404 | `not_found` 或**响应体不是带 `code` 的 JSON** | 路由不存在 / 代理返回的 404 | 视为暂时性故障，退避重试；**不得**触碰本机密钥 |
| 405 | `method_not_allowed` | — | 不重试 |
| 409 | `in_progress` | 同一条目/块正在写入 | 1–2 s 后重试 |
| 409 | `incomplete`（带 `missing`） | 完成时缺块 | 补传 `missing` 后再完成 |
| 409 | `upload_conflict` | 同 `itemId` 参数不同 | 不重试；换新 `itemId` |
| 413 | `too_large` | 超过单文件/单请求/总量上限 | 不重试；提示上限 |
| 429 | `rate_limited` | 密码尝试过多 | 提示 15 分钟后再试 |
| 507 | `storage_busy` | 空间被进行中的上传占满 | 退避重试 |
| 507 | `disk_full` | 服务器磁盘不足 | 不自动重试；提示管理员 |
| 500 | `write_failed` `internal` | 服务器内部错误 | 退避重试 |
| 0 / 超时 | — | 网络层失败 | 退避重试 |

## 5. 事件流

### 5.1 启用方式
`GET /api/spaces/:id/events?v=2&cid=<cid>`。`v=2` 时 `cid` 必须合法，否则 `400 bad_cid`（在写出响应头之前判断）。不带 `v=2` 即 v1 流（I4）。

### 5.2 v2 帧（每帧 `data: <JSON>\n\n`；连接开头仍先发 `retry: 3000\n\n`）

| type | 字段 | 何时 | 说明 |
|---|---|---|---|
| `usage` | `used` `total` | 连接建立时第 1 帧；用量变化后（300 ms 去抖） | 现状不变 |
| `hello` | `proto:2` `version` `epoch` `rev` `t` `peers` `pingMs` | 连接建立时第 2 帧 | `t` 为服务器毫秒时间 |
| `add` | `item:{id,ts,size,meta}` `rev` | 条目落盘后 | |
| `delete` | `id` `rev` | 每删除一个条目一帧（清空 N 条 = N 帧，rev 各 +1） | 与 v1 保持逐条语义 |
| `ping` | `epoch` `rev` `t` `peers` | 每 `pingMs` | 可见心跳；携带当前 `rev` |
| `peers` | `peers` | 该空间流的数量变化后（300 ms 去抖），只发给 v2 流 | |
| `echo` | `nonce` `t` | 见 §4.6，只发给目标 cid | |
| `gone` | — | 空间被删除，随后服务端关闭流 | 现状不变 |

客户端必须忽略未知 `type` 与未知字段。

### 5.3 `peers` 的定义
`peers` = 该空间当前打开的流里，**不同 `cid` 的个数 + v1 流的条数**。流内帧（`hello`/`ping`/`peers`）里的值包含接收者自己，界面显示「另有 `peers − 1` 台在线」；HTTP 快照与 `diag` 里的值是同一个计数，调用者若没有打开流则不含自己，界面**只使用流内帧的值**。同一浏览器开多个标签页只算 1；旧版页面每个标签页算 1（无法去重）。这是近似值，用于让用户发现「对端根本不在这个空间」，不用于任何判定逻辑。

## 6. 客户端同步状态机（规范）

### 6.1 连接状态

| 状态 | 进入条件 | 界面文案 | 行为 |
|---|---|---|---|
| `connecting` | 打开空间 / 重连 | 连接中… | 建立 v2 流 |
| `live` | 收到 `hello`，快照已应用，回环自测通过或尚未判定失败 | ● 实时同步 | 不轮询；看门狗运行 |
| `degraded` | `hello` 8 s 内未到；或回环自测 5 s 无 `echo`；或连续 3 次重连失败 | ◐ 轮询同步 | 可见时每 5 s 条件快照（§4.2）；后台继续尝试恢复流，退避 3→6→12→30 s |
| `offline` | `navigator.onLine === false`，或最近一次请求网络层失败 | ○ 离线，恢复后自动同步 | 监听 `online` / 可见性变化后立即重连 |
| `gone` | 任一接口返回 `404 space_not_found` | 页面级提示 | 停止一切请求 |

### 6.2 变量
`epoch`（字符串或 null）、`applied`（已应用到的 rev，或 null）、`queue`（快照在途时暂存的事件）、`fetching`（是否有快照请求在途）、`lastMsgAt`。

### 6.3 规则
- **R1 建流**：`new EventSource('/api/spaces/'+id+'/events?v=2&cid='+cid)`。
- **R2 收到 `hello`**：若 `hello.epoch !== epoch` 或 `applied === null` 或 `hello.rev !== applied` → `fetchSnapshot()`；记录 `lastMsgAt`；发起一次回环自测（§4.6）。
- **R3 `fetchSnapshot()`**：若 `fetching` 为真则只置「再取一次」标记后返回。否则 `fetching = true`，请求 `GET /items`（`degraded` 轮询时带 `epoch`/`rev` 条件）。期间到达的 `add`/`delete` 进入 `queue`。
- **R4 应用快照 `S`**：
  1. 若 `S.epoch === epoch` 且 `applied !== null` 且 `S.rev < applied` → 这是过期快照，**丢弃**并重新 `fetchSnapshot()`。
  2. 否则以 `S.items` 为准对齐本地：新增缺少的；删除本地有而 `S` 没有的，**但保留**带 `localRev > S.rev` 标记的条目（R7）。
  3. `epoch = S.epoch; applied = S.rev; fetching = false`；按到达顺序重放 `queue`（走 R5），清空。
- **R5 收到 `add`/`delete`（`rev = r`）**：
  - `fetching` 为真 → 入 `queue`。
  - `r ≤ applied` → 忽略。
  - `r === applied + 1` → 幂等应用，`applied = r`。
  - `r > applied + 1` → 有缺口，`fetchSnapshot()`（该事件入 `queue`）。
- **R6 收到 `ping`**：更新 `lastMsgAt`、在线数；若 `ping.epoch !== epoch` 或 `ping.rev !== applied`（且当前不在取快照）→ `fetchSnapshot()`。
- **R7 本机发送成功**（`201` 带 `rev`）：立即把条目加入列表并标记 `localRev = rev`；不修改 `applied`。收到 `200 duplicate` 或 `done:true`（无 `rev`）：加入列表并 `fetchSnapshot()`。
- **R8 看门狗**：每 5 s 检查；`now − lastMsgAt > 2.4 × pingMs`（60 s）→ 关闭流，按 R1 重连。任何帧（含 `usage`、`peers`、`echo`）都刷新 `lastMsgAt`。
- **R9 可见性**：页面变为可见时，若流不是 OPEN → 重连；否则 `fetchSnapshot()`（带条件参数，通常得到 204）。页面隐藏时停止轮询，不主动断流。
- **R10 `onerror`**：`readyState === CLOSED` 时自行退避重连；重连前先 `GET /api/spaces/:id`，仅当 `404 space_not_found` 才进入 `gone`。
- **R11 回环自测**：收到 `hello` 后 `POST /echo`；5 s 内未收到同 `nonce` 的 `echo` → `degraded`，并在诊断面板记「实时通道被缓冲或阻断」；之后每 5 分钟重测，一旦通过回到 `live`。
- **R12 版本**：`hello.version` 与页面加载时 `/api/config` 的 `version` 不同 → 显示「有新版本，点击刷新」横幅（不强制刷新，避免打断上传）。
- **R13 服务端不支持 v2**（`/api/config` 无 `proto` 或 `< 2`）：退回现有 v1 行为并额外每 15 s 全量对齐一次；不得白屏。

### 6.4 一致性保证（验收依据）
在流可用时：新条目经 `add` 事件到达，延迟 = 网络延迟。
在流静默丢帧时：下一个 `ping`（≤ 25 s）的 `rev` 与 `applied` 不等 → 快照补齐。
在流完全不通时：≤ 8 s 进入 `degraded`，之后每 5 s 对齐。
C5 竞态被 R3（快照在途时事件排队）+ R5（按 `rev` 取舍）+ R4.2（`localRev` 保留）消除；R4.1 是防御性规则，正常情况下不会触发。

## 7. 发送（发件箱）状态机

每次发送是一条发件箱记录：`{ itemId, kind, label, size, state, attempts, error }`，`itemId` 在创建记录时生成并在所有重试中保持不变。

```
queued → encrypting → uploading ──201/200──▶ committed（从发件箱移除，条目进入列表）
                          │
                          ├─ 可重试错误 ─▶ waiting(第 n 次, 倒计时) ─▶ uploading …   退避 1,2,4,8,16,30 s，自动最多 6 次
                          ├─ 不可重试错误 ─▶ failed（常驻卡片：重试 / 取回文字 / 丢弃）
                          └─ 用户取消 ─▶ cancelled（移除；有 uploadId 则 DELETE 会话）
```

- 可重试：网络层失败、`409 in_progress`、`429`、`5xx`（`507 disk_full` 除外）、`404 upload_not_found`、不带 `code` 的 404。
- `404 space_not_found` → 连接状态 `gone`，发件箱保留（文字可取回）。
- 页面回到前台或 `online` 事件：所有 `waiting` 记录立即重试。
- 输入框文字在记录进入发件箱后才清空；`failed` 的文字记录提供「取回文字」放回输入框。
- 文字类记录（≤ 64 KB）在 `committed` 之前镜像到 `sessionStorage['ca.outbox']`，页面被系统回收重载后恢复为 `waiting`。文件类记录只在内存。
- 分享入口：SW 缓存在对应记录 `committed` 之后才删除；提示语只在全部 `committed` 后显示「已发送」，否则显示「N 条发送失败」并留在发件箱。
- 发送成功后的常驻反馈以 `peers` 为准：`peers − 1 ≥ 1` →「已保存 · 另有 N 台设备在线」；否则「已保存 · 当前没有其他设备在线」并附「对方看不到？」入口（03 篇 §2.5）。**不得**显示「已送达对方」之类无法证实的措辞。

## 8. 端到端加密与兼容性约束

以下各项**不得改动**；改动任何一项都会让已配对设备、已存内容或已发出的配对链接失效。

| 约束 | 位置 |
|---|---|
| 密钥格式：32 字节随机，base64url 43 字符 | `crypto.js:22-23` |
| HKDF-SHA-256，salt `copyanywhere-v1`，info `copyanywhere/id` 与 `copyanywhere/enc` | `crypto.js:25-34` |
| 配对链接格式 `https://<origin>/#s=<secret>`；密钥只出现在片段中，加载后立即从地址栏移除 | `app.js:813`、`app.js:954-955` |
| 密文布局 `iv(12) ‖ ciphertext ‖ tag(16)`；元数据 AAD `meta`；内容块 AAD `blob:<n>:<i>:<last>` | `crypto.js:37-67` |
| 元数据明文字段 `k name type size dev did n c`（可增不可改；新客户端必须容忍缺字段） | `app.js:602`、`612`、`669` |
| localStorage 键 `ca.secret` `ca.device` `ca.did` `ca.autocopy` 及其含义 | `app.js:8` |
| 服务端 ID 校验 `ID_RE`、`ITEM_RE`、`META_RE` | `server.js:32-34` |
| 磁盘布局 `spaces/<id>/index.json`（`{created, items:[{id,ts,size,meta}]}`）与 `<itemId>.bin` | `server.js:55-57`、`78-88` |

本设计对加密的影响：
- **不新增任何密钥派生或加密算法调用**，不修改 `public/crypto.js`。
- 新增的两个 SHA-256（cid、指纹）输入只含 `did` 与 `spaceId`，不含 secret 与内容密钥；输出不可逆。
- 客户端生成的 `itemId` 不参与加密（块 AAD 用的是元数据里的随机数 `n`，`app.js:669`），所以幂等重发**必须复用同一份已加密元数据与同一 `n`**，以免同一条目出现两套密文。
- 服务器新获得的信息：每空间在线的匿名设备数、客户端生成的随机条目 id。两者都不泄露内容、文件名、设备名。

## 9. 安全

| 项 | 要求 |
|---|---|
| 密钥处置 | 只存在于 URL 片段（瞬时）与 localStorage；不得进入 cookie、查询参数、请求头、日志、诊断导出、`sessionStorage['ca.outbox']` 之外的任何新存储 |
| 配对链接劫持（C1） | 新链接与本机现有密钥不同时，必须先 `GET` 校验目标空间存在，再弹确认框（显示新旧指纹）后才替换；校验失败不动现有密钥 |
| 忘记密钥（C2） | 只有 `404 space_not_found` 才进入「空间不存在」流程；该流程把密钥移到 `ca.secret.prev` 并提供「重试」，由用户点击「在本机移除」才真正删除。「本设备退出」必须同时清除两个键 |
| 路径安全 | `X-Item-Id` / `itemId` 进入文件名（`server.js:57`），必须先过 `ITEM_RE` |
| 日志 | 见 §10；不得包含 IP、完整空间 ID、cid、元数据、条目 id |
| 空间 ID 即访问凭据 | 现状如此（任何知道 ID 的人可读密文、删除条目）。本次**不改变**（改动会使旧客户端失效），但新增接口、日志、诊断导出一律只出现 ID 前 6 位 |
| 滥用面 | `echo` 请求体上限 1 KB，只写给调用者指定 cid 的流；`diag` 只返回计数 |
| CSP / Permissions-Policy | 不放宽（`server.js:37-46`）。前端不得使用内联 `style=""`、内联脚本、外部资源 |
| 明文落地 | 发件箱镜像仅限文字、仅 `sessionStorage`、提交后即删；诊断导出不含任何解密后的内容 |

## 10. 可观测性

### 10.1 服务端结构化事件日志
环境变量 `LOG_LEVEL`：`silent` | `info`（默认）| `debug`。每行一个 JSON，输出到 stdout（systemd/Docker 已收集）。

```json
{"t":"2026-11-11T08:00:00.000Z","ev":"item_added","sp":"Ab3xYz","size":1234,"via":"single","streams":2}
```

| ev | 级别 | 字段 |
|---|---|---|
| `start` | info | `version` `epoch` `spaces` |
| `space_created` / `space_deleted` | info | `sp` |
| `item_added` | info | `sp` `size` `via`(`single`/`chunked`) `streams` |
| `item_duplicate` | info | `sp` `via` |
| `items_removed` | info | `sp` `n` `reason`(`user`/`clear`/`ttl`/`cap`/`evict`) |
| `upload_dropped` | info | `sp` `reason`(`idle`/`abort`/`space_deleted`) |
| `stream_open` / `stream_close` | debug | `sp` `v` `streams` `durSec`(仅 close) |
| `error` | info | `msg` |

`sp` = 空间 ID 前 6 位。**这不是访问日志**：不记录 IP、路径、UA、cid、条目 id。`streams` 让管理员直接回答「手机上传时电脑的页面连着没有」。
（README「服务器不记录访问日志」的表述需相应补一句说明事件日志及 `LOG_LEVEL=silent`，见 05 篇待确认决策 Q1。）

### 10.2 客户端「连接诊断」面板
设置 → 连接诊断，展示并可一键复制（不含密钥、不含完整空间 ID、不含内容）：
空间指纹、空间 ID 前 6 位、本机设备名、是否主屏幕 App、是否安全上下文、协议版本（客户端/服务端）、连接状态及进入时间、`epoch`/`applied`/服务端 `rev`、最近一帧到达距今秒数、回环自测结果与往返毫秒、在线设备数、发件箱各状态计数、元数据解密失败计数（C11）、Service Worker 状态。
数据来源：本地状态 + `GET /diag` + `POST /echo`。

## 11. 迁移与回滚

- **磁盘数据**：无迁移。`index.json` 与 `.bin` 格式不变；`rev`/`epoch` 只在内存。
- **升级**：`install.sh` 原子替换 `server.js` + `public/` 并重启（`install.sh:259-265`）。重启断开所有流 → 旧标签页按 v1 重连继续工作；新页面拿到新 `epoch` 取快照。进行中的分块上传会话丢失（现状如此），新客户端按 §4.4 重新开始。
- **回滚**：换回旧 `server.js` + `public/` 即可，数据无需处理。新前端若仍在某标签页运行，将按 R13 降级。
- **混跑矩阵**

| 客户端 \ 服务端 | 旧 | 新 |
|---|---|---|
| 旧（已打开的标签页） | 现状 | 支持：v1 流不变（I4），多出的 JSON 字段被忽略（`app.js:291-298` 对未知字段/类型无分支） |
| 新 | R13 降级 | 完整 v2 |

- **localStorage**：既有键不变。新增 `ca.secret.prev`（§9）与 `sessionStorage['ca.outbox']`（§7）。
- **部署约束**：安装脚本、打包脚本、Dockerfile 只复制 `server.js`、`package.json`、`public/`（`install.sh:259`、`scripts/bundle.sh:11`、`Dockerfile:9-10`）。因此**后端改动必须全部留在 `server.js`**；前端可在 `public/` 下自由增加模块文件。
