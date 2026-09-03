// The "Run now" button runs the same sweep the schedule does, and is now treated the same way.
//
// server.ts's tick set `runtime.updating` around runUpdateAll, stored the result, and logged one summary
// line. The admin route called runUpdateAll bare, with a `.then` that stored the result and a
// `.catch(() => {})`. So a sweep started from the panel:
//
//   - reported `running: false` from GET /api/admin/tasks for its whole duration (measured live on
//     2026-09-03: well over ten minutes, `lastResult` still the night before's), so the button stayed
//     enabled and the panel looked idle;
//   - wrote nothing to the log when it finished, and nothing at all if it threw;
//   - was invisible to the tick's overlap guard, which is `runtime.updating` and nothing else, so the
//     scheduled sweep could start on top of it.
//
// Both paths now go through runSweep. This file drives the route for real, with a source whose listing
// blocks until the test lets go, so "in flight" is a state the test holds rather than a race it hopes to win.
//
// Reintroduce by putting the bare `runUpdateAll({ maxNew: 10 }).then(...)` back in routes/admin.ts: the
// first assertion fails (the route returns with `updating` still false), and so does the refusal.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-sweep-'));
  process.env.DL_ROOT = ROOT;
  process.env.MIN_FREE_GB = '0'; // the disk floor belongs to diskGuard.test.ts
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_sweep';
const SRC = 'sweep-gate';
const SERIES = 's_sweep_gate';
const SUMMARY = /^updater: \+\d+ chapters, visited \d+ of \d+ series/;

/** Everything Fastify insists a logger has, keeping what the sweep says so the test can read it back. */
function capturingLogger() {
  const lines: { level: string; msg: unknown }[] = [];
  const at = (level: string) => (msg: unknown) => { lines.push({ level, msg }); };
  const logger: any = { info: at('info'), warn: at('warn'), error: at('error'), fatal: at('fatal'), debug() {}, trace() {} };
  logger.child = () => logger;
  return { logger, lines };
}

async function until(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`gave up waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runtime } = await import('../src/lib/runtime');
  const { registerAdapter } = await import('../src/lib/sources');
  const adminRoutes = (await import('../src/routes/admin')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();

  // A source whose listing waits for the test. Nothing else about it matters: it lists nothing, so once
  // released the series is one quiet, healthy visit.
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let listed = 0;
  registerAdapter({
    id: SRC, name: SRC,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: SRC, title: SRC }; },
    async listChapters() { listed++; await gate; return []; },
    async getPageUrls() { return []; },
    async latest() { return []; },
  } as any);

  await q(`DELETE FROM users WHERE username = 'sweep-admin'`).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [SERIES]).catch(() => {});
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Sweep',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
           VALUES ($1,'T!sweep',$1,$1,0,$2,$3,$4,true)`, [SERIES, LIB, SRC, `${SRC}-1`]);
  const admin = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ('sweep-admin','sweep-admin','x','admin','password') RETURNING id`))[0].id;

  const { logger, lines } = capturingLogger();
  const app = Fastify({ loggerInstance: logger });
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.ready();
  const auth = { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` };

  return { q, app, auth, runtime, lines, open: () => release(), listed: () => listed };
}

async function teardown(app: any, q: any) {
  await app.close();
  await q('DELETE FROM lib_series WHERE id = $1', [SERIES]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC]).catch(() => {});
  await q(`DELETE FROM users WHERE username = 'sweep-admin'`).catch(() => {});
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
}

test('a sweep started from the admin panel is the sweep', { skip }, async (t) => {
  const { q, app, auth, runtime, lines, open, listed } = await setup();
  const task = async () => (await app.inject({ method: 'GET', url: '/api/admin/tasks', headers: auth }))
    .json().content.find((x: any) => x.id === 'update');
  const start = async () => (await app.inject({ method: 'POST', url: '/api/admin/tasks/update/run', headers: auth })).json();
  const summaries = () => lines.filter((l) => typeof l.msg === 'string' && SUMMARY.test(l.msg));

  try {
    assert.equal(runtime.updating, false, 'nothing is running before the test starts');
    const before = Date.now();

    await t.test('THE REGRESSION: it is marked running from the moment it starts', async () => {
      assert.deepEqual(await start(), { ok: true, started: true });
      assert.equal(runtime.updating, true, 'the route returned without marking the sweep as running');
      assert.equal((await task()).running, true, 'so the panel showed a manual sweep as idle for its whole duration');
    });

    await t.test('a second start is refused while it runs, as the fingerprint task already was', async () => {
      assert.deepEqual(await start(), { ok: false, error: 'busy' });
      assert.equal(listed(), 1, 'refused means not started: the source has been asked exactly once');
    });

    await t.test('the scheduled tick reads the same flag, so it cannot start on top', async () => {
      const { runSweep } = await import('../src/lib/updater');
      assert.equal(runSweep({ maxNew: 5 }, app.log), false);
      assert.equal(listed(), 1);
    });

    await t.test('when it ends, the result is kept and one line is logged', async () => {
      assert.equal(summaries().length, 0, 'nothing has been said yet');
      open();
      await until(() => !runtime.updating, 'the sweep to finish');

      assert.ok(runtime.lastUpdate >= before, 'last run is this run');
      const r = runtime.lastUpdateResult;
      assert.ok(r, 'the result was kept');
      assert.ok((r.visited ?? 0) >= 1, 'and says what was visited');
      assert.equal(r.stopped, undefined, 'a sweep that finished is not one the budget cut short');
      assert.equal(typeof r.healthy, 'boolean');
      const shown = await task();
      assert.equal(shown.running, false);
      assert.ok(shown.lastResult && shown.lastResult.visited >= 1, 'and the panel can show it');
      assert.equal(summaries().length, 1, 'one summary line, the same one the schedule writes');
    });

    await t.test('and the next start is accepted again', async () => {
      assert.deepEqual(await start(), { ok: true, started: true });
      await until(() => !runtime.updating, 'the second sweep to finish');
      assert.equal(listed(), 2);
      assert.equal(summaries().length, 2);
    });
  } finally {
    await teardown(app, q);
  }
});

/**
 * No fake source can make the SWEEP throw: a source that throws is a per-series `source_error`, which is
 * the sweep working. This is the "database went away" case, through the seam runSweep exposes for it.
 *
 * Reintroduce by dropping the catch in runSweep: the promise rejects instead of resolving null, and nothing
 * reaches the log. By dropping the finally: `updating` stays true and every later start is refused.
 */
test('a sweep that throws is logged, cleared, and lets the next one run', { skip }, async () => {
  const { runSweep } = await import('../src/lib/updater');
  const { runtime } = await import('../src/lib/runtime');
  const { logger, lines } = capturingLogger();
  const boom = new Error('database went away');
  const before = Date.now();

  const run = runSweep({}, logger, async () => { throw boom; });
  assert.notEqual(run, false, 'it started');
  assert.equal(runtime.updating, true);
  assert.equal(await run, null, 'a throw resolves to null: no caller has to catch it, so none can swallow it');
  assert.equal(runtime.updating, false, 'the flag is released, so the next sweep is not refused forever');
  assert.ok(lines.some((l) => l.level === 'error' && l.msg === boom), 'the reason is in the log, not swallowed');
  assert.ok(runtime.lastUpdate >= before, 'last run moved to now...');
  assert.equal(runtime.lastUpdateResult, null, "...and the previous run's result does not pose as this one's");
});
