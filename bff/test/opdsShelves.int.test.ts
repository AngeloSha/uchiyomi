// The OPDS reader's own shelves (v0.61.0): Keep reading, Favourites and the Lists, from a per-reader root.
//
// An e-reader is a whole second way into the library, so each shelf is held to the app's rules: Keep reading is this
// reader's alone, a List is listed only when the app would list it (their own, or shared and showing them something),
// another member's private List is a 404 like a malformed id, and the token's own 18+ switch decides what a shelf
// shows -- an OPDS client has no reveal button to press.
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

const LIB = 'lib_osh', LIB18 = 'lib_osh_18';
const READER = 'osh-reader', OTHER = 'osh-other';
const S1 = 's_osh_one', S2 = 's_osh_two', SX = 's_osh_adult';
const BULK = Array.from({ length: 61 }, (_, i) => `s_osh_bulk_${String(i).padStart(2, '0')}`);
const ALL = [S1, S2, SX, ...BULK];
const book = (s: string, n: number) => `b_${s}_${n}`;
const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

let q: any, auth: any, app: any, reader = '', other = '', token = '';
const lists: Record<string, string> = {};
const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: basic(READER, token) } });
const entryIds = (xml: string) => [...xml.matchAll(/<id>([^<]+)<\/id>/g)].map((m) => m[1]).slice(1); // the first is the feed's

async function cleanup() {
  await q('DELETE FROM collections WHERE user_id IN (SELECT id FROM users WHERE username = ANY($1))', [[READER, OTHER]]).catch(() => {});
  await q('DELETE FROM read_progress WHERE series_id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM favorites WHERE series_id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[LIB, LIB18]]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [[READER, OTHER]]).catch(() => {});
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  auth = await import('../src/lib/auth');
  await migrate();
  await cleanup();
  await q(`INSERT INTO libraries (id, name, path, age_rating) VALUES ($1,'Osh','/osh',NULL), ($2,'Osh 18','/osh18',18)`, [LIB, LIB18]);
  const series = async (id: string, lib: string, chapters: number, genres: string[] = []) => {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, genres) VALUES ($1,'T!osh',$1,$1,$2,$3,$4)`,
      [id, chapters, lib, genres]);
    for (let n = 1; n <= chapters; n++) {
      await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, pages) VALUES ($1,$2,'T!osh',$3,$4,$5,'/library',10)`,
        [book(id, n), id, `T!osh/${id}/ch${n}.cbz`, n, `Chapter ${n}`]);
    }
  };
  await series(S1, LIB, 3);
  await series(S2, LIB, 2);
  await series(SX, LIB18, 1);
  for (const id of BULK) await series(id, LIB, 0, ['OshBulk']);
  const user = async (name: string, display: string) => (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
    VALUES ($1,$2,'x','user','password') RETURNING id`, [name, display]))[0].id as string;
  reader = await user(READER, 'Osh Reader');
  other = await user(OTHER, 'Osh Other');
  token = await auth.issueOpdsToken(reader);

  // The reader finished chapter 1 of S1 yesterday and stopped on page 4 of chapter 2 an hour ago; the other member is
  // part-way through S2, which must never reach the reader's shelf.
  const read = (who: string, s: string, n: number, page: number, done: boolean, ago: string) =>
    q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at) VALUES ($1,$2,$3,$4,$5, now() - $6::interval)`,
      [who, book(s, n), s, page, done, ago]);
  await read(reader, S1, 1, 9, true, '1 day');
  await read(reader, S1, 2, 4, false, '1 hour');
  await read(other, S2, 1, 3, false, '1 hour');
  await q(`INSERT INTO favorites (user_id, series_id, created_at) VALUES ($1,$2, now() - interval '2 days'), ($1,$3, now())`, [reader, S1, SX]);

  const list = async (who: string, name: string, items: string[], o: { shared?: boolean; query?: unknown } = {}) => {
    const id = (await q(`INSERT INTO collections (user_id, name, shared, query) VALUES ($1,$2,$3,$4::jsonb) RETURNING id`,
      [who, name, o.shared === true, o.query ? JSON.stringify(o.query) : null]))[0].id as string;
    for (const [i, s] of items.entries()) await q('INSERT INTO collection_items (collection_id, series_id, position) VALUES ($1,$2,$3)', [id, s, i]);
    return id;
  };
  lists.mine = await list(reader, 'Osh Mine', [S1]);
  lists.bulk = await list(reader, 'Osh Bulk', [], { query: { v: 1, genres: ['OshBulk'], sort: 'az' } });
  lists.theirs = await list(other, 'Osh Theirs', [S2], { shared: true });
  lists.secret = await list(other, 'Osh Secret', [S1]);
  lists.adultOnly = await list(other, 'Osh Adult only', [SX], { shared: true });

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/opds')).default);
  await app.ready();
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await cleanup();
});

test("the root is the reader's: their shelves, their lists and the household's shared ones, never another's private one", { skip }, async () => {
  const r = await get('/opds');
  assert.equal(r.statusCode, 200, r.payload);
  const xml = r.payload;
  for (const href of ['/opds/continue', '/opds/favorites', '/opds/series?sort=updated', `/opds/lists/${lists.mine}`, `/opds/lists/${lists.bulk}`, `/opds/lists/${lists.theirs}`]) {
    assert.ok(xml.includes(`href="${href}"`), `the root links ${href}`);
  }
  assert.match(xml, /<title>Osh Theirs · Osh Other<\/title>/, "someone else's list says whose it is");
  // Reintroduce by listing every list in the root: the other member's private one is here.
  assert.ok(!xml.includes(lists.secret), "another member's private list is never listed");
  assert.ok(!xml.includes(lists.adultOnly), 'a shared list that shows this token nothing (18+ hidden) is left out');
  await auth.setOpdsShowAdult(reader, true);
  try {
    assert.ok((await get('/opds')).payload.includes(`/opds/lists/${lists.adultOnly}`), 'and listed once the token shows 18+');
  } finally {
    await auth.setOpdsShowAdult(reader, false);
  }
});

test("Keep reading shows this reader's next chapters, with where they stopped", { skip }, async () => {
  const r = await get('/opds/continue');
  assert.equal(r.statusCode, 200, r.payload);
  // Reintroduce by picking without the reader's id: the other member's S2 is offered here.
  assert.deepEqual(entryIds(r.payload), [`yomi:book:${book(S1, 2)}`]);
  assert.match(r.payload, /<title>s_osh_one · Chapter 2<\/title>/);
  assert.match(r.payload, /pse:count="10" pse:lastRead="4"/, 'the page stream starts where the reader stopped');
  assert.ok(r.payload.includes(`href="/opds/book/${book(S1, 2)}/file"`), 'and the CBZ is there to download');
});

test('Favourites hides 18+ unless the token allows it', { skip }, async () => {
  assert.deepEqual(entryIds((await get('/opds/favorites')).payload), [`yomi:series:${S1}`]);
  await auth.setOpdsShowAdult(reader, true);
  try {
    // Newest favourite first.
    assert.deepEqual(entryIds((await get('/opds/favorites')).payload), [`yomi:series:${SX}`, `yomi:series:${S1}`]);
  } finally {
    await auth.setOpdsShowAdult(reader, false);
  }
});

test('a list feed pages sixty at a time', { skip }, async () => {
  const first = await get(`/opds/lists/${lists.bulk}`);
  assert.equal(first.statusCode, 200, first.payload);
  assert.equal(entryIds(first.payload).length, 60);
  assert.ok(first.payload.includes(`rel="next" href="/opds/lists/${lists.bulk}?page=1"`), 'a next link');
  const second = await get(`/opds/lists/${lists.bulk}?page=1`);
  assert.deepEqual(entryIds(second.payload), [`yomi:series:${BULK[60]}`]);
  assert.ok(!second.payload.includes('rel="next"'), 'and none after the last');
  // A shared list from another member reads too.
  assert.deepEqual(entryIds((await get(`/opds/lists/${lists.theirs}`)).payload), [`yomi:series:${S2}`]);
});

test("a malformed id, and another member's private list, are 404", { skip }, async () => {
  assert.equal((await get('/opds/lists/not-a-uuid')).statusCode, 404);
  assert.equal((await get(`/opds/lists/${lists.secret}`)).statusCode, 404);
  assert.equal((await get(`/opds/lists/${lists.adultOnly}`)).statusCode, 404, 'a shared list that shows this token nothing');
});
