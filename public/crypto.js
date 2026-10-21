// End-to-end encryption helpers (WebCrypto only).
// secret (32 random bytes, only in URL fragment / localStorage)
//   ├─ HKDF "copyanywhere/id"  -> space id the server routes by (cannot be reversed to the secret)
//   └─ HKDF "copyanywhere/enc" -> AES-256-GCM key for content and metadata
const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64u(bytes) {
  let s = '';
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const newSecret = () => b64u(crypto.getRandomValues(new Uint8Array(32)));
export const validSecret = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);

export async function deriveSpace(secret) {
  const base = await crypto.subtle.importKey('raw', unb64u(secret), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const salt = enc.encode('copyanywhere-v1');
  const idBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('copyanywhere/id') }, base, 256);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('copyanywhere/enc') }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { id: b64u(idBits), key };
}

// AAD binds ciphertext to its role so a blob cannot be swapped in as metadata and vice versa.
export async function encryptBytes(key, data, role) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(role) }, key, data);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return out;
}

export async function decryptBytes(key, data, role) {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b.subarray(0, 12), additionalData: enc.encode(role) }, key, b.subarray(12));
}

export async function encryptMeta(key, obj) {
  return b64u(await encryptBytes(key, enc.encode(JSON.stringify(obj)), 'meta'));
}

export async function decryptMeta(key, str) {
  return JSON.parse(dec.decode(await decryptBytes(key, unb64u(str), 'meta')));
}

// ---------- chunked content ----------
// Plaintext is split into `c`-byte chunks; each chunk is sealed separately as iv(12) || ciphertext || tag(16).
// AAD = "blob:<n>:<index>:<last>" so chunks cannot be reordered, dropped, truncated or moved between items.
export const GCM_OVERHEAD = 28;
export const DEFAULT_CHUNK = 8 * 1024 * 1024;
export const chunkCount = (size, c) => Math.max(1, Math.ceil(size / c));
export const cipherSize = (size, c) => size + chunkCount(size, c) * GCM_OVERHEAD;
export const chunkRole = (n, i, count) => `blob:${n}:${i}:${i === count - 1 ? 1 : 0}`;

/** Encrypt chunk `i` of `blob` (a Blob/File) described by meta {size, c, n}. */
export async function encryptChunk(key, blob, meta, i) {
  const count = chunkCount(meta.size, meta.c);
  const part = await blob.slice(i * meta.c, Math.min(meta.size, (i + 1) * meta.c)).arrayBuffer();
  return encryptBytes(key, part, chunkRole(meta.n, i, count));
}

/**
 * Decrypt a ciphertext byte stream chunk by chunk.
 * @param {ReadableStream<Uint8Array>} stream
 * @param {(plain: Uint8Array, i: number) => Promise<void>|void} onChunk
 * @param {(received: number) => void} [onBytes]
 */
export async function decryptStream(key, stream, meta, onChunk, onBytes) {
  const count = chunkCount(meta.size, meta.c);
  const full = meta.c + GCM_OVERHEAD;
  const expectLen = (i) => (i < count - 1 ? full : meta.size - meta.c * (count - 1) + GCM_OVERHEAD);
  const reader = stream.getReader();
  let i = 0;
  let buf = new Uint8Array(expectLen(0));
  let off = 0;
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    onBytes?.(received);
    let pos = 0;
    while (pos < value.length) {
      if (i >= count) throw new Error('unexpected trailing data');
      const take = Math.min(buf.length - off, value.length - pos);
      buf.set(value.subarray(pos, pos + take), off);
      off += take;
      pos += take;
      if (off === buf.length) {
        await onChunk(new Uint8Array(await decryptBytes(key, buf, chunkRole(meta.n, i, count))), i);
        i++;
        off = 0;
        if (i < count) buf = new Uint8Array(expectLen(i));
      }
    }
  }
  if (i !== count) throw new Error('truncated content');
}
