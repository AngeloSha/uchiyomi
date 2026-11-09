// #413 (@Wolf92s): a series may follow up to 25 other sources, and past the first three they are backups. A scheduled run
// over a series with nothing missing asks a backup at most once a day; a series that is behind and a run a person started
// ask every one, and a run in which nothing ahead answered asks the backups in turn until one does. Driven through
// updateSeries with fake sources that count their listing calls.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-backups-'));
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.DL_ROOT = ROOT;
  process.env.MIN_FREE_GB = '0';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const SER = 's_backups_1';
const MAIN = 'bk-main';
const FOLLOWERS = ['bk-f1', 'bk-f2', 'bk-f3', 'bk-f4', 'bk-f5'];
const asked: string[] = [];
const failing = new Set<string>();
let q: any;
let updateSeries: any;

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  ({ updateSeries } = (await import('../src/lib/updater')) as any);
  await migrate();
  for (const id of [MAIN, ...FOLLOWERS]) {
    registerAdapter({
      id, name: id,
      async search() { return []; },
      async getSeries(sid: string) { return { sourceId: sid, source: id, title: 'Backup Series' }; },
      async listChapters() {
        asked.push(id);
        if (failing.has(id)) throw new Error('HTTP 500');
        return [];
      },
      async getPageUrls() { return []; },
    } as any);
  }
  await q('DELETE FROM series_sources WHERE series_id = $1', [SER]);
  await q('DELETE FROM lib_series WHERE id = $1', [SER]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id, auto_update, source_checked_at, source_missing, finish_missing)
           VALUES ($1,'T!bk','Backup Series',$1,0,$2,'m',true, now(), 0, 0)`, [SER, MAIN]);
  for (const [i, f] of FOLLOWERS.entries()) {
    await q(`INSERT INTO series_sources (series_id, source_id, source_series_id, created_at, checked_at)
             VALUES ($1,$2,$3, now() - make_interval(mins => $4), now() - interval '1 hour')`, [SER, f, `${f}-1`, 100 - i]);
  }
});

after(async () => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  await q('DELETE FROM series_sources WHERE series_id = $1', [SER]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [SER]).catch(() => {});
  await (await import('../src/lib/db')).pool.end().catch(() => {});
});

/** Which sources one run asked for their listing, in the order asked. */
const run = async (opts: Record<string, unknown>) => {
  asked.length = 0;
  await updateSeries(SER, 10, opts);
  return [...asked];
};
const caughtUp = () => q(`UPDATE lib_series SET source_checked_at = now(), source_missing = 0, finish_missing = 0, finish_after = NULL WHERE id = $1`, [SER]);

test('a caught-up series asks its backups once a day, and the first three followers every time', { skip }, async () => {
  // Reintroduce by asking every follower (drop the `backups` skip in the follower loop): the fourth and fifth are asked.
  await caughtUp();
  assert.deepEqual(await run({ unattended: true }), [MAIN, 'bk-f1', 'bk-f2', 'bk-f3'], 'a backup checked an hour ago was asked again');
  // A day since the fourth was last asked: it is asked once, and its stamp says so.
  await q(`UPDATE series_sources SET checked_at = now() - interval '25 hours' WHERE series_id = $1 AND source_id = 'bk-f4'`, [SER]);
  await caughtUp();
  assert.deepEqual(await run({ unattended: true }), [MAIN, 'bk-f1', 'bk-f2', 'bk-f3', 'bk-f4']);
  await caughtUp();
  assert.deepEqual(await run({ unattended: true }), [MAIN, 'bk-f1', 'bk-f2', 'bk-f3'], 'asked again within the day');
});

test('a series that is behind, and a run a person started, ask every source', { skip }, async () => {
  // Reintroduce by resting backups whatever the series is: a behind series waits a day for the source that has its chapter.
  await q(`UPDATE lib_series SET finish_missing = 2 WHERE id = $1`, [SER]);
  assert.deepEqual(await run({ unattended: true }), [MAIN, ...FOLLOWERS], 'a behind series rests a backup');
  await caughtUp();
  assert.deepEqual(await run({}), [MAIN, ...FOLLOWERS], 'Check now rests a backup');
});

test('the backups are asked in turn when nothing ahead of them answered, until one does', { skip }, async () => {
  // Reintroduce by dropping `answered > 0` from the skip: a series whose main and first followers all fail asks nobody else.
  await caughtUp();
  for (const id of [MAIN, 'bk-f1', 'bk-f2', 'bk-f3']) failing.add(id);
  try {
    assert.deepEqual(await run({ unattended: true }), [MAIN, 'bk-f1', 'bk-f2', 'bk-f3', 'bk-f4'], 'the first backup is asked, and the next rests once it answered');
    failing.add('bk-f4');
    assert.deepEqual(await run({ unattended: true }), [MAIN, ...FOLLOWERS], 'and the next when it fails too');
  } finally { failing.clear(); }
});
