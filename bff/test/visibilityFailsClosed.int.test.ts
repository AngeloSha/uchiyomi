// What a viewer may see when the database is having a moment.
//
// `viewCtxFor` expresses BOTH restrictions as a non-null value: `libraryIds: null` means every library and
// `maxAgeRating: null` means no cap. So every fallback in that function is a fallback to unrestricted, and it
// had two -- `.catch(() => [])` on the grants query, which collapsed through `rows.length ? ... : null` into
// `libraryIds: null`, and `.catch(() => null)` on the cap. One failed query handed a capped account a context
// field-identical to SYSTEM_CTX, on the path that governs page bytes and OPDS downloads.
//
// The contract at the top of visibility.ts already forbade exactly this, in writing, 210 lines above it:
// an empty list "must never be produced by a `|| []` fallback -- that would turn a lookup failure into a
// silent lockout instead of an error". Failing loudly is that rule applied in the safe direction.
//
// The second half of this file covers the one image route that never got the visibility check its siblings
// all open with, so an account could render key art for a series it is otherwise correctly walled off from.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, mock } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB_OPEN = 'lib_vfc_open', LIB_SHUT = 'lib_vfc_shut';
const S_OPEN = 's_vfc_open', S_SHUT = 's_vfc_shut';
const USER = 'vfc-capped';

let q: any, db: any, vis: any, uid: string;

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  db = await import('../src/lib/db');
  q = db.q;
  vis = await import('../src/lib/visibility');
  await migrate();

  for (const [id, name] of [[LIB_OPEN, 'Open'], [LIB_SHUT, 'Shut']] as const) {
    await q(`INSERT INTO libraries (id, name, path) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING`, [id, name]);
  }
  for (const [sid, lib] of [[S_OPEN, LIB_OPEN], [S_SHUT, LIB_SHUT]] as const) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, age_rating)
             VALUES ($1,'T!vfc',$1,$1,1,$2,18) ON CONFLICT (id) DO NOTHING`, [sid, lib]);
  }
  await q('DELETE FROM users WHERE username = $1', [USER]);
  uid = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, max_age_rating)
                  VALUES ($1,$1,'x','user','password',13) RETURNING id`, [USER]))[0].id;
  await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1,$2)', [uid, LIB_OPEN]);
});

after(async () => {
  if (!DSN) return;
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[S_OPEN, S_SHUT]]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[LIB_OPEN, LIB_SHUT]]).catch(() => {});
});

test('a capped account keeps its restrictions when a lookup fails', { skip }, async (t) => {
  await t.test('control: the restrictions are there to begin with', async () => {
    const ctx = await vis.viewCtxFor(uid, 'user');
    assert.deepEqual([...(ctx.libraryIds ?? [])], [LIB_OPEN]);
    assert.equal(ctx.maxAgeRating, 13);
  });

  // The failure is made REAL rather than mocked: the module's exports are getters under the CJS the test
  // runner emits, so reassigning `db.q` silently does nothing and the test passes against the bug. Taking the
  // table away for a moment is a genuine query failure, on the genuine code path.
  await t.test('a failing grants query must not widen access to every library', async () => {
    await q('ALTER TABLE user_libraries RENAME TO user_libraries__hidden');
    try {
      const ctx = await vis.viewCtxFor(uid, 'user').then((c: any) => c, (e: any) => e);
      assert.ok(ctx instanceof Error, 'the failure must surface, not resolve to an unrestricted context');
      assert.equal(ctx.libraryIds, undefined, 'and it must not be a ViewCtx at all, let alone one with libraryIds null');
    } finally {
      await q('ALTER TABLE user_libraries__hidden RENAME TO user_libraries');
    }
  });

  await t.test('a failing cap query must not lift the age cap', async () => {
    await q('ALTER TABLE users RENAME COLUMN max_age_rating TO max_age_rating__hidden');
    try {
      const ctx = await vis.viewCtxFor(uid, 'user').then((c: any) => c, (e: any) => e);
      assert.ok(ctx instanceof Error, 'a lost cap lookup must not read as "no cap"');
    } finally {
      await q('ALTER TABLE users RENAME COLUMN max_age_rating__hidden TO max_age_rating');
    }
  });

  await t.test('and none of that disturbs the normal path afterwards', async () => {
    const ctx = await vis.viewCtxFor(uid, 'user');
    assert.equal(ctx.maxAgeRating, 13, 'the cap is back once the database is');
  });
});

test('the backdrop route is gated like every other image route', { skip }, async (t) => {
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const imageRoutes = (await import('../src/routes/images')).default;

  const app = Fastify();
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(imageRoutes);
  await app.ready();

  try {
    await t.test('a series in a library the account was not granted is not renderable', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/img/series/${S_SHUT}/backdrop?style=hero`,
        cookies: { yomi_img: app.jwt.sign({ sub: uid, kind: 'img' }) },
      });
      assert.equal(res.statusCode, 404, 'key art for a walled-off series must not render');
    });

    await t.test('its sibling thumb route agrees, which is where the rule came from', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/img/series/${S_SHUT}/thumb`,
        cookies: { yomi_img: app.jwt.sign({ sub: uid, kind: 'img' }) },
      });
      assert.equal(res.statusCode, 404);
    });
  } finally {
    await app.close();
  }
});
