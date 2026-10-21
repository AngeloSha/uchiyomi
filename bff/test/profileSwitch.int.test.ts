// Switching a device to a profile that opens at home, from the session of the account that manages it (POST
// /auth/switch, GET /auth/profiles). Each refusal is a check of its own: dropping
// any one of them makes its case below switch. Skipped unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LOCAL_NETWORKS = '192.168.1.0/24';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const PREFIX = 'ps-';
const HOME = '192.168.1.20';
const AWAY = '203.0.113.5';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('switching to a profile that opens at home', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const auth = await import('../src/lib/auth');
  const { env } = await import('../src/env');
  await migrate();
  await q('DELETE FROM users WHERE managed_by IN (SELECT id FROM users WHERE username LIKE $1)', [`${PREFIX}%`]);
  await q('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
  const user = async (name: string, o: { role?: string; open?: boolean; password?: boolean; managedBy?: string } = {}) => (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind, password_login, local_open, managed_by)
     VALUES ($1, $1, 'x', $2, $3, $4, $5, $6) RETURNING id`,
    [`${PREFIX}${name}`, o.role ?? 'user', o.password === false ? 'none' : 'password', o.password !== false, !!o.open, o.managedBy ?? null]))[0].id;
  const guardian = await user('guardian');
  const stranger = await user('stranger');
  const admin = await user('admin', { role: 'admin' });
  const kid = await user('kid', { open: true, password: false, managedBy: guardian });
  const hybrid = await user('hybrid', { open: true, managedBy: guardian });
  const grownup = await user('grownup', { managedBy: guardian }); // managed, but does not open at home
  const gone = await user('gone', { open: true, password: false, managedBy: guardian });
  await q('UPDATE users SET disabled = true WHERE id = $1', [gone]);

  const app = (await import('fastify')).default({ trustProxy: auth.trustProxySetting(env.TRUST_PROXY) });
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/auth')).default);
  await app.ready();

  /** A signed-in device of `userId` at home: its refresh cookie and an access token, as the app holds them. */
  const device = async (userId: string) => {
    const rt = await auth.issueRefreshToken(userId, { via: 'password', deviceName: 'tablet' });
    const res = await app.inject({ method: 'POST', url: '/auth/refresh', remoteAddress: HOME, cookies: { yomi_rt: rt } });
    return { rt: res.cookies.find((c: any) => c.name === 'yomi_rt')?.value ?? rt, access: res.json().accessToken as string };
  };
  // A home address of its own for each switch: the route carries the sign-in limit, ten an address in five minutes.
  let host = 30;
  const sw = (d: { rt?: string; access: string }, profileId: string, ip = `192.168.1.${host++}`) => app.inject({
    method: 'POST', url: '/auth/switch', remoteAddress: ip, payload: { profileId },
    headers: { authorization: `Bearer ${d.access}` }, ...(d.rt ? { cookies: { yomi_rt: d.rt } } : {}),
  });
  const rtOf = (res: any) => res.cookies.find((c: any) => c.name === 'yomi_rt')?.value as string | undefined;

  try {
    await t.test('from home the guardian lists its profiles and switches to one, without its password', async () => {
      const g = await device(guardian);
      const list = await app.inject({ method: 'GET', url: '/auth/profiles', remoteAddress: HOME, headers: { authorization: `Bearer ${g.access}` } });
      assert.equal(list.json().zone, 'local');
      assert.deepEqual(list.json().content.map((p: any) => p.id).sort(), [kid, hybrid].sort(), 'its own profiles that open at home, enabled');
      const res = await sw(g, kid);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().user.id, kid);
      assert.equal(res.json().user.kind, 'open');
      assert.equal((app.jwt.decode(res.json().accessToken) as any).loc, true, 'the profile\'s token holds at home only');
      const row = await one<any>(
        `SELECT r.via, r.parent_session, r.expires_at, p.session_id AS parent, p.expires_at AS parent_expires
           FROM refresh_tokens r, refresh_tokens p WHERE r.token_hash = $1 AND p.token_hash = $2`, [sha(rtOf(res)!), sha(g.rt)]);
      assert.equal(row.via, 'switch');
      assert.equal(row.parent_session, row.parent, 'opened from the guardian\'s session');
      assert.equal(new Date(row.expires_at).getTime(), new Date(row.parent_expires).getTime(), 'and lasting no longer than it');
      const audit = await one<any>(`SELECT detail FROM audit_log WHERE event = 'login.switch' AND user_id = $1 ORDER BY id DESC LIMIT 1`, [kid]);
      assert.equal(audit?.detail?.from, guardian);
      // A hybrid switches the same way: at home it needs no password either.
      assert.equal((await sw(await device(guardian), hybrid)).statusCode, 200);
    });

    await t.test('outside, nothing is listed and nothing switches', async () => {
      const g = await device(guardian);
      const list = await app.inject({ method: 'GET', url: '/auth/profiles', remoteAddress: AWAY, headers: { authorization: `Bearer ${g.access}` } });
      assert.deepEqual(list.json(), { zone: 'remote', content: [] });
      const res = await sw(g, kid, AWAY);
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error, 'local_only');
    });

    await t.test('only the guardian, or an admin, and only to an enabled profile that opens at home', async () => {
      const denied = async (d: any, id: string) => {
        const res = await sw(d, id);
        assert.equal(res.statusCode, 403, `${id}: ${res.body}`);
        assert.equal(res.json().error, 'switch_denied');
      };
      await denied(await device(stranger), kid);
      const g = await device(guardian);
      await denied(g, grownup);
      await denied(g, gone);
      await denied(g, guardian);
      assert.ok(await one(`SELECT 1 FROM audit_log WHERE event = 'login.fail' AND user_id = $1 AND detail->>'reason' = 'switch_denied'`, [stranger]),
        'a refused switch is written down');
      assert.equal((await sw(await device(admin), kid)).statusCode, 200, 'an admin switches to any of them');
    });

    await t.test('it takes the device\'s own session, entered with a credential', async () => {
      const g = await device(guardian);
      assert.equal((await sw({ access: g.access }, kid)).statusCode, 401, 'an access token alone, no session cookie');
      const s = await device(stranger);
      assert.equal((await sw({ rt: s.rt, access: g.access }, kid)).statusCode, 401, 'another account\'s cookie');
      // From inside the profile: a session entered without a password switches nowhere.
      const inKid = await sw(await device(guardian), kid);
      const fromKid = await sw({ rt: rtOf(inKid), access: inKid.json().accessToken }, hybrid);
      assert.equal(fromKid.statusCode, 403);
      assert.equal(fromKid.json().error, 'credential_required');
    });

    await t.test('the guardian signing out ends the profile on that device', async () => {
      const g = await device(guardian);
      const inKid = await sw(g, kid);
      await app.inject({ method: 'POST', url: '/auth/logout', cookies: { yomi_rt: g.rt } });
      const after = await app.inject({ method: 'POST', url: '/auth/refresh', remoteAddress: HOME, cookies: { yomi_rt: rtOf(inKid)! } });
      assert.equal(after.statusCode, 401);
    });
  } finally {
    await q('DELETE FROM audit_log WHERE username LIKE $1 OR user_id = ANY($2::uuid[])', [`${PREFIX}%`, [guardian, stranger, admin, kid, hybrid, grownup, gone]]).catch(() => {});
    await q('DELETE FROM users WHERE managed_by = $1', [guardian]).catch(() => {});
    await q('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]).catch(() => {});
    await app.close();
  }
});
