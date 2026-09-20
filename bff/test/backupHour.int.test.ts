// The backup hour, driven over HTTP against a real database.
//
// backupHour.test.ts reads the code and checks the re-arm is still wired. This proves the part a source scan
// cannot: that PATCH /api/admin/settings really writes the column, that GET answers it back, that the Tasks
// list -- which is where an admin goes to check -- reads the same column, and that the two values outside the
// day are refused rather than accepted and quietly clamped by the scheduler.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';
// STATICALLY imported: `await import('zod')` resolves to a different module instance than the routes' own,
// so `instanceof ZodError` is false in the handler below and a refused body reads 500 instead of 400
// (extensionMonitor.int.test.ts says the same, and it was measured).
import { ZodError } from 'zod';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const USER = 'bh-admin';

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runtime } = await import('../src/lib/runtime');
  const adminRoutes = (await import('../src/routes/admin')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();

  await q(`DELETE FROM users WHERE username = $1`, [USER]).catch(() => {});
  await q('UPDATE server_settings SET backup_hour = 3 WHERE id = 1');
  const admin = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ($1,$1,'x','admin','password') RETURNING id`, [USER]))[0].id;

  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  // The same handler server.ts installs, before the routes, so a refused schema answers 400 here as it
  // does on the real server rather than a bare 500 from the harness.
  app.setErrorHandler((err: any, req: any, reply: any) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'bad_request', fields: err.issues.map((i: any) => i.path.join('.')).filter(Boolean) });
    }
    const status = err.statusCode || 500;
    return reply.code(status).send({ error: status >= 500 ? 'internal' : err.message || 'error' });
  });
  await app.register(adminRoutes);
  await app.ready();
  const auth = { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` };
  const patch = (body: any) => app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: auth, payload: body });
  const get = async () => (await app.inject({ method: 'GET', url: '/api/admin/settings', headers: auth })).json();
  return { app, auth, patch, get, q, runtime };
}

async function teardown(app: any, q: any) {
  await app.close();
  await q('UPDATE server_settings SET backup_hour = 3 WHERE id = 1').catch(() => {});
  await q(`DELETE FROM users WHERE username = $1`, [USER]).catch(() => {});
}

test('the backup hour round-trips through settings and reaches the Tasks list', { skip }, async () => {
  const { app, auth, patch, get, q, runtime } = await setup();
  // Stand in for the scheduler server.ts installs: the route must call it, and this is the only way to see
  // that it did without booting the whole server.
  let rearmed = 0;
  runtime.rearmBackup = () => { rearmed += 1; };
  try {
    // Reintroduce by dropping backupHour from the settings zod schema: the PATCH is accepted and silently
    // ignored, so the panel says one hour and the night runs at another.
    const r = await patch({ backupHour: 4 });
    assert.equal(r.statusCode, 200, `PATCH refused: ${r.body}`);
    assert.equal(r.json().backup_hour, 4, 'the PATCH answer does not carry the new hour');
    assert.equal((await get()).backup_hour, 4, 'GET does not answer the hour back');

    // ⚠️ Reintroduce by deleting `runtime.rearmBackup?.()` from the route: everything above still passes,
    // and tonight's backup runs at the old hour.
    assert.equal(rearmed, 1, 'writing the hour did not re-arm the scheduler');

    // The Tasks tab reads the column, not the in-memory timer, so it is the place an admin checks.
    const listed = await app.inject({ method: 'GET', url: '/api/admin/tasks', headers: auth });
    const task = listed.json().content.find((x: any) => x.id === 'backup');
    assert.equal(task?.schedule, 'daily at 04:00', `the Tasks list shows ${task?.schedule}`);

    // A PATCH that does not name the hour must not touch it, and must not re-arm for nothing.
    await patch({ updaterHours: 6 });
    assert.equal((await get()).backup_hour, 4, 'an unrelated PATCH changed the hour');
    assert.equal(rearmed, 1, 'an unrelated PATCH re-armed the backup');

    // Reintroduce by widening .max(23) or dropping .min(0): the scheduler's own guard falls back to 03:00 for
    // the value the API accepted, which is worse than a refusal.
    for (const bad of [24, -1, 3.5]) {
      const rr = await patch({ backupHour: bad });
      assert.equal(rr.statusCode, 400, `backupHour ${bad} was accepted`);
    }
    assert.equal((await get()).backup_hour, 4, 'a refused value was written anyway');
    assert.equal(rearmed, 1, 'a refused value re-armed the scheduler');

    // And back to the shipped default, through the API, so the restore is itself a round-trip.
    await patch({ backupHour: 3 });
    assert.equal((await get()).backup_hour, 3);
    const again = await app.inject({ method: 'GET', url: '/api/admin/tasks', headers: auth });
    assert.equal(again.json().content.find((x: any) => x.id === 'backup')?.schedule, 'daily at 03:00');
  } finally {
    runtime.rearmBackup = null;
    await teardown(app, q);
  }
});
