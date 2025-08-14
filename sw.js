self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open('igstash-static-v1');
    await cache.addAll(['./','./index.html','./app.js','./manifest.webmanifest']);
  })());
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  event.respondWith((async () => {
    const cache = await caches.open('igstash-static-v1');
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (req.method === 'GET' && res.ok && new URL(req.url).origin === location.origin) {
        cache.put(req, res.clone());
      }
      return res;
    } catch {
      return cached || Response.error();
    }
  })());
});
