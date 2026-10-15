// MangaUpdates as a progress tracker: the adapter in lib/trackerProviders.ts, against a stand-in service that
// MANGAUPDATES_API_URL points it at. No database: the module opens none.
//
// What is pinned here is what is particular to MangaUpdates: it shows no token (its login API answers a session token
// the person pastes; this server never sees a password), its lists are numbered per account, an entry is simply absent
// until it is on a list, a series states only whether it has `completed`, a second write inside five seconds is refused
// with a 412 -- and every call waits its turn at lib/mangaupdates.ts's one-a-second gate, which Discover shares.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

type Hit = { method: string; path: string; body: any; auth: string };
const hits: Hit[] = [];
let answer: (h: Hit) => { status?: number; body?: unknown } = () => ({ status: 500 });

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body: any = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString() || 'null'); } catch { /* not JSON */ }
    const h = { method: req.method ?? '', path: req.url ?? '', body, auth: String(req.headers.authorization ?? '') };
    hits.push(h);
    const a = answer(h);
    res.writeHead(a.status ?? 200, { 'content-type': 'application/json' });
    res.end(a.body === undefined ? '' : JSON.stringify(a.body));
  });
});
// The adapter reads its base URL once, at load, so the stand-in is listening before it is imported.
test.before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.MANGAUPDATES_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  // No second between calls here, but for the test that measures the gap: each list id read is cached, so a test
  // that changes the lists uses a token of its own.
  (await import('../src/lib/mangaupdates')).setMangaUpdatesGap(0);
});
test.after(() => { server.close(); });

const mod = () => import('../src/lib/trackerProviders');
const reset = (a: typeof answer) => { hits.length = 0; answer = a; };

// The account's five standard lists, as /lists reports them.
const LISTS = [
  { list_id: 0, type: 'read' }, { list_id: 1, type: 'wish' }, { list_id: 2, type: 'complete' },
  { list_id: 3, type: 'unfinished' }, { list_id: 4, type: 'hold' }, { list_id: 9, type: 'custom', custom: true },
];

test('MangaUpdates is a provider with a complete adapter, and its help points at the guide\'s recipe', async () => {
  const { ADAPTERS, PROVIDERS, isProvider } = await mod();
  assert.ok(PROVIDERS.includes('mangaupdates'));
  assert.ok(isProvider('mangaupdates'));
  const a = ADAPTERS.mangaupdates;
  assert.equal(a.id, 'mangaupdates');
  assert.equal(a.label, 'MangaUpdates');
  assert.equal(a.tokenDays, null, 'the service does not say when a session ends');
  assert.equal(a.authorizeUrl, undefined);
  assert.match(a.tokenHelp, /session token/);
  // #244 as opened traded a username and password through this server, with no rate limit. Reintroduce it: this fails.
  assert.equal((await mod() as any).mangaupdatesLogin, undefined, 'the server signs in to MangaUpdates again');
});

test('whoAmI names the account; a 401 is a rejected token, a 5xx is not', async () => {
  const { ADAPTERS, verdictOf } = await mod();
  reset(() => ({ body: { user_id: 77, username: 'reader' } }));
  assert.deepEqual(await ADAPTERS.mangaupdates.whoAmI('tok'), { id: '77', name: 'reader' });
  assert.equal(hits[0].auth, 'Bearer tok');
  assert.equal(hits[0].path, '/v1/account/profile');
  reset(() => ({ status: 401, body: { reason: 'This action requires a user account' } }));
  await assert.rejects(ADAPTERS.mangaupdates.whoAmI('bad'), (e: any) => verdictOf(e).verdict === 'rejected');
  reset(() => ({ status: 502 }));
  await assert.rejects(ADAPTERS.mangaupdates.whoAmI('tok'), (e: any) => verdictOf(e).verdict === 'refused');
});

test('listLibrary reads each list asked for, by the id the account gives it, and pages by its own numbers', async () => {
  const { ADAPTERS } = await mod();
  const row = (id: number, title: string, chapter: number, type = 'Manga') =>
    ({ record: { series: { id, title }, status: { chapter } }, metadata: { series: { series_id: id, title, type } } });
  reset((h) => {
    if (h.path === '/v1/lists') return { body: LISTS.map((l) => (l.type === 'read' ? { ...l, list_id: 12 } : l)) };
    if (h.path === '/v1/lists/12/search') {
      return h.body.page === 1
        ? { body: { total_hits: 101, results: Array.from({ length: 100 }, (_, i) => row(1000 + i, `Series ${i}`, i)) } }
        : { body: { total_hits: 101, results: [row(2000, 'The Last One', 7, 'Novel')] } };
    }
    if (h.path === '/v1/lists/1/search') return { body: { total_hits: 1, results: [row(3000, 'Wished', 0, 'Manhwa')] } };
    return { status: 404 };
  });
  const all = await ADAPTERS.mangaupdates.listLibrary('tok-12', { statuses: ['reading', 'plan_to_read'], max: 500 });
  assert.equal(all.length, 102);
  assert.deepEqual(all[0], { externalId: '1000', title: 'Series 0', altTitles: [], status: 'reading', progress: 0, format: 'manga' });
  assert.equal(all[100].format, 'novel');
  assert.equal(all[101].status, 'plan_to_read');
  assert.equal(all[101].format, 'manga');
  const searches = hits.filter((h) => h.path.endsWith('/search')).map((h) => `${h.path}#${h.body.page}`);
  assert.deepEqual(searches, ['/v1/lists/12/search#1', '/v1/lists/12/search#2', '/v1/lists/1/search#1']);
  // capped at `max`, and nothing is asked for with nothing to ask
  reset((h) => (h.path === '/v1/lists' ? { body: LISTS } : { body: { total_hits: 100, results: Array.from({ length: 100 }, (_, i) => row(i + 1, `T${i}`, 1)) } }));
  assert.equal((await ADAPTERS.mangaupdates.listLibrary('tok-cap', { statuses: ['reading'], max: 5 })).length, 5);
  reset(() => ({ status: 500 }));
  assert.deepEqual(await ADAPTERS.mangaupdates.listLibrary('tok', { statuses: [], max: 5 }), []);
  assert.equal(hits.length, 0);
});

test('seriesState: absent from every list is no entry; the list it is on is its status; `completed` is the end', async () => {
  const { ADAPTERS } = await mod();
  const run = (series: unknown, entry: { status?: number; body?: unknown }) => {
    reset((h) => {
      if (h.path === '/v1/series/42') return { body: series };
      if (h.path === '/v1/lists') return { body: LISTS };
      if (h.path === '/v1/lists/series/42') return entry;
      return { status: 500 };
    });
    // `ref` is the adapter's own note for its setProgress (the next test reads it), not part of the answer.
    return ADAPTERS.mangaupdates.seriesState('tok', '42').then(({ ref: _ref, ...answer }) => answer);
  };
  assert.deepEqual(await run({ completed: false, latest_chapter: 90 }, { status: 404 }), { ended: false, total: null, entry: null });
  // the newest chapter is a total only once nothing more is coming
  assert.deepEqual(await run({ completed: true, latest_chapter: 120, status: '120 Chapters (Complete)' }, { body: { list_id: 2, status: { chapter: 120 } } }),
    { ended: true, total: 120, entry: { status: 'completed', progress: 120 } });
  assert.deepEqual((await run({ completed: false, latest_chapter: 5 }, { body: { list_id: 4, status: { chapter: 3 } } })).entry, { status: 'on_hold', progress: 3 });
  assert.deepEqual((await run({ completed: false }, { body: { list_id: 1, status: { chapter: 0 } } })).entry, { status: 'plan_to_read', progress: 0 });
  assert.equal((await run({ completed: false }, { body: { list_id: 9, status: { chapter: 2 } } })).entry?.status, 'reading', 'a custom list counts as reading');
  await assert.rejects(ADAPTERS.mangaupdates.seriesState('tok', 'abc'), /not a series id/);
});

test('setProgress adds a series that is not on a list, to reading, and updates one that is', async () => {
  const { ADAPTERS } = await mod();
  reset((h) => {
    if (h.path === '/v1/lists') return { body: LISTS };
    if (h.path === '/v1/lists/series/42') return { status: 404 };
    return { body: { status: 'success' } };
  });
  await ADAPTERS.mangaupdates.setProgress('tok', '42', 7, 'reading');
  let w = hits.find((h) => h.method === 'POST')!;
  assert.equal(w.path, '/v1/lists/series');
  assert.deepEqual(w.body, [{ series: { id: 42 }, list_id: 0, status: { chapter: 7 } }]);

  // on the wish list, being read: moved to reading; completed: moved to complete; on a custom list: left there
  const on = (list_id: number) => {
    reset((h) => {
      if (h.path === '/v1/lists') return { body: LISTS };
      if (h.path === '/v1/lists/series/42') return { body: { list_id, status: { chapter: 1 } } };
      return { body: { status: 'success' } };
    });
  };
  on(1);
  await ADAPTERS.mangaupdates.setProgress('tok', '42', 8, 'reading');
  w = hits.find((h) => h.method === 'POST')!;
  assert.equal(w.path, '/v1/lists/series/update');
  assert.equal(w.body[0].list_id, 0);
  on(0);
  await ADAPTERS.mangaupdates.setProgress('tok', '42', 100, 'completed');
  assert.equal(hits.find((h) => h.method === 'POST')!.body[0].list_id, 2);
  on(9);
  await ADAPTERS.mangaupdates.setProgress('tok', '42', 9, 'reading');
  assert.equal(hits.find((h) => h.method === 'POST')!.body[0].list_id, 9);
});

test('a write the service refuses with a 401 disables the connection (authFailed); a 500 does not', async () => {
  const { ADAPTERS } = await mod();
  reset((h) => (h.path === '/v1/lists' ? { body: LISTS } : h.path === '/v1/lists/series/42' ? { status: 404 } : { status: 401 }));
  await assert.rejects(ADAPTERS.mangaupdates.setProgress('tok', '42', 1, 'reading'), (e: any) => e.authFailed === true);
  reset((h) => (h.path === '/v1/lists' ? { body: LISTS } : h.path === '/v1/lists/series/42' ? { status: 404 } : { status: 500 }));
  await assert.rejects(ADAPTERS.mangaupdates.setProgress('tok', '42', 1, 'reading'), (e: any) => !e.authFailed);
});

test('every call waits its turn at the one-a-second gate Discover shares (#244)', async () => {
  // A list import or a burst of pushes must not get this server's address throttled for everyone's Discover lookups.
  // Reintroduce by dropping the gate from muCall: the tracker's calls arrive together and the spacing check fails.
  const { setMangaUpdatesGap, searchMangaUpdates } = await import('../src/lib/mangaupdates');
  const { ADAPTERS } = await mod();
  const at: number[] = [];
  reset((h) => {
    at.push(Date.now());
    if (h.path === '/v1/lists') return { body: LISTS };
    if (h.path === '/v1/series/search') return { body: { results: [] } };
    if (h.path === '/v1/series/42') return { body: { completed: false } };
    if (h.path === '/v1/lists/series/42') return { status: 404 };
    return { body: {} };
  });
  setMangaUpdatesGap(80);
  try {
    // Two people's pushes and a Discover lookup, all at once.
    await Promise.all([
      ADAPTERS.mangaupdates.seriesState('tok-gap-a', '42'),
      searchMangaUpdates('Walk Tale', () => false),
      ADAPTERS.mangaupdates.seriesState('tok-gap-b', '42'),
    ]);
  } finally { setMangaUpdatesGap(0); }
  assert.equal(at.length, 7, 'the calls were not all made');
  const sorted = [...at].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i] - sorted[i - 1] >= 60, `two calls came ${sorted[i] - sorted[i - 1]} ms apart`);
});

test('a push writes from what seriesState read, and the list ids are asked once in a while', async () => {
  // #244 as opened made about six calls a push (/lists and the entry read twice each). Reintroduce the second read:
  // the call list carries GET /v1/lists/series/42 twice.
  const { ADAPTERS } = await mod();
  reset((h) => {
    if (h.path === '/v1/lists') return { body: LISTS };
    if (h.path === '/v1/series/42') return { body: { completed: false, latest_chapter: 9 } };
    if (h.path === '/v1/lists/series/42') return { body: { list_id: 0, status: { chapter: 3 } } };
    return { body: { status: 'success' } };
  });
  const a = ADAPTERS.mangaupdates;
  const calls = () => hits.map((h) => `${h.method} ${h.path}`);
  await a.setProgress('tok-ref', '42', 4, 'reading', await a.seriesState('tok-ref', '42'));
  assert.deepEqual(calls(), ['GET /v1/series/42', 'GET /v1/lists', 'GET /v1/lists/series/42', 'POST /v1/lists/series/update']);
  assert.deepEqual(hits.at(-1)!.body, [{ series: { id: 42 }, list_id: 0, status: { chapter: 4 } }]);
  hits.length = 0;
  await a.setProgress('tok-ref', '42', 5, 'reading', await a.seriesState('tok-ref', '42'));
  assert.deepEqual(calls(), ['GET /v1/series/42', 'GET /v1/lists/series/42', 'POST /v1/lists/series/update'], 'the list ids were asked again');
});

test('a plan from an add puts a series that is on no list on the wish list (planning, #223)', async () => {
  // Reintroduce by reading `planning` as reading: the series lands on the reading list at chapter 0.
  const { ADAPTERS } = await mod();
  reset((h) => {
    if (h.path === '/v1/lists') return { body: LISTS.map((l) => (l.type === 'wish' ? { ...l, list_id: 21 } : l)) };
    if (h.path === '/v1/lists/series/42') return { status: 404 };
    return { body: { status: 'success' } };
  });
  await ADAPTERS.mangaupdates.setProgress('tok-plan', '42', 0, 'planning');
  const w = hits.find((h) => h.method === 'POST')!;
  assert.equal(w.path, '/v1/lists/series');
  assert.deepEqual(w.body, [{ series: { id: 42 }, list_id: 21, status: { chapter: 0 } }]);
});
