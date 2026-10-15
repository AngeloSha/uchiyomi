// MangaUpdates as a progress tracker: the adapter in lib/trackerProviders.ts, against a stand-in service that
// MANGAUPDATES_API_URL points it at. No database: the module opens none.
//
// What is pinned here is what is particular to MangaUpdates: it has no token page (a username and password buy a
// session token, once), its lists are numbered per account, an entry is simply absent until it is on a list, a series
// states only whether it has `completed`, and a second write inside five seconds is refused with a 412.
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
});
test.after(() => { server.close(); });

const mod = () => import('../src/lib/trackerProviders');
const reset = (a: typeof answer) => { hits.length = 0; answer = a; };

// The account's five standard lists, as /lists reports them.
const LISTS = [
  { list_id: 0, type: 'read' }, { list_id: 1, type: 'wish' }, { list_id: 2, type: 'complete' },
  { list_id: 3, type: 'unfinished' }, { list_id: 4, type: 'hold' }, { list_id: 9, type: 'custom', custom: true },
];

test('MangaUpdates is a provider with a complete adapter, and it asks for no token page', async () => {
  const { ADAPTERS, PROVIDERS, isProvider } = await mod();
  assert.ok(PROVIDERS.includes('mangaupdates'));
  assert.ok(isProvider('mangaupdates'));
  const a = ADAPTERS.mangaupdates;
  assert.equal(a.id, 'mangaupdates');
  assert.equal(a.label, 'MangaUpdates');
  assert.equal(a.tokenDays, null, 'the service does not say when a session ends');
  assert.equal(a.authorizeUrl, undefined);
  assert.match(a.tokenHelp, /username and password/);
});

test('login trades the credentials for the session token and nothing else', async () => {
  const { mangaupdatesLogin } = await mod();
  reset(() => ({ body: { status: 'success', context: { session_token: 'sess-123', uid: 5 } } }));
  assert.deepEqual(await mangaupdatesLogin('tim', 'hunter2'), { token: 'sess-123' });
  assert.equal(hits[0].method, 'PUT');
  assert.equal(hits[0].path, '/v1/account/login');
  assert.deepEqual(hits[0].body, { username: 'tim', password: 'hunter2' });
});

test('a refused login is `rejected` with the service\'s reason; an answer with no token is not a success', async () => {
  const { mangaupdatesLogin } = await mod();
  reset(() => ({ status: 401, body: { status: 'exception', reason: 'Username or password is incorrect' } }));
  await assert.rejects(mangaupdatesLogin('tim', 'nope'), (e: any) => e.rejected === true && /incorrect/.test(e.message));
  reset(() => ({ status: 200, body: { status: 'success', context: {} } }));
  await assert.rejects(mangaupdatesLogin('tim', 'x'), (e: any) => /did not give a token/.test(e.message));
  reset(() => ({ status: 503, body: null }));
  await assert.rejects(mangaupdatesLogin('tim', 'x'), (e: any) => e.rejected === false, 'an outage is not a verdict on the password');
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
  const all = await ADAPTERS.mangaupdates.listLibrary('tok', { statuses: ['reading', 'plan_to_read'], max: 500 });
  assert.equal(all.length, 102);
  assert.deepEqual(all[0], { externalId: '1000', title: 'Series 0', altTitles: [], status: 'reading', progress: 0, format: 'manga' });
  assert.equal(all[100].format, 'novel');
  assert.equal(all[101].status, 'plan_to_read');
  assert.equal(all[101].format, 'manga');
  const searches = hits.filter((h) => h.path.endsWith('/search')).map((h) => `${h.path}#${h.body.page}`);
  assert.deepEqual(searches, ['/v1/lists/12/search#1', '/v1/lists/12/search#2', '/v1/lists/1/search#1']);
  // capped at `max`, and nothing is asked for with nothing to ask
  reset((h) => (h.path === '/v1/lists' ? { body: LISTS } : { body: { total_hits: 100, results: Array.from({ length: 100 }, (_, i) => row(i + 1, `T${i}`, 1)) } }));
  assert.equal((await ADAPTERS.mangaupdates.listLibrary('tok', { statuses: ['reading'], max: 5 })).length, 5);
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
    return ADAPTERS.mangaupdates.seriesState('tok', '42');
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
