# 04 · 后端实施任务（面向初级后端）

规范在 [02-sync-contract.md](02-sync-contract.md)。本篇只讲**怎么做、改哪里、怎么验收**。
行号基于提交 `a9d6495`；前一个任务合并后行号会漂移，请按函数名/注释定位。
本篇中的代码片段是**示意**，未经运行验证；以 02 篇的契约和本篇的验收测试为准。

## 0. 开工前必读

| 规则 | 原因 |
|---|---|
| 后端代码**只改 `server.js`**，不新建后端模块文件 | 安装/打包/镜像只复制 `server.js`、`package.json`、`public/`（`install.sh:259`、`scripts/bundle.sh:11`、`Dockerfile:9-10`） |
| 不加 npm 依赖；不改 `public/crypto.js` | 项目零依赖；加密兼容约束见 02 篇 §8 |
| **不修改 `test/server.test.mjs`** | 它是 v1 兼容性的回归网。它变红 = 你破坏了旧客户端，改你的实现而不是改它。确需修改时先上报 |
| 每个任务新建自己的测试文件 `test/v2-*.test.mjs` | `npm test` 会逐文件各起一个进程（`package.json` 的 `node --test test/*.test.mjs`），互不干扰 |
| 已有响应字段只增不改不删 | 已打开的旧标签页仍在运行旧 JS |
| 「检查是否存在 → 加锁」之间**不得出现 `await`** | Node 单线程，没有 `await` 就没有并发插入点；有了就会出现两个请求同时写同一个文件 |
| 日志与任何新接口都不得输出 IP、完整空间 ID、cid、条目 id、meta | 02 篇 §9 |
| 一个任务一个 PR；合并前 `npm test` 全绿 | — |

每个任务自测命令：`node --test test/<本任务文件>`；提 PR 前跑一次 `npm test`。

依赖关系与顺序：

```
B0 ─▶ B1 ─▶ B2 ─▶ B3 ─▶ B6
              └──▶ B4 ─▶ B5
        B7 可在 B1 之后任意时刻做（若在 B4/B5 之前做，B4/B5 里补上对应日志行）
        B8 无依赖，随时可做
```

规模（估算，非承诺）：B0 小、B1 小、B2 中、B3 中、B4 中、B5 中、B6 小、B7 小、B8 很小。

---

## B0 测试辅助与基线

**文件**：新增 `test/helpers.mjs`（文件名不匹配 `*.test.mjs`，不会被当作测试执行）。不改 `server.js`。

**步骤**
1. 在未做任何改动的工作区运行 `npm test`，把结果（通过数/失败数）贴进 PR 描述作为基线。
2. 新建 `test/helpers.mjs`，导出：
   - `boot(overrides)`：建临时目录，调用 `start({ port: 0, host: '127.0.0.1', dataDir, password: PW, minFreeBytes: 0, ...overrides })`，返回 `{ base, dataDir, server, close }`（参照 `test/server.test.mjs:15-24`）。
   - `PW`、`id43()`（43 字符）、`id16()`（`crypto.randomBytes(12).toString('base64url')`）、`META`（`'bWV0YQ-test-meta-0'`）。
   - `create(base, id)`、`postItem(base, id, body, headers = {})`、`list(base, id, query = '')`。
   - `openStream(base, id, query = '')`：见下方示意。

```js
export async function openStream(base, id, query = '') {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/spaces/${id}/events${query}`, { signal: ctrl.signal });
  const events = []; let comments = 0; const waiters = new Set();
  const done = (async () => {
    if (!res.ok) return;
    const dec = new TextDecoder(); let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          if (frame.startsWith(':')) comments++;
          else if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)));
          for (const w of [...waiters]) w();
        }
      }
    } catch {}
  })();
  /** 等到出现满足 pred 的事件；超时则 reject */
  const next = (pred, ms = 2000) => new Promise((resolve, reject) => {
    const check = () => { const e = events.find(pred); if (e) { stop(); resolve(e); } };
    const timer = setTimeout(() => { stop(); reject(new Error('timeout waiting for event')); }, ms);
    const stop = () => { clearTimeout(timer); waiters.delete(check); };
    waiters.add(check); check();
  });
  return { res, events, comments: () => comments, next, close: async () => { ctrl.abort(); await done; } };
}
```

**验收**
- `npm test` 结果与基线一致（helpers 未被执行为测试）。
- 写一个临时脚本或在 B1 的测试里实际用到 `boot` 与 `openStream` 各一次并通过。

---

## B1 错误码 `code`

**契约**：02 篇 §4 开头、§4.7。**文件**：`server.js`、新增 `test/v2-errors.test.mjs`。

**步骤**
1. `httpError`（`server.js:48`）增加第三个参数：`(status, message, code) => Object.assign(new Error(message), { status, code })`。
2. `fail`（`server.js:199`）改为 `(res, status, error, code) => send(res, status, { error, code: code || DEFAULT_CODE[status] || 'internal' })`，其中
   `DEFAULT_CODE = { 400: 'bad_request', 401: 'unauthorized', 404: 'not_found', 405: 'method_not_allowed', 409: 'conflict', 413: 'too_large', 429: 'rate_limited', 500: 'internal', 507: 'storage_busy' }`。
3. 顶层捕获（`server.js:486`）把 `e.code` 传给 `fail`。
4. 按下表给调用点补上显式 `code`（没列出的用默认值即可）：

| 位置（函数 / 现有 error 文本） | code |
|---|---|
| `makeRoom`：`larger than total storage limit` | `too_large` |
| `makeRoom`：`storage busy with other uploads`（两处） | `storage_busy` |
| `makeRoom`：`server disk is full` | `disk_full` |
| `readJson`：`too large` / `bad json` | `too_large` / `bad_json` |
| 创建空间：`bad id` | `bad_space_id` |
| `api`：`space not found`（两处：`server.js:290`、`345`） | `space_not_found` |
| `api`：`bad meta`；`uploads`：`bad meta` | `bad_meta` |
| `api`：`empty` | `empty_body` |
| `api`：`write failed` | `write_failed` |
| `api`：`item not found` | `item_not_found` |
| `uploads`：`bad size` / `bad chunk size` / `bad index` / `bad chunk length` / `bad chunk` | `bad_size` / `bad_chunk_size` / `bad_index` / `bad_chunk_length` / `bad_chunk` |
| `uploads`：`upload not found`（三处） | `upload_not_found` |
| `uploads`：`chunk in progress` | `in_progress` |
| `uploads`：`{ error: 'incomplete', missing }`（`server.js:405`，用的是 `send`） | 对象里加 `code: 'incomplete'` |
| `serveStatic`：`bad path` | `bad_path` |

注意两行「一行两种情况」的代码：`server.js:344`（413 / 500）要分别给 `too_large` / `write_failed`；`server.js:345`（404 / 400）要分别给 `space_not_found` / `empty_body`。

**验收测试**（`test/v2-errors.test.mjs`，每条断言 `status` 与 `body.code`，并断言 `body.error` 仍是原来的字符串）
1. 错误密码创建空间 → 401 `unauthorized`。
2. `GET /api/spaces/<不存在的合法 id>` → 404 `space_not_found`。
3. `GET /api/nope` → 404 `not_found`；`GET /api/spaces/<id>/nope` → 404 `not_found`。
4. `GET …/items/<不存在的 16 字符 id>` → 404 `item_not_found`。
5. `POST …/items` 的 `X-Meta` 非法 → 400 `bad_meta`；空请求体 → 400 `empty_body`。
6. `PUT …/uploads/<不存在>/0` → 404 `upload_not_found`。
7. 分块未传完就 `complete` → 409 `incomplete` 且 `missing` 仍在。
8. `POST …/uploads` 的 `size: 0` → 400 `bad_size`。
9. `npm test` 全绿（旧测试未改）。

---

## B2 `epoch` / `rev` 与快照

**契约**：02 篇 §2、§3（I1–I3）、§4.1、§4.2。**文件**：`server.js`、新增 `test/v2-rev.test.mjs`。

**步骤**
1. 状态区（`server.js:50` 附近）加 `let epoch = '';`；在 `start()` 里 `Object.assign(config, overrides)` 之后赋值 `epoch = crypto.randomBytes(6).toString('base64url');`。
2. 抽出 `const newSpace = (created, items) => ({ created, items, clients: new Set(), saving: Promise.resolve(), rev: 0, lastChange: 0 });`，替换两处手写对象（`server.js:70`、`server.js:281`）。**不要**把 `rev` 写进 `save()`（`server.js:84` 只序列化 `created` 与 `items`，保持不动）。
3. 新增唯一的 rev 自增点：
```js
const frame = (msg) => `data: ${JSON.stringify(msg)}\n\n`;
/** add / delete 专用：分配 rev 并立即广播。函数体内不得有 await（不变式 I1）。 */
function emit(id, msg) {
  const s = spaces.get(id);
  if (!s) return undefined;
  msg.rev = ++s.rev;
  s.lastChange = Date.now();
  broadcast(id, msg);
  return msg.rev;
}
```
4. `removeItems` 里的 `broadcast(id, { type: 'delete', id: i })`（`server.js:120`）改成 `emit(...)`；`addItem` 里的 `broadcast(id, { type: 'add', … })`（`server.js:166`）改成 `const rev = emit(...)`，并让 `addItem` 最后 `return rev`。`gone` 与 `usage` **不走** `emit`。
5. 新增 `const snapshot = (s) => ({ epoch, rev: s.rev, serverTime: Date.now(), peers: 0, items: s.items.map(publicItem), usage: usage() });`（`peers` 在 B3 改成真实值）。`GET /spaces/:id`（`server.js:292`）返回 `{ created: s.created, ...snapshot(s) }`；`GET /items`（`server.js:324`）返回 `snapshot(s)`。
6. 把查询参数传进 `api`：`server.js:480` 同时解构 `searchParams`，`api(req, res, parts, query)` 增加第 4 个参数。
7. 条件查询：在 `GET /items` 分支里，若 `query.get('epoch') === epoch && query.get('rev') === String(s.rev)` → `return send(res, 204);`。
8. 两处 `201` 响应带上 rev：单请求（`server.js:350-351`）`const rev = await addItem(id, item); return send(res, 201, { ...publicItem(item), rev });`；分块完成（`server.js:414-415`）同理。

**易错点**
- `emit` 必须在数组修改**之后**调用（I2）。`addItem` 现在是「push → await save → 广播」，顺序已满足；不要把 `emit` 挪到 `push` 前面。
- 不要在 `publicItem` 里加 `rev`；条目对象上不要挂 `rev`（否则会被写进 `index.json`）。

**验收测试**（`test/v2-rev.test.mjs`）
1. 新空间：`GET /items` 的 `epoch` 为 8 字符字符串、`rev === 0`、`serverTime` 与本地时间差 < 5 s，原有 `items`/`usage` 字段仍在。
2. 打开 v1 流；上传 1 条 → 响应 `rev === 1`，流上 `add` 事件 `rev === 1`，`GET /items` 的 `rev === 1`；删除它 → `delete` 事件 `rev === 2`，快照 `rev === 2`。
3. 上传 3 条后 `DELETE /items`（清空）→ 流上 3 个 `delete` 事件，`rev` 连续递增；快照 `rev` 等于最后一个事件的 `rev`。
4. 条件查询：带当前 `epoch`+`rev` → 204 且无响应体；`rev` 不对 → 200；`epoch` 不对 → 200；只带一个参数 → 200。
5. 连续性：`Promise.all` 并发上传 20 条（`maxItems` 设为 50）→ 流上收到的 `add` 事件 `rev` 按到达顺序恰为 `1..20`；最终快照 `rev === 20`。
6. 落盘格式不变：读取该空间的 `index.json`，顶层键只有 `created`、`items`；每个条目键只有 `id`、`ts`、`size`、`meta`。
7. 重启：只关闭 HTTP 服务（`server.close`，不要用会删除临时目录的 `close()`），用同一 `dataDir` 再 `start()` → `epoch` 变化、`rev === 0`、条目仍在。
8. `npm test` 全绿。

---

## B3 v2 事件流（`hello` / `ping` / `peers`）与 `/api/config`

**契约**：02 篇 §3（I4）、§5、§4.1。**文件**：`server.js`、`package.json`（仅 `version` 改为 `0.2.0`）、新增 `test/v2-stream.test.mjs`。

**步骤**
1. `config` 增加 `pingMs: 25e3`（测试通过 `start({ pingMs: 80 })` 覆盖）。常量 `const CID_RE = /^[A-Za-z0-9_-]{16}$/;`。
2. 读取版本：`let VERSION = 'dev'; try { VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || 'dev'; } catch {}`。
3. 在线数：
```js
function peerCount(s) {
  const cids = new Set(); let v1 = 0;
  for (const r of s.clients) { if (r.ca?.cid) cids.add(r.ca.cid); else v1++; }
  return cids.size + v1;
}
function peersChanged(id) {              // 300 ms 去抖，只发给 v2 流
  const s = spaces.get(id);
  if (!s || s.peersTimer) return;
  s.peersTimer = setTimeout(() => {
    s.peersTimer = null;
    if (spaces.get(id) !== s) return;
    const line = frame({ type: 'peers', peers: peerCount(s) });
    for (const r of s.clients) if (r.ca?.v === 2) r.write(line);
  }, 300);
}
```
4. 改写事件流分支（`server.js:304-317`）：
   - 最前面：`const v2 = query.get('v') === '2'; const cid = v2 ? String(query.get('cid') || '') : null; if (v2 && !CID_RE.test(cid)) return fail(res, 400, 'bad cid', 'bad_cid');`（必须在 `res.writeHead` 之前）。
   - `writeHead` 与首帧 `retry + usage` 保持原样；`res.ca = { v: v2 ? 2 : 1, cid, since: Date.now() }`；加入 `s.clients`。
   - v2 追加一帧 `hello`：`{ type: 'hello', proto: 2, version: VERSION, epoch, rev: s.rev, t: Date.now(), peers: peerCount(s), pingMs: config.pingMs }`。
   - 心跳定时器间隔用 `config.pingMs`；v2 写 `frame({ type: 'ping', epoch, rev: s.rev, t: Date.now(), peers: peerCount(s) })`，v1 仍写 `': ping\n\n'`。
   - 连接建立后与 `close` 回调里各调用一次 `peersChanged(id)`。
5. `snapshot()` 里的 `peers` 改为 `peerCount(s)`。
6. `GET /api/config`（`server.js:267-269`）增加 `proto: 2, version: VERSION, pingMs: config.pingMs`。**这一步放在最后**：`proto: 2` 一旦对外，前端就会启用 v2。

**易错点**
- v1 流不能收到 `hello`/`ping`/`peers`（`test/server.test.mjs:175` 会因此失败）。
- `peersTimer` 挂在空间对象上没问题，`save()` 不会序列化它；空间被删除后回调里的 `spaces.get(id) !== s` 判断不能省。

**验收测试**（`test/v2-stream.test.mjs`，`boot({ pingMs: 80 })`）
1. v1 流：第 1 个事件是 `usage`；400 ms 内 `comments() >= 2`；事件里没有 `hello`、`ping`、`peers`。
2. v2 流（`?v=2&cid=<id16()>`）：事件顺序前两个为 `usage`、`hello`；`hello` 含 `proto === 2`、`version`（字符串）、`epoch`、`rev`、`t`、`peers === 1`、`pingMs === 80`；400 ms 内收到 ≥ 2 个 `ping` 且 `comments() === 0`。
3. 上传 1 条后，其后到达的 `ping.rev` 等于 `add.rev`，`ping.epoch` 等于 `hello.epoch`。
4. `?v=2`（无 cid）与 `?v=2&cid=short` → 400 `bad_cid`，`Content-Type` 是 JSON 而不是事件流。
5. 在线数：A（cid a）连上 → `hello.peers === 1`；B（cid b）连上 → A 收到 `peers` 事件且值为 2；再用 cid a 开第三条流 → 等 500 ms，A 没有收到值为 3 的 `peers`；开一条 v1 流 → A 收到 `peers === 3`；关闭 B → A 收到 `peers === 2`。
6. `GET /api/config` 含 `proto === 2`、`version`、`pingMs`，原有 4 个字段不变。
7. `npm test` 全绿。

---

## B4 幂等的单请求发送（`X-Item-Id`）

**契约**：02 篇 §3（I5）、§4.3。**文件**：`server.js`、新增 `test/v2-idempotent.test.mjs`。

**步骤**
1. 状态区加 `const inflightItems = new Set(); // "<spaceId>/<itemId>"`，以及
   `const hasSession = (id, itemId) => [...sessions.values()].some((u) => u.spaceId === id && u.itemId === itemId);`
2. 改写单请求上传分支（`server.js:330-353`）。结构必须是：

```js
const meta = …;                                   // 原有校验
const want = req.headers['x-item-id'];
const declared = …; const limit = …;              // 原有 413 预检，保持在加锁之前
let lock = null;
if (want !== undefined) {
  if (!ITEM_RE.test(String(want))) { req.resume(); return fail(res, 400, 'bad item id', 'bad_item_id'); }
  const ex = s.items.find((i) => i.id === want);
  if (ex) { req.resume(); return send(res, 200, { ...publicItem(ex), duplicate: true }); }
  lock = `${id}/${want}`;
  if (inflightItems.has(lock) || hasSession(id, want)) { req.resume(); return fail(res, 409, 'upload in progress', 'in_progress'); }
  inflightItems.add(lock);                        // ← 从上面的 find 到这里没有 await
}
try {
  const release = await makeRoom(declared || limit);   // 可能抛 507：必须在外层 try 里
  try {
    const itemId = want || newId();
    … 原有逻辑不变 …
  } finally { release(); }
} finally { if (lock) inflightItems.delete(lock); }
```

**易错点**
- `makeRoom` 会抛异常；如果它在 `try` 外面，锁永远不释放，该 id 之后永远 409。
- 锁在 `addItem` 之后才释放，而 `addItem` 第一行就同步 `push`，所以不存在「锁已释放但条目还不在列表里」的瞬间。不要调整这个顺序。
- 重复提交时必须 `req.resume()` 把请求体读掉，否则 keep-alive 连接会卡住。

**验收测试**（`test/v2-idempotent.test.mjs`）
1. 同一 `X-Item-Id` 顺序提交两次：第一次 201，`id` 等于提交的值，含 `rev`；第二次 200，`duplicate === true`，`ts` 与第一次相同；`GET /items` 只有 1 条；v2/v1 流上只有 1 个 `add`；第二次之后快照 `rev` 未变。
2. 非法 id（15 字符、17 字符、含 `/` 或 `.`，如 `../../../../etc/p`）→ 400 `bad_item_id`；空间目录下除 `index.json` 外没有新文件。
3. 不带该头 → 201，`id` 为服务端生成的 16 字符（旧行为）。
4. 并发：同一 id 同时发两个请求，其中一个用慢速请求体（`ReadableStream` 分两段、中间等 200 ms，`fetch` 需加 `duplex: 'half'`）→ 两个状态码为 `{201, 409}` 或 `{201, 200}`；最终只有 1 条；目录里没有 `.part` 残留；下载内容等于 201 那次的请求体。
5. 失败后释放锁（请求体为空）：带 id X 提交空体 → 400 `empty_body`；随后带 X 正常提交 → 201。
6. 失败后释放锁（`makeRoom` 抛错）：`boot({ maxFileBytes: 2 MB, maxTotalBytes: 3 MB })`，先建两个分块会话各预留 1.2 MB，再带 id X 提交 1 MB → 507 `storage_busy`；删除会话后带 X 再提交 → 201（不是 409）。
7. 不同空间使用同一 id 互不影响：都 201。
8. `npm test` 全绿。

---

## B5 分块上传的幂等与续传（`itemId`）

**契约**：02 篇 §4.4。**文件**：`server.js`、新增 `test/v2-chunked.test.mjs`。依赖 B4 的 `inflightItems`。

**步骤**（`uploads()` 的创建分支，`server.js:376-393`）
1. 从请求体多解构一个 `itemId: want`。原有 `meta`/`size`/`chunk`/上限校验保持在前。
2. 校验之后、`makeRoom` 之前插入（**这一段没有 `await`**）：
```js
let lock = null;
if (want !== undefined) {
  if (typeof want !== 'string' || !ITEM_RE.test(want)) return fail(res, 400, 'bad item id', 'bad_item_id');
  const ex = s.items.find((i) => i.id === want);
  if (ex) return send(res, 200, { done: true, item: publicItem(ex) });
  const cur = [...sessions.values()].find((u) => u.spaceId === id && u.itemId === want);
  if (cur) {
    if (cur.size !== size || cur.chunk !== chunk) return fail(res, 409, 'upload conflict', 'upload_conflict');
    cur.touched = Date.now();
    return send(res, 200, { uploadId: cur.id, count: cur.count, received: [...cur.received].sort((a, b) => a - b) });
  }
  lock = `${id}/${want}`;
  if (inflightItems.has(lock)) return fail(res, 409, 'upload in progress', 'in_progress');
  inflightItems.add(lock);
}
```
3. 把「`makeRoom` → 建会话 → 响应」整体包进 `try { … } finally { if (lock) inflightItems.delete(lock); }`；会话的 `itemId` 用 `want || newId()`；201 响应体加 `received: []`。
4. 完成分支（`server.js:401-416`）：在缺块检查之后、`fsp.rename` 之前加 `if (u.completing) return fail(res, 409, 'upload in progress', 'in_progress'); u.completing = true;`（防止同一会话并发两次 `complete` 时第二次 rename 抛 500）；`rename` 失败时必须把 `u.completing` 置回 `false` 再抛出，否则该会话会一直 409。响应带 `rev`（B2 已做）。

**易错点**
- 续传分支**不得**再次调用 `makeRoom`（会重复预留空间）。
- `sessions.set` 在 `finally` 释放锁之前同步执行，因此「锁已释放但会话还没登记」的瞬间不存在；不要在两者之间加 `await`。

**验收测试**（`test/v2-chunked.test.mjs`，3 块的小文件，块大小参照 `test/server.test.mjs:230` 附近的现有用例）
1. 带 `itemId` 新建 → 201，`received` 为 `[]`；传完并 `complete` → 201，`id === itemId`，含 `rev`；下载内容正确。
2. 续传：只传第 1 块（序号 1）；用相同参数再次 `POST /uploads` → 200，`uploadId` 与第一次相同，`received` 为 `[1]`；两次之间 `usage.used` 不变。
3. 冲突：同 `itemId`、不同 `size` → 409 `upload_conflict`。
4. 已完成：`complete` 之后同 `itemId` 再 `POST /uploads` → 200 `{ done: true }` 且 `item.id === itemId`。
5. 完成响应丢失的恢复路径：`complete` 成功后再调一次 `complete` → 404 `upload_not_found`；随后 `POST /uploads` → `done: true`。
6. 跨路径互斥：存在 `itemId = X` 的会话时，`POST /items` 带 `X-Item-Id: X` → 409 `in_progress`。
7. 非法 `itemId`（数字、15 字符）→ 400 `bad_item_id`。
8. 不带 `itemId` → 201 且含 `received: []`（旧客户端忽略该字段）。
9. `npm test` 全绿。

---

## B6 诊断接口与流回环自测

**契约**：02 篇 §4.5、§4.6。**文件**：`server.js`、新增 `test/v2-diag.test.mjs`。依赖 B3。

**步骤**
1. 常量 `const NONCE_RE = /^[A-Za-z0-9_-]{8,32}$/;`；`start()` 里记录 `startedAt = Date.now()`。
2. 在 `if (parts[2] !== 'items') return fail(…)`（`server.js:322`）**之前**加两个分支：
   - `parts[2] === 'diag' && parts.length === 3 && method === 'GET'`：按 02 篇 §4.5 返回。`bytes` 为该空间条目 `size` 之和；`streams` 遍历 `s.clients` 按 `r.ca.v` 计数。
   - `parts[2] === 'echo' && parts.length === 3 && method === 'POST'`：`const { cid, nonce } = await readJson(req, 1024);` 校验后向 `r.ca?.v === 2 && r.ca.cid === cid` 的每条流写 `frame({ type: 'echo', nonce, t: Date.now() })`，返回 `{ ok: true, streams: n }`。

**验收测试**（`test/v2-diag.test.mjs`）
1. `diag` 返回 02 篇 §4.5 列出的全部键且类型正确；上传 2 条后 `items === 2`、`bytes` 等于两条 `size` 之和、`rev === 2`、`lastChange > 0`；各开一条 v1 与 v2 流后 `streams` 为 `{ v1: 1, v2: 1 }`、`peers === 2`。
2. `diag` 响应文本中不包含测试用的 cid、完整空间 ID、`127.0.0.1`。
3. 不存在的空间 → 404 `space_not_found`。
4. `echo`：A（cid a）、B（cid b）、C（cid a）、D（v1）都连上；`POST /echo { cid: a, nonce }` → 200 `streams === 2`；A、C 在 1 s 内收到 `echo` 且 `nonce` 一致；B、D 在 300 ms 内没有收到。
5. cid 没有对应的流 → 200 `streams === 0`。
6. `nonce` 过短、`cid` 非法 → 400 `bad_request`。2 KB 的请求体 → 413 `too_large` **或**连接被重置（`readJson` 超限时会销毁连接，`server.js:218`，这是现有行为，两种结果都算通过）；之后再发一个正常请求仍得到 200。
7. `npm test` 全绿。

---

## B7 结构化事件日志

**契约**：02 篇 §10.1。**文件**：`server.js`、新增 `test/v2-log.test.mjs`；可选：`.env.example` 加一行注释说明 `LOG_LEVEL`。

**步骤**
1. `config` 增加 `logLevel: env.LOG_LEVEL || 'info'` 与 `logSink: (line) => console.log(line)`（测试通过 `start({ logSink })` 收集）。
2. 新增：
```js
const sp = (id) => id.slice(0, 6);
function log(ev, fields = {}, level = 'info') {
  if (config.logLevel === 'silent' || (level === 'debug' && config.logLevel !== 'debug')) return;
  config.logSink(JSON.stringify({ t: new Date().toISOString(), ev, ...fields }));
}
```
3. `removeItems(id, ids, reason)` 增加第三个参数并在删除后 `log('items_removed', { sp: sp(id), n: ids.length, reason })`。调用点与取值：`makeRoom` 里 → `evict`；`addItem` 里 → `cap`；`sweep` 里 → `ttl`；清空接口 → `clear`；单条删除接口 → `user`。
4. `dropSession(u, reason)` 同理，`log('upload_dropped', …)`：`sweep` → `idle`；删除空间 → `space_deleted`；`DELETE /uploads/:uid` → `abort`。
5. 其余埋点：`start()` 末尾 `start`；创建/删除空间；`addItem` 成功后 `item_added`（`via` 由调用方传入：`single` / `chunked`；`streams` 为 `s.clients.size`）；B4/B5 的重复分支 `item_duplicate`；事件流建立/关闭（`debug` 级）；顶层捕获的 500 → `error`（只记 `msg`，原有 `console.error(e)` 保留）。

**验收测试**（`test/v2-log.test.mjs`，`boot({ logSink: (l) => lines.push(l) })`）
1. 每一行都能 `JSON.parse`，且含 `t`、`ev`。
2. 依次创建空间、上传、单条删除、再传 2 条后清空 → 出现 `space_created`、`item_added`（`via: 'single'`、`size` 正确、`streams: 0`）、`items_removed`（`reason: 'user', n: 1`）、`items_removed`（`reason: 'clear', n: 2`）。
3. 隐私：全部日志文本中不出现完整空间 ID（只出现前 6 位）、条目 id、`META` 字符串、`127.0.0.1`、请求头里的 `X-Forwarded-For` 值。
4. 默认级别下没有 `stream_open`；`logLevel: 'debug'` 时打开再关闭一条流后出现 `stream_open` 与 `stream_close`（含 `durSec`）。
5. `logLevel: 'silent'` → 没有任何输出。
6. `npm test` 全绿。

---

## B8 分享回退提示

**契约**：02 篇 §4.1 最后一行。**文件**：`server.js`、新增 `test/v2-share.test.mjs`。

**步骤**：`serveStatic` 里 `POST /share` 的回退（`server.js:449`）把 `Location: '/'` 改为 `Location: '/?share=lost'`，其余不变（仍然 `req.resume()` 丢弃请求体、仍然 303）。服务端**不得**尝试保存该请求体：它是未加密的明文。

**验收测试**
1. `POST /share`（`redirect: 'manual'`）→ 303，`Location` 头为 `/?share=lost`。
2. `GET /?share=lost` → 200，返回首页 HTML（查询参数不影响静态文件解析）。
3. 数据目录下没有因该请求产生任何新文件。
4. `npm test` 全绿（`test/server.test.mjs:116-117` 只断言 303）。

---

## 交付清单（每个 PR）
- [ ] 只改了本任务列出的文件
- [ ] 新测试文件覆盖本任务全部验收条目，`node --test test/<文件>` 通过
- [ ] `npm test` 全绿，且 `test/server.test.mjs` 未被修改
- [ ] 响应字段只增不改；v1 流行为未变
- [ ] PR 描述写明：实现了 02 篇哪几节、未覆盖/存疑的点
