// Minimal service worker: makes the app installable and receives Android "Share to" (Web Share Target).
// Shared files are kept in a local cache only until the page encrypts and uploads them.
const SHARE_CACHE = 'ca-share';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.origin === location.origin && url.pathname === '/share') {
    e.respondWith(receiveShare(e.request));
  }
});

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter((f) => f && typeof f === 'object' && f.size > 0);
    const text = ['title', 'text', 'url']
      .map((k) => form.get(k))
      .filter((v) => typeof v === 'string' && v.trim())
      .filter((v, i, a) => a.indexOf(v) === i)
      .join('\n');
    await caches.delete(SHARE_CACHE);
    const cache = await caches.open(SHARE_CACHE);
    await Promise.all(files.map((f, i) =>
      cache.put(`/_share/file/${i}`, new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }))));
    await cache.put('/_share/meta', new Response(JSON.stringify({
      text,
      files: files.map((f) => ({ name: f.name || `shared-${Date.now()}`, type: f.type || 'application/octet-stream' })),
    }), { headers: { 'Content-Type': 'application/json' } }));
  } catch (err) {
    // fall through: the page simply opens without shared content
  }
  return Response.redirect('/?share=1', 303);
}
