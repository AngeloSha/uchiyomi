// /auth/me's `talk` (v0.90.0): whether this server has chapter comments at all (lib/comments.ts talkOn), which is what
// Profile → Settings → Reading reads to offer Comments and reactions -- never where there is nobody to talk to, and
// still there once a member has switched their own talk off, or they could not switch it back on.
//
// Skipped unless TEST_DATABASE_URL is set.
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
const USERS = ['metalk-alice', 'metalk-bob'];

test("/auth/me says whether this server has chapter comments", { skip }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const comments = await import('../src/lib/comments');
  const Fastify = (await import('fastify')).default;
  await migrate();
  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]).catch(() => {});
  // Nobody else is enabled while this runs, so the count is this file's own.
  const others = await q<{ id: string; disabled: boolean }>('SELECT id, disabled FROM users WHERE NOT disabled');
  await q('UPDATE users SET disabled = true WHERE NOT disabled');

  const app = Fastify();
  await app.register((await import('@fastify/rate-limit')).default, { global: false });
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/auth')).default);
  await app.ready();
  const account = async (name: string) => (await one<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1, $1, 'x', 'user', 'password') RETURNING id`,
    [name]))!.id;
  const me = async (uid: string) => (await app.inject({
    method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'user' })}` },
  })).json();

  try {
    const alice = await account('metalk-alice');
    comments.resetTalkOn();
    assert.equal((await me(alice)).talk, false, 'one member: nobody to talk to, so no switch');
    const bob = await account('metalk-bob');
    comments.resetTalkOn();
    assert.equal((await me(alice)).talk, true, 'two members: the household has talk');
    await q(`INSERT INTO app_settings (user_id, data) VALUES ($1, '{"comments": false}'::jsonb)
             ON CONFLICT (user_id) DO UPDATE SET data = app_settings.data || EXCLUDED.data`, [bob]);
    const bobs = await me(bob);
    assert.equal(bobs.talk, true, 'still offered to a member who switched it off, so it can be switched back on');
    assert.equal(bobs.settings.comments, false, 'and the switch reads its own setting');
  } finally {
    await app.close();
    await q('DELETE FROM users WHERE username = ANY($1)', [USERS]).catch(() => {});
    for (const o of others) await q('UPDATE users SET disabled = $2 WHERE id = $1', [o.id, o.disabled]);
    comments.resetTalkOn();
  }
});
