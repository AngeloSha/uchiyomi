// First-run setup makes one admin, however many setups arrive at once (v0.77.1).
//
// POST /api/setup counted the accounts and then made the admin, with nothing between the two, so two setups at once --
// someone on the network racing the owner on a fresh install -- could both find none and both make one. The count and
// the insert now run under firstAdmin's advisory lock (6301), the one an SSO-only server's first sign-in takes, and the
// test holds the window between them open with the same seam (_setFirstAdminPause), so the two setups meet inside it
// every run rather than once in a while.
//
// A database of this file's own: the case under test is a server with no account at all.
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const PASSWORD = 'first-admin-passw0rd';

let DBNAME = '';
let q: any, one: any, pool: any;

before(async () => {
  if (!DSN) return;
  const { Client } = await import('pg');
  const admin = new Client({ connectionString: DSN });
  await admin.connect();
  DBNAME = `${decodeURIComponent(new URL(DSN).pathname.slice(1))}_setup`;
  await admin.query(`DROP DATABASE IF EXISTS "${DBNAME}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${DBNAME}"`);
  await admin.end();
  const url = new URL(DSN);
  url.pathname = `/${DBNAME}`;
  process.env.DATABASE_URL = url.toString();
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UCHIYOMI_PING_URL = '';
  delete process.env.AUTH_MODE;
  delete process.env.INITIAL_USER_PASSWORD_HASH_B64;
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q, one, pool } = (await import('../src/lib/db')) as any);
});

after(async () => {
  if (!DSN) return;
  await pool?.end();
  const { Client } = await import('pg');
  const admin = new Client({ connectionString: DSN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${DBNAME}" WITH (FORCE)`).catch(() => {});
  await admin.end();
});

async function server() {
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/auth')).default);
  await app.ready();
  return app;
}
const setup = (app: any, username: string) => app.inject({ method: 'POST', url: '/api/setup', payload: { username, password: PASSWORD } });
const count = async (where = 'true') => Number((await one(`SELECT count(*)::int AS c FROM users WHERE ${where}`)).c);

test('two setups at once make one admin', { skip }, async () => {
  await q('TRUNCATE users CASCADE');
  const app = await server();
  // The window between counting the accounts and making the admin, held open so the two meet inside it every run.
  const { _setFirstAdminPause } = await import('../src/routes/auth');
  _setFirstAdminPause(300);
  try {
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/setup/status' })).json(), { needsSetup: true }, 'PREMISE: a new server');
    // Reintroduce by checking outside the lock (drop the advisory lock in /api/setup, routes/auth.ts): both are 200, and
    // the server has two admins -- one of them whoever raced the owner.
    const both = await Promise.all([setup(app, 'owner'), setup(app, 'racer')]);
    assert.deepEqual(both.map((r) => r.statusCode).sort(), [200, 403], `two setups answered ${both.map((r) => r.statusCode)}`);
    assert.equal(await count(), 1, 'two setups at once made two accounts');
    assert.equal(await count(`role = 'admin'`), 1);
    const refused = both.find((r) => r.statusCode === 403)!;
    assert.equal(refused.json().error, 'already_configured');
    // The one that won is a signed-in admin, as a setup always was.
    const won = both.find((r) => r.statusCode === 200)!;
    assert.equal(won.json().user.role, 'admin');
    assert.ok(won.json().accessToken);
  } finally {
    _setFirstAdminPause(0);
    await app.close();
  }
});

test('setup stays closed once the server has an account', { skip }, async () => {
  const app = await server();
  try {
    const had = await count();
    assert.ok(had >= 1, 'PREMISE: the server is set up');
    const late = await setup(app, 'latecomer');
    assert.equal(late.statusCode, 403, late.body);
    assert.equal(late.json().error, 'already_configured');
    assert.equal(await count(), had);
  } finally {
    await app.close();
  }
});
