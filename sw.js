const CACHE_NAME = 'compound-ledger-v3';
const CORE_ASSETS = [
  './tracker.html',
  './tracker.js',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './chart.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Only intercept same-origin requests (this site's own files) for offline support.
// Anything cross-origin — Google Sign-In, Google Drive API calls, auth tokens —
// is deliberately left untouched: never cached, never inspected, goes straight
// to the network so no personal data or credentials ever sit in Cache Storage.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // let the browser handle it normally
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      });
    })
  );
});
