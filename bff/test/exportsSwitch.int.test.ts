// Download as zip is an admin's choice (Admin → Settings, server_settings.zip_exports), off by default: packing a series
// spends disk and CPU on the server and hands the whole of it to whoever can see it.
//
// Off, the route refuses with 403 `exports_off` and says `enabled: false` so a client does not offer it; on, a request
// gets as far as the work (here a series that does not exist, which is a 404, never a 403).
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const USER = 'zip-switch-user';

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const downloadRoutes = (await import('../src/routes/downloads')).default;
  await migrate();
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  const u = await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ($1,$1,'x','user','password') RETURNING id`, [USER]);
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(downloadRoutes);
  await app.ready();
  return { app, q, auth: { authorization: `Bearer ${app.jwt.sign({ sub: u[0].id, role: 'user' })}` } };
}

after(async () => {
  if (!DSN) return;
  const { q } = await import('../src/lib/db');
  await q('UPDATE server_settings SET zip_exports = false WHERE id = 1').catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
});

test('Download as zip is off by default: no export starts, and the client is told not to offer it', { skip }, async () => {
  const { app, q, auth } = await setup();
  try {
    await q('INSERT INTO server_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
    await q('UPDATE server_settings SET zip_exports = false WHERE id = 1');
    const list = await app.inject({ method: 'GET', url: '/api/exports', headers: auth });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(JSON.parse(list.body).enabled, false);
    const r = await app.inject({ method: 'POST', url: '/api/exports', headers: auth, payload: { seriesId: 's_nope' } });
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(JSON.parse(r.body).error, 'exports_off');
  } finally { await app.close(); }
});

test('with an admin\'s switch on, an export request is let through to the work', { skip }, async () => {
  // Reintroduce by dropping the zipExportsOn() check in POST /api/exports: the first test fails; by always refusing: this one.
  const { app, q, auth } = await setup();
  try {
    await q('UPDATE server_settings SET zip_exports = true WHERE id = 1');
    const list = await app.inject({ method: 'GET', url: '/api/exports', headers: auth });
    assert.equal(JSON.parse(list.body).enabled, true);
    const r = await app.inject({ method: 'POST', url: '/api/exports', headers: auth, payload: { seriesId: 's_does_not_exist' } });
    assert.equal(r.statusCode, 404, r.body);
  } finally { await app.close(); }
});
