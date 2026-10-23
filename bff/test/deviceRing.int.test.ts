// The device keyring (lib/deviceRing.ts; GET /auth/ring, POST /auth/resume, POST /auth/leave): a sign-in that ticks
// Remember on this device can be taken up again on that device
// without its password, for as long as its session lives, and on no other device. Skipped unless TEST_DATABASE_URL is set.
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

const PREFIX = 'dr-';
const PASSWORD = 'dr-password-only-for-this-test';
const AWAY = '203.0.113.9';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('the device keyring', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const auth = await import('../src/lib/auth');
  const ring = await import('../src/lib/deviceRing');
  const { env } = await import('../src/env');
  const { hash } = await import('@node-rs/argon2');
  await migrate();
  await q('DELETE FROM users WHERE managed_by IN (SELECT id FROM users WHERE username LIKE $1)', [`${PREFIX}%`]);
  await q('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
  const ph = await hash(PASSWORD);
  const user = async (name: string, role = 'user') => (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1, $1, $2, $3, 'password') RETURNING id`,
    [`${PREFIX}${name}`, ph, role]))[0].id;
  const alice = await user('alice');
  const bob = await user('bob');
  const admin = await user('admin', 'admin');

  const app = (await import('fastify')).default({ trustProxy: auth.trustProxySetting(env.TRUST_PROXY) });
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/auth')).default);
  await app.ready();

  // A home address of its own per sign-in route call: they carry the sign-in limit.
  let host = 10;
  const home = () => `192.168.1.${host++}`;
  const cookieOf = (res: any, name: string) => res.cookies.find((c: any) => c.name === name);
  /** A sign-in on a device (its yomi_dev cookie, or a new device); the device key and the session cookie after it. */
  const signIn = async (name: string, remember: boolean, dev?: string) => {
    const res = await app.inject({
      method: 'POST', url: '/auth/login', remoteAddress: home(), cookies: dev ? { yomi_dev: dev } : {},
      payload: { username: `${PREFIX}${name}`, password: PASSWORD, remember },
    });
    assert.equal(res.statusCode, 200, res.body);
    return { dev: cookieOf(res, 'yomi_dev')?.value ?? dev, rt: cookieOf(res, 'yomi_rt').value as string };
  };
  const listed = async (dev: string, ip = home()) =>
    (await app.inject({ method: 'GET', url: '/auth/ring', remoteAddress: ip, cookies: { yomi_dev: dev } })).json().content.map((p: any) => p.id).sort();
  const resume = (dev: string | undefined, id: string, rt?: string, ip = home()) => app.inject({
    method: 'POST', url: '/auth/resume', remoteAddress: ip, payload: { profileId: id },
    cookies: { ...(dev ? { yomi_dev: dev } : {}), ...(rt ? { yomi_rt: rt } : {}) },
  });
  const live = async (rt: string) => !!(await auth.validateRefreshToken(rt));

  try {
    await t.test('remembering is opt-in, and its cookie goes to the sign-in routes only', async () => {
      const plain = await app.inject({ method: 'POST', url: '/auth/login', remoteAddress: home(), payload: { username: `${PREFIX}alice`, password: PASSWORD } });
      assert.equal(cookieOf(plain, 'yomi_dev'), undefined, 'a device that asked nothing is remembered');
      const res = await app.inject({ method: 'POST', url: '/auth/login', remoteAddress: home(), payload: { username: `${PREFIX}alice`, password: PASSWORD, remember: true } });
      const dev = cookieOf(res, 'yomi_dev');
      assert.ok(dev?.value, 'no device cookie');
      assert.equal(dev.path, '/auth');
      assert.equal(dev.httpOnly, true);
      assert.deepEqual(await listed(dev.value), [alice]);
      assert.equal(await one('SELECT 1 FROM device_ring WHERE device_hash = $1', [dev.value]), null, 'the cookie itself is stored');
    });

    await t.test('two accounts on one device, each taken up again without its password', async () => {
      const a = await signIn('alice', true);
      const b = await signIn('bob', true, a.dev);
      assert.deepEqual(await listed(a.dev!), [alice, bob].sort());
      const toA = await resume(a.dev, alice, b.rt);
      assert.equal(toA.statusCode, 200, toA.body);
      assert.equal(toA.json().user.id, alice);
      assert.ok(await live(b.rt), 'putting bob aside ended his remembered session');
      const toB = await resume(a.dev, bob, cookieOf(toA, 'yomi_rt').value);
      assert.equal(toB.statusCode, 200, toB.body);
      assert.equal(toB.json().user.id, bob);
      assert.equal((await one<any>(`SELECT detail FROM audit_log WHERE event = 'login.switch' AND user_id = $1 ORDER BY id DESC LIMIT 1`, [bob]))?.detail?.via, 'ring');
    });

    await t.test('on that device only', async () => {
      const a = await signIn('alice', true);
      const other = await signIn('bob', true);
      for (const dev of [undefined, other.dev, 'f'.repeat(64), 'not-a-key']) {
        const r = await resume(dev, alice);
        assert.equal(r.statusCode, 401, `${dev}: ${r.body}`);
        assert.equal(r.json().error, 'not_remembered');
      }
      assert.equal((await resume(a.dev, alice)).statusCode, 200);
    });

    await t.test('an entry lasts as long as its session: sign-out and sign-out everywhere end it', async () => {
      const a = await signIn('alice', true);
      await app.inject({ method: 'POST', url: '/auth/logout', cookies: { yomi_rt: a.rt } });
      assert.deepEqual(await listed(a.dev!), []);
      assert.equal((await resume(a.dev, alice)).json().error, 'not_remembered');
      const again = await signIn('alice', true, a.dev);
      await auth.revokeAllSessions(alice);
      assert.deepEqual(await listed(again.dev!), []);
      // And the daily prune drops what no longer opens.
      await ring.pruneRing();
      assert.equal(await one('SELECT 1 FROM device_ring WHERE user_id = $1', [alice]), null);
    });

    await t.test('an admin remembered for more than twelve hours signs in again', async () => {
      const d = await signIn('admin', true);
      await q(`UPDATE refresh_tokens SET created_at = now() - interval '13 hours'
                WHERE id = (SELECT session_id FROM refresh_tokens WHERE token_hash = $1)`, [sha(d.rt)]);
      const r = await resume(d.dev, admin);
      assert.equal(r.statusCode, 401);
      assert.equal(r.json().error, 'reauth');
      assert.deepEqual(await listed(d.dev!), [], 'the entry is forgotten');
      // A member is remembered as long as the session lives.
      const m = await signIn('bob', true);
      await q(`UPDATE refresh_tokens SET created_at = now() - interval '13 hours'
                WHERE id = (SELECT session_id FROM refresh_tokens WHERE token_hash = $1)`, [sha(m.rt)]);
      assert.equal((await resume(m.dev, bob)).statusCode, 200);
    });

    await t.test('leaving keeps a remembered session for later, and ends any other', async () => {
      const a = await signIn('alice', true);
      const left = await app.inject({ method: 'POST', url: '/auth/leave', cookies: { yomi_rt: a.rt, yomi_dev: a.dev! } });
      assert.equal(left.json().remembered, true);
      assert.equal(cookieOf(left, 'yomi_rt')?.value, '', 'the session cookie goes; the session stays');
      assert.ok(await live(a.rt));
      const p = await signIn('bob', false, a.dev);
      const left2 = await app.inject({ method: 'POST', url: '/auth/leave', cookies: { yomi_rt: p.rt, yomi_dev: a.dev! } });
      assert.equal(left2.json().remembered, false);
      assert.equal(await live(p.rt), false, 'a session nobody remembered was left live with no cookie');
    });

    await t.test('taking up a remembered account ends a session the device held and did not remember', async () => {
      const a = await signIn('alice', true);
      const passing = await signIn('bob', false, a.dev);
      assert.equal((await resume(a.dev, alice, passing.rt)).statusCode, 200);
      assert.equal(await live(passing.rt), false);
    });

    await t.test('a session entered without a password is listed and taken up at home only', async () => {
      // Nothing remembers one today -- only a password sign-in ticks the box -- so it is put there by hand: the rule
      // holds whatever wrote the entry.
      const kid = (await q<{ id: string }>(
        `INSERT INTO users (username, display_name, password_hash, role, auth_kind, password_login, local_open, managed_by)
         VALUES ('dr-kid', 'dr-kid', 'x', 'user', 'none', false, true, $1) RETURNING id`, [alice]))[0].id;
      const a = await signIn('alice', true);
      const ksid = (await one<{ s: string }>(`SELECT session_id AS s FROM refresh_tokens WHERE token_hash = $1`,
        [sha(await auth.issueRefreshToken(kid, { via: 'switch' }))]))!.s;
      await ring.rememberSession(a.dev!, kid, ksid);
      assert.deepEqual(await listed(a.dev!, AWAY), [alice]);
      assert.deepEqual(await listed(a.dev!), [alice, kid].sort());
      assert.equal((await resume(a.dev, kid, undefined, AWAY)).json().error, 'local_only');
      const r = await resume(a.dev, kid);
      assert.equal(r.statusCode, 200);
      assert.equal((app.jwt.decode(r.json().accessToken) as any).loc, true);
    });
  } finally {
    await q('DELETE FROM audit_log WHERE user_id = ANY($1::uuid[]) OR username LIKE $2', [[alice, bob, admin], `${PREFIX}%`]).catch(() => {});
    await q('DELETE FROM users WHERE managed_by = $1', [alice]).catch(() => {});
    await q('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]).catch(() => {});
    await app.close();
  }
});
