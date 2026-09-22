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
  process.env.SOLVER_BUDGET_MS = '800';       // and a solver-fronted source gets this instead (real: 90s)
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
/** A fixture series row; the `mk` inside before() is not reachable from later tests. */
const mkSeries = (key: string, sourceId: string | null) =>
  q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
     VALUES ($1,'T!upd',$1,$1,0,$2,$3,$4,true) ON CONFLICT (id) DO NOTHING`,
    [S(key), LIB, sourceId, sourceId ? `${sourceId}-1` : null]);

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
      shortChapter && new RegExp(`/${shortChapter}/l[34]\\.png$`).test(String(u)) ? new Response('nope', { status: 503 }) : png()) as typeof fetch;
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

  // Chapter 2 comes up two pages short, twice: below the partial floor, so this remains the ledger case.
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


/**
 * A source behind the Cloudflare solver gets a listing budget that fits a challenge.
 *
 * aqua's challenge takes about a minute; the listing budget was 20 seconds for every source alike, so the
 * first scheduled sweep on v0.14 lost 15 aqua series to `source_error` while the solver was busy. A
 * 60-second challenge against a 20-second timeout is a structural loss, not a flaky site.
 *
 * Reintroduce by passing LIST_TIMEOUT instead of budgetFor(src, LIST_TIMEOUT): the first test fails.
 */
test('a solver-fronted source is given time for its challenge; a plain one is not', { skip }, async () => {
  const { registerAdapter } = await import('../src/lib/sources');
  const slow = (id: string, requiresCloudflare: boolean) => ({
    id, name: id, requiresCloudflare,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: id }; },
    async listChapters() { await new Promise((r) => setTimeout(r, 500)); return [{ number: 1, title: 'Chapter 1', sourceId: 'c1' }]; },
    async getPageUrls() { return ['https://example.invalid/page.png']; },
    async latest() { return []; },
  });
  registerAdapter(slow('upd-cf-slow', true) as any);
  registerAdapter(slow('upd-plain-slow', false) as any);
  await mkSeries('cfslow', 'upd-cf-slow');
  await mkSeries('plainslow', 'upd-plain-slow');
  globalThis.fetch = (async () => png()) as typeof fetch;

  const cf = await updateSeries(S('cfslow'), 1);
  assert.equal(cf.outcome, 'ok', 'a 500 ms listing is inside the 800 ms solver budget');
  assert.equal(cf.available, 1);
  const plain = await updateSeries(S('plainslow'), 1);
  assert.equal(plain.outcome, 'source_error', 'the same 500 ms is over the 300 ms budget for a source that needs no solver');
});

/**
 * A chapter that has failed CHAPTER_RETRY_CAP times is left alone by the sweep, and counted.
 *
 * Reintroduce by iterating `missing` instead of `eligible`: the source is asked for the capped chapter and
 * `capped` reads 0.
 */
test('a chapter past the retry cap is not attempted by the sweep, and is counted', { skip }, async () => {
  const { CHAPTER_RETRY_CAP } = await import('../src/lib/updater');
  const { registerAdapter } = await import('../src/lib/sources');
  const asked: number[] = [];
  registerAdapter({
    id: 'upd-cap', name: 'upd-cap',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: 'upd-cap', title: sid }; },
    async listChapters() { return [1, 2, 3].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `c${n}` })); },
    async getPageUrls(chId: string) { asked.push(Number(chId.slice(1))); return ['https://example.invalid/page.png']; },
    async latest() { return []; },
  } as any);
  await mkSeries('cap', 'upd-cap');
  await q('DELETE FROM chapter_failures WHERE series_id = $1', [S('cap')]);
  await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, reason, attempts) VALUES ($1, 1, 'upd-cap', 'incomplete', 'x', $2), ($1, 2, 'upd-cap', 'incomplete', 'x', $3)`,
    [S('cap'), CHAPTER_RETRY_CAP, CHAPTER_RETRY_CAP - 1]);
  globalThis.fetch = (async () => png()) as typeof fetch;

  const r = await updateSeries(S('cap'), 5);
  assert.deepEqual(asked.sort(), [2, 3], `chapter 1 is capped and must not be asked for; asked: ${asked}`);
  assert.equal(r.capped, 1, 'and the sweep says how many it left alone');
  assert.equal(r.added, 2);
});

/**
 * A series added as "latest N" is not backfilled by the sweep.
 *
 * The add path writes `chapter_floor` = the lowest chapter it took, because the loop above is oldest-missing-
 * first: a series added as the latest 25 of 200 would otherwise have the sweep fetch 1..175 five per night
 * with every new release queued behind them, which is the opposite of what "latest" asked for. Chapters
 * below the floor are left to the fill scan, on purpose.
 *
 * Reintroduce by filtering `chapters` for `missing` instead of `wanted` (i.e. dropping the `>= floor`
 * filter): added reads 4 -- chapters 1, 2, 3 and 6 -- and source_missing reads 4.
 */
test('a floored series fetches the chapter above what it holds, not the ones below the floor', { skip }, async () => {
  const { registerAdapter } = await import('../src/lib/sources');
  const SRC_FLOOR = 'upd-floor';
  const asked: number[] = [];
  registerAdapter({
    id: SRC_FLOOR, name: SRC_FLOOR,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: SRC_FLOOR, title: sid }; },
    async listChapters() { return [1, 2, 3, 4, 5, 6].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `c${n}` })); },
    async getPageUrls(chId: string) { asked.push(Number(chId.slice(1))); return ['https://example.invalid/page.png']; },
    async latest() { return [];  },
  } as any);
  await mkSeries('floor', SRC_FLOOR);
  await q('UPDATE lib_series SET chapter_floor = 4 WHERE id = $1', [S('floor')]);
  // Books 4 and 5 are what a "latest 2" add would have left behind, as rows rather than files: updateSeries
  // reads lib_books, and the scan that would mint them from disk is not part of this test.
  await q('DELETE FROM lib_books WHERE series_id = $1', [S('floor')]);
  for (const n of [4, 5]) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages) VALUES ($1, $2, 'T!upd', $3, $4, $5, 1)`,
      [`${S('floor')}_b${n}`, S('floor'), `${S('floor')}/Chapter ${n}.cbz`, n, `Chapter ${n}`]);
  }
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC_FLOOR]);
  globalThis.fetch = (async () => png()) as typeof fetch;

  const r = await updateSeries(S('floor'), 5);

  assert.equal(r.added, 1, `chapter 6 alone is new; asked for: ${asked}`);
  assert.deepEqual(asked, [6], 'the sweep did not so much as ask for anything below the floor');
  assert.ok(onDisk('floor', 6));
  assert.ok(!onDisk('floor', 1) && !onDisk('floor', 3), 'nothing below the floor was fetched');
  const st = await stamp('floor');
  assert.equal(st.m, 1, '"{n} behind" on the series page counts what the sweep would fetch, not the back catalogue');
  assert.equal(st.c, 6, 'while source_chapters still says what the source said');
});

// ---- v0.37.0: "Fetch newest" -- the newest LISTED release, floor ignored for that one number ----------
//
// A "Nothing yet" add and a Mihon-backup import both write chapter_floor = the newest listed number + 0.001
// (routes/sources.ts), so the sweep correctly fetches nothing for them -- and so would any button that
// filtered by the floor: a chapterless series answering "already at latest" forever. PR #53's fix took the
// newest MISSING number from the whole listing instead, which is chapter max for that series and the
// highest chapter BELOW the floor for a caught-up Latest-N series: Latest-25 of 200 with 176-200 on disk
// "fetched" 175, then 174 on the next click, reporting each as a new release. The rule is max(listed).

/** A six-chapter source whose page asks are recorded, so a test can say exactly what was fetched. */
function sixChapterSource(id: string, asked: number[]) {
  return {
    id, name: id,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: sid }; },
    async listChapters() { return [1, 2, 3, 4, 5, 6].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `c${n}` })); },
    async getPageUrls(chId: string) { asked.push(Number(chId.slice(1))); return ['https://example.invalid/page.png']; },
    async latest() { return []; },
  };
}
const floorOf = async (key: string) => Number((await q('SELECT chapter_floor FROM lib_series WHERE id = $1', [S(key)]))[0].chapter_floor);
/** A book row the way a "latest N" add leaves one behind: a row, not a file (see the floor test above). */
const book = (key: string, n: number) =>
  q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages) VALUES ($1, $2, 'T!upd', $3, $4, $5, 1)`,
    [`${S(key)}_b${n}`, S(key), `${S(key)}/Chapter ${n}.cbz`, n, `Chapter ${n}`]);

/**
 * Reintroduce by filtering the newest out of `wanted` (the floor-honouring set) instead of `releases`:
 * `newest.state` reads `unlisted`, added reads 0 and nothing is asked for.
 */
test('fetch newest reaches the latest release of a "nothing yet" series floored above its catalogue, and leaves the floor alone', { skip }, async () => {
  const { registerAdapter } = await import('../src/lib/sources');
  const asked: number[] = [];
  registerAdapter(sixChapterSource('upd-newest-none', asked) as any);
  await mkSeries('newestnone', 'upd-newest-none');
  // Exactly as sources.ts writes it for chapterFrom:'none': a hair above the newest listed number, on a
  // series with no books at all.
  await q('UPDATE lib_series SET chapter_floor = 6.001 WHERE id = $1', [S('newestnone')]);
  await q('DELETE FROM lib_books WHERE series_id = $1', [S('newestnone')]);
  await q('DELETE FROM source_health WHERE source_id = $1', ['upd-newest-none']);
  globalThis.fetch = (async () => png()) as typeof fetch;

  const sweep = await updateSeries(S('newestnone'), 5);
  assert.equal(sweep.added, 0, 'the sweep honours the floor: nothing is backfilled');

  const r = await updateSeries(S('newestnone'), 1, { newestOnly: true });
  assert.deepEqual(r.newest, { number: 6, state: 'queued' }, 'the newest listed number is the one queued');
  assert.equal(r.added, 1, 'and it landed');
  assert.deepEqual(asked, [6], 'only that one chapter was asked for');
  assert.ok(onDisk('newestnone', 6));
  assert.equal(await floorOf('newestnone'), 6.001, 'the floor is not moved: the next sweep still wants only what is above it');
});

/**
 * THE TRAP. Reintroduce by selecting the newest MISSING number -- `releases.filter((c) => !have.has(c.number))`
 * and taking its last element -- instead of max(listed): `newest.state` reads `queued` for chapter 3,
 * added reads 1, and Chapter 3.cbz appears on disk below the floor.
 */
test('a caught-up Latest-N series answers up to date, and nothing below its floor is fetched', { skip }, async () => {
  const { registerAdapter } = await import('../src/lib/sources');
  const asked: number[] = [];
  registerAdapter(sixChapterSource('upd-newest-caught', asked) as any);
  await mkSeries('newestcaught', 'upd-newest-caught');
  // Latest-3 of 6: floor 4, and 4..6 on the shelf. 1..3 are missing below the floor, on purpose.
  await q('UPDATE lib_series SET chapter_floor = 4 WHERE id = $1', [S('newestcaught')]);
  await q('DELETE FROM lib_books WHERE series_id = $1', [S('newestcaught')]);
  for (const n of [4, 5, 6]) await book('newestcaught', n);
  await q('DELETE FROM source_health WHERE source_id = $1', ['upd-newest-caught']);
  globalThis.fetch = (async () => png()) as typeof fetch;

  const r = await updateSeries(S('newestcaught'), 1, { newestOnly: true });
  assert.deepEqual(r.newest, { number: 6, state: 'up_to_date' }, 'we hold the newest listed number, so the series is up to date');
  assert.equal(r.added, 0);
  assert.deepEqual(asked, [], 'nothing was asked for: not chapter 3, not anything under the floor');
  assert.ok(!onDisk('newestcaught', 3) && !onDisk('newestcaught', 1), 'and nothing under the floor is on disk');
  assert.equal(await floorOf('newestcaught'), 4);

  // The have-set is the sweep's: a chapter the read-cleanup let go still counts as held (the person read it
  // and chose to have it cleaned) -- not fetched, and told apart from a live row (the `deleted` test
  // below) -- while one the verify task found MISSING does not: its file is gone without anyone deciding
  // so, and "Fetch newest" is exactly how it comes back.
  await q(`UPDATE lib_books SET pruned_at = now(), pruned_reason = NULL WHERE id = $1`, [`${S('newestcaught')}_b6`]);
  const cleaned = await updateSeries(S('newestcaught'), 1, { newestOnly: true });
  assert.equal(cleaned.newest?.state, 'deleted', 'a cleanup tombstone of the newest number is held, and says it was deleted');
  assert.deepEqual(asked, [], 'and is not fetched back');
  await q(`UPDATE lib_books SET pruned_at = now(), pruned_reason = 'missing' WHERE id = $1`, [`${S('newestcaught')}_b6`]);
  const missing = await updateSeries(S('newestcaught'), 1, { newestOnly: true });
  assert.equal(missing.newest?.state, 'queued', 'a "missing" tombstone of the newest number is fetched again');
  assert.deepEqual(asked, [6]);
});

/**
 * Reintroduce by queueing `eligible` (the sweep's oldest-first list) when newestOnly is set: `asked` reads
 * [6] still -- but with maxNew 5 it reads [6] only because nothing else is above the floor; set the floor to
 * 1 in the fixture and it reads [1, 2, 3, 6]. The assertion that pins the rule is `newest.number === 6`
 * together with `asked` being exactly one number.
 */
test('a Latest-N series that is behind fetches the newest listed release and only that, with its floor unchanged', { skip }, async () => {
  const { registerAdapter } = await import('../src/lib/sources');
  const { CHAPTER_RETRY_CAP } = await import('../src/lib/updater');
  const asked: number[] = [];
  registerAdapter(sixChapterSource('upd-newest-behind', asked) as any);
  await mkSeries('newestbehind', 'upd-newest-behind');
  // Latest-2 taken when the source listed five: floor 4, chapters 4 and 5 on the shelf, 6 released since.
  await q('UPDATE lib_series SET chapter_floor = 4 WHERE id = $1', [S('newestbehind')]);
  await q('DELETE FROM lib_books WHERE series_id = $1', [S('newestbehind')]);
  for (const n of [4, 5]) await book('newestbehind', n);
  await q('DELETE FROM source_health WHERE source_id = $1', ['upd-newest-behind']);
  // A stale cap on chapter 6 from an earlier failed sweep: a person asking for it on purpose resets it,
  // exactly as the series page's Fetch does.
  await q('DELETE FROM chapter_failures WHERE series_id = $1', [S('newestbehind')]);
  await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, reason, attempts) VALUES ($1, 6, 'upd-newest-behind', 'incomplete', 'x', $2)`,
    [S('newestbehind'), CHAPTER_RETRY_CAP]);
  globalThis.fetch = (async () => png()) as typeof fetch;

  const r = await updateSeries(S('newestbehind'), 5, { newestOnly: true });
  assert.deepEqual(r.newest, { number: 6, state: 'queued' });
  assert.deepEqual(asked, [6], 'one number, the newest, whatever maxNew allows');
  assert.equal(r.added, 1);
  assert.ok(onDisk('newestbehind', 6));
  assert.equal(await floorOf('newestbehind'), 4, 'the floor stays where Latest-N put it');
  const ledger = await q('SELECT 1 FROM chapter_failures WHERE series_id = $1 AND number = 6', [S('newestbehind')]);
  assert.equal(ledger.length, 0, 'the retry cap was reset for that number and the landed chapter left no ledger row');
});

/**
 * The gates the fetch route applies, applied here so a bulk button cannot reach past them: a source the
 * admin disabled fetches nothing, and an adult source on a capped account fetches nothing -- each says so,
 * and neither asks the source for a page. Reintroduce by dropping BOTH `isDisabled` checks (the filter
 * before the listing and the verdict branch: the first verdict reads `queued` and asked reads [6]) or the
 * `sourceAllowed` branch (the second does).
 */
test('fetch newest honours a disabled source and the viewer\'s age gate, and says which stopped it', { skip }, async () => {
  const { registerAdapter } = await import('../src/lib/sources');
  const { setDisabled } = await import('../src/lib/sourceHealth');
  const asked: number[] = [];
  registerAdapter(sixChapterSource('upd-newest-gate', asked) as any);
  await mkSeries('newestgate', 'upd-newest-gate');
  await q('DELETE FROM lib_books WHERE series_id = $1', [S('newestgate')]);
  await q('DELETE FROM source_health WHERE source_id = $1', ['upd-newest-gate']);
  globalThis.fetch = (async () => png()) as typeof fetch;

  await setDisabled('upd-newest-gate', true);
  try {
    const off = await updateSeries(S('newestgate'), 1, { newestOnly: true });
    // No number: the disabled source was never asked what it lists (the test below pins that).
    assert.deepEqual(off.newest, { number: null, state: 'disabled' });
    assert.equal(off.added, 0);
  } finally {
    await setDisabled('upd-newest-gate', false);
  }
  const capped = await updateSeries(S('newestgate'), 1, { newestOnly: true, sourceAllowed: () => false });
  assert.deepEqual(capped.newest, { number: 6, state: 'denied' });
  assert.deepEqual(asked, [], 'neither gate let a page be asked for');
  assert.ok(!onDisk('newestgate', 6));
});

/**
 * After Delete files + Put back every row of the series is a tombstone with pruned_reason 'deleted', and
 * the series page shows the chapter as deleted from the server. Select it and press Fetch newest: the
 * have-set rightly holds the number (the sweep must not undo a deliberate deletion every night), but the
 * old verdict was `up_to_date` and the person read "Chapter 6 is already here." over a row with no pages
 * behind it -- for the very chapter they pressed the button to get back. A tombstone with no live row
 * beside it is now `deleted`; a live row beside a tombstone of the same number is what it always was.
 * Reintroduce by answering `up_to_date` for every held number (dropping the `live.has` test in the
 * newestOnly verdict): the first assertion reads up_to_date.
 */
test('a newest chapter deleted on purpose is told apart from one we hold, and is not fetched back', { skip }, async () => {
  const { registerAdapter } = await import('../src/lib/sources');
  const asked: number[] = [];
  registerAdapter(sixChapterSource('upd-newest-del', asked) as any);
  await mkSeries('newestdel', 'upd-newest-del');
  await q('DELETE FROM lib_books WHERE series_id = $1', [S('newestdel')]);
  for (const n of [4, 5, 6]) await book('newestdel', n);
  await q('DELETE FROM source_health WHERE source_id = $1', ['upd-newest-del']);
  globalThis.fetch = (async () => png()) as typeof fetch;

  // Exactly as deleteSeriesFiles (lib/libraryAdmin.ts) leaves the row.
  await q(`UPDATE lib_books SET pruned_at = now(), pruned_reason = 'deleted' WHERE id = $1`, [`${S('newestdel')}_b6`]);
  const del = await updateSeries(S('newestdel'), 1, { newestOnly: true });
  assert.deepEqual(del.newest, { number: 6, state: 'deleted' }, 'a Delete-files tombstone of the newest number is "deleted", not "already here"');
  assert.equal(del.added, 0);
  assert.deepEqual(asked, [], 'and it is not fetched: the deletion was on purpose, and Fetch again is the way back');

  // The cleanup's tombstone (reason NULL) is the same decision, made by a setting rather than a button.
  await q(`UPDATE lib_books SET pruned_reason = NULL WHERE id = $1`, [`${S('newestdel')}_b6`]);
  const cleaned = await updateSeries(S('newestdel'), 1, { newestOnly: true });
  assert.equal(cleaned.newest?.state, 'deleted');

  // A live row for the number beside the tombstone -- the chapter was fetched again into a fresh row
  // while the old one kept its mark -- is a chapter we hold. Live wins.
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages) VALUES ($1, $2, 'T!upd', $3, 6, 'Chapter 6', 1)`,
    [`${S('newestdel')}_b6again`, S('newestdel'), `${S('newestdel')}/Chapter 6 - again.cbz`]);
  const again = await updateSeries(S('newestdel'), 1, { newestOnly: true });
  assert.deepEqual(again.newest, { number: 6, state: 'up_to_date' }, 'a live row beside the tombstone means we have it');
  assert.deepEqual(asked, []);
  assert.ok(!onDisk('newestdel', 6));
});

/**
 * The verdict's `isDisabled` check sits after the listing, which for the sweep is the right place (a
 * disabled adapter stays loaded and the listing keeps the series page's ghost rows current). A bulk
 * button over 500 series on one disabled source would ask that source for 500 listings, 1.5 s apiece,
 * to say "disabled" 500 times. Fetch newest filters a disabled source out before the listing loop; a
 * series whose every source is disabled is its verdict with no network call, and a series that also
 * follows a live source is asked on that one only.
 * Reintroduce by dropping the newestOnly filter over `followed` before the listing loop: the first
 * assertion below counts one listing call (the verdict still reads disabled, from the later check).
 */
test('a disabled source is never asked for its listing by fetch newest; a live follower still is', { skip }, async () => {
  const { registerAdapter } = await import('../src/lib/sources');
  const { setDisabled } = await import('../src/lib/sourceHealth');
  const listed: string[] = [];
  const counting = (id: string) => ({
    ...sixChapterSource(id, []),
    async listChapters() { listed.push(id); return [1, 2, 3, 4, 5, 6].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `c${n}` })); },
  });
  registerAdapter(counting('upd-newest-off') as any);
  registerAdapter(counting('upd-newest-off-ext') as any);
  await mkSeries('newestoff', 'upd-newest-off');
  await q('DELETE FROM lib_books WHERE series_id = $1', [S('newestoff')]);
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [['upd-newest-off', 'upd-newest-off-ext']]);
  globalThis.fetch = (async () => png()) as typeof fetch;

  await setDisabled('upd-newest-off', true);
  try {
    const off = await updateSeries(S('newestoff'), 1, { newestOnly: true });
    assert.equal(listed.filter((id) => id === 'upd-newest-off').length, 0, 'the disabled source was never asked for its listing');
    assert.deepEqual(off.newest, { number: null, state: 'disabled' });
    assert.equal(off.asked, false, 'and the run says no source was asked, so the bulk job does not pace for it');

    // Followed on a second, live source as well: that one is asked, the disabled one still is not, and
    // the newest release comes through it.
    await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, 'upd-newest-off-ext', 'ext-off') ON CONFLICT DO NOTHING`, [S('newestoff')]);
    const viaExt = await updateSeries(S('newestoff'), 1, { newestOnly: true });
    assert.deepEqual(listed, ['upd-newest-off-ext'], 'only the live follower was asked');
    assert.deepEqual(viaExt.newest, { number: 6, state: 'queued' });
    assert.equal(viaExt.added, 1);
    assert.equal(viaExt.asked, true);
    assert.ok(onDisk('newestoff', 6));
  } finally {
    await setDisabled('upd-newest-off', false);
    await q('DELETE FROM series_sources WHERE series_id = $1', [S('newestoff')]).catch(() => {});
  }
});


// ---- v0.31.0: which copy of a chapter, from which group, from which source ----------------------------
//
// A source can list one number several times (MangaDex: one row per group), and a series can be followed
// on more than one source. The updater now merges every listing it is given, hands the lot to
// chooseReleases (lib/releases.ts) with the series' preferences, and fetches ONE copy per number; what it
// fetched is stamped on the book (setBookMeta) and written into the file (ComicInfo <Translator>).

/** One adapter whose listing each test below sets; `asked` records the chapter ids it was asked pages for. */
const SRC_GRP = 'upd-grp';
let grpList: any[] = [];
const grpAsked: string[] = [];
/** A primary and a follower for the multi-source tests; page urls carry the adapter so fetch can refuse one. */
const SRC_PRI = 'upd-pri', SRC_EXT = 'upd-ext';
const priAsked: string[] = [];
const extAsked: string[] = [];
const numbered = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ number: i + 1, title: `Chapter ${i + 1}`, sourceId: `${prefix}${i + 1}` }));
const bookRow = (key: string, n: number) =>
  (q(`SELECT series_id, scanlator, source_id FROM lib_books WHERE file LIKE $1`, [`%${S(key)}/Chapter ${n}.cbz`]) as Promise<any[]>).then((r) => r[0]);
const comicInfo = (key: string, n: number): string => {
  const AdmZip = require('adm-zip');
  return new AdmZip(join(ROOT, S(key), `Chapter ${n}.cbz`)).readAsText('ComicInfo.xml');
};

before(async () => {
  if (!DSN) return;
  const { registerAdapter } = await import('../src/lib/sources');
  registerAdapter({
    id: SRC_GRP, name: SRC_GRP,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: SRC_GRP, title: sid }; },
    async listChapters() { return grpList; },
    async getPageUrls(chId: string) { grpAsked.push(chId); return ['https://example.invalid/grp/page.png']; },
    async latest() { return []; },
  } as any);
  registerAdapter({
    id: SRC_PRI, name: SRC_PRI,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: SRC_PRI, title: sid }; },
    async listChapters() { return numbered(5, 'p'); },
    async getPageUrls(chId: string) { priAsked.push(chId); return [`https://example.invalid/pri/${chId}.png`]; },
    async latest() { return []; },
  } as any);
  registerAdapter({
    id: SRC_EXT, name: SRC_EXT,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: SRC_EXT, title: sid }; },
    async listChapters() { return numbered(6, 'e'); },
    async getPageUrls(chId: string) { extAsked.push(chId); return [`https://example.invalid/ext/${chId}.png`]; },
    async latest() { return []; },
  } as any);
});

after(async () => {
  if (!DSN) return;
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[SRC_GRP, SRC_PRI, SRC_EXT]]).catch(() => {});
});

/**
 * Reintroduce by replacing the chooseReleases call with `{ releases: tagged, waiting: [] }`: the loop takes
 * the copies in listed order, A's id is asked for first, and "the preferred group's copy was fetched" fails.
 * Reintroduce the stamp by dropping the setBookMeta call after persistScan in runUpdateAll: the file lands,
 * the scan mints the row, and "stamped who released it" reads null.
 */
test('the preferred group\'s copy is the one fetched, and the file and the book both say so', { skip }, async () => {
  grpList = [
    { number: 6, title: 'Chapter 6', sourceId: 'g6a', scanlator: 'A' },
    { number: 6, title: 'Chapter 6', sourceId: 'g6b', scanlator: 'B' },
  ];
  grpAsked.length = 0;
  await mkSeries('grp', SRC_GRP);
  await q(`UPDATE lib_series SET scanlator_prefs = '{"priority":["B"]}' WHERE id = $1`, [S('grp')]);
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC_GRP]);
  await only(['grp']);
  globalThis.fetch = (async () => png()) as typeof fetch;

  const r = await runUpdateAll({ maxNew: 5 });

  assert.equal(r.added, 1, 'one number, one file');
  assert.deepEqual(grpAsked, ['g6b'], `the preferred group's copy was fetched, not the first listed; asked: ${grpAsked}`);
  assert.ok(onDisk('grp', 6));
  assert.match(comicInfo('grp', 6), /<Translator>B<\/Translator>/, 'the file carries the group in ComicInfo');
  const b = await bookRow('grp', 6);
  assert.ok(b, 'the sweep scanned the file into a book');
  assert.equal(b.scanlator, 'B', 'and stamped who released it');
  assert.equal(b.source_id, SRC_GRP, 'and where it came from');
});

/**
 * Reintroduce by passing `{ ...prefs, patienceMs: 0 }` to chooseReleases: the first run fetches A's copy
 * and "held for the preferred group" fails on added.
 */
test('a number whose preferred group has not released yet is held, counted as behind, and not fetched', { skip }, async () => {
  grpList = [{ number: 7, title: 'Chapter 7', sourceId: 'g7a', scanlator: 'A', publishedAt: new Date().toISOString() }];
  grpAsked.length = 0;
  await mkSeries('pat', SRC_GRP);
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC_GRP]);
  globalThis.fetch = (async () => png()) as typeof fetch;

  // patienceDays null on the series: the global default (2 days) applies.
  await q(`UPDATE lib_series SET scanlator_prefs = '{"priority":["B"]}' WHERE id = $1`, [S('pat')]);
  const held = await updateSeries(S('pat'), 5);
  assert.equal(held.added, 0, 'held for the preferred group');
  assert.equal(held.waiting, 1, 'and the run says how many it is holding');
  assert.equal(held.outcome, 'ok', 'holding is not a failure');
  assert.deepEqual(grpAsked, [], 'nothing was asked for');
  assert.equal((await stamp('pat')).m, 1, 'a held number is still a missing one: "1 behind" on the series page');
  assert.equal((await stamp('pat')).c, 1);

  // Patience off for this series: the same listing is taken now.
  await q(`UPDATE lib_series SET scanlator_prefs = '{"priority":["B"],"patienceDays":0}' WHERE id = $1`, [S('pat')]);
  const taken = await updateSeries(S('pat'), 5);
  assert.equal(taken.added, 1, 'with no patience, the copy on offer is taken');
  assert.equal(taken.waiting, 0);
  assert.deepEqual(grpAsked, ['g7a']);
});

/**
 * Reintroduce by dropping the `!have.has(c.number)` filter from `missing`: B is asked for chapter 5 and
 * "a chapter on disk is not fetched again" fails.
 */
test('a chapter already on disk is never replaced by a better-ranked group\'s copy', { skip }, async () => {
  grpList = [
    { number: 5, title: 'Chapter 5', sourceId: 'g5a', scanlator: 'A' },
    { number: 5, title: 'Chapter 5', sourceId: 'g5b', scanlator: 'B' },
  ];
  grpAsked.length = 0;
  await mkSeries('keep', SRC_GRP);
  await q(`UPDATE lib_series SET scanlator_prefs = '{"priority":["B"]}' WHERE id = $1`, [S('keep')]);
  // Chapter 5 landed from A on an earlier run, as the row the scan would have minted for it.
  await q('DELETE FROM lib_books WHERE series_id = $1', [S('keep')]);
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, scanlator, source_id) VALUES ($1, $2, 'T!upd', $3, 5, 'Chapter 5', 1, 'A', $4)`,
    [`${S('keep')}_b5`, S('keep'), `${S('keep')}/Chapter 5.cbz`, SRC_GRP]);
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC_GRP]);
  globalThis.fetch = (async () => png()) as typeof fetch;

  const r = await updateSeries(S('keep'), 5);

  assert.deepEqual(grpAsked, [], `a chapter on disk is not fetched again, whoever released it; asked: ${grpAsked}`);
  assert.equal(r.added, 0);
  assert.equal((await stamp('keep')).m, 0, 'and it is not "behind" either');
  const b = await bookRow('keep', 5);
  assert.equal(b.scanlator, 'A', 'the stamp still names the group whose file is on disk');
});

/**
 * Reintroduce by passing `releases` instead of `landed` to setBookMeta in updateSeries: chapter 5's row is
 * relabelled B while A's file is what is on disk, and "a book that did not land keeps its stamp" fails.
 */
test('only the chapters that landed are stamped; a book from an earlier run keeps its group', { skip }, async () => {
  grpList = [
    { number: 5, title: 'Chapter 5', sourceId: 'g5b', scanlator: 'B' },
    { number: 6, title: 'Chapter 6', sourceId: 'g6b', scanlator: 'B' },
  ];
  grpAsked.length = 0;
  await mkSeries('stamp', SRC_GRP);
  await q('DELETE FROM lib_books WHERE series_id = $1', [S('stamp')]);
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, scanlator, source_id) VALUES ($1, $2, 'T!upd', $3, 5, 'Chapter 5', 1, 'A', $4)`,
    [`${S('stamp')}_b5`, S('stamp'), `${S('stamp')}/Chapter 5.cbz`, SRC_GRP]);
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC_GRP]);
  globalThis.fetch = (async () => png()) as typeof fetch;

  const r = await updateSeries(S('stamp'), 5);

  assert.equal(r.added, 1);
  assert.deepEqual(r.landed, [{ number: 6, scanlator: 'B', source: SRC_GRP }], 'the run reports what landed, for the stamp after the scan');
  assert.equal((await bookRow('stamp', 5)).scanlator, 'A', 'a book that did not land keeps its stamp');
});

/**
 * Reintroduce by iterating `followed.slice(0, 1)` in the listing loop: the follower is never asked, chapter
 * 6 is never seen, and "five from the primary and one from the follower" fails with added 5. Reintroduce
 * the count by stamping `tagged.length` instead of `releases.length`: "source_chapters is the union of
 * NUMBERS" fails, reading 11 copies where there are 6 numbers.
 */
test('a series followed on two sources takes what the primary has and the rest from the follower', { skip }, async () => {
  priAsked.length = 0; extAsked.length = 0;
  await mkSeries('two', SRC_PRI);
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, $2, 'ext-two') ON CONFLICT DO NOTHING`, [S('two'), SRC_EXT]);
  await q('DELETE FROM lib_books WHERE series_id = $1', [S('two')]);
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[SRC_PRI, SRC_EXT]]);
  await only(['two']);
  globalThis.fetch = (async () => png()) as typeof fetch;

  const r = await runUpdateAll({ maxNew: 6 });

  assert.equal(r.added, 6, 'five from the primary and one from the follower');
  assert.deepEqual(extAsked, ['e6'], `chapter 6 came from the follower, and only chapter 6; asked: ${extAsked}`);
  assert.deepEqual(priAsked, ['p1', 'p2', 'p3', 'p4', 'p5'], 'the primary wins every number it has');
  assert.ok(onDisk('two', 6));
  assert.equal((await bookRow('two', 6)).source_id, SRC_EXT, 'the book says which adapter it came from');
  assert.equal((await bookRow('two', 1)).source_id, SRC_PRI);
  const st = await stamp('two');
  assert.equal(st.c, 6, 'source_chapters is the union of NUMBERS the sources listed, not the number of copies');
  const ext = (await q('SELECT checked_at, chapters FROM series_sources WHERE series_id = $1 AND source_id = $2', [S('two'), SRC_EXT]))[0];
  assert.ok(ext.checked_at, 'the follower carries its own checked stamp');
  assert.equal(ext.chapters, 6, 'and what it listed');
});

/**
 * A series whose primary adapter is gone -- the extension was uninstalled, or its language hidden -- but
 * which follows a source that is still here keeps updating from that source. That is what following is
 * for, and it is what the Health page says when it lists such a series as reference rather than frozen.
 *
 * Reintroduce by returning 'unrouted' when the PRIMARY adapter is missing (the check that used to run
 * before series_sources was read): the follower is never asked and "the follower is asked" fails with
 * outcome 'unrouted'.
 */
test('a dead primary with a live follower still updates from the follower', { skip }, async () => {
  extAsked.length = 0;
  await mkSeries('deadpri', 'sw:0000000000000000000'); // an adapter that is not loaded
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, $2, 'ext-two') ON CONFLICT DO NOTHING`, [S('deadpri'), SRC_EXT]);
  await q('DELETE FROM lib_books WHERE series_id = $1', [S('deadpri')]);
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC_EXT]);
  await only(['deadpri']);
  globalThis.fetch = (async () => png()) as typeof fetch;

  // Through the sweep, which scans what landed; updateSeries alone leaves the rows for the next scan.
  const r = await runUpdateAll({ maxNew: 10 });
  assert.equal(r.outcomes.unrouted ?? 0, 0, `the follower is asked; outcomes ${JSON.stringify(r.outcomes)}`);
  assert.ok(extAsked.length >= 1, 'the follower served the chapters');
  assert.equal(r.added, 6);
  assert.equal((await bookRow('deadpri', 6)).source_id, SRC_EXT);
});

/**
 * Reintroduce by returning 'blocked' when `blocked > 0` instead of when every followed source is: the
 * follower is never listed and "a cooldown on the primary does not stop the follower" fails.
 */
test('a cooldown on the primary does not stop the follower; a cooldown on both is a blocked series', { skip }, async () => {
  priAsked.length = 0; extAsked.length = 0;
  await mkSeries('blk', SRC_PRI);
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, $2, 'ext-blk') ON CONFLICT DO NOTHING`, [S('blk'), SRC_EXT]);
  // 1..5 are on disk; only the follower lists 6.
  await q('DELETE FROM lib_books WHERE series_id = $1', [S('blk')]);
  for (const n of [1, 2, 3, 4, 5]) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages) VALUES ($1, $2, 'T!upd', $3, $4, $5, 1)`,
      [`${S('blk')}_b${n}`, S('blk'), `${S('blk')}/Chapter ${n}.cbz`, n, `Chapter ${n}`]);
  }
  const block = (id: string) => q(`INSERT INTO source_health (source_id, status, blocked_until) VALUES ($1, 'blocked', now() + interval '1 hour')
    ON CONFLICT (source_id) DO UPDATE SET blocked_until = now() + interval '1 hour'`, [id]);
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[SRC_PRI, SRC_EXT]]);
  globalThis.fetch = (async () => png()) as typeof fetch;
  try {
    await block(SRC_PRI);
    const r = await updateSeries(S('blk'), 5);
    assert.equal(r.outcome, 'ok', 'a cooldown on the primary does not stop the follower');
    assert.equal(r.added, 1);
    assert.deepEqual(extAsked, ['e6']);
    assert.deepEqual(priAsked, [], 'the primary was left alone');
    assert.ok(onDisk('blk', 6));

    await block(SRC_EXT);
    await q('UPDATE lib_series SET source_checked_at = NULL WHERE id = $1', [S('blk')]);
    assert.equal((await updateSeries(S('blk'), 5)).outcome, 'blocked', 'with every source in a cooldown, the series is blocked');
    assert.equal((await stamp('blk')).t, null, 'and, never asked, it is not stamped');
  } finally {
    await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[SRC_PRI, SRC_EXT]]);
  }
});

/**
 * Reintroduce by ending the loop on the primary's refusal, or by skipping same-number copies: chapters 1
 * and 2 never move to the follower and chapter 3 is never reached. One refusal is still only one strike.
 */
test('a refusing primary costs one strike and does not stop the follower\'s chapters', { skip }, async () => {
  const { registerAdapter } = await import('../src/lib/sources');
  // The primary lists 1..2 and the follower 1..3. The refusal on primary chapter 1 moves chapters 1 and 2
  // to their same-number follower copies; chapter 3 was already chosen from the follower.
  registerAdapter({
    id: 'upd-pri2', name: 'upd-pri2',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: 'upd-pri2', title: sid }; },
    async listChapters() { return numbered(2, 'q'); },
    async getPageUrls(chId: string) { priAsked.push(chId); return [`https://example.invalid/refused/${chId}.png`]; },
    async latest() { return []; },
  } as any);
  registerAdapter({
    id: 'upd-ext2', name: 'upd-ext2',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: 'upd-ext2', title: sid }; },
    async listChapters() { return numbered(3, 'f'); },
    async getPageUrls(chId: string) { extAsked.push(chId); return [`https://example.invalid/ext/${chId}.png`]; },
    async latest() { return []; },
  } as any);
  priAsked.length = 0; extAsked.length = 0;
  await mkSeries('ref', 'upd-pri2');
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, 'upd-ext2', 'ext-ref') ON CONFLICT DO NOTHING`, [S('ref')]);
  await q('DELETE FROM lib_books WHERE series_id = $1', [S('ref')]);
  await q('DELETE FROM chapter_failures WHERE series_id = $1', [S('ref')]);
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [['upd-pri2', 'upd-ext2']]);
  globalThis.fetch = (async (u: any) => (String(u).includes('/refused/') ? new Response('go away', { status: 403 }) : png())) as typeof fetch;
  try {
    const r = await updateSeries(S('ref'), 5);
    assert.equal(priAsked.length, 1, `the refusing primary was asked once, not for chapter 2 as well; asked: ${priAsked}`);
    assert.deepEqual(extAsked, ['f1', 'f2', 'f3'], 'each number landed from the healthy follower');
    for (const n of [1, 2, 3]) assert.ok(onDisk('ref', n), `chapter ${n} landed`);
    assert.equal(r.added, 3);
    assert.equal(r.failed, 0, 'a recovered refusal is not a chapter failure');
    assert.equal(r.switched, 2, 'the two primary copies report their source switch');
    assert.equal(Number((await q('SELECT count(*)::int AS n FROM chapter_failures WHERE series_id = $1', [S('ref')]))[0]?.n), 0,
      'a chapter recovered from its alternate leaves no retry-ledger row');
    const h = (await q('SELECT consecutive FROM source_health WHERE source_id = $1', ['upd-pri2']))[0];
    assert.equal(Number(h?.consecutive), 1, 'one refusal is one strike');
  } finally {
    await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [['upd-pri2', 'upd-ext2']]);
    await q('DELETE FROM chapter_failures WHERE series_id = $1', [S('ref')]).catch(() => {});
  }
});
