// Signing up, against a real database (v0.61.0).
//
// Admin → Settings → Open registration existed, and POST /auth/register behind it, but the sign-in screen had no form,
// so the switch did nothing anyone could see. v0.61.0 adds the form (web/components/LoginScreen.tsx) and makes the
// route answer like a sign-in: the device names itself, a name that differs from an existing one only in case is
// taken (uq_users_username is case-sensitive -- a stranger could be `Admin` beside `admin`), and two sign-ups racing
// for one name end in one account and a 409, never a 500.
//
// ⚠️ CI runs every integration test against ONE shared database, serially: this file puts Open registration back the
// way it found it and removes only the accounts it made (all named `reg-q-…`).
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const PASSWORD = 'a-long-enough-passw0rd';
const cookieOf = (res: any, name: string) => res.cookies?.find((c: any) => c.name === name);

test('signing up', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one, pool } = await import('../src/lib/db');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const authRoutes = (await import('../src/routes/auth')).default;
  await migrate();
  const clean = () => q(`DELETE FROM users WHERE lower(username) LIKE 'reg-q-%'`);
  await clean();
  const was = await one<{ allow_registration: boolean }>('SELECT allow_registration FROM server_settings WHERE id = 1');
  const setOpen = (on: boolean) => q('UPDATE server_settings SET allow_registration = $1 WHERE id = 1', [on]);
  const started = (await one<{ t: Date }>('SELECT now() AS t'))!.t;
  const app = Fastify();
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(authRoutes);
  await app.ready();
  const register = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/auth/register', headers: { 'user-agent': 'register-int-test' }, payload });
  const named = async (name: string) =>
    (await one<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE lower(username) = lower($1)', [name]))!.n;

  try {
    await t.test('closed: 403 registration_disabled, and no account is made', async () => {
      await setOpen(false);
      const r = await register({ username: 'reg-q-closed', password: PASSWORD });
      assert.equal(r.statusCode, 403, r.body);
      assert.equal(r.json().error, 'registration_disabled');
      assert.equal(await named('reg-q-closed'), 0);
    });

    await t.test('open: 200, a member with settings, a session cookie, an audit row, and the device it named', async () => {
      await setOpen(true);
      const r = await register({ username: 'reg-q-open', password: PASSWORD, deviceId: 'dev-reg-1', deviceName: 'Kedryn’s phone' });
      assert.equal(r.statusCode, 200, r.body);
      const body = r.json();
      assert.ok(typeof body.accessToken === 'string' && body.accessToken.length > 20, 'no access token');
      assert.equal(body.user.username, 'reg-q-open');
      assert.equal(body.user.role, 'user', 'a sign-up is a member, never an admin');
      assert.ok(body.refreshExpiresAt > Date.now());
      const rt = cookieOf(r, 'yomi_rt')?.value;
      assert.ok(rt, 'no yomi_rt cookie: the session would end with the tab');
      assert.ok(cookieOf(r, 'yomi_img')?.value, 'no yomi_img cookie (every <img> would 401)');
      const u = await one<{ id: string; role: string; auth_kind: string; display_name: string }>(
        `SELECT id, role, auth_kind, display_name FROM users WHERE username = 'reg-q-open'`);
      assert.ok(u, 'no account');
      assert.deepEqual([u.role, u.auth_kind, u.display_name], ['user', 'password', 'reg-q-open']);
      assert.ok(await one('SELECT 1 FROM app_settings WHERE user_id = $1', [u.id]), 'no app_settings row');
      assert.ok(await one(`SELECT 1 FROM audit_log WHERE event = 'user.register' AND user_id = $1 AND at >= $2`, [u.id, started]), 'not audited');
      // Reintroduce by dropping deviceId/deviceName from the issueRefreshToken call: the session is a nameless device.
      const s = await one<{ device_name: string | null; device_id: string | null }>(
        'SELECT device_name, device_id FROM refresh_tokens WHERE user_id = $1', [u.id]);
      assert.deepEqual(s, { device_name: 'Kedryn’s phone', device_id: 'dev-reg-1' });
      const sessions = await app.inject({ method: 'GET', url: '/auth/sessions', headers: { authorization: `Bearer ${body.accessToken}` }, cookies: { yomi_rt: rt } });
      assert.equal(sessions.statusCode, 200, sessions.body);
      const mine = sessions.json().content;
      assert.equal(mine.length, 1);
      assert.equal(mine[0].device_name, 'Kedryn’s phone', 'the sessions list does not name the device');
      assert.equal(mine[0].current, true);
    });

    await t.test('the same name again is taken: 409', async () => {
      const r = await register({ username: 'reg-q-open', password: PASSWORD });
      assert.equal(r.statusCode, 409, r.body);
      assert.equal(r.json().error, 'username_taken');
      assert.equal(await named('reg-q-open'), 1);
    });

    await t.test('a lookalike of an existing name is taken', async () => {
      // Reintroduce by comparing `username = $1` in the route: this is a 200, and two accounts read alike.
      for (const lookalike of ['REG-Q-OPEN', 'Reg-Q-Open']) {
        const r = await register({ username: lookalike, password: PASSWORD });
        assert.equal(r.statusCode, 409, `${lookalike}: ${r.body}`);
        assert.equal(r.json().error, 'username_taken');
      }
      assert.equal(await named('reg-q-open'), 1, 'a lookalike was made');
    });

    await t.test('sign-ups racing for one name in different cases end in one account', async () => {
      // All four hash their password (argon2, off the main thread) at once and reach the check together. Reintroduce by
      // dropping the advisory lock in the route: they see no row, they insert, and the names differ only in case --
      // several accounts.
      const rs = await Promise.all(['reg-q-race', 'REG-Q-RACE', 'Reg-Q-Race', 'reg-Q-RACE']
        .map((username) => register({ username, password: PASSWORD })));
      assert.deepEqual(rs.map((r) => r.statusCode).sort(), [200, 409, 409, 409], rs.map((r) => r.body).join(' | '));
      assert.equal(await named('reg-q-race'), 1);
    });

    await t.test('a unique violation from another writer is a 409, not a 500', async () => {
      // Another writer holds the exact name, uncommitted: the route's check cannot see it, its INSERT waits on the
      // unique index, and the other commit turns that INSERT into a 23505. Reintroduce by dropping the 23505 mapping
      // in the route: this is a 500.
      const other = await pool.connect();
      try {
        await other.query('BEGIN');
        await other.query(`INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ('x', 'reg-q-dup', 'user', 'x', 'password')`);
        const pending = register({ username: 'reg-q-dup', password: PASSWORD });
        // Until the route's INSERT is waiting on that row's lock.
        let waiting = false;
        for (let i = 0; i < 200 && !waiting; i++) {
          waiting = !!(await one(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'INSERT INTO users%'`));
          if (!waiting) await new Promise((r) => setTimeout(r, 25));
        }
        assert.ok(waiting, 'the route never reached its INSERT');
        await other.query('COMMIT');
        const r = await pending;
        assert.equal(r.statusCode, 409, r.body);
        assert.equal(r.json().error, 'username_taken');
      } finally {
        await other.query('ROLLBACK').catch(() => {});
        other.release();
      }
      assert.equal(await named('reg-q-dup'), 1);
    });

    await t.test('a weak password or a name the rules refuse is a 400, and nothing is made', async () => {
      const weak = await register({ username: 'reg-q-weak', password: 'short' });
      assert.deepEqual([weak.statusCode, weak.json().error], [400, 'weak_password']);
      for (const username of ['reg q spaced', 'r', 'reg-q-ünïcode']) {
        const bad = await register({ username, password: PASSWORD });
        assert.deepEqual([bad.statusCode, bad.json().error], [400, 'bad_request'], username);
      }
      const longDevice = await register({ username: 'reg-q-device', password: PASSWORD, deviceName: 'x'.repeat(129) });
      assert.deepEqual([longDevice.statusCode, longDevice.json().error], [400, 'bad_request'], 'a device name is held to /auth/login\'s limit');
      assert.equal(await named('reg-q-weak') + await named('reg-q-device'), 0);
    });
  } finally {
    await app.close();
    await clean().catch(() => {});
    await setOpen(!!was?.allow_registration).catch(() => {});
  }
});
