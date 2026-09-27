/* Uchiyomi service worker — app-shell + runtime caching.
   Explicit offline chapter downloads live in IndexedDB (managed by the app);
   this SW handles the shell, static assets, and casual image/API re-reads. */
// Bump on any change to cached assets. /icons is served cache-first, so the rebrand's new icons only reach
// existing visitors once this changes — the activate handler evicts every cache whose name doesn't end in it.
//
// v7: the API cache was previously kept per-URL with no cap and was never cleared on sign-out, so on a shared
// device it may already hold one account's home screen, history and stats. Those existing caches have to go on
// upgrade, not merely stop growing, which is what this bump does.
// v8: this worker leaked an IndexedDB connection, which blocked the page's v1 to v2 upgrade of the offline
// store and hung the reader on "Loading chapter...". The old worker has to be replaced for that to stop, so
// the bump is load-bearing here rather than cosmetic.
// v9: two offline-navigation defects, both invisible while the network is up.
//   (a) Every successful navigation did `c.put('/', res)`, so the ONE shell entry held whatever page was
//       loaded last. Offline, any navigation was answered with that unrelated document.
//   (b) Next's per-route RSC payload (`<route>/index.txt`, a real static file in the export) matched no
//       rule at all, so the client router's fetch went straight to the network and died offline. Next then
//       fell back to a hard navigation, which hit (a), and the tab ended up showing the raw payload as text
//       -- i.e. tapping a DOWNLOADED chapter with no network did not open the reader.
//   Every v8 SHELL entry is keyed wrongly, so this bump is load-bearing rather than cosmetic.
// v10: a cold boot with no network could not open anything, because SHELL is only ever written by a HARD
//   navigation and every route to the reader inside the app is a <Link>. So `/reader/` was in the cache only
//   if someone happened to reload while in it, and `/` held whichever route was hard-loaded last -- a push
//   notification makes that `/series/` -- which would then be served as the document for a reader URL and
//   hydrate the wrong route entirely. The offline surface is precached at install instead of hoped for, and
//   the navigate key is normalised to a trailing slash: the export is written with `trailingSlash: true`, so
//   `/downloads` -> `/downloads/` is a redirect the SERVER performs, and offline there is no server to do it.
//   Every v9 SHELL entry is keyed without the slash, so this bump is load-bearing too.
const VERSION = 'v10';
const SHELL = `yomi-shell-${VERSION}`;
const STATIC = `yomi-static-${VERSION}`;
const IMG = `yomi-img-${VERSION}`;
const API = `yomi-api-${VERSION}`;
const IMG_MAX = 1000;
// The API cache had no cap at all. The reader alone stores three distinct URLs per chapter (/api/books/:id,
// /api/books/:id/pages, and the series' book list), none of which ever repeat, so across a library this size
// it grew without limit. On iOS the Cache API and IndexedDB share ONE origin quota and eviction is
// origin-wide, so left alone it eventually takes the downloaded offline chapters with it.
const API_MAX = 300;

/**
 * The three documents an offline launch needs, plus their RSC payloads, fetched while the network is still
 * there. All six are static files in the export.
 *
 * ⚠️ `skipWaiting()` is called unconditionally and NOT awaited on the precache. A precache is an
 * optimisation; letting a single failed request block activation would leave the old worker in place and
 * make the app worse than having no precache at all.
 */
const OFFLINE_DOCS = ['/', '/downloads/', '/reader/'];
const OFFLINE_PAYLOADS = ['/index.txt', '/downloads/index.txt', '/reader/index.txt'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    (async () => {
      try {
        const shell = await caches.open(SHELL);
        await Promise.all(OFFLINE_DOCS.map(async (u) => {
          try { const r = await fetch(u, { cache: 'reload' }); if (r.ok) await shell.put(u, r); } catch (_) {}
        }));
        const stat = await caches.open(STATIC);
        await Promise.all(OFFLINE_PAYLOADS.map(async (u) => {
          try { const r = await fetch(u, { cache: 'reload' }); if (r.ok) await stat.put(u, r); } catch (_) {}
        }));
      } catch (_) { /* best effort, always */ }
    })(),
  );
});

/**
 * Empty every cache that can hold one account's answers.
 *
 * These caches are origin-scoped and keyed by URL with no `Vary`, and `activate` only ever emptied them on a
 * VERSION bump -- so signing out left the previous person's home screen, history, stats and covers sitting
 * there. On a shared household tablet the next reader only had to hit one network hiccup for `networkFirst`
 * to fall through and serve them, including titles their age cap and library grants correctly hide.
 */
async function clearAccountCaches() {
  await Promise.all([caches.delete(API), caches.delete(IMG)]);
}

/**
 * Who the app last told us is signed in, or null.
 *
 * Background sync runs with the app closed and authenticates with `freshAccessToken()`, which uses the
 * refresh cookie: that is whoever signed in LAST, not necessarily whoever queued the reading. Without this,
 * one person's queued chapters would be filed against the next person's history and streak.
 *
 * Null means "not told yet" (a worker that has not seen a page since it started). In that state, events
 * stamped with an owner are left alone and the foreground flush, which does know, handles them. It runs
 * four seconds after every launch, so nothing waits long.
 */
let ownerHint = null;

self.addEventListener('message', (e) => {
  if (e.data?.type === 'yomi-signout') { ownerHint = null; e.waitUntil(clearAccountCaches()); }
  if (e.data?.type === 'yomi-user') ownerHint = e.data.userId || null;
});

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

async function networkFirst(req, name, max) {
  const c = await caches.open(name);
  try {
    const res = await fetch(req);
    if (res.ok) {
      c.put(req, res.clone());
      // same sampling as the image cache: enumerating every entry on each request is not worth it
      if (max && Math.random() < 0.05) trimCache(name, max);
    }
    return res;
  } catch {
    const hit = await c.match(req);
    return hit || Response.error();
  }
}

/**
 * Network-first, falling back to a copy stored under a caller-chosen key rather than the request's URL.
 *
 * Two decisions, and the second was wrong the first time.
 *
 * KEYED BY PATH: for a static file whose content does not depend on its query string, keying by the full
 * URL stores one identical copy per distinct query and reuses none of them.
 *
 * NETWORK-FIRST, not cache-first: `STATIC` is `yomi-static-${VERSION}`, and VERSION tracks changes to THIS
 * worker, not the app -- it sat at v8 from v0.12.0 to v0.19.0, eight releases that all shipped web changes.
 * So this cache outlives deploys. Next's RSC payloads name build-hashed chunks, and `/_next/static` is
 * served immutable and ships only with the build it belongs to, so a cache-first copy would hand a
 * returning reader the PREVIOUS build's chunk list after every deploy. Next recovers with a hard
 * navigation, so the cost is an unexpected reload per route rather than a broken app -- but it would recur
 * on every release, and it couples this cache to the build id with nothing enforcing it.
 *
 * Going to the network first costs nothing that was not already being paid: before this rule existed the
 * request went to the network unconditionally. The cached copy is purely the offline fallback, which is
 * the only thing it was ever needed for.
 */
async function networkFirstByPath(req, key, name) {
  const c = await caches.open(name);
  try {
    const res = await fetch(req);
    if (res.ok) c.put(key, res.clone());
    return res;
  } catch {
    return (await c.match(key)) || Response.error();
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
        // Keyed by PATHNAME, not by the full URL and not always '/'.
        //
        // Not the full URL, because `/reader/?book=<id>` would store one copy of the same document per
        // chapter and grow without limit -- in a static export the document for a route does not depend on
        // its query string. And not always '/', which is what this did: one entry, overwritten by every
        // navigation, so offline it answered every route with whichever page happened to be loaded last.
        // Normalised to a trailing slash so it matches what `install` precached and what the export emits.
        // Without this, `/downloads` and `/downloads/` are two entries and the offline one is the miss.
        const p0 = new URL(req.url).pathname;
        const key = p0.endsWith('/') ? p0 : `${p0}/`;
        try {
          const res = await fetch(req);
          if (res.ok) {
            const c = await caches.open(SHELL);
            c.put(key, res.clone());
            // '/' stays the last-resort fallback for a route never loaded as a document, so keep it fresh.
            if (key !== '/') c.put('/', res.clone());
          }
          return res;
        } catch {
          const c = await caches.open(SHELL);
          return (await c.match(key)) || (await c.match('/')) || Response.error();
        }
      })(),
    );
    return;
  }

  // Next's per-route RSC payload. In this export it is a real static file (`out/<route>/index.txt`) that
  // the client router fetches on every client-side navigation, and its content does not vary with the query
  // string -- so it is cached ONCE PER ROUTE, keyed by pathname, and there are about as many entries as
  // there are pages.
  //
  // This is the whole reason a downloaded chapter would not open offline: without this rule the fetch went
  // to the network, failed, and Next fell back to a hard navigation. Tapping a chapter inside the running
  // app is the path that actually matters, and it needs nothing but this payload.
  if (url.pathname.endsWith('.txt')) {
    e.respondWith(networkFirstByPath(req, url.pathname, STATIC));
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
    //
    // The admin console is never cached here either (v0.49.0). Health polls the repair's status every two
    // seconds while a run is going, and each answer through `networkFirst` went into the capped API cache,
    // churning the 300 entries a reader's offline re-reads depend on; and an admin answer replayed from cache
    // is a stale "running" that never ends.
    if (url.pathname.startsWith('/api/sources') || url.pathname.startsWith('/api/admin/')) {
      e.respondWith(fetch(req));
      return;
    }
    e.respondWith(networkFirst(req, API, API_MAX));
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
// This connection MUST be closed on every path out.
//
// It was not, and v0.11.1 turned that into a hang. An IndexedDB version change waits for every other open
// connection to close, so this one, held open by a long-lived worker after the first flush, blocked the
// page's v1 to v2 upgrade indefinitely. The page awaits the offline store before rendering a chapter, so the
// reader sat on "Loading chapter..." for good. Note the several early returns below: each one used to leak
// the handle, and the `!vals.length` path is the common case, so it leaked almost every time.
//
// `onversionchange` is the belt to that braces: if a page starts an upgrade while we are mid-flush, let go
// at once rather than making it wait for us.
async function flushOutboxSW() {
  let db;
  try { db = await reqp(indexedDB.open('yomi-offline')); } catch (_) { return; }
  db.onversionchange = () => { try { db.close(); } catch (_) {} };
  try {
    await flushOutboxWith(db);
  } finally {
    try { db.close(); } catch (_) {}
  }
}

async function flushOutboxWith(db) {
  if (!db.objectStoreNames.contains('outbox')) return;
  const ro = db.transaction('outbox', 'readonly').objectStore('outbox');
  let keys, vals;
  try { [keys, vals] = await Promise.all([reqp(ro.getAllKeys()), reqp(ro.getAll())]); } catch (_) { return; }
  if (!vals || !vals.length) return;
  const token = await freshAccessToken();
  if (!token) return;
  for (let i = 0; i < vals.length; i++) {
    const ev = vals[i];
    // Events carry an owner since v0.11.1. The worker cannot know who is signed in, and `freshAccessToken`
    // authenticates as whoever holds the refresh cookie, so an event stamped with a different account is
    // left for the app to flush when that person is actually signed in.
    if (ev.userId && ev.userId !== ownerHint) continue;
    try {
      const r = await fetch(`/api/books/${ev.bookId}/progress`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ page: ev.page, completed: ev.completed, seriesId: ev.seriesId, deviceId: ev.deviceId, at: ev.ts }),
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
