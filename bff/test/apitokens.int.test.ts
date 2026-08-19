// Personal API tokens, exercised through a real Fastify instance using the real `authenticate` and
// `requireAdmin` preHandlers.
//
// These are tested end-to-end rather than at the function level because the risk here is not "does the
// helper work" but "did adding a second way to authenticate weaken the first one". So the JWT path is
// asserted alongside the token path, including the case that matters most: an admin's automation token
// must not inherit admin powers just because its owner is an admin.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const auth = await import('../src/lib/auth');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;

  await migrate();
  await q(`DELETE FROM users WHERE username IN ($1,$2)`, ['tok-admin', 'tok-user']);
  const mk = async (username: string, role: string) => {
    const r = await q<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$1,'x',$2) RETURNING id`,
      [username, role],
    );
    return r[0].id;
  };
  const adminId = await mk('tok-admin', 'admin');
  const userId = await mk('tok-user', 'user');

  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  // three routes covering the axes that matter: read, write, and admin-only
  app.get('/api/who', { preHandler: auth.authenticate }, async (req) => ({ sub: auth.userIdOf(req), role: auth.roleOf(req) }));
  app.post('/api/write', { preHandler: auth.authenticate }, async () => ({ ok: true }));
  app.get('/api/admin/thing', { preHandler: [auth.authenticate, auth.requireAdmin] }, async () => ({ ok: true }));
  await app.ready();

  return { app, auth, q, adminId, userId };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

test('personal API tokens', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async (t) => {
  const { app, auth, q, adminId, userId } = await setup();

  await t.test('a read token authenticates as its owner', async () => {
    const { token } = await auth.issueApiToken(userId, 'reader', ['read'], null);
    const r = await app.inject({ method: 'GET', url: '/api/who', headers: bearer(token) });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().sub, userId);
  });

  await t.test('a read token cannot mutate', async () => {
    const { token } = await auth.issueApiToken(userId, 'reader2', ['read'], null);
    const r = await app.inject({ method: 'POST', url: '/api/write', headers: bearer(token) });
    assert.equal(r.statusCode, 403);
    assert.match(r.json().message, /read-only/i);
  });

  await t.test('a write token can mutate', async () => {
    const { token } = await auth.issueApiToken(userId, 'writer', ['read', 'write'], null);
    assert.equal((await app.inject({ method: 'POST', url: '/api/write', headers: bearer(token) })).statusCode, 200);
  });

  await t.test("an admin's token without the admin scope cannot reach the admin API", async () => {
    // the point of scoping: a token left in a cron job must not be able to manage the server
    const { token } = await auth.issueApiToken(adminId, 'cron', ['read', 'write'], null);
    const r = await app.inject({ method: 'GET', url: '/api/admin/thing', headers: bearer(token) });
    assert.equal(r.statusCode, 403);
    assert.match(r.json().message, /admin scope/i);
  });

  await t.test('an admin-scoped token can', async () => {
    const { token } = await auth.issueApiToken(adminId, 'ops', ['read', 'admin'], null);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/thing', headers: bearer(token) })).statusCode, 200);
  });

  await t.test('a non-admin cannot be escalated by an admin-scoped token', async () => {
    // scope alone must never grant the role; the underlying account still has to be an admin
    const { token } = await auth.issueApiToken(userId, 'sneaky', ['read', 'admin'], null);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/thing', headers: bearer(token) })).statusCode, 403);
  });

  await t.test('an expired token is rejected', async () => {
    const { token } = await auth.issueApiToken(userId, 'stale', ['read'], new Date(Date.now() - 1000));
    assert.equal((await app.inject({ method: 'GET', url: '/api/who', headers: bearer(token) })).statusCode, 401);
  });

  await t.test('a revoked token stops working immediately', async () => {
    const { id, token } = await auth.issueApiToken(userId, 'doomed', ['read'], null);
    assert.equal((await app.inject({ method: 'GET', url: '/api/who', headers: bearer(token) })).statusCode, 200);
    assert.equal(await auth.revokeApiToken(userId, id), true);
    assert.equal((await app.inject({ method: 'GET', url: '/api/who', headers: bearer(token) })).statusCode, 401);
  });

  await t.test('one user cannot revoke another user\'s token', async () => {
    const { id } = await auth.issueApiToken(adminId, 'not-yours', ['read'], null);
    assert.equal(await auth.revokeApiToken(userId, id), false);
  });

  await t.test('garbage and unknown tokens are rejected', async () => {
    for (const bad of ['uy_nonsense', 'uy_', 'Bearer', 'not-a-token']) {
      const r = await app.inject({ method: 'GET', url: '/api/who', headers: bearer(bad) });
      assert.equal(r.statusCode, 401, `expected 401 for ${bad}`);
    }
  });

  await t.test('the JWT session path still works and is unrestricted by scopes', async () => {
    // the regression that would matter most: adding tokens must not have changed normal logins
    const jwtToken = app.jwt.sign({ sub: adminId, role: 'admin' }, { expiresIn: 60 });
    assert.equal((await app.inject({ method: 'GET', url: '/api/who', headers: bearer(jwtToken) })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/write', headers: bearer(jwtToken) })).statusCode, 200);
    // a session login has no token scopes, so requireAdmin must let it through on role alone
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/thing', headers: bearer(jwtToken) })).statusCode, 200);
  });

  await t.test('no credentials is still a 401', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/who' })).statusCode, 401);
  });

  await t.test('listing shows tokens but never the secret', async () => {
    const rows = await auth.listApiTokens(userId);
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.ok(!JSON.stringify(r).includes('uy_'), 'a raw token leaked into the listing');
      assert.ok(r.name && r.scopes.length);
    }
  });

  await app.close();
  await q(`DELETE FROM users WHERE username IN ($1,$2)`, ['tok-admin', 'tok-user']);
});
