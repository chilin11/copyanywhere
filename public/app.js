import qrcode from '/vendor/qrcode.mjs';
import {
  b64u, newSecret, validSecret, deriveSpace, encryptMeta, decryptMeta,
  DEFAULT_CHUNK, GCM_OVERHEAD, chunkCount, cipherSize, encryptChunk, decryptStream,
} from '/crypto.js';
import { createSync, isMissingSpace, isNetworkError } from '/sync.js';

const $ = (id) => document.getElementById(id);
const LS = { secret: 'ca.secret', device: 'ca.device', did: 'ca.did', autoCopy: 'ca.autocopy' };
const PREVIEW_MAX = 25 * 1024 * 1024; // auto-decrypt images up to this size
const MEDIA_MAX = 300 * 1024 * 1024; // in-page audio/video preview up to this size
const DISK_STREAM_MIN = 200 * 1024 * 1024; // stream big downloads straight to disk when supported
const PARALLEL = 3;
const SHARE_CACHE = 'ca-share';
const touch = matchMedia('(pointer: coarse)').matches;

let cfg = { ttlMs: 24 * 3600e3, maxFileBytes: 5 * 1024 ** 3, maxTotalBytes: 5 * 1024 ** 3 };
let configLoaded = false;
let space = null; // { secret, id, key, fp, cid }
let sync = null;  // sync engine (sync.js) for the current space
let unread = 0;
/** @type {Map<string, any>} id -> { raw, meta, el, kind, blob?, text?, url?, dl? } */
const entries = new Map();
const undecryptable = new Set(); // item ids whose metadata failed to decrypt (C11)
const outboxState = new Map();   // itemId -> queued|encrypting|uploading|waiting|failed
const newItemId = () => b64u(crypto.getRandomValues(new Uint8Array(12)));
const newNonce = () => b64u(crypto.getRandomValues(new Uint8Array(16)));
const ITEM_ID_RE = /^[A-Za-z0-9_-]{16}$/, NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const validRecord = (r) => !!r && ITEM_ID_RE.test(r.itemId || '') && NONCE_RE.test(r.n || '');

async function loadConfig() {
  if (configLoaded) return;
  cfg = { ...cfg, ...(await (await api('/config')).json()) };
  configLoaded = true;
}

let deviceId = localStorage.getItem(LS.did);

// ---------- utils ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

// stroke icons (lucide-style), inlined so the strict CSP needs no extra requests
const ICONS = {
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  paperclip: '<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 1 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  text: '<path d="M4 7V5h16v2"/><path d="M9 19h6"/><path d="M12 5v14"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 15h10"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
};
const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(name, cls = 'ic') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || ''; // constant markup, never user data
  return svg;
}
const hydrateIcons = (root = document) => {
  for (const el of root.querySelectorAll('i[data-icon]')) el.replaceWith(icon(el.dataset.icon, el.className || 'ic'));
};

/** Button with an icon and a text label; setLabel()/flash() only touch the label. */
function iconBtn(label, name, onclick, cls = 'btn soft sm') {
  return h('button', { class: cls, type: 'button', onclick }, icon(name), h('span', { class: 'lbl' }, label));
}
const setLabel = (btn, text) => { const l = btn.querySelector('.lbl'); if (l) l.textContent = text; else btn.textContent = text; };
function flash(btn, text = '已复制') {
  if (!btn) return;
  const l = btn.querySelector('.lbl');
  const svg = btn.querySelector('svg');
  const old = { text: l?.textContent, svg };
  clearTimeout(btn._flash);
  if (l) l.textContent = text;
  if (svg) svg.replaceWith(icon('check'));
  btn.classList.add('done');
  btn._flash = setTimeout(() => {
    if (l) l.textContent = old.text;
    btn.querySelector('svg')?.replaceWith(old.svg);
    btn.classList.remove('done');
  }, 1600);
}

const KIND = {
  text: { label: '文字', icon: 'text' },
  image: { label: '图片', icon: 'image' },
  file: { label: '文件', icon: 'file' },
};
const hue = (s) => { let x = 7; for (const c of String(s)) x = (x * 31 + c.codePointAt(0)) >>> 0; return x % 360; };
const isPhone = (name) => /iPhone|iPad|Android|手机|平板|phone|pad/i.test(name || '');
function avatar(meta) {
  const el = h('span', { class: 'avatar', title: meta.dev || '' }, icon(isPhone(meta.dev) ? 'phone' : 'monitor'));
  el.style.setProperty('--hue', hue(meta.did || meta.dev || '?'));
  return el;
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
}
function fmtTime(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return '刚刚';
  if (s < 3600) return Math.round(s / 60) + ' 分钟前';
  if (s < 86400) return Math.round(s / 3600) + ' 小时前';
  return new Date(ts).toLocaleString();
}
function fmtLeft(ts) {
  const ms = ts + cfg.ttlMs - Date.now();
  if (ms <= 0) return '即将删除';
  return ms < 3600e3 ? `${Math.ceil(ms / 60e3)} 分钟后删除` : `${Math.round(ms / 3600e3)} 小时后删除`;
}
function fmtEta(sec) {
  if (!isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return `剩余 ${Math.ceil(sec)} 秒`;
  if (sec < 3600) return `剩余 ${Math.ceil(sec / 60)} 分钟`;
  return `剩余 ${(sec / 3600).toFixed(1)} 小时`;
}

function guessDevice() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android 手机' : 'Android 平板';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return '浏览器';
}
const deviceName = () => localStorage.getItem(LS.device) || guessDevice();

function stampName(prefix, mime) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ext = (mime.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5);
  return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

function kindOf(meta) {
  if (meta.k === 'text') return 'text';
  if (/^image\//.test(meta.type || '')) return 'image';
  return 'file';
}
function fileType(meta) {
  const t = meta.type || '';
  const ext = ((meta.name || '').match(/\.([a-z0-9]{1,8})$/i)?.[1] || '').toLowerCase();
  const rules = [
    [t.startsWith('video/') || /^(mp4|mov|mkv|avi|webm|m4v)$/.test(ext), 'violet', '视频'],
    [t.startsWith('audio/') || /^(mp3|m4a|wav|flac|aac|ogg|opus)$/.test(ext), 'pink', '音频'],
    [t === 'application/pdf' || ext === 'pdf', 'red', 'PDF 文档'],
    [/^(zip|rar|7z|gz|tgz|bz2|xz|tar|zst)$/.test(ext), 'amber', '压缩包'],
    [/^(xls|xlsx|csv|tsv|numbers)$/.test(ext), 'green', '表格'],
    [/^(doc|docx|pages|rtf|odt)$/.test(ext), 'blue', '文档'],
    [/^(ppt|pptx|key|odp)$/.test(ext), 'orange', '演示文稿'],
    [/^(apk|exe|msi|dmg|pkg|ipa|deb|rpm|appimage|iso)$/.test(ext), 'lime', '安装包'],
    [t.startsWith('image/'), 'teal', '图片'],
    [t.startsWith('text/') || /^(txt|md|log|json|ya?ml|xml|html?|css|m?js|ts|py|go|rs|java|c|cpp|h|sh|sql)$/.test(ext), 'slate', '文本 / 代码'],
  ];
  const hit = rules.find((r) => r[0]);
  const label = (ext || t.split('/')[1] || 'file').replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase() || 'FILE';
  return { tone: hit ? hit[1] : 'gray', desc: hit ? hit[2] : '文件', label };
}

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, { cache: 'no-store', ...opts });
  if (!r.ok) {
    let msg = r.statusText, code;
    try { const body = await r.json(); msg = body.error || msg; code = body.code; } catch {}
    throw Object.assign(new Error(msg), { status: r.status, code });
  }
  return r;
}
const postJson = (path, body, headers = {}) =>
  api(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

// ---------- views ----------
function showSetup(error) {
  space = null;
  sync?.stop();
  sync = null;
  setStatus(null);
  $('viewMain').hidden = true;
  $('barActions').hidden = true;
  $('viewSetup').hidden = false;
  $('setupProblem').hidden = !error;
  $('setupError').textContent = error || '';
  $('retrySpace').hidden = !localStorage.getItem(LS.secret);
  $('forgetSpace').hidden = !localStorage.getItem(LS.secret) && !localStorage.getItem('ca.secret.prev');
}

function showMain() {
  $('viewSetup').hidden = true;
  $('viewMain').hidden = false;
  $('barActions').hidden = false;
  $('foot').textContent = `端到端加密 · 内容 ${Math.round(cfg.ttlMs / 3600e3)} 小时后自动删除 · 单个文件最大 ${fmtSize(cfg.maxFileBytes)}`;
}

const STATUS_TEXT = { live: '实时同步', degraded: '轮询同步', offline: '离线', connecting: '连接中…', gone: '连接不存在' };
const STATUS_HELP = {
  live: '新内容会立刻出现。',
  degraded: '实时通道暂时不通，每 5 秒同步一次。',
  offline: '页面保持打开时，连接恢复后会尝试同步和重发待发送内容。',
  connecting: '正在连接服务器…',
};
let noticeTimer = null;
function setStatus(state) {
  const s = $('status');
  s.dataset.state = state || 'connecting';
  $('statusText').textContent = STATUS_TEXT[state] || STATUS_TEXT.connecting;
  s.title = (STATUS_HELP[state] || '') + ' 点击查看诊断。';
  // 03 §2.9: explain offline/degraded only after 10 s, hide as soon as it recovers.
  clearTimeout(noticeTimer);
  if (state === 'degraded' || state === 'offline') {
    noticeTimer = setTimeout(() => {
      if (sync?.status !== state) return;
      $('connNoticeText').textContent = state === 'offline'
        ? '暂时无法连接服务器。页面保持打开时，连接恢复后会尝试同步和重发待发送内容。'
        : '实时通道暂时不通，已改为每 5 秒同步一次，新内容可能延迟几秒。';
      $('connNotice').dataset.state = state;
      $('connNotice').hidden = false;
    }, 10000);
  } else $('connNotice').hidden = true;
  renderIdentity();
}

/** Space strip: fingerprint + devices online (stream values only, 02 §5.3). */
function renderIdentity() {
  if (!space) return;
  const fp = $('spaceFp');
  fp.textContent = space.fp;
  fp.style.setProperty('--hue', hue(space.fp));
  const n = sync?.status === 'offline' || sync?.status === 'gone' ? null : sync?.peers ?? null;
  const el = $('spacePeers');
  el.textContent = n === null ? '' : n <= 1 ? ' · 只有本机在线' : ` · ${n} 台在线`;
  el.classList.toggle('muted', n !== null && n <= 1);
}

function setUsage(u) {
  if (!u || !u.total) return;
  const pct = Math.min(100, (u.used / u.total) * 100);
  $('meterText').textContent = `${fmtSize(u.used)} / ${fmtSize(u.total)}`;
  $('meterFill').style.width = pct + '%';
  $('meter').classList.toggle('warn', pct > 85);
}

function refreshCounts() {
  const c = { all: 0, text: 0, image: 0, file: 0 };
  for (const e of entries.values()) { c.all++; c[e.kind]++; }
  $('cntAll').textContent = c.all;
  $('cntText').textContent = c.text;
  $('cntImage').textContent = c.image;
  $('cntFile').textContent = c.file;
  $('empty').hidden = c.all > 0 || $('transfers').children.length > 0 || undecryptable.size > 0;
  $('undecryptable').hidden = !undecryptable.size;
  $('undecryptableText').textContent = `有 ${undecryptable.size} 条内容无法解密（可能已损坏，或不是用当前 Token 加密的）`;
}

// ---------- new-content hints (03 §2.8) ----------
const hiddenFresh = new Map(); // kind -> count of new items hidden by the active filter
let freshAbove = 0;            // new items above the viewport
const currentFilter = () => $('feed').dataset.filter || 'all';
function setFilter(filter) {
  for (const c of $('chips').children) c.classList.toggle('active', c.dataset.filter === filter);
  $('feed').dataset.filter = filter;
  if (filter === 'all') hiddenFresh.clear(); else hiddenFresh.delete(filter);
  renderFreshHints();
}
function feedTopHidden() { return $('feed').getBoundingClientRect().top < 0; }
function noteFresh(entry) {
  const f = currentFilter();
  if (f !== 'all' && f !== entry.kind) hiddenFresh.set(entry.kind, (hiddenFresh.get(entry.kind) || 0) + 1);
  else if (feedTopHidden()) freshAbove++;
  renderFreshHints();
}
function renderFreshHints() {
  const total = [...hiddenFresh.values()].reduce((a, b) => a + b, 0);
  $('filterHint').hidden = !total;
  if (total) {
    const kinds = [...hiddenFresh.keys()];
    $('filterHintText').textContent = kinds.length === 1 ? `有 ${total} 条新的${KIND[kinds[0]].label}` : `有 ${total} 条新内容被筛选隐藏`;
    $('filterHintView').dataset.filter = kinds.length === 1 ? kinds[0] : 'all';
  }
  $('freshPill').hidden = !freshAbove;
  $('freshPillText').textContent = `↑ ${freshAbove} 条新内容`;
}
function clearFeed() {
  for (const id of [...entries.keys()]) dropEntry(id);
  undecryptable.clear();
  hiddenFresh.clear(); freshAbove = 0;
  renderFreshHints(); refreshCounts();
}

function bumpUnread() {
  if (!document.hidden) return;
  unread++;
  document.title = `(${unread}) CopyAnywhere`;
}

// ---------- space lifecycle ----------
const missingSpace = isMissingSpace;
async function digest(text) { return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); }
async function fingerprint(id) {
  const b = await digest('copyanywhere/fp\n' + id);
  const n = (b[0] << 12) | (b[1] << 4) | (b[2] >> 4);
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  return [15, 10, 5, 0].map((shift) => alphabet[(n >> shift) & 31]).join('');
}
async function openSpace(secret) {
  const { id, key } = await deriveSpace(secret);
  const fp = await fingerprint(id);
  const cid = b64u(await digest(`copyanywhere/cid\n${deviceId}\n${id}`)).slice(0, 16);
  sync?.stop();
  sync = null;
  const current = space = { secret, id, key, fp, cid };
  let data = null;
  try { data = await (await api(`/spaces/${id}`)).json(); }
  catch (e) {
    if (space !== current) return;
    if (missingSpace(e)) return spaceGone();
    toast('暂时连不上服务器，稍后自动重试');
  }
  if (space !== current) return;
  showMain();
  setStatus('connecting');
  if (data) { setUsage(data.usage); await syncItems(data.items, true); }
  if (space !== current) return;
  startSync(data);
  resumePending();
}

/** Start the v2 sync engine (sync.js) for the current space. */
function startSync(initial) {
  sync?.stop();
  const current = space;
  const engine = createSync({
    spaceId: current.id,
    cid: current.cid,
    getConfig: () => cfg,
    ensureConfig: loadConfig,
    request: api,
    hooks: {
      snapshot: (items, keepRev) => (alive() ? syncItems(items, false, keepRev) : undefined),
      add: (item) => (alive() ? addEntry(item, null, true) : undefined),
      remove: (id) => { if (alive()) dropEntry(id); },
      usage: (u) => { if (alive()) setUsage(u); },
      peers: (n) => { if (alive()) onPeers(n); },
      status: (state) => {
        if (!alive()) return;
        setStatus(state);
        if (state === 'live') { resumePending(); wakeWaiting(); }
        if (!$('dlgDiag').hidden && $('dlgDiag').open) renderDiag();
      },
      gone: () => { if (space === current) spaceGone(); },
      version: () => { if (alive()) $('versionBanner').hidden = false; },
    },
  });
  const alive = () => space === current && sync === engine;
  sync = engine;
  engine.start(initial);
}

/** Work that needs a known server protocol: restore mirrored texts and consume Android shares. */
function resumePending() {
  if (!space || !configLoaded) return;
  restoreOutbox();
  consumeShareTarget().catch(() => toast('读取分享内容失败，请重试'));
}

let lastPeers = null;
function onPeers(n) {
  renderIdentity();
  if ($('dlgAdd').open) renderAddPeers(n, lastPeers);
  lastPeers = n;
}

function spaceGone() {
  const secret = localStorage.getItem(LS.secret);
  if (secret) localStorage.setItem('ca.secret.prev', secret);
  const fp = space?.fp;
  clearFeed();
  showSetup(`服务器上找不到当前 Token 对应的连接${fp ? `（短指纹 ${fp}）` : ''}。它可能已被删除，或服务器数据被重置。本机 Token 仍然保留，可以重试或粘贴其他 Token 或配对链接。`);
}

async function syncItems(list, initial = false, rev = undefined) {
  const ids = new Set(list.map((i) => i.id));
  for (const [id, entry] of entries) if (!ids.has(id) && !(Number.isSafeInteger(rev) && entry.localRev > rev)) dropEntry(id);
  for (const id of undecryptable) if (!ids.has(id)) undecryptable.delete(id);
  for (const raw of list) await addEntry(raw, null, !initial);
  refreshCounts();
}

// ---------- feed ----------
async function addEntry(raw, local, live = false) {
  if (!space || entries.has(raw.id)) return entries.get(raw.id);
  if (!local && undecryptable.has(raw.id)) return undefined;
  const key = space.key;
  let meta;
  try { meta = local?.meta || (await decryptMeta(key, raw.meta)); }
  catch {
    if (space?.key === key && !entries.has(raw.id)) { undecryptable.add(raw.id); refreshCounts(); }
    return undefined;
  }
  if (entries.has(raw.id) || !space || space.key !== key) return entries.get(raw.id);
  const entry = { raw, meta, kind: kindOf(meta), mine: meta.did === deviceId };
  if (local?.blob) entry.blob = Promise.resolve(local.blob);
  entry.el = renderEntry(entry);
  entries.set(raw.id, entry);
  const feed = $('feed');
  const after = [...feed.children].find((c) => Number(c.dataset.ts) < raw.ts);
  feed.insertBefore(entry.el, after || null);
  if (live && !entry.mine) {
    entry.el.classList.add('fresh');
    setTimeout(() => entry.el.classList.remove('fresh'), 2400);
    bumpUnread();
    noteFresh(entry);
  }
  refreshCounts();
  return entry;
}

function dropEntry(id) {
  if (undecryptable.delete(id)) refreshCounts();
  const e = entries.get(id);
  if (!e) return;
  entries.delete(id);
  e.dl?.abort();
  e.el.remove();
  if (e.url) URL.revokeObjectURL(e.url);
  refreshCounts();
}

/** Stream-decrypt an item. onChunk receives plaintext chunks in order. */
async function streamItem(entry, { onChunk, onProgress, signal }) {
  const { raw, meta } = entry;
  const r = await api(`/spaces/${space.id}/items/${raw.id}`, { signal });
  await decryptStream(space.key, r.body, meta, onChunk, onProgress && ((n) => onProgress(n / raw.size)));
}

function getBlob(entry, opts = {}) {
  if (entry.blob) return entry.blob;
  const p = (async () => {
    const parts = [];
    await streamItem(entry, { ...opts, onChunk: (c) => { parts.push(c); } });
    return new Blob(parts, { type: entry.meta.type || 'application/octet-stream' });
  })();
  if (entry.raw.size <= PREVIEW_MAX) entry.blob = p;
  p.catch(() => { if (entry.blob === p) entry.blob = undefined; });
  return p;
}

const isUrl = (t) => /^https?:\/\/\S+$/i.test(t.trim());

function renderEntry(entry) {
  const { raw, meta, kind } = entry;
  const actions = h('div', { class: 'item-actions' });
  const body = h('div', { class: 'item-body' });
  const prog = h('div', { class: 'progress thin', hidden: true }, h('div', { class: 'progress-bar' }));
  const info = h('span', { class: 'info' });
  const el = h('article', { class: `item item-${kind}`, 'data-ts': raw.ts, 'data-kind': kind },
    h('div', { class: 'item-head' },
      avatar(meta),
      h('div', { class: 'who' },
        h('div', { class: 'who-line' },
          h('span', { class: 'dev' }, meta.dev || '未知设备'),
          entry.mine ? h('span', { class: 'tag' }, '本机') : null),
        h('div', { class: 'when' },
          h('span', { class: 'time', 'data-ts': raw.ts, title: fmtLeft(raw.ts) }, fmtTime(raw.ts)), info)),
      h('span', { class: 'kind-badge' }, icon(KIND[kind].icon), h('span', {}, KIND[kind].label)),
      h('button', { class: 'icon-btn', type: 'button', title: '删除', 'aria-label': '删除', onclick: () => removeEntry(entry) }, icon('trash'))),
    body, prog, actions);
  entry.prog = prog;
  const setInfo = (t) => { info.textContent = t ? ' · ' + t : ''; };

  if (kind === 'text') {
    const pre = h('pre', { class: 'text' }, '解密中…');
    body.append(h('div', { class: 'bubble' }, pre));
    const copyBtn = iconBtn('复制', 'copy', () => copyText(entry.text, copyBtn), 'btn primary sm');
    copyBtn.disabled = true;
    actions.append(copyBtn);
    getBlob(entry).then((b) => b.text()).then((t) => {
      entry.text = t;
      pre.textContent = t;
      copyBtn.disabled = false;
      const chars = [...t].length;
      setInfo(chars + ' 字');
      if (isUrl(t)) {
        pre.classList.add('is-link');
        actions.append(h('a', { class: 'btn ghost sm', href: t.trim(), target: '_blank', rel: 'noopener noreferrer' }, icon('link'), h('span', { class: 'lbl' }, '打开链接')));
      }
      requestAnimationFrame(() => {
        if (pre.scrollHeight > pre.clientHeight + 4) {
          pre.classList.add('clamped');
          const more = iconBtn('展开全文', 'chevron', () => {
            const clamped = pre.classList.toggle('clamped');
            setLabel(more, clamped ? '展开全文' : '收起');
            more.classList.toggle('flip', !clamped);
          }, 'btn ghost sm');
          actions.append(more);
        }
      });
      if (!entry.mine && localStorage.getItem(LS.autoCopy) === '1' && document.hasFocus() && Date.now() - raw.ts < 60e3) {
        navigator.clipboard?.writeText(t).then(() => toast(`已自动复制来自 ${meta.dev || '其他设备'} 的文字`)).catch(() => {});
      }
    }).catch(() => { pre.textContent = '（解密失败）'; pre.classList.add('error'); });
    return el;
  }

  const dl = iconBtn('下载', 'download', null, kind === 'image' ? 'btn ghost sm' : 'btn primary sm dl');
  dl.addEventListener('click', () => download(entry, dl));

  if (kind === 'image' && meta.size <= PREVIEW_MAX) {
    const img = h('img', { class: 'preview', alt: meta.name || '图片', title: (meta.name || '图片') + ' · 点击查看大图' });
    img.addEventListener('click', () => { $('viewImg').src = img.src; $('dlgView').showModal(); });
    img.addEventListener('load', () => setInfo(`${fmtSize(meta.size)} · ${img.naturalWidth}×${img.naturalHeight}`), { once: true });
    body.append(h('div', { class: 'shot' }, img));
    setInfo(fmtSize(meta.size));
    const copyBtn = iconBtn('复制图片', 'copy', () => copyImage(entry, copyBtn), 'btn primary sm');
    copyBtn.disabled = true;
    actions.append(copyBtn);
    getBlob(entry).then((b) => {
      entry.url = URL.createObjectURL(b);
      img.src = entry.url;
      copyBtn.disabled = false;
      if (canShareFiles()) actions.insertBefore(iconBtn('分享 / 存相册', 'share', () => shareBlob(meta, b), 'btn ghost sm'), dl);
    }).catch(() => { body.replaceChildren(h('p', { class: 'error' }, '（解密失败）')); });
    actions.append(dl);
    return el;
  }

  // generic file (and images too large to preview)
  const ft = fileType(meta);
  setInfo(fmtSize(meta.size));
  body.append(h('div', { class: 'file', 'data-tone': ft.tone },
    h('div', { class: 'file-icon' }, icon('file'), h('span', { class: 'file-ext' }, ft.label)),
    h('div', { class: 'file-info' },
      h('span', { class: 'file-name', title: meta.name || '' }, meta.name || '文件'),
      h('span', { class: 'file-sub' }, `${ft.desc} · ${fmtSize(meta.size)}`)),
    dl));
  if (/^(video|audio)\//.test(meta.type || '') && meta.size <= MEDIA_MAX) {
    const play = iconBtn('在线播放', 'play', null, 'btn soft sm');
    play.addEventListener('click', async () => {
      play.disabled = true;
      try {
        const b = await getBlob(entry, { onProgress: (p) => setLabel(play, `解密 ${Math.round(p * 100)}%`) });
        entry.url ||= URL.createObjectURL(b);
        const media = h(meta.type.startsWith('video/') ? 'video' : 'audio', { class: 'media', controls: true, src: entry.url, playsinline: true });
        body.append(media);
        play.remove();
        media.play().catch(() => {});
      } catch (e) { toast('预览失败：' + e.message); play.disabled = false; setLabel(play, '在线播放'); }
    });
    actions.append(play);
  }
  return el;
}

const canShareFiles = () => {
  try { return touch && navigator.canShare?.({ files: [new File([''], 'a.txt', { type: 'text/plain' })] }); } catch { return false; }
};
async function shareBlob(meta, blob) {
  try { await navigator.share({ files: [new File([blob], meta.name || 'file', { type: blob.type })] }); }
  catch (e) { if (e.name !== 'AbortError') toast('分享失败：' + e.message); }
}

async function download(entry, btn) {
  if (entry.dl) { entry.dl.abort(); return; }
  const { meta } = entry;
  const label = btn.querySelector('.lbl')?.textContent ?? btn.textContent;
  const ac = new AbortController();
  const bar = entry.prog.firstChild;
  const onProgress = (p) => { bar.style.width = `${p * 100}%`; setLabel(btn, `取消 ${Math.round(p * 100)}%`); };
  let writable = null;
  try {
    if (meta.size >= DISK_STREAM_MIN && window.showSaveFilePicker && !entry.blob) {
      const handle = await window.showSaveFilePicker({ suggestedName: meta.name || 'file' });
      writable = await handle.createWritable();
    }
    entry.dl = ac;
    entry.prog.hidden = false;
    setLabel(btn, '取消');
    btn.classList.add('busy');
    if (writable) {
      await streamItem(entry, { signal: ac.signal, onProgress, onChunk: (c) => writable.write(c) });
      await writable.close();
      toast('已保存到本地');
    } else {
      const blob = await getBlob(entry, { signal: ac.signal, onProgress });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: meta.name || 'file' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60e3);
    }
  } catch (e) {
    await writable?.abort().catch(() => {});
    if (e.name === 'AbortError') toast(ac.signal.aborted ? '已取消下载' : '已取消');
    else toast('下载失败：' + e.message, 4000);
  } finally {
    entry.dl = null;
    entry.prog.hidden = true;
    bar.style.width = '0';
    setLabel(btn, label);
    btn.classList.remove('busy');
  }
}

async function removeEntry(entry) {
  try {
    await api(`/spaces/${space.id}/items/${entry.raw.id}`, { method: 'DELETE' });
    dropEntry(entry.raw.id);
  } catch (e) {
    if (e.status === 404) dropEntry(entry.raw.id); else toast('删除失败：' + e.message);
  }
}

// ---------- clipboard out ----------
async function copyText(text, btn) {
  if (text == null) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { class: 'offscreen' });
    ta.value = text;
    (btn?.closest('dialog[open]') || document.body).append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) return toast('复制失败，请检查剪贴板权限后重试');
  }
  if (btn) flash(btn); else toast('已复制');
}

function toPng(blob) {
  if (blob.type === 'image/png') return Promise.resolve(blob);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('convert failed'))), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法解码图片')); };
    img.src = url;
  });
}

async function copyImage(entry, btn) {
  try {
    if (!window.ClipboardItem || !navigator.clipboard?.write) throw new Error('浏览器不支持');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': getBlob(entry).then(toPng) })]); // promise keeps Safari's gesture
    if (btn) flash(btn); else toast('图片已复制');
  } catch (e) {
    toast('复制图片失败：' + e.message + '（可以下载或长按图片保存）', 4000);
  }
}

// ---------- sending (outbox, 02 §7) ----------
// Text records (<= 64 KB) are mirrored to sessionStorage['ca.outbox'] until committed so a reload resumes them
// with the SAME itemId and nonce `n` (the server dedups by itemId). Files stay in memory only.
const OUTBOX_KEY = 'ca.outbox';
const restoredOutbox = new Set();
function readOutbox() {
  try { const value = JSON.parse(sessionStorage.getItem(OUTBOX_KEY) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
}
function writeOutbox(items) {
  try { if (items.length) sessionStorage.setItem(OUTBOX_KEY, JSON.stringify(items)); else sessionStorage.removeItem(OUTBOX_KEY); return true; }
  catch { return false; }
}
function forgetOutbox(itemId) { writeOutbox(readOutbox().filter((r) => r.itemId !== itemId)); }

/** @param {{record?: {itemId: string, n: string}, mirrored?: boolean, onCommit?: Function, onDiscard?: Function}} opts */
function sendText(text, opts = {}) {
  if (!text || !text.trim() || !space) return Promise.resolve(false);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  let { record, mirrored = false } = opts;
  if (!record) {
    record = { itemId: newItemId(), n: newNonce() };
    if (blob.size <= 64 * 1024) {
      mirrored = writeOutbox([...readOutbox(), { text, spaceId: space.id, ...record }]);
      if (!mirrored) toast('浏览器无法暂存待发送文字，关闭页面前请确认已发送', 7000);
    }
  }
  return upload({ k: 'text', type: 'text/plain;charset=utf-8', size: blob.size }, blob, '文字', { ...opts, record, mirrored });
}
function restoreOutbox() {
  if (!space || !configLoaded) return;
  for (const r of readOutbox()) {
    if (!r || r.spaceId !== space.id || typeof r.text !== 'string' || new Blob([r.text]).size > 64 * 1024 || !validRecord(r) || restoredOutbox.has(r.itemId)) continue;
    restoredOutbox.add(r.itemId);
    if (cfg.proto >= 2) { sendText(r.text, { record: { itemId: r.itemId, n: r.n }, mirrored: true }); continue; }
    const card = h('div', { class: 'transfer item-text failed', role: 'alert' },
      h('span', {}, '上次未确认发送的文字（旧版服务器无法安全自动重发）'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { restoreText(r.text); forgetOutbox(r.itemId); card.remove(); refreshCounts(); } }, '取回文字'),
        h('button', { type: 'button', class: 'btn ghost sm', onclick: () => { forgetOutbox(r.itemId); card.remove(); refreshCounts(); } }, '丢弃')));
    $('transfers').prepend(card); refreshCounts();
  }
}
function restoreText(text) {
  const ta = $('text');
  if (ta.value && ta.value !== text && !confirm('输入框已有内容，替换为这条待发送文字？')) return false;
  ta.value = text; autoGrow(); ta.focus();
  return true;
}

function sendFile(file, name, opts = {}) {
  if (!file.size) { toast('跳过空文件'); return Promise.resolve(false); }
  if (file.size > cfg.maxFileBytes) {
    const card = h('div', { class: 'transfer item-file failed', role: 'alert' },
      h('span', {}, `「${file.name || '文件'}」发送失败：超过大小上限 ${fmtSize(cfg.maxFileBytes)}`),
      h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { card.remove(); refreshCounts(); if (opts.onDiscard) await opts.onDiscard().catch(() => {}); } }, '丢弃'));
    $('transfers').prepend(card); refreshCounts();
    return Promise.resolve(false);
  }
  const fname = name || file.name || stampName('file', file.type || 'application/octet-stream');
  return upload({ k: 'file', name: fname, type: file.type || 'application/octet-stream', size: file.size }, file, fname, opts);
}

function sendXhr(method, url, body, headers, onProgress, active) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    active.add(xhr);
    xhr.open(method, url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded);
    xhr.onload = () => {
      active.delete(xhr);
      let res = {};
      try { res = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(res);
      else reject(Object.assign(new Error(res.error || `HTTP ${xhr.status}`), { status: xhr.status, code: res.code }));
    };
    xhr.onerror = () => { active.delete(xhr); reject(Object.assign(new Error('网络错误'), { status: 0 })); };
    xhr.onabort = () => { active.delete(xhr); reject(Object.assign(new Error('已取消'), { name: 'AbortError' })); };
    xhr.send(body);
  });
}

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000]; // 02 §7: at most 6 automatic retries
const waiters = new Set(); // wake functions of records in `waiting`
function wakeWaiting() { for (const w of [...waiters]) w(); }
const abortError = (msg = '已取消') => Object.assign(new Error(msg), { name: 'AbortError' });
const retryable = (e) => e.name !== 'AbortError' && e.code !== 'disk_full' && e.code !== 'upload_conflict' && (isNetworkError(e) || e.code === 'in_progress' || e.code === 'incomplete' || e.code === 'upload_not_found' || (e.status === 404 && !e.code) || e.status === 429 || e.status >= 500);
function failReason(e) {
  if (e.code === 'too_large' || e.status === 413) return `超过大小上限 ${fmtSize(cfg.maxFileBytes)}`;
  if (e.code === 'disk_full') return '服务器磁盘已满，请联系管理员';
  if (e.code === 'storage_busy') return '服务器正忙于其他上传';
  if (missingSpace(e)) return '当前 Token 对应的连接不存在';
  if (isNetworkError(e)) return '网络连接失败';
  if (e.code === 'upload_conflict') return '与未完成的上传冲突，请重新发送';
  return `服务器错误（${e.code || e.status || '未知'}）`;
}

function transferCard(label, size, onCancel, kind = 'file') {
  const bar = h('div', { class: 'progress-bar' });
  const info = h('span', { class: 'muted small transfer-info' }, '等待中');
  const pct = h('span', { class: 'transfer-pct' }, '');
  const actions = h('div', { class: 'row transfer-actions', hidden: true });
  const el = h('div', { class: `transfer item-${kind}` },
    h('div', { class: 'transfer-head' },
      h('span', { class: 'transfer-icon' }, icon('upload')),
      h('div', { class: 'transfer-main' },
        h('div', { class: 'transfer-line' }, h('span', { class: 'transfer-name' }, label), pct),
        h('div', { class: 'progress' }, bar),
        info),
      h('button', { class: 'icon-btn', type: 'button', title: '取消', 'aria-label': '取消', onclick: onCancel }, icon('x'))),
    actions);
  $('transfers').prepend(el);
  refreshCounts();
  let t0 = performance.now(), mode = '', onNow = null;
  const clearMode = () => { if (!mode) return; mode = ''; actions.hidden = true; actions.replaceChildren(); el.classList.remove('waiting', 'failed'); el.removeAttribute('role'); };
  const btn = (text, fn) => h('button', { class: 'btn ghost sm', type: 'button', onclick: fn }, text);
  return {
    status(text) { clearMode(); info.textContent = text; },
    update(sent) {
      if (mode === 'wait') clearMode();
      const p = Math.min(100, (sent / size) * 100);
      bar.style.width = p + '%';
      pct.textContent = Math.floor(p) + '%';
      const secs = (performance.now() - t0) / 1000;
      const speed = sent / Math.max(secs, 0.001);
      info.textContent = `上传 ${Math.floor(p)}% · ${fmtSize(Math.min(sent, size))} / ${fmtSize(size)} · ${fmtSize(speed)}/s ${fmtEta((size - sent) / speed)}`;
    },
    restart() { t0 = performance.now(); },
    waiting(sec, k, now) {
      onNow = now;
      info.textContent = `网络不稳定，${sec} 秒后第 ${k} 次重试`;
      if (mode !== 'wait') { clearMode(); mode = 'wait'; el.classList.add('waiting'); actions.append(btn('立即重试', () => onNow?.())); actions.hidden = false; }
    },
    failed(message, { retry, restore, discard }) {
      clearMode(); mode = 'failed';
      el.classList.add('failed'); el.setAttribute('role', 'alert');
      info.textContent = message;
      actions.append(btn('重试', retry));
      if (restore) actions.append(btn('取回文字', restore));
      actions.append(btn('丢弃', discard));
      actions.hidden = false;
    },
    remove() { el.remove(); refreshCounts(); },
  };
}

let savedTimer = null;
/** 02 §7 / 03 §2.4: state only what we can prove — saved, and how many other devices are online. */
function showSaved() {
  const n = sync?.status === 'offline' ? null : sync?.peers ?? null;
  const others = n === null ? null : n - 1;
  const bar = $('savedBar');
  bar.replaceChildren(icon('check'), h('span', {}, others === null ? '已保存 · 在线设备数暂不可用' : others >= 1 ? `已保存 · 另有 ${others} 台设备在线` : '已保存 · 当前没有其他设备在线'));
  if (!(others >= 1)) bar.append(h('button', { class: 'btn ghost sm', type: 'button', onclick: openDiag }, '对方看不到？'));
  bar.hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { bar.hidden = true; }, others >= 1 ? 2500 : 6000);
}

/**
 * One outbox record. itemId and n are fixed for all retries (and across reloads when the caller persisted them),
 * so the server's X-Item-Id / itemId dedup (02 §4.3–4.4) guarantees at most one item.
 */
async function upload(meta, blob, label, opts = {}) {
  if (!space) return false;
  const { record, mirrored, onCommit, onDiscard } = opts;
  const current = space, { id, key } = current;
  const itemId = validRecord(record) ? record.itemId : newItemId();
  Object.assign(meta, { dev: deviceName(), did: deviceId, n: validRecord(record) ? record.n : newNonce(), c: DEFAULT_CHUNK });
  const count = chunkCount(meta.size, meta.c), total = cipherSize(meta.size, meta.c);
  const v2 = () => cfg.proto >= 2;
  const active = new Set();
  let cancelled = false, uploadId = null, running = false, wake = null;
  const setState = (st) => { if (st) outboxState.set(itemId, st); else outboxState.delete(itemId); };
  const finish = () => { setState(null); waiters.delete(wake); card.remove(); };
  const discard = async () => {
    if (cancelled) return;
    cancelled = true;
    for (const x of active) x.abort();
    wake?.();
    if (mirrored) forgetOutbox(itemId);
    if (uploadId) api(`/spaces/${id}/uploads/${uploadId}`, { method: 'DELETE' }).catch(() => {});
    finish();
    if (onDiscard) await onDiscard().catch(() => {});
  };
  const card = transferCard(label, total, discard, meta.k === 'text' ? 'text' : /^image\//.test(meta.type || '') ? 'image' : 'file');
  setState('queued');
  const loaded = new Float64Array(count);
  const progress = () => card.update(loaded.reduce((a, b) => a + b, 0));
  const backoff = (ms, n) => new Promise((resolve) => {
    setState('waiting');
    const until = Date.now() + ms;
    let timer = null;
    const done = () => { clearInterval(timer); waiters.delete(done); if (wake === done) wake = null; resolve(); };
    wake = done;
    waiters.add(done);
    timer = setInterval(() => { const left = until - Date.now(); if (left <= 0) done(); else card.waiting(Math.ceil(left / 1000), n + 1, done); }, 250);
    card.waiting(Math.ceil(ms / 1000), n + 1, done);
  });
  let metaStr;
  const attempt = async () => {
    if (cancelled || space !== current) throw abortError('已取消或 Token 已切换');
    setState('encrypting'); card.status('加密中…'); card.restart();
    metaStr ||= await encryptMeta(key, meta);
    if (count === 1) {
      const ct = await encryptChunk(key, blob, meta, 0);
      if (cancelled) throw abortError();
      setState('uploading');
      return sendXhr('POST', `/api/spaces/${id}/items`, ct, { 'Content-Type': 'application/octet-stream', 'X-Meta': metaStr, ...(v2() ? { 'X-Item-Id': itemId } : {}) }, (l) => { loaded[0] = l; progress(); }, active);
    }
    const session = await (await postJson(`/spaces/${id}/uploads`, { size: total, chunk: meta.c + GCM_OVERHEAD, meta: metaStr, ...(v2() ? { itemId } : {}) })).json();
    if (session.done) return session.item;
    uploadId = session.uploadId;
    setState('uploading');
    const received = new Set(session.received || []);
    for (let i = 0; i < count; i++) {
      if (cancelled) throw abortError();
      if (received.has(i)) { loaded[i] = Math.min(meta.c + GCM_OVERHEAD, total - i * (meta.c + GCM_OVERHEAD)); progress(); continue; }
      const ct = await encryptChunk(key, blob, meta, i);
      await sendXhr('PUT', `/api/spaces/${id}/uploads/${uploadId}/${i}`, ct, { 'Content-Type': 'application/octet-stream' }, (l) => { loaded[i] = l; progress(); }, active);
      loaded[i] = ct.byteLength; progress();
    }
    return (await postJson(`/spaces/${id}/uploads/${uploadId}/complete`, {})).json();
  };
  const run = async () => {
    if (running || cancelled) return false;
    running = true;
    try {
      let raw;
      for (let n = 0; ; n++) {
        try { raw = await attempt(); break; }
        catch (e) {
          // Without server-side idempotency (old server) an automatic retry could duplicate the item: manual only.
          if (cancelled || !v2() || !retryable(e) || n >= RETRY_DELAYS.length) throw e;
          if (e.code === 'upload_not_found') uploadId = null;
          await backoff(e.code === 'in_progress' ? 1500 : RETRY_DELAYS[n], n);
          if (cancelled) throw abortError();
        }
      }
      if (space === current) {
        const existing = entries.get(raw.id), small = meta.size <= PREVIEW_MAX ? blob : null;
        const added = existing || await addEntry(raw, { meta, blob: small });
        if (added) { if (!added.blob && small) added.blob = Promise.resolve(small); if (Number.isSafeInteger(raw.rev)) added.localRev = raw.rev; }
        if (!Number.isSafeInteger(raw.rev)) sync?.resync(); // R7: duplicate / done:true carry no rev
      }
      finish();
      if (mirrored) forgetOutbox(itemId);
      if (onCommit) await onCommit().catch(() => toast('已保存，但未能清除本机分享缓存', 7000));
      if (space === current) showSaved();
      return true;
    } catch (e) {
      if (cancelled) return false;
      if (missingSpace(e)) { spaceGone(); return false; } // mirrored text stays in sessionStorage
      setState('failed');
      card.failed(`发送失败：${failReason(e)}${!v2() && retryable(e) ? '（旧版服务器，重试可能产生重复）' : ''}`, {
        retry: () => run(),
        restore: meta.k === 'text' ? async () => { if (restoreText(await blob.text())) await discard(); } : null,
        discard,
      });
      return false;
    } finally { running = false; }
  };
  return run();
}

async function pasteFromClipboard() {
  try {
    if (navigator.clipboard?.read) {
      let sent = 0;
      for (const ci of await navigator.clipboard.read()) {
        const img = ci.types.find((t) => t.startsWith('image/'));
        if (img) {
          sendFile(new File([await ci.getType(img)], stampName('截图', img), { type: img }));
          sent++;
        } else if (ci.types.includes('text/plain')) {
          const t = await (await ci.getType('text/plain')).text();
          if (t.trim()) { sendText(t); sent++; }
        }
      }
      if (!sent) toast('剪贴板是空的');
      return;
    }
    const t = await navigator.clipboard.readText();
    if (t.trim()) sendText(t); else toast('剪贴板是空的');
  } catch {
    toast('浏览器不允许直接读取剪贴板，请在输入框里长按或 Ctrl/⌘+V 粘贴', 4000);
    $('text').focus();
  }
}

function autoGrow() {
  const ta = $('text');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + 'px';
}

function sendComposer() {
  const ta = $('text');
  const t = ta.value;
  if (!t.trim()) return ta.focus();
  sendText(t);
  ta.value = '';
  autoGrow();
}

// ---------- share target (Android PWA) ----------
// The SW stores each share as /_share/batch/<uuid>/{meta,text,file/<i>}. Before the first upload attempt we
// persist an {itemId, n} per entry into that batch's meta, so if the page is reloaded/killed after the server
// committed but before the cache entry was deleted, the resend carries the same itemId and the server answers
// "duplicate" instead of creating a second item. Cache entries are deleted only after commit (or explicit discard).
const SHARE_META_RE = /^\/_share\/(?:batch\/[^/]+\/)?meta$/;
const shareAttempted = new Set(); // cache keys already handed to the outbox in this page (failed ones keep their card)
let shareRun = null;
function consumeShareTarget() {
  if (!space || !configLoaded || !('caches' in window)) return Promise.resolve();
  if (shareRun) return shareRun;
  // One tab at a time; a second tab would only produce in_progress/duplicate answers anyway.
  const work = navigator.locks?.request
    ? navigator.locks.request('ca-share', { ifAvailable: true }, (lock) => (lock ? processShares() : null))
    : processShares();
  shareRun = Promise.resolve(work).finally(() => { shareRun = null; });
  return shareRun;
}

async function processShares() {
  if (!(await caches.has(SHARE_CACHE))) return;
  const current = space;
  const cache = await caches.open(SHARE_CACHE);
  const jobs = [];
  for (const request of await cache.keys()) {
    const metaPath = new URL(request.url).pathname;
    if (!SHARE_META_RE.test(metaPath)) continue;
    const prefix = metaPath.slice(0, -4);
    let data;
    try { data = await (await cache.match(request)).json(); } catch { data = null; }
    if (!data || typeof data !== 'object') { await cache.delete(request); continue; }
    data.files = Array.isArray(data.files) ? data.files : [];
    data.ids = data.ids && typeof data.ids === 'object' ? data.ids : {};
    let dirty = false;
    if (typeof data.text === 'string') { // legacy format kept the text inside meta
      if (!(await cache.match(prefix + 'text'))) await cache.put(prefix + 'text', new Response(data.text));
      delete data.text;
      dirty = true;
    }
    const present = [];
    for (const k of ['text', ...data.files.map((_, i) => `file/${i}`)]) if (await cache.match(prefix + k)) present.push(k);
    if (!present.length) { await cache.delete(metaPath); continue; }
    for (const k of present) if (!validRecord(data.ids[k])) { data.ids[k] = { itemId: newItemId(), n: newNonce() }; dirty = true; }
    if (dirty) await cache.put(metaPath, new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }));
    const cleanup = (key) => async () => {
      await cache.delete(key);
      const remaining = (await cache.keys()).some((r) => { const p = new URL(r.url).pathname; return p.startsWith(prefix) && p !== metaPath; });
      if (!remaining) await cache.delete(metaPath);
    };
    for (const k of present) {
      const key = prefix + k;
      if (shareAttempted.has(key)) continue;
      shareAttempted.add(key);
      jobs.push({ key, k, data, cleanup: cleanup(key) });
    }
  }
  let failed = 0, sent = 0;
  for (let j = 0; j < jobs.length; j++) {
    const job = jobs[j];
    if (space !== current) { for (const rest of jobs.slice(j)) shareAttempted.delete(rest.key); break; }
    const r = await cache.match(job.key);
    if (!r) continue;
    const opts = { record: job.data.ids[job.k], onCommit: job.cleanup, onDiscard: job.cleanup };
    let ok;
    if (job.k === 'text') {
      const t = await r.text();
      if (!t.trim()) { await job.cleanup(); continue; }
      ok = await sendText(t, opts);
    } else {
      const b = await r.blob();
      if (!b.size) { await job.cleanup(); continue; }
      const fm = job.data.files[Number(job.k.slice(5))] || {};
      ok = await sendFile(new File([b], fm.name || `shared-${Date.now()}`, { type: fm.type || b.type || 'application/octet-stream' }), undefined, opts);
    }
    if (ok) sent++; else failed++;
  }
  if (failed) toast(`${failed} 条分享发送失败，已留在发件箱，可重试或丢弃`, 7000);
  else if (sent) toast(`分享的 ${sent} 条内容已发送`);
}

// ---------- dialogs ----------
function drawQr(text) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const c = $('qr');
  const quiet = 4;
  const cell = Math.max(2, Math.floor(264 / (n + quiet * 2)));
  const size = cell * (n + quiet * 2);
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, size, size);
  g.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) {
    if (q.isDark(r, col)) g.fillRect((col + quiet) * cell, (r + quiet) * cell, cell, cell);
  }
}

function openAdd() {
  const link = `${location.origin}/#s=${space.secret}`;
  drawQr(link);
  $('addIdentity').textContent = `指纹 ${space.fp}`;
  $('addHint').textContent = '短指纹仅供参考，不是完整 Token，也不能证明 Token 一致。';
  renderAddPeers(sync?.peers ?? null, null);
  $('dlgAdd').showModal();
}
/** Live device count while the add-device dialog is open (03 §3.4). */
function renderAddPeers(n, before) {
  const el = $('addPeers');
  el.classList.toggle('ok', n !== null && before !== null && n > before);
  el.textContent = n === null ? '在线设备数暂不可用'
    : before !== null && n > before ? `✓ 新设备已加入：现在 ${n} 台设备在线`
    : n <= 1 ? '当前在线：1 台（等待新设备…）' : `当前在线：${n} 台`;
}

// ---------- diagnostics (02 §10.2, 03 §2.5) ----------
let diagServer = null, diagTimer = null;
function openDiag() {
  if (!space) return;
  diagServer = null;
  renderDiag();
  if (!$('dlgDiag').open) $('dlgDiag').showModal();
  clearInterval(diagTimer);
  diagTimer = setInterval(() => { if ($('dlgDiag').open) renderDiag(); else clearInterval(diagTimer); }, 1000);
  api(`/spaces/${space.id}/diag`).then((r) => r.json()).then((d) => { diagServer = d; renderDiag(); }).catch((e) => { diagServer = { error: e.code || (isNetworkError(e) ? 'network' : `http_${e.status}`) }; renderDiag(); });
}
const secs = (ms) => (ms == null ? '—' : `${Math.round(ms / 1000)} 秒`);
function outboxCounts() {
  const c = {};
  for (const st of outboxState.values()) c[st] = (c[st] || 0) + 1;
  return c;
}
function diagReport() {
  const i = sync?.info() || {};
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  return {
    generated: new Date().toISOString(),
    space: { fingerprint: space?.fp ?? null, idPrefix: space ? space.id.slice(0, 6) : null },
    device: deviceName(),
    standalone,
    secureContext: globalThis.isSecureContext,
    online: navigator.onLine,
    proto: { client: 2, server: cfg.proto ?? null, serverVersion: cfg.version ?? null, configLoaded },
    connection: {
      status: i.status ?? null,
      since: i.statusSince ? new Date(i.statusSince).toISOString() : null,
      stream: i.proto === 2 ? 'v2' : 'v1',
      epoch: i.epoch ?? null, applied: i.applied ?? null, serverRev: i.serverRev ?? null,
      lastFrameAgoSec: i.lastFrameAgoMs == null ? null : Math.round(i.lastFrameAgoMs / 1000),
      reconnectFailures: i.failures ?? 0, nextRetryInSec: i.nextRetryInMs == null ? null : Math.round(i.nextRetryInMs / 1000),
      loopback: i.echo ? { result: i.echo.result, rttMs: i.echo.rttMs, streams: i.echo.streams } : null,
      snapshotError: i.snapshotError ?? null,
    },
    peers: i.peers ?? null,
    outbox: outboxCounts(),
    undecryptable: undecryptable.size,
    serviceWorker: !('serviceWorker' in navigator) ? 'unsupported' : navigator.serviceWorker.controller ? 'active' : 'not-controlling',
    server: diagServer,
  };
}
function renderDiag() {
  if (!space) return;
  const i = sync?.info() || {};
  const st = i.status;
  $('diagStep1').textContent = `本机短指纹：${space.fp}`;
  $('diagStep2').textContent = i.peers == null || st === 'offline' ? '在线设备数暂不可用' : i.peers <= 1 ? '只有本机在线' : `当前在线：${i.peers} 台`;
  $('diagStep2').classList.toggle('warn', i.peers != null && i.peers <= 1);
  const echo = i.echo || {};
  $('diagStep3').textContent = st === 'live'
    ? (echo.result === 'ok' ? `实时同步正常（往返 ${echo.rttMs} ms）` : echo.result === 'pending' ? '实时同步已连接，正在自测…' : '实时同步已连接')
    : st === 'degraded' ? (echo.result === 'fail' ? '实时通道被缓冲或阻断，已改为每 5 秒同步' : '实时通道不通，已改为每 5 秒同步')
    : st === 'offline' ? '暂时无法连接服务器，恢复后会尝试同步' : '正在连接…';
  $('diagStep3').classList.toggle('warn', st !== 'live');
  const r = diagReport();
  const rows = [
    ['连接', `短指纹 ${r.space.fingerprint} · 内部 ID ${r.space.idPrefix}…`],
    ['本机', `${r.device}${r.standalone ? ' · 主屏幕 App' : ''}${r.secureContext ? '' : ' · 非安全上下文'}`],
    ['协议', `客户端 2 / 服务端 ${r.proto.server ?? '未知'}${r.proto.serverVersion ? `（${r.proto.serverVersion}）` : ''}`],
    ['状态', `${STATUS_TEXT[st] || '—'}${i.statusSince ? ` · 已持续 ${secs(Date.now() - i.statusSince)}` : ''}`],
    ['同步位置', `epoch ${r.connection.epoch ?? '—'} · 已应用 rev ${r.connection.applied ?? '—'} · 服务端 rev ${diagServer?.rev ?? r.connection.serverRev ?? '—'}`],
    ['最近一帧', i.lastFrameAgoMs == null ? '—' : `${secs(i.lastFrameAgoMs)}前`],
    ['回环自测', echo.result === 'ok' ? `通过 · ${echo.rttMs} ms` : echo.result === 'fail' ? '失败（5 秒内未收到）' : echo.result === 'pending' ? '进行中' : '—'],
    ['重连', i.nextRetryInMs != null ? `${secs(i.nextRetryInMs)}后重试（已失败 ${i.failures} 次）` : `连续失败 ${i.failures ?? 0} 次`],
    ['发件箱', Object.entries(r.outbox).map(([k, v]) => `${k} ${v}`).join(' · ') || '空'],
    ['无法解密', String(r.undecryptable)],
    ['Service Worker', r.serviceWorker],
    ['服务端视角', !diagServer ? '读取中…' : diagServer.error ? `读取失败（${diagServer.error}）` : `条目 ${diagServer.items} · v2 流 ${diagServer.streams?.v2 ?? 0} / v1 流 ${diagServer.streams?.v1 ?? 0}`],
  ];
  $('diagTable').replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

function parseJoin(input) {
  const value = input.trim();
  if (validSecret(value)) return value;
  try {
    const url = new URL(value);
    if (url.origin !== location.origin) return null;
    const secret = new URLSearchParams(url.hash.slice(1)).get('s');
    return validSecret(secret) ? secret : null;
  } catch { return null; }
}
async function joinSpace(secret) {
  if (!validSecret(secret)) throw new Error('Token 不完整，或链接无效、不是本服务器的链接，请重新复制。');
  const { id } = await deriveSpace(secret);
  try { await api(`/spaces/${id}`); }
  catch (e) { throw new Error(missingSpace(e) ? '本服务器上不存在此 Token 对应的连接，本机 Token 未改变。' : '无法验证 Token 对应的连接，请检查网络后重试。本机 Token 未改变。'); }
  const old = localStorage.getItem(LS.secret);
  if (old === secret && space?.secret === secret) return true;
  if (old && old !== secret) {
    if ($('transfers').children.length) throw new Error('请先完成或取消正在发送的内容，再切换 Token。');
    const oldId = (await deriveSpace(old)).id;
    if (!confirm(`从短指纹 ${await fingerprint(oldId)} 切换到 ${await fingerprint(id)}？这会替换本机保存的 Token，但不会删除原有服务器数据。请先备份原 Token 或配对链接，否则可能无法找回。继续吗？`)) return false;
  }
  localStorage.setItem(LS.secret, secret);
  localStorage.removeItem('ca.secret.prev');
  clearFeed();
  await openSpace(secret);
  return true;
}

// ---------- wiring ----------
function wire() {
  $('hint').textContent = touch ? '' : 'Enter 发送 · Shift+Enter 换行 · 页面任意处 ⌘/Ctrl+V 直接发送 · 可拖入文件';
  $('text').placeholder = touch ? '输入或长按粘贴文字…' : '输入文字，或直接粘贴截图 / 文件…';

  $('formJoin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const secret = parseJoin($('joinLink').value);
    try { if (await joinSpace(secret)) $('joinLink').value = ''; }
    catch (err) { if (space) toast(err.message, 6000); else showSetup(err.message); }
  });
  $('retrySpace').addEventListener('click', () => { const secret = localStorage.getItem(LS.secret) || localStorage.getItem('ca.secret.prev'); if (validSecret(secret)) openSpace(secret).catch(() => showSetup('连接失败，请重试。')); });
  $('forgetSpace').addEventListener('click', () => {
    if (!confirm('仅在本机移除 Token？以后需要重新获取 Token 或配对链接。')) return;
    localStorage.removeItem(LS.secret); localStorage.removeItem('ca.secret.prev'); showSetup();
  });
  $('formCreate').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('pw').value;
    if ((localStorage.getItem(LS.secret) || localStorage.getItem('ca.secret.prev')) && !confirm('创建新的 Token 将替换本机保存的 Token，不会删除原有服务器数据。请先备份原 Token 或配对链接，否则可能无法找回。继续吗？')) return;
    const btn = e.submitter || $('formCreate').querySelector('button');
    btn.disabled = true;
    try {
      const secret = newSecret();
      const { id } = await deriveSpace(secret);
      await postJson('/spaces', { id }, { Authorization: 'Bearer ' + pw });
      $('pw').value = '';
      localStorage.setItem(LS.secret, secret);
      await openSpace(secret);
      if (space) openAdd();
    } catch (err) {
      showSetup(err.status === 401 ? '密码不正确' : err.status === 429 ? '尝试次数过多，请 15 分钟后再试' : '创建失败：' + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('btnSend').addEventListener('click', sendComposer);
  $('text').addEventListener('input', autoGrow);
  $('text').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    if (e.metaKey || e.ctrlKey || (!touch && !e.shiftKey)) { e.preventDefault(); sendComposer(); }
  });
  $('btnPaste').addEventListener('click', pasteFromClipboard);
  $('file').addEventListener('change', (e) => {
    for (const f of e.target.files) sendFile(f);
    e.target.value = '';
  });

  $('chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) setFilter(chip.dataset.filter);
  });

  document.addEventListener('paste', (e) => {
    if (!space || $('viewMain').hidden || document.querySelector('dialog[open]')) return;
    const dt = e.clipboardData;
    if (!dt) return;
    const files = [...dt.files];
    if (files.length) {
      e.preventDefault();
      for (const f of files) {
        const generic = !f.name || /^image\.(png|jpe?g|gif|webp)$/i.test(f.name);
        sendFile(f, generic ? stampName('截图', f.type || 'image/png') : f.name);
      }
      return;
    }
    const target = e.target;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
    const text = dt.getData('text/plain');
    if (text && text.trim()) { e.preventDefault(); sendText(text); }
  });

  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (space && hasFiles(e)) { dragDepth++; $('drop').hidden = false; } });
  window.addEventListener('dragleave', () => { if (dragDepth > 0 && --dragDepth === 0) $('drop').hidden = true; });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('drop').hidden = true;
    if (space) for (const f of e.dataTransfer.files) sendFile(f);
  });

  $('btnAdd').addEventListener('click', openAdd);
  for (const b of ['btnDiag', 'status', 'spaceIdentity', 'connNoticeMore', 'btnDiagSettings']) $(b).addEventListener('click', () => { if ($('dlgSettings').open) $('dlgSettings').close(); openDiag(); });
  $('dlgDiag').addEventListener('close', () => clearInterval(diagTimer));
  $('diagRetest').addEventListener('click', () => { sync?.retestEcho(); sync?.resync(); renderDiag(); });
  $('diagCopyLink').addEventListener('click', () => copyText(`${location.origin}/#s=${space.secret}`, $('diagCopyLink')));
  $('copyDiag').addEventListener('click', async () => {
    // No secret, no full space ID, no content: only fingerprint, 6-char ID prefix and counters (02 §9, §10.2).
    const report = JSON.stringify(diagReport(), null, 2);
    copyText(report, $('copyDiag'));
  });
  $('filterHintView').addEventListener('click', () => { setFilter($('filterHintView').dataset.filter || 'all'); $('feed').scrollIntoView({ block: 'start', behavior: 'smooth' }); });
  $('freshPill').addEventListener('click', () => { freshAbove = 0; renderFreshHints(); $('feed').scrollIntoView({ block: 'start', behavior: 'smooth' }); });
  window.addEventListener('scroll', () => { if (freshAbove && !feedTopHidden()) { freshAbove = 0; renderFreshHints(); } }, { passive: true });
  $('undecryptableDismiss').addEventListener('click', () => { $('undecryptable').hidden = true; });
  $('versionBanner').addEventListener('click', () => {
    if (outboxState.size && !confirm('还有内容正在发送，刷新会中断文件上传（文字会在刷新后自动继续）。仍要刷新吗？')) return;
    location.reload();
  });
  $('btnCopyToken').addEventListener('click', () => copyText(space.secret, $('btnCopyToken')));
  $('btnCopyLink').addEventListener('click', () => copyText(`${location.origin}/#s=${space.secret}`, $('btnCopyLink')));
  $('btnSwitch').addEventListener('click', () => {
    $('dlgSettings').close();
    $('switchError').textContent = '';
    $('switchLink').value = '';
    $('dlgSwitch').showModal();
  });
  $('cancelSwitch').addEventListener('click', () => $('dlgSwitch').close());
  $('dlgSwitch').addEventListener('close', () => { $('switchLink').value = ''; });
  $('formSwitch').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    btn.disabled = true;
    $('switchError').textContent = '';
    try {
      if (await joinSpace(parseJoin($('switchLink').value))) $('dlgSwitch').close();
    } catch (err) { $('switchError').textContent = err.message; }
    finally { btn.disabled = false; }
  });
  $('dlgView').addEventListener('click', (e) => { if (e.target === $('dlgView') || e.target === $('viewImg')) $('dlgView').close(); });

  $('btnSettings').addEventListener('click', () => {
    $('devName').value = deviceName();
    $('autoCopy').checked = localStorage.getItem(LS.autoCopy) === '1';
    $('dlgSettings').showModal();
  });
  $('autoCopy').addEventListener('change', (e) => {
    if (e.target.checked) localStorage.setItem(LS.autoCopy, '1'); else localStorage.removeItem(LS.autoCopy);
  });
  $('dlgSettings').addEventListener('close', () => {
    const v = $('devName').value.trim();
    if (v && v !== guessDevice()) localStorage.setItem(LS.device, v); else localStorage.removeItem(LS.device);
  });
  $('btnClear').addEventListener('click', async () => {
    if (!confirm('清空当前 Token 对应的全部内容？使用此 Token 的所有设备都会同步清空。')) return;
    try {
      await api(`/spaces/${space.id}/items`, { method: 'DELETE' });
      for (const id of [...entries.keys()]) dropEntry(id);
      toast('已清空');
    } catch (e) { toast('清空失败：' + e.message); }
  });
  $('btnLeave').addEventListener('click', () => {
    if (!confirm('在本设备退出并移除 Token？之后需要 Token、配对链接或扫码才能重新连接。')) return;
    localStorage.removeItem(LS.secret);
    localStorage.removeItem('ca.secret.prev');
    location.replace('/');
  });
  $('btnDestroy').addEventListener('click', async () => {
    if (!confirm('永久删除当前 Token 对应的连接？服务器上的全部密文会立即删除，使用此 Token 的所有设备都会失效。')) return;
    try { await api(`/spaces/${space.id}`, { method: 'DELETE' }); } catch (e) { if (e.status !== 404) return toast('删除失败：' + e.message); }
    localStorage.removeItem(LS.secret);
    location.replace('/');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    unread = 0;
    document.title = 'CopyAnywhere';
    if (!space) return;
    sync?.visible(); // R9
    wakeWaiting();   // 02 §7: waiting records retry immediately when the page comes back
  });
  window.addEventListener('online', () => { sync?.online(); wakeWaiting(); });
  window.addEventListener('offline', () => { sync?.offline(); });
  window.addEventListener('beforeunload', (e) => { if ([...outboxState.values()].some((st) => st !== 'failed')) e.preventDefault(); });

  setInterval(() => {
    for (const t of document.querySelectorAll('.time[data-ts]')) {
      t.textContent = fmtTime(Number(t.dataset.ts));
      t.title = fmtLeft(Number(t.dataset.ts));
    }
  }, 30e3);
}

async function init() {
  const fragment = location.hash;
  const shareParam = new URLSearchParams(location.search).get('share');
  // remove the key (fragment) and the one-shot ?share= flag immediately
  if (fragment || shareParam) history.replaceState(null, '', location.pathname);
  hydrateIcons();
  if (!globalThis.isSecureContext || !globalThis.crypto?.subtle) {
    $('viewSetup').hidden = false;
    $('formJoin').hidden = true; $('formCreate').hidden = true;
    $('setupProblem').hidden = false;
    $('setupError').textContent = '需要安全连接（HTTPS 或 localhost）才能使用端到端加密。';
    $('retrySpace').hidden = true; $('forgetSpace').hidden = true;
    return;
  }
  if (!deviceId) { deviceId = b64u(crypto.getRandomValues(new Uint8Array(9))); localStorage.setItem(LS.did, deviceId); }
  wire();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (shareParam === 'lost') toast('这次分享没有收到，请重新分享。', 7000);
  try { await loadConfig(); } catch {} // retried by the sync engine before each (re)connect
  const secret = localStorage.getItem(LS.secret);
  if (validSecret(secret)) await openSpace(secret); else showSetup();
  if (fragment) {
    const candidate = new URLSearchParams(fragment.slice(1)).get('s');
    try { await joinSpace(candidate); }
    catch (e) { if (space) toast(e.message, 7000); else showSetup(e.message); }
  }
}

init().catch(() => { showSetup('启动失败，请检查浏览器与网络后重试。'); });
