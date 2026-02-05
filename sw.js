const CACHE_VERSION = 'habits-v8.8';

// Install: activate immediately, don't wait for old SW to finish
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Activate: clear old caches and take control of all clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first, fall back to cache for offline support
// Never cache the HTML page or service worker so updates propagate immediately
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isNavigate = event.request.mode === 'navigate';
  const isSW = url.pathname.endsWith('sw.js');

  // HTML pages and sw.js always go straight to network (no cache fallback for sw.js)
  if (isNavigate || isSW) {
    event.respondWith(
      fetch(event.request).catch(() => isNavigate ? caches.match(event.request) : Response.error())
    );
    return;
  }

  // All other assets: network-first with cache fallback
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (event.request.method === 'GET' && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
