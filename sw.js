/* One-Dayer Scorer: keeps the app usable without internet.
   App files: try the network first (so updates show straight away), fall back to the saved copy offline.
   Libraries and fonts: use the saved copy, refresh it in the background. */
const CACHE = 'one-dayer-v1';
const SHELL = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'img/logo.png', 'img/logo-inverted.png', 'img/hero-pitch.jpg',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const LIBS = /^https:\/\/(www\.gstatic\.com\/firebasejs|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(), bare = url.search ? res.clone() : null; caches.open(CACHE).then(c => { c.put(req, copy); if (bare) c.put(url.origin + url.pathname, bare); }); }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match(url.origin + url.pathname)).then(r => r || (req.mode === 'navigate' ? caches.match('index.html') : undefined))));
    return;
  }
  if (LIBS.test(req.url)) {
    e.respondWith(caches.match(req).then(hit => {
      const net = fetch(req).then(res => { if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
