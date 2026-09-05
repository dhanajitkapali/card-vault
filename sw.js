// Offline shell. Cache-first: the app must open with no network at all.
// Bump CACHE on every release or clients keep the old shell.
const CACHE = 'cards-v1';
const SHELL = [
  './', './index.html', './styles.css',
  './js/app.js', './js/crypto.js', './js/db.js', './js/faceid.js',
  './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Same-origin GETs only. Nothing else is ever fetched (PLAN.md C5).
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  e.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((res) => {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
