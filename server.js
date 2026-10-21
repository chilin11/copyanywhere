// CopyAnywhere — self-hosted, end-to-end encrypted clipboard / file drop.
// The server only ever sees ciphertext: keys live in the URL fragment on each device.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(+v) && +v > 0 ? +v : d);
const env = process.env;
export const config = {
  port: num(env.PORT, 8080),
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR || path.join(ROOT, 'data')),
  password: env.PASSWORD || '',
  ttlMs: num(env.TTL_HOURS, 24) * 3600e3,
  maxFileBytes: Math.floor(num(env.MAX_FILE_MB, 90) * 1024 * 1024),
  maxSpaceBytes: Math.floor(num(env.MAX_SPACE_MB, 1024) * 1024 * 1024),
  maxItems: num(env.MAX_ITEMS, 200),
  trustProxy: env.TRUST_PROXY !== '0',
};

const ID_RE = /^[A-Za-z0-9_-]{43}$/; // 32-byte base64url space id (derived from the secret client-side)
const ITEM_RE = /^[A-Za-z0-9_-]{16}$/;
const META_MAX = 16 * 1024;
const OVERHEAD = 64; // AES-GCM iv + tag

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

// ---------- storage ----------
/** @type {Map<string, {created:number, items:Array<{id:string,ts:number,size:number,meta:string}>, clients:Set<http.ServerResponse>, saving:Promise<void>}>} */
const spaces = new Map();
const spacesDir = () => path.join(config.dataDir, 'spaces');
const spaceDir = (id) => path.join(spacesDir(), id);
const blobPath = (id, item) => path.join(spaceDir(id), item + '.bin');

async function loadAll() {
  await fsp.mkdir(spacesDir(), { recursive: true });
  for (const id of await fsp.readdir(spacesDir())) {
    if (!ID_RE.test(id)) continue;
    let idx = { created: Date.now(), items: [] };
    try {
      idx = JSON.parse(await fsp.readFile(path.join(spaceDir(id), 'index.json'), 'utf8'));
    } catch {}
    const items = [];
    for (const it of idx.items || []) {
      try {
        const st = await fsp.stat(blobPath(id, it.id));
        items.push({ ...it, size: st.size });
      } catch {}
    }
    spaces.set(id, { created: idx.created || Date.now(), items, clients: new Set(), saving: Promise.resolve() });
    // drop orphan blobs / temp files
    for (const f of await fsp.readdir(spaceDir(id))) {
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
    const data = JSON.stringify({ created: s.created, items: s.items });
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, path.join(spaceDir(id), 'index.json'));
  }).catch((e) => console.error('save failed', e.message));
  return s.saving;
}

const bytesOf = (s) => s.items.reduce((a, i) => a + i.size, 0);

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
}

export async function sweep() {
  const cutoff = Date.now() - config.ttlMs;
  for (const [id, s] of spaces) {
    const old = s.items.filter((i) => i.ts < cutoff).map((i) => i.id);
    if (old.length) await removeItems(id, old);
  }
}

// ---------- helpers ----------
function send(res, status, body, headers = {}) {
  const isJson = body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    ...headers,
  });
  res.end(payload);
}
const fail = (res, status, error) => send(res, status, { error });

// Behind one reverse proxy (Caddy / cloudflared) the real client is the LAST X-Forwarded-For entry:
// proxies append, so anything a client injects can only appear earlier in the list.
function clientIp(req) {
  if (config.trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || '';
}

function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// password brute-force limiter: 10 failures / 15 min per IP
const failures = new Map();
function limited(ip) {
  const f = failures.get(ip);
  return f && f.until > Date.now() && f.count >= 10;
}
function noteFailure(ip) {
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || f.until < now) failures.set(ip, { count: 1, until: now + 15 * 60e3 });
  else f.count++;
}

const publicItem = ({ id, ts, size, meta }) => ({ id, ts, size, meta });

// ---------- API ----------
async function api(req, res, parts) {
  const method = req.method;

  if (parts[0] === 'config' && parts.length === 1 && method === 'GET') {
    return send(res, 200, { ttlMs: config.ttlMs, maxFileBytes: config.maxFileBytes, maxSpaceBytes: config.maxSpaceBytes });
  }

  if (parts[0] !== 'spaces') return fail(res, 404, 'not found');

  // create / register a space (needs the server password)
  if (parts.length === 1 && method === 'POST') {
    const ip = clientIp(req);
    if (limited(ip)) return fail(res, 429, 'too many attempts, try again later');
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!config.password || !safeEqual(auth, config.password)) {
      noteFailure(ip);
      return fail(res, 401, 'wrong password');
    }
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

  // GET /api/spaces/:id  -> summary + items
  if (parts.length === 2 && method === 'GET') {
    return send(res, 200, { created: s.created, bytes: bytesOf(s), items: s.items.map(publicItem) });
  }
  // DELETE /api/spaces/:id -> destroy everything
  if (parts.length === 2 && method === 'DELETE') {
    broadcast(id, { type: 'gone' });
    for (const c of s.clients) c.end();
    spaces.delete(id);
    await s.saving;
    await fsp.rm(spaceDir(id), { recursive: true, force: true });
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
    res.write('retry: 3000\n\n');
    s.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25e3);
    req.on('close', () => { clearInterval(ping); s.clients.delete(res); });
    return;
  }

  if (parts[2] !== 'items') return fail(res, 404, 'not found');

  if (parts.length === 3 && method === 'GET') return send(res, 200, { items: s.items.map(publicItem) });

  if (parts.length === 3 && method === 'DELETE') {
    await removeItems(id, s.items.map((i) => i.id));
    return send(res, 200, { ok: true });
  }

  if (parts.length === 3 && method === 'POST') {
    const meta = String(req.headers['x-meta'] || '');
    if (!meta || meta.length > META_MAX || !/^[A-Za-z0-9_-]+$/.test(meta)) return fail(res, 400, 'bad meta');
    const limit = config.maxFileBytes + OVERHEAD;
    const declared = Number(req.headers['content-length']);
    if (declared > limit) { res.setHeader('Connection', 'close'); return fail(res, 413, 'file too large'); }

    const itemId = crypto.randomBytes(12).toString('base64url');
    const tmp = blobPath(id, itemId) + '.part';
    const ok = await new Promise((resolve) => {
      let size = 0;
      let done = false;
      const out = fs.createWriteStream(tmp);
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          req.unpipe(out); out.destroy(); req.pause();
          finish({ error: 413 });
        }
      });
      req.on('aborted', () => { out.destroy(); finish({ error: 499 }); });
      req.on('error', () => { out.destroy(); finish({ error: 499 }); });
      out.on('error', () => finish({ error: 500 }));
      out.on('finish', () => finish({ size }));
      req.pipe(out);
    });
    if (ok.error) {
      await fsp.rm(tmp, { force: true });
      if (ok.error === 499) return;
      res.setHeader('Connection', 'close');
      return fail(res, ok.error, ok.error === 413 ? 'file too large' : 'write failed');
    }
    if (!spaces.has(id)) { await fsp.rm(tmp, { force: true }); return fail(res, 404, 'space not found'); }
    if (ok.size === 0) { await fsp.rm(tmp, { force: true }); return fail(res, 400, 'empty'); }
    await fsp.rename(tmp, blobPath(id, itemId));
    const item = { id: itemId, ts: Date.now(), size: ok.size, meta };
    s.items.push(item);
    // enforce quotas: evict oldest first
    const evict = [];
    let total = bytesOf(s);
    for (const i of s.items) {
      if (i.id === itemId) continue;
      if (total <= config.maxSpaceBytes && s.items.length - evict.length <= config.maxItems) break;
      evict.push(i.id);
      total -= i.size;
    }
    await save(id);
    broadcast(id, { type: 'add', item: publicItem(item) });
    if (evict.length) await removeItems(id, evict);
    if (total > config.maxSpaceBytes) {
      await removeItems(id, [itemId]);
      return fail(res, 413, 'space quota exceeded');
    }
    return send(res, 201, publicItem(item));
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
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(blobPath(id, itemId)).on('error', () => res.destroy()).pipe(res);
    return;
  }
  if (method === 'DELETE') {
    await removeItems(id, [itemId]);
    return send(res, 200, { ok: true });
  }
  return fail(res, 405, 'method not allowed');
}

// ---------- static ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(req, res, pathname) {
  if (req.method === 'POST' && pathname === '/share') {
    // Share target hit without an active service worker: just go home.
    req.resume();
    return send(res, 303, '', { Location: '/' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method not allowed');
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return fail(res, 404, 'not found');
  let st;
  try { st = await fsp.stat(file); } catch { st = null; }
  if (!st || !st.isFile()) return fail(res, 404, 'not found');
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: etag,
  };
  if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = '/';
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
      if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : 'internal error');
      else res.destroy();
      if (!e.status) console.error(e);
    }
  });
  server.requestTimeout = 60 * 60e3; // slow mobile uploads
  server.headersTimeout = 60e3;
  server.keepAliveTimeout = 65e3;
  await new Promise((r) => server.listen(config.port, config.host, r));
  server.on('close', () => clearInterval(timer));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().then((server) => {
    const a = server.address();
    console.log(`CopyAnywhere listening on ${a.address}:${a.port} (data: ${config.dataDir})`);
    const stop = () => {
      for (const s of spaces.values()) for (const c of s.clients) c.end();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
