// CopyAnywhere — self-hosted, end-to-end encrypted clipboard / file drop.
// The server only ever stores ciphertext; keys live in the URL fragment on each device.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const MB = 1024 * 1024;

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(+v) && +v > 0 ? +v : d);
const env = process.env;
const totalMb = num(env.MAX_TOTAL_MB, 5120);
export const config = {
  port: num(env.PORT, 8080),
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR || path.join(ROOT, 'data')),
  password: env.PASSWORD || '',
  ttlMs: num(env.TTL_HOURS, 24) * 3600e3,
  maxTotalBytes: Math.floor(totalMb * MB), // all spaces together
  maxFileBytes: Math.floor(Math.min(num(env.MAX_FILE_MB, totalMb), totalMb) * MB),
  maxItems: num(env.MAX_ITEMS, 500), // per space
  minFreeBytes: Math.floor(num(env.MIN_FREE_MB, 512) * MB), // keep this much disk free
  trustProxy: env.TRUST_PROXY !== '0',
};

export const CHUNK_MAX = 16 * MB + 64; // max ciphertext bytes per request (Cloudflare limit is 100 MB)
const GCM_OVERHEAD = 28; // 12-byte IV + 16-byte tag per chunk
const ID_RE = /^[A-Za-z0-9_-]{43}$/;
const ITEM_RE = /^[A-Za-z0-9_-]{16}$/;
const META_RE = /^[A-Za-z0-9_-]{16,16384}$/;
const SESSION_IDLE_MS = 30 * 60e3;

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ---------- state ----------
/** spaceId -> { created, items:[{id,ts,size,meta}], clients:Set<res>, saving:Promise } */
const spaces = new Map();
/** uploadId -> chunked upload session (in memory; lost on restart) */
const sessions = new Map();
const spacesDir = () => path.join(config.dataDir, 'spaces');
const spaceDir = (id) => path.join(spacesDir(), id);
const blobPath = (id, item) => path.join(spaceDir(id), item + '.bin');
const newId = () => crypto.randomBytes(12).toString('base64url');

async function loadAll() {
  await fsp.mkdir(spacesDir(), { recursive: true });
  for (const id of await fsp.readdir(spacesDir())) {
    if (!ID_RE.test(id)) continue;
    let idx = { created: Date.now(), items: [] };
    try { idx = JSON.parse(await fsp.readFile(path.join(spaceDir(id), 'index.json'), 'utf8')); } catch {}
    const items = [];
    for (const it of idx.items || []) {
      try { items.push({ ...it, size: (await fsp.stat(blobPath(id, it.id))).size }); } catch {}
    }
    spaces.set(id, { created: idx.created || Date.now(), items, clients: new Set(), saving: Promise.resolve() });
    for (const f of await fsp.readdir(spaceDir(id))) { // orphans and unfinished uploads
      const m = f.match(/^([A-Za-z0-9_-]{16})\.bin$/);
      if (f !== 'index.json' && !(m && items.some((i) => i.id === m[1]))) await fsp.rm(path.join(spaceDir(id), f), { force: true });
    }
  }
}

function save(id) {
  const s = spaces.get(id);
  if (!s) return Promise.resolve();
  s.saving = s.saving.then(async () => {
    if (!spaces.has(id)) return;
    const tmp = path.join(spaceDir(id), 'index.json.tmp');
    await fsp.writeFile(tmp, JSON.stringify({ created: s.created, items: s.items }));
    await fsp.rename(tmp, path.join(spaceDir(id), 'index.json'));
  }).catch((e) => console.error('save failed', e.message));
  return s.saving;
}

// ---------- storage accounting ----------
const storedBytes = () => { let n = 0; for (const s of spaces.values()) for (const i of s.items) n += i.size; return n; };
let pendingBytes = 0; // reserved by makeRoom() until the caller has accounted for it
const reservedBytes = () => { let n = pendingBytes; for (const u of sessions.values()) n += u.size; return n; };
export const usage = () => ({ used: storedBytes() + reservedBytes(), total: config.maxTotalBytes });

let usageTimer = null;
function broadcastUsage() {
  if (usageTimer) return;
  usageTimer = setTimeout(() => {
    usageTimer = null;
    const line = `data: ${JSON.stringify({ type: 'usage', ...usage() })}\n\n`;
    for (const s of spaces.values()) for (const res of s.clients) res.write(line);
  }, 300);
}

function broadcast(id, msg) {
  const s = spaces.get(id);
  if (!s) return;
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of s.clients) res.write(line);
}

async function removeItems(id, ids) {
  const s = spaces.get(id);
  if (!s || !ids.length) return;
  const set = new Set(ids);
  s.items = s.items.filter((i) => !set.has(i.id));
  await Promise.all(ids.map((i) => fsp.rm(blobPath(id, i), { force: true })));
  await save(id);
  for (const i of ids) broadcast(id, { type: 'delete', id: i });
  broadcastUsage();
}

/** Reserve room for `bytes` more (evicting the oldest items across all spaces, checking real disk space).
 *  Resolves with release(); call it once the bytes are counted elsewhere (item stored / session created) or abandoned. */
let roomLock = Promise.resolve();
function makeRoom(bytes) {
  const run = async () => {
    if (bytes > config.maxTotalBytes) throw httpError(413, 'larger than total storage limit');
    // evicting every stored item would not help: in-flight uploads hold the space
    if (reservedBytes() + bytes > config.maxTotalBytes) throw httpError(507, 'storage busy with other uploads');
    if (storedBytes() + reservedBytes() + bytes > config.maxTotalBytes) {
      const all = [];
      for (const [sid, s] of spaces) for (const i of s.items) all.push({ sid, ...i });
      all.sort((a, b) => a.ts - b.ts);
      let over = storedBytes() + reservedBytes() + bytes - config.maxTotalBytes;
      const bySpace = new Map();
      for (const i of all) {
        if (over <= 0) break;
        if (!bySpace.has(i.sid)) bySpace.set(i.sid, []);
        bySpace.get(i.sid).push(i.id);
        over -= i.size;
      }
      for (const [sid, ids] of bySpace) await removeItems(sid, ids);
      if (storedBytes() + reservedBytes() + bytes > config.maxTotalBytes) throw httpError(507, 'storage busy with other uploads');
    }
    try {
      const st = await fsp.statfs(config.dataDir);
      if (st.bavail * st.bsize - bytes < config.minFreeBytes) throw httpError(507, 'server disk is full');
    } catch (e) { if (e.status) throw e; }
    pendingBytes += bytes;
    let released = false;
    return () => { if (!released) { released = true; pendingBytes -= bytes; } };
  };
  const p = roomLock.then(run, run);
  roomLock = p.catch(() => {});
  return p;
}

async function addItem(id, item) {
  const s = spaces.get(id);
  s.items.push(item);
  const extra = s.items.length - config.maxItems;
  const evict = extra > 0 ? s.items.filter((i) => i.id !== item.id).slice(0, extra).map((i) => i.id) : [];
  await save(id);
  broadcast(id, { type: 'add', item: publicItem(item) });
  if (evict.length) await removeItems(id, evict);
  broadcastUsage();
}

async function dropSession(u) {
  if (!sessions.delete(u.id)) return;
  await fsp.rm(u.part, { force: true });
  broadcastUsage();
}

export async function sweep() {
  const cutoff = Date.now() - config.ttlMs;
  for (const [id, s] of spaces) {
    const old = s.items.filter((i) => i.ts < cutoff).map((i) => i.id);
    if (old.length) await removeItems(id, old);
  }
  for (const u of sessions.values()) {
    if (Date.now() - u.touched > SESSION_IDLE_MS && !u.inflight.size) await dropSession(u);
  }
}

// ---------- helpers ----------
function send(res, status, body, headers = {}) {
  const isJson = body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}
const fail = (res, status, error) => send(res, status, { error });

// cloudflared / Cloudflare set CF-Connecting-IP; otherwise the last X-Forwarded-For hop is the real client.
function clientIp(req) {
  if (config.trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf);
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || '';
}

function readJson(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpError(413, 'too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(httpError(400, 'bad json')); }
    });
    req.on('error', reject);
  });
}

/** Stream the request body into `file` at `start`; resolves with byte count, or {error}. */
function receiveBody(req, file, { flags = 'w', start = 0, limit }) {
  return new Promise((resolve) => {
    let size = 0;
    let done = false;
    const out = fs.createWriteStream(file, { flags, start });
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.unpipe(out); out.destroy(); req.pause(); finish({ error: 413 }); }
    });
    req.on('aborted', () => { out.destroy(); finish({ error: 499 }); });
    req.on('error', () => { out.destroy(); finish({ error: 499 }); });
    out.on('error', () => finish({ error: 500 }));
    out.on('finish', () => finish({ size }));
    req.pipe(out);
  });
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const failures = new Map(); // password brute-force limiter: 10 failures / 15 min per IP
const limited = (ip) => { const f = failures.get(ip); return f && f.until > Date.now() && f.count >= 10; };
function noteFailure(ip) {
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || f.until < now) failures.set(ip, { count: 1, until: now + 15 * 60e3 }); else f.count++;
}

const publicItem = ({ id, ts, size, meta }) => ({ id, ts, size, meta });
const cipherLimit = () => Math.ceil(config.maxFileBytes * 1.001) + 4096; // + per-chunk GCM overhead

// ---------- API ----------
async function api(req, res, parts) {
  const method = req.method;

  if (parts[0] === 'config' && parts.length === 1 && method === 'GET') {
    return send(res, 200, { ttlMs: config.ttlMs, maxFileBytes: config.maxFileBytes, maxTotalBytes: config.maxTotalBytes, chunkMax: CHUNK_MAX });
  }
  if (parts[0] !== 'spaces') return fail(res, 404, 'not found');

  if (parts.length === 1 && method === 'POST') { // create a space (needs the server password)
    const ip = clientIp(req);
    if (limited(ip)) return fail(res, 429, 'too many attempts, try again later');
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!config.password || !safeEqual(auth, config.password)) { noteFailure(ip); return fail(res, 401, 'wrong password'); }
    const { id } = await readJson(req);
    if (!ID_RE.test(String(id || ''))) return fail(res, 400, 'bad id');
    if (!spaces.has(id)) {
      await fsp.mkdir(spaceDir(id), { recursive: true });
      spaces.set(id, { created: Date.now(), items: [], clients: new Set(), saving: Promise.resolve() });
      await save(id);
    }
    return send(res, 201, { ok: true });
  }

  const id = parts[1];
  if (!ID_RE.test(id || '')) return fail(res, 404, 'not found');
  const s = spaces.get(id);
  if (!s) return fail(res, 404, 'space not found');

  if (parts.length === 2 && method === 'GET') return send(res, 200, { created: s.created, items: s.items.map(publicItem), usage: usage() });
  if (parts.length === 2 && method === 'DELETE') {
    broadcast(id, { type: 'gone' });
    for (const c of s.clients) c.end();
    for (const u of [...sessions.values()]) if (u.spaceId === id) await dropSession(u);
    spaces.delete(id);
    await s.saving;
    await fsp.rm(spaceDir(id), { recursive: true, force: true });
    broadcastUsage();
    return send(res, 200, { ok: true });
  }

  if (parts[2] === 'events' && parts.length === 3 && method === 'GET') {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.write(`retry: 3000\n\ndata: ${JSON.stringify({ type: 'usage', ...usage() })}\n\n`);
    s.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25e3); // < Cloudflare's 100 s idle timeout
    req.on('close', () => { clearInterval(ping); s.clients.delete(res); });
    return;
  }

  // ----- chunked uploads: POST /uploads, PUT /uploads/:uid/:index, POST /uploads/:uid/complete, DELETE /uploads/:uid
  if (parts[2] === 'uploads') return uploads(req, res, id, s, parts.slice(3));

  if (parts[2] !== 'items') return fail(res, 404, 'not found');

  if (parts.length === 3 && method === 'GET') return send(res, 200, { items: s.items.map(publicItem), usage: usage() });
  if (parts.length === 3 && method === 'DELETE') {
    await removeItems(id, s.items.map((i) => i.id));
    return send(res, 200, { ok: true });
  }

  if (parts.length === 3 && method === 'POST') { // single-request upload (one chunk)
    const meta = String(req.headers['x-meta'] || '');
    if (!META_RE.test(meta)) return fail(res, 400, 'bad meta');
    const declared = Number(req.headers['content-length']) || 0;
    const limit = Math.min(CHUNK_MAX, cipherLimit());
    if (declared > limit) { res.setHeader('Connection', 'close'); return fail(res, 413, 'too large for a single request'); }
    const release = await makeRoom(declared || limit);
    try {
      const itemId = newId();
      const tmp = blobPath(id, itemId) + '.part';
      const r = await receiveBody(req, tmp, { limit });
      if (r.error || !r.size || !spaces.has(id)) {
        await fsp.rm(tmp, { force: true });
        if (r.error === 499) return;
        if (r.error) { res.setHeader('Connection', 'close'); return fail(res, r.error, r.error === 413 ? 'too large' : 'write failed'); }
        return fail(res, r.size ? 404 : 400, r.size ? 'space not found' : 'empty');
      }
      await fsp.rename(tmp, blobPath(id, itemId));
      const item = { id: itemId, ts: Date.now(), size: r.size, meta };
      release();
      await addItem(id, item);
      return send(res, 201, publicItem(item));
    } finally { release(); }
  }

  const itemId = parts[3];
  if (parts.length !== 4 || !ITEM_RE.test(itemId || '')) return fail(res, 404, 'not found');
  const item = s.items.find((i) => i.id === itemId);
  if (!item) return fail(res, 404, 'item not found');

  if (method === 'GET') {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/octet-stream',
      'Content-Length': item.size,
      'Cache-Control': 'no-store, no-transform',
    });
    fs.createReadStream(blobPath(id, itemId)).on('error', () => res.destroy()).pipe(res);
    return;
  }
  if (method === 'DELETE') { await removeItems(id, [itemId]); return send(res, 200, { ok: true }); }
  return fail(res, 405, 'method not allowed');
}

async function uploads(req, res, id, s, rest) {
  const method = req.method;
  if (rest.length === 0 && method === 'POST') {
    const { size, chunk, meta } = await readJson(req);
    if (!META_RE.test(String(meta || ''))) return fail(res, 400, 'bad meta');
    if (!Number.isSafeInteger(size) || size <= 0) return fail(res, 400, 'bad size');
    if (!Number.isSafeInteger(chunk) || chunk <= GCM_OVERHEAD || chunk > CHUNK_MAX) return fail(res, 400, 'bad chunk size');
    if (size > cipherLimit()) return fail(res, 413, 'file too large');
    const release = await makeRoom(size);
    const itemId = newId();
    const u = {
      id: newId(), spaceId: id, itemId, size, chunk, count: Math.ceil(size / chunk), meta,
      part: blobPath(id, itemId) + '.part', received: new Set(), inflight: new Set(), touched: Date.now(),
    };
    try { await fsp.writeFile(u.part, ''); } catch (e) { release(); throw e; }
    sessions.set(u.id, u);
    release();
    broadcastUsage();
    return send(res, 201, { uploadId: u.id, count: u.count });
  }

  const u = sessions.get(rest[0]);
  if (!u || u.spaceId !== id) { req.resume(); return fail(res, 404, 'upload not found'); }
  u.touched = Date.now();

  if (rest.length === 1 && method === 'DELETE') { await dropSession(u); return send(res, 200, { ok: true }); }

  if (rest.length === 2 && rest[1] === 'complete' && method === 'POST') {
    if (u.inflight.size || u.received.size !== u.count) {
      const missing = [];
      for (let i = 0; i < u.count && missing.length < 50; i++) if (!u.received.has(i)) missing.push(i);
      return send(res, 409, { error: 'incomplete', missing });
    }
    // rename first so the reservation (held by the session) stays counted until the item is
    await fsp.rename(u.part, blobPath(id, u.itemId));
    if (!sessions.delete(u.id) || !spaces.has(id)) { // aborted or space deleted meanwhile
      await fsp.rm(blobPath(id, u.itemId), { force: true });
      return fail(res, 404, 'upload not found');
    }
    const item = { id: u.itemId, ts: Date.now(), size: u.size, meta: u.meta };
    await addItem(id, item); // pushes synchronously, before its first await
    return send(res, 201, publicItem(item));
  }

  if (rest.length === 2 && method === 'PUT' && /^\d+$/.test(rest[1])) {
    const index = Number(rest[1]);
    if (index >= u.count) { req.resume(); return fail(res, 400, 'bad index'); }
    const expected = index < u.count - 1 ? u.chunk : u.size - u.chunk * (u.count - 1);
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) !== expected) { req.resume(); return fail(res, 400, 'bad chunk length'); }
    if (u.received.has(index)) { req.resume(); return send(res, 200, { ok: true, duplicate: true }); }
    if (u.inflight.has(index)) { req.resume(); return fail(res, 409, 'chunk in progress'); }
    u.inflight.add(index);
    let r;
    try { r = await receiveBody(req, u.part, { flags: 'r+', start: index * u.chunk, limit: expected }); }
    finally { u.inflight.delete(index); }
    u.touched = Date.now();
    if (r.error === 499) return;
    if (r.error || r.size !== expected) { res.setHeader('Connection', 'close'); return fail(res, r.error || 400, 'bad chunk'); }
    if (!sessions.has(u.id)) return fail(res, 404, 'upload not found');
    u.received.add(index);
    return send(res, 200, { ok: true });
  }
  req.resume();
  return fail(res, 404, 'not found');
}

// ---------- static ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(req, res, pathname) {
  if (req.method === 'POST' && pathname === '/share') { req.resume(); return send(res, 303, '', { Location: '/' }); }
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method not allowed');
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return fail(res, 400, 'bad path'); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return fail(res, 404, 'not found');
  let st = null;
  try { st = await fsp.stat(file); } catch {}
  if (!st || !st.isFile()) return fail(res, 404, 'not found');
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

// ---------- server ----------
export async function start(overrides = {}) {
  Object.assign(config, overrides);
  if (!config.password) throw new Error('PASSWORD is not set. Set PASSWORD=<long random string> (needed to create spaces).');
  spaces.clear();
  sessions.clear();
  await loadAll();
  await sweep();
  const timer = setInterval(() => sweep().catch((e) => console.error('sweep', e.message)), 60e3);
  timer.unref();

  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://x');
      if (pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
      if (pathname.startsWith('/api/')) return await api(req, res, pathname.slice(5).split('/').filter(Boolean));
      return await serveStatic(req, res, pathname);
    } catch (e) {
      if (e.status) req.resume();
      if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : 'internal error');
      else res.destroy();
      if (!e.status) console.error(e);
    }
  });
  server.requestTimeout = 60 * 60e3;
  server.headersTimeout = 60e3;
  server.keepAliveTimeout = 65e3;
  await new Promise((r) => server.listen(config.port, config.host, r));
  server.on('close', () => clearInterval(timer));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().then((server) => {
    const a = server.address();
    console.log(`CopyAnywhere listening on ${a.address}:${a.port} (data: ${config.dataDir}, limit ${Math.round(config.maxTotalBytes / MB)} MB)`);
    const stop = () => {
      for (const s of spaces.values()) for (const c of s.clients) c.end();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
