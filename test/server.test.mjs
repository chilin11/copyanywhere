import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { start, sweep, config } from '../server.js';
import * as c from '../public/crypto.js';

const PW = 'test-password-123';
let server;
let base;
let dataDir;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-test-'));
  server = await start({ port: 0, host: '127.0.0.1', dataDir, password: PW, maxFileBytes: 1024 * 1024, maxSpaceBytes: 3 * 1024 * 1024, maxItems: 5 });
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
const upload = (id, body, meta = 'bWV0YQ') => fetch(`${base}/api/spaces/${id}/items`, {
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
  assert.equal(list.items[0].meta, 'bWV0YQ');

  const dl = await fetch(`${base}/api/spaces/${id}/items/${item.id}`);
  assert.equal(dl.headers.get('cache-control'), 'no-store');
  assert.deepEqual(new Uint8Array(await dl.arrayBuffer()), payload);

  assert.equal((await fetch(`${base}/api/spaces/${id}/items/${item.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/spaces/${id}/items/${item.id}`)).status, 404);

  await new Promise((r) => setTimeout(r, 100));
  ctrl.abort();
  await pump;
  assert.deepEqual(events.map((e) => e.type), ['add', 'delete']);
  assert.equal(events[0].item.id, item.id);
});

test('rejects bad meta, empty and oversize uploads', async () => {
  const id = id43();
  await create(id);
  assert.equal((await upload(id, new Uint8Array(10), 'bad meta!')).status, 400);
  assert.equal((await upload(id, new Uint8Array(0))).status, 400);
  assert.equal((await upload(id, new Uint8Array(1024 * 1024 + 100))).status, 413);
  // streamed body without content-length
  const stream = new ReadableStream({
    start(ctrl) { for (let i = 0; i < 20; i++) ctrl.enqueue(new Uint8Array(64 * 1024)); ctrl.close(); },
  });
  const r = await fetch(`${base}/api/spaces/${id}/items`, { method: 'POST', headers: { 'X-Meta': 'bWV0YQ' }, body: stream, duplex: 'half' })
    .catch(() => null); // server may close the socket early
  if (r) assert.equal(r.status, 413);
  const list = await (await fetch(`${base}/api/spaces/${id}/items`)).json();
  assert.equal(list.items.length, 0);
  const files = await fs.readdir(path.join(dataDir, 'spaces', id));
  assert.deepEqual(files.filter((f) => f !== 'index.json'), []);
});

test('quota evicts oldest items (count and bytes)', async () => {
  const id = id43();
  await create(id);
  const ids = [];
  for (let i = 0; i < 7; i++) ids.push((await (await upload(id, new Uint8Array(1000 + i))).json()).id);
  let list = (await (await fetch(`${base}/api/spaces/${id}/items`)).json()).items;
  assert.deepEqual(list.map((i) => i.id), ids.slice(2));
  for (let i = 0; i < 4; i++) assert.equal((await upload(id, new Uint8Array(1000 * 1000))).status, 201);
  list = (await (await fetch(`${base}/api/spaces/${id}/items`)).json()).items;
  assert.ok(list.reduce((a, i) => a + i.size, 0) <= 3 * 1024 * 1024);
  assert.equal(list.length, 3);
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
