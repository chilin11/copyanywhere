import qrcode from '/vendor/qrcode.mjs';
import {
  b64u, newSecret, validSecret, deriveSpace, encryptMeta, decryptMeta,
  DEFAULT_CHUNK, GCM_OVERHEAD, chunkCount, cipherSize, encryptChunk, decryptStream,
} from '/crypto.js';

const $ = (id) => document.getElementById(id);
const LS = { secret: 'ca.secret', device: 'ca.device', did: 'ca.did', autoCopy: 'ca.autocopy' };
const PREVIEW_MAX = 25 * 1024 * 1024; // auto-decrypt images up to this size
const MEDIA_MAX = 300 * 1024 * 1024; // in-page audio/video preview up to this size
const DISK_STREAM_MIN = 200 * 1024 * 1024; // stream big downloads straight to disk when supported
const PARALLEL = 3;
const SHARE_CACHE = 'ca-share';
const touch = matchMedia('(pointer: coarse)').matches;

let cfg = { ttlMs: 24 * 3600e3, maxFileBytes: 5 * 1024 ** 3, maxTotalBytes: 5 * 1024 ** 3 };
let space = null; // { secret, id, key }
let es = null;
let retryTimer = null;
let unread = 0;
/** @type {Map<string, any>} id -> { raw, meta, el, kind, blob?, text?, url?, dl? } */
const entries = new Map();

if (!localStorage.getItem(LS.did)) localStorage.setItem(LS.did, b64u(crypto.getRandomValues(new Uint8Array(9))));
const deviceId = localStorage.getItem(LS.did);

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
function fileIcon(meta) {
  const t = meta.type || '';
  const ext = (meta.name || '').split('.').pop().toLowerCase();
  if (t.startsWith('image/')) return '🖼';
  if (t.startsWith('video/')) return '🎬';
  if (t.startsWith('audio/')) return '🎵';
  if (t === 'application/pdf' || ext === 'pdf') return '📕';
  if (/^(zip|rar|7z|gz|tgz|bz2|xz|tar|dmg|iso)$/.test(ext)) return '📦';
  if (/^(xls|xlsx|csv|numbers)$/.test(ext)) return '📊';
  if (/^(doc|docx|pages|txt|md|rtf)$/.test(ext)) return '📝';
  if (/^(ppt|pptx|key)$/.test(ext)) return '📽';
  if (/^(apk|exe|msi|pkg|app|ipa)$/.test(ext)) return '⚙';
  return '📄';
}

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, { cache: 'no-store', ...opts });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error || msg; } catch {}
    throw Object.assign(new Error(msg), { status: r.status });
  }
  return r;
}
const postJson = (path, body, headers = {}) =>
  api(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

// ---------- views ----------
function showSetup(error) {
  space = null;
  es?.close();
  es = null;
  $('viewMain').hidden = true;
  $('barActions').hidden = true;
  $('viewSetup').hidden = false;
  $('setupError').hidden = !error;
  $('setupError').textContent = error || '';
}

function showMain() {
  $('viewSetup').hidden = true;
  $('viewMain').hidden = false;
  $('barActions').hidden = false;
  $('foot').textContent = `端到端加密 · 内容 ${Math.round(cfg.ttlMs / 3600e3)} 小时后自动删除 · 单个文件最大 ${fmtSize(cfg.maxFileBytes)}`;
}

function setStatus(state) {
  const s = $('status');
  s.dataset.state = state;
  $('statusText').textContent = { online: '已连接', offline: '重连中', connecting: '连接中' }[state];
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
  $('empty').hidden = c.all > 0 || $('transfers').children.length > 0;
}

function bumpUnread() {
  if (!document.hidden) return;
  unread++;
  document.title = `(${unread}) CopyAnywhere`;
}

// ---------- space lifecycle ----------
async function openSpace(secret) {
  const { id, key } = await deriveSpace(secret);
  space = { secret, id, key };
  let data = { items: [] };
  try {
    data = await (await api(`/spaces/${id}`)).json();
  } catch (e) {
    if (e.status === 404) {
      localStorage.removeItem(LS.secret);
      return showSetup('这个空间不存在或已被删除，请重新创建或重新扫码。');
    }
    toast('暂时连不上服务器，稍后自动重试');
  }
  showMain();
  setUsage(data.usage);
  await syncItems(data.items, true);
  connect();
  consumeShareTarget().catch(() => {});
}

function spaceGone() {
  localStorage.removeItem(LS.secret);
  for (const id of [...entries.keys()]) dropEntry(id);
  showSetup('这个空间已被删除。');
}

function connect() {
  clearTimeout(retryTimer);
  es?.close();
  if (!space) return;
  const id = space.id;
  setStatus('connecting');
  es = new EventSource(`/api/spaces/${id}/events`);
  es.onopen = () => { setStatus('online'); resync(); };
  es.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'add') addEntry(m.item, null, true);
    else if (m.type === 'delete') dropEntry(m.id);
    else if (m.type === 'usage') setUsage(m);
    else if (m.type === 'gone') spaceGone();
  };
  es.onerror = () => {
    setStatus('offline');
    if (es.readyState === EventSource.CLOSED) {
      retryTimer = setTimeout(async () => {
        if (!space || space.id !== id) return;
        try { await api(`/spaces/${id}`); connect(); } catch (e) { if (e.status === 404) spaceGone(); else connect(); }
      }, 4000);
    }
  };
}

async function resync() {
  if (!space) return;
  try {
    const data = await (await api(`/spaces/${space.id}/items`)).json();
    setUsage(data.usage);
    await syncItems(data.items);
  } catch (e) {
    if (e.status === 404) spaceGone();
  }
}

async function syncItems(list, initial = false) {
  const ids = new Set(list.map((i) => i.id));
  for (const id of [...entries.keys()]) if (!ids.has(id)) dropEntry(id);
  for (const raw of list) await addEntry(raw, null, !initial);
  refreshCounts();
}

// ---------- feed ----------
async function addEntry(raw, local, live = false) {
  if (!space || entries.has(raw.id)) return entries.get(raw.id);
  const key = space.key;
  let meta;
  try { meta = local?.meta || (await decryptMeta(key, raw.meta)); } catch { return; }
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
  }
  refreshCounts();
  return entry;
}

function dropEntry(id) {
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
  const { raw, meta } = entry;
  const actions = h('div', { class: 'item-actions' });
  const body = h('div', { class: 'item-body' });
  const prog = h('div', { class: 'progress thin', hidden: true }, h('div', { class: 'progress-bar' }));
  const el = h('article', { class: 'item', 'data-ts': raw.ts, 'data-kind': entry.kind },
    h('div', { class: 'item-head' },
      h('span', { class: 'dev' }, meta.dev || '未知设备'),
      entry.mine ? h('span', { class: 'tag' }, '本机') : null,
      h('span', { class: 'time muted', 'data-ts': raw.ts, title: fmtLeft(raw.ts) }, fmtTime(raw.ts)),
      meta.k === 'file' ? h('span', { class: 'muted' }, fmtSize(meta.size)) : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn', type: 'button', title: '删除', 'aria-label': '删除', onclick: () => removeEntry(entry) }, '✕')),
    body, prog, actions);
  entry.prog = prog;

  if (meta.k === 'text') {
    const pre = h('pre', { class: 'text' }, '解密中…');
    body.append(pre);
    const copyBtn = h('button', { class: 'btn soft sm', type: 'button', disabled: true, onclick: () => copyText(entry.text) }, '复制');
    actions.append(copyBtn);
    getBlob(entry).then((b) => b.text()).then((t) => {
      entry.text = t;
      pre.textContent = t;
      copyBtn.disabled = false;
      if (isUrl(t)) actions.append(h('a', { class: 'btn ghost sm', href: t.trim(), target: '_blank', rel: 'noopener noreferrer' }, '打开链接'));
      requestAnimationFrame(() => {
        if (pre.scrollHeight > pre.clientHeight + 4) {
          pre.classList.add('clamped');
          const more = h('button', { class: 'btn ghost sm', type: 'button' }, '展开');
          more.addEventListener('click', () => { more.textContent = pre.classList.toggle('clamped') ? '展开' : '收起'; });
          actions.append(more);
        }
      });
      if (!entry.mine && localStorage.getItem(LS.autoCopy) === '1' && document.hasFocus() && Date.now() - raw.ts < 60e3) {
        navigator.clipboard?.writeText(t).then(() => toast(`已自动复制来自 ${meta.dev || '其他设备'} 的文字`)).catch(() => {});
      }
    }).catch(() => { pre.textContent = '（解密失败）'; pre.classList.add('error'); });
    return el;
  }

  if (entry.kind === 'image' && meta.size <= PREVIEW_MAX) {
    const img = h('img', { class: 'preview', alt: meta.name || '图片', title: '点击查看大图' });
    img.addEventListener('click', () => { $('viewImg').src = img.src; $('dlgView').showModal(); });
    body.append(img);
    const copyBtn = h('button', { class: 'btn soft sm', type: 'button', disabled: true, onclick: () => copyImage(entry) }, '复制图片');
    actions.append(copyBtn);
    getBlob(entry).then((b) => {
      entry.url = URL.createObjectURL(b);
      img.src = entry.url;
      copyBtn.disabled = false;
      if (canShareFiles()) actions.append(h('button', { class: 'btn ghost sm', type: 'button', onclick: () => shareBlob(meta, b) }, '分享 / 存相册'));
    }).catch(() => { body.replaceChildren(h('p', { class: 'error' }, '（解密失败）')); });
  } else {
    body.append(h('div', { class: 'file' },
      h('span', { class: 'file-icon' }, fileIcon(meta)),
      h('div', { class: 'file-info' }, h('span', { class: 'file-name' }, meta.name || '文件'), h('span', { class: 'muted small' }, fmtSize(meta.size)))));
    if (/^(video|audio)\//.test(meta.type || '') && meta.size <= MEDIA_MAX) {
      const play = h('button', { class: 'btn soft sm', type: 'button' }, '▶ 预览');
      play.addEventListener('click', async () => {
        play.disabled = true;
        try {
          const b = await getBlob(entry, { onProgress: (p) => { play.textContent = `解密 ${Math.round(p * 100)}%`; } });
          entry.url ||= URL.createObjectURL(b);
          const media = h(meta.type.startsWith('video/') ? 'video' : 'audio', { class: 'media', controls: true, src: entry.url, playsinline: true });
          body.append(media);
          play.remove();
          media.play().catch(() => {});
        } catch (e) { toast('预览失败：' + e.message); play.disabled = false; play.textContent = '▶ 预览'; }
      });
      actions.append(play);
    }
  }
  const dl = h('button', { class: entry.kind === 'image' ? 'btn ghost sm' : 'btn soft sm', type: 'button' }, '下载');
  dl.addEventListener('click', () => download(entry, dl));
  actions.append(dl);
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
  const label = btn.textContent;
  const ac = new AbortController();
  const bar = entry.prog.firstChild;
  const onProgress = (p) => { bar.style.width = `${p * 100}%`; btn.textContent = `取消 ${Math.round(p * 100)}%`; };
  let writable = null;
  try {
    if (meta.size >= DISK_STREAM_MIN && window.showSaveFilePicker && !entry.blob) {
      const handle = await window.showSaveFilePicker({ suggestedName: meta.name || 'file' });
      writable = await handle.createWritable();
    }
    entry.dl = ac;
    entry.prog.hidden = false;
    btn.textContent = '取消';
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
    btn.textContent = label;
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
async function copyText(text) {
  if (text == null) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { class: 'offscreen' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) return toast('复制失败，请手动选择文字复制');
  }
  toast('已复制');
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

async function copyImage(entry) {
  try {
    if (!window.ClipboardItem || !navigator.clipboard?.write) throw new Error('浏览器不支持');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': getBlob(entry).then(toPng) })]); // promise keeps Safari's gesture
    toast('图片已复制');
  } catch (e) {
    toast('复制图片失败：' + e.message + '（可以下载或长按图片保存）', 4000);
  }
}

// ---------- sending ----------
let queue = Promise.resolve();
function enqueue(job) {
  const p = queue.then(job, job);
  queue = p.catch(() => {});
  return p;
}

function sendText(text) {
  if (!text || !text.trim()) return Promise.resolve();
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  return enqueue(() => upload({ k: 'text', type: 'text/plain;charset=utf-8', size: blob.size }, blob, '文字'));
}

function sendFile(file, name) {
  if (!file.size) { toast('跳过空文件'); return Promise.resolve(); }
  if (file.size > cfg.maxFileBytes) {
    toast(`「${file.name || '文件'}」超过上限 ${fmtSize(cfg.maxFileBytes)}`, 4000);
    return Promise.resolve();
  }
  const fname = name || file.name || stampName('file', file.type || 'application/octet-stream');
  return enqueue(() => upload({ k: 'file', name: fname, type: file.type || 'application/octet-stream', size: file.size }, file, fname));
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
      else reject(Object.assign(new Error(res.error || `HTTP ${xhr.status}`), { status: xhr.status }));
    };
    xhr.onerror = () => { active.delete(xhr); reject(Object.assign(new Error('网络错误'), { status: 0 })); };
    xhr.onabort = () => { active.delete(xhr); reject(Object.assign(new Error('已取消'), { name: 'AbortError' })); };
    xhr.send(body);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const retryable = (e) => e.name !== 'AbortError' && (e.status === 0 || e.status === 409 || e.status === 429 || e.status >= 500);

function transferCard(label, size, onCancel) {
  const bar = h('div', { class: 'progress-bar' });
  const info = h('span', { class: 'muted small' }, '加密中…');
  const el = h('div', { class: 'transfer' },
    h('div', { class: 'transfer-head' },
      h('span', { class: 'transfer-icon' }, '⬆'),
      h('span', { class: 'transfer-name' }, label),
      h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn', type: 'button', title: '取消', onclick: onCancel }, '✕')),
    h('div', { class: 'progress' }, bar), info);
  $('transfers').prepend(el);
  refreshCounts();
  const t0 = performance.now();
  return {
    update(sent) {
      const pct = Math.min(100, (sent / size) * 100);
      bar.style.width = pct + '%';
      const secs = (performance.now() - t0) / 1000;
      const speed = sent / Math.max(secs, 0.001);
      info.textContent = `${fmtSize(Math.min(sent, size))} / ${fmtSize(size)} · ${fmtSize(speed)}/s ${fmtEta((size - sent) / speed)}`;
    },
    remove() { el.remove(); refreshCounts(); },
  };
}

async function upload(meta, blob, label) {
  if (!space) return;
  const { id, key } = space;
  Object.assign(meta, { dev: deviceName(), did: deviceId, n: b64u(crypto.getRandomValues(new Uint8Array(16))), c: DEFAULT_CHUNK });
  const count = chunkCount(meta.size, meta.c);
  const total = cipherSize(meta.size, meta.c);
  const active = new Set();
  let cancelled = false; // by the user
  let stop = false; // any worker failed for good
  let uploadId = null;
  const card = transferCard(label, total, () => {
    cancelled = true;
    for (const x of active) x.abort();
  });
  const loaded = new Float64Array(count);
  const progress = () => card.update(loaded.reduce((a, b) => a + b, 0));
  try {
    const metaStr = await encryptMeta(key, meta);
    let raw;
    if (count === 1) {
      const ct = await encryptChunk(key, blob, meta, 0);
      raw = await sendXhr('POST', `/api/spaces/${id}/items`, ct, { 'Content-Type': 'application/octet-stream', 'X-Meta': metaStr },
        (l) => { loaded[0] = l; progress(); }, active);
    } else {
      ({ uploadId } = await (await postJson(`/spaces/${id}/uploads`, { size: total, chunk: meta.c + GCM_OVERHEAD, meta: metaStr })).json());
      let next = 0;
      const worker = async () => {
        while (!cancelled && !stop && next < count) {
          const i = next++;
          for (let attempt = 0; ; attempt++) {
            try {
              const ct = await encryptChunk(key, blob, meta, i);
              if (cancelled) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
              await sendXhr('PUT', `/api/spaces/${id}/uploads/${uploadId}/${i}`, ct, { 'Content-Type': 'application/octet-stream' },
                (l) => { loaded[i] = l; progress(); }, active);
              loaded[i] = ct.byteLength;
              progress();
              break;
            } catch (e) {
              loaded[i] = 0;
              if (!retryable(e) || attempt >= 5 || cancelled || stop) { stop = true; throw e; }
              await sleep(1000 * 2 ** attempt);
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, count) }, worker));
      if (cancelled) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
      raw = await (await postJson(`/spaces/${id}/uploads/${uploadId}/complete`, {})).json();
    }
    const existing = entries.get(raw.id);
    const small = meta.size <= PREVIEW_MAX ? blob : null;
    if (existing) { if (!existing.blob && small) existing.blob = Promise.resolve(small); }
    else await addEntry(raw, { meta, blob: small });
  } catch (e) {
    stop = true;
    for (const x of active) x.abort();
    if (uploadId) api(`/spaces/${id}/uploads/${uploadId}`, { method: 'DELETE' }).catch(() => {});
    if (cancelled) toast('已取消发送');
    else if (e.status === 404 && !uploadId) spaceGone();
    else toast(`发送失败：${e.status === 413 ? '超过大小上限' : e.status === 507 ? '服务器空间不足' : e.message}`, 4000);
  } finally {
    card.remove();
  }
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
  ta.value = '';
  autoGrow();
  sendText(t);
}

// ---------- share target (Android PWA) ----------
async function consumeShareTarget() {
  if (new URLSearchParams(location.search).has('share')) history.replaceState(null, '', '/');
  if (!('caches' in window) || !space || !(await caches.has(SHARE_CACHE))) return;
  const cache = await caches.open(SHARE_CACHE);
  const metaRes = await cache.match('/_share/meta');
  if (!metaRes) return caches.delete(SHARE_CACHE);
  const { text, files } = await metaRes.json();
  const blobs = [];
  for (let i = 0; i < files.length; i++) {
    const r = await cache.match(`/_share/file/${i}`);
    if (r) blobs.push(new File([await r.blob()], files[i].name, { type: files[i].type }));
  }
  await caches.delete(SHARE_CACHE).catch(() => {});
  const jobs = blobs.map((f) => sendFile(f));
  if (text) jobs.push(sendText(text));
  await Promise.all(jobs);
  if (jobs.length) toast('分享内容已发送');
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
  $('link').value = link;
  $('dlgAdd').showModal();
}

// ---------- wiring ----------
function wire() {
  $('hint').textContent = touch ? '' : 'Enter 发送 · Shift+Enter 换行 · 页面任意处 ⌘/Ctrl+V 直接发送 · 可拖入文件';
  $('text').placeholder = touch ? '输入或长按粘贴文字…' : '输入文字，或直接粘贴截图 / 文件…';

  $('formCreate').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('pw').value;
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
    if (!chip) return;
    for (const c of $('chips').children) c.classList.toggle('active', c === chip);
    $('feed').dataset.filter = chip.dataset.filter;
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
    if (text && text.trim()) { e.preventDefault(); sendText(text); toast('已发送剪贴板文字'); }
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
  $('btnCopyLink').addEventListener('click', () => copyText($('link').value));
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
    if (!confirm('清空空间里的全部内容？所有设备都会同步清空。')) return;
    try {
      await api(`/spaces/${space.id}/items`, { method: 'DELETE' });
      for (const id of [...entries.keys()]) dropEntry(id);
      toast('已清空');
    } catch (e) { toast('清空失败：' + e.message); }
  });
  $('btnLeave').addEventListener('click', () => {
    if (!confirm('在本设备退出？之后需要重新扫码才能加入。')) return;
    localStorage.removeItem(LS.secret);
    location.replace('/');
  });
  $('btnDestroy').addEventListener('click', async () => {
    if (!confirm('永久删除整个空间？服务器上的全部密文会立即删除，所有设备都会失效。')) return;
    try { await api(`/spaces/${space.id}`, { method: 'DELETE' }); } catch (e) { if (e.status !== 404) return toast('删除失败：' + e.message); }
    localStorage.removeItem(LS.secret);
    location.replace('/');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    unread = 0;
    document.title = 'CopyAnywhere';
    if (!space) return;
    if (!es || es.readyState === EventSource.CLOSED) connect(); else resync();
  });
  window.addEventListener('beforeunload', (e) => { if ($('transfers').children.length) e.preventDefault(); });

  setInterval(() => {
    for (const t of document.querySelectorAll('.time[data-ts]')) {
      t.textContent = fmtTime(Number(t.dataset.ts));
      t.title = fmtLeft(Number(t.dataset.ts));
    }
  }, 30e3);
}

async function init() {
  wire();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try { cfg = { ...cfg, ...(await (await api('/config')).json()) }; } catch {}

  const m = location.hash.match(/[#&]s=([A-Za-z0-9_-]{43})(?:&|$)/);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search); // never keep the key in the URL bar
  if (m) localStorage.setItem(LS.secret, m[1]);

  const secret = localStorage.getItem(LS.secret);
  if (validSecret(secret)) await openSpace(secret); else showSetup();
}

init();
