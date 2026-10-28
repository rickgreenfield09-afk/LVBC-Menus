// sw.js (member app)
// Lets the app open with no signal — so a member can still pull up
// their card. Same approach as mobile/sw.js: network-first, so an
// online phone always gets the latest deploy and the cache is only
// the fallback; no cache version to bump on each release.
//
// Only the app's own files and its CDN scripts/fonts are cached.
// Supabase calls are never cached here, so points, the QR code and
// the menus need a connection the first time each is opened.

const CACHE = 'lvbc-member-shell';
const SHELL = [
  '/member/',
  '/member/member.css',
  '/member/js/core.js',
  '/member/js/card.js',
  '/member/js/activity.js',
  '/member/js/menus.js',
  '/member/js/profile.js',
  '/member/js/membership.js',
  '/member/js/store.js',
  '/config.js',
  '/push-client.js',
];
const CDN_HOSTS = ['unpkg.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

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
  // js.stripe.com isn't in CDN_HOSTS on purpose: payment code is never cached.
  if (sameOrigin ? url.pathname.startsWith('/api/') : !CDN_HOSTS.includes(url.hostname)) return;

  event.respondWith(
    fetch(req).then((res) => {
      // Opaque (cross-origin, no-cors) responses report ok=false but are still cacheable.
      if (res.ok || res.type === 'opaque') {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: sameOrigin }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/member/') : Response.error())))
  );
});

// Push notifications (sent from the staff panel's Marketing > Push). The
// payload is { title, body, url }; a tap opens the app at url, or focuses
// it if it is already open.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* not JSON */ }
  event.waitUntil(self.registration.showNotification(data.title || 'Lago Vista Brewing Company', {
    body: data.body || '',
    icon: 'https://opatyodqtfrytgosqxom.supabase.co/storage/v1/object/public/assets/lvbc-logo.png',
    data: { url: data.url || '/member/', title: data.title || 'Lago Vista Brewing Company', body: data.body || '' },
  }));
});

// A tap hands the full text to the app, which shows it in a popup (the
// notification itself truncates long messages). An open app gets it by
// postMessage; a cold start gets it in the URL hash (#push=...), which
// core.js reads and clears.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url, title, body } = event.notification.data;
  const message = { type: 'lvbc-push', title, body };
  const target = new URL(url, self.location.origin);
  if (!target.hash) target.hash = 'push=' + encodeURIComponent(JSON.stringify({ title, body }));
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const open = wins.find((w) => w.url.startsWith(self.location.origin + '/member/'));
    if (open) {
      open.postMessage(message);
      return open.focus();
    }
    return self.clients.openWindow(target.href);
  }));
});
