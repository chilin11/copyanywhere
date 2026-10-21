import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { start, sweep, config } from '../server.js';
import * as c from '../public/crypto.js';

const PW = 'test-password-123';
const MB = 1024 * 1024;
let server;
let base;
let dataDir;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-test-'));
  server = await start({ port: 0, host: '127.0.0.1', dataDir, password: PW, maxFileBytes: 2 * MB, maxTotalBytes: 3 * MB, maxItems: 5, minFreeBytes: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await fs.rm(dataDir, { recursive: true, force: true });
});

const id43 = () => c.b64u(crypto.getRandomValues(new Uint8Array(32)));
const create = (id, pw = PW, ip = '1.1.1.1') => fetch(`${base}/api/spaces`, {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + pw, 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
  body: JSON.stringify({ id }),
});
const upload = (id, body, meta = 'bWV0YQ-test-meta-0') => fetch(`${base}/api/spaces/${id}/items`, {
  method: 'POST', headers: { 'X-Meta': meta, 'Content-Type': 'application/octet-stream' }, body,
});

test('crypto: derive, roundtrip, AAD binding', async () => {
  const s = c.newSecret();
  assert.ok(c.validSecret(s));
  const a = await c.deriveSpace(s);
  const b = await c.deriveSpace(s);
  assert.equal(a.id, b.id);
  assert.match(a.id, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.id, s);
  const data = new TextEncoder().encode('你好 clipboard');
  const ct = await c.encryptBytes(a.key, data, 'blob:x');
  const pt = new Uint8Array(await c.decryptBytes(b.key, ct, 'blob:x'));
  assert.deepEqual(pt, data);
  await assert.rejects(c.decryptBytes(a.key, ct, 'blob:y'));
  const other = await c.deriveSpace(c.newSecret());
  await assert.rejects(c.decryptBytes(other.key, ct, 'blob:x'));
  const m = await c.encryptMeta(a.key, { k: 'text', n: 'abc' });
  assert.deepEqual(await c.decryptMeta(b.key, m), { k: 'text', n: 'abc' });
});

const concat = (arrs) => {
  const out = new Uint8Array(arrs.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
const streamOf = (arrs, split = 4096) => new ReadableStream({
  start(ctrl) {
    const all = concat(arrs);
    for (let o = 0; o < all.length; o += split) ctrl.enqueue(all.slice(o, o + split));
    ctrl.close();
  },
});

test('crypto: chunked encryption round-trips and rejects reorder, truncation, swap', async () => {
  const { key } = await c.deriveSpace(c.newSecret());
  const size = 25_000;
  const data = new Uint8Array(size).map((_, i) => (i * 7 + 3) & 255);
  const meta = { size, c: 10_000, n: 'item1' };
  const count = c.chunkCount(size, meta.c);
  assert.equal(count, 3);
  const parts = [];
  for (let i = 0; i < count; i++) parts.push(await c.encryptChunk(key, new Blob([data]), meta, i));
  assert.equal(parts.reduce((a, p) => a + p.length, 0), c.cipherSize(size, meta.c));

  const out = [];
  let seen = 0;
  await c.decryptStream(key, streamOf(parts, 3333), meta, (p, i) => { assert.equal(i, out.length); out.push(p); }, (n) => { seen = n; });
  assert.deepEqual(concat(out), data);
  assert.equal(seen, c.cipherSize(size, meta.c));

  const none = () => {};
  await assert.rejects(c.decryptStream(key, streamOf([parts[1], parts[0], parts[2]]), meta, none)); // reordered
  await assert.rejects(c.decryptStream(key, streamOf(parts.slice(0, 2)), meta, none), /truncated/);
  await assert.rejects(c.decryptStream(key, streamOf(parts.slice(0, 2)), { ...meta, size: 20_000 }, none)); // last flag
  await assert.rejects(c.decryptStream(key, streamOf(parts), { ...meta, n: 'item2' }, none)); // moved to another item
  await assert.rejects(c.decryptStream(key, streamOf([...parts, new Uint8Array(5)]), meta, none), /trailing/);
  const bad = parts.map((p) => p.slice());
  bad[1][100] ^= 1;
  await assert.rejects(c.decryptStream(key, streamOf(bad), meta, none)); // tampered

  const empty = { size: 0, c: 10_000, n: 'e' };
  const ep = await c.encryptChunk(key, new Blob([]), empty, 0);
  assert.equal(ep.length, c.GCM_OVERHEAD);
  const eo = [];
  await c.decryptStream(key, streamOf([ep]), empty, (p) => eo.push(p));
  assert.equal(eo.length, 1);
  assert.equal(eo[0].length, 0);
});

test('static files are served with strict security headers', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await r.text(), /CopyAnywhere/);
  for (const p of ['/app.js', '/crypto.js', '/sw.js', '/style.css', '/manifest.webmanifest', '/vendor/qrcode.mjs', '/icon-192.png']) {
    assert.equal((await fetch(base + p)).status, 200, p);
  }
  assert.equal((await fetch(base + '/%2e%2e/server.js')).status, 404);
  assert.equal((await fetch(base + '/../server.js')).status, 404);
  const share = await fetch(base + '/share', { method: 'POST', body: 'x', redirect: 'manual' });
  assert.equal(share.status, 303);
});

test('creating a space requires the password and is rate limited', async () => {
  const id = id43();
  assert.equal((await create(id, 'wrong', '9.9.9.9')).status, 401);
  assert.equal((await fetch(`${base}/api/spaces/${id}`)).status, 404);
  assert.equal((await create('short')).status, 400);
  assert.equal((await create(id)).status, 201);
  assert.equal((await create(id)).status, 201); // idempotent
  for (let i = 0; i < 9; i++) await create(id43(), 'wrong', '9.9.9.9');
  assert.equal((await create(id43(), PW, '9.9.9.9')).status, 429);
  assert.equal((await create(id43(), PW, '8.8.8.8')).status, 201);
});

test('upload, list, download, delete, and live events', async () => {
  const id = id43();
  await create(id);
  const events = [];
  const ctrl = new AbortController();
  const es = await fetch(`${base}/api/spaces/${id}/events`, { signal: ctrl.signal });
  assert.equal(es.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = es.body.getReader();
  const pump = (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
        for (const m of buf.matchAll(/^data: (.*)$/gm)) events.push(JSON.parse(m[1]));
        buf = buf.slice(buf.lastIndexOf('\n') + 1);
      }
    } catch {}
  })();

  const payload = new Uint8Array(200_000).map((_, i) => (i * 31 + 7) & 255);
  const up = await upload(id, payload);
  assert.equal(up.status, 201);
  const item = await up.json();
  assert.equal(item.size, payload.length);

  const list = await (await fetch(`${base}/api/spaces/${id}/items`)).json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].meta, 'bWV0YQ-test-meta-0');

  const dl = await fetch(`${base}/api/spaces/${id}/items/${item.id}`);
  assert.equal(dl.headers.get('cache-control'), 'no-store, no-transform');
  assert.deepEqual(new Uint8Array(await dl.arrayBuffer()), payload);

  assert.equal((await fetch(`${base}/api/spaces/${id}/items/${item.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/spaces/${id}/items/${item.id}`)).status, 404);

  await new Promise((r) => setTimeout(r, 450)); // usage updates are debounced (300 ms)
  ctrl.abort();
  await pump;
  assert.equal(events[0].type, 'usage'); // sent on connect
  assert.deepEqual(events.filter((e) => e.type !== 'usage').map((e) => e.type), ['add', 'delete']);
  assert.equal(events.find((e) => e.type === 'add').item.id, item.id);
  const last = events.at(-1);
  assert.equal(last.type, 'usage');
  assert.equal(last.total, 3 * MB);
});

test('rejects bad meta, empty and oversize uploads', async () => {
  const id = id43();
  await create(id);
  assert.equal((await upload(id, new Uint8Array(10), 'bad meta!')).status, 400);
  assert.equal((await upload(id, new Uint8Array(0))).status, 400);
  // server answers 413 and closes before reading the body; a large body may surface as a reset instead
  const over = await upload(id, new Uint8Array(2_300_000)).catch(() => null);
  if (over) assert.equal(over.status, 413);
  // streamed body without content-length
  const stream = new ReadableStream({
    start(ctrl) { for (let i = 0; i < 40; i++) ctrl.enqueue(new Uint8Array(64 * 1024)); ctrl.close(); },
  });
  const r = await fetch(`${base}/api/spaces/${id}/items`, { method: 'POST', headers: { 'X-Meta': 'bWV0YQ-test-meta-0' }, body: stream, duplex: 'half' })
    .catch(() => null); // server may close the socket early
  if (r) assert.equal(r.status, 413);
  const list = await (await fetch(`${base}/api/spaces/${id}/items`)).json();
  assert.equal(list.items.length, 0);
  const files = await fs.readdir(path.join(dataDir, 'spaces', id));
  assert.deepEqual(files.filter((f) => f !== 'index.json'), []);
});

const META = 'bWV0YQ-test-meta-0';
const list = async (id) => (await fetch(`${base}/api/spaces/${id}/items`)).json();
const initUpload = (id, body) => fetch(`${base}/api/spaces/${id}/uploads`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const partFiles = async (id) => (await fs.readdir(path.join(dataDir, 'spaces', id))).filter((f) => f.endsWith('.part'));

test('per-space item cap, and the global byte cap evicts the oldest items across spaces', async () => {
  const a = id43();
  const b = id43();
  await create(a);
  await create(b);
  const ids = [];
  for (let i = 0; i < 7; i++) ids.push((await (await upload(a, new Uint8Array(1000 + i))).json()).id);
  assert.deepEqual((await list(a)).items.map((i) => i.id), ids.slice(2));

  const big = [];
  for (let i = 0; i < 3; i++) big.push((await (await upload(a, new Uint8Array(900_000))).json()).id);
  const up = await upload(b, new Uint8Array(900_000)); // 3.6 MB > 3 MB total -> evicts from space a
  assert.equal(up.status, 201);
  assert.deepEqual((await list(a)).items.map((i) => i.id), big.slice(1));
  const lb = await list(b);
  assert.equal(lb.items.length, 1);
  assert.deepEqual(lb.usage, { used: 2_700_000, total: 3 * MB });
  assert.ok((await (await fetch(`${base}/api/config`)).json()).maxTotalBytes === 3 * MB);
});

test('chunked upload: validation, out of order, duplicate, bad length, incomplete, complete', async () => {
  const id = id43();
  await create(id);
  const size = 250_000;
  const chunk = 100_000;
  const data = new Uint8Array(size).map((_, i) => (i * 13 + 5) & 255);
  const part = (i) => data.slice(i * chunk, Math.min(size, (i + 1) * chunk));

  assert.equal((await initUpload(id, { size, chunk, meta: 'bad meta!' })).status, 400);
  assert.equal((await initUpload(id, { size: 0, chunk, meta: META })).status, 400);
  assert.equal((await initUpload(id, { size, chunk: 10, meta: META })).status, 400);
  assert.equal((await initUpload(id, { size, chunk: 64 * MB, meta: META })).status, 400);
  assert.equal((await initUpload(id, { size: 2_700_000, chunk, meta: META })).status, 413); // > MAX_FILE

  const used0 = (await list(id)).usage.used;
  const r = await initUpload(id, { size, chunk, meta: META });
  assert.equal(r.status, 201);
  const { uploadId, count } = await r.json();
  assert.equal(count, 3);
  assert.equal((await list(id)).usage.used, used0 + size); // reserved up front

  const url = (x) => `${base}/api/spaces/${id}/uploads/${uploadId}/${x}`;
  const put = (i, body) => fetch(url(i), { method: 'PUT', body });
  assert.equal((await put(2, part(2))).status, 200); // last chunk first
  assert.equal((await put(0, part(1).slice(0, 10))).status, 400); // wrong length
  assert.equal((await put(3, part(2))).status, 400); // index out of range
  let done = await fetch(url('complete'), { method: 'POST' });
  assert.equal(done.status, 409);
  assert.deepEqual((await done.json()).missing, [0, 1]);
  assert.equal((await put(1, part(1))).status, 200);
  assert.equal((await put(0, part(0))).status, 200);
  const dup = await put(1, part(1));
  assert.equal(dup.status, 200);
  assert.equal((await dup.json()).duplicate, true);
  assert.equal((await list(id)).items.length, 0); // not visible until complete

  done = await fetch(url('complete'), { method: 'POST' });
  assert.equal(done.status, 201);
  const item = await done.json();
  assert.equal(item.size, size);
  assert.equal(item.meta, META);
  const l = await list(id);
  assert.equal(l.items.length, 1);
  assert.equal(l.usage.used, used0 + size); // reservation became the stored item
  const dl = await fetch(`${base}/api/spaces/${id}/items/${item.id}`);
  assert.deepEqual(new Uint8Array(await dl.arrayBuffer()), data);
  assert.equal((await fetch(url('complete'), { method: 'POST' })).status, 404);
  assert.equal((await put(0, part(0))).status, 404);
  assert.deepEqual(await partFiles(id), []);
});

test('reservations: uploads in flight cannot overcommit; abort and space deletion free them', async () => {
  const id = id43();
  const other = id43();
  await create(id);
  await create(other);
  const r = await initUpload(id, { size: 2 * MB, chunk: MB, meta: META }); // evicts old items to fit
  assert.equal(r.status, 201);
  const { uploadId } = await r.json();
  assert.ok((await list(id)).usage.used <= 3 * MB);
  const keep = (await list(other)).usage.used - 2 * MB; // whatever is still stored

  // 2 MB reserved + 1.2 MB can never fit in 3 MB: refuse without evicting anything
  assert.equal((await upload(other, new Uint8Array(1_200_000))).status, 507);
  assert.equal((await initUpload(other, { size: 1_200_000, chunk: MB, meta: META })).status, 507);
  assert.equal((await list(other)).usage.used, keep + 2 * MB);

  assert.equal((await fetch(`${base}/api/spaces/${id}/uploads/${uploadId}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(await partFiles(id), []);
  assert.equal((await list(other)).usage.used, keep);
  assert.equal((await upload(other, new Uint8Array(1_200_000))).status, 201);

  // deleting a space drops its pending uploads too
  await initUpload(id, { size: MB, chunk: MB, meta: META });
  const before = (await list(other)).usage.used;
  assert.equal((await fetch(`${base}/api/spaces/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await list(other)).usage.used, before - MB);
});

test('items persist to disk, expired items are swept, space deletion', async () => {
  const id = id43();
  await create(id);
  const keep = await (await upload(id, new Uint8Array([1, 2, 3]))).json();

  // persisted to disk
  const idx = JSON.parse(await fs.readFile(path.join(dataDir, 'spaces', id, 'index.json'), 'utf8'));
  assert.equal(idx.items[0].id, keep.id);

  const ttl = config.ttlMs;
  config.ttlMs = -1;
  await sweep();
  config.ttlMs = ttl;
  assert.equal((await (await fetch(`${base}/api/spaces/${id}/items`)).json()).items.length, 0);
  await assert.rejects(fs.stat(path.join(dataDir, 'spaces', id, keep.id + '.bin')));

  assert.equal((await fetch(`${base}/api/spaces/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/spaces/${id}`)).status, 404);
  await assert.rejects(fs.stat(path.join(dataDir, 'spaces', id)));
});
