// The nightly update sweep, and the difference between a quiet night and a broken one.
//
// This file is the updater's first test of any kind. That mattered, because every way the sweep could fail
// returned the same bare `added: 0` -- the series being gone, the source uninstalled, the source blocked,
// `listChapters` throwing or hanging, every chapter failing to save, or `updateSeries` throwing outright.
// `added: 0` is also exactly what a healthy night with nothing new returns, and it was all the admin panel
// ever received. The whole library could stop updating and every surface would report it was fine.
//
// That is precisely the failure the source watchdog exists to catch, and the lesson had never been applied
// to the most-used background job in the product.
//
// `listChapters` was also unbounded here while the identical call is bounded at 20s on the add path, so one
// hung site held a sequential sweep for undici's 300-second default, with every series behind it waiting.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-upd-'));
  process.env.DL_ROOT = ROOT;
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.MIN_FREE_GB = '0'; // the disk floor belongs to diskGuard.test.ts
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UPDATER_LIST_TIMEOUT_MS = '300'; // the real bound is 20s; nobody should wait that to prove it exists
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_upd';
const SRC_OK = 'upd-ok', SRC_THROW = 'upd-throw', SRC_HANG = 'upd-hang', SRC_EMPTY = 'upd-empty';
const SRC_BLOCK = 'upd-block';
const SRC_MANY = 'upd-many', SRC_LAND = 'upd-land', SRC_LEDGER = 'upd-ledger';
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const png = () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
/** Counts how many chapters the sweep actually ATTEMPTS against a source that is refusing. */
let blockAsks = 0;
const S = (k: string) => `s_upd_${k}`;
let q: any, updateSeries: any, runUpdateAll: any;

function fake(id: string, mode: 'ok' | 'throw' | 'hang' | 'empty') {
  return {
    id, name: id,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: id }; },
    async listChapters() {
      if (mode === 'throw') throw new Error('site refused');
      if (mode === 'hang') return new Promise<any[]>(() => {});   // a site behind a challenge that never answers
      if (mode === 'empty') return [];
      return [{ number: 1, title: 'Chapter 1', id: 'c1' }];
    },
    async getPageUrls() { return []; },
    async latest() { return []; },
  };
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  ({ updateSeries, runUpdateAll } = (await import('../src/lib/updater')) as any);
  await migrate();

  registerAdapter(fake(SRC_OK, 'ok') as any);
  registerAdapter(fake(SRC_THROW, 'throw') as any);
  registerAdapter(fake(SRC_HANG, 'hang') as any);
  registerAdapter(fake(SRC_EMPTY, 'empty') as any);
  registerAdapter({
    id: SRC_BLOCK, name: SRC_BLOCK,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: SRC_BLOCK, title: SRC_BLOCK }; },
    async listChapters() {
      return Array.from({ length: 5 }, (_, i) => ({ number: i + 1, title: `Chapter ${i + 1}`, id: `c${i + 1}` }));
    },
    async getPageUrls() { blockAsks++; return ['https://example.invalid/refused.png']; },
    async latest() { return []; },
  } as any);

  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Upd',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  const mk = async (key: string, sourceId: string | null) =>
    q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
       VALUES ($1,'T!upd',$1,$1,0,$2,$3,$4,true) ON CONFLICT (id) DO NOTHING`,
      [S(key), LIB, sourceId, sourceId ? `${sourceId}-1` : null]);
  await mk('throw', SRC_THROW);
  await mk('hang', SRC_HANG);
  await mk('empty', SRC_EMPTY);
  await mk('unrouted', null);
  await mk('block', SRC_BLOCK);

  // A source with several chapters that actually download, one with one, and one whose pages are per chapter
  // so a single chapter can be made to come up short.
  const many = (id: string, n: number) => ({
    id, name: id,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: sid }; },
    // `sourceId` is what the downloader hands back to getPageUrls; the older fakes above never fetch pages, so
    // their `id` field was never exercised.
    async listChapters() { return Array.from({ length: n }, (_, i) => ({ number: i + 1, title: `Chapter ${i + 1}`, sourceId: `c${i + 1}` })); },
    async getPageUrls() { return ['https://example.invalid/page.png']; },
    async latest() { return []; },
  });
  registerAdapter(many(SRC_MANY, 5) as any);
  registerAdapter(many(SRC_LAND, 1) as any);
  registerAdapter({
    ...many(SRC_LEDGER, 2),
    async getPageUrls(chId: string) { return Array.from({ length: 5 }, (_, i) => `https://example.invalid/${chId}/l${i}.png`); },
  } as any);
  await mk('ok', SRC_OK);
  for (const k of ['many1', 'many2', 'many3', 'rotA', 'rotB']) await mk(k, SRC_MANY);
  for (const k of ['block2', 'block3']) await mk(k, SRC_BLOCK);
  await mk('land', SRC_LAND);
  await mk('ledger', SRC_LEDGER);
});

after(async () => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  // persistScan may have minted rows of its own for the scratch folders; sweep those too.
  await q(`DELETE FROM lib_books WHERE file LIKE 's_upd_%'`).catch(() => {});
  await q(`DELETE FROM lib_series WHERE folder LIKE 's_upd_%'`).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[SRC_MANY, SRC_LAND, SRC_LEDGER, SRC_OK, SRC_THROW]]).catch(() => {});
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC_BLOCK]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
});

test('a series says WHY it produced nothing', { skip }, async (t) => {
  await t.test('a source that throws is not a quiet night', async () => {
    const r = await updateSeries(S('throw'));
    assert.equal(r.added, 0);
    assert.equal(r.outcome, 'source_error', 'a refusing site must be distinguishable from having nothing new');
  });

  await t.test('a source that hangs is bounded, and reported', async () => {
    const started = Date.now();
    const r = await updateSeries(S('hang'));
    assert.ok(Date.now() - started < 5000, 'listChapters must be bounded here as it is on the add path');
    assert.equal(r.outcome, 'source_error');
  });

  await t.test('a source that genuinely has nothing is healthy', async () => {
    const r = await updateSeries(S('empty'));
    assert.equal(r.added, 0);
    assert.equal(r.outcome, 'ok', 'nothing new is a perfectly good night');
  });

  await t.test('a row with no source is unrouted, not broken', async () => {
    const r = await updateSeries(S('unrouted'));
    assert.equal(r.outcome, 'unrouted');
  });

  await t.test('a series that no longer exists says so', async () => {
    const r = await updateSeries('s_upd_does_not_exist');
    assert.equal(r.outcome, 'gone');
  });
});

test('a sweep where everything failed does not look like a sweep with nothing new', { skip }, async (t) => {
  await t.test('all-broken reports unhealthy', async () => {
    await q(`UPDATE lib_series SET auto_update = COALESCE(source_id = $1 OR source_id = $2, false) WHERE library_id = $3`,
      [SRC_THROW, SRC_HANG, LIB]);
    const r = await runUpdateAll({ maxNew: 1 });
    assert.equal(r.added, 0);
    assert.equal(r.healthy, false, 'a run where no source answered must not report healthy');
    assert.ok(r.failed >= 2, `expected the failures to be counted, got ${r.failed}`);
    assert.ok(r.outcomes.source_error >= 2, 'and attributed to the right cause');
  });

  await t.test('all-quiet reports healthy, with the same +0', async () => {
    await q(`UPDATE lib_series SET auto_update = COALESCE(source_id = $1, false) WHERE library_id = $2`, [SRC_EMPTY, LIB]);
    const r = await runUpdateAll({ maxNew: 1 });
    assert.equal(r.added, 0, 'same visible number as the broken run above...');
    assert.equal(r.healthy, true, '...and that is exactly why the two must differ somewhere else');
    assert.equal(r.failed, 0);
  });
});


/**
 * A source that refuses must cost ONE chapter, not five.
 *
 * The updater was the only caller of downloadChapter that did not stop on `blockStatus` -- its catch was a
 * bare `failed++`. So when mangakakalot rate-limited us, the sweep asked it for four more chapters it was
 * never going to serve, and each refusal called reportFail again. The cooldown escalates with `consecutive`
 * (15, 30, 45, 60, 75 minutes), so one burst produced five escalations in 74 seconds and locked the source
 * for 75 minutes. The person's own manual retry was then refused too, which is what "I tried again and it
 * still doesn't work" actually was.
 *
 * Reintroduce by restoring `} catch { failed++; }` in updater.ts: blockAsks becomes 5 and consecutive 5.
 */
test('a refusing source costs one chapter, not the whole run', { skip }, async () => {
  globalThis.fetch = (async () => new Response('go away', { status: 403 })) as typeof fetch;
  blockAsks = 0;
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC_BLOCK]);

  await updateSeries(S('block'), 5);

  assert.equal(blockAsks, 1, 'the sweep stopped at the first refusal instead of asking five times');
  const h = (await q(`SELECT consecutive FROM source_health WHERE source_id = $1`, [SRC_BLOCK]))[0];
  assert.ok(h, 'the refusal is still recorded once');
  assert.equal(Number(h.consecutive), 1,
    'one refusal is one strike: five strikes turned a 15-minute cooldown into 75');
});


// ---- v0.14.0: the sweep has a budget, visits sources fairly, and writes its failures down --------------
//
// Measured on the night that prompted this: one aqua chapter came up 25 of 176 images short, aqua went into
// a 30-minute cooldown, and because the sweep walked all 226 series in one flat line the remaining 164 aqua
// series were skipped one after another -- with the 34 series on other sources stuck behind them. The only
// record was "blocked=164" in one log line.

/**
 * Only these rows take part in the next sweep: everything else is switched off, whichever library or test file
 * it came from. Scoping this to LIB let a fixture left behind by another file sharing the scratch database ride
 * into the sweep and put every count off by one.
 */
const only = async (keys: string[]) => {
  await q(`UPDATE lib_series SET auto_update = (id = ANY($1::text[]))`, [keys.map(S)]);
  // A scan run by an earlier test can merge or soft-delete a hand-made fixture; the sweep's query would then
  // silently select nothing. Restore visibility for the rows this test is about, and let the precondition
  // assertions below say so if anything else is off.
  await q(`UPDATE lib_series SET deleted_at = NULL, merged_into = NULL WHERE id = ANY($1::text[])`, [keys.map(S)]);
};
const onDisk = (key: string, n: number) => existsSync(join(ROOT, S(key), `Chapter ${n}.cbz`));
const stamp = async (key: string) =>
  (await q(`SELECT source_chapters AS c, source_missing AS m, source_checked_at AS t FROM lib_series WHERE id = $1`, [S(key)]))[0];

test('the sweep records what the source said', { skip }, async () => {
  await q(`UPDATE lib_series SET source_checked_at = NULL, source_chapters = NULL, source_missing = NULL WHERE library_id = $1`, [LIB]);
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[SRC_OK, SRC_THROW]]);

  await updateSeries(S('ok'));
  const ok = await stamp('ok');
  assert.equal(ok.c, 1, 'the source listed one chapter');
  assert.equal(ok.m, 1, 'and we hold none of it');
  assert.ok(ok.t, 'asked, so stamped');

  await updateSeries(S('throw'));
  const th = await stamp('throw');
  assert.ok(th.t, 'asked and got nothing is still asked: a dead source must rotate to the back, not sit first forever');
  assert.equal(th.c, null, 'but it said nothing, so nothing is recorded as said');

  await q(`INSERT INTO source_health (source_id, status, blocked_until) VALUES ($1, 'blocked', now() + interval '1 hour')
           ON CONFLICT (source_id) DO UPDATE SET blocked_until = now() + interval '1 hour'`, [SRC_OK]);
  await q('UPDATE lib_series SET source_checked_at = NULL WHERE id = $1', [S('ok')]);
  assert.equal((await updateSeries(S('ok'))).outcome, 'blocked');
  assert.equal((await stamp('ok')).t, null, 'skipped for a cooldown was never asked, so it keeps its place in the queue');
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC_OK]);
});

/** Reintroduce by removing the `spent >= sweepMax` check: added becomes 15 and nothing is skipped. */
test('a sweep stops at its budget and says so', { skip }, async () => {
  await only(['many1', 'many2', 'many3']);
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC_MANY]);
  globalThis.fetch = (async () => png()) as typeof fetch;

  const r = await runUpdateAll({ maxNew: 5, sweepMax: 7 });

  assert.equal(r.added, 7, 'seven attempts and then stop, not fifteen');
  assert.equal(r.stopped, 'budget');
  assert.equal(r.visited, 2, 'the third series was never listed');
  assert.equal(r.outcomes.skipped, 1, 'what the budget left behind is counted, not lost');
});

/**
 * Reintroduce by flattening the queues back into one loop: blocked becomes 2 and skipped 0, and the healthy
 * source behind them in the line is only reached because the fixture is small.
 */
test('a source in a cooldown parks its own queue, and nobody else\'s', { skip }, async () => {
  await only(['block', 'block2', 'block3', 'land']);
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[SRC_BLOCK, SRC_LAND]]);
  blockAsks = 0;
  globalThis.fetch = (async (u: any) => (String(u).includes('refused') ? new Response('go away', { status: 403 }) : png())) as typeof fetch;

  const r = await runUpdateAll({ maxNew: 5 });

  assert.equal(blockAsks, 1, 'the refusing source was asked exactly once');
  assert.equal(r.outcomes.blocked, 1, 'its next series saw the cooldown...');
  assert.equal(r.outcomes.skipped, 1, '...and the one after that was parked: not asked, and not miscounted as blocked');
  assert.ok(onDisk('land', 1), 'while the healthy source that used to wait behind all of them landed its chapter');
});

/** Reintroduce by ordering on latest_mtime alone: rotA goes first both times and rotB is never visited. */
test('what a sweep leaves unvisited goes first next time', { skip }, async () => {
  await only(['rotA', 'rotB']);
  await q(`UPDATE lib_series SET source_checked_at = NULL, latest_mtime = CASE id WHEN $1 THEN 2000 ELSE 1000 END WHERE id = ANY($2::text[])`,
    [S('rotA'), [S('rotA'), S('rotB')]]);
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC_MANY]);
  globalThis.fetch = (async () => png()) as typeof fetch;

  const first = await runUpdateAll({ maxNew: 5, sweepMax: 5 });
  assert.equal(first.visited, 1);
  assert.ok((await stamp('rotA')).t, 'the fresher series went first, as it always did');
  assert.equal((await stamp('rotB')).t, null);

  const second = await runUpdateAll({ maxNew: 5, sweepMax: 5 });
  assert.equal(second.visited, 1);
  assert.ok((await stamp('rotB')).t, 'and the one it left behind goes first the next time, instead of never');
});

/**
 * Reintroduce by removing the upsert in noteChapterFailure: no row. By removing the DELETE at the end of
 * persistScan: the row outlives the chapter.
 */
test('a chapter that will not download is written down, and erased when it lands', { skip }, async () => {
  await only(['ledger']);
  const serve = (shortChapter: string | null) => {
    globalThis.fetch = (async (u: any) =>
      shortChapter && String(u).endsWith(`/${shortChapter}/l4.png`) ? new Response('nope', { status: 503 }) : png()) as typeof fetch;
  };
  const clear = () => q('DELETE FROM source_health WHERE source_id = $1', [SRC_LEDGER]);

  // Chapter 1 lands and is scanned, so the series row the scanner uses is the one the ledger will be keyed by.
  await clear(); serve(null);
  await updateSeries(S('ledger'), 1);
  assert.ok(onDisk('ledger', 1));
  const { persistScan } = await import('../src/lib/library');
  await persistScan();
  const book = (await q(`SELECT series_id FROM lib_books WHERE file LIKE $1`, [`%${S('ledger')}/Chapter 1.cbz`]))[0];
  assert.ok(book, 'the scanner saw the chapter');
  const sid: string = book.series_id;
  await q(`UPDATE lib_series SET source_id = $1, source_series_id = $2, auto_update = true WHERE id = $3`, [SRC_LEDGER, `${SRC_LEDGER}-1`, sid]);
  const row = async () => (await q(`SELECT status, attempts, source_id FROM chapter_failures WHERE series_id = $1 AND number = 2`, [sid]))[0];
  await q('DELETE FROM chapter_failures WHERE series_id = $1', [sid]);

  // Chapter 2 comes up one page short, twice.
  await clear(); serve('c2');
  await updateSeries(sid, 5);
  let f = await row();
  assert.ok(f, 'the failure is written down');
  assert.equal(f.status, 'incomplete');
  assert.equal(Number(f.attempts), 1);
  assert.equal(f.source_id, SRC_LEDGER);

  await clear(); // the shortfall earned a cooldown; lift it so the retry is attempted at all
  await updateSeries(sid, 5);
  f = await row();
  assert.equal(Number(f.attempts), 2, 'one row per chapter, bumped per attempt');

  const { runHealthChecks } = await import('../src/lib/health');
  const report: any = await runHealthChecks();
  const check = (report.checks ?? report).find((c: any) => c.id === 'chapter-failures');
  assert.ok(check, 'the health page has a check for this');
  assert.equal(check.status, 'warn');
  assert.ok(check.items.some((i: any) => i.title === SRC_LEDGER), 'and it names the source');

  // Then it lands, and the ledger forgets it.
  await clear(); serve(null);
  await updateSeries(sid, 5);
  assert.ok(onDisk('ledger', 2));
  await persistScan();
  assert.equal(await row(), undefined, 'erased the moment the chapter exists');
});


/**
 * A completed sweep leaves a persisted timestamp, and only a completed one.
 *
 * The scheduled updater's first run after boot used to wait a full interval, so every deploy pushed the
 * next sweep out by six hours; three deploys in one day meant no scheduled sweep at all, measured live. The
 * first tick now schedules the remainder of the interval since this stamp. Reintroduce by removing the
 * UPDATE in runSweep: the stamp stays null and a restart starts the clock from zero again.
 */
test('a completed sweep records when it finished', { skip }, async () => {
  const { runSweep } = await import('../src/lib/updater');
  await only(['empty']);
  await q('UPDATE server_settings SET updater_last_run = NULL WHERE id = 1');
  const quiet = { info() {}, warn() {}, error() {} };
  const run = runSweep({ maxNew: 1 }, quiet as any);
  assert.ok(run, 'nothing else was running, so it started');
  await run;
  const t = (await q('SELECT updater_last_run AS t FROM server_settings WHERE id = 1'))[0].t;
  assert.ok(t && Date.now() - new Date(t).getTime() < 60_000, 'stamped within the last minute');

  // A sweep that threw is not a completed sweep: the stamp must not move.
  await q('UPDATE server_settings SET updater_last_run = NULL WHERE id = 1');
  const boom = runSweep({ maxNew: 1 }, quiet as any, async () => { throw new Error('sweep died'); });
  assert.ok(boom); await boom;
  assert.equal((await q('SELECT updater_last_run AS t FROM server_settings WHERE id = 1'))[0].t, null,
    'a run that died does not count as the last completed one');
});


/**
 * A stop request ends the sweep at a boundary, and says so.
 *
 * There was no signal handler at all: `docker compose up -d` in the middle of a sweep killed it wherever it
 * was, the job card polled a run that no longer existed, and the result was indistinguishable from a sweep
 * that finished. Now SIGTERM sets runtime.stopping; the sweep checks it between series and between
 * chapters, never mid-write, and reports `stopped: 'shutdown'`.
 *
 * Reintroduce by removing either `runtime.stopping` check in updater.ts: the matching test fails.
 */
test('a stop request ends the sweep between series, and it is not a healthy night', { skip }, async () => {
  const { runtime } = await import('../src/lib/runtime');
  await only(['many1', 'many2']);
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC_MANY]);
  // Precondition, asserted rather than assumed: the two rows must be what the sweep's own query selects.
  const pre = await q(`SELECT id, auto_update, deleted_at, merged_into, library_id FROM lib_series WHERE id = ANY($1::text[]) ORDER BY id`, [[S('many1'), S('many2')]]);
  assert.deepEqual(pre.map((r: any) => [r.id, r.auto_update, r.deleted_at, r.merged_into]),
    [[S('many1'), true, null, null], [S('many2'), true, null, null]], `fixture rows are not sweepable: ${JSON.stringify(pre)}`);
  globalThis.fetch = (async () => png()) as typeof fetch;
  runtime.stopping = true;
  try {
    const r = await runUpdateAll({ maxNew: 5 });
    assert.equal(r.visited, 0, 'nothing was started once a stop was requested');
    assert.equal(r.stopped, 'shutdown');
    assert.equal(r.outcomes.skipped, 2, 'what it did not reach is counted as skipped, not as done');
    assert.equal(r.healthy, false, 'an interrupted sweep must not read as a quiet night');
  } finally { runtime.stopping = false; }
});

test('a stop request mid-series finishes the current chapter and takes no more', { skip }, async () => {
  const { runtime } = await import('../src/lib/runtime');
  const { registerAdapter } = await import('../src/lib/sources');
  const SRC_STOP = 'upd-stop';
  registerAdapter({
    id: SRC_STOP, name: SRC_STOP,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: SRC_STOP, title: sid }; },
    async listChapters() { return Array.from({ length: 5 }, (_, i) => ({ number: i + 1, title: `Chapter ${i + 1}`, sourceId: `s${i + 1}` })); },
    // The stop arrives while chapter 1 is being fetched: chapter 1 must still land whole, chapter 2 must not start.
    async getPageUrls() { runtime.stopping = true; return ['https://example.invalid/page.png']; },
    async latest() { return []; },
  } as any);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
           VALUES ($1,'T!upd',$1,$1,0,$2,$3,$4,true) ON CONFLICT (id) DO NOTHING`, [S('stop'), LIB, SRC_STOP, `${SRC_STOP}-1`]);
  globalThis.fetch = (async () => png()) as typeof fetch;
  try {
    const r = await updateSeries(S('stop'), 5);
    assert.equal(r.added, 1, 'the chapter in flight completed');
    assert.ok(onDisk('stop', 1), 'and is whole on disk');
    assert.ok(!onDisk('stop', 2), 'the next one was never started');
  } finally { runtime.stopping = false; }
});
