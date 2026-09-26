// #101: the Health report boiled down for the header (lib/healthSummary.ts), and the route that serves it
// without running the checks.
//
// Skipped automatically unless TEST_DATABASE_URL is set, except the pure tests.
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const check = (id: string, status: 'ok' | 'warn' | 'problem', summary = `${id} says ${status}`) =>
  ({ id, title: id.toUpperCase(), status, summary, items: [] });
const report = (...checks: any[]) => ({ generatedAt: '2026-09-26T00:00:00.000Z', checks });

test('the headline is the worst check, and the key follows WHICH checks found something, not their counts', async () => {
  const { summarise } = await import('../src/lib/healthSummary');
  const a = summarise(report(check('sources', 'warn', '2 sources failing'), check('solver', 'problem', 'solver down'), check('gaps', 'ok')));
  assert.equal(a.worst, 'problem');
  assert.equal(a.count, 2);
  assert.equal(a.headline, 'SOLVER: solver down', 'the worst check leads, whatever order the report came in');

  // Same checks, different numbers: the same problem. Reintroduce by hashing the summaries: the key moves and a
  // dismissed banner comes back every time a count changes.
  const b = summarise(report(check('sources', 'warn', '3 sources failing'), check('solver', 'problem', 'still down'), check('gaps', 'ok')));
  assert.equal(b.key, a.key);
  // A check getting worse, or a new one finding something, is news.
  assert.notEqual(summarise(report(check('sources', 'problem'), check('solver', 'problem'))).key, a.key);
  assert.notEqual(summarise(report(check('sources', 'warn'), check('solver', 'problem'), check('gaps', 'warn'))).key, a.key);

  const clean = summarise(report(check('gaps', 'ok')));
  assert.deepEqual([clean.worst, clean.count, clean.headline, clean.key], ['ok', 0, null, '']);
});

test('the Health route stores what it found, and the summary route answers from that without running checks', { skip }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  await migrate();
  await q('UPDATE server_settings SET health_summary = NULL WHERE id = 1');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  await q(`DELETE FROM users WHERE username = 'hs-admin'`);
  const admin = (await q<{ id: string }>(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                                           VALUES ('hs-admin','hs-admin','x','admin','password') RETURNING id`))[0].id;
  const as = { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` };
  try {
    const before = await app.inject({ method: 'GET', url: '/api/admin/health/summary', headers: as });
    assert.equal(before.statusCode, 200);
    assert.equal(before.json().summary, null, 'nothing stored yet: null, not an invented "all clear"');

    const full = await app.inject({ method: 'GET', url: '/api/admin/health', headers: as });
    assert.equal(full.statusCode, 200);
    const after = (await app.inject({ method: 'GET', url: '/api/admin/health/summary', headers: as })).json().summary;
    // Reintroduce by dropping storeHealthSummary from the Health route: this stays null.
    assert.ok(after, 'opening the Health page did not refresh what the header shows');
    assert.equal(after.at, full.json().generatedAt);
    assert.equal(after.count, full.json().checks.filter((c: any) => c.status !== 'ok').length);

    // Stored, not computed: a planted summary comes back exactly, however the library looks right now.
    await q(`UPDATE server_settings SET health_summary = '{"at":"x","worst":"warn","count":7,"headline":"planted","key":"p","checks":[]}' WHERE id = 1`);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/health/summary', headers: as })).json().summary.headline, 'planted');

    const member = await app.inject({ method: 'GET', url: '/api/admin/health/summary', headers: { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'user' })}` } });
    assert.equal(member.statusCode, 403, 'admins only: the text names sources and folders');
  } finally {
    await app.close();
    await q(`DELETE FROM users WHERE username = 'hs-admin'`).catch(() => {});
    await q('UPDATE server_settings SET health_summary = NULL WHERE id = 1').catch(() => {});
  }
});
