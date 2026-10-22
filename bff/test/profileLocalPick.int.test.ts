// The sign-in screen's "who is reading?" at home (GET /auth/pick, POST /auth/profile-login): off unless an admin
// turns it on, at home only, profiles that open at home only, and a
// session that holds at home on every request. Skipped unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LOCAL_NETWORKS = '192.168.1.0/24';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const PREFIX = 'lp-';
const AWAY = '203.0.113.7';

test('who is reading, at home', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const auth = await import('../src/lib/auth');
  const { env } = await import('../src/env');
  await migrate();
  await q('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
  const make = async (name: string, o: { open: boolean; password: boolean; disabled?: boolean }) => (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind, password_login, local_open, disabled)
     VALUES ($1, $1, 'x', 'user', 'none', $2, $3, $4) RETURNING id`,
    [`${PREFIX}${name}`, o.password, o.open, !!o.disabled]))[0].id;
  const kid = await make('kid', { open: true, password: false });
  const hybrid = await make('hybrid', { open: true, password: true });
  const grown = await make('grown', { open: false, password: true });
  const gone = await make('gone', { open: true, password: false, disabled: true });
  const before = (await one<{ on: boolean }>('SELECT local_pick AS on FROM server_settings WHERE id = 1'))?.on ?? false;
  const turn = (on: boolean) => q('UPDATE server_settings SET local_pick = $1 WHERE id = 1', [on]);

  const app = (await import('fastify')).default({ trustProxy: auth.trustProxySetting(env.TRUST_PROXY) });
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/auth')).default);
  await app.ready();
  let host = 40;
  const home = () => `192.168.1.${host++}`;
  const listed = async (ip = home()) => (await app.inject({ method: 'GET', url: '/auth/pick', remoteAddress: ip })).json().content
    .map((p: any) => p.id).filter((id: string) => [kid, hybrid, grown, gone].includes(id)).sort();
  const pick = (id: string, ip = home()) => app.inject({ method: 'POST', url: '/auth/profile-login', remoteAddress: ip, payload: { profileId: id } });

  try {
    await t.test('off unless an admin turns it on', async () => {
      await turn(false);
      assert.deepEqual(await listed(), []);
      const r = await pick(kid);
      assert.equal(r.statusCode, 401);
      assert.deepEqual(r.json(), { error: 'invalid_credentials' });
    });

    await t.test('on, at home: the enabled profiles that open at home, a tap each', async () => {
      await turn(true);
      assert.deepEqual(await listed(), [kid, hybrid].sort());
      const r = await pick(kid);
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().user.id, kid);
      assert.equal((app.jwt.decode(r.json().accessToken) as any).loc, true, 'the session does not hold at home only');
      const rt = r.cookies.find((c: any) => c.name === 'yomi_rt').value;
      assert.equal((await auth.validateRefreshToken(rt))?.via, 'local-pick');
      // And it is held there: refreshed from outside, it opens nothing.
      const away = await app.inject({ method: 'POST', url: '/auth/refresh', remoteAddress: AWAY, cookies: { yomi_rt: rt } });
      assert.equal(away.json().error, 'local_only');
    });

    await t.test('a picked session ends when it was going to, however often it is used', async () => {
      // A tablet at home refreshes every few minutes: with a fresh REFRESH_TTL_DAYS at each rotation, a profile picked
      // once would stay signed in for good. Its first expiry holds instead, as a switched-to session's does.
      await turn(true);
      const r = await pick(kid);
      assert.equal(r.statusCode, 200, r.body);
      const rt = r.cookies.find((c: any) => c.name === 'yomi_rt').value;
      const { createHash } = await import('node:crypto');
      await q(`UPDATE refresh_tokens SET expires_at = now() + interval '1 day' WHERE token_hash = $1`, [createHash('sha256').update(rt).digest('hex')]);
      const again = await app.inject({ method: 'POST', url: '/auth/refresh', remoteAddress: home(), cookies: { yomi_rt: rt } });
      assert.equal(again.statusCode, 200, again.body);
      assert.ok(again.json().refreshExpiresAt < Date.now() + 2 * 86_400_000, 'the rotation started a fresh lifetime');
    });

    await t.test('one answer for every refusal: outside, a profile with a password only, a disabled one', async () => {
      await turn(true);
      assert.deepEqual(await listed(AWAY), [], 'outside, the list shows who reads here');
      for (const [id, ip] of [[kid, AWAY], [grown, home()], [gone, home()], ['00000000-0000-4000-8000-000000000000', home()]] as const) {
        const r = await pick(id, ip);
        assert.equal(r.statusCode, 401, `${id} from ${ip}: ${r.body}`);
        assert.deepEqual(r.json(), { error: 'invalid_credentials' });
      }
    });
  } finally {
    await turn(before).catch(() => {});
    await q('DELETE FROM audit_log WHERE user_id = ANY($1::uuid[]) OR username LIKE $2', [[kid, hybrid, grown, gone], `${PREFIX}%`]).catch(() => {});
    await q('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]).catch(() => {});
    await app.close();
  }
});
