/* Uchiyomi service worker — app-shell + runtime caching.
   Explicit offline chapter downloads live in IndexedDB (managed by the app);
   this SW handles the shell, static assets, and casual image/API re-reads. */
// Bump on any change to cached assets. /icons is served cache-first, so the rebrand's new icons only reach
// existing visitors once this changes — the activate handler evicts every cache whose name doesn't end in it.
const VERSION = 'v6';
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
    // Source browsing is never cached here. The Cache API keys by URL with no `Vary` and this cache is
    // origin-scoped and only ever evicted on a VERSION bump -- not on logout. These responses are now
    // per-account (an age-limited account is served a filtered source list, and an account that may not
    // download is refused outright), so a stored copy is one account's answer waiting to be replayed to the
    // next person on a shared household device. VERSION went to v6 to drop copies stored before this.
    if (url.pathname.startsWith('/api/sources')) {
      e.respondWith(fetch(req));
      return;
    }
    e.respondWith(networkFirst(req, API));
    return;
  }
});

// ---- web push: new-chapter notifications ----
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const title = data.title || 'Uchiyomi';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || 'A new chapter is available',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag,
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if ('focus' in c) { try { await c.navigate(target); } catch (_) {} return c.focus(); }
      }
      if (clients.openWindow) return clients.openWindow(target);
    })(),
  );
});

// If the browser rotates the push endpoint, the old subscription silently dies — re-subscribe with the
// same server key and re-register it, so new-chapter notifications survive without a manual re-toggle.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const key = event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey;
        if (!key) return;
        const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        const token = await freshAccessToken();
        if (!token) return;
        const j = sub.toJSON();
        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }),
        });
      } catch (_) { /* next Profile visit re-subscribes by hand */ }
    })(),
  );
});

// ---- background sync: flush the queued reading-progress outbox even when the app is closed ----
function reqp(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function freshAccessToken() {
  // the SW has no in-memory access token; mint one from the httpOnly refresh cookie
  try {
    const r = await fetch('/auth/refresh', { method: 'POST', credentials: 'include' });
    if (!r.ok) return null;
    return (await r.json()).accessToken || null;
  } catch (_) { return null; }
}
async function flushOutboxSW() {
  let db;
  try { db = await reqp(indexedDB.open('yomi-offline')); } catch (_) { return; }
  if (!db.objectStoreNames.contains('outbox')) return;
  const ro = db.transaction('outbox', 'readonly').objectStore('outbox');
  let keys, vals;
  try { [keys, vals] = await Promise.all([reqp(ro.getAllKeys()), reqp(ro.getAll())]); } catch (_) { return; }
  if (!vals || !vals.length) return;
  const token = await freshAccessToken();
  if (!token) return;
  for (let i = 0; i < vals.length; i++) {
    const ev = vals[i];
    try {
      const r = await fetch(`/api/books/${ev.bookId}/progress`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ page: ev.page, completed: ev.completed, seriesId: ev.seriesId, deviceId: ev.deviceId }),
      });
      // success or permanent rejection -> drop the entry; transient failures stay queued
      if (r.ok || (r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 429)) {
        const rw = db.transaction('outbox', 'readwrite');
        rw.objectStore('outbox').delete(keys[i]);
        await new Promise((res) => { rw.oncomplete = res; rw.onerror = res; rw.onabort = res; });
      }
    } catch (_) { /* still offline — the sync retries later */ }
  }
}
self.addEventListener('sync', (event) => {
  if (event.tag === 'yomi-progress') event.waitUntil(flushOutboxSW());
});
