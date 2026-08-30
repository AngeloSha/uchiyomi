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
