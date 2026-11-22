const version = /* CACHE_VERSION */ "";
const precache = /* PRECACHE */ [];
const root = new URL(self.registration.scope);
const scope = root.href;
const prefix = `kana-loop:${scope}:`;
const cacheName = prefix + version;
const index = new URL('./index.html', scope);
const cachedUrls = new Set(precache.map((path) => new URL(path, scope).href));

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll([...cachedUrls].map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(prefix) && key !== cacheName)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function serve(request, key) {
  const cache = await caches.open(cacheName);
  return (await cache.match(key)) ?? fetch(request);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || !request.url.startsWith(scope)) return;

  const url = new URL(request.url);
  if (request.mode === 'navigate' && (url.pathname === root.pathname || url.pathname === index.pathname)) {
    event.respondWith(serve(request, index.href));
  } else if (cachedUrls.has(request.url)) {
    event.respondWith(serve(request, request.url));
  }
});
