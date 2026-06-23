/* Koryomi service worker — app-shell + runtime caching.
   Explicit offline chapter downloads live in IndexedDB (managed by the app);
   this SW handles the shell, static assets, and casual image/API re-reads. */
const VERSION = 'v3';
const SHELL = `yomi-shell-${VERSION}`;
const STATIC = `yomi-static-${VERSION}`;
const IMG = `yomi-img-${VERSION}`;
const API = `yomi-api-${VERSION}`;
const IMG_MAX = 1000;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

async function cacheFirst(req, name, trim) {
  const c = await caches.open(name);
  const hit = await c.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === 'opaque') {
      c.put(req, res.clone());
      if (trim) trimCache(name, IMG_MAX);
    }
    return res;
  } catch {
    return hit || Response.error();
  }
}

// Serve the cached copy instantly but always refetch in the background, so a stale/broken cached
// image self-heals on the next view (and we never get stuck serving a failed response).
async function staleWhileRevalidate(req, name, trim) {
  const c = await caches.open(name);
  const hit = await c.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res.ok || res.type === 'opaque') {
        c.put(req, res.clone());
        // trimming enumerates the whole cache — do it occasionally, not on every image request
        if (trim && Math.random() < 0.05) trimCache(name, IMG_MAX);
      }
      return res;
    })
    .catch(() => hit || Response.error());
  return hit || network;
}

async function networkFirst(req, name) {
  const c = await caches.open(name);
  try {
    const res = await fetch(req);
    if (res.ok) c.put(req, res.clone());
    return res;
  } catch {
    const hit = await c.match(req);
    return hit || Response.error();
  }
}

async function trimCache(name, max) {
  const c = await caches.open(name);
  const keys = await c.keys();
  if (keys.length > max) {
    for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          const c = await caches.open(SHELL);
          c.put('/', res.clone());
          return res;
        } catch {
          const c = await caches.open(SHELL);
          return (await c.match('/')) || (await c.match(req)) || Response.error();
        }
      })(),
    );
    return;
  }

  if (
    url.pathname.startsWith('/_next/static') ||
    url.pathname.startsWith('/icons') ||
    url.pathname === '/manifest.webmanifest'
  ) {
    e.respondWith(cacheFirst(req, STATIC, false));
    return;
  }

  if (url.pathname.startsWith('/img/')) {
    e.respondWith(staleWhileRevalidate(req, IMG, true));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    e.respondWith(networkFirst(req, API));
    return;
  }
});
