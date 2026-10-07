// Crash durability for the detached bulk chapter cleanup. The worker deliberately stops after unlink and before the
// tombstone; the next-process startup path must use its committed intent to finish that exact row, retain untouched
// chapters, and publish a useful interrupted result.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
let DL = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-bulk-crash-'));
  DL = join(ROOT, 'downloads');
  mkdirSync(DL, { recursive: true });
  process.env.DL_ROOT = DL;
  process.env.LIBRARY_ROOT = join(ROOT, 'library');
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.CONFIG_DIR = join(ROOT, 'config');
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.MIN_FREE_GB = '0';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const LIB = 'lib_bulk_crash';
const SERIES = 's_bulk_crash';
const folder = 'T!crash/Crash Journal';
let q: any;
let startRun: any;
let readRun: any;
let closeInterrupted: any;
let setHooks: any;

const pathFor = (n: number) => join(DL, folder, `Chapter ${n}.cbz`);
const until = async (f: () => Promise<any> | any, label: string, tries = 300) => {
  for (let i = 0; i < tries; i++) {
    const value = await f();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
};

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = await import('../src/lib/db') as any);
  ({
    startBulkChapterDelete: startRun,
    readBulkChapterDeleteRun: readRun,
    closeInterruptedBulkChapterDeleteRuns: closeInterrupted,
    setBulkChapterDeleteTestHooks: setHooks,
  } = await import('../src/lib/bulkChapterDelete') as any);
  await migrate();
  await q('DELETE FROM admin_bulk_delete_runs WHERE $1 = ANY(series_ids)', [SERIES]);
  await q('DELETE FROM lib_series WHERE id = $1', [SERIES]);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Crash journal',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  await q(
    `INSERT INTO lib_series (id, source, title, folder, books_count, library_id, auto_update)
     VALUES ($1,'T!crash','Crash Journal',$2,3,$3,true)`,
    [SERIES, folder, LIB],
  );
  for (let n = 1; n <= 3; n++) {
    const file = `${folder}/Chapter ${n}.cbz`;
    mkdirSync(join(pathFor(n), '..'), { recursive: true });
    writeFileSync(pathFor(n), `chapter-${n}`);
    await q(
      `INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root)
       VALUES ($1,$2,'T!crash',$3,$4,$5,1,$6)`,
      [`b_bulk_crash_${n}`, SERIES, file, n, `Chapter ${n}`, DL],
    );
  }
  await q(`UPDATE lib_series SET cover_book_id = 'b_bulk_crash_1' WHERE id = $1`, [SERIES]);
});

after(async () => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  setHooks?.({});
  await q('DELETE FROM admin_bulk_delete_runs WHERE $1 = ANY(series_ids)', [SERIES]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = $1', [SERIES]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [SERIES]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
});

test('migration exposes a per-chapter intent journal and a current progress snapshot', { skip }, async () => {
  const itemColumns = await q(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'admin_bulk_delete_items'`,
  );
  const names = new Set(itemColumns.map((r: any) => r.column_name));
  for (const name of ['run_id', 'series_id', 'book_id', 'root', 'file', 'position', 'state', 'bytes', 'reason']) {
    assert.equal(names.has(name), true, `missing durable item column ${name}`);
  }
  const current = await q(
    `SELECT data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'admin_bulk_delete_runs' AND column_name = 'current'`,
  );
  assert.equal(current[0]?.data_type, 'jsonb');
});

test('a restart reconciles process death between unlink and tombstone without touching the next chapter', { skip }, async () => {
  let crashPoint!: () => void;
  const reached = new Promise<void>((resolve) => { crashPoint = resolve; });
  setHooks({
    afterUnlink: (item: any) => {
      if (item.id !== 'b_bulk_crash_2') return;
      crashPoint();
      return 'simulate_crash';
    },
  });
  const started = await startRun({ ids: [SERIES], pause: true, userId: null, busy: () => false });
  assert.ok(started?.id);
  await reached;
  await until(async () => {
    const row = (await q(
      `SELECT state FROM admin_bulk_delete_items WHERE run_id = $1 AND book_id = 'b_bulk_crash_2'`,
      [started.id],
    ))[0];
    return row?.state === 'intent' && !existsSync(pathFor(2));
  }, 'committed intent and completed unlink');

  assert.equal((await q(`SELECT pruned_at FROM lib_books WHERE id = 'b_bulk_crash_2'`))[0].pruned_at, null,
    'the simulated process died before the tombstone');
  assert.equal(existsSync(pathFor(3)), true, 'a later chapter was not reached');
  const inFlight = await readRun(started.id);
  assert.equal(inFlight.status, 'running');
  assert.equal(inFlight.current.id, SERIES);
  assert.equal(inFlight.current.processed, 0);
  const storedCurrent = (await q('SELECT current FROM admin_bulk_delete_runs WHERE id = $1', [started.id]))[0].current;

  // This module is still the old in-memory worker, so give the abandoned row a different worker id exactly as a new
  // process would observe it. No code after the simulated exit writes the run.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await q('UPDATE admin_bulk_delete_runs SET worker_id = gen_random_uuid() WHERE id = $1', [started.id]);
  const closers = await Promise.all([closeInterrupted(), closeInterrupted()]);
  assert.deepEqual(closers.sort(), [0, 1], 'only one boot worker owns reconciliation');

  const run = await readRun(started.id);
  assert.equal(run.status, 'interrupted');
  assert.equal(run.current, null);
  assert.equal(run.done, 1);
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].id, SERIES);
  assert.equal(run.results[0].outcome, 'applied');
  assert.equal(run.results[0].chapters, 1);
  assert.equal(run.results[0].kept, 2, 'cover plus the chapter never reached');
  assert.equal(run.results[0].paused, true, 'the requested unmonitor is completed during recovery');
  assert.equal(run.summary.chapters, 1);
  assert.match(run.error, /server stopped/i);
  assert.equal((await q(`SELECT pruned_reason FROM lib_books WHERE id = 'b_bulk_crash_2'`))[0].pruned_reason, 'deleted');
  assert.equal((await q(`SELECT pruned_at FROM lib_books WHERE id = 'b_bulk_crash_3'`))[0].pruned_at, null);
  assert.equal(existsSync(pathFor(3)), true);
  assert.equal((await q(
    `SELECT state FROM admin_bulk_delete_items WHERE run_id = $1 AND book_id = 'b_bulk_crash_2'`, [started.id],
  ))[0].state, 'applied');
  assert.equal((await q('SELECT auto_update FROM lib_series WHERE id = $1', [SERIES]))[0].auto_update, false);
  const auditCount = async (event: string) => Number((await q(
    `SELECT count(*)::int n FROM audit_log
      WHERE event = $1 AND detail->>'runId' = $2 AND detail->>'id' = $3`,
    [event, started.id, SERIES],
  ))[0].n);
  assert.equal(await auditCount('series.chapters_delete'), 1);
  assert.equal(await auditCount('series.settings'), 1);

  // Model a second process death after the idempotent tombstone/pause/audits but before the run-row transaction
  // commits. Reopening only that transaction state must neither duplicate audits nor lose the recovered result.
  await q(
    `UPDATE admin_bulk_delete_runs
        SET status = 'running', worker_id = gen_random_uuid(), finished_at = NULL, done = 0,
            summary = '{"applied":0,"chapters":0,"bytes":0,"kept":0,"paused":0,"skipped":0,"failed":0,"chapterSkips":{}}'::jsonb,
            results = '[]'::jsonb, current = $2::jsonb, error = NULL
      WHERE id = $1`,
    [started.id, JSON.stringify(storedCurrent)],
  );
  assert.equal(await closeInterrupted(), 1);
  const retried = await readRun(started.id);
  assert.equal(retried.status, 'interrupted');
  assert.equal(retried.results[0].chapters, 1);
  assert.equal(retried.results[0].paused, true);
  assert.equal(await auditCount('series.chapters_delete'), 1, 'retry does not duplicate delete evidence');
  assert.equal(await auditCount('series.settings'), 1, 'retry does not duplicate pause evidence');
  setHooks({});
});
