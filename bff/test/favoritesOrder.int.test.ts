// Favourites in the order their reader chose (v0.97.0), through the real routes.
//
// The owner: "we need a better system to reorder favorites". They were listed newest first everywhere, and the only way
// to move one was to unfavourite it and favourite it again. PUT /api/favorites/order now places them (lib/favorites.ts),
// and every list of one person's favourites reads that order: GET /api/favorites (the Favourites sheet), Home's rail and
// the OPDS feed. Asserted: the order is the one given, Home and the sheet agree, a favourite made since comes first, one
// the sheet did not send keeps its place after the rest, ids that are not this person's favourites change nothing, and
// another person's order is their own.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
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

const IDS = ['s_fo_a', 's_fo_b', 's_fo_c', 's_fo_d', 's_fo_e'];
const USERS = ['fo-ana', 'fo-bo'];
let app: any, q: any;
const auth: Record<string, Record<string, string>> = {};
const uids: Record<string, string> = {};

/** `who` favourites `id`, `agoMin` minutes ago (the older ones first, so newest-first is a real order). */
const fav = (who: string, id: string, agoMin: number) =>
  q(`INSERT INTO favorites (user_id, series_id, created_at) VALUES ($1,$2, now() - make_interval(mins => $3))`, [uids[who], id, agoMin]);
const sheet = async (who: string) =>
  (await app.inject({ method: 'GET', url: '/api/favorites', headers: auth[who] })).json().content.map((s: any) => s.id);
const home = async (who: string) =>
  (await app.inject({ method: 'GET', url: '/api/home', headers: auth[who] })).json().favorites.map((s: any) => s.id);
const order = (who: string, seriesIds: unknown) =>
  app.inject({ method: 'PUT', url: '/api/favorites/order', headers: auth[who], payload: { seriesIds } });

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  await q('DELETE FROM favorites WHERE series_id = ANY($1)', [IDS]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [IDS]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]).catch(() => {});
  for (const id of IDS) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!fo',$1,$2,0)`, [id, `T!fo/${id}`]);
  }
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/personal')).default);
  await app.ready();
  for (const name of USERS) {
    uids[name] = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','user','password') RETURNING id`, [name]))[0].id;
    auth[name] = { authorization: `Bearer ${app.jwt.sign({ sub: uids[name], role: 'user' })}` };
  }
  // Ana: a, b, c, d favourited in that order (a oldest); Bo: c, d.
  await fav('fo-ana', 's_fo_a', 40); await fav('fo-ana', 's_fo_b', 30); await fav('fo-ana', 's_fo_c', 20); await fav('fo-ana', 's_fo_d', 10);
  await fav('fo-bo', 's_fo_c', 20); await fav('fo-bo', 's_fo_d', 10);
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM favorites WHERE series_id = ANY($1)', [IDS]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [IDS]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]).catch(() => {});
  await (await import('../src/lib/db')).pool.end().catch(() => {});
});

test('until someone orders them, favourites are newest first, as they always were', { skip }, async () => {
  assert.deepEqual(await sheet('fo-ana'), ['s_fo_d', 's_fo_c', 's_fo_b', 's_fo_a']);
});

test('an order put is the order the sheet and Home read, and it is that person\'s alone', { skip }, async () => {
  // Reintroduce `ORDER BY created_at DESC` in GET /api/favorites or in Home's rail: one of them reads newest first.
  const r = await order('fo-ana', ['s_fo_b', 's_fo_d', 's_fo_a', 's_fo_c']);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json(), { ok: true, placed: 4 });
  assert.deepEqual(await sheet('fo-ana'), ['s_fo_b', 's_fo_d', 's_fo_a', 's_fo_c']);
  assert.deepEqual(await home('fo-ana'), ['s_fo_b', 's_fo_d', 's_fo_a', 's_fo_c']);
  assert.deepEqual(await sheet('fo-bo'), ['s_fo_d', 's_fo_c'], "another person's favourites moved");
});

test('a favourite made since comes first; one the sheet did not send keeps its place after the rest', { skip }, async () => {
  // Reintroduce placing only the ids given (an UPDATE over `want` alone): the favourite not sent keeps its old position,
  // and the order below reads it in the wrong place.
  await fav('fo-ana', 's_fo_e', 0);
  assert.deepEqual((await sheet('fo-ana'))[0], 's_fo_e', 'a new favourite is where it always was: first');
  // The sheet sends three; c and e, not sent, follow in the order they were listed (e first, then c).
  const r = await order('fo-ana', ['s_fo_a', 's_fo_b', 's_fo_d']);
  assert.deepEqual(r.json(), { ok: true, placed: 5 });
  assert.deepEqual(await sheet('fo-ana'), ['s_fo_a', 's_fo_b', 's_fo_d', 's_fo_e', 's_fo_c']);
});

test("ids that are not this person's favourites change nothing, and a body that is not a list is refused", { skip }, async () => {
  const before = await sheet('fo-bo');
  const r = await order('fo-bo', ['s_fo_a', 'nope', 's_fo_c', 's_fo_c']);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(await sheet('fo-bo'), ['s_fo_c', 's_fo_d']);
  assert.equal((await q('SELECT count(*)::int n FROM favorites WHERE user_id = $1', [uids['fo-bo']]))[0].n, before.length, 'an id became a favourite');
  for (const bad of [{ seriesIds: 's_fo_c' }, { seriesIds: [1, 2] }, { seriesIds: [], extra: true }]) {
    const res = await app.inject({ method: 'PUT', url: '/api/favorites/order', headers: auth['fo-bo'], payload: bad });
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
  }
});
