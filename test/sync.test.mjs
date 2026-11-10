// Rules R2–R11 of the client sync engine (public/sync.js), with fake EventSource / clock / fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSync, decideEvent, deriveStatus, keepRevFor, isStaleSnapshot, backoffDelay } from '../public/sync.js';

const flush = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 20; i++) await flush(); }

function harness({ items = () => ({ epoch: 'E1', rev: 0, items: [] }), probe } = {}) {
  let now = 1_000_000, seq = 0, nonceN = 0;
  const timers = new Map();
  const streams = [];
  class FakeES {
    constructor(url) { this.url = url; this.readyState = 0; streams.push(this); }
    close() { this.readyState = 2; this.closed = true; }
    open() { this.readyState = 1; this.onopen?.(); }
    send(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
    fail(closed) { this.readyState = closed ? 2 : 0; this.onerror?.(); }
  }
  const calls = [];
  const pending = [];
  let hold = false;
  const request = async (path, opts = {}) => {
    calls.push({ path, method: opts.method || 'GET', body: opts.body });
    if (path.endsWith('/echo')) return { status: 200, json: async () => ({ ok: true, streams: 1 }) };
    if (/\/items/.test(path)) {
      if (hold) await new Promise((r) => pending.push(r));
      const snap = items(path);
      if (snap instanceof Error) throw snap;
      if (snap === 204) return { status: 204, json: async () => null };
      return { status: 200, json: async () => snap };
    }
    if (probe) { const p = probe(); if (p instanceof Error) throw p; }
    return { status: 200, json: async () => ({}) };
  };
  const log = { added: [], removed: [], snapshots: [], status: [], gone: 0 };
  const sync = createSync({
    spaceId: 'S', cid: 'cid0000000000000', request,
    getConfig: () => ({ proto: 2, version: '1', pingMs: 25000 }),
    hooks: {
      snapshot: async (list, keepRev) => { log.snapshots.push({ ids: list.map((i) => i.id), keepRev }); },
      add: async (item) => { log.added.push(item.id); },
      remove: (id) => { log.removed.push(id); },
      status: (s) => log.status.push(s),
      gone: () => { log.gone++; },
    },
    env: {
      EventSource: FakeES,
      setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
      clearTimeout: (id) => timers.delete(id),
      setInterval: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn, every: ms }); return id; },
      clearInterval: (id) => timers.delete(id),
      now: () => now, hidden: () => false, onLine: () => true, nonce: () => `nonce${String(++nonceN).padStart(4, '0')}`,
    },
  });
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, t] = due;
      now = t.at;
      if (t.every) t.at += t.every; else timers.delete(id);
      t.fn();
      await settle();
    }
    now = end;
    await settle();
  }
  return {
    sync, log, calls, streams, advance, settle,
    es: () => streams[streams.length - 1],
    hold(v) { hold = v; if (!v) while (pending.length) pending.shift()(); },
    lastNonce: () => `nonce${String(nonceN).padStart(4, '0')}`,
  };
}
const add = (id, rev) => ({ type: 'add', item: { id, ts: 1, size: 1, meta: 'm' }, rev });
const hello = (epoch, rev, peers = 2) => ({ type: 'hello', proto: 2, version: '1', epoch, rev, t: 0, peers, pingMs: 25000 });

test('pure rules: R5 decision, R4 stale/keep, status, backoff', () => {
  assert.equal(decideEvent(null, 1), 'gap');
  assert.equal(decideEvent(5, 5), 'ignore');
  assert.equal(decideEvent(5, 6), 'apply');
  assert.equal(decideEvent(5, 8), 'gap');
  assert.equal(isStaleSnapshot('E', 9, { epoch: 'E', rev: 8 }), true);
  assert.equal(isStaleSnapshot('E', 9, { epoch: 'F', rev: 1 }), false);
  assert.equal(keepRevFor('E', { epoch: 'E', rev: 4 }), 4);
  assert.equal(keepRevFor('E', { epoch: 'F', rev: 4 }), undefined);
  assert.equal(deriveStatus({ helloSeen: true, v2: true, echoResult: 'fail' }), 'degraded');
  assert.equal(deriveStatus({ helloSeen: false, failures: 3 }), 'degraded');
  assert.equal(deriveStatus({ offline: true, helloSeen: true }), 'offline');
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(backoffDelay), [3000, 6000, 12000, 30000, 30000, 30000]);
});

test('in-order events apply once; gap triggers a snapshot; queued events replay idempotently', async () => {
  let snap = { epoch: 'E1', rev: 5, items: [] };
  const h = harness({ items: () => snap });
  h.sync.start({ epoch: 'E1', rev: 5, items: [] });
  await h.settle();
  h.es().open();
  h.es().send(hello('E1', 5));
  await h.settle();
  assert.equal(h.calls.filter((c) => c.path.startsWith('/spaces/S/items')).length, 0, 'in sync at hello: no snapshot');
  h.es().send({ type: 'echo', nonce: h.lastNonce(), t: 0 });
  h.es().send(add('a', 6));
  await h.settle();
  assert.deepEqual(h.log.added, ['a']);
  assert.equal(h.sync.status, 'live');
  // gap: rev 8 while applied = 6 -> snapshot; events arriving during the fetch are queued
  snap = { epoch: 'E1', rev: 8, items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  h.hold(true);
  h.es().send(add('c', 8));
  await h.settle();
  h.es().send(add('c', 8)); // duplicate frame
  h.es().send(add('d', 9));
  await h.settle();
  assert.deepEqual(h.log.added, ['a'], 'nothing applied while the snapshot is in flight');
  h.hold(false);
  await h.settle();
  assert.equal(h.log.snapshots.length, 1);
  assert.equal(h.log.snapshots[0].keepRev, 8);
  assert.deepEqual(h.log.added, ['a', 'd'], 'rev <= 8 ignored after snapshot, rev 9 applied exactly once');
  assert.equal(h.sync.info().applied, 9);
  // R6: ping with the same rev does not refetch; a higher rev does
  const before = h.calls.length;
  h.es().send({ type: 'ping', epoch: 'E1', rev: 9, t: 0, peers: 2 });
  await h.settle();
  assert.equal(h.calls.length, before);
  snap = { epoch: 'E1', rev: 10, items: [] };
  h.es().send({ type: 'ping', epoch: 'E1', rev: 10, t: 0, peers: 2 });
  await h.settle();
  assert.match(h.calls.at(-1).path, /items\?epoch=E1&rev=9$/);
  assert.equal(h.sync.info().applied, 10);
});

test('epoch change (server restart) refetches and drops local-rev protection', async () => {
  let snap = { epoch: 'E1', rev: 3, items: [] };
  const h = harness({ items: () => snap });
  h.sync.start({ epoch: 'E1', rev: 3, items: [] });
  await h.settle();
  h.es().open(); h.es().send(hello('E1', 3)); await h.settle();
  h.es().fail(true); await h.settle();
  await h.advance(3000); // backoff 3 s -> probe -> reconnect
  assert.equal(h.streams.length, 2);
  snap = { epoch: 'E2', rev: 1, items: [{ id: 'x' }] };
  h.es().open(); h.es().send(hello('E2', 1)); await h.settle();
  assert.equal(h.log.snapshots.at(-1).keepRev, undefined);
  assert.deepEqual(h.sync.info().epoch, 'E2');
  h.es().send(add('y', 2)); await h.settle();
  assert.deepEqual(h.log.added, ['y']);
});

test('loopback failure degrades, polls every 5 s, retests after 5 min and recovers', async () => {
  const h = harness({ items: () => 204 });
  h.sync.start({ epoch: 'E1', rev: 0, items: [] });
  await h.settle();
  h.es().open(); h.es().send(hello('E1', 0)); await h.settle();
  assert.equal(h.sync.status, 'live');
  await h.advance(5000); // no echo within 5 s
  assert.equal(h.sync.status, 'degraded');
  assert.equal(h.sync.info().echo.result, 'fail');
  const polls = () => h.calls.filter((c) => c.path.startsWith('/spaces/S/items')).length;
  const p0 = polls();
  for (let i = 0; i < 4; i++) h.es().send({ type: 'ping', epoch: 'E1', rev: 0, t: 0, peers: 1 }), await h.advance(5000);
  assert.ok(polls() - p0 >= 3, 'conditional snapshot roughly every 5 s while degraded');
  const echoes = () => h.calls.filter((c) => c.path.endsWith('/echo')).length;
  const e0 = echoes();
  let waited = 0;
  while (echoes() === e0 && waited < 400000) { h.es().send({ type: 'ping', epoch: 'E1', rev: 0, t: 0, peers: 1 }); await h.advance(5000); waited += 5000; }
  assert.equal(echoes(), e0 + 1, 'one retest');
  const sinceFail = waited + 20000; // + the 4 polling steps above
  assert.ok(sinceFail >= 295000 && sinceFail <= 305000, `retest ~5 min after the failure (${sinceFail} ms)`);
  h.es().send({ type: 'echo', nonce: h.lastNonce(), t: 0 }); await h.settle();
  assert.equal(h.sync.status, 'live');
});

test('reconnect backoff 3 → 6 → 12 → 30 s, hello resets it; watchdog reconnects silent streams', async () => {
  const h = harness();
  h.sync.start({ epoch: 'E1', rev: 0, items: [] });
  await h.settle();
  const delays = [];
  for (let i = 0; i < 5; i++) {
    const n = h.streams.length;
    h.es().fail(true); await h.settle();
    let waited = 0;
    while (h.streams.length === n) { await h.advance(1000); waited += 1000; }
    delays.push(waited);
  }
  assert.deepEqual(delays, [3000, 6000, 12000, 30000, 30000]);
  assert.equal(h.sync.status, 'degraded');
  h.es().open(); h.es().send(hello('E1', 0)); await h.settle();
  assert.equal(h.sync.info().failures, 0);
  // silent stream: no frame for > 2.4 × pingMs -> reconnect
  const n = h.streams.length;
  await h.advance(65000);
  assert.ok(h.streams.length > n);
  assert.ok(h.streams[n - 1].closed);
});

test('only space_not_found leads to gone; proxy 404 without code does not', async () => {
  let probeErr = Object.assign(new Error('not found'), { status: 404 });
  const h = harness({ probe: () => probeErr });
  h.sync.start({ epoch: 'E1', rev: 0, items: [] });
  await h.settle();
  h.es().fail(true); await h.settle();
  await h.advance(3000);
  assert.equal(h.log.gone, 0);
  assert.equal(h.streams.length, 2, 'reconnected after a code-less 404');
  probeErr = Object.assign(new Error('space not found'), { status: 404, code: 'space_not_found' });
  h.es().fail(true); await h.settle();
  await h.advance(6000);
  assert.equal(h.log.gone, 1);
  assert.equal(h.sync.status, 'gone');
});
