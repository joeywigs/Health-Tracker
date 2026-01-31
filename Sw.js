const CACHE_NAME = ‘habits-v1’;
const STATIC_ASSETS = [
‘/’,
‘/index.html’,
‘/app.js’,
‘/icons/new-icon.png’,
‘https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap’
];

// Install - cache static assets
self.addEventListener(‘install’, (event) => {
event.waitUntil(
caches.open(CACHE_NAME).then((cache) => {
return cache.addAll(STATIC_ASSETS);
})
);
self.skipWaiting();
});

// Activate - clean up old caches
self.addEventListener(‘activate’, (event) => {
event.waitUntil(
caches.keys().then((cacheNames) => {
return Promise.all(
cacheNames
.filter((name) => name !== CACHE_NAME)
.map((name) => caches.delete(name))
);
})
);
self.clients.claim();
});

// Fetch - network first, fall back to cache
self.addEventListener(‘fetch’, (event) => {
// Skip non-GET requests
if (event.request.method !== ‘GET’) return;

// Skip API requests (let them go to network)
if (event.request.url.includes(‘workers.dev’)) return;

event.respondWith(
fetch(event.request)
.then((response) => {
// Clone the response before caching
const responseClone = response.clone();
caches.open(CACHE_NAME).then((cache) => {
cache.put(event.request, responseClone);
});
return response;
})
.catch(() => {
// Network failed, try cache
return caches.match(event.request);
})
);
});