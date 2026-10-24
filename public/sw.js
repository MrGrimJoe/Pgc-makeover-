/*
 * Dialtone service worker: static files only.
 *
 * What it does:
 *   - keeps the offline page, the app icons, the hashed build files (/assets/) and the bundled
 *     stickers so the app starts faster and shows a clear page when the phone is offline.
 * What it never does:
 *   - touch /api/ (feeds, profiles, messages, media, sign-in all go straight to the network),
 *   - cache HTML pages, uploads or any response for a signed-in person,
 *   - handle non-GET or range (video) requests.
 * Bump CACHE when this file's rules change; old caches are deleted on activate.
 */
const CACHE = 'dialtone-static-v1';
const OFFLINE_URL = '/offline.html';
const PRECACHE = [
  OFFLINE_URL,
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

/** Same-origin static paths that are safe to keep. Everything else is left to the browser. */
function isCacheableStatic(pathname) {
  if (pathname.startsWith('/api/')) return false;
  return (
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/icons/') ||
    pathname.startsWith('/stickers/') ||
    pathname === OFFLINE_URL
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('dialtone-static-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return; // video seeking must reach the network untouched
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Page loads: always the network (the shell is tiny and changes with each deploy); offline page on failure.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL).then((r) => r || Response.error()))
    );
    return;
  }

  if (!isCacheableStatic(url.pathname)) return;

  // Static files: cache first, fill the cache from the network. Only complete, successful responses are kept.
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response.ok && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      });
    })
  );
});
