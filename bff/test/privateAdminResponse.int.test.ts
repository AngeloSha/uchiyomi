// The admin response filter (lib/privateAdmin.ts privateAdminResponse), mounted as server.ts mounts it.
//
// It rebuilds every /api/admin payload to drop other accounts' private rows. Rebuilding a Date from its entries made
// it `{}`, so every timestamp an admin screen shows read "Invalid Date" from v0.107.0 on: removed series, members'
// last active, sessions, the audit log, import batches.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const USER = 'par-admin';
let app: any, q: any;

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q?.('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
});

test('admin timestamps reach the page as dates, and other accounts\' private rows still do not', { skip }, async () => {
  ({ q } = await import('../src/lib/db'));
  await (await import('../src/lib/migrate')).migrate();
  await q('DELETE FROM users WHERE username = $1', [USER]);
  const uid = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','admin','password') RETURNING id`, [USER]))[0].id;
  const { privateAdminResponse } = await import('../src/lib/privateAdmin');
  const at = new Date('2026-11-12T19:47:00.000Z');
  app = (await import('fastify')).default();
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  app.addHook('onRequest', async (req: any) => { await req.jwtVerify(); });
  app.addHook('preSerialization', privateAdminResponse);
  app.get('/api/admin/test-dates', async () => ({
    deleted_at: at,
    rows: [{ id: 'r1', last_active: at, nested: { when: at } }, { id: 'r2', last_active: null }],
    // Another account's private row: the filter's job, which must survive the fix.
    others: [{ id: 'p1', is_private: true, owner_user_id: '11111111-2222-4333-8444-555555555555', title: 'Not yours' }],
  }));
  await app.ready();
  const r = await app.inject({ method: 'GET', url: '/api/admin/test-dates', headers: { authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'admin' })}` } });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.deleted_at, at.toISOString(), 'a date went out as {}');
  assert.equal(body.rows[0].last_active, at.toISOString());
  assert.equal(body.rows[0].nested.when, at.toISOString());
  assert.equal(body.rows[1].last_active, null);
  assert.deepEqual(body.others, [], 'another account\'s private row was sent to this admin');
});
