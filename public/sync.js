// Sync engine v2 (docs/redesign/02-sync-contract.md §6, rules R1–R13).
// DOM-free on purpose: timers, EventSource and clocks are injectable so the rules can run under `node --test`.

export const HELLO_MS = 8000;          // R2/§6.1: hello must arrive within 8 s
export const ECHO_MS = 5000;           // R11: echo must come back within 5 s
export const ECHO_RETEST_MS = 300000;  // R11: re-test a failed loopback every 5 minutes
export const POLL_MS = 5000;           // degraded: conditional snapshot every 5 s
export const LEGACY_POLL_MS = 15000;   // R13: old server, full re-align every 15 s
export const TICK_MS = 5000;           // R8: watchdog period
export const BACKOFF = [3000, 6000, 12000, 30000];
export const QUEUE_MAX = 2000;

const ES_OPEN = 1, ES_CLOSED = 2;

/** 404 space_not_found is the ONLY trigger for the "space gone" flow (02 §4.7, 05 §1 transition rule). */
export const isMissingSpace = (e) => !!e && e.status === 404 && (e.code === 'space_not_found' || (!e.code && e.message === 'space not found'));
export const isNetworkError = (e) => !!e && e.name !== 'AbortError' && (e.status == null || e.status === 0);

/** R5: what to do with a change event carrying `rev`, given the last applied rev. */
export function decideEvent(applied, rev) {
  if (!Number.isSafeInteger(rev) || applied === null || applied === undefined) return 'gap';
  if (rev <= applied) return 'ignore';
  if (rev === applied + 1) return 'apply';
  return 'gap';
}
/** R4.1: a snapshot older than what we already applied (same epoch) must be discarded. */
export const isStaleSnapshot = (epoch, applied, snap) =>
  snap.epoch === epoch && applied !== null && Number.isSafeInteger(snap.rev) && snap.rev < applied;
/** R4.2: rev below which local-only entries may be dropped; undefined = no protection (epoch changed / legacy). */
export function keepRevFor(epoch, snap) {
  if (!Number.isSafeInteger(snap.rev) || typeof snap.epoch !== 'string') return undefined;
  return epoch === null || snap.epoch === epoch ? snap.rev : undefined;
}
/** §6.1 status derivation from the flags the engine tracks. */
export function deriveStatus(f) {
  if (f.gone) return 'gone';
  if (f.offline) return 'offline';
  if (f.helloSeen && !(f.v2 && f.echoResult === 'fail')) return 'live';
  if (f.helloTimedOut || f.failures >= 3 || f.echoResult === 'fail') return 'degraded';
  return 'connecting';
}
export const backoffDelay = (n) => BACKOFF[Math.min(Math.max(0, n), BACKOFF.length - 1)];

function randomNonce() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * @param {object} o
 * @param {string} o.spaceId
 * @param {string} o.cid
 * @param {() => any} o.getConfig            live /api/config values ({proto, version, pingMs})
 * @param {() => Promise<any>} [o.ensureConfig] retried before each (re)connect if config failed to load
 * @param {(path: string, opts?: any) => Promise<Response>} o.request  throws {status, code} on HTTP errors
 * @param {object} o.hooks  snapshot(items, keepRev) add(item) remove(id) usage(u) peers(n) status(s, info) gone() version(v)
 * @param {object} [o.env]  EventSource setTimeout clearTimeout setInterval clearInterval now hidden() onLine() nonce()
 */
export function createSync(o) {
  const g = globalThis;
  const env = {
    EventSource: g.EventSource,
    setTimeout: (...a) => g.setTimeout(...a), clearTimeout: (t) => g.clearTimeout(t),
    setInterval: (...a) => g.setInterval(...a), clearInterval: (t) => g.clearInterval(t),
    now: () => Date.now(),
    hidden: () => !!g.document?.hidden,
    onLine: () => g.navigator?.onLine !== false,
    nonce: randomNonce,
    ...o.env,
  };
  const { spaceId, cid, hooks } = o;
  const cfg = () => o.getConfig?.() || {};
  const s = {
    stopped: false, gone: false, v2: null, es: null, gen: 0,
    epoch: null, applied: null, streamEpoch: null, seen: { ep: null, rev: -1 },
    queue: [], fetching: false, again: false, chain: Promise.resolve(),
    helloSeen: false, helloTimedOut: false, failures: 0, backoffIdx: 0, offline: false,
    lastMsgAt: 0, lastPoll: 0, snapshotError: null, serverRev: null, peers: null,
    helloTimer: null, reconnectTimer: null, nextRetryAt: 0, tickTimer: null,
    echo: { nonce: null, sentAt: 0, timer: null, result: null, rtt: null, at: 0, streams: null },
    status: null, statusSince: 0, versionSeen: null,
  };

  const flags = () => ({ gone: s.gone, offline: s.offline || !env.onLine(), v2: s.v2, helloSeen: s.helloSeen, helloTimedOut: s.helloTimedOut, failures: s.failures, echoResult: s.echo.result });
  function update() {
    if (s.stopped && !s.gone) return;
    const next = deriveStatus(flags());
    if (next !== s.status) { s.status = next; s.statusSince = env.now(); hooks.status?.(next, info()); }
  }
  function info() {
    const now = env.now();
    return {
      status: s.status, statusSince: s.statusSince, proto: s.v2 ? 2 : 1, epoch: s.epoch, applied: s.applied,
      serverRev: s.serverRev, peers: s.peers, lastFrameAgoMs: s.lastMsgAt ? now - s.lastMsgAt : null,
      readyState: s.es ? s.es.readyState : null, failures: s.failures, helloTimedOut: s.helloTimedOut,
      nextRetryInMs: s.reconnectTimer ? Math.max(0, s.nextRetryAt - now) : null,
      echo: { result: s.echo.pending ? 'pending' : s.echo.result, rttMs: s.echo.rtt, at: s.echo.at, streams: s.echo.streams },
      snapshotError: s.snapshotError, queued: s.queue.length, fetching: s.fetching,
    };
  }

  // ---------- serial work chain: every snapshot apply and every change apply runs here, in order ----------
  function enqueue(fn) {
    s.chain = s.chain.then(async () => { if (!s.stopped) await fn(); }).catch(() => {
      if (s.stopped) return;
      s.fetching = false; // never leave the engine wedged
      env.setTimeout(fetchSnapshot, 1000);
    });
    return s.chain;
  }

  // ---------- R3 / R4 ----------
  function fetchSnapshot() {
    if (s.stopped) return;
    if (s.fetching) { s.again = true; return; }
    s.fetching = true; s.again = false;
    enqueue(runSnapshot);
  }
  async function runSnapshot() {
    let ok = false, stale = false;
    try {
      const cond = s.v2 && s.epoch !== null && s.applied !== null;
      const r = await o.request(`/spaces/${spaceId}/items${cond ? `?epoch=${encodeURIComponent(s.epoch)}&rev=${s.applied}` : ''}`);
      if (s.stopped) return;
      s.lastPoll = env.now(); s.offline = false; s.snapshotError = null;
      if (r.status !== 204) {
        const snap = await r.json();
        if (s.stopped) return;
        if (s.v2 && isStaleSnapshot(s.epoch, s.applied, snap)) stale = true;
        else {
          if (snap.usage) hooks.usage?.(snap.usage);
          // snap.peers is ignored on purpose: the UI only uses stream values (§5.3).
          await hooks.snapshot(Array.isArray(snap.items) ? snap.items : [], s.v2 ? keepRevFor(s.epoch, snap) : undefined);
          if (s.stopped) return;
          if (s.v2 && typeof snap.epoch === 'string' && Number.isSafeInteger(snap.rev)) {
            if (snap.epoch !== s.epoch) s.seen = { ep: snap.epoch, rev: snap.rev };
            s.epoch = snap.epoch; s.applied = snap.rev; s.serverRev = snap.rev;
          }
        }
      }
      ok = true;
    } catch (e) {
      if (s.stopped) return;
      s.lastPoll = env.now();
      if (isMissingSpace(e)) { s.fetching = false; return goGone(); }
      s.snapshotError = e.code || (isNetworkError(e) ? 'network' : `http_${e.status}`);
      if (isNetworkError(e)) s.offline = true;
    } finally {
      s.fetching = false;
    }
    if (ok && !stale) await replay();
    if (stale) env.setTimeout(fetchSnapshot, 300);
    else if (ok && s.again) { s.again = false; fetchSnapshot(); }
    update();
  }
  async function replay() {
    const q = s.queue; s.queue = [];
    // Events from another epoch than the snapshot we just applied are covered (or obsoleted) by it.
    for (const m of q) if (!s.v2 || m._ep === s.epoch) await processChange(m);
  }

  // ---------- R5 ----------
  async function processChange(m) {
    if (s.stopped) return;
    if (!s.v2) { if (m.type === 'add') await hooks.add(m.item); else hooks.remove(m.id); return; }
    if (s.fetching) { pushQueue(m); return; }
    if (m._ep !== s.epoch) {
      // Event from a stream whose epoch differs from what we applied: only meaningful after a snapshot of that epoch.
      if (m._ep === s.streamEpoch) { pushQueue(m); fetchSnapshot(); }
      return;
    }
    const d = decideEvent(s.applied, m.rev);
    if (d === 'ignore') return;
    if (d === 'gap') { pushQueue(m); fetchSnapshot(); return; }
    if (m.type === 'add') await hooks.add(m.item); else hooks.remove(m.id);
    if (!s.stopped && m._ep === s.epoch && s.applied !== null && m.rev === s.applied + 1) s.applied = m.rev;
  }
  function pushQueue(m) {
    s.queue.push(m);
    if (s.queue.length > QUEUE_MAX) s.queue.splice(0, s.queue.length - QUEUE_MAX); // the next snapshot covers what we drop
  }
  function inSync(ep, rev) {
    if (s.epoch === null || s.applied === null || ep !== s.epoch) return false;
    const seen = s.seen.ep === ep ? s.seen.rev : -1;
    return rev === Math.max(s.applied, seen);
  }

  // ---------- stream ----------
  function closeStream() {
    env.clearTimeout(s.helloTimer); s.helloTimer = null;
    if (s.es) { s.es.onopen = s.es.onmessage = s.es.onerror = null; s.es.close(); s.es = null; }
    s.helloSeen = false;
  }
  function clearReconnect() { env.clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
  function armHelloTimer(es) {
    env.clearTimeout(s.helloTimer);
    s.helloTimer = env.setTimeout(() => {
      if (s.es !== es || s.helloSeen) return;
      s.helloTimedOut = true;
      update();
      fetchSnapshot(); // start polling right away (degraded)
    }, HELLO_MS);
  }
  async function connect() {
    if (s.stopped) return;
    const gen = ++s.gen;
    clearReconnect(); closeStream();
    if (o.ensureConfig) { try { await o.ensureConfig(); } catch {} }
    if (s.stopped || gen !== s.gen) return;
    const wasV2 = s.v2;
    s.v2 = cfg().proto >= 2;
    if (wasV2 !== null && wasV2 !== s.v2) { s.epoch = null; s.applied = null; } // server switched protocol
    const es = s.es = new env.EventSource(`/api/spaces/${spaceId}/events${s.v2 ? `?v=2&cid=${encodeURIComponent(cid)}` : ''}`);
    s.lastMsgAt = env.now();
    armHelloTimer(es);
    es.onopen = () => {
      if (s.es !== es) return;
      s.offline = false;
      if (!s.v2) { // R13: legacy stream has no hello; an open stream is the best we know
        env.clearTimeout(s.helloTimer);
        s.helloSeen = true; s.helloTimedOut = false; s.failures = 0; s.backoffIdx = 0;
        fetchSnapshot();
      }
      update();
    };
    es.onmessage = (ev) => { if (s.es === es) onFrame(ev.data); };
    es.onerror = () => { if (s.es === es) onStreamError(es); };
    update();
  }
  function onStreamError(es) {
    s.failures++;
    s.helloSeen = false;
    if (!env.onLine()) s.offline = true;
    if (es.readyState === ES_CLOSED || s.failures >= 3) {
      // Browser gave up, or we are degraded: back off ourselves (3 → 6 → 12 → 30 s).
      closeStream();
      scheduleReconnect();
    } else if (!s.helloTimer) armHelloTimer(es); // browser auto-retries (retry: 3000); go degraded if it takes > 8 s
    if (s.failures >= 3) fetchSnapshot();
    update();
  }
  function scheduleReconnect() {
    clearReconnect();
    const delay = backoffDelay(s.backoffIdx++);
    s.nextRetryAt = env.now() + delay;
    s.reconnectTimer = env.setTimeout(probeAndConnect, delay);
  }
  async function probeAndConnect() {
    s.reconnectTimer = null;
    if (s.stopped) return;
    try {
      await o.request(`/spaces/${spaceId}`); // R10: only space_not_found may lead to "gone"
      s.offline = false;
    } catch (e) {
      if (s.stopped) return;
      if (isMissingSpace(e)) return goGone();
      if (isNetworkError(e)) { s.offline = true; update(); scheduleReconnect(); return; }
    }
    connect();
  }
  function reconnectNow() {
    if (s.stopped) return;
    s.backoffIdx = 0;
    connect();
  }

  function onFrame(data) {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    s.lastMsgAt = env.now(); // R8: any frame counts
    s.offline = false;
    switch (m.type) {
      case 'usage': hooks.usage?.(m); break;
      case 'hello': onHello(m); break;
      case 'ping':
        setPeers(m.peers);
        if (Number.isSafeInteger(m.rev)) s.serverRev = m.rev;
        if (s.v2 && !s.fetching && !inSync(m.epoch, m.rev)) fetchSnapshot(); // R6
        break;
      case 'peers': setPeers(m.peers); break;
      case 'echo': onEcho(m); break;
      case 'add': case 'delete': onChange(m); break;
      case 'gone': goGone(); return;
      default: break; // unknown types are ignored (§5.2)
    }
    update();
  }
  function setPeers(n) {
    if (!Number.isSafeInteger(n) || n < 0) return;
    if (n !== s.peers) { s.peers = n; hooks.peers?.(n); }
  }
  function onHello(m) {
    env.clearTimeout(s.helloTimer); s.helloTimer = null;
    s.helloSeen = true; s.helloTimedOut = false; s.failures = 0; s.backoffIdx = 0;
    s.streamEpoch = typeof m.epoch === 'string' ? m.epoch : null;
    setPeers(m.peers);
    if (Number.isSafeInteger(m.rev)) s.serverRev = m.rev;
    const v = cfg().version;
    if (m.version && v && m.version !== v && s.versionSeen !== m.version) { s.versionSeen = m.version; hooks.version?.(m.version); } // R12
    if (!inSync(m.epoch, m.rev)) fetchSnapshot(); // R2
    startEcho(); // R11
  }
  function onChange(m) {
    if (s.v2) {
      if (!Number.isSafeInteger(m.rev)) { fetchSnapshot(); return; }
      m._ep = s.streamEpoch;
      if (s.seen.ep === m._ep) s.seen.rev = Math.max(s.seen.rev, m.rev); else s.seen = { ep: m._ep, rev: m.rev };
    }
    enqueue(() => processChange(m));
  }

  // ---------- R11 loopback ----------
  function startEcho() {
    if (!s.v2 || !s.helloSeen || !s.es || s.stopped) return;
    const nonce = env.nonce();
    env.clearTimeout(s.echo.timer);
    Object.assign(s.echo, { nonce, sentAt: env.now(), pending: true, streams: null });
    s.echo.timer = env.setTimeout(() => {
      if (s.echo.nonce !== nonce) return;
      Object.assign(s.echo, { nonce: null, pending: false, result: 'fail', at: env.now() });
      update();
      fetchSnapshot();
    }, ECHO_MS);
    o.request(`/spaces/${spaceId}/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cid, nonce }) })
      .then((r) => r.json()).then((j) => { if (s.echo.nonce === nonce) s.echo.streams = j.streams ?? null; })
      .catch((e) => { if (isMissingSpace(e)) goGone(); });
  }
  function onEcho(m) {
    if (!m.nonce || m.nonce !== s.echo.nonce) return;
    env.clearTimeout(s.echo.timer);
    Object.assign(s.echo, { nonce: null, pending: false, result: 'ok', rtt: env.now() - s.echo.sentAt, at: env.now() });
  }

  // ---------- R8 watchdog + polling ----------
  function tick() {
    if (s.stopped) return;
    const now = env.now();
    const pingMs = cfg().pingMs || 25000;
    if (s.v2 && s.es && now - s.lastMsgAt > 2.4 * pingMs) { reconnectNow(); return; }
    if (!env.hidden() && !s.fetching) {
      const status = deriveStatus(flags());
      if ((status === 'degraded' || status === 'offline' || s.snapshotError) && now - s.lastPoll >= POLL_MS) fetchSnapshot();
      else if (!s.v2 && now - s.lastPoll >= LEGACY_POLL_MS) fetchSnapshot();
    }
    if (s.v2 && s.echo.result === 'fail' && s.helloSeen && !s.echo.pending && now - s.echo.at >= ECHO_RETEST_MS) startEcho();
    update();
  }

  function goGone() {
    if (s.gone) return;
    s.gone = true;
    update();
    stop();
    hooks.gone?.();
  }
  function stop() {
    s.stopped = true;
    s.gen++;
    clearReconnect(); closeStream();
    env.clearTimeout(s.echo.timer);
    env.clearInterval(s.tickTimer);
  }

  return {
    /** Begin syncing. `initial` is the snapshot already applied by the caller (GET /spaces/:id), if any. */
    start(initial) {
      if (initial && typeof initial.epoch === 'string' && Number.isSafeInteger(initial.rev) && cfg().proto >= 2) {
        s.epoch = initial.epoch; s.applied = initial.rev; s.serverRev = initial.rev; s.lastPoll = env.now();
      } else if (!initial) s.snapshotError = 'initial';
      s.tickTimer = env.setInterval(tick, TICK_MS);
      connect();
    },
    stop,
    /** R9: page became visible. */
    visible() {
      if (s.stopped) return;
      if (!s.es || s.es.readyState !== ES_OPEN) reconnectNow(); else fetchSnapshot();
    },
    online() { if (s.stopped) return; s.offline = false; reconnectNow(); },
    offline() { if (s.stopped) return; s.offline = true; update(); },
    /** R7: our own upload reported the server is ahead; align if it came without rev. */
    resync: fetchSnapshot,
    retestEcho: startEcho,
    info,
    get status() { return s.status; },
    get peers() { return s.peers; },
    /** test hook */
    _state: s,
  };
}
