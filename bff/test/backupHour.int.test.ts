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
  await q('UPDATE server_settings SET backup_hour = 3, auto_follow_on_failure = true WHERE id = 1');
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
  await q('UPDATE server_settings SET backup_hour = 3, backup_enabled = true, backup_keep = NULL, auto_follow_on_failure = true WHERE id = 1').catch(() => {});
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

test('the failed-chapter source hunt switch round-trips through admin settings', { skip }, async () => {
  const { app, patch, get, q } = await setup();
  try {
    // Reintroduce by omitting auto_follow_on_failure from SETTINGS_COLS: PATCH writes the value but neither
    // its answer nor the next GET can tell the settings page what is actually active.
    const off = await patch({ autoFollowOnFailure: false });
    assert.equal(off.statusCode, 200, off.body);
    assert.equal(off.json().auto_follow_on_failure, false);
    assert.equal((await get()).auto_follow_on_failure, false);
    assert.equal((await q('SELECT auto_follow_on_failure AS value FROM server_settings WHERE id = 1'))[0]?.value, false);

    // An unrelated save must leave the switch alone, and the shipped default is restored through the same
    // camelCase PATCH contract the web uses.
    await patch({ updaterHours: 6 });
    assert.equal((await get()).auto_follow_on_failure, false);
    const on = await patch({ autoFollowOnFailure: true });
    assert.equal(on.statusCode, 200, on.body);
    assert.equal(on.json().auto_follow_on_failure, true);
  } finally {
    await teardown(app, q);
  }
});

test('the nightly backup switch and the number to keep round-trip, and reach the Tasks list (v0.61.1, #199)', { skip }, async () => {
  const { app, auth, patch, get, q, runtime } = await setup();
  const { env } = await import('../src/env');
  let rearmed = 0;
  runtime.rearmBackup = () => { rearmed += 1; };
  const backupTask = async () =>
    (await app.inject({ method: 'GET', url: '/api/admin/tasks', headers: auth })).json().content.find((x: any) => x.id === 'backup');
  try {
    await q('UPDATE server_settings SET backup_enabled = true, backup_keep = NULL WHERE id = 1');
    // Nothing saved yet: the page shows what the next run will keep, BACKUP_KEEP, not a blank or a guess.
    // Reintroduce by returning the bare column: GET says null and the field shows 14 whatever the variable says.
    assert.equal((await get()).backup_keep, env.BACKUP_KEEP);
    assert.equal((await get()).backup_enabled, true, 'on by default');

    // Off: stored, answered back, said on the Tasks row, and the scheduler told.
    // Reintroduce by dropping backupEnabled from the zod schema: the PATCH is accepted and nothing changes.
    const off = await patch({ backupEnabled: false });
    assert.equal(off.statusCode, 200, off.body);
    assert.equal(off.json().backup_enabled, false);
    assert.equal((await get()).backup_enabled, false);
    assert.equal(rearmed, 1, 'switching it did not re-arm the scheduler');
    const task = await backupTask();
    assert.equal(task?.schedule, 'switched off · on demand', `the Tasks list shows ${task?.schedule}`);
    assert.equal(task?.scheduleKey, 'switched off · on demand', 'the page has no key to translate it by');

    // The count: stored as given and refused outside 1-365, and saving it re-arms nothing (it deletes nothing either).
    const keep = await patch({ backupKeep: 3 });
    assert.equal(keep.statusCode, 200, keep.body);
    assert.equal(keep.json().backup_keep, 3);
    assert.equal((await q('SELECT backup_keep AS k FROM server_settings WHERE id = 1'))[0]?.k, 3);
    for (const bad of [0, 366, 2.5, -1]) {
      const rr = await patch({ backupKeep: bad });
      assert.equal(rr.statusCode, 400, `backupKeep ${bad} was accepted`);
    }
    assert.equal((await get()).backup_keep, 3, 'a refused value was written anyway');
    assert.equal(rearmed, 1, 'the count re-armed the scheduler');

    // An unrelated save leaves both alone; back on, the row says the hour again.
    await patch({ updaterHours: 6 });
    assert.equal((await get()).backup_enabled, false);
    const on = await patch({ backupEnabled: true });
    assert.equal(on.json().backup_enabled, true);
    assert.equal(rearmed, 2);
    assert.equal((await backupTask())?.schedule, 'daily at 03:00');
  } finally {
    runtime.rearmBackup = null;
    await teardown(app, q);
  }
});
