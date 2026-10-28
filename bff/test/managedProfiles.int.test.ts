// A member the admin allows makes and manages its own profiles that open at home (routes/personal.ts /api/profiles).
// Each starts with the member's own restrictions, never more; a member reaches its
// own profiles only, and at most MAX_MANAGED_PROFILES. Skipped unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  // Requests here come from 127.0.0.1: home, so a session entered without a password reaches the route at all and is
  // refused by the route's own rule, not by being outside.
  process.env.LOCAL_NETWORKS = '127.0.0.0/8';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const PREFIX = 'mp-';
const LIB = 'mp-shelf';

test('a member\'s own profiles', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const { MAX_MANAGED_PROFILES } = await import('../src/lib/profiles');
  await migrate();
  // Profiles first: they name their managers, and go when those go only through ON DELETE SET NULL.
  await q('DELETE FROM users WHERE managed_by IN (SELECT id FROM users WHERE username LIKE $1)', [`${PREFIX}%`]);
  await q('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
  await q('DELETE FROM libraries WHERE id = $1', [LIB]);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1, 'MP Shelf', '/mp-shelf')`, [LIB]);
  const member = async (name: string, perms: object) => (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms) VALUES ($1, $1, 'x', 'user', 'password', $2) RETURNING id`,
    [`${PREFIX}${name}`, JSON.stringify(perms)]))[0].id;
  const parent = await member('parent', { canManageProfiles: true, canDownload: false });
  const plain = await member('plain', {});
  const other = await member('other', { canManageProfiles: true });
  await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1, $2)', [parent, LIB]);
  await q('UPDATE users SET max_age_rating = 12 WHERE id = $1', [parent]);

  const app = (await import('fastify')).default();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/personal')).default);
  await app.ready();
  const as = (id: string, extra: object = {}) => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role: 'user', ...extra })}` });
  const create = (id: string, body: object, extra: object = {}) =>
    app.inject({ method: 'POST', url: '/api/profiles', headers: as(id, extra), payload: body });

  try {
    await t.test('only a member the admin allowed makes profiles', async () => {
      const r = await create(plain, { displayName: 'Nope' });
      assert.equal(r.statusCode, 403);
      assert.equal((await one<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE managed_by = $1', [plain]))!.n, 0);
    });

    await t.test('a profile sees no more than its maker: libraries, age limit, downloads -- and makes no profiles', async () => {
      // Reintroduce by dropping inheritRestrictions: the profile has every library and no age limit.
      const r = await create(parent, { displayName: 'Kid One' });
      assert.equal(r.statusCode, 200, r.body);
      const p = r.json();
      assert.equal(p.kind, 'open');
      assert.equal(p.username, 'KidOne');
      const row = await one<any>('SELECT managed_by, max_age_rating, perms, role, password_login, local_open FROM users WHERE id = $1', [p.id]);
      assert.deepEqual([row.managed_by, row.max_age_rating, row.perms, row.role, row.password_login, row.local_open],
        [parent, 12, { canDownload: false }, 'user', false, true]);
      const libs = await q<{ library_id: string }>('SELECT library_id FROM user_libraries WHERE user_id = $1', [p.id]);
      assert.deepEqual(libs.map((l) => l.library_id), [LIB]);
    });

    await t.test('a session entered without a password makes no profile', async () => {
      const r = await create(parent, { displayName: 'From a kid' }, { loc: true });
      assert.equal(r.statusCode, 403);
      assert.equal(r.json().error, 'credential_required');
    });

    await t.test('a member reaches its own profiles only', async () => {
      const mine = (await create(parent, { displayName: 'Kid Two' })).json().id;
      const list = await app.inject({ method: 'GET', url: '/api/profiles', headers: as(other) });
      assert.deepEqual(list.json().content, [], 'another member lists none of them');
      assert.equal((await app.inject({ method: 'PATCH', url: `/api/profiles/${mine}`, headers: as(other), payload: { displayName: 'Mine now' } })).statusCode, 404);
      assert.equal((await app.inject({ method: 'DELETE', url: `/api/profiles/${mine}`, headers: as(other) })).statusCode, 404);
      assert.equal((await app.inject({ method: 'PATCH', url: '/api/profiles/not-a-uuid', headers: as(parent), payload: {} })).statusCode, 400);
    });

    await t.test('a password makes it a hybrid; without one it cannot stop opening at home', async () => {
      const id = (await create(parent, { displayName: 'Kid Three' })).json().id;
      const closed = await app.inject({ method: 'PATCH', url: `/api/profiles/${id}`, headers: as(parent), payload: { localOpen: false } });
      assert.equal(closed.json().error, 'no_way_in');
      const pw = await app.inject({ method: 'PATCH', url: `/api/profiles/${id}`, headers: as(parent), payload: { password: 'mp-password-only' } });
      assert.equal(pw.statusCode, 200, pw.body);
      assert.equal(pw.json().kind, 'hybrid');
    });

    await t.test(`at most ${MAX_MANAGED_PROFILES}, even asked for at once`, async () => {
      const have = (await one<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE managed_by = $1', [parent]))!.n;
      const res = await Promise.all(Array.from({ length: MAX_MANAGED_PROFILES - have + 3 }, (_, i) => create(parent, { displayName: `Many ${i}` })));
      assert.equal(res.filter((r) => r.statusCode === 200).length, MAX_MANAGED_PROFILES - have);
      assert.ok(res.filter((r) => r.statusCode !== 200).every((r) => r.json().error === 'too_many_profiles'));
      assert.equal((await one<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE managed_by = $1', [parent]))!.n, MAX_MANAGED_PROFILES);
    });

    await t.test('deleting a profile deletes it, and says what it held', async () => {
      const id = (await q<{ id: string }>('SELECT id FROM users WHERE managed_by = $1 ORDER BY created_at LIMIT 1', [parent]))[0].id;
      const r = await app.inject({ method: 'DELETE', url: `/api/profiles/${id}`, headers: as(parent) });
      assert.equal(r.statusCode, 200);
      assert.equal(await one('SELECT 1 FROM users WHERE id = $1', [id]), null);
      const audit = await one<any>(`SELECT detail FROM audit_log WHERE event = 'profile.delete' AND detail->>'target' = $1`, [id]);
      assert.ok(audit?.detail?.destroyed, 'the audit line counts what went');
    });
  } finally {
    await q('DELETE FROM audit_log WHERE user_id = ANY($1::uuid[])', [[parent, plain, other]]).catch(() => {});
    await q('DELETE FROM users WHERE managed_by = ANY($1::uuid[])', [[parent, plain, other]]).catch(() => {});
    await q('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]).catch(() => {});
    await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
    await app.close();
  }
});
