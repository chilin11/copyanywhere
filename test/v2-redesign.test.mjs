import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { start } from '../server.js';

const id = (n) => crypto.randomBytes(n).toString('base64url');
const META = 'bWV0YQ-test-meta-0';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function stream(url) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  const events = [], comments = [];
  const reading = (async () => {
    let buf = '';
    try {
      for await (const chunk of response.body) {
        buf += new TextDecoder().decode(chunk);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
          if (line.startsWith(':')) comments.push(line);
        }
      }
    } catch (e) { if (e.name !== 'AbortError') throw e; }
  })();
  const wait = async (predicate) => {
    for (let i = 0; i < 100; i++) { const event = events.find(predicate); if (event) return event; await delay(10); }
    assert.fail('stream event timed out');
  };
  return { events, comments, wait, close: async () => { controller.abort(); await reading; } };
}

test('v2 snapshots, streams, idempotence, resumable upload and v1 compatibility', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-v2-'));
  const server = await start({ port: 0, host: '127.0.0.1', dataDir, password: 'test', minFreeBytes: 0, maxFileBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024, maxItems: 100, pingMs: 80, logLevel: 'silent' });
  const base = `http://127.0.0.1:${server.address().port}`;
  const sid = id(32), cid = id(12), itemId = id(12), chunkId = id(12);
  const root = `${base}/api/spaces/${sid}`;
  const json = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const post = (item, body = 'cipher') => fetch(`${root}/items`, { method: 'POST', headers: { 'X-Meta': META, 'X-Item-Id': item }, body });
  let v1, v2;
  try {
    let r = await fetch(`${base}/api/spaces`, { method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sid }) });
    assert.equal(r.status, 201);
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.proto, 2);
    let snap = await (await fetch(`${root}/items`)).json();
    assert.equal(snap.rev, 0); assert.match(snap.epoch, /^[A-Za-z0-9_-]{8}$/);
    assert.equal((await fetch(`${root}/items?epoch=${snap.epoch}&rev=0`)).status, 204);
    assert.equal((await fetch(`${root}/events?v=2&cid=bad`)).status, 400);
    v1 = await stream(`${root}/events`);
    v2 = await stream(`${root}/events?v=2&cid=${cid}`);
    const hello = await v2.wait((e) => e.type === 'hello');
    assert.equal(hello.peers, 2); assert.equal(hello.rev, 0);
    await v2.wait((e) => e.type === 'ping');
    const echo = await (await json(`${root}/echo`, { cid, nonce: 'abcdefgh' })).json();
    assert.equal(echo.streams, 1);
    await v2.wait((e) => e.type === 'echo' && e.nonce === 'abcdefgh');
    const pair = await Promise.all([post(itemId), post(itemId)]);
    assert.ok(pair.some((x) => x.status === 201));
    assert.ok(pair.every((x) => [200, 201, 409].includes(x.status)));
    const duplicate = await post(itemId);
    assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).duplicate, true);
    const add = await v2.wait((e) => e.type === 'add' && e.item.id === itemId);
    assert.equal(add.rev, 1);
    snap = await (await fetch(`${root}/items`)).json();
    assert.equal(snap.rev, 1); assert.equal(snap.items.length, 1);
    r = await post('../../invalid'); assert.equal(r.status, 400); assert.equal((await r.json()).code, 'bad_item_id');
    const body = { itemId: chunkId, size: 90, chunk: 40, meta: META };
    r = await json(`${root}/uploads`, body); assert.equal(r.status, 201);
    const session = await r.json(); assert.deepEqual(session.received, []);
    r = await fetch(`${root}/uploads/${session.uploadId}/1`, { method: 'PUT', body: new Uint8Array(40).fill(2) }); assert.equal(r.status, 200);
    r = await json(`${root}/uploads`, body); assert.equal(r.status, 200); assert.deepEqual((await r.json()).received, [1]);
    r = await json(`${root}/uploads`, { ...body, size: 91 }); assert.equal(r.status, 409); assert.equal((await r.json()).code, 'upload_conflict');
    assert.equal((await post(chunkId)).status, 409);
    for (const [index, length] of [[0, 40], [2, 10]]) assert.equal((await fetch(`${root}/uploads/${session.uploadId}/${index}`, { method: 'PUT', body: new Uint8Array(length).fill(index + 1) })).status, 200);
    r = await json(`${root}/uploads/${session.uploadId}/complete`, {}); assert.equal(r.status, 201);
    const completed = await r.json(); assert.equal(completed.id, chunkId); assert.equal(completed.rev, 2);
    r = await json(`${root}/uploads`, body); assert.equal((await r.json()).done, true);
    assert.equal((await (await fetch(`${root}/items/${chunkId}`)).arrayBuffer()).byteLength, 90);
    const diagText = await (await fetch(`${root}/diag`)).text();
    assert.ok(!diagText.includes(sid)); assert.ok(!diagText.includes(cid));
    const diag = JSON.parse(diagText); assert.equal(diag.items, 2); assert.deepEqual(diag.streams, { v1: 1, v2: 1 });
    assert.equal((await fetch(`${root}/items/${itemId}`, { method: 'DELETE' })).status, 200);
    const del = await v2.wait((e) => e.type === 'delete' && e.id === itemId); assert.equal(del.rev, 3);
    await delay(120);
    assert.ok(v1.comments.length > 0);
    assert.ok(v1.events.every((e) => ['usage', 'add', 'delete'].includes(e.type)));
    const missing = await fetch(`${base}/api/spaces/${id(32)}`); assert.equal((await missing.json()).code, 'space_not_found');
    const fallback = await fetch(`${base}/share`, { method: 'POST', redirect: 'manual' }); assert.equal(fallback.headers.get('location'), '/?share=lost');
    const index = JSON.parse(await fs.readFile(path.join(dataDir, 'spaces', sid, 'index.json'), 'utf8'));
    assert.deepEqual(Object.keys(index).sort(), ['created', 'items']);
  } finally {
    await v1?.close(); await v2?.close();
    server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
