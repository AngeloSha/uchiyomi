// The desktop sign-in handshake, end to end against a real database: the shell's secret from this PC gets the
// window exactly the session `/auth/login` would have given it, and that session then works like any other.
//
// ⚠️ CI runs every integration test against ONE shared database, serially, so this file cannot assume an empty
// users table: "the oldest enabled admin" would be whichever admin an earlier file left behind. It sets aside
// (disables) the admins it finds, puts them back afterwards, and removes only the accounts it made.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const DATA = mkdtempSync(join(tmpdir(), 'uchi-desk-int-'));
const PORT = 43124;
const SECRET = '9c'.repeat(32);
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.UCHIYOMI_DESKTOP = '1';
  process.env.UCHIYOMI_DATA_DIR = DATA;
  process.env.PORT = String(PORT);
  process.env.DL_ROOT = join(DATA, 'dl');
  process.env.UCHIYOMI_DESKTOP_SECRET = SECRET;
  process.env.UCHIYOMI_DESKTOP_USER = 'Renata';
  delete process.env.CONFIG_DIR;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const { ensureDesktopUser, desktopUserId } = await import('../src/lib/desktopUser');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const { installDesktopGuards } = await import('../src/lib/desktopGuard');
  const authRoutes = (await import('../src/routes/auth')).default;
  await migrate();
  // Leftovers from an interrupted earlier run of this file, then set every other admin aside.
  await q("DELETE FROM users WHERE auth_kind = 'desktop' OR username IN ('dk-owner', 'dk-gone')");
  const setAside = (await q<{ id: string }>("SELECT id FROM users WHERE role = 'admin' AND NOT disabled")).map((r) => r.id);
  if (setAside.length) await q('UPDATE users SET disabled = true WHERE id = ANY($1::uuid[])', [setAside]);
  const reg = await one<{ allow_registration: boolean }>('SELECT allow_registration FROM server_settings WHERE id = 1');
  const started = (await one<{ t: Date }>('SELECT now() AS t'))!.t;
  const restore = async () => {
    await q("DELETE FROM users WHERE auth_kind = 'desktop' OR username IN ('dk-owner', 'dk-gone')");
    if (setAside.length) await q('UPDATE users SET disabled = false WHERE id = ANY($1::uuid[])', [setAside]);
    await q('UPDATE server_settings SET allow_registration = $1 WHERE id = 1', [!!reg?.allow_registration]);
  };
  const app = Fastify();
  installDesktopGuards(app);
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(authRoutes);
  await app.ready();
  return { app, q, one, ensureDesktopUser, desktopUserId, restore, started };
}

const cookieOf = (res: any, name: string) => res.cookies?.find((c: any) => c.name === name);

test('desktop sign-in against a real database', { skip }, async (t) => {
  const { app, q, one, ensureDesktopUser, desktopUserId, restore, started } = await setup();
  try {
    let userId = '';

    await t.test('ensureDesktopUser makes one local admin, once', async () => {
      // Nobody to sign in as until this runs (server.ts calls it right after migrate()).
      assert.equal(await desktopUserId(), null);
      userId = await ensureDesktopUser();
      // Reintroduce by dropping the `if (existing) return existing` in ensureDesktopUser: the second call makes
      // `local2`, and every boot adds another admin.
      assert.equal(await ensureDesktopUser(), userId, 'a second call made another account');
      const rows = await q<{ id: string; username: string; display_name: string; role: string; auth_kind: string }>(
        "SELECT id, username, display_name, role, auth_kind FROM users WHERE auth_kind = 'desktop' OR role = 'admin' AND NOT disabled");
      assert.deepEqual(rows, [{ id: userId, username: 'local', display_name: 'Renata', role: 'admin', auth_kind: 'desktop' }]);
      assert.ok(await one('SELECT 1 FROM app_settings WHERE user_id = $1', [userId]), 'no app_settings row');
    });

    let rt = '';
    await t.test('the right secret from this PC: 200, the same body and cookies as /auth/login', async () => {
      const res = await app.inject({
        method: 'POST', url: '/auth/desktop', remoteAddress: '127.0.0.1',
        headers: { host: HOST, origin: ORIGIN, 'x-uchiyomi-desktop': SECRET, 'user-agent': 'Uchiyomi-Desktop-Test' },
        payload: { deviceId: 'dev-1' },
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json();
      assert.ok(typeof body.accessToken === 'string' && body.accessToken.length > 20);
      assert.equal(body.desktop, true, 'the web app learns it is on desktop from this');
      assert.equal(body.user.id, userId);
      assert.equal(body.user.role, 'admin');
      assert.equal(body.user.displayName, 'Renata');
      assert.ok(body.refreshExpiresAt > Date.now());
      rt = cookieOf(res, 'yomi_rt')?.value;
      assert.ok(rt, 'no yomi_rt cookie');
      assert.ok(cookieOf(res, 'yomi_img')?.value, 'no yomi_img cookie (every <img> would 401)');
      assert.equal(cookieOf(res, 'yomi_rt').httpOnly, true);
      // The session reads as this computer in the (hidden) sessions list and the audit log.
      const s = await one<{ device_name: string; device_id: string }>(
        'SELECT device_name, device_id FROM refresh_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [userId]);
      assert.deepEqual(s, { device_name: 'This PC', device_id: 'dev-1' });
      assert.ok(await one("SELECT 1 FROM audit_log WHERE event = 'login.desktop' AND user_id = $1", [userId]));

      // /auth/me with that access token.
      const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { host: HOST, authorization: `Bearer ${body.accessToken}` } });
      assert.equal(me.statusCode, 200);
      assert.equal(me.json().id, userId);
    });

    await t.test('the cookie it set refreshes like any other session', async () => {
      const res = await app.inject({ method: 'POST', url: '/auth/refresh', headers: { host: HOST }, cookies: { yomi_rt: rt } });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().desktop, true);
      const next = cookieOf(res, 'yomi_rt')?.value;
      assert.ok(next && next !== rt, 'refresh did not rotate the token');
    });

    await t.test('a refused exchange is audited and issues nothing', async () => {
      const before = await one<{ n: number }>('SELECT count(*)::int AS n FROM refresh_tokens');
      const res = await app.inject({ method: 'POST', url: '/auth/desktop', remoteAddress: '127.0.0.1', headers: { host: HOST, 'x-uchiyomi-desktop': 'nope' } });
      assert.equal(res.statusCode, 401);
      assert.equal((await one<{ n: number }>('SELECT count(*)::int AS n FROM refresh_tokens'))?.n, before?.n);
      assert.ok(await one("SELECT 1 FROM audit_log WHERE event = 'login.desktop_fail' AND detail->>'reason' = 'bad_secret' AND at >= $1", [started]));
    });

    await t.test('a flood of refused exchanges cannot grow the audit log', async () => {
      // ⚠️ The handshake has no rate limit on purpose (routes/auth.ts), and audit_log is never pruned, so one
      // row per refusal let any process on the PC grow the database for as long as it liked: 3,744 rows
      // (1.5 MB) in five seconds of curl.
      const rows = async (reason: string) => (await one<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_log WHERE event = 'login.desktop_fail' AND detail->>'reason' = $1", [reason]))!.n;
      const noSecret = await rows('no_secret');
      const badSecret = await rows('bad_secret');
      for (let i = 0; i < 25; i++) {
        const bare = await app.inject({ method: 'POST', url: '/auth/desktop', remoteAddress: '127.0.0.1', headers: { host: HOST } });
        assert.equal(bare.statusCode, 401);
        const wrong = await app.inject({ method: 'POST', url: '/auth/desktop', remoteAddress: '127.0.0.1', headers: { host: HOST, 'x-uchiyomi-desktop': `guess-${i}` } });
        assert.equal(wrong.statusCode, 401);
      }
      // Reintroduce by auditing the request that carried no secret at all (drop the `if (header)` in
      // routes/auth.ts): 25 rows. Nothing was guessed, so there is nothing to write down.
      assert.equal(await rows('no_secret') - noSecret, 0, 'a request with no secret wrote an audit row');
      // Reintroduce by auditing every wrong secret (drop the desktopFailAudit() gate in routes/auth.ts): 25 rows.
      // One row a minute at most, carrying how many attempts it stands for (desktopAuth.test.ts).
      assert.ok(await rows('bad_secret') - badSecret <= 1, `wrong secrets wrote ${await rows('bad_secret') - badSecret} rows, not one`);
    });

    await t.test('/auth/config says desktop, and registration is closed whatever the settings say', async () => {
      await q('UPDATE server_settings SET allow_registration = true WHERE id = 1');
      {
        const res = await app.inject({ method: 'GET', url: '/auth/config', headers: { host: HOST } });
        assert.equal(res.statusCode, 200);
        const c = res.json();
        // Reintroduce by dropping `!isDesktop() &&` from allowRegistration: this is true.
        assert.equal(c.allowRegistration, false);
        assert.equal(c.desktop, true, 'a browser tab needs this to say "open the app" instead of a sign-in form');
        assert.deepEqual(c.oidc, { enabled: false, name: '' }, 'OIDC is forced off on desktop');
      }
    });

    await t.test('a restored server database: the window signs in as its oldest enabled admin', async () => {
      // A server backup restored onto the desktop brings its own admin (and no `local`). The exchange must
      // sign in as that person, with their library and progress, not as a new empty account.
      const [owner] = await q<{ id: string }>(
        `INSERT INTO users (display_name, username, role, password_hash, auth_kind, created_at)
         VALUES ('Owner', 'dk-owner', 'admin', 'x', 'password', now() - interval '400 days') RETURNING id`);
      const [gone] = await q<{ id: string }>(
        `INSERT INTO users (display_name, username, role, password_hash, auth_kind, created_at, disabled)
         VALUES ('Gone', 'dk-gone', 'admin', 'x', 'password', now() - interval '800 days', true) RETURNING id`);
      // Reintroduce by dropping `AND NOT disabled` from desktopUserId: the disabled account is picked.
      assert.equal(await desktopUserId(), owner.id);
      assert.equal(await ensureDesktopUser(), owner.id, 'ensureDesktopUser made a new account beside the restored admin');
      const res = await app.inject({ method: 'POST', url: '/auth/desktop', remoteAddress: '127.0.0.1', headers: { host: HOST, 'x-uchiyomi-desktop': SECRET } });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().user.id, owner.id);
      assert.notEqual(res.json().user.id, gone.id);
    });

    await t.test('a restored database whose only `local` is disabled: the next account is local2', async () => {
      await q("UPDATE users SET disabled = true WHERE auth_kind = 'desktop' OR username = 'dk-owner'");
      const id = await ensureDesktopUser();
      const row = await one<{ username: string }>('SELECT username FROM users WHERE id = $1', [id]);
      assert.equal(row?.username, 'local2');
    });
  } finally {
    await app.close();
    await restore();
  }
});
