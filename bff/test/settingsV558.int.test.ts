// v0.55.8 account settings: the known navigation settings are validated without closing the
// forwards-compatible settings bag, and Home list ids never cross account boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

test('v0.55.8 personal settings contracts', { skip }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const personalRoutes = (await import('../src/routes/personal')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();

  await q("DELETE FROM users WHERE username IN ('v558-settings-a','v558-settings-b')").catch(() => {});
  const users = await q<{ id: string; username: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ('v558-settings-a','A','x','user','password'), ('v558-settings-b','B','x','user','password')
     RETURNING id, username`,
  );
  const mine = users.find((u) => u.username === 'v558-settings-a')!.id;
  const other = users.find((u) => u.username === 'v558-settings-b')!.id;
  const cols = await q<{ id: string; user_id: string }>(
    `INSERT INTO collections (user_id, name, sort_order)
     VALUES ($1,'First',1), ($1,'Second',2), ($1,'Third',3), ($1,'Fourth',4), ($2,'Foreign',1)
     RETURNING id, user_id`, [mine, other],
  );
  const owned = cols.filter((c) => c.user_id === mine).map((c) => c.id);
  const foreign = cols.find((c) => c.user_id === other)!.id;

  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(personalRoutes);
  await app.ready();
  const auth = { authorization: `Bearer ${app.jwt.sign({ sub: mine, role: 'user' })}` };

  try {
    const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/settings', headers: auth, payload });

    const ok = await put({ librarySort: 'unread', showAllChapters: true, homeCollections: [owned[1], owned[0], owned[1]], futureSetting: { kept: true } });
    assert.equal(ok.statusCode, 200, ok.body);
    const saved = (await app.inject({ method: 'GET', url: '/api/settings', headers: auth })).json();
    assert.equal(saved.librarySort, 'unread');
    assert.equal(saved.showAllChapters, true);
    assert.deepEqual(saved.homeCollections, [owned[1], owned[0]], 'deduplicated without changing order');
    assert.deepEqual(saved.futureSetting, { kept: true }, 'unknown settings remain forwards-compatible');

    for (const payload of [
      { librarySort: 'oldest' },
      { showAllChapters: 'yes' },
      { homeCollections: owned },
      { homeCollections: [foreign] },
      ['not', 'an', 'object'],
    ]) {
      const bad = await put(payload);
      assert.equal(bad.statusCode, 400, `${JSON.stringify(payload)}: ${bad.body}`);
      assert.equal(bad.json().error, 'bad_settings');
    }
  } finally {
    await app.close();
    await q("DELETE FROM users WHERE username IN ('v558-settings-a','v558-settings-b')").catch(() => {});
  }
});
