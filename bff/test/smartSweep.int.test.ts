// Smart update checks (v0.61.0): Admin -> Settings "Smart update checks", off by default. While it is on, the
// SCHEDULED sweep leaves a series that has been quiet a long time for a later sweep -- never longer than three days --
// and asks every series as usual while its next chapter is due (lib/releaseRadar.ts checkEvery / isDue, pinned in
// releaseRadar.test.ts). Nothing a person starts consults it: Run now asks everything, Check now asks at once.
//
// A fake source counts which series it was asked about; the sweep runs for real through runSweep, as the schedule
// runs it, and the routes through Fastify.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-smart-'));
  process.env.DL_ROOT = ROOT;
  process.env.MIN_FREE_GB = '0';
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const SRC_ROOT = join(__dirname, '..', 'src');

const LIB = 'lib_smart';
const SRC = 'smart-src';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Which series the source was asked to list, in order, by series id. */
const asked: string[] = [];
const S = (k: string) => `s_smart_${k}`;
const KEYS = ['quiet', 'never', 'due', 'missing', 'quiet70'];

let q: any, app: any, runtime: any, runSweep: typeof import('../src/lib/updater')['runSweep'];
let listRuns: typeof import('../src/lib/downloadJobs')['listRuns'];
const A: Record<string, string> = {};

/** Everything Fastify insists a logger has, keeping what the sweep says. */
function capturingLogger() {
  const lines: string[] = [];
  const at = () => (msg: unknown) => { lines.push(String(msg)); };
  const logger: any = { info: at(), warn: at(), error: at(), fatal: at(), debug() {}, trace() {} };
  logger.child = () => logger;
  return { logger, lines };
}

/**
 * The five series, as the sweep will find them: each was asked `checkedH` hours ago (null: never), has been silent since
 * `quietD` days ago, and lacks `missing` chapters; `due` gives it a radar whose next chapter is due now.
 *   quiet    asked 4 h ago, silent a year: rests (three days between asks)
 *   never    never asked: asked
 *   due      asked 4 h ago, silent a week, next chapter due today: asked (every sweep while due)
 *   missing  asked 4 h ago, silent a year, two chapters to fetch: asked (every sweep while it lacks some)
 *   quiet70  asked 70 h ago, silent a year: asked (the three days are up, less half an interval)
 */
async function seed() {
  const rows: Record<string, { checkedH: number | null; quietD: number; missing: number }> = {
    quiet: { checkedH: 4, quietD: 365, missing: 0 },
    never: { checkedH: null, quietD: 365, missing: 0 },
    due: { checkedH: 4, quietD: 7, missing: 0 },
    missing: { checkedH: 4, quietD: 365, missing: 2 },
    quiet70: { checkedH: 70, quietD: 365, missing: 0 },
  };
  await q(`DELETE FROM series_radar WHERE series_id = ANY($1)`, [KEYS.map(S)]);
  for (const [k, r] of Object.entries(rows)) {
    await q(`UPDATE lib_series SET source_checked_at = CASE WHEN $2::int IS NULL THEN NULL ELSE now() - make_interval(hours => $2::int) END,
                                   latest_mtime = (extract(epoch FROM now() - make_interval(days => $3)) * 1000)::bigint,
                                   created_at = now() - interval '2 years', source_missing = $4
              WHERE id = $1`, [S(k), r.checkedH, r.quietD, r.missing]);
  }
  await q(`INSERT INTO series_radar (series_id, basis, kind, interval_days, last_at, next_at, due_until, quiet_after)
           VALUES ($1, 'arrival', 'weekly', 7, now() - interval '7 days', now() - interval '2 hours', now() + interval '3 days', now() + interval '14 days')`,
    [S('due')]);
  // Only these take part, and every one is visible: the sweep's own query would otherwise pick up other files' rows.
  await q(`UPDATE lib_series SET auto_update = (id = ANY($1::text[]))`, [KEYS.map(S)]);
  asked.length = 0;
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ runtime } = (await import('../src/lib/runtime')) as any);
  ({ runSweep } = await import('../src/lib/updater'));
  ({ listRuns } = await import('../src/lib/downloadJobs'));
  const { registerAdapter } = await import('../src/lib/sources');
  await migrate();
  registerAdapter({
    id: SRC, name: SRC,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: SRC, title: sid }; },
    // Lists nothing: a visit is a quiet, healthy ask, and the ask is all this file counts.
    async listChapters(sid: string) { asked.push(sid.replace(/-src$/, '')); return []; },
    async getPageUrls() { return []; },
    async latest() { return []; },
  } as any);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1, 'Smart', '/smart') ON CONFLICT (id) DO NOTHING`, [LIB]);
  for (const k of KEYS) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
             VALUES ($1, 'T!smart', $1, $1, 0, $2, $3, $4, true) ON CONFLICT (id) DO NOTHING`, [S(k), LIB, SRC, `${S(k)}-src`]);
  }
  await q(`DELETE FROM users WHERE username = 'smart_admin'`);
  const admin = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                          VALUES ('smart_admin', 'A', 'x', 'admin', 'password') RETURNING id`))[0].id;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify({ loggerInstance: capturingLogger().logger });
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  A.authorization = `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}`;
});

after(async () => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  await q(`UPDATE server_settings SET update_smart = false WHERE id = 1`).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [KEYS.map(S)]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q(`DELETE FROM users WHERE username = 'smart_admin'`).catch(() => {});
  await app?.close();
});

test('the smart checks are off by default, and the switch saves', { skip }, async () => {
  // Reintroduce DEFAULT true on the column: an existing install changes how often its sources are asked on upgrade.
  const settings = async () => (await app.inject({ method: 'GET', url: '/api/admin/settings', headers: A })).json();
  assert.equal((await settings()).update_smart, false);
  const on = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: A, payload: { updateSmart: true } });
  assert.equal(on.statusCode, 200, on.body);
  assert.equal((await settings()).update_smart, true);
  const off = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: A, payload: { updateSmart: false } });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal((await settings()).update_smart, false);
  // Not a boolean: refused (400 through server.ts's ZodError handler, which this bare app does not install), unsaved.
  assert.ok((await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: A, payload: { updateSmart: 'yes' } })).statusCode >= 400);
  assert.equal((await settings()).update_smart, false);
});

test('a smart sweep rests the quiet series that are not due, and asks the rest', { skip }, async () => {
  // Reintroduce by filtering nothing in runUpdateAll: "quiet" is asked, and nothing rests.
  await seed();
  const { logger, lines } = capturingLogger();
  const run = runSweep({ maxNew: 5, smart: { hoursMs: 6 * HOUR } }, logger);
  assert.ok(run, 'the sweep did not start');
  const r = (await run)!;
  assert.deepEqual([...asked].sort(), [S('due'), S('missing'), S('never'), S('quiet70')].sort(), `asked ${asked.join(', ')}`);
  assert.equal(r.rested, 1);
  assert.equal(r.series, 4, 'the series it set out to visit');
  assert.equal(r.outcomes.skipped, 0, 'a rested series is not a skipped one');
  assert.equal(runtime.lastUpdateResult.rested, 1, 'Admin -> Tasks says how many rested');
  assert.equal(listRuns().find((c) => c.kind === 'sweep')?.total, 4, 'the run\'s card counts the due series');
  assert.ok(lines.some((l) => /^updater: \+0 chapters, visited 4 of 4 series \(1 quiet series not due\)$/.test(l)), lines.join(' | '));
  // A sweep without the switch asks everything, the quiet one included, and says nothing of resting.
  await seed();
  const plain = (await runSweep({ maxNew: 5 }, capturingLogger().logger))!;
  assert.equal(asked.length, 5);
  assert.equal(plain.rested, 0);
});

test('Run now asks every series, the quiet ones included', { skip }, async () => {
  // POST /api/admin/update is "Run now" (and so is the Tasks row's): never smart, whatever the switch says.
  await q(`UPDATE server_settings SET update_smart = true WHERE id = 1`);
  try {
    await seed();
    const res = await app.inject({ method: 'POST', url: '/api/admin/update', headers: A, payload: {} });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual([...asked].sort(), KEYS.map(S).sort());
    assert.equal(res.json().rested, 0);
  } finally {
    await q(`UPDATE server_settings SET update_smart = false WHERE id = 1`);
  }
});

test('Check now on a rested series asks at once', { skip }, async () => {
  await q(`UPDATE server_settings SET update_smart = true WHERE id = 1`);
  try {
    await seed();
    const start = await app.inject({ method: 'POST', url: `/api/admin/series/${S('quiet')}/check`, headers: A, payload: {} });
    assert.equal(start.statusCode, 200, start.body);
    let state: any = { running: true };
    for (let i = 0; i < 200 && state.running; i++) {
      await new Promise((res) => setTimeout(res, 50));
      state = (await app.inject({ method: 'GET', url: `/api/admin/series/${S('quiet')}/check`, headers: A })).json();
    }
    assert.deepEqual(asked, [S('quiet')], 'Check now waited for the schedule');
  } finally {
    await q(`UPDATE server_settings SET update_smart = false WHERE id = 1`);
  }
});

test('the scheduled sweep is smart only while the switch is on', () => {
  // A source pin: the tick reads the switch every time it fires and passes `smart` from it and from nothing else.
  // Reintroduce by passing it always (`runSweep({ maxNew: 5, smart: { hoursMs } })`): the second match fails.
  const server = readFileSync(join(SRC_ROOT, 'server.ts'), 'utf8');
  const tick = server.slice(server.indexOf("const s = await pool.query('SELECT updater_hours, update_smart FROM server_settings WHERE id = 1');"),
    server.indexOf('setTimeout(tick, retryIn ||'));
  assert.ok(tick.length > 100, 'the sweep tick moved; update this test');
  assert.match(tick, /const smart = s\.rows\[0\]\?\.update_smart === true \? \{ hoursMs: hours \* 3_600_000 \} : null;/);
  assert.match(tick, /const run = smart \? runSweep\(\{ maxNew: 5, smart \}, app\.log\) : runSweep\(\{ maxNew: 5 \}, app\.log\);/);
  // And no other call of the sweep is handed the schedule: Run now, the Tasks row, the repair's and Fix everything's
  // sweeps. Every call site of runSweep / runUpdateAll in src/, read to its closing parenthesis.
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.ts')) continue;
      const src = readFileSync(full, 'utf8');
      for (const m of src.matchAll(/(?<!function )\b(runSweep|runUpdateAll)\(/g)) {
        let depth = 1;
        let j = m.index! + m[0].length;
        while (j < src.length && depth) { if (src[j] === '(') depth++; else if (src[j] === ')') depth--; j++; }
        if (/\bsmart\b/.test(src.slice(m.index!, j))) offenders.push(`${full.slice(SRC_ROOT.length + 1)}: ${src.slice(m.index!, j).replace(/\s+/g, ' ')}`);
      }
    }
  };
  walk(SRC_ROOT);
  assert.deepEqual(offenders, ['server.ts: runSweep({ maxNew: 5, smart }, app.log)'], 'something besides the schedule passes the smart checks');
});

test('nothing a person starts consults the schedule', () => {
  // updateSeries -- what Check now, Fetch, Fetch newest, Fill, the repair, Fix everything and the slow archive run --
  // never reads the smart checks or the radar's times: only runUpdateAll's own filter does, and only with `smart`.
  // Reintroduce a check inside visitSeries (say `if (!isDue(...)) return nothing(...)`): this fails.
  const updater = readFileSync(join(SRC_ROOT, 'lib', 'updater.ts'), 'utf8');
  const visit = updater.slice(updater.indexOf('export async function updateSeries('), updater.indexOf('export async function runUpdateAll('));
  assert.ok(visit.includes('async function visitSeries('), 'visitSeries moved; update this test');
  for (const word of ['isDue', 'checkEvery', 'smart', 'series_radar', 'update_smart']) {
    assert.ok(!visit.includes(word), `updateSeries/visitSeries mentions ${word}`);
  }
  // isDue is called in exactly one place, behind `opts.smart`.
  const sweep = updater.slice(updater.indexOf('export async function runUpdateAll('));
  assert.equal((updater.match(/\bisDue\(/g) ?? []).length, 1);
  assert.match(sweep, /if \(opts\.smart\) \{[\s\S]*?isDue\(/);
});
