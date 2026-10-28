// Admin -> Members makes profiles that open at home: POST and PATCH
// /api/admin/users with localOpen, removePassword and managedBy, and the rules that hold whatever the body says -- a
// profile that opens at home is never an admin, and every account keeps a way in. Skipped unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const PREFIX = 'pp-';
const PASSWORD = 'pp-password-only-for-this-test';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('profiles that open at home, from Admin -> Members', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const auth = await import('../src/lib/auth');
  await migrate();
  await q('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
  const admin = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ('pp-admin', 'pp-admin', 'x', 'admin', 'password') RETURNING id`))[0].id;

  const app = (await import('fastify')).default();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/auth')).default);
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  const asAdmin = { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` };
  const make = (body: object) => app.inject({ method: 'POST', url: '/api/admin/users', headers: asAdmin, payload: body });
  const patch = (id: string, body: object) => app.inject({ method: 'PATCH', url: `/api/admin/users/${id}`, headers: asAdmin, payload: body });
  const kindOf = async (id: string) => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/users', headers: asAdmin });
    return res.json().content.find((u: any) => u.id === id);
  };
  const login = (username: string, password = PASSWORD) =>
    app.inject({ method: 'POST', url: '/auth/login', remoteAddress: '198.51.100.70', payload: { username, password } });

  try {
    await t.test('a profile with no password: no way in through the sign-in form, whatever is typed', async () => {
      const res = await make({ username: 'pp-kid', localOpen: true, managedBy: admin });
      assert.equal(res.statusCode, 200, res.body);
      const row = await one<any>('SELECT password_login, local_open, auth_kind, managed_by, password_hash FROM users WHERE id = $1', [res.json().id]);
      assert.deepEqual([row.password_login, row.local_open, row.auth_kind, row.managed_by], [false, true, 'none', admin]);
      assert.match(row.password_hash, /^\$argon2/, 'a real hash of a password nobody knows, as the desktop account has');
      assert.equal((await login('pp-kid')).statusCode, 401);
      const listed = await kindOf(res.json().id);
      assert.equal(listed.kind, 'open');
      assert.equal(listed.managed_by, admin);
      assert.equal(listed.auth_kind, undefined, 'Members reads the kind, not the columns it is made from');
    });

    await t.test('a profile that opens at home is never an admin, whichever way it is asked for', async () => {
      // Reintroduce by dropping profileRefusal's first rule: the database's check answers instead, a 500.
      const r1 = await make({ username: 'pp-open-admin', role: 'admin', localOpen: true, password: PASSWORD });
      assert.equal(r1.statusCode, 400);
      assert.equal(r1.json().error, 'local_open_admin');
      const kid = (await make({ username: 'pp-kid2', localOpen: true })).json().id;
      assert.equal((await patch(kid, { role: 'admin' })).json().error, 'local_open_admin');
      const other = (await make({ username: 'pp-admin2', role: 'admin', password: PASSWORD })).json().id;
      assert.equal((await patch(other, { localOpen: true })).json().error, 'local_open_admin');
      // Demoted and opened at home in one request: one statement, so the check never sees an admin that opens at home.
      const both = await patch(other, { role: 'user', localOpen: true });
      assert.equal(both.statusCode, 200, both.body);
      assert.equal((await kindOf(other)).kind, 'hybrid');
    });

    await t.test('every account keeps a way in', async () => {
      const none = await make({ username: 'pp-nothing' });
      assert.equal(none.statusCode, 400);
      assert.equal(none.json().error, 'no_way_in');
      const pw = (await make({ username: 'pp-pw', password: PASSWORD })).json().id;
      assert.equal((await patch(pw, { removePassword: true })).json().error, 'no_way_in');
      assert.equal((await patch(pw, { removePassword: true, password: PASSWORD })).statusCode, 400, 'take it away and set it at once');
      const open = await patch(pw, { removePassword: true, localOpen: true });
      assert.equal(open.statusCode, 200, open.body);
      assert.equal((await kindOf(pw)).kind, 'open');
      assert.equal((await login('pp-pw')).statusCode, 401, 'the password it had no longer signs in');
    });

    await t.test('a password taken away takes its tokens: an API or OPDS token opens the library from anywhere', async () => {
      const id = (await make({ username: 'pp-tokens', password: PASSWORD })).json().id;
      const api = await auth.issueApiToken(id, 'reader', ['read'], null);
      await auth.issueOpdsToken(id);
      assert.ok(await auth.resolveApiToken(api.token), 'precondition: the token works');
      assert.equal((await patch(id, { removePassword: true, localOpen: true })).statusCode, 200);
      assert.equal(await auth.resolveApiToken(api.token), null, 'the API token outlived the password');
      assert.equal((await one<{ n: number }>('SELECT count(*)::int AS n FROM opds_tokens WHERE user_id = $1', [id]))!.n, 0,
        'the OPDS token outlived the password');
      // Still linked to the provider, the account keeps a credential, and so its tokens.
      const sso = (await make({ username: 'pp-sso-tokens', password: PASSWORD })).json().id;
      await q(`UPDATE users SET oidc_issuer = 'https://idp.example', oidc_sub = 'pp-sso-tokens' WHERE id = $1`, [sso]);
      const kept = await auth.issueApiToken(sso, 'reader', ['read'], null);
      assert.equal((await patch(sso, { removePassword: true })).statusCode, 200);
      assert.ok(await auth.resolveApiToken(kept.token), 'a token of an account the provider still signs in');
    });

    await t.test('conversions: open to hybrid to password, each ending the profile\'s sessions', async () => {
      const id = (await make({ username: 'pp-grows', localOpen: true })).json().id;
      const token = await auth.issueRefreshToken(id, { via: 'password' });
      assert.equal((await patch(id, { password: PASSWORD })).statusCode, 200);
      assert.equal((await kindOf(id)).kind, 'hybrid');
      assert.equal((await one<{ r: boolean }>('SELECT revoked_at IS NOT NULL AS r FROM refresh_tokens WHERE token_hash = $1', [sha(token)]))!.r, true);
      assert.equal((await login('pp-grows')).statusCode, 200, 'the hybrid signs in with its password');
      const token2 = await auth.issueRefreshToken(id, { via: 'password' });
      assert.equal((await patch(id, { localOpen: false })).statusCode, 200);
      assert.equal((await kindOf(id)).kind, 'password');
      assert.equal((await one<{ r: boolean }>('SELECT revoked_at IS NOT NULL AS r FROM refresh_tokens WHERE token_hash = $1', [sha(token2)]))!.r, true,
        'a profile that no longer opens at home kept the sessions it had');
    });

    await t.test('SSO-only mode: Members makes a profile without a password, and the start-up warning does not count it', async () => {
      // The one account SSO-only mode lets Members make, since it has no password and opens through a guardian the
      // provider signed in; and it is no account that "cannot sign in" for want of a link.
      const { authModeWarnings } = await import('../src/lib/authMode');
      const before = process.env.AUTH_MODE;
      process.env.AUTH_MODE = 'oidc-only';
      try {
        // The warning names ten at most, and this database is shared: the count is what is compared.
        const unlinked = async () => Number((await authModeWarnings()).join(' ').match(/(\d+) accounts? ha(?:s|ve) no/)?.[1] ?? 0);
        const count = await unlinked();
        assert.ok(count >= 1, 'precondition: pp-admin has no link');
        assert.equal((await make({ username: 'pp-sso-pw', password: PASSWORD })).statusCode, 403);
        assert.equal((await make({ username: 'pp-sso-hybrid', password: PASSWORD, localOpen: true })).statusCode, 403);
        const open = await make({ username: 'pp-sso-kid', localOpen: true });
        assert.equal(open.statusCode, 200, open.body);
        assert.equal(await unlinked(), count, 'a profile without a password was counted as an account that cannot sign in');
      } finally {
        if (before === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = before;
      }
    });

    await t.test('a profile is managed by an account that signs in with a credential of its own', async () => {
      const kid = (await make({ username: 'pp-kid3', localOpen: true })).json().id;
      const r = await make({ username: 'pp-kid4', localOpen: true, managedBy: kid });
      assert.equal(r.statusCode, 400);
      assert.equal(r.json().error, 'bad_manager');
      assert.equal((await patch(kid, { managedBy: kid })).json().error, 'bad_manager', 'nobody manages themselves');
    });
  } finally {
    await q('DELETE FROM audit_log WHERE user_id = $1 OR username LIKE $2', [admin, `${PREFIX}%`]).catch(() => {});
    await q('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]).catch(() => {});
    await app.close();
  }
});
