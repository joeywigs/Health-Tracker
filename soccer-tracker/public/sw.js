/* Offline app shell.
 *
 * Fields have terrible signal, so the app has to boot with no network at all.
 * Game data never comes from here — it lives in localStorage and syncs to D1
 * separately — so this only needs to cache the shell.
 *
 * Bump CACHE when you change any shell file.
 */
const CACHE = 'soccer-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/app.css',
  '/app.js',
  '/icon.svg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache the API — stale game data is worse than no game data.
  if (url.pathname.startsWith('/api/')) return;

  // Network-first so a deploy is picked up as soon as there is signal, with the
  // cached shell as the fallback when there isn't.
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(request);
        if (hit) return hit;
        if (request.mode === 'navigate') return caches.match('/index.html');
        return new Response('offline', { status: 503 });
      })
  );
});
