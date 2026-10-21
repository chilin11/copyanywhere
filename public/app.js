import qrcode from '/vendor/qrcode.mjs';
import { b64u, newSecret, validSecret, deriveSpace, encryptBytes, decryptBytes, encryptMeta, decryptMeta } from '/crypto.js';

const $ = (id) => document.getElementById(id);
const LS_SECRET = 'ca.secret';
const LS_DEVICE = 'ca.device';
const PREVIEW_MAX = 25 * 1024 * 1024; // auto-decrypt images up to this size for previews
const SHARE_CACHE = 'ca-share';

let cfg = { ttlMs: 24 * 3600e3, maxFileBytes: 90 * 1024 * 1024 };
let space = null; // { secret, id, key }
let es = null;
let retryTimer = null;
/** @type {Map<string, {raw:any, meta:any, el:HTMLElement, blob?:Promise<Blob>, text?:string, url?:string}>} */
const entries = new Map();

// ---------- small utils ----------
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
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  return (n / 1024 ** 3).toFixed(1) + ' GB';
}

function fmtTime(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return '刚刚';
  if (s < 3600) return Math.round(s / 60) + ' 分钟前';
  if (s < 86400) return Math.round(s / 3600) + ' 小时前';
  return new Date(ts).toLocaleString();
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
const deviceName = () => localStorage.getItem(LS_DEVICE) || guessDevice();

function stampName(prefix, mime) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ext = (mime.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5);
  return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
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
  $('foot').textContent =
    `端到端加密 · 内容 ${Math.round(cfg.ttlMs / 3600e3)} 小时后自动删除 · 单个文件上限 ${fmtSize(cfg.maxFileBytes)}`;
}

function setStatus(online) {
  const s = $('status');
  s.classList.toggle('online', online);
  s.title = online ? '已连接，实时同步中' : '连接中断，正在重连…';
}

function updateEmpty() {
  $('empty').hidden = $('feed').children.length > 0;
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
      localStorage.removeItem(LS_SECRET);
      return showSetup('这个空间不存在或已被删除，请重新创建或重新扫码。');
    }
    toast('暂时连不上服务器，稍后自动重试');
  }
  showMain();
  await syncItems(data.items);
  connect();
  consumeShareTarget().catch(() => {});
}

function spaceGone() {
  localStorage.removeItem(LS_SECRET);
  for (const id of [...entries.keys()]) dropEntry(id);
  showSetup('这个空间已被删除。');
}

function connect() {
  clearTimeout(retryTimer);
  es?.close();
  if (!space) return;
  const id = space.id;
  es = new EventSource(`/api/spaces/${id}/events`);
  es.onopen = () => { setStatus(true); resync(); };
  es.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'add') addEntry(m.item);
    else if (m.type === 'delete') dropEntry(m.id);
    else if (m.type === 'gone') spaceGone();
  };
  es.onerror = () => {
    setStatus(false);
    if (es.readyState === EventSource.CLOSED) {
      // Non-retryable (e.g. 404). Check whether the space still exists.
      retryTimer = setTimeout(async () => {
        if (!space || space.id !== id) return;
        try { await api(`/spaces/${id}`); connect(); }
        catch (e) { if (e.status === 404) spaceGone(); else connect(); }
      }, 4000);
    }
  };
}

async function resync() {
  if (!space) return;
  try {
    const data = await (await api(`/spaces/${space.id}/items`)).json();
    await syncItems(data.items);
  } catch (e) {
    if (e.status === 404) spaceGone();
  }
}

async function syncItems(list) {
  const ids = new Set(list.map((i) => i.id));
  for (const id of [...entries.keys()]) if (!ids.has(id)) dropEntry(id);
  for (const raw of list) await addEntry(raw);
  updateEmpty();
}

// ---------- feed ----------
async function addEntry(raw, local) {
  if (!space || entries.has(raw.id)) return entries.get(raw.id);
  const key = space.key;
  let meta;
  try {
    meta = local?.meta || (await decryptMeta(key, raw.meta));
  } catch {
    return; // not decryptable with our key: ignore
  }
  if (entries.has(raw.id) || !space || space.key !== key) return entries.get(raw.id);
  const entry = { raw, meta };
  if (local?.blob) entry.blob = Promise.resolve(local.blob);
  entry.el = renderEntry(entry);
  entries.set(raw.id, entry);
  const feed = $('feed');
  const after = [...feed.children].find((c) => Number(c.dataset.ts) < raw.ts);
  feed.insertBefore(entry.el, after || null);
  updateEmpty();
  return entry;
}

function dropEntry(id) {
  const e = entries.get(id);
  if (!e) return;
  entries.delete(id);
  e.el.remove();
  if (e.url) URL.revokeObjectURL(e.url);
  updateEmpty();
}

function getBlob(entry, onProgress) {
  if (entry.blob) return entry.blob;
  const { raw, meta } = entry;
  const p = (async () => {
    const r = await api(`/spaces/${space.id}/items/${raw.id}`);
    let buf;
    if (onProgress && r.body && raw.size > 512 * 1024) {
      const reader = r.body.getReader();
      buf = new Uint8Array(raw.size);
      let off = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf.set(value, off);
        off += value.length;
        onProgress(off / raw.size);
      }
      buf = buf.subarray(0, off);
    } else {
      buf = new Uint8Array(await r.arrayBuffer());
    }
    const plain = await decryptBytes(space.key, buf, 'blob:' + meta.n);
    return new Blob([plain], { type: meta.type || 'application/octet-stream' });
  })();
  // Keep small blobs around; large ones are fetched again when needed.
  if (raw.size <= PREVIEW_MAX) entry.blob = p;
  p.catch(() => { if (entry.blob === p) entry.blob = undefined; });
  return p;
}

const isImage = (meta) => meta.k === 'file' && /^image\//.test(meta.type || '') && meta.size <= PREVIEW_MAX;
const isUrl = (t) => /^https?:\/\/\S+$/i.test(t.trim());

function renderEntry(entry) {
  const { raw, meta } = entry;
  const actions = h('div', { class: 'item-actions' });
  const body = h('div', { class: 'item-body' });
  const el = h('article', { class: 'item', 'data-ts': raw.ts },
    h('div', { class: 'item-head' },
      h('span', { class: 'dev' }, meta.dev || '未知设备'),
      h('span', { class: 'time muted', 'data-ts': raw.ts }, fmtTime(raw.ts)),
      meta.k === 'file' ? h('span', { class: 'muted' }, fmtSize(meta.size)) : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn', type: 'button', title: '删除', 'aria-label': '删除', onclick: () => removeEntry(entry) }, '✕')),
    body, actions);

  if (meta.k === 'text') {
    const pre = h('pre', { class: 'text' }, '解密中…');
    body.append(pre);
    const copyBtn = h('button', { class: 'ghost', type: 'button', disabled: true, onclick: () => copyText(entry.text) }, '复制');
    actions.append(copyBtn);
    getBlob(entry).then((b) => b.text()).then((t) => {
      entry.text = t;
      pre.textContent = t;
      copyBtn.disabled = false;
      if (isUrl(t)) actions.append(h('a', { class: 'ghost button', href: t.trim(), target: '_blank', rel: 'noopener noreferrer' }, '打开链接'));
    }).catch(() => { pre.textContent = '（解密失败）'; pre.classList.add('error'); });
    return el;
  }

  if (isImage(meta)) {
    const img = h('img', { class: 'preview', alt: meta.name || '图片' });
    body.append(img);
    const copyBtn = h('button', { class: 'ghost', type: 'button', disabled: true, onclick: () => copyImage(entry) }, '复制图片');
    actions.append(copyBtn);
    getBlob(entry).then((b) => {
      entry.url = URL.createObjectURL(b);
      img.src = entry.url;
      copyBtn.disabled = false;
      if (canShareFiles()) actions.append(h('button', { class: 'ghost', type: 'button', onclick: () => shareEntry(entry, b) }, '分享 / 存到相册'));
    }).catch(() => { body.replaceChildren(h('p', { class: 'error' }, '（解密失败）')); });
  } else {
    body.append(h('div', { class: 'file' }, h('span', { class: 'file-icon' }, '📄'), h('span', { class: 'file-name' }, meta.name || '文件')));
  }
  const dl = h('button', { class: 'ghost', type: 'button' }, '下载');
  dl.addEventListener('click', () => download(entry, dl));
  actions.append(dl);
  return el;
}

const canShareFiles = () => {
  try { return /Android|iPhone|iPad/.test(navigator.userAgent) && navigator.canShare?.({ files: [new File([''], 'a.txt', { type: 'text/plain' })] }); }
  catch { return false; }
};

async function shareEntry(entry, blob) {
  try {
    await navigator.share({ files: [new File([blob], entry.meta.name || 'image', { type: blob.type })] });
  } catch (e) {
    if (e.name !== 'AbortError') toast('分享失败：' + e.message);
  }
}

async function download(entry, btn) {
  const label = btn.textContent;
  btn.disabled = true;
  try {
    const blob = await getBlob(entry, (p) => { btn.textContent = `下载中 ${Math.round(p * 100)}%`; });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: entry.meta.name || 'file' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60e3);
  } catch (e) {
    toast('下载失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function removeEntry(entry) {
  try {
    await api(`/spaces/${space.id}/items/${entry.raw.id}`, { method: 'DELETE' });
    dropEntry(entry.raw.id);
  } catch (e) {
    if (e.status === 404) dropEntry(entry.raw.id);
    else toast('删除失败：' + e.message);
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
    if (!window.ClipboardItem || !navigator.clipboard?.write) throw new Error('浏览器不支持复制图片');
    // Pass a promise so Safari keeps the user gesture.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': getBlob(entry).then(toPng) })]);
    toast('图片已复制');
  } catch (e) {
    toast('复制图片失败：' + e.message + '（可以用「下载」或长按图片保存）', 4000);
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
  const data = new TextEncoder().encode(text);
  return enqueue(() => upload({ k: 'text', type: 'text/plain;charset=utf-8', size: data.length }, data, '文字'));
}

function sendFile(file, name) {
  if (!file.size) { toast('跳过空文件'); return Promise.resolve(); }
  if (file.size > cfg.maxFileBytes) {
    toast(`「${file.name || '文件'}」超过上限 ${fmtSize(cfg.maxFileBytes)}`, 4000);
    return Promise.resolve();
  }
  const fname = name || file.name || stampName('file', file.type || 'application/octet-stream');
  return enqueue(async () =>
    upload({ k: 'file', name: fname, type: file.type || 'application/octet-stream', size: file.size }, await file.arrayBuffer(), fname));
}

async function upload(meta, data, label) {
  if (!space) return;
  const { id, key } = space;
  meta.dev = deviceName();
  meta.n = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const bar = h('div', { class: 'progress-bar' });
  const card = h('article', { class: 'item pending' },
    h('div', { class: 'item-head' }, h('span', { class: 'dev' }, '加密上传中'), h('span', { class: 'muted' }, label)),
    h('div', { class: 'progress' }, bar));
  $('feed').prepend(card);
  updateEmpty();
  try {
    const ct = await encryptBytes(key, data, 'blob:' + meta.n);
    const metaStr = await encryptMeta(key, meta);
    const raw = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/spaces/${id}/items`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-Meta', metaStr);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.style.width = `${(e.loaded / e.total) * 100}%`; };
      xhr.onload = () => {
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status === 201) resolve(body);
        else reject(Object.assign(new Error(body.error || `HTTP ${xhr.status}`), { status: xhr.status }));
      };
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.send(ct);
    });
    const blob = new Blob([data], { type: meta.type });
    const existing = entries.get(raw.id);
    if (existing) { if (!existing.blob && raw.size <= PREVIEW_MAX) existing.blob = Promise.resolve(blob); }
    else await addEntry(raw, { meta, blob: raw.size <= PREVIEW_MAX ? blob : null });
  } catch (e) {
    if (e.status === 404) spaceGone();
    toast(`发送失败：${e.status === 413 ? '超过大小上限' : e.message}`, 4000);
  } finally {
    card.remove();
    updateEmpty();
  }
}

async function pasteFromClipboard() {
  try {
    if (navigator.clipboard?.read) {
      let sent = 0;
      for (const ci of await navigator.clipboard.read()) {
        const img = ci.types.find((t) => t.startsWith('image/'));
        if (img) {
          const b = await ci.getType(img);
          sendFile(new File([b], stampName('截图', img), { type: img }));
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
    if (t.trim()) sendText(t);
    else toast('剪贴板是空的');
  } catch {
    toast('浏览器不允许直接读取剪贴板，请在输入框里长按或 Ctrl/⌘+V 粘贴', 4000);
    $('text').focus();
  }
}

function sendComposer() {
  const ta = $('text');
  const t = ta.value;
  if (!t.trim()) return ta.focus();
  ta.value = '';
  sendText(t);
}

// ---------- share target (Android PWA) ----------
async function consumeShareTarget() {
  if (new URLSearchParams(location.search).has('share')) history.replaceState(null, '', '/');
  if (!('caches' in window) || !space) return;
  if (!(await caches.has(SHARE_CACHE))) return;
  const cache = await caches.open(SHARE_CACHE);
  const metaRes = await cache.match('/_share/meta');
  if (!metaRes) return caches.delete(SHARE_CACHE);
  const { text, files } = await metaRes.json();
  const blobs = [];
  for (let i = 0; i < files.length; i++) {
    const r = await cache.match(`/_share/file/${i}`);
    if (r) blobs.push(new File([await r.blob()], files[i].name, { type: files[i].type }));
  }
  await caches.delete(SHARE_CACHE).catch(() => {}); // consume once
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
  const cell = Math.max(2, Math.floor(c.width / (n + quiet * 2)));
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
  $('qr').width = 264;
  drawQr(link);
  $('link').value = link;
  $('dlgAdd').showModal();
}

// ---------- wiring ----------
function wire() {
  $('formCreate').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('pw').value;
    const btn = e.submitter || $('formCreate').querySelector('button');
    btn.disabled = true;
    try {
      const secret = newSecret();
      const { id } = await deriveSpace(secret);
      await api('/spaces', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + pw, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      $('pw').value = '';
      localStorage.setItem(LS_SECRET, secret);
      await openSpace(secret);
      if (space) openAdd();
    } catch (err) {
      const msg = err.status === 401 ? '密码不正确' : err.status === 429 ? '尝试次数过多，请 15 分钟后再试' : '创建失败：' + err.message;
      showSetup(msg);
    } finally {
      btn.disabled = false;
    }
  });

  $('btnSend').addEventListener('click', sendComposer);
  $('text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendComposer(); }
  });
  $('btnPaste').addEventListener('click', pasteFromClipboard);
  $('file').addEventListener('change', (e) => {
    for (const f of e.target.files) sendFile(f);
    e.target.value = '';
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
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return; // normal paste
    const text = dt.getData('text/plain');
    if (text && text.trim()) { e.preventDefault(); sendText(text); toast('已发送剪贴板文字'); }
  });

  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!space || !hasFiles(e)) return;
    dragDepth++;
    $('drop').hidden = false;
  });
  window.addEventListener('dragleave', () => {
    if (dragDepth > 0 && --dragDepth === 0) $('drop').hidden = true;
  });
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

  $('btnSettings').addEventListener('click', () => {
    $('devName').value = deviceName();
    $('dlgSettings').showModal();
  });
  $('dlgSettings').addEventListener('close', () => {
    const v = $('devName').value.trim();
    if (v && v !== guessDevice()) localStorage.setItem(LS_DEVICE, v);
    else localStorage.removeItem(LS_DEVICE);
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
    localStorage.removeItem(LS_SECRET);
    location.replace('/');
  });
  $('btnDestroy').addEventListener('click', async () => {
    if (!confirm('永久删除整个空间？服务器上的全部密文会立即删除，所有设备都会失效。')) return;
    try {
      await api(`/spaces/${space.id}`, { method: 'DELETE' });
    } catch (e) {
      if (e.status !== 404) return toast('删除失败：' + e.message);
    }
    localStorage.removeItem(LS_SECRET);
    location.replace('/');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !space) return;
    if (!es || es.readyState === EventSource.CLOSED) connect();
    else resync();
  });

  setInterval(() => {
    for (const t of document.querySelectorAll('.time[data-ts]')) t.textContent = fmtTime(Number(t.dataset.ts));
  }, 30e3);
}

async function init() {
  wire();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try { cfg = { ...cfg, ...(await (await api('/config')).json()) }; } catch {}

  const m = location.hash.match(/[#&]s=([A-Za-z0-9_-]{43})(?:&|$)/);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search); // never keep the key in the URL bar
  if (m) localStorage.setItem(LS_SECRET, m[1]);

  const secret = localStorage.getItem(LS_SECRET);
  if (validSecret(secret)) await openSpace(secret);
  else showSetup();
}

init();
