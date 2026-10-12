// Smart and shared Lists (v0.61.0, lib/lists.ts and lib/smartLists.ts), through the real routes.
//
// A smart list is a saved Library search, answered afresh for whoever opens it; a shared list is one the household may
// READ. The owner's rulings: shared lists are view-only for everyone else, and what a list shows is always the viewer's
// own view of it -- their libraries, their age cap, their 18+ switch, their reading. So one shared smart list is opened
// here by four members who must each see something different, and every route that changes a list is tried by someone
// who does not own it.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB_A = 'lib_lst_a', LIB_B = 'lib_lst_b', LIB_X = 'lib_lst_x'; // X is an 18+ library
const GENRE = 'LstRomance';
/** id, library, age rating, chapters. Every one is in GENRE, so the smart list below matches all of them. */
const SERIES: Array<[string, string, number | null, number]> = [
  ['s_lst_a1', LIB_A, null, 2],
  ['s_lst_a2', LIB_A, 16, 1], // above the capped member's 13
  ['s_lst_b1', LIB_B, null, 1], // outside the library-restricted member's grant
  ['s_lst_x1', LIB_X, null, 1], // in the 18+ library
];
const IDS = SERIES.map((s) => s[0]);
const NAMES = ['lst-owner', 'lst-full', 'lst-lib', 'lst-cap'];

let q: any, app: any;
const uid: Record<string, string> = {};
const H = (who: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: uid[who], role: 'user' })}` });

async function cleanup() {
  await q('DELETE FROM collections WHERE user_id IN (SELECT id FROM users WHERE username = ANY($1))', [NAMES]).catch(() => {});
  await q('DELETE FROM read_progress WHERE series_id = ANY($1)', [IDS]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [IDS]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [IDS]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[LIB_A, LIB_B, LIB_X]]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [NAMES]).catch(() => {});
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  await cleanup();
  await q(`INSERT INTO libraries (id, name, path, age_rating) VALUES ($1,'Lst A','/lst-a',NULL), ($2,'Lst B','/lst-b',NULL), ($3,'Lst X','/lst-x',18)`,
    [LIB_A, LIB_B, LIB_X]);
  for (const [id, lib, age, chapters] of SERIES) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, age_rating, genres)
             VALUES ($1,'T!lst',$1,$1,$2,$3,$4,$5)`, [id, chapters, lib, age, [GENRE]]);
    for (let n = 1; n <= chapters; n++) {
      await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root) VALUES ($1,$2,'T!lst',$3,$4,$5,'/library')`,
        [`b_${id}_${n}`, id, `T!lst/${id}/ch${n}.cbz`, n, `Chapter ${n}`]);
    }
  }
  for (const n of NAMES) {
    uid[n] = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$2,'x','user','password') RETURNING id`,
      [n, n === 'lst-owner' ? 'Owner Name' : n]))[0].id;
  }
  await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1,$2)', [uid['lst-lib'], LIB_A]);
  await q('UPDATE users SET max_age_rating = 13 WHERE id = $1', [uid['lst-cap']]);
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/personal')).default);
  await app.ready();
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await cleanup();
});

const call = (who: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: H(who), ...(payload === undefined ? {} : { payload }) });
const create = async (who: string, body: Record<string, unknown>) => {
  const r = await call(who, 'POST', '/api/collections', body);
  assert.equal(r.statusCode, 200, r.payload);
  return r.json();
};
const idsOf = (r: any) => (r.json().items as any[]).map((s) => s.id).sort();
const ROMANCE_UNREAD = { v: 1, genres: [GENRE], read: 'UNREAD', sort: 'az' };

test('one shared smart list shows each member their own view of the library', { skip }, async (t) => {
  const smart = await create('lst-owner', { name: 'Lst Unread romance', query: ROMANCE_UNREAD, shared: true });
  assert.equal(smart.kind, 'smart');
  assert.equal(smart.shared, true);
  const open = (who: string, adult = false) => call(who, 'GET', `/api/collections/${smart.id}${adult ? '?adult=1' : ''}`);

  await t.test('an unrestricted member sees the whole match, the 18+ library only when revealed', async () => {
    // Reintroduce by evaluating a shared list through its OWNER's ViewCtx: every member sees one answer.
    assert.deepEqual(idsOf(await open('lst-full', true)), ['s_lst_a1', 's_lst_a2', 's_lst_b1', 's_lst_x1']);
    const hidden = await open('lst-full');
    assert.deepEqual(idsOf(hidden), ['s_lst_a1', 's_lst_a2', 's_lst_b1'], 'the 18+ switch applies to a shared list');
    assert.equal(hidden.json().total, 3);
  });

  await t.test('a member granted one library sees that library alone', async () => {
    assert.deepEqual(idsOf(await open('lst-lib', true)), ['s_lst_a1', 's_lst_a2']);
  });

  await t.test('a capped member sees nothing above the cap', async () => {
    assert.deepEqual(idsOf(await open('lst-cap', true)), ['s_lst_a1', 's_lst_b1']);
  });

  await t.test("Unread is each member's own reading", async () => {
    for (const n of [1, 2]) {
      await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,'s_lst_a1',20,true)`,
        [uid['lst-full'], `b_s_lst_a1_${n}`]);
    }
    assert.deepEqual(idsOf(await open('lst-full')), ['s_lst_a2', 's_lst_b1'], 'read to the end: no longer unread for this reader');
    assert.deepEqual(idsOf(await open('lst-lib')), ['s_lst_a1', 's_lst_a2'], "another member's reading is not this member's");
  });

  await t.test('only the owner is sent the search, and others see whose list it is', async () => {
    const mine = (await open('lst-owner')).json();
    assert.deepEqual(mine.query, ROMANCE_UNREAD);
    assert.equal(mine.mine, true);
    const theirs = (await open('lst-lib')).json();
    assert.equal(theirs.query, undefined, 'the search may name a library or source this member does not have');
    assert.equal(theirs.mine, false);
    assert.equal(theirs.owner?.name, 'Owner Name');
  });

  await t.test('the listing counts each list for the viewer', async () => {
    const all = (await call('lst-lib', 'GET', '/api/collections?scope=all')).json().content as any[];
    const row = all.find((c) => c.id === smart.id);
    assert.ok(row, 'a shared list that shows this member something is listed');
    assert.equal(row.item_count, 2, "the restricted member's own count");
    assert.equal(row.kind, 'smart');
    assert.equal(row.mine, false);
    assert.equal(row.query, undefined);
    assert.equal(row.owner?.name, 'Owner Name');
  });
});

test('a shared list is read-only for everyone but its owner', { skip }, async () => {
  const manual = await create('lst-owner', { name: 'Lst Picks', shared: true });
  const add = await call('lst-owner', 'POST', `/api/collections/${manual.id}/items`, { seriesId: 's_lst_a1' });
  assert.equal(add.statusCode, 200, add.payload);
  // Reintroduce by resolving the write routes through listFor (own OR shared): each of these answers 200.
  for (const [method, url, payload] of [
    ['PATCH', `/api/collections/${manual.id}`, { name: 'Taken' }],
    ['PATCH', `/api/collections/${manual.id}`, { shared: false }],
    ['DELETE', `/api/collections/${manual.id}`, undefined],
    ['POST', `/api/collections/${manual.id}/items`, { seriesId: 's_lst_b1' }],
    ['DELETE', `/api/collections/${manual.id}/items/s_lst_a1`, undefined],
    ['PUT', `/api/collections/${manual.id}/items`, { seriesIds: ['s_lst_a1'] }],
    ['POST', `/api/collections/${manual.id}/items/bulk`, { seriesIds: ['s_lst_b1'] }],
  ] as const) {
    const r = await call('lst-full', method, url, payload);
    assert.equal(r.statusCode, 404, `${method} ${url}: ${r.payload}`);
  }
  const after = (await call('lst-owner', 'GET', `/api/collections/${manual.id}`)).json();
  assert.equal(after.name, 'Lst Picks');
  assert.equal(after.shared, true);
  assert.deepEqual(after.items.map((s: any) => s.id), ['s_lst_a1'], 'nothing another member sent changed it');
  // ...and the member can still read it.
  assert.equal((await call('lst-full', 'GET', `/api/collections/${manual.id}`)).statusCode, 200);
});

test("another account's private list, and a malformed id, are 404", { skip }, async () => {
  const priv = await create('lst-owner', { name: 'Lst Private' });
  await call('lst-owner', 'POST', `/api/collections/${priv.id}/items`, { seriesId: 's_lst_a1' });
  assert.equal((await call('lst-full', 'GET', `/api/collections/${priv.id}`)).statusCode, 404);
  const listed = (await call('lst-full', 'GET', '/api/collections?scope=all')).json().content as any[];
  assert.ok(!listed.some((c) => c.id === priv.id), 'a private list is never listed to someone else');
  // Reintroduce by dropping the uuid check in listFor: Postgres refuses the cast and this reads 500.
  assert.equal((await call('lst-owner', 'GET', '/api/collections/not-a-uuid')).statusCode, 404);
});

test('a shared list that shows a member nothing is left out for them', { skip }, async () => {
  const onlyB = await create('lst-owner', { name: 'Lst Only B', shared: true });
  await call('lst-owner', 'POST', `/api/collections/${onlyB.id}/items`, { seriesId: 's_lst_b1' });
  const forLib = (await call('lst-lib', 'GET', '/api/collections?scope=all')).json().content as any[];
  // Reintroduce by keeping every shared list in listsFor: it is listed with a count of 0.
  assert.ok(!forLib.some((c) => c.id === onlyB.id), 'the library-restricted member is not shown a list of nothing');
  assert.equal((await call('lst-lib', 'GET', `/api/collections/${onlyB.id}`)).statusCode, 404, 'nor can open it by id');
  const forFull = (await call('lst-full', 'GET', '/api/collections?scope=all')).json().content as any[];
  assert.equal(forFull.find((c) => c.id === onlyB.id)?.item_count, 1, 'a member it shows a series to sees it');
  // The owner always sees their own, empty or not.
  const empty = await create('lst-owner', { name: 'Lst Empty', shared: true });
  const forOwner = (await call('lst-owner', 'GET', '/api/collections?scope=all')).json().content as any[];
  assert.equal(forOwner.find((c) => c.id === empty.id)?.item_count, 0);
});

test("Home's lists take a shared list and refuse another member's private one", { skip }, async () => {
  const shared = await create('lst-owner', { name: 'Lst Home shared', shared: true });
  await call('lst-owner', 'POST', `/api/collections/${shared.id}/items`, { seriesId: 's_lst_a1' });
  const priv = await create('lst-owner', { name: 'Lst Home private' });
  const put = (homeCollections: unknown) => call('lst-full', 'PUT', '/api/settings', { homeCollections });
  const ok = await put([shared.id]);
  assert.equal(ok.statusCode, 200, ok.payload);
  assert.deepEqual(ok.json().homeCollections, [shared.id]);
  // Reintroduce by dropping `user_id = $1 OR` for `true`: another member's private id is saved, and Home answers for it.
  const refused = await put([priv.id]);
  assert.equal(refused.statusCode, 400, refused.payload);
  assert.equal(refused.json().error, 'bad_settings');
  assert.equal((await put(['not-a-uuid'])).statusCode, 400, 'a malformed id is refused, not a 500');
});

test('a smart list holds what its search finds: no hand edits, no turning into a picked list', { skip }, async () => {
  const smart = await create('lst-owner', { name: 'Lst Smart edit', query: { v: 1, genres: [GENRE], sort: 'az' } });
  for (const [method, url, payload] of [
    ['POST', `/api/collections/${smart.id}/items`, { seriesId: 's_lst_a1' }],
    ['DELETE', `/api/collections/${smart.id}/items/s_lst_a1`, undefined],
    ['PUT', `/api/collections/${smart.id}/items`, { seriesIds: ['s_lst_a1'] }],
    ['POST', `/api/collections/${smart.id}/items/bulk`, { seriesIds: ['s_lst_a1'] }],
  ] as const) {
    const r = await call('lst-owner', method, url, payload);
    assert.equal(r.statusCode, 409, `${method} ${url}: ${r.payload}`);
    assert.equal(r.json().error, 'smart_list');
  }
  assert.equal((await q('SELECT count(*)::int AS n FROM collection_items WHERE collection_id = $1', [smart.id]))[0].n, 0);
  // Its search changes; a hand-picked list has none to change.
  const re = await call('lst-owner', 'PATCH', `/api/collections/${smart.id}`, { query: { v: 1, genres: [GENRE], lib: LIB_B, sort: 'az' } });
  assert.equal(re.statusCode, 200, re.payload);
  assert.deepEqual(idsOf(await call('lst-owner', 'GET', `/api/collections/${smart.id}`)), ['s_lst_b1']);
  const picked = await create('lst-owner', { name: 'Lst Picked' });
  const notSmart = await call('lst-owner', 'PATCH', `/api/collections/${picked.id}`, { query: { v: 1, sort: 'az' } });
  assert.equal(notSmart.statusCode, 400);
  assert.equal(notSmart.json().error, 'not_smart');
  // A query the Library could not have written is refused, never stored.
  for (const query of [{ v: 1, sort: 'az', extra: 1 }, { v: 2, sort: 'az' }, { v: 1, sort: 'random' }, { v: 1, sort: 'az', q: 'x'.repeat(201) }]) {
    const bad = await call('lst-owner', 'POST', '/api/collections', { name: 'Lst Bad', query });
    assert.equal(bad.statusCode, 400, JSON.stringify(query));
  }
  // A smart list is capped by `limit`, and says how many there are in all.
  const capped = (await call('lst-owner', 'GET', `/api/collections/${smart.id}?limit=1`)).json();
  assert.equal(capped.items.length, 1);
});

test('GET /api/collections without a scope is what it always was', { skip }, async () => {
  await create('lst-owner', { name: 'Lst Smart hidden', query: { v: 1, sort: 'az' } });
  const picks = await create('lst-owner', { name: 'Lst Raw count' });
  await call('lst-owner', 'POST', `/api/collections/${picks.id}/items`, { seriesId: 's_lst_x1' });
  await create('lst-full', { name: 'Lst Someone else', shared: true });
  const rows = (await call('lst-owner', 'GET', '/api/collections')).json().content as any[];
  // Reintroduce by answering the default with listsFor 'all': the smart list and the other member's appear here, in
  // the series page's "Add to collection" sheet, where nothing can be added to either.
  assert.ok(rows.every((r) => !r.name.includes('Smart hidden') && !r.name.includes('Someone else')), JSON.stringify(rows.map((r) => r.name)));
  const raw = rows.find((r) => r.id === picks.id);
  assert.equal(Number(raw.item_count), 1, 'the stored count, an 18+ title in it included, as before');
  assert.deepEqual(Object.keys(raw).sort(), ['accent', 'id', 'item_count', 'name', 'sort_order']);
});
