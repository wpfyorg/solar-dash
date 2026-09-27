const CACHE = 'solar-demo-v2';
const BASE = new URL('./', self.location.href).pathname;
const SHELL = [BASE, BASE + 'demo-data.js', BASE + 'manifest.webmanifest', BASE + 'font.woff2', BASE + 'icons/icon-192.png', BASE + 'icons/icon-512.png', BASE + 'icons/icon-512-maskable.png', BASE + 'icons/apple-touch-icon.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const networkFirst = e.request.mode === 'navigate' || url.pathname === BASE + 'demo-data.js' || url.pathname === BASE + 'manifest.webmanifest';
  if (networkFirst) {
    e.respondWith(fetch(e.request).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request.mode === 'navigate' ? BASE : e.request, copy)); return res; }).catch(() => caches.match(e.request.mode === 'navigate' ? BASE : e.request)));
    return;
  }
  e.respondWith(caches.match(e.request).then(c => c || fetch(e.request)));
});
