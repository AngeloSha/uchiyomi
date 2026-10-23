// A session entered without a password holds at home only: lib/auth.ts authenticate,
// exchangeRefreshToken and requireCredentialSession, routes/images.ts authorizeImageRequest, lib/clientAddr.ts
// clientZone. Driven over HTTP from a home address, from outside, and through a proxy. Nothing opens such a session yet
// (the switch is next), so it is issued here the way the switch will issue it. Skipped unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  // Read once, when env.ts loads: this file's home, and its reverse proxy named by address -- through a proxy only the
  // default names trust, nobody is at home (lib/clientAddr.ts unnamedHop; clientZone.test.ts).
  process.env.LOCAL_NETWORKS = '192.168.1.0/24';
  process.env.TRUST_PROXY = 'loopback, 172.18.0.5';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const NAMES = ['pz-guardian', 'pz-child'];
const HOME = '192.168.1.20';
const AWAY = '203.0.113.5';
const PROXY = '172.18.0.5'; // named in TRUST_PROXY above
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const auth = await import('../src/lib/auth');
  const { env } = await import('../src/env');
  const Fastify = (await import('fastify')).default;
  const { authorizeImageRequest } = await import('../src/routes/images');

  await migrate();
  await q('DELETE FROM users WHERE username = ANY($1)', [NAMES]);
  const guardian = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ('pz-guardian', 'pz-guardian', 'x', 'user', 'password') RETURNING id`))[0].id;
  const child = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind, password_login, local_open, managed_by)
     VALUES ('pz-child', 'pz-child', 'x', 'user', 'none', false, true, $1) RETURNING id`, [guardian]))[0].id;

  const app = Fastify({ trustProxy: auth.trustProxySetting(env.TRUST_PROXY) });
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  // As server.ts does: every /img/ route behind the one guard.
  app.addHook('preHandler', async (req, reply) => { if (req.url.startsWith('/img/')) await authorizeImageRequest(app, req, reply); });
  app.get('/img/probe', async () => ({ ok: true }));
  await app.register((await import('../src/routes/auth')).default);
  await app.register((await import('../src/routes/personal')).default);
  await app.ready();
  return { app, q, one, auth, guardian, child };
}

const cookieOf = (res: any, name: string): string | null => res.cookies?.find((c: any) => c.name === name)?.value ?? null;

test('a session entered without a password, at home and away', { skip }, async (t) => {
  const { app, q, one, auth, guardian, child } = await setup();
  const from = (ip: string, xff?: string) => ({ remoteAddress: ip, ...(xff ? { headers: { 'x-forwarded-for': xff } } : {}) });
  const refresh = (token: string, ip: string, xff?: string) =>
    app.inject({ method: 'POST', url: '/auth/refresh', cookies: { yomi_rt: token }, ...from(ip, xff) });
  const me = (access: string, ip: string, xff?: string) =>
    app.inject({ method: 'GET', url: '/auth/me', remoteAddress: ip, headers: { authorization: `Bearer ${access}`, ...(xff ? { 'x-forwarded-for': xff } : {}) } });
  /** The guardian's session, and the child's opened from it the way the switch will. */
  const family = async () => {
    const g = await auth.issueRefreshToken(guardian, { via: 'password', deviceName: 'tablet' });
    const sid = (await one<{ s: string }>('SELECT session_id AS s FROM refresh_tokens WHERE token_hash = $1', [sha(g)]))!.s;
    const c = await auth.issueRefreshToken(child, { via: 'switch', parentSession: sid, deviceName: 'tablet' });
    return { g, c };
  };
  /** At home: the child's access token and image cookie, and the token the jar holds afterwards. */
  const atHome = async (c: string) => {
    const res = await refresh(c, HOME);
    assert.equal(res.statusCode, 200, 'precondition: at home the child refreshes');
    return { access: res.json().accessToken as string, img: cookieOf(res, 'yomi_img')!, token: cookieOf(res, 'yomi_rt') ?? c };
  };

  try {
    await t.test('at home it is a session like any other, and what it is minted says it holds at home only', async () => {
      const { c } = await family();
      const { access, img } = await atHome(c);
      assert.equal((app.jwt.decode(access) as any).loc, true);
      assert.equal((app.jwt.decode(img) as any).loc, true);
      const res = await me(access, HOME);
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().kind, 'open');
      assert.equal((await app.inject({ url: '/img/probe', remoteAddress: HOME, cookies: { yomi_img: img } })).statusCode, 200);
    });

    await t.test('outside, a session entered without a password opens nothing', async () => {
      // Reintroduce by dropping the zone check from authenticate, or from the image guard: that request gets a 200.
      const { c } = await family();
      const { access, img } = await atHome(c);
      const api = await me(access, AWAY);
      assert.equal(api.statusCode, 401);
      assert.deepEqual(api.json(), { error: 'local_only' });
      const page = await app.inject({ url: '/img/probe', remoteAddress: AWAY, cookies: { yomi_img: img } });
      assert.equal(page.statusCode, 401, 'the week-long image cookie opened a page from outside');
    });

    await t.test('outside, a session entered without a password refreshes nothing', async () => {
      const { c } = await family();
      const { token } = await atHome(c);
      const away = await refresh(token, AWAY);
      assert.equal(away.statusCode, 401);
      assert.deepEqual(away.json(), { error: 'local_only' });
      assert.equal(cookieOf(away, 'yomi_rt'), null, 'the cookie is left alone: back home it works again');
      assert.equal((await refresh(token, HOME)).statusCode, 200, 'and it does');
    });

    await t.test('behind the proxy the forwarded address decides, and an outside visitor cannot claim home', async () => {
      const { c } = await family();
      const { token } = await atHome(c);
      assert.equal((await refresh(token, PROXY, AWAY)).statusCode, 401, 'forwarded from outside');
      assert.equal((await refresh(token, AWAY, HOME)).statusCode, 401, 'an outside visitor claiming a home address');
      assert.equal((await refresh(token, PROXY, HOME)).statusCode, 200, 'forwarded from home');
    });

    await t.test('a session with a password is held to nothing', async () => {
      const { g } = await family();
      const res = await refresh(g, AWAY);
      assert.equal(res.statusCode, 200);
      assert.equal((app.jwt.decode(res.json().accessToken) as any).loc, undefined, 'an ordinary token is what it always was');
      assert.equal((await me(res.json().accessToken, AWAY)).statusCode, 200);
    });

    await t.test('a session entered without a password makes no credential', async () => {
      // Each of these, made at home, would work from anywhere. Reintroduce by dropping requireCredentialSession from a
      // route: its line here sees the credential made.
      const { g, c } = await family();
      const { access } = await atHome(c);
      const as = (token: string) => ({ remoteAddress: HOME, headers: { authorization: `Bearer ${token}` } });
      const refused = [
        await app.inject({ method: 'POST', url: '/api/tokens', payload: { name: 'pz', scopes: ['read'] }, ...as(access) }),
        await app.inject({ method: 'POST', url: '/api/opds/token', ...as(access) }),
        await app.inject({ method: 'POST', url: '/auth/password', payload: { current: 'x', next: 'pz-new-password' }, ...as(access) }),
        await app.inject({ method: 'POST', url: '/auth/totp/setup', ...as(access) }),
      ];
      for (const r of refused) {
        assert.equal(r.statusCode, 403, r.body);
        assert.equal(r.json().error, 'credential_required');
      }
      assert.equal((await one<{ n: number }>('SELECT count(*)::int AS n FROM api_tokens WHERE user_id = $1', [child]))!.n, 0);
      // The same request from the guardian's session, entered with a password, is an ordinary one.
      const gAccess = (await refresh(g, HOME)).json().accessToken;
      const ok = await app.inject({ method: 'POST', url: '/api/tokens', payload: { name: 'pz', scopes: ['read'] }, ...as(gAccess) });
      assert.equal(ok.statusCode, 200, ok.body);
    });

    await t.test('a rotation keeps the expiry it was given', async () => {
      // A session opened from another must not outlive the lifetime it was opened with by refreshing.
      const { c } = await family();
      await q(`UPDATE refresh_tokens SET expires_at = now() + interval '3 days' WHERE token_hash = $1`, [sha(c)]);
      const { token } = await atHome(c);
      const e = (await one<{ d: number }>(
        `SELECT extract(epoch FROM expires_at - now())::int AS d FROM refresh_tokens WHERE token_hash = $1`, [sha(token)]))!.d;
      assert.ok(Math.abs(e - 3 * 86400) < 120, `expires in ${e} s, not three days`);
    });
  } finally {
    await q('DELETE FROM audit_log WHERE username = ANY($1) OR user_id = ANY($2::uuid[])', [NAMES, [guardian, child]]).catch(() => {});
    await q('DELETE FROM users WHERE username = ANY($1)', [NAMES]).catch(() => {});
    await app.close();
  }
});
