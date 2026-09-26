// waaree-dash service worker: caches the app shell (HTML, font, icons,
// manifest) so the page still opens (as an installed PWA) with no network,
// and shows the last known /api/state while offline or unreachable.
// Registered only when `isSecureContext` (see index.html) — service workers
// need HTTPS or localhost, so on a plain http://solar.lan the page still
// works as an add-to-home-screen app, it just always fetches fresh.
const CACHE_VERSION = 'v3';
const CACHE_NAME = `waaree-dash-${CACHE_VERSION}`;
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/font.woff2',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.pathname === '/api/state') {
    // Network-first: always try live data, fall back to the last cached
    // response (the frontend's own "stale"/"api_error" banners take it from
    // there using the payload's own `status`/`live.updated_at`).
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  if (url.pathname === '/') {
    // The page itself is network-first so a new UI reaches installed PWAs
    // on the next open; the cached copy is only the offline fallback.
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok && !res.redirected) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  if (SHELL.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
});
