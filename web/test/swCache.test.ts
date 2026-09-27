// The service worker's runtime caches, on a device more than one person uses.
//
// Two faults, both in what the SW keeps and for how long:
//
//  1. The API and image caches are origin-scoped and keyed by URL with NO `Vary`, and `activate` only ever
//     emptied them on a VERSION bump. Signing out cleared nothing, so the next reader on a shared tablet only
//     had to hit one network hiccup for `networkFirst` to fall through and hand them the previous person's
//     home screen, history and stats -- including titles their age cap and library grants correctly hide.
//     The `/api/sources` carve-out already stated this reasoning in a comment; it just applied to one path.
//
//  2. The API cache had no cap. The reader stores three distinct, never-repeating URLs per chapter, so it
//     grew without limit. On iOS the Cache API and IndexedDB share one origin quota and eviction is
//     origin-wide, which means it eventually takes the reader's downloaded offline chapters with it.
//
// sw.js is plain browser JS with no module surface, so it is evaluated here against a fake worker global.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

/** Minimal CacheStorage: enough of the shape that sw.js cannot tell the difference. */
function makeCaches() {
  const store = new Map<string, Map<string, any>>();
  const open = async (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    const c = store.get(name)!;
    return {
      match: async (req: any) => c.get(typeof req === 'string' ? req : req.url),
      put: async (req: any, res: any) => { c.set(typeof req === 'string' ? req : req.url, res); },
      delete: async (req: any) => c.delete(typeof req === 'string' ? req : req.url),
      keys: async () => [...c.keys()].map((url) => ({ url })),
    };
  };
  return {
    api: {
      open,
      keys: async () => [...store.keys()],
      delete: async (name: string) => store.delete(name),
    },
    store,
  };
}

function loadSw() {
  const src = readFileSync(join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  const handlers: Record<string, Function> = {};
  const { api: cachesApi, store } = makeCaches();

  const self: any = {
    addEventListener: (t: string, h: Function) => { handlers[t] = h; },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
    registration: {},
  };
  const ctx: any = {
    self, caches: cachesApi, console,
    location: { origin: 'https://yomi.test' },
    URL, Response, Request, Math, JSON, Promise, Date, TypeError,
    fetch: async (req: any) => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    setTimeout, clearTimeout,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { handlers, store, ctx };
}

/** Drive the fetch handler the way the browser does, and hand back what it responded with. */
async function doFetch(handlers: Record<string, Function>, url: string) {
  let responded: Promise<any> | undefined;
  await handlers.fetch({
    request: { method: 'GET', url, mode: 'cors' },
    respondWith: (p: any) => { responded = p; },
  });
  return responded ? await responded : undefined;
}

test('signing out empties the caches that hold one account’s answers', async () => {
  const { handlers, store } = loadSw();
  assert.ok(handlers.message, 'the SW must listen for a sign-out message at all');

  await doFetch(handlers, 'https://yomi.test/api/home');
  await doFetch(handlers, 'https://yomi.test/api/history');
  const apiCache = [...store.keys()].find((k) => k.startsWith('yomi-api-'))!;
  assert.equal(store.get(apiCache)!.size, 2, 'precondition: those answers were cached');

  const waits: Promise<any>[] = [];
  await handlers.message({ data: { type: 'yomi-signout' }, waitUntil: (p: any) => waits.push(p) });
  await Promise.all(waits);

  assert.ok(!store.has(apiCache), 'the API cache must be gone after sign-out');
  assert.ok(![...store.keys()].some((k) => k.startsWith('yomi-img-')), 'so must the image cache');
});

test('the API cache is capped, so it cannot grow until the browser evicts the origin', async () => {
  const { handlers, store, ctx } = loadSw();
  ctx.Math = { ...Math, random: () => 0 }; // trimming is sampled at 5%; make it certain rather than likely

  for (let i = 0; i < 400; i++) await doFetch(handlers, `https://yomi.test/api/books/b${i}/pages`);
  // trimming is deliberately fire-and-forget so it never sits in front of a response; give the last one a turn
  await new Promise((r) => setTimeout(r, 50));

  const apiCache = [...store.keys()].find((k) => k.startsWith('yomi-api-'))!;
  const n = store.get(apiCache)!.size;
  assert.ok(n <= 300, `the API cache should stay within its cap, held ${n}`);
  assert.ok(n > 0, 'but it should still be caching, otherwise offline re-reads break');
});

test('source browsing is still never cached', async () => {
  const { handlers, store } = loadSw();
  await doFetch(handlers, 'https://yomi.test/api/sources/latest?source=x');
  const apiCache = [...store.keys()].find((k) => k.startsWith('yomi-api-'));
  assert.ok(!apiCache || store.get(apiCache)!.size === 0, 'per-account source answers must not be stored');
});

test('the admin console is never cached, so a polled repair status cannot churn the API cache', async () => {
  // Health polls GET /api/admin/tasks/repair/status every 2 s while a repair runs (v0.49.0). Through
  // networkFirst each answer was stored, evicting a reader's cached pages from the 300-entry cache, and an
  // offline replay would show a run "running" forever. Reintroduce by dropping the `/api/admin/` half of the
  // network-only rule in sw.js: the cache holds the status answers.
  const { handlers, store } = loadSw();
  for (let i = 0; i < 5; i++) await doFetch(handlers, 'https://yomi.test/api/admin/tasks/repair/status');
  await doFetch(handlers, 'https://yomi.test/api/admin/health');
  await new Promise((r) => setTimeout(r, 20));
  const apiCache = [...store.keys()].find((k) => k.startsWith('yomi-api-'));
  const held = apiCache ? [...store.get(apiCache)!.keys()].filter((u) => u.includes('/api/admin/')) : [];
  assert.deepEqual(held, [], 'admin answers were stored in the API cache');
  // ...while the reader's own API answers are still cached, or offline re-reads break.
  await doFetch(handlers, 'https://yomi.test/api/books/b1/pages');
  await new Promise((r) => setTimeout(r, 20));
  const after = [...store.keys()].find((k) => k.startsWith('yomi-api-'));
  assert.ok(after && store.get(after)!.size > 0, 'the API cache stopped caching everything');
});

test('the new worker drops the admin answers a v10 worker stored', async () => {
  // Admin answers went through networkFirst until v0.49.0, so a v10 API cache can hold hundreds of repair-status
  // polls that nothing reads any more; only a VERSION bump evicts them. Reintroduce by leaving VERSION at 'v10':
  // the old cache survives activation.
  const { handlers, store } = loadSw();
  store.set('yomi-api-v10', new Map([['https://yomi.test/api/admin/tasks/repair/status', {}], ['https://yomi.test/api/books/b1/pages', {}]]));
  store.set('yomi-shell-v10', new Map([['https://yomi.test/', {}]]));
  const waits: Promise<any>[] = [];
  await handlers.activate({ waitUntil: (p: any) => waits.push(p) });
  await Promise.all(waits);
  assert.ok(!store.has('yomi-api-v10'), 'the v10 API cache, with its stored admin answers, survived the new worker');
  assert.ok(!store.has('yomi-shell-v10'), 'a v10 cache survived the new worker');
});

// ---- what v9 and v10 exist for: offline navigation ----------------------------------------------------
//
// Neither of the two rules below had a test, which is how they came to be the subject of a bug report three
// releases after they shipped. They are the difference between a downloaded chapter opening on a plane and
// the tab showing Next's raw payload as text.

/** Drive the fetch handler as a document navigation rather than a subresource. */
async function doNavigate(handlers: Record<string, Function>, url: string) {
  let responded: Promise<any> | undefined;
  await handlers.fetch({
    request: { method: 'GET', url, mode: 'navigate' },
    respondWith: (p: any) => { responded = p; },
  });
  return responded ? await responded : undefined;
}

test('a navigation is cached per ROUTE, not under one shared key', async () => {
  const { handlers, store } = loadSw();
  await doNavigate(handlers, 'https://yomi.test/library/');
  await doNavigate(handlers, 'https://yomi.test/downloads/');

  const shell = [...store.keys()].find((k) => k.startsWith('yomi-shell-'))!;
  const keys = [...store.get(shell)!.keys()];
  // Reintroduce by keying every navigation as '/': offline, any route is answered with whichever document
  // was loaded last, which is what shipped before v9.
  assert.ok(keys.includes('/library/'), 'the library document was not cached under its own path');
  assert.ok(keys.includes('/downloads/'), 'the downloads document was not cached under its own path');
});

test('the query string does not multiply cache entries for one route', async () => {
  const { handlers, store } = loadSw();
  // Every chapter is a different `?book=`, and in a static export they all resolve to ONE document.
  // Reintroduce by keying on the full URL and this cache grows by one identical copy per chapter opened.
  for (const id of ['b1', 'b2', 'b3']) await doNavigate(handlers, `https://yomi.test/reader/?book=${id}`);
  const shell = [...store.keys()].find((k) => k.startsWith('yomi-shell-'))!;
  const readerKeys = [...store.get(shell)!.keys()].filter((k) => String(k).startsWith('/reader'));
  assert.deepEqual(readerKeys, ['/reader/'], 'the reader document should be stored exactly once');
});

test('a route is answered from cache when the network is gone', async () => {
  const { handlers, store, ctx } = loadSw();
  await doNavigate(handlers, 'https://yomi.test/downloads/');
  ctx.fetch = async () => { throw new TypeError('Failed to fetch'); }; // airplane mode

  const res = await doNavigate(handlers, 'https://yomi.test/downloads/');
  assert.ok(res && res.status !== 0, 'the downloads document must survive the network going away');
  const shell = [...store.keys()].find((k) => k.startsWith('yomi-shell-'))!;
  assert.ok([...store.get(shell)!.keys()].includes('/downloads/'));
});

test('Next’s per-route payload is cached, keyed by path and not by its query', async () => {
  const { handlers, store } = loadSw();
  // Without a rule for this the client router's fetch went to the network, died offline, and Next fell back
  // to a hard navigation -- which is how a tab ended up showing `1:{"...` as plain text.
  // Reintroduce by deleting the `.txt` branch from sw.js.
  await doFetch(handlers, 'https://yomi.test/reader/index.txt?book=b1&_rsc=abc');
  await doFetch(handlers, 'https://yomi.test/reader/index.txt?book=b2&_rsc=def');
  const stat = [...store.keys()].find((k) => k.startsWith('yomi-static-'))!;
  const txt = [...store.get(stat)!.keys()].filter((k) => String(k).includes('.txt'));
  assert.deepEqual(txt, ['/reader/index.txt'], 'the payload should be one entry per route, query stripped');
});

test('install precaches the surface a cold offline launch needs', async () => {
  const { handlers, store } = loadSw();
  assert.ok(handlers.install, 'the SW must handle install');
  const waits: Promise<any>[] = [];
  await handlers.install({ waitUntil: (p: any) => waits.push(p) });
  await Promise.all(waits);

  const shell = [...store.keys()].find((k) => k.startsWith('yomi-shell-'))!;
  const keys = [...store.get(shell)!.keys()].map(String);
  // ⚠️ SHELL is only ever written by a HARD navigation, and every route to the reader inside the app is a
  // <Link>. Without this precache, `/reader/` is in the cache only if someone happened to reload while in
  // it. Reintroduce by dropping the precache and a cold boot on a plane depends on luck.
  for (const p of ['/', '/downloads/', '/reader/']) {
    assert.ok(keys.includes(p), `${p} was not precached at install`);
  }
});
