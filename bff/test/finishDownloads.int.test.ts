// "Finish downloads on their own" (lib/finishDownloads.ts), and the gap rule that stopped counting numbers no source
// lists as missing chapters.
//
// The owner's report, 2026-10-17: series added from Discover met a rate limit or a block in their first chapters and
// stayed that way. The add was a one-shot job; the six-hourly sweep took five chapters a run, and none at all while the
// site was cooling down; and a refusal counted toward the same three strikes as a broken chapter, after which nothing
// asked again. A series whose very first chapter was refused was not even saved. And Health said Tales of Demons and
// Gods was missing 306 chapters: numbers none of the sites it follows lists, another site's numbering of chapters the
// library already had.
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
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-fin-'));
  process.env.DL_ROOT = ROOT;
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.DOWNLOAD_RESUME_WAIT_MS = '0,0,0'; // a 429 is waited out in rounds of seconds in production
  process.env.MIN_FREE_GB = '0'; // the disk floor belongs to diskGuard.test.ts
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_fin';
/** Lists chapters 1-3 of every title and serves their pages. Records which titles were asked, and which chapters. */
const FIN = 'fin-ok';
/** Lists chapters 1-3 of one title; every page answers 429. */
const REF = 'fin-refuse';
/** v0.79.0: in a cooldown before the add starts; its pages would be fine. */
const COOLED = 'fin-cooled';
/** v0.79.0: its chapters' page lists answer 429. */
const PLREF = 'fin-plref';
const S = (k: string) => `s_fin_${k}`;
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const realFetch = globalThis.fetch;
/** The titles (source series ids) fin-ok was asked to list, and the chapters (`<title>:<n>`) it was asked pages for. */
const listed = new Set<string>();
const asked: string[] = [];
let q: any;

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  await migrate();
  registerAdapter({
    id: FIN, name: 'Fin OK',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: FIN, title: sid }; },
    async listChapters(sid: string) {
      listed.add(sid);
      return [1, 2, 3].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `${sid}:${n}` }));
    },
    async getPageUrls(chId: string) { asked.push(chId); return [`https://example.invalid/fin/${encodeURIComponent(chId)}.png`]; },
    async latest() { return []; },
  } as any);
  registerAdapter({
    id: REF, name: 'Fin Refuse',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: REF, title: sid === `${REF}-off` ? 'Refused Off' : 'Refused First' }; },
    async listChapters() { return [1, 2, 3].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `r${n}`, pages: 1 })); },
    async getPageUrls(chId: string) { return [`https://example.invalid/refuse/${chId}.png`]; },
    async latest() { return []; },
  } as any);
  registerAdapter({
    id: COOLED, name: 'Fin Cooled',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: COOLED, title: 'Cooled At Start' }; },
    async listChapters() { return [1, 2, 3].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `k${n}`, pages: 1 })); },
    async getPageUrls(chId: string) { return [`https://example.invalid/fin/${chId}.png`]; },
    async latest() { return []; },
  } as any);
  registerAdapter({
    id: PLREF, name: 'Fin Page List',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: PLREF, title: 'Page List Refused' }; },
    async listChapters() { return [1, 2, 3].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `l${n}`, pages: 1 })); },
    // The chapter's page list itself answers 429, as an engine relays a site's refusal.
    async getPageUrls() { throw new Error('suwayomi: HTTP error 429 Too Many Requests'); },
    async latest() { return []; },
  } as any);
  globalThis.fetch = (async (u: any) => (String(u).includes('/refuse/')
    ? new Response('slow down', { status: 429, headers: { 'retry-after': '1' } })
    : new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } }))) as typeof fetch;
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Fin',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
});

after(async () => {
  globalThis.fetch = realFetch;
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  await q('UPDATE server_settings SET finish_downloads = true WHERE id = 1').catch(() => {});
  await q(`DELETE FROM lib_books WHERE series_id LIKE 's_fin_%'`).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id LIKE 's_fin_%' OR folder LIKE 'Fin Refuse/%' OR library_id = $1`, [LIB]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[FIN, REF, COOLED, PLREF]]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE folder LIKE 'Fin Cooled/%' OR folder LIKE 'Fin Page List/%'`).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
});

/** A series on fin-ok under `title`, holding nothing, updates on. */
const mk = (key: string, title: string) =>
  q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
     VALUES ($1,'T!fin',$1,$1,0,$2,$3,$4,true) ON CONFLICT (id) DO NOTHING`, [S(key), LIB, FIN, title]);
const quiet = { info() {}, warn() {}, error() {} };

test('the finishing sweep visits only the series that are behind, and leaves the full sweep\'s clock alone', { skip }, async () => {
  const { runSweep } = await import('../src/lib/updater');
  await mk('behind', 'behind');
  await mk('caught', 'caught');
  await mk('never', 'never');
  await q('UPDATE lib_series SET source_checked_at = now(), source_missing = 2 WHERE id = $1', [S('behind')]);
  await q('UPDATE lib_series SET source_checked_at = now(), source_missing = 0 WHERE id = $1', [S('caught')]);
  const stamp = new Date('2026-01-02T03:04:05Z');
  await q('UPDATE server_settings SET updater_last_run = $1 WHERE id = 1', [stamp]);
  const lastRun = async () => new Date((await q('SELECT updater_last_run AS t FROM server_settings WHERE id = 1'))[0].t).getTime();
  try {
    listed.clear();
    const run = runSweep({ maxNew: 10, sweepMax: 60, finishing: true }, quiet);
    assert.notEqual(run, false, 'PREMISE: no other sweep is running');
    const r = await run;
    // Reintroduce by dropping the behind filter (lib/updater.ts runUpdateAll behindOnly): the caught-up one is asked.
    assert.ok(listed.has('behind'), 'a series its source lists more chapters for is visited');
    assert.ok(listed.has('never'), 'and so is one no sweep has checked yet: an add the site refused');
    assert.ok(!listed.has('caught'), 'a caught-up series is not asked');
    assert.ok((r?.added ?? 0) >= 6, `and what they were behind on landed (${r?.added})`);
    // Reintroduce by persisting the finishing sweep as the last run (lib/updater.ts runSweep `finishing`): it moves.
    assert.equal(await lastRun(), stamp.getTime(), 'the finishing sweep is not the full sweep: the interval it resumes from stays');

    listed.clear();
    await runSweep({ maxNew: 10, sweepMax: 60 }, quiet);
    assert.ok(listed.has('caught'), 'PREMISE: the full sweep asks every series');
    assert.notEqual(await lastRun(), stamp.getTime(), 'PREMISE: and moves the clock, so the assertion above can fail');
  } finally {
    await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [[S('behind'), S('caught'), S('never')]]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [[S('behind'), S('caught'), S('never')]]).catch(() => {});
  }
});

test('a series behind only on chapters it leaves alone is not gone back for', { skip }, async () => {
  const { CHAPTER_RETRY_CAP, updateSeries, runSweep } = await import('../src/lib/updater');
  await mk('stuck', 'stuck');
  await mk('owed', 'owed');
  // Every chapter of `stuck` broke three times: the sweep leaves all three alone. `owed` has one that did, and two it fetches.
  await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, reason, attempts)
           VALUES ($1, 1, $3, 'incomplete', 'x', $4), ($1, 2, $3, 'incomplete', 'x', $4), ($1, 3, $3, 'incomplete', 'x', $4),
                  ($2, 1, $3, 'incomplete', 'x', $4)`, [S('stuck'), S('owed'), FIN, CHAPTER_RETRY_CAP]);
  // `owed`'s two land on this visit; stopping them would need a refusing fetch, so its count is read back first.
  globalThis.fetch = (async (u: any) => (String(u).includes('/refuse/') || String(u).includes('owed')
    ? new Response('broken', { status: 500 })
    : new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } }))) as typeof fetch;
  const behind = async (k: string) => (await q('SELECT source_missing, finish_missing FROM lib_series WHERE id = $1', [S(k)]))[0];
  try {
    await updateSeries(S('stuck'), 5);
    await updateSeries(S('owed'), 5);
    // Reintroduce by stamping `missing.length` (lib/updater.ts visitSeries finish_missing): finish_missing reads 3 here.
    assert.deepEqual(await behind('stuck'), { source_missing: 3, finish_missing: 0 }, 'three behind, none of them still tried');
    assert.equal((await behind('owed')).finish_missing, 2, 'PREMISE: what it still tries is counted');
    await q('DELETE FROM source_health WHERE source_id = $1', [FIN]); // the 500s' cooldown, or nothing is asked at all
    listed.clear();
    await runSweep({ maxNew: 10, sweepMax: 60, finishing: true }, quiet);
    assert.ok(!listed.has('stuck'), 'a series behind only on chapters left alone is not asked for its list again');
    assert.ok(listed.has('owed'), 'PREMISE: one with chapters still tried is');
  } finally {
    globalThis.fetch = (async (u: any) => (String(u).includes('/refuse/')
      ? new Response('slow down', { status: 429, headers: { 'retry-after': '1' } })
      : new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } }))) as typeof fetch;
    await q('DELETE FROM source_health WHERE source_id = $1', [FIN]).catch(() => {});
    await q('DELETE FROM chapter_failures WHERE series_id = ANY($1)', [[S('stuck'), S('owed')]]).catch(() => {});
    await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [[S('stuck'), S('owed')]]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [[S('stuck'), S('owed')]]).catch(() => {});
  }
});

test('a refused chapter is tried past three with the switch on, and left at three with it off', { skip }, async () => {
  const { CHAPTER_RETRY_CAP, updateSeries } = await import('../src/lib/updater');
  const { REFUSAL_RETRY_CAP } = await import('../src/lib/finishDownloads');
  assert.ok(REFUSAL_RETRY_CAP > CHAPTER_RETRY_CAP, 'PREMISE: the refusal cap is the higher one');
  await mk('cap', 'cap');
  /** One update of a series holding nothing whose chapter 1 was refused `refusals` times and chapter 2 broke three. */
  const round = async (refusals: number): Promise<number[]> => {
    await q('DELETE FROM chapter_failures WHERE series_id = $1', [S('cap')]);
    await q('DELETE FROM lib_books WHERE series_id = $1', [S('cap')]);
    rmSync(join(ROOT, S('cap')), { recursive: true, force: true });
    await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, reason, attempts)
             VALUES ($1, 1, $2, 'rate_limited', 'HTTP 429', $3), ($1, 2, $2, 'incomplete', 'x', $4)`, [S('cap'), FIN, refusals, CHAPTER_RETRY_CAP]);
    asked.length = 0;
    await updateSeries(S('cap'), 5);
    return asked.filter((c) => c.startsWith('cap:')).map((c) => Number(c.slice(4))).sort((a, b) => a - b);
  };
  try {
    // Reintroduce by capping every status at CHAPTER_RETRY_CAP (lib/updater.ts visitSeries cappedNums): [3].
    assert.deepEqual(await round(CHAPTER_RETRY_CAP), [1, 3], 'on (the default), a chapter refused three times is asked again; one that broke three times is not');
    assert.deepEqual(await round(REFUSAL_RETRY_CAP), [3], 'until the refusal cap');
    await q('UPDATE server_settings SET finish_downloads = false WHERE id = 1');
    assert.deepEqual(await round(CHAPTER_RETRY_CAP), [3], 'off, a refusal is capped at three like any failure, as before');
  } finally {
    await q('UPDATE server_settings SET finish_downloads = true WHERE id = 1');
    await q('DELETE FROM chapter_failures WHERE series_id = $1', [S('cap')]).catch(() => {});
    await q('DELETE FROM lib_books WHERE series_id = $1', [S('cap')]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = $1', [S('cap')]).catch(() => {});
  }
});

test('Health says a refused chapter is still being tried', { skip }, async () => {
  const { CHAPTER_RETRY_CAP } = await import('../src/lib/updater');
  const { REFUSAL_RETRY_CAP } = await import('../src/lib/finishDownloads');
  const { runHealthChecks } = await import('../src/lib/health');
  await mk('hl', 'hl');
  // One chapter the site refused three times, one that broke three times.
  await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, reason, attempts)
           VALUES ($1, 1, $2, 'rate_limited', 'HTTP 429', $3), ($1, 2, $2, 'error', 'x', $3)`, [S('hl'), FIN, CHAPTER_RETRY_CAP]);
  const card = async () => (await runHealthChecks()).checks.find((x: any) => x.id === 'chapter-failures');
  const row = (c: any) => c.items.find((i: any) => i.sourceId === FIN);
  try {
    let c = await card();
    // Reintroduce by counting every status at CHAPTER_RETRY_CAP (lib/health.ts chapterFailures): "2 left alone".
    assert.match(row(c).detail, new RegExp(`, 1 left alone after ${CHAPTER_RETRY_CAP};`), 'only the broken one is left alone');
    assert.match(c.note, new RegExp(`tried up to ${REFUSAL_RETRY_CAP} times`), 'and the note says how long a refusal is tried');
    assert.doesNotMatch(c.note, /\.;/, 'the note joins its sentences as sentences');
    await q('UPDATE server_settings SET finish_downloads = false WHERE id = 1');
    c = await card();
    assert.match(row(c).detail, new RegExp(`, 2 left alone after ${CHAPTER_RETRY_CAP};`), 'off, a refusal is left alone at three, as before');
    assert.doesNotMatch(c.note, /Finish downloads on their own/);
  } finally {
    await q('UPDATE server_settings SET finish_downloads = true WHERE id = 1');
    await q('DELETE FROM chapter_failures WHERE series_id = $1', [S('hl')]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = $1', [S('hl')]).catch(() => {});
  }
});

test('an add whose first chapter a site refused keeps the series, behind', { skip }, async () => {
  const { addSeriesFromSource, jobBusy } = await import('../src/routes/sources');
  /** Waits for the detached add on `folder` to finish, then reads its row. */
  const settle = async (folder: string) => {
    const until = Date.now() + 20_000;
    while (Date.now() < until && jobBusy(folder)) await new Promise((r) => setTimeout(r, 100));
    assert.equal(jobBusy(folder), false, 'PREMISE: the add finished');
    return (await q(`SELECT id, source_checked_at, source_missing, source_chapters, chapter_floor, books_count FROM lib_series WHERE folder = $1`, [folder]))[0];
  };
  try {
    const r = await addSeriesFromSource({ source: REF, sourceId: `${REF}-1`, wait: false });
    assert.equal(r.started, true, r.message);
    const row = await settle('Fin Refuse/Refused First');
    // Reintroduce by answering the refusal alone (routes/sources.ts keepForLater): no row, and nothing to resume.
    assert.ok(row, 'the series is saved although no chapter landed');
    assert.equal(row.source_checked_at, null, 'never checked: the finishing sweep takes it first');
    assert.equal(Number(row.source_missing), 3, 'and behind by everything that was selected');
    assert.equal(Number(row.source_chapters), 3);
    assert.equal(row.chapter_floor, null, 'All has no floor');
    const listing = await q('SELECT number::float8 AS n FROM series_listing WHERE series_id = $1 ORDER BY number', [row.id]);
    assert.deepEqual(listing.map((x: any) => x.n), [1, 2, 3], 'its listing is written, as on any add');

    // Off, the add answers the refusal and keeps nothing, as before.
    await q('UPDATE server_settings SET finish_downloads = false WHERE id = 1');
    await q('DELETE FROM source_health WHERE source_id = $1', [REF]); // the first refusal's cooldown
    const off = await addSeriesFromSource({ source: REF, sourceId: `${REF}-off`, wait: false });
    assert.equal(off.started, true, off.message);
    assert.equal(await settle('Fin Refuse/Refused Off'), undefined, 'switched off, a refused first chapter keeps nothing');
  } finally {
    await q('UPDATE server_settings SET finish_downloads = true WHERE id = 1');
    await q(`DELETE FROM lib_series WHERE folder LIKE 'Fin Refuse/%'`).catch(() => {});
    await q('DELETE FROM source_health WHERE source_id = $1', [REF]).catch(() => {});
  }
});

test('a hole no source lists is not a missing chapter', { skip }, async () => {
  const { runHealthChecks } = await import('../src/lib/health');
  const { seriesGaps } = await import('../src/lib/seriesGaps');
  const { englishOf } = await import('../src/lib/said');
  const series = (key: string, title: string) =>
    q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'test',$2,$1) ON CONFLICT (id) DO NOTHING`, [S(key), title]);
  const books = async (key: string, nums: number[]) => {
    for (const n of nums) {
      await q(`INSERT INTO lib_books (id, series_id, source, file, title, number, pages) VALUES ($1,$2,'test',$3,$4,$5,20)
               ON CONFLICT (id) DO NOTHING`, [`b_${S(key)}_${n}`, S(key), `/test/${S(key)}/${n}.cbz`, `Chapter ${n}`, n]);
    }
  };
  const list = async (key: string, nums: number[]) => {
    for (const n of nums) {
      await q(`INSERT INTO series_listing (series_id, number, source_id, chosen) VALUES ($1,$2,'test','{}'::jsonb)
               ON CONFLICT (series_id, number) DO NOTHING`, [S(key), n]);
    }
  };
  // Some of the hole listed: 4-6 missing, 7-9 nobody's.
  await series('half', 'Half Listed Fixture');
  await books('half', [1, 2, 3, 10, 11, 12]);
  await list('half', [1, 2, 3, 4, 5, 6, 10, 11, 12]);
  // None of it listed: Tales' shape, a run between two held numbers that no source it follows has.
  await series('none', 'None Listed Fixture');
  await books('none', [1, 2, 3, 10, 11, 12]);
  await list('none', [1, 2, 3, 10, 11, 12]);
  // No source has ever answered for it: every hole counts, as before.
  await series('bare', 'Never Listed Fixture');
  await books('bare', [1, 2, 3, 10]);
  try {
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'chapter-gaps');
    const item = (k: string) => c.items.find((i: any) => i.seriesId === S(k));
    for (const it of c.items) assert.equal(englishOf(it.detailSaid), it.detail, `"${it.detail}": its codes say something else`);
    assert.equal(englishOf(c.summarySaid), c.summary);
    assert.equal(englishOf(c.noteSaid), c.note);

    const half = item('half');
    assert.notEqual(half.info, true, 'what a source lists is still a finding');
    assert.match(half.detail, /^3 missing — 4-6\b/, 'counted: only the listed part');
    assert.match(half.detail, /3 numbers none of its sources list — 7-9/, 'and the rest said apart');
    assert.ok(half.actions.includes('fill'));

    // Reintroduce by counting every hole (lib/health.ts chapterGaps splitListed): "6 missing — 4-9", a finding.
    const none = item('none');
    assert.equal(none.info, true, 'numbers no source lists are for reference, not a finding');
    assert.equal(none.detail, '6 numbers none of its sources list — 4-9');
    assert.doesNotMatch(none.detail, /missing/);
    assert.ok(none.actions.includes('fill'), 'Fill now still asks other sources for them');
    assert.match(c.summary, /\b1 with numbers none of their sources list\b/);
    assert.match(c.note, /are not counted as missing/);
    // A sentence after a sentence, never "found.; Numbers". Reintroduce by dropping joined('sentence', …) in chapterGaps.
    assert.doesNotMatch(c.note, /\.;/, 'the note joins its sentences as sentences');

    const bare = item('bare');
    assert.notEqual(bare.info, true, 'a series no source ever answered for counts its holes as before');
    assert.match(bare.detail, /^6 missing — 4-9$/);

    // The reader's own warning (#236) is the card's rule: only what a source lists is "missing".
    // Reintroduce by dropping splitListed from lib/seriesGaps.ts: none reads [4-9].
    assert.deepEqual(await seriesGaps(S('half')), [{ lo: 4, hi: 6 }]);
    assert.deepEqual(await seriesGaps(S('none')), []);
    assert.deepEqual(await seriesGaps(S('bare')), [{ lo: 4, hi: 9 }]);
  } finally {
    await q('DELETE FROM series_listing WHERE series_id = ANY($1)', [[S('half'), S('none'), S('bare')]]).catch(() => {});
    await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [[S('half'), S('none'), S('bare')]]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [[S('half'), S('none'), S('bare')]]).catch(() => {});
  }
});

test('an add whose source is cooling keeps the series, and so does one whose page list is refused', { skip }, async () => {
  const { addSeriesFromSource, jobBusy } = await import('../src/routes/sources');
  const settle = async (folder: string) => {
    const until = Date.now() + 20_000;
    while (Date.now() < until && jobBusy(folder)) await new Promise((r) => setTimeout(r, 100));
    return (await q('SELECT id, source_checked_at, source_missing FROM lib_series WHERE folder = $1', [folder]))[0];
  };
  try {
    // In a cooldown before the add began (a Discover search a moment ago can do that): chapter 1 is never asked.
    // Reintroduce by dropping the `refusing` skip branch in routes/sources.ts run(): 422, no row.
    await q(`INSERT INTO source_health (source_id, status, blocked_until) VALUES ($1, 'rate_limited', now() + interval '1 hour')
             ON CONFLICT (source_id) DO UPDATE SET blocked_until = EXCLUDED.blocked_until`, [COOLED]);
    const r1 = await addSeriesFromSource({ source: COOLED, sourceId: `${COOLED}-1`, wait: false });
    assert.equal(r1.started, true, r1.message);
    const row1 = await settle('Fin Cooled/Cooled At Start');
    assert.ok(row1, 'the series is kept although its source was cooling');
    assert.equal(row1.source_checked_at, null);
    assert.equal(Number(row1.source_missing), 3);
    // v0.80.0: and the scout looks for it on the other sources meanwhile (lib/sourceScout.ts). Reintroduce by dropping
    // the request after keepForLater (routes/sources.ts): no row.
    const ask = (await q('SELECT reason, priority FROM series_scout WHERE series_id = $1', [row1.id]))[0];
    assert.equal(ask?.reason, 'refused');
    assert.equal(ask?.priority, 3, 'before anything the sweep put forward');
    // The page list refused (v0.79.0, lib/downloader.ts): a refusal like an image's. Reintroduce by rethrowing the page
    // list's error bare: no blockStatus, 422, no row.
    const r2 = await addSeriesFromSource({ source: PLREF, sourceId: `${PLREF}-1`, wait: false });
    assert.equal(r2.started, true, r2.message);
    const row2 = await settle('Fin Page List/Page List Refused');
    assert.ok(row2, 'the series is kept although its source refused the page list');
    assert.equal(row2.source_checked_at, null);
  } finally {
    await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[COOLED, PLREF]]).catch(() => {});
    await q(`DELETE FROM lib_series WHERE folder LIKE 'Fin Cooled/%' OR folder LIKE 'Fin Page List/%'`).catch(() => {});
  }
});

test('the finishing sweep yields to a waiting full sweep', { skip }, async () => {
  const { runSweep } = await import('../src/lib/updater');
  const { wantQuiet } = await import('../src/lib/finishDownloads');
  const { runtime } = await import('../src/lib/runtime');
  const { registerAdapter } = await import('../src/lib/sources');
  // One page held until released: the finishing sweep is inside its first series when the full sweep comes asking.
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let pagesAsked = 0;
  registerAdapter({
    id: 'fin-gate', name: 'Fin Gate',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: 'fin-gate', title: sid }; },
    async listChapters(sid: string) { listed.add(sid); return [1, 2].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `${sid}:${n}` })); },
    async getPageUrls(chId: string) { pagesAsked++; if (pagesAsked === 1) await held; return [`https://example.invalid/fin/${encodeURIComponent(chId)}.png`]; },
    async latest() { return []; },
  } as any);
  const keys = ['yA', 'yB', 'yC'];
  for (const k of keys) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
             VALUES ($1,'T!fin',$1,$1,0,$2,'fin-gate',$3,true) ON CONFLICT (id) DO NOTHING`, [S(k), LIB, k]);
  }
  try {
    listed.clear();
    const run = runSweep({ maxNew: 10, sweepMax: 60, finishing: true }, quiet);
    assert.notEqual(run, false, 'PREMISE: the finishing sweep started');
    while (pagesAsked < 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(runSweep({ maxNew: 5 }, quiet), false, 'PREMISE: a full sweep is refused while it runs');
    assert.equal(runtime.finishing, true);
    wantQuiet();   // what the full sweep's tick does now (server.ts)
    release();
    const r = await run;
    // Reintroduce by dropping the quietWanted checks (lib/updater.ts runUpdateAll): every series is visited.
    assert.equal(r?.stopped, 'yield', 'it gave way');
    assert.equal(listed.size, 1, 'at the chapter it was on, before the other series');
    assert.equal(runtime.finishing, false);
    const full = runSweep({ maxNew: 5 }, quiet);
    assert.notEqual(full, false, 'and the full sweep starts');
    await full;
  } finally {
    await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [keys.map(S)]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [keys.map(S)]).catch(() => {});
  }
});
