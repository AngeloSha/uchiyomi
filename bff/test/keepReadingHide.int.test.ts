// "Remove from Keep reading": PUT /api/keep-reading/:seriesId, GET /api/keep-reading/hidden, and the pick they change
// (lib/onDeck.ts). A removal is this reader's own, lasts until the series is read again, and can be undone.
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

const LIB = 'lib_kr', LIB_OFF = 'lib_kr_off';
const SERIES: Array<[string, string]> = [['s_kr_a', LIB], ['s_kr_b', LIB], ['s_kr_off', LIB_OFF]];
const IDS = SERIES.map((s) => s[0]);
const book = (s: string, n: number) => `b_${s}_${n}`;

let q: any, app: any, viewer = '', other = '';
const as = (id: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role: 'user' })}` });
const put = (seriesId: string, hidden: boolean, who = viewer) =>
  app.inject({ method: 'PUT', url: `/api/keep-reading/${seriesId}`, headers: as(who), payload: { hidden } });
const home = async (who = viewer) => (await app.inject({ method: 'GET', url: '/api/home', headers: as(who) })).json();
const onDeck = async (who = viewer) => (await home(who)).onDeck.map((b: any) => b.seriesId).sort();
const read = (who: string, s: string, n: number) =>
  q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at) VALUES ($1,$2,$3,5,false, now())
     ON CONFLICT (user_id, book_id) DO UPDATE SET updated_at = now()`, [who, book(s, n), s]);

async function cleanup() {
  await q('DELETE FROM read_progress WHERE series_id = ANY($1)', [IDS]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [IDS]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [IDS]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[LIB, LIB_OFF]]).catch(() => {});
  await q(`DELETE FROM users WHERE username IN ('kr-viewer','kr-other')`).catch(() => {}); // keep_reading_hidden cascades
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  await cleanup();
  await q(`INSERT INTO libraries (id, name, path, age_rating) VALUES ($1,'Kr','/kr',NULL), ($2,'Kr off','/kroff',NULL)`, [LIB, LIB_OFF]);
  for (const [id, lib] of SERIES) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id) VALUES ($1,'T!kr',$2,$1,3,$3)`, [id, `Title ${id}`, lib]);
    for (let n = 1; n <= 3; n++) {
      await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root) VALUES ($1,$2,'T!kr',$3,$4,$5,'/library')`,
        [book(id, n), id, `T!kr/${id}/ch${n}.cbz`, n, `Chapter ${n}`]);
    }
  }
  const user = async (name: string) => (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
    VALUES ($1,$1,'x','user','password') RETURNING id`, [name]))[0].id as string;
  viewer = await user('kr-viewer');
  other = await user('kr-other');
  for (const u of [viewer, other]) await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1,$2)', [u, LIB]);
  for (const u of [viewer, other]) for (const s of ['s_kr_a', 's_kr_b']) await read(u, s, 1);

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/catalog')).default);
  await app.ready();
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await cleanup();
});

test('removing a series takes it out of Keep reading, for this reader only, and lists it as hidden', { skip }, async () => {
  assert.deepEqual(await onDeck(), ['s_kr_a', 's_kr_b']);
  assert.equal((await home()).keepReadingHidden, 0);
  const r = await put('s_kr_a', true);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, hidden: true });
  // Reintroduce by dropping the NOT EXISTS in lib/onDeck.ts: s_kr_a is still on the row.
  assert.deepEqual(await onDeck(), ['s_kr_b'], 'gone from the row');
  assert.deepEqual(await onDeck(other), ['s_kr_a', 's_kr_b'], 'and only from this reader\'s');
  assert.equal((await home()).keepReadingHidden, 1);
  const list = (await app.inject({ method: 'GET', url: '/api/keep-reading/hidden', headers: as(viewer) })).json().content;
  assert.deepEqual(list.map((h: any) => [h.seriesId, h.title]), [['s_kr_a', 'Title s_kr_a']]);
  const none = (await app.inject({ method: 'GET', url: '/api/keep-reading/hidden', headers: as(other) })).json().content;
  assert.deepEqual(none, []);
});

test('reading the series again brings it back by itself, and it leaves the hidden list', { skip }, async () => {
  await read(viewer, 's_kr_a', 2);
  assert.deepEqual(await onDeck(), ['s_kr_a', 's_kr_b']);
  assert.equal((await home()).keepReadingHidden, 0);
  const list = (await app.inject({ method: 'GET', url: '/api/keep-reading/hidden', headers: as(viewer) })).json().content;
  assert.deepEqual(list, []);
});

test('hidden: false puts a series back without reading it', { skip }, async () => {
  await put('s_kr_b', true);
  assert.deepEqual(await onDeck(), ['s_kr_a']);
  const r = await put('s_kr_b', false);
  assert.deepEqual(r.json(), { ok: true, hidden: false });
  assert.deepEqual(await onDeck(), ['s_kr_a', 's_kr_b']);
});

test('a series in a library the reader was not granted cannot be hidden', { skip }, async () => {
  const r = await put('s_kr_off', true);
  assert.equal(r.statusCode, 404);
  const rows = await q('SELECT 1 FROM keep_reading_hidden WHERE series_id = $1', ['s_kr_off']);
  assert.equal(rows.length, 0, 'no row stored');
});
