// v0.89.0 (#305, TIGamingTV: "more sources per series, more to search from"): how many other sources a series may follow
// is the admin's choice, Admin -> Settings -> Other sources per series (lib/followLimit.ts), 1 to 10. Until one is picked
// it is MAX_FOLLOWED_SOURCES, or three. Driven through the real settings route and the one count every follow is written
// under (lib/autoFollow.ts followJudged): Find other sources, the scout, the hunt and a follow by hand all go through it.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  // The starting value is the env's: nothing set, so three.
  delete process.env.MAX_FOLLOWED_SOURCES;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_fl', SER = 's_fl', ADMIN = 'fl-admin', MEMBER = 'fl-member';
const src = (i: number) => `fl-src-${i}`;
let q: any, app: any, saved: number | null = null;
const H: Record<string, { authorization: string }> = {};

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const rateLimit = (await import('@fastify/rate-limit')).default;
  await migrate();
  saved = (await q('SELECT max_followed_sources AS n FROM server_settings WHERE id = 1'))[0]?.n ?? null;
  await q('UPDATE server_settings SET max_followed_sources = NULL WHERE id = 1');
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'FL',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q('DELETE FROM lib_series WHERE id = $1', [SER]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id)
           VALUES ($1,'T!fl','Followed Far',$1,0,$2,'fl-main','fl-main-series')`, [SER, LIB]);
  await q('DELETE FROM users WHERE username = ANY($1)', [[ADMIN, MEMBER]]);
  const ids: Record<string, string> = {};
  for (const [name, role] of [[ADMIN, 'admin'], [MEMBER, 'user']]) {
    ids[name] = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x',$2,'password') RETURNING id`, [name, role]))[0].id;
  }
  app = Fastify();
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  app.setErrorHandler((err: any, _req: any, reply: any) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'bad_request' });
    return reply.code(err.statusCode || 500).send({ error: err.message || 'error' });
  });
  await app.register(rateLimit, { global: false });
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  H[ADMIN] = { authorization: `Bearer ${app.jwt.sign({ sub: ids[ADMIN], role: 'admin' })}` };
  H[MEMBER] = { authorization: `Bearer ${app.jwt.sign({ sub: ids[MEMBER], role: 'user' })}` };
});

after(async () => {
  if (!DSN) return;
  await q('DELETE FROM lib_series WHERE id = $1', [SER]).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [[ADMIN, MEMBER]]).catch(() => {});
  await q('UPDATE server_settings SET max_followed_sources = $1 WHERE id = 1', [saved]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await app?.close();
});

const settings = async () => (await app.inject({ method: 'GET', url: '/api/admin/settings', headers: H[ADMIN] })).json();
const patch = (payload: unknown, who = ADMIN) => app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: H[who], payload });
const followers = async () => Number((await q('SELECT count(*)::int AS n FROM series_sources WHERE series_id = $1', [SER]))[0].n);

test('the admin picks how many other sources a series may follow, 1 to 10; lowering it unfollows nothing', { skip }, async () => {
  const { followJudged } = await import('../src/lib/autoFollow');
  const follow = (i: number) => followJudged(SER, { source: src(i), name: src(i), sourceSeriesId: `${src(i)}-series`, theirTitle: 'Followed Far', coverage: null });

  const before = await settings();
  assert.equal(before.followerLimit, 3, 'PREMISE: three while nothing is picked and the env says nothing');
  assert.equal(before.followerLimitMax, 10);
  for (let i = 1; i <= 3; i++) assert.equal(await follow(i), 'inserted');
  assert.equal(await follow(4), 'cap', 'PREMISE: the fourth is over the default');

  // Reintroduce by reading the env alone (followerLimit answering followLimit()): the fourth is still `cap`.
  assert.equal((await patch({ maxFollowedSources: 5 })).statusCode, 200);
  assert.equal((await settings()).followerLimit, 5, 'the menu reads what was picked');
  assert.equal(await follow(4), 'inserted', 'the admin\'s choice is the limit');
  assert.equal(await follow(5), 'inserted');
  assert.equal(await follow(6), 'cap', 'and it is still a limit');

  // Lower than the series follows: it keeps every source, and follows no more.
  assert.equal((await patch({ maxFollowedSources: 2 })).statusCode, 200);
  assert.equal(await followers(), 5, 'lowering the number unfollows nothing');
  assert.equal(await follow(6), 'cap');

  // Ten at most, a whole number, and only an admin's to pick. A refused value writes nothing.
  for (const bad of [0, 11, 2.5, '4', null]) {
    assert.equal((await patch({ maxFollowedSources: bad })).statusCode, 400, `refused: ${JSON.stringify(bad)}`);
  }
  assert.equal((await patch({ maxFollowedSources: 10 }, MEMBER)).statusCode, 403);
  assert.equal((await settings()).followerLimit, 2, 'nothing refused was written');
  // The scout set the series aside for a day as full: raising the number brings it forward at once. Reintroduce by
  // dropping that: its next look stays tomorrow.
  await q(`INSERT INTO series_scout (series_id, reason, next_at, verdict) VALUES ($1, 'behind', now() + interval '1 day', 'cap')
           ON CONFLICT (series_id) DO UPDATE SET next_at = EXCLUDED.next_at, verdict = 'cap'`, [SER]);
  assert.equal((await patch({ maxFollowedSources: 10 })).statusCode, 200);
  assert.ok((await q('SELECT next_at <= now() AS due FROM series_scout WHERE series_id = $1', [SER]))[0].due, 'a full series is looked at again');
  for (let i = 6; i <= 10; i++) assert.equal(await follow(i), 'inserted');
  assert.equal(await follow(11), 'cap', 'ten is the most');
});
