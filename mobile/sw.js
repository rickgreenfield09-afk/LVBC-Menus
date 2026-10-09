// sw.js (mobile)
// Makes the app open with no signal. Network-first: an online phone
// always gets the latest deploy, and the cache is only the fallback —
// so there is no cache version to remember to bump on each release.
//
// Only the app's own files and its CDN script/fonts are cached.
// Supabase and /api/ calls are never cached here — the inventory
// screen handles its own offline queue (mobile/js/inventory.js).

const CACHE = 'lvbc-mobile-shell';
const SHELL = [
  '/mobile/',
  '/mobile/mobile.css',
  '/mobile/js/core.js',
  '/mobile/js/schedule.js',
  '/mobile/js/inventory.js',
  '/mobile/js/merch.js',
  '/mobile/js/tasks.js',
  '/mobile/js/offsite.js',
  '/style.css',
  '/config.js',
];
const CDN_HOSTS = ['unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin ? url.pathname.startsWith('/api/') : !CDN_HOSTS.includes(url.hostname)) return;

  event.respondWith(
    fetch(req).then((res) => {
      // Opaque (cross-origin, no-cors) responses report ok=false but are still cacheable.
      if (res.ok || res.type === 'opaque') {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: sameOrigin }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/mobile/') : Response.error())))
  );
});
