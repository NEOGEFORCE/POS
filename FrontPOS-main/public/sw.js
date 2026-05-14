const CACHE_NAME = 'pos-ultra-cache-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/login',
  '/sales/new',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Estrategia Stale-While-Revalidate para mayor velocidad
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  // No interceptar llamadas a la API, SSE o HMR de Next.js
  if (url.pathname.startsWith('/api/') || url.pathname.includes('_next/webpack-hmr')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchedResponse = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache).catch(err => {
                console.warn('[SW] Fallo al cachear:', event.request.url, err);
            });
          });
        }
        return networkResponse;
      }).catch(() => {
          // Fallback offline si falla red y no está en cache
          return cachedResponse;
      });

      return cachedResponse || fetchedResponse || new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
    }).catch(() => {
        return new Response('Offline Error', { status: 503 });
    })
  );
});
