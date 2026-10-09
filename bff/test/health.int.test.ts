// Library health checks, against a real Postgres because every check is a SQL query.
//
// The assertions that matter most here are the NEGATIVE ones. Two plausible-looking checks were tried
// against the real library and had to be narrowed:
//   * "pages = 0 means a broken file" would have flagged 29,739 of 40,466 books, because page counts are
//     filled in lazily on first open rather than at scan time.
//   * "a one-page chapter is a failed download" would have flagged every ".5" author notice, which really
//     is one page.
// A health page that cries wolf gets ignored, so those two cases are pinned here to stop them coming back.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}

const S_GAPS = 's_health_gaps';
const S_ZERO = 's_health_zero'; // 0, 93, 94, 95: the shape on which health and fill used to disagree
const S_CLEAN = 's_health_clean';

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const health = await import('../src/lib/health');
  await migrate();
  for (const id of [S_GAPS, S_CLEAN, S_ZERO]) await q(`DELETE FROM lib_series WHERE id = $1`, [id]);

  const series = async (id: string, title: string) =>
    q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'test',$2,$1)`, [id, title]);
  const book = async (sid: string, n: number, pages: number) =>
    q(`INSERT INTO lib_books (id, series_id, source, file, title, number, pages)
       VALUES ($1,$2,'test',$3,$4,$5,$6)`,
      [`b_${sid}_${n}`, sid, `/test/${sid}/${n}.cbz`, `Chapter ${n}`, n, pages]);

  await series(S_GAPS, 'Health Gaps Fixture');
  // chapters 1,2,3 then 7,8 — a hole at 4-6
  for (const n of [1, 2, 3, 7, 8]) await book(S_GAPS, n, 20);

  // The exact shape from the incident: chapter 0 then 93 onwards. The SQL implementation dropped the 0
  // (WHERE number > 0) and saw one unbroken run; gapsOf() keeps it and sees 1-92. Same data, two answers.
  await series(S_ZERO, 'Health Zero Fixture');
  for (const n of [0, 93, 94, 95]) await book(S_ZERO, n, 20);
  await series(S_CLEAN, 'Health Clean Fixture');
  for (const n of [1, 2, 3]) await book(S_CLEAN, n, 20);
  await book(S_CLEAN, 4, 0); // never opened: page count unknown, NOT a broken file
  await book(S_CLEAN, 4.5, 1); // author notice: legitimately one page

  return { q, health };
}

const find = (r: any, id: string) => r.checks.find((c: any) => c.id === id);
const titles = (c: any) => c.items.map((i: any) => i.title);

/**
 * v0.49.1: every sentence a check sends carries its codes (lib/said.ts), and the codes say exactly its English --
 * read back from the registry alone (englishOf) -- so the page's words are always about what the server said.
 * Called on each report the tests below build, whatever their fixtures reach. Reintroduce by writing a summary as a
 * bare `summary:` string: "<check> sends its summary without codes" fails; by giving `gaps.detail` the wrong count:
 * "its codes say something else" fails.
 */
async function assertSaid(checks: any[]): Promise<number> {
  const { englishOf } = await import('../src/lib/said');
  let n = 0;
  for (const c of checks.filter(Boolean)) {
    assert.ok(c.summarySaid?.length, `${c.id} sends its summary without codes`);
    assert.equal(englishOf(c.summarySaid), c.summary, `${c.id}: the summary's codes say something else`);
    if (c.note) assert.equal(englishOf(c.noteSaid), c.note, `${c.id}: the note's codes say something else`);
    else assert.equal(c.noteSaid, undefined, `${c.id}: codes for a note it does not have`);
    for (const it of c.items) {
      n++;
      if (it.titleSaid) assert.equal(englishOf(it.titleSaid), it.title, `${c.id}: the title's code says something else`);
      // The database's own refusal of a folder is the one detail sent as it is: only it has the words.
      if (c.id === 'library-scan' && !it.detailSaid) continue;
      assert.ok(it.detailSaid?.length, `${c.id}: "${it.detail}" is sent without codes`);
      const back = englishOf(it.detailSaid);
      if (back !== null) assert.equal(back, it.detail, `${c.id}: "${it.detail}" -- its codes say something else`);
      else {
        // A diagnosis's fix inside a row keeps its own code (lib/sourceDiagnosis.ts FixCode), and ends the line.
        assert.ok(it.detailSaid.at(-1).code.startsWith('fix.') && it.detail.endsWith(it.diagnosis?.fix), `${c.id}: "${it.detail}" has a code nobody knows`);
      }
    }
  }
  return n;
}

test('library health checks', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async (t) => {
  const { q, health } = await setup();
  const report = await health.runHealthChecks();
  await assertSaid(report.checks);

  await t.test('reports every check and a timestamp', () => {
    assert.ok(Date.parse(report.generatedAt) > 0);
    for (const id of ['chapter-gaps', 'short-chapters', 'outliers', 'duplicates', 'sources', 'solver']) {
      assert.ok(find(report, id), `missing check: ${id}`);
    }
  });

  await t.test('finds the missing run of chapters', () => {
    const c = find(report, 'chapter-gaps');
    const item = c.items.find((i: any) => i.title === 'Health Gaps Fixture');
    assert.ok(item, 'expected the gappy fixture to be reported');
    assert.match(item.detail, /3 missing/);
    assert.match(item.detail, /4-6/);
    // Reintroduce by restoring the SQL islands-and-gaps with `WHERE number > 0`: this series vanishes from the
    // check while "find missing chapters" still offers to fetch 92 for it.
    const zero = c.items.find((i: any) => i.title === 'Health Zero Fixture');
    assert.ok(zero, 'a series holding 0 and 93.. is reported as having a gap, exactly as the fill dialog says');
    assert.match(zero.detail, /^92 missing — 1-92/);
  });

  await t.test('a series with no holes is not reported as gappy', () => {
    assert.ok(!titles(find(report, 'chapter-gaps')).includes('Health Clean Fixture'));
  });

  await t.test('an unopened chapter is not called a broken file', () => {
    // the 29,739-false-positive trap: pages = 0 means "not read yet"
    const c = find(report, 'short-chapters');
    assert.ok(!titles(c).includes('Health Clean Fixture'), 'pages = 0 must not be flagged');
  });

  await t.test('a one-page half-chapter is not called a broken file', () => {
    // ".5" entries are usually author notices and really are one page
    const c = find(report, 'short-chapters');
    const hit = c.items.find((i: any) => i.title === 'Health Clean Fixture' && /4\.5/.test(i.detail));
    assert.equal(hit, undefined, 'decimal chapters must be excluded');
  });

  await t.test('a truncated whole chapter IS reported', async () => {
    await q(`UPDATE lib_books SET pages = 1 WHERE id = $1`, [`b_${S_CLEAN}_3`]);
    const again = await health.runHealthChecks();
    const hit = find(again, 'short-chapters').items.find(
      (i: any) => i.title === 'Health Clean Fixture' && /Chapter 3/.test(i.detail),
    );
    assert.ok(hit, 'a whole-numbered 1-page chapter should be flagged');
    await q(`UPDATE lib_books SET pages = 20 WHERE id = $1`, [`b_${S_CLEAN}_3`]);
  });

  await t.test('status reflects whether a check found anything', () => {
    // Items flagged `info` are listed for reference and never decide the verdict: a source the operator
    // switched off, a version that is merely behind. The old form of this rule (every item is a finding)
    // only held because no test machine ever had an out-of-date solver, and the disabled-source case was
    // a genuine false alarm that PR #39 ran into.
    for (const c of report.checks) {
      assert.equal(c.items.filter((i: any) => !i.info).length === 0, c.status === 'ok', `${c.id}: status and items disagree`);
      assert.ok(c.summary.length > 0);
    }
  });

  for (const id of [S_GAPS, S_CLEAN]) await q(`DELETE FROM lib_series WHERE id = $1`, [id]);
});


const S_FROZEN = 's_health_frozen', S_ROUTED = 's_health_routed', S_OFF = 's_health_off';

/**
 * A series whose source no longer exists must be SAID somewhere.
 *
 * `updateSeries` returns `unrouted` for it every night and the sweep discards the count; its health row, if
 * any, reads `ok` because nothing was ever asked; the fill scan never pins it. Live: 31 chapters, frozen for
 * twelve days, and every surface said fine.
 *
 * Reintroduce by removing frozenSeries() from the Promise.all in runHealthChecks: the check is absent.
 */
test('a series with no working source is listed, one with a working source is not', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks, frozenSeries } = await import('../src/lib/health');
  const { noIgnores } = await import('../src/lib/healthIgnore');
  const { registerAdapter } = await import('../src/lib/sources');
  await migrate();
  registerAdapter({ id: 'health-live', name: 'Health Live', search: async () => [], getSeries: async () => null,
    listChapters: async () => [], getPageUrls: async () => [], latest: async () => [] } as any);
  for (const id of [S_FROZEN, S_ROUTED, S_OFF]) await q('DELETE FROM lib_series WHERE id = $1', [id]);
  await q(`DELETE FROM suwayomi_sources WHERE source_id = 'health-off'`);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id)
           VALUES ($1, 'test', 'Frozen Fixture', $1, 31, 'sw:999999999', '9')`, [S_FROZEN]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id)
           VALUES ($1, 'test', 'Routed Fixture', $1, 5, 'health-live', 'x')`, [S_ROUTED]);
  // A source that is still installed but switched off -- by hand, or by hiding its language -- is a
  // different finding: the fix is a button, not a reinstall.
  await q(`INSERT INTO suwayomi_sources (source_id, name, lang, enabled) VALUES ('health-off', 'Off', 'ru', false)`);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id)
           VALUES ($1, 'test', 'Off Fixture', $1, 7, 'sw:health-off', '1')`, [S_OFF]);
  try {
    const report = await runHealthChecks();
    const check = report.checks.find((c: any) => c.id === 'frozen-series');
    assert.ok(check, 'the check exists');
    assert.ok(await assertSaid(report.checks) > 0);
    assert.equal(check.status, 'warn');
    const titles = check.items.map((i: any) => i.title);
    assert.ok(titles.includes('Frozen Fixture'), `the frozen series is named: ${titles.join(', ')}`);
    assert.ok(!titles.includes('Routed Fixture'), 'a series whose adapter is loaded is not');
    assert.ok(titles.includes('Off Fixture'), 'a series on a switched-off source is still frozen');
    // The reasons, with the extension engine answering: this process has none, and with none every extension
    // series waits for the engine first (the next test but one).
    const up = await frozenSeries(noIgnores(), 'up');
    const detail = (title: string) => up.items.find((i) => i.title === title)!.detail;
    assert.match(detail('Frozen Fixture'), /sw:999999999 is no longer installed/);
    // Reintroduce by dropping the EXISTS subquery from frozenSeries(): "a switched-off source is said to be
    // switched off" fails, the detail reads "no longer installed" for a source that is right there. Named as the engine
    // named it since v0.55.1 (sourceLabel), where it read sw:health-off.
    assert.match(detail('Off Fixture'), /its source Off is switched off/, 'a switched-off source is said to be switched off');
  } finally {
    for (const id of [S_FROZEN, S_ROUTED, S_OFF]) await q('DELETE FROM lib_series WHERE id = $1', [id]);
    await q(`DELETE FROM suwayomi_sources WHERE source_id = 'health-off'`);
  }
});

const S_COVERED = 's_health_covered', S_ORPHANED = 's_health_orphaned';

/**
 * A series whose primary is gone but which follows a source that is loaded still updates -- the updater
 * merges the followers' lists -- so it is not frozen, and calling it frozen would send the operator to
 * repair something that is fetching chapters every night. It is listed for reference instead, because a
 * dead primary is still worth tidying. A follower that is itself gone changes nothing.
 *
 * Reintroduce by dropping the series_sources read in frozenSeries() (every unrouted row frozen): "a dead
 * primary with a live follower is not frozen" fails -- the fixture is listed as a warning.
 */
test('a dead primary with a live follower is reference, not a warning; with a dead follower it is still frozen', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks, frozenSeries } = await import('../src/lib/health');
  const { noIgnores } = await import('../src/lib/healthIgnore');
  const { registerAdapter } = await import('../src/lib/sources');
  await migrate();
  registerAdapter({ id: 'health-follower', name: 'Health Follower', search: async () => [], getSeries: async () => null,
    listChapters: async () => [], getPageUrls: async () => [], latest: async () => [] } as any);
  for (const id of [S_COVERED, S_ORPHANED]) await q('DELETE FROM lib_series WHERE id = $1', [id]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id)
           VALUES ($1, 'test', 'Covered Fixture', $1, 12, 'sw:888888888', '8')`, [S_COVERED]);
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, 'health-follower', 'f1')`, [S_COVERED]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id)
           VALUES ($1, 'test', 'Orphaned Fixture', $1, 9, 'sw:777777777', '7')`, [S_ORPHANED]);
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, 'sw:666666666', 'f2')`, [S_ORPHANED]);
  try {
    const check = (await runHealthChecks()).checks.find((c: any) => c.id === 'frozen-series');
    assert.ok(check, 'the check exists');
    await assertSaid([check]);
    const covered = check.items.find((i: any) => i.title === 'Covered Fixture');
    assert.ok(covered, 'the series with a dead primary is still listed');
    assert.equal(covered.info, true, 'a dead primary with a live follower is not frozen');
    assert.match(covered.detail, /primary sw:888888888 gone; still following Health Follower/);
    assert.match(check.summary, /1 lost its primary but still follows another/);
    const orphaned = check.items.find((i: any) => i.title === 'Orphaned Fixture');
    assert.ok(orphaned, 'a dead primary with a dead follower is listed');
    assert.notEqual(orphaned.info, true, 'and it is a real finding');
    const up = await frozenSeries(noIgnores(), 'up');
    assert.match(up.items.find((i) => i.title === 'Orphaned Fixture')!.detail, /sw:777777777 is no longer installed/);
    assert.equal(check.status, 'warn');
  } finally {
    for (const id of [S_COVERED, S_ORPHANED]) await q('DELETE FROM lib_series WHERE id = $1', [id]);
  }
});

const S_ENGINE = 's_health_engine', S_GONE = 's_health_gone', S_ROOM = 's_health_room';

/**
 * #72: with no extension engine answering, EVERY extension series is unrouted, and an enabled source then read
 * "over the source limit (SUWAYOMI_MAX_SOURCES)" -- advice to raise a limit that was never reached. The engine is
 * the reason in each state it can be in; with it answering, the old rules stand.
 *
 * Reintroduce by making engineWhy() in frozenSeries return null (the old why() for every state): the 'off' case
 * reads "over the source limit" again, and "the engine is the reason" fails.
 */
test('the engine being off is the reason, not the source limit', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { frozenSeries } = await import('../src/lib/health');
  const { noIgnores } = await import('../src/lib/healthIgnore');
  const { env } = await import('../src/env');
  const reg = await import('../src/lib/sources/suwayomi/register');
  const { unregisterAdapter } = await import('../src/lib/sources');
  await migrate();
  for (const id of [S_ENGINE, S_GONE, S_ROOM]) await q('DELETE FROM lib_series WHERE id = $1', [id]);
  await q(`DELETE FROM suwayomi_sources WHERE source_id IN ('health-engine', 'health-room')`);
  // Enabled and remembered, but not registered: exactly what every extension source is while the engine is away.
  await q(`INSERT INTO suwayomi_sources (source_id, name, lang, enabled) VALUES ('health-engine', 'Engine Source', 'en', true),
             ('health-room', 'Room Source', 'en', true)`);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id)
           VALUES ($1, 'test', 'Engine Fixture', $1, 12, 'sw:health-engine', '1')`, [S_ENGINE]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id)
           VALUES ($1, 'test', 'Gone Fixture', $1, 3, 'gone-pack-source', '1')`, [S_GONE]);
  // A series on the source that takes the one slot below.
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id)
           VALUES ($1, 'test', 'Room Fixture', $1, 2, 'sw:health-room', '1')`, [S_ROOM]);
  try {
    const detail = async (engine: 'off' | 'switched_off' | 'unreachable' | 'up', title: string) => {
      const c = await frozenSeries(noIgnores(), engine);
      await assertSaid([c]);
      return { detail: c.items.find((i) => i.title === title)!.detail, note: c.note ?? '' };
    };
    for (const engine of ['off', 'switched_off'] as const) {
      const r = await detail(engine, 'Engine Fixture');
      assert.match(r.detail, /^12 chapters; its source Engine Source can’t be reached because the extension engine is off$/, `the engine is the reason (${engine})`);
      assert.doesNotMatch(r.detail, /source limit/);
      assert.match(r.note, /^Series that came from extensions wait for the extension engine; Admin → Sources shows how to bring it back\. /);
    }
    assert.match((await detail('unreachable', 'Engine Fixture')).detail, /because the extension engine isn’t answering$/);
    const actions = async (engine: 'off' | 'up', title: string) => (await frozenSeries(noIgnores(), engine)).items.find((i) => i.title === title)!;
    // v0.55.1: switched on and not loaded is over the limit only when the last load says it left the source out
    // (register.ts leftOutByLimit, which the sources overview reads too). Before any such load, an extension the engine
    // no longer offers is not over any limit: it is gone, and Replace is its fix. Reintroduce `r.still_enabled` alone in
    // frozenSeries: "switched on but not left out by the limit is not over it" fails, and its Free a slot would land on
    // a sheet offering Replace.
    assert.match((await detail('up', 'Engine Fixture')).detail, /its source Engine Source is no longer installed$/,
      'switched on but not left out by the limit is not over it');
    assert.deepEqual((await actions('up', 'Engine Fixture')).actions, ['replace_source', 'find_sources', 'ignore']);
    // Left out by the limit as a load leaves it: an engine that answered, a limit of one, and a source some series reads
    // through ahead of it in the engine's order.
    const was = { url: env.SUWAYOMI_URL, cap: env.SUWAYOMI_MAX_SOURCES };
    Object.assign(env, { SUWAYOMI_URL: 'http://engine.test:4567', SUWAYOMI_MAX_SOURCES: 1 });
    try {
      await reg.loadSuwayomiSources(async () => [{ id: 'health-room', name: 'Room Source', lang: 'en' }, { id: 'health-engine', name: 'Engine Source', lang: 'en' }] as any);
    } finally {
      Object.assign(env, was);
    }
    assert.ok(reg.leftOutByLimit('sw:health-engine') && !reg.leftOutByLimit('sw:health-room'), 'PREMISE: the load left the engine fixture out');
    const up = await detail('up', 'Engine Fixture');
    assert.match(up.detail, /is over the source limit \(SUWAYOMI_MAX_SOURCES\)$/, 'with the engine up, the limit is the reason');
    // v0.55.1: by the name the engine gave it, as the rest of Health names a source (sourceLabel), never `sw:…`.
    // Reintroduce `source: r.source_id` in frozenSeries: the engine's own reason above already reads sw:health-engine.
    assert.match(up.detail, /^12 chapters; its source Engine Source is over/, 'the over-limit row names its source as the engine named it');
    assert.doesNotMatch(up.note, /wait for the extension engine/);
    // v0.55.0: the limit is a slot to free, not a source to replace -- the source works. Reintroduce by offering Replace
    // there (keysFor -> sourceKeys): the over-limit row reads replace_source.
    const slot = await actions('up', 'Engine Fixture');
    assert.deepEqual(slot.actions, ['free_slot', 'ignore'], 'the over-limit row offers a slot to free, never Replace');
    assert.equal(slot.sourceId, 'sw:health-engine', 'naming the source Admin → Sources opens on');
    assert.deepEqual((await actions('off', 'Engine Fixture')).actions, ['ignore'], 'with the engine away there is no slot to free either: the engine is the fix');
    assert.deepEqual((await actions('up', 'Gone Fixture')).actions, ['replace_source', 'find_sources', 'ignore'], 'a source that is gone still offers Replace');
    // A source that is not an extension's is not the engine's to explain.
    for (const engine of ['off', 'switched_off', 'unreachable', 'up'] as const) {
      assert.match((await detail(engine, 'Gone Fixture')).detail, /gone-pack-source is no longer installed$/, `a non-extension source (${engine})`);
    }
  } finally {
    for (const id of [S_ENGINE, S_GONE, S_ROOM]) await q('DELETE FROM lib_series WHERE id = $1', [id]);
    await q(`DELETE FROM suwayomi_sources WHERE source_id IN ('health-engine', 'health-room')`);
    unregisterAdapter('sw:health-room');
    // With no engine configured again, a load registers nothing and forgets what the last one left out.
    await reg.loadSuwayomiSources(async () => []);
  }
});

/**
 * A source the operator switched off themselves is listed, so the count stays visible, but it is never the
 * reason the check is amber. Contributor PR #39 ran into the old behaviour while adding language hiding:
 * turning off thirty Russian sources produced thirty "problems" that were the operator's own decision.
 *
 * Reintroduce by taking the verdict in sourceTrouble() from every row again (`status: rows.length ? 'warn'
 * : 'ok'` instead of `live.length`): "a page with only switched-off sources is ok" fails -- it stays warn.
 */
test('a source you turned off is listed but never a warning', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  await migrate();
  const OFF = 'hl-off', DOWN = 'hl-down', UNUSED = 'hl-unused';
  const S_DOWN = 's_health_down';
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[OFF, DOWN, UNUSED]]);
  await q('DELETE FROM lib_series WHERE id = $1', [S_DOWN]);
  await q(`INSERT INTO source_health (source_id, status, disabled) VALUES ($1, 'ok', true), ($2, 'down', false), ($3, 'down', false)`,
    [OFF, DOWN, UNUSED]);
  // ⚠️ The down source needs a series on it, because "down" is only a finding when something depends on it:
  // since v0.41.0 a failing source no series uses is greyed (ten of the live server's twelve not-ok rows are
  // Discover-only noise nobody can act on). Without this row the fixture would prove the new rule instead of
  // the old one. `hl-unused` is the new rule's own fixture: same failure, nothing using it.
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id)
           VALUES ($1, 'test', 'Down Fixture', $1, 3, $2, 'd1')`, [S_DOWN, DOWN]);
  // Other files leave their own rows in source_health (the suite shares one database, one file at a time),
  // so the counts are checked against the items rather than assumed to be ours alone: the summary's two
  // figures (v0.53.0: the series' sources that need a look, and the failing ones nothing uses) must add up to
  // exactly the non-info items, and every info item must be folded away as quiet or switched off.
  const counts = (c: any) => ({
    failing: Number(c.summary.match(/(\d+) sources? your series use/)?.[1] ?? 0) + Number(c.summary.match(/(\d+) sources? nothing uses/)?.[1] ?? 0),
    folded: c.items.filter((i: any) => i.group === 'quiet' || i.group === 'off').length,
    live: c.items.filter((i: any) => !i.info).length,
    info: c.items.filter((i: any) => i.info).length,
  });
  try {
    const first = (await runHealthChecks()).checks.find((c: any) => c.id === 'sources');
    await assertSaid([first]);
    assert.equal(first.status, 'warn', 'a source that is down is still a warning');
    const n1 = counts(first);
    assert.equal(n1.failing, n1.live, `the verdict counts only live faults (summary: ${first.summary})`);
    assert.equal(n1.folded, n1.info, 'and every row listed for reference is folded as quiet or switched off');
    const off = first.items.find((i: any) => i.title === OFF);
    assert.ok(off, 'the switched-off source is still listed');
    assert.equal(off.info, true, 'the switched-off source is marked as reference, not a finding');
    assert.match(off.detail, /turned off/);
    const down = first.items.find((i: any) => i.title === DOWN);
    assert.notEqual(down?.info, true, 'the down source is a real finding');
    assert.match(down.detail, /1 series use it/, 'and the count now includes the series on it');
    // Reintroduce by dropping the 0-series rule from sourceTrouble() (`info` for disabled rows only):
    // this assertion fails -- a source nothing uses is a warning again, which is ten of the live server's
    // twelve and the reason that check was permanently amber.
    const unused = first.items.find((i: any) => i.title === UNUSED);
    assert.ok(unused, 'a source nothing uses is still listed');
    assert.equal(unused.info, true, 'but it is reference, not a finding: nothing depends on it');
    assert.match(unused.detail, /no series use it/);
    // The chips act on the source by id, never by parsing the title.
    assert.equal(down.sourceId, DOWN, 'every source row names its source');
    // ...and, since v0.48.3, Ignore: a real finding can be silenced (lib/healthIgnore.ts).
    // v0.49.1: and Find other sources, for the one series whose main source it is (lib/findSources.ts).
    assert.deepEqual(down.actions, ['test', 'disable', 'find_sources', 'ignore'], 'a live failing source offers Test and Turn off');
    assert.equal(down.findSeries, 1);
    assert.deepEqual(off.actions, ['test'], 'one already turned off is not offered Turn off again (nor Ignore: it is quiet already)');

    await q('DELETE FROM lib_series WHERE id = $1', [S_DOWN]);
    await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[DOWN, UNUSED]]);
    const second = (await runHealthChecks()).checks.find((c: any) => c.id === 'sources');
    await assertSaid([second]);
    const n2 = counts(second);
    assert.equal(second.status, n2.live ? 'warn' : 'ok', 'a page with only switched-off sources is ok');
    assert.equal(n2.failing, n2.live, `still only live faults in the verdict (summary: ${second.summary})`);
    assert.ok(second.items.some((i: any) => i.title === OFF && i.info), 'the switched-off source is still listed');
  } finally {
    await q('DELETE FROM lib_series WHERE id = $1', [S_DOWN]);
    await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[OFF, DOWN, UNUSED]]);
  }
});

/**
 * A blocked source offers "Clear block" as well, and clearing is what also wipes the escalation memory
 * (consecutive), which is what makes the next cooldown fifteen minutes instead of seventy-five.
 *
 * Reintroduce by dropping the `blocked_until` branch from the actions list in sourceTrouble(): the blocked
 * fixture offers no way to clear the block from the page that reports it.
 */
test('a blocked source offers Clear block, and a source with a cooldown is a finding even with no series', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  await migrate();
  const BLOCKED = 'hl-blocked';
  await q('DELETE FROM source_health WHERE source_id = $1', [BLOCKED]);
  await q(`INSERT INTO source_health (source_id, status, disabled, blocked_until, consecutive)
           VALUES ($1, 'blocked', false, now() + interval '1 hour', 4)`, [BLOCKED]);
  try {
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'sources');
    await assertSaid([c]);
    const row = c.items.find((i: any) => i.title === BLOCKED);
    assert.ok(row, 'listed');
    // A cooldown is happening NOW, so it is a finding whether or not a series uses the source: something is
    // being waited on, and the waiting is the thing an admin may want to end.
    assert.notEqual(row.info, true, 'a source in a cooldown is a finding even with nothing on it');
    assert.deepEqual(row.actions, ['test', 'unblock', 'disable', 'ignore']);
  } finally {
    await q('DELETE FROM source_health WHERE source_id = $1', [BLOCKED]);
  }
});

/**
 * v0.53.0, the owner: "it feels like there is a million extention that i need to fix". The card listed thirty sources
 * he had switched off on purpose first (ORDER BY disabled DESC), each with a Test key, and the four his library
 * depends on at its very end. Every row now says which part of the card it belongs to and its one state, and the
 * check lists them as the card shows them: the series' sources first, the most series and then the worst first; the
 * failing ones nothing uses; then the quiet and the switched-off ones, by name. The summary counts the first two.
 *
 * Reintroduce by dropping the sort (the rows come in source_id order): "the groups come in the card's order" fails --
 * hg-off sits between the series' sources. Drop the series key from it: "the series' sources, the most series first"
 * fails. Count every finding as one figure again: "the summary counts the two groups" fails.
 */
test('Source health groups its rows, names each one\'s state, lists what the library depends on first, and counts the groups', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  const { registerAdapter } = await import('../src/lib/sources');
  await migrate();
  // Two loaded sources (a confirmed failure, and a test that ran out of time, are evidence only for a loaded one) and
  // one with an extension's logo.
  const stub = { search: async () => [], getSeries: async () => null, listChapters: async () => [], getPageUrls: async () => [] };
  registerAdapter({ id: 'hg-zz-fail', name: 'Alpha Failing', iconUrl: 'http://icons.invalid/alpha.png', ...stub } as any);
  registerAdapter({ id: 'hg-late', name: 'Late Source', ...stub } as any);
  const IDS = ['hg-busy', 'hg-slow', 'hg-one', 'hg-zz-fail', 'hg-zeta', 'hg-idle', 'hg-late', 'hg-off', 'sw:hg-lang', 'sw:hg-ext'];
  const SERIES = ['s_hg_1', 's_hg_2', 's_hg_3', 's_hg_4', 's_hg_5'];
  const clean = async () => {
    await q('DELETE FROM lib_series WHERE id = ANY($1::text[])', [SERIES]);
    await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [IDS]);
    await q(`DELETE FROM suwayomi_sources WHERE source_id = ANY($1::text[])`, [['hg-lang', 'hg-ext']]);
  };
  await clean();
  // Russian hidden in every extension: hg-lang is off for its language, hg-ext switched off by itself.
  const [{ hidden_langs: hiddenWas }] = await q(`SELECT hidden_langs FROM server_settings WHERE id = 1`);
  await q(`UPDATE server_settings SET hidden_langs = '["ru"]'::jsonb WHERE id = 1`);
  const series = (id: string, source: string) => q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id)
    VALUES ($1, 'test', $1, $1, 3, $2, 'x')`, [id, source]);
  // hg-busy carries three series and hg-slow follows the same three: a tie on series, decided by how bad. hg-one
  // carries one, hg-late two.
  for (const id of SERIES.slice(0, 3)) {
    await series(id, 'hg-busy');
    await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, 'hg-slow', 'x')`, [id]);
  }
  await series('s_hg_4', 'hg-one');
  await series('s_hg_5', 'hg-late');
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ('s_hg_4', 'hg-late', 'x')`);
  await q(`INSERT INTO suwayomi_sources (source_id, name, lang, enabled) VALUES ('hg-lang', 'Hidden Lang', 'ru', false), ('hg-ext', 'Ext Off', 'xx', false)`);
  const failAt = new Date().toISOString();
  await q(
    `INSERT INTO source_health (source_id, status, consecutive, blocked_until, slow_streak, empty_streak, disabled, stages,
                                live_state, live_stage, live_at, live_by) VALUES
       ('hg-busy', 'rate_limited', 3, now() + interval '20 minutes', 0, 0, false, '{}'::jsonb, NULL, NULL, NULL, NULL),
       ('hg-slow', 'ok', 0, NULL, 4, 0, false, '{}'::jsonb, NULL, NULL, NULL, NULL),
       ('hg-one', 'ok', 0, NULL, 0, 4, false, '{}'::jsonb, NULL, NULL, NULL, NULL),
       ('hg-zz-fail', 'ok', 0, NULL, 0, 0, false, $1::jsonb, 'fail', 'chapters', now(), 'test'),
       ('hg-zeta', 'down', 4, now() + interval '1 hour', 0, 0, false, '{}'::jsonb, NULL, NULL, NULL, NULL),
       ('hg-idle', 'down', 4, now() - interval '1 hour', 0, 0, false, '{}'::jsonb, NULL, NULL, NULL, NULL),
       ('hg-late', 'ok', 0, NULL, 0, 0, false, '{}'::jsonb, 'inconclusive', 'pages', now() - interval '1 hour', 'test'),
       ('hg-off', 'down', 4, NULL, 0, 0, true, '{}'::jsonb, NULL, NULL, NULL, NULL),
       ('sw:hg-lang', 'down', 4, NULL, 0, 0, false, '{}'::jsonb, NULL, NULL, NULL, NULL),
       ('sw:hg-ext', 'ok', 0, NULL, 0, 0, false, '{}'::jsonb, NULL, NULL, NULL, NULL)`,
    [JSON.stringify({ chapters: { failAt, failBy: 'test', since: failAt, kind: 'error', error: 'HTTP 500' } })],
  );
  try {
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'sources');
    await assertSaid([c]);
    const row = (id: string) => c.items.find((i: any) => i.sourceId === id);
    const shape = (id: string) => { const r = row(id); return r && { group: r.group, state: r.state, stage: r.stage ?? null, info: !!r.info }; };
    assert.deepEqual(shape('hg-busy'), { group: 'affected', state: 'blocked', stage: null, info: false });
    assert.deepEqual(shape('hg-slow'), { group: 'affected', state: 'slow', stage: null, info: false });
    assert.deepEqual(shape('hg-one'), { group: 'affected', state: 'empty', stage: null, info: false });
    assert.deepEqual(shape('hg-zz-fail'), { group: 'unused', state: 'failing', stage: 'chapters', info: false }, 'a confirmed failure nothing uses is a finding of its own group');
    assert.deepEqual(shape('hg-zeta'), { group: 'unused', state: 'blocked', stage: null, info: false }, 'a cooldown happening now is a finding with nothing on it');
    assert.deepEqual(shape('hg-idle'), { group: 'quiet', state: 'blocked', stage: null, info: true }, 'an ended cooldown on a source nothing uses is quiet');
    // ⚠️ A test that ran out of time is not proof (#115), whatever uses the source: quiet, with the series it has.
    assert.deepEqual(shape('hg-late'), { group: 'quiet', state: 'inconclusive', stage: 'pages', info: true }, 'a test that ran out of time is quiet even on a used source');
    assert.equal(row('hg-late').series, 2);
    assert.deepEqual(shape('hg-off'), { group: 'off', state: 'off', stage: null, info: true });
    assert.deepEqual(shape('sw:hg-lang'), { group: 'off', state: 'off', stage: null, info: true });
    assert.deepEqual(shape('sw:hg-ext'), { group: 'off', state: 'off', stage: null, info: true });
    // Where each was switched off, which is where it comes back on. Reintroduce `offBy: 'language'` for every
    // extension source that is off: "switched off by itself in Extensions" fails.
    assert.equal(row('hg-off').offBy, 'admin', 'turned off under Providers');
    assert.equal(row('sw:hg-lang').offBy, 'language', 'its language hidden in every extension');
    assert.equal(row('sw:hg-ext').offBy, 'extension', 'switched off by itself in Extensions');
    assert.equal(row('hg-busy').cooldown.status, 'rate_limited');
    assert.ok(Date.parse(row('hg-busy').cooldown.until) > Date.now(), 'a cooldown says when it ends');
    assert.ok(Date.parse(row('hg-idle').cooldown.until) < Date.now(), 'and an ended one says so too');
    assert.equal(row('hg-zz-fail').icon, true, 'an extension\'s logo is said');
    assert.equal(row('hg-busy').icon, undefined, 'and only then');
    // The actions are what they were: the primary key is the client's choice from `state`, and nothing is lost.
    assert.deepEqual(row('hg-busy').actions, ['test', 'unblock', 'disable', 'find_sources', 'ignore']);
    assert.deepEqual(row('hg-off').actions, ['test']);

    // The whole list in the card's order, other files' rows included: no group after a later one.
    const RANK: Record<string, number> = { affected: 0, unused: 1, quiet: 2, off: 3 };
    const ranks = c.items.map((i: any) => RANK[i.group]);
    assert.ok(c.items.every((i: any) => i.group in RANK), 'every source row says its group');
    assert.deepEqual(ranks, [...ranks].sort((a: number, b: number) => a - b), `the groups come in the card's order: ${c.items.map((i: any) => `${i.group}:${i.sourceId}`).join(' ')}`);
    const mine = c.items.filter((i: any) => IDS.includes(i.sourceId)).map((i: any) => i.sourceId);
    assert.deepEqual(mine.filter((id: string) => row(id).group === 'affected'), ['hg-busy', 'hg-slow', 'hg-one'],
      'the series\' sources, the most series first, and the worst first between two with as many');
    assert.deepEqual(mine.filter((id: string) => row(id).group === 'unused'), ['hg-zz-fail', 'hg-zeta'], 'by name: Alpha Failing, then hg-zeta');
    assert.deepEqual(mine.filter((id: string) => row(id).group === 'quiet'), ['hg-idle', 'hg-late'], 'by name');
    assert.deepEqual(mine.filter((id: string) => row(id).group === 'off'), ['sw:hg-ext', 'hg-off', 'sw:hg-lang'], 'by name: Ext Off, hg-off, Hidden Lang');

    // The summary counts the two groups that need a look, whoever else left rows here.
    const n = (g: string) => c.items.filter((i: any) => i.group === g).length;
    assert.equal(c.status, 'warn');
    assert.deepEqual(c.summarySaid.slice(0, 2).map((x: any) => [x.code, x.params?.n, x.join ?? null]),
      [['sources.affected', n('affected'), null], ['sources.failingUnused', n('unused'), 'dot']], 'the summary counts the two groups');
    assert.match(c.summary, new RegExp(`^${n('affected')} sources your series use need a look · ${n('unused')} sources nothing uses are failing`));
    assert.equal(n('affected') + n('unused'), c.items.filter((i: any) => !i.info).length, 'and the two groups are every finding: the status agrees');

    // Nothing that needs a look: "Nothing is failing that your library uses" while a quiet row is listed, never
    // "All sources are working" over a test that ran out of time.
    await q(`UPDATE source_health SET status = 'ok', blocked_until = NULL, slow_streak = 0, empty_streak = 0, stages = '{}'::jsonb, live_state = NULL
              WHERE source_id = ANY($1::text[])`, [['hg-busy', 'hg-slow', 'hg-one', 'hg-zz-fail', 'hg-zeta']]);
    const calm = (await runHealthChecks()).checks.find((x: any) => x.id === 'sources');
    await assertSaid([calm]);
    if (!calm.items.some((i: any) => !i.info)) {
      assert.equal(calm.status, 'ok');
      assert.equal(calm.summarySaid[0].code, 'sources.unused', `quiet rows are listed: ${calm.summary}`);
      await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [['hg-idle', 'hg-late']]);
      const quiet = (await runHealthChecks()).checks.find((x: any) => x.id === 'sources');
      if (!quiet.items.some((i: any) => i.group === 'quiet' || !i.info)) {
        assert.equal(quiet.summary, 'All sources are working', 'only switched-off sources left');
        assert.deepEqual(quiet.summarySaid.map((x: any) => x.code), ['sources.working']);
      }
    }
  } finally {
    await clean();
    await q(`UPDATE server_settings SET hidden_langs = $1::jsonb WHERE id = 1`, [JSON.stringify(hiddenWas ?? [])]);
  }
});

test('a source hidden by language is turned off too, however stale its health row', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  // Hiding a language flips suwayomi_sources.enabled, not source_health.disabled -- and an unregistered
  // source is never probed again, so a 'down' recorded before it was hidden would keep this check amber
  // for good. Reintroduce by dropping the suwayomi_sources EXISTS from the `disabled` column in
  // sourceTrouble(): the `hidden by language is off` assertion fails with status warn.
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  await migrate();
  const ID = 'health-hidden-ru';
  await q('DELETE FROM source_health WHERE source_id = $1', [`sw:${ID}`]);
  await q('DELETE FROM suwayomi_sources WHERE source_id = $1', [ID]);
  await q(`INSERT INTO suwayomi_sources (source_id, name, lang, enabled) VALUES ($1, 'Hidden RU', 'ru', false)`, [ID]);
  await q(`INSERT INTO source_health (source_id, status, disabled, consecutive) VALUES ($1, 'down', false, 4)`, [`sw:${ID}`]);
  try {
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'sources');
    // By sourceId: since v0.49.0 (#115) the row is titled with the engine's name for it ('Hidden RU'), not the id.
    const row = c.items.find((i: any) => i.sourceId === `sw:${ID}`);
    assert.ok(row, 'still listed');
    assert.equal(row.title, 'Hidden RU', 'named, not sw:<id>');
    assert.equal(row.info, true, 'hidden by language is off');
    assert.match(row.detail, /turned off/);
    assert.ok(!c.items.some((i: any) => !i.info && i.sourceId === `sw:${ID}`), 'never counted as a fault');
  } finally {
    await q('DELETE FROM source_health WHERE source_id = $1', [`sw:${ID}`]);
    await q('DELETE FROM suwayomi_sources WHERE source_id = $1', [ID]);
  }
});

test('a stored error older than the last success is history, not a fix to go and apply', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  // `reportOk` never clears `last_error`, so a source that saw a Cloudflare challenge on Monday and has
  // answered fine since still carries Monday's words. This check lists it for its empty streak (a live
  // fact), diagnoses it from the stored string (a stale one), and the stored rules run before the
  // empty-streak one -- so the page told the operator to go and fix a solver problem that ended days ago
  // and hid the finding that is actually current. When the last success is newer than the last failure,
  // the error must not be diagnosed at all.
  //
  // Reintroduce by passing `r.last_error` to diagnose() unconditionally in sourceTrouble(): the `stale`
  // assertion fails with the Cloudflare fix text in the detail.
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  await migrate();
  const STALE = 'hl-stale-cf', FRESH = 'hl-fresh-cf';
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[STALE, FRESH]]);
  // Both rows hold the same challenge string (verbatim from a production last_error). STALE succeeded after
  // it was written; FRESH failed after its last success, so for FRESH the string is the current truth.
  await q(
    `INSERT INTO source_health (source_id, status, empty_streak, last_error, last_fail_at, last_ok_at) VALUES
       ($1, 'ok', 3, 'Just a moment...', now() - interval '2 days', now() - interval '1 hour'),
       ($2, 'blocked', 0, 'Just a moment...', now() - interval '1 hour', now() - interval '2 days')`,
    [STALE, FRESH],
  );
  try {
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'sources');
    await assertSaid([c]);
    const stale = c.items.find((i: any) => i.title === STALE);
    assert.ok(stale, 'still listed: the empty streak is a live fact');
    assert.doesNotMatch(stale.detail, /Cloudflare interstitial|re-test/, `stale: an error older than the last success must not become a fix (${stale.detail})`);
    assert.match(stale.detail, /returns nothing/, 'what remains is the live finding, the empty streak');
    const fresh = c.items.find((i: any) => i.title === FRESH);
    assert.ok(fresh, 'listed: it is blocked');
    assert.match(fresh.detail, /Cloudflare interstitial/, 'fresh: an error newer than the last success is still diagnosed');
  } finally {
    await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[STALE, FRESH]]);
  }
});

test('a source that keeps outrunning its budget is listed, as Providers already says', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  // Providers marks a source with slow_streak >= 3 'quiet'; Health selected rows only by status and empty streak,
  // so the source that vanished from Discover for a day (reportSlow's story) was on one surface and not the other.
  // Reintroduce by dropping `OR sh.slow_streak >= 3` from sourceTrouble()'s WHERE: the slow row is missing.
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  await migrate();
  const SLOW = 'hl-slow';
  const S_SLOW = 's_health_slow';
  await q('DELETE FROM source_health WHERE source_id = $1', [SLOW]);
  await q('DELETE FROM lib_series WHERE id = $1', [S_SLOW]);
  await q(`INSERT INTO source_health (source_id, status, slow_streak, last_slow_at, last_error) VALUES ($1, 'ok', 4, now(), 'timeout after 8000ms')`, [SLOW]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id)
           VALUES ($1, 'test', 'Slow Fixture', $1, 3, $2, 's1')`, [S_SLOW, SLOW]);
  try {
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'sources');
    await assertSaid([c]);
    const row = c.items.find((i: any) => i.sourceId === SLOW);
    assert.ok(row, 'listed');
    assert.notEqual(row.info, true, 'a series depends on it, so it is a finding');
    assert.equal(row.diagnosis.code, 'too_slow', 'and the diagnosis is the slow one, with the budget');
    assert.match(row.detail, /longer than 8s/);
  } finally {
    await q('DELETE FROM lib_series WHERE id = $1', [S_SLOW]);
    await q('DELETE FROM source_health WHERE source_id = $1', [SLOW]);
  }
});

/**
 * The prune that runs when an extension is uninstalled must keep the health row of a source that still
 * has series. That row is the only record the source ever existed, and those series are frozen, not gone.
 * This exercises the function the route calls; the route itself needs a live extension server.
 *
 * Reintroduce by dropping the NOT EXISTS clause in pruneOrphanedHealth: orphan-b is deleted and this fails.
 */
test('uninstall prunes an orphaned health row and keeps one that still has series', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { pruneOrphanedHealth } = await import('../src/lib/sourceHealth');
  await migrate();
  const A = 'sw:orphan-a', B = 'sw:orphan-b', SB = 's_health_orphan_b';
  await q('DELETE FROM lib_series WHERE id = $1', [SB]);
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[A, B]]);
  await q(`INSERT INTO source_health (source_id, status) VALUES ($1, 'down'), ($2, 'ok')`, [A, B]);
  await q(`INSERT INTO lib_series (id, source, title, folder, source_id, source_series_id) VALUES ($1, 'test', 'Orphan B', $1, $2, '1')`, [SB, B]);
  try {
    const pruned = await pruneOrphanedHealth([A, B]);
    assert.equal(pruned, 1, 'exactly one row went');
    const left = (await q<{ source_id: string }>('SELECT source_id FROM source_health WHERE source_id = ANY($1::text[]) ORDER BY 1', [[A, B]])).map((r) => r.source_id);
    assert.deepEqual(left, [B], 'the orphan went, the one with a series stayed');
  } finally {
    await q('DELETE FROM lib_series WHERE id = $1', [SB]);
    await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[A, B]]);
  }
});

const S_HELD = 's_health_held';

/**
 * What the library HOLDS is one question with one answer (lib/libraryNumbers.ts), and this page used to get
 * it wrong in both directions: a chapter deleted on purpose still counted as a hole the page told you to
 * fill -- a finding that could not be cleared by doing what it asked -- while a renumber made through the
 * series page left the old number reported for ever.
 *
 * Reintroduce by reading `lib_books.number` raw in chapterGaps() (no `haveNumbers`, no `heldBooks`, no
 * override join): the deliberate deletion becomes a gap again and the renumbered chapter never fills one.
 */
test('a deliberate deletion is not a gap, a file that went missing is, and a renumber is honoured', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  await migrate();
  await q('DELETE FROM lib_series WHERE id = $1', [S_HELD]);
  await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'test','Held Fixture',$1)`, [S_HELD]);
  for (const n of [1, 2, 3, 4, 5]) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, title, number, pages)
             VALUES ($1,$2,'test',$3,$4,$5,20)`,
      [`b_${S_HELD}_${n}`, S_HELD, `/test/${S_HELD}/${n}.cbz`, `Chapter ${n}`, n]);
  }
  // 3: the verify task found the file simply gone. Not held -- fetching it again is the whole point.
  await q(`UPDATE lib_books SET pruned_at = now(), pruned_reason = 'missing' WHERE id = $1`, [`b_${S_HELD}_3`]);
  // 4: deleted on purpose. Held, so the sweep does not fetch it back and this page must not ask for it.
  await q(`UPDATE lib_books SET pruned_at = now(), pruned_reason = 'deleted' WHERE id = $1`, [`b_${S_HELD}_4`]);
  const gapItem = async () => {
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'chapter-gaps');
    return c.items.find((i: any) => i.title === 'Held Fixture');
  };
  try {
    const item = await gapItem();
    assert.ok(item, 'the missing file is a gap');
    assert.match(item.detail, /^1 missing — 3/, `only the missing one (${item.detail})`);
    assert.deepEqual(item.numbers, [3], 'the chip is told which numbers, so it can say so');
    assert.deepEqual(item.actions, ['fill', 'ignore'], 'and offers to look for a source that has them (or to stop being told)');

    // An admin renumbers chapter 5 to 3 through the series page: the hole is filled by a row that is
    // already there, and the finding must clear itself.
    await q(`INSERT INTO book_overrides (book_id, number) VALUES ($1, 3)`, [`b_${S_HELD}_5`]);
    assert.equal(await gapItem(), undefined, 'a renumber the rest of the product honours clears the gap');
  } finally {
    await q('DELETE FROM book_overrides WHERE book_id = $1', [`b_${S_HELD}_5`]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = $1', [S_HELD]);
  }
});

const S_OUT = 's_health_outlier';

/**
 * The live signature: "Player Who Returned 10,000 Years Later" chapter 10000, the title's number parsed as
 * a chapter. The finding now carries the rows it is about, because the fix is a delete and a delete needs
 * ids -- and it clears itself when an admin corrects the number instead.
 *
 * Reintroduce by reading `lib_books.number` raw in outlierChapters() (no overrides, no `heldBooks`): the
 * renumbered chapter is reported as impossible again, and so is the one already deleted.
 */
test('an impossible chapter number is offered for deletion, unless it was renumbered or already deleted', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  await migrate();
  await q('DELETE FROM lib_series WHERE id = $1', [S_OUT]);
  await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'test','Outlier Fixture',$1)`, [S_OUT]);
  for (const n of [1, 2, 3, 4, 5, 10000]) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, title, number, pages)
             VALUES ($1,$2,'test',$3,$4,$5,20)`,
      [`b_${S_OUT}_${n}`, S_OUT, `/test/${S_OUT}/${n}.cbz`, `Chapter ${n}`, n]);
  }
  const outlier = async () => {
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'outliers');
    await assertSaid([c]);
    return c.items.find((i: any) => i.title === 'Outlier Fixture');
  };
  try {
    const item = await outlier();
    assert.ok(item, 'the sidebar-widget number is reported');
    assert.match(item.detail, /1 chapter\(s\) up to 10000/);
    assert.deepEqual(item.bookIds, [`b_${S_OUT}_10000`], 'the chip is told exactly which chapter to delete');
    assert.deepEqual(item.numbers, [10000]);
    assert.deepEqual(item.actions, ['delete', 'ignore'], 'deleting is the action, and it is never automatic');
    // v0.55.0 integration: the 10000 is this card's, never 9,994 missing chapters on the gaps card -- a hole nothing can
    // fetch, which Fix everything's gap step leaves alone, so a bookmarked one kept "the next run continues" on its end
    // for good. A real hole below it is still a gap. Reintroduce by counting every number in chapterGaps (drop
    // plausibleNumbers): "an impossible number is the outliers card's, not a gap of thousands" fails.
    const gapRow = async () => (await runHealthChecks()).checks.find((x: any) => x.id === 'chapter-gaps').items.find((i: any) => i.title === 'Outlier Fixture');
    assert.equal(await gapRow(), undefined, 'an impossible number is the outliers card\'s, not a gap of thousands');
    await q('DELETE FROM lib_books WHERE id = $1', [`b_${S_OUT}_4`]);
    assert.deepEqual((await gapRow())?.numbers, [4], 'a real hole below an impossible number is still a gap');
    await q(`INSERT INTO lib_books (id, series_id, source, file, title, number, pages) VALUES ($1,$2,'test',$3,'Chapter 4',4,20)`,
      [`b_${S_OUT}_4`, S_OUT, `/test/${S_OUT}/4.cbz`]);

    await q(`INSERT INTO book_overrides (book_id, number) VALUES ($1, 6)`, [`b_${S_OUT}_10000`]);
    assert.equal(await outlier(), undefined, 'correcting the number clears the finding');

    await q('DELETE FROM book_overrides WHERE book_id = $1', [`b_${S_OUT}_10000`]);
    await q(`UPDATE lib_books SET pruned_at = now(), pruned_reason = 'deleted' WHERE id = $1`, [`b_${S_OUT}_10000`]);
    assert.equal(await outlier(), undefined, 'and so does deleting it: the finding cannot outlive its rows');
  } finally {
    await q('DELETE FROM book_overrides WHERE book_id = $1', [`b_${S_OUT}_10000`]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = $1', [S_OUT]);
  }
});

const S_TWICE = 's_health_twice';

/**
 * v0.50.0: a chapter downloaded again in another site's split, before the sweep compared parts (lib/partAlias.ts).
 * The seeded pair is Tales of Demons and Gods' 335: mangapill's 335 and 335.5 first, mangaread's 335.1 and 335.6
 * days later. Beside it, 336.5 came from mangaread too -- but under mangapill's own numbering, as the fallback takes a
 * part the main source failed (lib/chapterFallback.ts), and mangapill lists 336.5: that is not a second copy.
 * Reintroduce by dropping the listing test in savedTwice: "the chip names the later files, and only them" fails, with
 * 336.5 offered for deletion.
 */
test('the same chapter saved twice names the later split, offers Delete only for it, warns, and never deletes', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  await migrate();
  await q('DELETE FROM lib_series WHERE id = $1', [S_TWICE]);
  await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'test','Saved Twice Fixture',$1)`, [S_TWICE]);
  const DAY = 86_400_000, t0 = Date.UTC(2026, 8, 1);
  const files: Array<[number, string, number]> = [
    [335, 'tw-pill', t0], [335.5, 'tw-pill', t0 + 1000], [336, 'tw-pill', t0 + 2000], [334, 'tw-pill', t0 - DAY],
    [336.5, 'tw-read', t0 + 3000], [335.1, 'tw-read', t0 + 30 * DAY], [335.6, 'tw-read', t0 + 30 * DAY + 1000],
  ];
  for (const [n, src, mtime] of files) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, title, number, pages, source_id, mtime)
             VALUES ($1,$2,'test',$3,$4,$5,20,$6,$7)`, [`b_${S_TWICE}_${n}`, S_TWICE, `/test/${S_TWICE}/${n}.cbz`, `Chapter ${n}`, n, src, mtime]);
  }
  await q(`INSERT INTO series_listing (series_id, number, title, source_id, chosen, status, copies)
           VALUES ($1, 336.5, 'Chapter 336.5', 'tw-pill', '{}'::jsonb, 'available', $2::jsonb)`,
    [S_TWICE, JSON.stringify([{ sourceId: 'p336.5', source: 'tw-pill', groups: [] }, { sourceId: 'r336.5', source: 'tw-read', groups: [] }])]);
  const check = async () => {
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'saved-twice');
    await assertSaid([c]);
    return c;
  };
  try {
    const c = await check();
    assert.ok(c, 'the check is on the page');
    const item = c.items.find((i: any) => i.title === 'Saved Twice Fixture');
    assert.ok(item, 'the later split of 335 is reported');
    assert.deepEqual(item.bookIds, [`b_${S_TWICE}_335.1`, `b_${S_TWICE}_335.6`], 'the chip names the later files, and only them');
    assert.deepEqual(item.numbers, [335.1, 335.6]);
    assert.ok(!item.bookIds.includes(`b_${S_TWICE}_336.5`), 'the fallback\'s part under mangapill\'s own numbering is not a second copy');
    assert.equal(item.detail, '2 files from tw-read saved again in another split: 335.1, 335.6');
    assert.deepEqual(item.actions, ['delete'], 'Delete is offered, and nothing else does anything on its own');
    assert.equal(c.status, 'warn', 'a card with something to look at reads All good');
    assert.equal(item.info, undefined, 'a finding, not a row for reference');
    assert.equal(c.summary, '1 series has chapters saved twice, split two ways');
    assert.equal((await q('SELECT count(*)::int AS n FROM lib_books WHERE series_id = $1 AND pruned_at IS NULL', [S_TWICE]))[0].n, files.length,
      'running the check deleted nothing');

    // The existing delete path keeps the rows as tombstones; the finding goes with the files.
    await q(`UPDATE lib_books SET pruned_at = now(), pruned_reason = 'deleted' WHERE id = ANY($1)`, [item.bookIds]);
    const after = await check();
    assert.equal(after.items.find((i: any) => i.title === 'Saved Twice Fixture'), undefined, 'deleting the later files clears it');
    assert.equal(after.status, after.items.length ? 'warn' : 'ok', 'and the card is all good once nothing is left');
  } finally {
    await q('DELETE FROM lib_series WHERE id = $1', [S_TWICE]);
  }
});

const S_SHORT = 's_health_short';

/**
 * "Fix" replaces a file, so it is offered only for a file this server downloaded and named itself. For
 * somebody's own copy in the read library the only honest chip is "It's fine" -- and a chapter already
 * confirmed short is greyed, with WHEN and WHAT was decided, rather than being reported every night for
 * ever. The nightly repair skips a confirmed chapter, which is why its only chip is the one that withdraws
 * the confirmation.
 *
 * Reintroduce by offering `fix_short` for every row (dropping the root/name check in shortChapters()): the
 * read-library assertion fails -- the page offers to overwrite a file we did not write.
 */
test('a short chapter offers Fix only for a file we downloaded, and a confirmed one is greyed with what was decided', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  const { DL_ROOT } = await import('../src/lib/library');
  const { chapterFileRel } = await import('../src/lib/downloader');
  await migrate();
  await q('DELETE FROM lib_series WHERE id = $1', [S_SHORT]);
  await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'test','Short Fixture',$1)`, [S_SHORT]);
  const book = (n: number, pages: number, root: string, file: string) =>
    q(`INSERT INTO lib_books (id, series_id, source, file, title, number, pages, root)
       VALUES ($1,$2,'test',$3,$4,$5,$6,$7)`,
      [`b_${S_SHORT}_${n}`, S_SHORT, file, `Chapter ${n}`, n, pages, root]);
  await book(3, 2, DL_ROOT, chapterFileRel(S_SHORT, 3));
  await book(4, 1, '/library', `${S_SHORT}/Ch 04 [somescan].cbz`);
  await book(5, 2, DL_ROOT, chapterFileRel(S_SHORT, 5));
  await book(6, 1, DL_ROOT, chapterFileRel(S_SHORT, 6));
  await book(7, 2, DL_ROOT, chapterFileRel(S_SHORT, 7));
  await book(8, 1, DL_ROOT, chapterFileRel(S_SHORT, 8));
  await q(`UPDATE lib_books SET short_confirmed_at = now() WHERE id = $1`, [`b_${S_SHORT}_5`]);
  // Saved with a placeholder page: the chapter sweep re-fetches it, and the repair's short step skips it.
  await q(`UPDATE lib_books SET missing_pages = ARRAY[2] WHERE id = $1`, [`b_${S_SHORT}_7`]);
  // "It's fine", pressed by an admin (the confirm-short route writes both).
  await q(`UPDATE lib_books SET short_confirmed_at = now(),
                  short_result = '{"at":"2026-09-01T00:00:00.000Z","why":"confirmed_by_admin","by":"hs-admin"}'::jsonb
            WHERE id = $1`, [`b_${S_SHORT}_8`]);
  // A tombstoned chapter: the bytes are gone, so a page count taken before they went says nothing anybody
  // can act on. Reintroduce by dropping `b.pruned_at IS NULL` from shortChapters(): it is reported again.
  await q(`UPDATE lib_books SET pruned_at = now(), pruned_reason = 'deleted' WHERE id = $1`, [`b_${S_SHORT}_6`]);
  try {
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'short-chapters');
    await assertSaid([c]);
    const of = (n: number) => c.items.find((i: any) => i.bookId === `b_${S_SHORT}_${n}`);
    const ours = of(3);
    assert.ok(ours, 'our own short chapter is reported');
    assert.equal(ours.number, 3, 'the chip is told which chapter');
    assert.deepEqual(ours.actions, ['fix_short', 'confirm_short']);
    assert.notEqual(ours.info, true);
    const theirs = of(4);
    assert.ok(theirs, 'a read-library chapter is reported too');
    assert.deepEqual(theirs.actions, ['confirm_short'], 'but never offered a replacement of a file we did not write');
    const confirmed = of(5);
    assert.ok(confirmed, 'a confirmed chapter stays listed');
    assert.equal(confirmed.info, true, 'greyed: it is not a fault any more');
    assert.equal(confirmed.fixed?.what, 'confirmed short at the source');
    assert.ok(Date.parse(confirmed.fixed?.at) > 0, 'and says when that was decided');
    assert.deepEqual(confirmed.actions, ['confirm_short'], 'its one chip is the one that withdraws the confirmation');
    assert.equal(of(6), undefined, 'a deleted chapter is not a short chapter');
    // v0.49.0. Reintroduce by offering fix_short on a row with missing_pages again: the actions below read
    // ['fix_short', 'confirm_short'], and Fix would do nothing (stepShort filters `missing_pages IS NULL`).
    const partial = of(7);
    assert.deepEqual(partial.actions, ['confirm_short'], 'a chapter with placeholder pages is not offered Fix');
    assert.deepEqual(partial.outcome, { kind: 'short', at: null, why: 'partial', missing: 1 }, 'and says why');
    const fine = of(8);
    assert.equal(fine.fixed?.what, 'marked fine by an admin', 'a person\'s judgement is not claimed as the repair\'s proof');
    assert.equal(fine.outcome?.why, 'confirmed_by_admin');
    assert.equal(fine.outcome?.by, 'hs-admin');
    assert.match(c.summary, /2 confirmed short at the source/);
    assert.match(c.note, /Counted nightly by the repair task/, 'the note no longer says only opened chapters count');
  } finally {
    await q('DELETE FROM lib_series WHERE id = $1', [S_SHORT]);
  }
});

const S_STRIP = 's_health_strip';

/**
 * A chapter stitched into one or two long strips is a whole chapter (v0.55.10, lib/longStrip.ts): on the live server 6 of
 * the 20 "short" chapters were, Eleceed 215 two 689 x 54,000 strips among them, and a file in the read library is never
 * the repair's to look at, so each stayed a finding until somebody pressed "It's fine". Measured from the file once, into
 * the reader's cache. Reintroduce by dropping the `longStrip` test in shortChapters(): chapter 1 is listed.
 */
test('a chapter stitched into long strips is not short', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  const sharp = (await import('sharp')).default;
  const AdmZip = require('adm-zip');
  await migrate();
  const root = mkdtempSync(join(tmpdir(), 'uchi-strip-'));
  const cbz = async (file: string, pages: Array<[number, number]>) => {
    const z = new AdmZip();
    for (const [i, [width, height]] of pages.entries()) {
      z.addFile(`${String(i + 1).padStart(3, '0')}.png`, await sharp({ create: { width, height, channels: 3, background: '#777' } }).png().toBuffer());
    }
    mkdirSync(join(root, S_STRIP), { recursive: true });
    writeFileSync(join(root, file), z.toBuffer());
  };
  await q('DELETE FROM lib_series WHERE id = $1', [S_STRIP]);
  await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'test','Strip Fixture',$1)`, [S_STRIP]);
  const book = (n: number, pages: number) =>
    q(`INSERT INTO lib_books (id, series_id, source, file, title, number, pages, root) VALUES ($1,$2,'test',$3,$4,$5,$6,$7)`,
      [`b_${S_STRIP}_${n}`, S_STRIP, `${S_STRIP}/Ch ${n}.cbz`, `Chapter ${n}`, n, pages, root]);
  // Two strips 7 widths tall each, 14 together; a credits banner wider than tall; a notice 5.4 widths tall.
  await cbz(`${S_STRIP}/Ch 1.cbz`, [[10, 70], [10, 70]]);
  await cbz(`${S_STRIP}/Ch 2.cbz`, [[76, 44]]);
  await cbz(`${S_STRIP}/Ch 3.cbz`, [[20, 108]]);
  await book(1, 2);
  await book(2, 1);
  await book(3, 1);
  await book(4, 1); // its file is gone: nothing to measure
  try {
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'short-chapters');
    const listed = (n: number) => c.items.some((i: any) => i.bookId === `b_${S_STRIP}_${n}`);
    assert.equal(listed(1), false, 'two long strips are a whole chapter');
    assert.ok(listed(2), 'a banner wider than tall is what a failed download leaves');
    assert.ok(listed(3), 'and so is a notice five widths tall');
    assert.ok(listed(4), 'a chapter that cannot be measured stays a finding');
    const [cached] = await q<{ page_dims: Array<{ width: number; height: number }> }>(
      'SELECT page_dims FROM lib_books WHERE id = $1', [`b_${S_STRIP}_1`]);
    assert.deepEqual(cached.page_dims.map((d) => [d.width, d.height]), [[10, 70], [10, 70]], "measured once, into the reader's cache");
  } finally {
    await q('DELETE FROM lib_series WHERE id = $1', [S_STRIP]);
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * "It keeps taking longer than 15 s" is about browsing today (v0.55.10, lib/sourceHealth.ts slowStreakNow): one evening's
 * slow searches through a busy solver held four sources on the card for six days of fast answers. Reintroduce by reading
 * `slow_streak` as stored in sourceTrouble(): the six-day-old streak is listed.
 */
test('a slow streak nobody has added to in a day is no finding', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  await migrate();
  const SRC = 'hs-slow-stale', S = 's_health_slow_stale';
  await q('DELETE FROM lib_series WHERE id = $1', [S]);
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC]);
  await q(`INSERT INTO lib_series (id, source, title, folder, source_id) VALUES ($1,'test','Slow Fixture',$1,$2)`, [S, SRC]);
  await q(`INSERT INTO source_health (source_id, slow_streak, last_slow_at, last_error)
           VALUES ($1, 5, now() - interval '6 days', 'timeout after 15000ms')`, [SRC]);
  try {
    const row = async () => (await runHealthChecks()).checks.find((x: any) => x.id === 'sources').items.find((i: any) => i.sourceId === SRC);
    assert.equal(await row(), undefined, 'six days on, a slow streak says nothing about the next search');
    await q(`UPDATE source_health SET last_slow_at = now() - interval '1 hour' WHERE source_id = $1`, [SRC]);
    const fresh = await row();
    assert.ok(fresh, 'while somebody is still running into it, it is listed');
    assert.equal(fresh.state, 'slow');
    assert.notEqual(fresh.info, true, 'and it is a finding: a series uses the source');
  } finally {
    await q('DELETE FROM lib_series WHERE id = $1', [S]);
    await q('DELETE FROM source_health WHERE source_id = $1', [SRC]);
  }
});

const S_GR = 's_health_gapsresult';

/**
 * A gap the nightly repair has already searched for, and found nobody carrying, is not a fault: it is an
 * answer, and repeating it in amber every day is how a health page trains people to ignore it. It goes grey
 * WITH the answer and the date -- and goes back to amber when the answer goes stale, when the library has
 * moved on since, or when nobody actually asked (a cooldown is silence, not an answer).
 *
 * Reintroduce by greying on `gaps_checked_at` alone (dropping the `why` whitelist and the freshness check):
 * the cooldown and the stale assertions below fail -- a gap nobody has looked at in a fortnight, and one
 * whose search never ran, both read as settled.
 */
test('a gap the repair has already looked into is greyed until its answer goes stale', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  await migrate();
  await q('DELETE FROM lib_series WHERE id = $1', [S_GR]);
  await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'test','Gaps Result Fixture',$1)`, [S_GR]);
  for (const n of [1, 2, 3, 7, 8]) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, title, number, pages)
             VALUES ($1,$2,'test',$3,$4,$5,20)`,
      [`b_${S_GR}_${n}`, S_GR, `/test/${S_GR}/${n}.cbz`, `Chapter ${n}`, n]);
  }
  const item = async () => {
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'chapter-gaps');
    await assertSaid([c]);
    return c.items.find((i: any) => i.title === 'Gaps Result Fixture');
  };
  // The stamp and the conclusion at the same time, as a finished run leaves them; `concluded` apart from the
  // stamp is a run that is on this series right now.
  const AGO: Record<string, number> = { '1 hour': 3600e3, '8 days': 8 * 864e5 };
  const stamp = async (ago: string, result: Record<string, unknown>, concluded = ago) =>
    q(`UPDATE lib_series SET gaps_checked_at = now() - $2::interval, gaps_result = $3::jsonb WHERE id = $1`,
      [S_GR, ago, JSON.stringify({ at: new Date(Date.now() - AGO[concluded]).toISOString(), have_count: 5, ...result })]);
  try {
    const first = await item();
    assert.ok(first, 'never looked at: a plain finding');
    assert.notEqual(first.info, true);
    assert.equal(first.fixed, undefined, 'nothing has been decided about it yet');

    await stamp('1 hour', { why: 'no_candidate', sweep: 0, unfillable: ['4-6'], scanned: 3 });
    const asked = await item();
    assert.equal(asked.info, true, 'asked, and the answer was no: greyed');
    assert.equal(asked.fixed?.what, 'no other source lists them');
    // v0.49.0: the conclusion is data the page translates, not an English suffix on the detail.
    // Reintroduce the suffix and the first assertion fails; drop `outcome` and the rest do.
    assert.equal(asked.detail, '3 missing — 4-6', 'the detail is the finding alone');
    assert.equal(asked.outcome?.kind, 'gaps');
    assert.equal(asked.outcome?.why, 'no_candidate');
    assert.deepEqual(asked.outcome?.unfillable, ['4-6']);
    assert.equal(asked.outcome?.scanned, 3);
    assert.ok(Date.parse(asked.outcome?.at) > Date.now() - 2 * 3600e3, 'and when it was concluded');

    await stamp('8 days', { why: 'no_candidate', sweep: 0 });
    assert.notEqual((await item()).info, true, 'an answer older than a week is worth asking again');

    // A run stamps the series BEFORE it searches, so mid-run the stamp is fresh while the stored answer is
    // still last week's. Reintroduce by judging freshness on gaps_checked_at: this reads as settled.
    await stamp('1 hour', { why: 'no_candidate', sweep: 0 }, '8 days');
    assert.notEqual((await item()).info, true, "last week's answer is not made fresh by tonight's stamp");

    await stamp('1 hour', { why: 'cooldown', sweep: 0 });
    assert.notEqual((await item()).info, true, 'a cooldown is not an answer: nobody was asked');

    // #116: a series numbered by posting order is never searched for -- no other site's numbers line up -- and
    // the repair says so. That is an answer too, greyed like "nobody lists them". Reintroduce by leaving
    // 'posting_order' out of ANSWERED (lib/health.ts): it stays amber every night.
    await stamp('1 hour', { why: 'posting_order', sweep: 0 });
    const numbered = await item();
    assert.equal(numbered.info, true, 'numbered by posting order: an answer, greyed');
    assert.equal(numbered.fixed?.what, 'this series is numbered by posting order, so no other source is searched', 'and the row says why');

    // Something landed since the search ran, so the hole may have moved.
    await stamp('1 hour', { why: 'no_candidate', sweep: 0, have_count: 4 });
    assert.notEqual((await item()).info, true, 'an answer about a different library is not about this one');

    // Every missing chapter is listed on a source we already follow: the ordinary sweep's job, not a search's.
    await stamp('1 hour', { why: 'listed', sweep: 3 });
    const listed = await item();
    assert.equal(listed.info, true, 'a hole the chapter sweep is about to fill is not a finding');
    assert.equal(listed.outcome?.why, 'listed');
    assert.equal(listed.outcome?.sweep, 3);
    assert.match(listed.fixed?.what, /the next chapter sweep will fetch them/);

    // A paused series: nothing but Fill now will ever fetch its gaps, and the row says so before the press.
    // Reintroduce by dropping the caveat: the assertion below finds none.
    assert.equal(listed.caveats, undefined, 'updates on: no caveat');
    await q('UPDATE lib_series SET auto_update = false WHERE id = $1', [S_GR]);
    assert.deepEqual((await item()).caveats, [{ action: 'fill', code: 'updates_paused' }]);
  } finally {
    await q('DELETE FROM lib_series WHERE id = $1', [S_GR]);
  }
});

test('holes below a series\' "Latest N" start are listed for reference; the holes above it are still the finding', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  // v0.55.0. Reintroduce by counting every hole in chapterGaps (drop splitAtFloor): the first row counts six missing
  // with 4-6 and 9 among them, and the second is a finding with Fill now on it.
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  await migrate();
  const S = 's_health_floor';
  await q('DELETE FROM lib_series WHERE id = $1', [S]);
  await q(`INSERT INTO lib_series (id, source, title, folder, chapter_floor) VALUES ($1,'test','Floor Fixture',$1,10)`, [S]);
  for (const n of [1, 2, 3, 7, 8, 12, 13]) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, title, number, pages) VALUES ($1,$2,'test',$3,$4,$5,20)`,
      [`b_${S}_${n}`, S, `/test/${S}/${n}.cbz`, `Chapter ${n}`, n]);
  }
  const check = async () => {
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'chapter-gaps');
    await assertSaid([c]);
    return { c, row: c.items.find((i: any) => i.seriesId === S) };
  };
  try {
    // Holes 4-6 and 9-11 with the series started at chapter 10: 4-6 and 9 are before the start, 10-11 is the finding.
    const mixed = (await check()).row;
    assert.notEqual(mixed.info, true, 'a hole at or above the start is still a finding');
    assert.deepEqual(mixed.numbers, [10, 11], 'and only it is what Fill now is about');
    assert.equal(mixed.detail, '2 missing — 10-11; 4 more before where you started (chapter 10)');
    assert.ok(mixed.actions.includes('fill'));

    await q('UPDATE lib_series SET chapter_floor = 13 WHERE id = $1', [S]);
    const { c, row } = await check();
    assert.equal(row.info, true, 'every hole before the start: listed for reference');
    assert.equal(row.detail, '6 missing before where you started (chapter 13) — 4-6, 9-11');
    assert.equal(row.actions, undefined, 'with nothing to press');
    assert.ok(c.summarySaid.some((p: any) => p.code === 'gaps.beforeStart'), 'and the summary counts it apart from "already looked into"');
  } finally {
    await q('DELETE FROM lib_series WHERE id = $1', [S]);
  }
});

const D1 = 's_health_dup_a', D2 = 's_health_dup_b';

/**
 * A merge is one-way and it moves everything into the survivor, so the survivor this page SUGGESTS has to
 * be the copy that would lose the most by being the one absorbed: most live chapters, then the one people
 * have actually read, then the older row (the id in everybody's links and history).
 *
 * Reintroduce by suggesting `ids[0]` (the alphabetically first title, which is what `array_agg ORDER BY
 * ls.title` gives): the first assertion below keeps the copy with one chapter over the one with three.
 */
test('a duplicate pair suggests the copy with the most to lose as the one to keep', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  await migrate();
  const USER = 'hl-dup-reader';
  await q('DELETE FROM lib_series WHERE id = ANY($1::text[])', [[D1, D2]]);
  await q('DELETE FROM users WHERE username = $1', [USER]);
  // D1 is the older row and holds three chapters; D2 is newer, holds one, and somebody has read it.
  // ⚠️ D1's title sorts LAST on purpose: `array_agg(... ORDER BY ls.title)` would otherwise put the right
  // answer first by accident, and this test would pass against a keep that is simply `ids[0]`.
  await q(`INSERT INTO lib_series (id, source, title, folder, created_at) VALUES ($1,'test','Zeta Copy',$1, now() - interval '30 days')`, [D1]);
  await q(`INSERT INTO lib_series (id, source, title, folder, created_at) VALUES ($1,'test','Alpha Copy',$1, now())`, [D2]);
  for (const n of [1, 2, 3]) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, title, number, pages)
             VALUES ($1,$2,'test',$3,$4,$5,20)`, [`b_${D1}_${n}`, D1, `/test/${D1}/${n}.cbz`, `Chapter ${n}`, n]);
  }
  await q(`INSERT INTO lib_books (id, series_id, source, file, title, number, pages)
           VALUES ($1,$2,'test',$3,$4,1,20)`, [`b_${D2}_1`, D2, `/test/${D2}/1.cbz`, 'Chapter 1']);
  const uid = (await q<{ id: string }>(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                                        VALUES ($1,$1,'x','user','password') RETURNING id`, [USER]))[0].id;
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,5,true)`,
    [uid, `b_${D2}_1`, D2]);
  // checked_at: automatic links as v0.55.7 writes them, held to the title check; Health groups only those.
  await q(`INSERT INTO series_trackers (series_id, provider, external_id, title, checked_at) VALUES ($1,'anilist','hl-dup-1','Dup', now()), ($2,'anilist','hl-dup-1','Dup', now())`, [D1, D2]);
  const item = async () => {
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'duplicates');
    await assertSaid([c]);
    return c.items.find((i: any) => (i.seriesIds ?? []).includes(D1));
  };
  try {
    const pair = await item();
    assert.ok(pair, 'the pair is reported');
    assert.deepEqual([...pair.seriesIds].sort(), [D1, D2].sort());
    assert.equal(pair.keep, D1, 'chapters first: three beats one, read or not');
    assert.deepEqual(pair.actions, ['merge', 'ignore'], 'and merging is offered, one pair at a time');

    // Both down to one live chapter: the copy somebody has read wins over the older one.
    await q(`UPDATE lib_books SET pruned_at = now(), pruned_reason = 'deleted' WHERE id = ANY($1::text[])`,
      [[`b_${D1}_2`, `b_${D1}_3`]]);
    assert.equal((await item()).keep, D2, 'then readers: a copy with progress on it is the one to keep');

    await q('DELETE FROM read_progress WHERE user_id = $1', [uid]);
    assert.equal((await item()).keep, D1, 'and last the older row, whose id is in everybody\'s links');
  } finally {
    await q('DELETE FROM series_trackers WHERE external_id = $1', ['hl-dup-1']).catch(() => {});
    await q('DELETE FROM read_progress WHERE user_id = $1', [uid]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1::text[])', [[D1, D2]]).catch(() => {});
    await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  }
});

const S_FAIL = 's_health_fail';

/**
 * v0.55.1: a source whose every failing chapter was refused for room (HTTP 429, status `rate_limited`) is waiting, not
 * failing. The owner's Health read "70 chapters across 4 sources keep failing" in amber while Fix everything said the
 * rate-limited ones clear by themselves. One chapter failing any other way keeps the source a finding.
 *
 * Reintroduce by dropping the `info` line in health.ts chapterFailures: the card is amber with only waiting chapters.
 */
test('chapters refused only for room are waiting, not failing', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  await migrate();
  const S = 's_health_wait';
  const SRC = 'health-wait-src';
  await q('DELETE FROM lib_series WHERE id = $1', [S]);
  await q('DELETE FROM chapter_failures WHERE series_id = $1', [S]);
  await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'test','Wait Fixture',$1)`, [S]);
  await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, reason, attempts, at, first_at)
           VALUES ($1, 1, $2, 'rate_limited', 'no images downloaded (blocked?) (page 1: 429)', 1, now(), now()),
                  ($1, 2, $2, 'rate_limited', 'no images downloaded (blocked?) (page 1: 429)', 1, now(), now())`, [S, SRC]);
  const card = async () => {
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'chapter-failures');
    await assertSaid([c]);
    return c;
  };
  try {
    const c = await card();
    const row = c.items.find((i: any) => i.sourceId === SRC);
    assert.equal(row?.info, true, 'a source refusing only for room is a statement, not a finding');
    assert.ok(!c.items.some((i: any) => !i.info), 'nothing else fails in this fixture');
    assert.equal(c.status, 'ok', 'chapters waiting for a pause to end do not turn the card amber');
    assert.match(c.summary, /2 chapters wait for a site that asked for a pause, and are tried again by themselves/);

    // One chapter failing another way: the source is a finding again, and the waiting count is not said beside it.
    await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, reason, attempts, at, first_at)
             VALUES ($1, 3, $2, 'error', 'HTTP 500', 1, now(), now())`, [S, SRC]);
    const mixed = await card();
    assert.notEqual(mixed.items.find((i: any) => i.sourceId === SRC)?.info, true, 'one real failure keeps it a finding');
    assert.equal(mixed.status, 'warn');
    assert.match(mixed.summary, /3 chapters across 1 source keep failing/);
  } finally {
    await q('DELETE FROM chapter_failures WHERE series_id = $1', [S]);
    await q('DELETE FROM lib_series WHERE id = $1', [S]);
  }
});

/**
 * v0.49.0: "failing since" is the FIRST failure (first_at), not the latest attempt, and a source that cannot
 * be asked right now says so on its Retry now before anyone presses it.
 *
 * Reintroduce by reading min(f.at) again: `since` is the latest attempt. Drop the caveat builder: none is found.
 */
test('the failures row says since when, how often, and what Retry now cannot do yet', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  await migrate();
  const SRC = 'health-fail-src';
  await q('DELETE FROM lib_series WHERE id = $1', [S_FAIL]);
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC]);
  await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'test','Fail Fixture',$1)`, [S_FAIL]);
  await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, reason, attempts, at, first_at)
           VALUES ($1, 1, $2, 'error', 'x', 2, now() - interval '1 hour', '2026-09-01T00:00:00Z'),
                  ($1, 2, $2, 'error', 'y', 1, now() - interval '2 hours', NULL)`, [S_FAIL, SRC]);
  const row = async () => {
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'chapter-failures');
    await assertSaid([c]);
    return c.items.find((i: any) => i.sourceId === SRC);
  };
  try {
    const r = await row();
    assert.equal(r.outcome?.kind, 'failures');
    assert.equal(r.outcome?.firstAt, '2026-09-01T00:00:00.000Z', 'the first failure, not the latest attempt');
    assert.match(r.detail, /since 2026-09-01/);
    assert.equal(r.outcome?.attempts, 2);
    assert.equal(r.outcome?.resetPending, false);
    assert.equal(r.caveats, undefined, 'a source that can be asked has no caveat');

    await q(`INSERT INTO source_health (source_id, status, consecutive, blocked_until, updated_at)
             VALUES ($1, 'rate_limited', 1, now() + interval '30 minutes', now())`, [SRC]);
    const blocked = await row();
    assert.equal(blocked.caveats?.length, 1);
    assert.equal(blocked.caveats[0].action, 'retry');
    assert.equal(blocked.caveats[0].code, 'source_cooling_down');
    assert.ok(Date.parse(blocked.caveats[0].until) > Date.now(), 'with when it ends');

    await q(`UPDATE source_health SET blocked_until = NULL, disabled = true WHERE source_id = $1`, [SRC]);
    assert.deepEqual((await row()).caveats, [{ action: 'retry', code: 'source_off' }]);
  } finally {
    await q('DELETE FROM lib_series WHERE id = $1', [S_FAIL]);
    await q('DELETE FROM source_health WHERE source_id = $1', [SRC]);
  }
});

const S_ARCH = 's_health_arch', S_ARCH_UP = 's_health_arch_up';

/**
 * #117 x Health (the critic's "health-clarity vs issue-117"): a series' slow archive fetches every number listed below
 * its boundary a few an hour, so a hole it takes whole is its work in progress -- listed for reference, with the
 * outcome `archiving` in place of whatever an older search concluded -- and Fill now says what it will do differently
 * (caveat `archiving`: at once, at normal pace). A hole reaching above the boundary stays a finding; a finished
 * archive owns nothing. Only what it will really fetch, and only while it fetches (integration-2 review): a number the
 * source does not list, or one the archive gave up on, is a gap like any other, and so is every hole of a paused
 * archive, or of any archive while the admin has paused them all.
 *
 * Reintroduce by dropping `archived` from chapterGaps: the first assertion finds a live finding. Drop the caveat
 * builder's archive half: the caveat assertions find none. Count every number below the boundary (archiveHoles
 * without its listing): "a number the source does not list is not the archive's" reads archiving. Count a paused
 * archive: "paused, nothing is fetching them" does; leave the admin's pause out of archiveHoles: "nor while every
 * archive is paused" does.
 */
test("a gap below an active archive's boundary is the archive's, and Fill now says it fetches it at once", { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  await migrate();
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[S_ARCH, S_ARCH_UP]]);
  const book = (sid: string, n: number) => q(`INSERT INTO lib_books (id, series_id, source, file, title, number, pages)
    VALUES ($1,$2,'test',$3,$4,$5,20)`, [`b_${sid}_${n}`, sid, `/test/${sid}/${n}.cbz`, `Chapter ${n}`, n]);
  await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'test','Archived Gap Fixture',$1)`, [S_ARCH]);
  for (const n of [1, 2, 3, 7, 8]) await book(S_ARCH, n);
  await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'test','Half Archived Fixture',$1)`, [S_ARCH_UP]);
  for (const n of [1, 5, 9, 10]) await book(S_ARCH_UP, n);
  // An older search's answer on the archived one: the archive is what is happening to the hole now.
  await q(`UPDATE lib_series SET gaps_checked_at = now(), gaps_result = $2::jsonb WHERE id = $1`,
    [S_ARCH, JSON.stringify({ at: new Date().toISOString(), have_count: 5, why: 'listed', sweep: 3 })]);
  await q(`INSERT INTO archive_queue (series_id, state, boundary) VALUES ($1, 'queued', 8.5), ($2, 'queued', 5.5)
           ON CONFLICT (series_id) DO UPDATE SET state = EXCLUDED.state, boundary = EXCLUDED.boundary`, [S_ARCH, S_ARCH_UP]);
  // What the sources list: the archive fetches listed numbers, and only those.
  const list = (sid: string, n: number) => q(`INSERT INTO series_listing (series_id, number, source_id, chosen) VALUES ($1,$2,'test','{}'::jsonb)
    ON CONFLICT (series_id, number) DO NOTHING`, [sid, n]);
  for (const n of [4, 5, 6]) await list(S_ARCH, n);
  for (const n of [2, 3, 4, 6, 7, 8]) await list(S_ARCH_UP, n);
  const gaps = async () => {
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'chapter-gaps');
    await assertSaid([c]);
    return c;
  };
  const item = (c: any, id: string) => c.items.find((i: any) => i.seriesId === id);
  try {
    let c = await gaps();
    const arch = item(c, S_ARCH);
    assert.ok(arch, 'still listed: the hole is there until the archive fills it');
    assert.equal(arch.info, true, 'a hole wholly below the boundary is the archive\'s, not a finding');
    assert.equal(arch.outcome?.kind, 'gaps');
    assert.equal(arch.outcome?.why, 'archiving', 'the outcome says it is being archived');
    assert.equal(arch.outcome?.at, null, 'from no search at all');
    assert.equal(arch.fixed, undefined, "an older search's answer is not what is happening to it now");
    assert.deepEqual(arch.caveats, [{ action: 'fill', code: 'archiving' }], 'Fill now fetches them at once instead');
    assert.match(c.summary, /1 being archived slowly/);
    // Reaching above the boundary (6-8 over 5.5): the sweep owns that part, so it stays a finding.
    const up = item(c, S_ARCH_UP);
    assert.notEqual(up.info, true, 'a hole reaching above the boundary is still a finding');
    assert.notEqual(up.outcome?.why, 'archiving');
    assert.deepEqual(up.caveats, [{ action: 'fill', code: 'archiving' }], 'though Fill now still fetches its lower part at once');
    // Paused, nothing is fetching them: the hole is not being archived, whatever it is waiting for (the sweep still
    // floors at a paused archive's boundary). The older answer stands; Fill now still fetches them at once.
    await q(`UPDATE archive_queue SET state = 'paused' WHERE series_id = $1`, [S_ARCH]);
    c = await gaps();
    assert.equal(item(c, S_ARCH).outcome?.why, 'listed', 'paused, nothing is fetching them: not being archived');
    assert.deepEqual(item(c, S_ARCH).caveats, [{ action: 'fill', code: 'archiving' }]);
    // Finished, it has lifted its boundary: a gap again, with the older answer it had.
    await q(`UPDATE archive_queue SET state = 'done' WHERE series_id = $1`, [S_ARCH]);
    c = await gaps();
    assert.equal(item(c, S_ARCH).outcome?.why, 'listed');
    assert.equal(item(c, S_ARCH).caveats, undefined);
    // Never searched at all, and wholly below an active boundary: the archive's still, not only when an older search
    // had already greyed it. Reintroduce by greying only a searched hole (drop `archived ||` from `info`): a finding.
    await q(`UPDATE archive_queue SET state = 'queued' WHERE series_id = $1`, [S_ARCH]);
    await q('UPDATE lib_series SET gaps_checked_at = NULL, gaps_result = NULL WHERE id = $1', [S_ARCH]);
    assert.equal(item(await gaps(), S_ARCH).info, true, "a hole nobody searched for is the archive's too");
    // The same hole, never searched, is a finding again whenever nothing is fetching it.
    await q(`UPDATE archive_queue SET state = 'paused' WHERE series_id = $1`, [S_ARCH]);
    assert.notEqual(item(await gaps(), S_ARCH).info, true, "a paused archive's hole is a finding: nothing is fetching it");
    await q(`UPDATE archive_queue SET state = 'queued' WHERE series_id = $1`, [S_ARCH]);
    await q('UPDATE server_settings SET archive_paused = true WHERE id = 1');
    try {
      assert.notEqual(item(await gaps(), S_ARCH).info, true, 'nor while every archive is paused');
    } finally {
      await q('UPDATE server_settings SET archive_paused = false WHERE id = 1');
    }
    assert.equal(item(await gaps(), S_ARCH).info, true, 'PREMISE: resumed, the archive\'s again');
    // A number the source does not list is not the archive's: it never fetches it, and read as being archived the
    // hole was never searched for until the archive finished, weeks on.
    await q('DELETE FROM series_listing WHERE series_id = $1 AND number = 5', [S_ARCH]);
    c = await gaps();
    assert.notEqual(item(c, S_ARCH).info, true, "a number the source does not list is not the archive's");
    assert.deepEqual(item(c, S_ARCH).caveats, [{ action: 'fill', code: 'archiving' }], 'though Fill now still fetches the rest at once');
    // Nor is one it gave up on: past the sweep's retry cap, the archive leaves it too.
    await list(S_ARCH, 5);
    await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, attempts) VALUES ($1, 5, 'test', 'error', 99)`, [S_ARCH]);
    assert.notEqual(item(await gaps(), S_ARCH).info, true, 'nor one it gave up on');
  } finally {
    await q('UPDATE server_settings SET archive_paused = false WHERE id = 1');
    await q('DELETE FROM archive_queue WHERE series_id = ANY($1)', [[S_ARCH, S_ARCH_UP]]);
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [[S_ARCH, S_ARCH_UP]]);
  }
});

const NB = ['s_health_nb_pending', 's_health_nb_remap', 's_health_nb_journal', 's_health_nb_auto', 's_health_nb_kept', 's_health_nb_hint', 's_health_nb_old', 's_health_nb_asked'];

/**
 * #116's Health check (the critic's "issue-116 vs health-clarity"): a series in a library is never renamed
 * unattended, so the detector marks it and it downloads nothing until an admin confirms the plan -- which, before
 * this check, only its own series page said. Each waiting series is a finding by name, with `renumber` and, for a
 * change nobody asked for, `keep_numbers`; a journal a crash left is a finding with no key; numbered by posting
 * order on its own lately, a hint, and a strong verdict kept by hand are listed too.
 *
 * Reintroduce by leaving numberingCheck() out of runHealthChecks: the check is not there.
 */
test('the numbering check names every series waiting for a numbering review, with what can be done about it', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  await migrate();
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [NB]);
  const note = (verdict: string) => JSON.stringify({ verdict, ordered: true, posts: 226, numbers: 13, extras: 213, biggest: { number: 7, posts: 73 }, examples: [], source: 'nb-web' });
  const seed = (id: string, cols: Record<string, unknown>) => {
    const keys = ['id', 'source', 'title', 'folder', 'source_id', ...Object.keys(cols)];
    const vals = [id, 'Webtoons (health)', id, id, 'nb-web', ...Object.values(cols)];
    return q(`INSERT INTO lib_series (${keys.join(',')}) VALUES (${keys.map((k, i) => (k === 'numbering_note' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(',')})`, vals);
  };
  await seed(NB[0], { numbering_pending: 'posting_order', numbering_source: 'nb-web', numbering_note: note('strong') });
  await seed(NB[1], { numbering_pending: 'remap' });
  await seed(NB[2], { renumber_plan: JSON.stringify({ v: 1 }) });
  await seed(NB[3], { numbering: 'posting_order', numbering_by: 'auto', numbering_source: 'nb-web', numbering_changed_at: new Date(), numbering_note: note('strong') });
  await seed(NB[4], { numbering: 'source', numbering_by: 'manual', numbering_note: note('strong') });
  await seed(NB[5], { numbering_note: note('hint') });
  await seed(NB[6], { numbering: 'posting_order', numbering_by: 'auto', numbering_changed_at: new Date(Date.now() - 20 * 86_400_000), numbering_note: note('strong') });
  await seed(NB[7], { numbering_pending: 'posting_order', numbering_by: 'manual' });
  const check = async () => {
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'numbering');
    await assertSaid([c]);
    return c;
  };
  const item = (c: any, id: string) => c.items.find((i: any) => i.seriesId === id);
  try {
    const c = await check();
    assert.ok(c, 'the numbering check');
    assert.equal(c.title, 'Chapter numbering');
    assert.equal(c.status, 'warn');
    const pending = item(c, NB[0]);
    assert.equal(pending.title, NB[0], 'named by its series');
    assert.equal(pending.sourceId, 'nb-web', 'and its numbering source, for the extension settings link');
    assert.deepEqual(pending.actions, ['renumber', 'keep_numbers']);
    assert.notEqual(pending.info, true);
    assert.match(pending.detail, /gives 213 of 226 posts a number another post has \(73 are all 7\)/);
    // nb-web is no adapter this process has loaded (an extension the engine is not serving): the source is named as
    // the series was added. Reintroduce by falling back to the id (`getSource(src)?.name || src` in numberingCheck):
    // "nb-web gives ...".
    assert.match(pending.detail, /^Webtoons \(health\) gives/, 'a source that is not loaded is named as the series was added, not by its id');
    assert.match(pending.detail, /Nothing downloads for this series/);
    assert.deepEqual(item(c, NB[1]).actions, ['renumber'], 'a remap is confirmed, never declined');
    assert.match(item(c, NB[1]).detail, /extension setting changed/);
    const journal = item(c, NB[2]);
    assert.equal(journal.actions, undefined, 'the check that finishes it is the way out');
    assert.match(journal.detail, /interrupted/);
    assert.notEqual(journal.info, true);
    assert.deepEqual([item(c, NB[3]).info, item(c, NB[3]).actions], [true, ['keep_numbers']], 'numbered on its own lately: for reference');
    assert.deepEqual([item(c, NB[4]).info, item(c, NB[4]).actions], [true, ['renumber']], 'kept by hand: for reference');
    assert.deepEqual([item(c, NB[5]).info, item(c, NB[5]).actions], [undefined, ['renumber', 'keep_numbers']], 'a hint is worth a look');
    assert.equal(item(c, NB[6]), undefined, 'two weeks on, a series numbered on its own is no longer news');
    assert.deepEqual(item(c, NB[7]).actions, ['renumber'], 'a change an admin asked for is not declined from here');
    assert.match(c.summary, /series wait for a numbering review/);
  } finally {
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [NB]);
  }
});

const S_HOLE = 's_health_hole';

/**
 * #116: a series numbered by posting order keeps the number of a post its source DELETED as a hole (lib/numbering.ts),
 * so nothing after it moves. Nothing can fill it, so it is not a gap (lib/libraryNumbers.ts).
 *
 * Reintroduce by dropping the UNION from HAVE_SQL: the hole at 3 is a gap nobody can ever clear.
 */
test('a post the source deleted is a hole, not a gap', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  await migrate();
  await q('DELETE FROM lib_series WHERE id = $1', [S_HOLE]);
  await q(`INSERT INTO lib_series (id, source, title, folder, source_id, numbering, numbering_by, numbering_source)
           VALUES ($1,'test','Hole Fixture',$1,'hole-src','posting_order','auto','hole-src')`, [S_HOLE]);
  for (const n of [1, 2, 4, 5]) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, title, number, pages) VALUES ($1,$2,'test',$3,$4,$5,20)`,
      [`b_${S_HOLE}_${n}`, S_HOLE, `/test/${S_HOLE}/${n}.cbz`, `Chapter ${n}`, n]);
  }
  await q(`INSERT INTO series_post_numbers (series_id, source_id, post_id, number, seen_at, gone_at)
           VALUES ($1, 'hole-src', 'p3', 3, now(), now())`, [S_HOLE]);
  const gap = async () => (await runHealthChecks()).checks.find((c: any) => c.id === 'chapter-gaps').items.find((i: any) => i.seriesId === S_HOLE);
  try {
    assert.equal(await gap(), undefined, 'the deleted post leaves a hole that is not a gap');
    // The same number, not deleted at the source: missing, and a gap like any other.
    await q(`UPDATE series_post_numbers SET gone_at = NULL WHERE series_id = $1`, [S_HOLE]);
    assert.match((await gap())?.detail ?? '', /^1 missing — 3/);
  } finally {
    await q('DELETE FROM lib_series WHERE id = $1', [S_HOLE]);
  }
});

/**
 * The solver's row named a newer FlareSolverr "vv3.5.2": GitHub's tag already starts with its "v", and the summary
 * and the row's title put one before it. Reintroduce the tag as it is (drop the replace in solverHealth): the first
 * assertion.
 */
test("the solver's newer release is named with one v", { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { solverHealth } = await import('../src/lib/health');
  const { resetSolverVersionCache } = await import('../src/lib/solverVersion');
  const { forgetSolverPing } = await import('../src/lib/sources/flaresolverr');
  const { englishOf } = await import('../src/lib/said');
  await migrate();
  const realFetch = globalThis.fetch;
  // The solver answers as FlareSolverr does, and GitHub with a release tagged the way FlareSolverr tags them.
  globalThis.fetch = (async (u: any) => String(u).startsWith('https://api.github.com/')
    ? new Response(JSON.stringify({ tag_name: 'v3.5.2' }), { status: 200, headers: { 'content-type': 'application/json' } })
    : new Response(JSON.stringify({ msg: 'FlareSolverr is ready!', version: '3.4.6' }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  resetSolverVersionCache();
  forgetSolverPing();
  try {
    const row = await solverHealth();
    // v0.55.3: FlareSolverr is named by its kind ("trawl answering at its root is trawl", below).
    assert.equal(row.summary, 'Ready (FlareSolverr v3.4.6) — v3.5.2 is available', 'the solver\'s newer release is named with one v');
    assert.deepEqual(row.items.map((i) => i.title), ['v3.4.6 → v3.5.2']);
    assert.equal(englishOf(row.summarySaid), row.summary, 'the codes say the same');
  } finally {
    globalThis.fetch = realFetch;
    resetSolverVersionCache();
    forgetSolverPing();
  }
});

/**
 * #144: Byparr speaks FlareSolverr's /v1 but redirects its root to its docs and says it is up at /health. The solver row
 * read it as not answering while it solved fine. Reintroduce the root alone in solverPing: the first assertion fails.
 * Its version is Byparr's, so it is never compared with FlareSolverr's releases: compare every kind again in
 * solverHealth, and "never behind" fails (1.0.0 against 3.5.2).
 */
test("Byparr answering at /health is a working solver, and never behind FlareSolverr's releases", { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { solverHealth } = await import('../src/lib/health');
  const { resetSolverVersionCache } = await import('../src/lib/solverVersion');
  const { forgetSolverPing, solverPing } = await import('../src/lib/sources/flaresolverr');
  await migrate();
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (u: any, init?: any) => {
    const url = String(u);
    if (url.startsWith('https://api.github.com/')) {
      return new Response(JSON.stringify({ tag_name: 'v3.5.2' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    asked.push(`${new URL(url).pathname} ${init?.redirect ?? 'follow'}`);
    if (new URL(url).pathname === '/health') {
      return new Response(JSON.stringify({ msg: 'Byparr is ready!', version: '1.0.0' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // Byparr's root: a redirect to its API docs.
    return new Response(null, { status: 307, headers: { location: '/docs' } });
  }) as typeof fetch;
  resetSolverVersionCache();
  forgetSolverPing();
  try {
    const ping = await solverPing();
    assert.equal(ping.ok, true, 'Byparr answering at /health reads as not answering');
    assert.equal(ping.kind, 'other');
    assert.deepEqual(asked, ['/ manual', '/health manual'], 'the root redirect is followed onto the docs page');
    forgetSolverPing();
    const row = await solverHealth();
    assert.equal(row.status, 'ok');
    assert.equal(row.summary, 'Ready (v1.0.0)', "Byparr's own version is never behind FlareSolverr's releases");
    assert.equal(row.items.length, 0);
  } finally {
    globalThis.fetch = realFetch;
    resetSolverVersionCache();
    forgetSolverPing();
  }
});

/**
 * v0.55.3: trawl (#144) greets "TRAWL is ready!" at its root, and `solverPing` read every greeting with "ready" in it as
 * FlareSolverr's: Health held trawl's 1.7.0 against FlareSolverr's 3.x releases and said an update was out. It is named
 * by its greeting now, and held against its own releases. Reintroduce `flaresolverr` for every greeting (kindOf in
 * flaresolverr.ts): "a TRAWL greeting is trawl" fails; compare it with FlareSolverr's releases (latestSolverVersion
 * without the kind, in solverHealth): the summary names v3.6.0 as available.
 */
test('trawl answering at its root is trawl, named and held against its own releases', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { solverHealth } = await import('../src/lib/health');
  const { resetSolverVersionCache } = await import('../src/lib/solverVersion');
  const { forgetSolverPing, solverPing } = await import('../src/lib/sources/flaresolverr');
  const { englishOf } = await import('../src/lib/said');
  await migrate();
  const realFetch = globalThis.fetch;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (u: any) => {
    const url = String(u);
    // Each repository's own latest: trawl is current, FlareSolverr's is a number trawl's must never be held against.
    if (url.includes('/repos/germondai/trawl/')) return json({ tag_name: 'v1.7.0' });
    if (url.startsWith('https://api.github.com/')) return json({ tag_name: 'v3.6.0' });
    // trawl 1.7.0's own greeting, as the live one answered it (2026-10-04).
    return json({ msg: 'TRAWL is ready!', version: '1.7.0', uptime: 7 });
  }) as typeof fetch;
  resetSolverVersionCache();
  forgetSolverPing();
  try {
    const ping = await solverPing();
    assert.equal(ping.ok, true);
    assert.equal(ping.kind, 'trawl', 'a TRAWL greeting is trawl');
    forgetSolverPing();
    const row = await solverHealth();
    assert.equal(row.status, 'ok');
    assert.equal(row.summary, 'Ready (trawl v1.7.0)', "trawl is named, and is not behind FlareSolverr's releases");
    assert.equal(englishOf(row.summarySaid), row.summary, 'the codes say the same');
    assert.equal(row.items.length, 0, 'no "newer solver" row');
  } finally {
    globalThis.fetch = realFetch;
    resetSolverVersionCache();
    forgetSolverPing();
  }
});

/**
 * v0.55.3, a backup solver (FLARESOLVERR_FALLBACK_URL): the card lists both solvers, the main first, each with its state,
 * and is amber whenever one does not answer -- the main ("the backup is solving"), the backup (it would not answer when
 * needed), or both (the solver-down card it always was, which Fix everything's Needs you reads by its first code).
 * Reintroduce the card without rows (`rows = []` in solverHealth): "the card lists both solvers" fails; its status from
 * the sources blaming the solver alone: "status and items disagree" (a finding on an ok card); the main's ping as the
 * whole of the solver's (solverPing's top level): "the main down, the backup solving" reads the solver-down card.
 */
test('with a backup, the card lists both solvers and says which one is not answering', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { solverHealth } = await import('../src/lib/health');
  const { resetSolverVersionCache } = await import('../src/lib/solverVersion');
  const { forgetSolverPing } = await import('../src/lib/sources/flaresolverr');
  await migrate();
  const MAIN = 'http://main-solver.test:8191', BACKUP = 'http://backup-solver.test:8191';
  const saved = { main: process.env.FLARESOLVERR_URL, backup: process.env.FLARESOLVERR_FALLBACK_URL };
  process.env.FLARESOLVERR_URL = MAIN;
  process.env.FLARESOLVERR_FALLBACK_URL = BACKUP;
  const up = { main: true, backup: true };
  const realFetch = globalThis.fetch;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const refused = () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
  globalThis.fetch = (async (u: any) => {
    const url = String(u);
    if (url.includes('/repos/germondai/trawl/')) return json({ tag_name: 'v1.7.0' });
    if (url.startsWith('https://api.github.com/')) return json({ tag_name: 'v3.6.0' });
    // The owner's plan: trawl as the main, FlareSolverr kept as the backup.
    if (url.startsWith(MAIN)) return up.main ? json({ msg: 'TRAWL is ready!', version: '1.7.0' }) : refused();
    if (url.startsWith(BACKUP)) return up.backup ? json({ msg: 'FlareSolverr is ready!', version: '3.4.6' }) : refused();
    return realFetch(u);
  }) as typeof fetch;
  const card = async (main: boolean, backup: boolean) => {
    up.main = main; up.backup = backup;
    forgetSolverPing();
    const c = await solverHealth();
    await assertSaid([c]);
    assert.equal(c.items.filter((i: any) => !i.info).length === 0, c.status === 'ok', 'status and items disagree');
    return c;
  };
  resetSolverVersionCache();
  try {
    let c = await card(true, true);
    assert.equal(c.status, 'ok');
    assert.equal(c.summary, 'Ready (trawl v1.7.0)');
    assert.deepEqual(c.items.map((i: any) => [i.title, i.detail, !!i.info]), [
      ['Main solver', `Ready (trawl v1.7.0) · ${MAIN}`, true],
      ['Backup solver', `Ready (FlareSolverr v3.4.6) — v3.6.0 is available · ${BACKUP}`, true],
    ], 'the card lists both solvers, each with its kind, its version and its own newer release');

    c = await card(false, true);
    assert.equal(c.status, 'warn', 'the main down, the backup solving: amber');
    assert.equal(c.summary, 'The main solver is not answering; the backup is solving', 'the main down, the backup solving');
    assert.match(c.note ?? '', /goes to the backup/);
    assert.deepEqual(c.items.map((i: any) => [i.title, i.detail, !!i.info]), [
      ['Main solver', `not answering (ECONNREFUSED) · ${MAIN}`, false],
      ['Backup solver', `Ready (FlareSolverr v3.4.6) — v3.6.0 is available · ${BACKUP}`, true],
    ]);

    c = await card(true, false);
    assert.equal(c.status, 'warn', 'a backup that would not answer turns the card amber');
    assert.equal(c.summary, 'Ready (trawl v1.7.0); the backup is not answering');
    assert.deepEqual(c.items.map((i: any) => [i.title, !!i.info]), [['Main solver', true], ['Backup solver', false]]);

    c = await card(false, false);
    assert.equal(c.status, 'warn');
    assert.equal(c.summarySaid![0].code, 'solver.down', 'both down: the solver-down card, by its first code');
    assert.equal(c.summary, `Not answering at ${MAIN} (ECONNREFUSED); the backup is not answering`);
    assert.deepEqual(c.items.map((i: any) => [i.title, !!i.info]), [['Main solver', false], ['Backup solver', false]]);
  } finally {
    globalThis.fetch = realFetch;
    if (saved.main === undefined) delete process.env.FLARESOLVERR_URL; else process.env.FLARESOLVERR_URL = saved.main;
    if (saved.backup === undefined) delete process.env.FLARESOLVERR_FALLBACK_URL; else process.env.FLARESOLVERR_FALLBACK_URL = saved.backup;
    resetSolverVersionCache();
    forgetSolverPing();
  }
});

// ---- v0.54.0: Replace, where a main source is off or failing ---------------------------------------------------
//
// aqua went offline and was switched off while it stayed the main source of 195 series: Source health offered Find other
// sources, which adds followers and never moves a main source, and "Series that can no longer update" read "Every series
// has a working source" -- only a source that was not loaded counted.

/** A loaded stub source for these tests, a failure record at one stage, and a series on a main with followers. */
const stubSource = (id: string) => ({ id, name: `Name ${id}`, search: async () => [], getSeries: async () => null,
  listChapters: async () => [], getPageUrls: async () => [], latest: async () => [] });
const failedAt = (stage: string, kind = 'error') =>
  JSON.stringify({ [stage]: { failAt: new Date().toISOString(), failBy: 'test', kind, error: kind === 'site_offline' ? 'site_offline: the site says it is offline' : 'HTTP 500' } });

test("a source that is off or failing and is some series' main offers Replace; a cooldown or a search-only failure does not", { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  // Reintroduce by dropping `replaceHere` from sourceTrouble: the chip is missing on the off and the failing rows.
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  const { registerAdapter } = await import('../src/lib/sources');
  await migrate();
  const IDS = ['hr-off', 'hr-fail', 'hr-cool', 'hr-search', 'hr-folonly'];
  for (const id of IDS) registerAdapter(stubSource(id) as any);
  const SERIES = ['s_hr_off', 's_hr_fail', 's_hr_cool', 's_hr_search'];
  const clean = async () => {
    await q('DELETE FROM lib_series WHERE id = ANY($1::text[])', [SERIES]);
    await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [IDS]);
  };
  await clean();
  for (const id of SERIES) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id) VALUES ($1, 'test', $1, $1, 3, $2, 'x')`,
      [id, id.replace('s_hr_', 'hr-')]);
  }
  // A failing source that is only ever a follower: its series do not need a new main source.
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ('s_hr_off', 'hr-folonly', 'x')`);
  await q(`INSERT INTO source_health (source_id, status, disabled, blocked_until, stages) VALUES
             ('hr-off', 'ok', true, NULL, '{}'::jsonb),
             ('hr-fail', 'ok', false, NULL, $1::jsonb),
             ('hr-cool', 'rate_limited', false, now() + interval '1 hour', '{}'::jsonb),
             ('hr-search', 'ok', false, NULL, $2::jsonb),
             ('hr-folonly', 'ok', false, NULL, $3::jsonb)`, [failedAt('chapters'), failedAt('search'), failedAt('pages')]);
  try {
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'sources');
    await assertSaid([c]);
    const row = (id: string) => c.items.find((i: any) => i.sourceId === id);
    assert.deepEqual(row('hr-off').actions, ['test', 'replace_source', 'find_sources'], 'a switched-off main source offers Replace');
    assert.deepEqual(row('hr-fail').actions, ['test', 'disable', 'replace_source', 'find_sources', 'ignore'], 'a failing main source offers Replace');
    assert.equal(row('hr-fail').findSeries, 1, 'over the series whose main source it is');
    assert.deepEqual(row('hr-cool').actions, ['test', 'unblock', 'disable', 'find_sources', 'ignore'], 'a cooldown does not offer Replace: it ends by itself');
    assert.deepEqual(row('hr-search').actions, ['test', 'disable', 'find_sources', 'ignore'], 'a search failure stops no update: no Replace');
    assert.equal(row('hr-search').state, 'failing', 'PREMISE: it reads failing');
    assert.deepEqual(row('hr-folonly').actions, ['test', 'disable', 'ignore'], 'a source no series has as its main source has nothing to replace');
  } finally {
    await clean();
  }
});

test('images failing with 429 are a cooldown: no Replace, and its series still update; images failing with a 500 are failing (v0.55.1)', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  // The owner's first Fix everything run (2026-10-03): Mangakakalot's image server answered 429 -- "0/32 pages
  // downloaded (HTTP 429)", five in a row, recorded as an error before v0.55.1 -- so Source health read it failing,
  // offered Replace, and Fix everything moved 14 series off a source whose searches and chapter lists answer fine. A rate
  // limit is a cooldown: its row is the cooldown's, `rate_limited`, also once the cooldown ran out or a passing Test
  // cleared it. Reintroduce by counting rate limits among the failing (lib/health.ts sourceTrouble's `failing`, or
  // currentFailures in lib/sourceEvidence.ts): hl-limit reads failing with Replace offered, and its series is frozen.
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks, frozenSeries } = await import('../src/lib/health');
  const { noIgnores } = await import('../src/lib/healthIgnore');
  const { registerAdapter } = await import('../src/lib/sources');
  const { standingsOf } = await import('../src/lib/sourceStanding');
  const { noteStage } = await import('../src/lib/sourceHealth');
  await migrate();
  const IDS = ['hl-limit', 'hl-limitnew', 'hl-err', 'hl-note'];
  for (const id of IDS) registerAdapter(stubSource(id) as any);
  const SERIES = ['s_hl_limit', 's_hl_limitnew', 's_hl_err'];
  const clean = async () => {
    await q('DELETE FROM lib_series WHERE id = ANY($1::text[])', [SERIES]);
    await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [IDS]);
  };
  await clean();
  for (const id of SERIES) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id, auto_update)
             VALUES ($1, 'test', $1, $1, 4, $2, 'x', true)`, [id, id.replace('s_hl_', 'hl-')]);
  }
  const images = (error: string, kind = 'error') =>
    JSON.stringify({ images: { failAt: new Date(Date.now() - 60_000).toISOString(), failBy: 'traffic', streak: 5, kind, error } });
  // As the owner's row was: rate limited, its cooldown over. And one recorded since v0.55.1, its cooldown cleared by a
  // Test that passed (a Test fetches no image). And a source whose images fail with a server error.
  await q(`INSERT INTO source_health (source_id, status, disabled, blocked_until, last_error, stages) VALUES
             ('hl-limit', 'rate_limited', false, now() - interval '5 minutes', '0/32 pages downloaded (HTTP 429)', $1::jsonb),
             ('hl-limitnew', 'ok', false, NULL, NULL, $2::jsonb),
             ('hl-err', 'blocked', false, NULL, '0/32 pages downloaded (HTTP 500)', $3::jsonb)`,
    [images('0/32 pages downloaded (HTTP 429)'), images('0/32 pages downloaded (HTTP 429)', 'rate_limited'), images('0/32 pages downloaded (HTTP 500)')]);
  try {
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'sources');
    await assertSaid([c]);
    const row = (id: string) => c.items.find((i: any) => i.sourceId === id);
    assert.equal(row('hl-limit').state, 'blocked', 'images failing with 429 are a cooldown, never a failure');
    assert.equal(row('hl-limit').cooldown?.status, 'rate_limited');
    assert.ok(!row('hl-limit').actions.includes('replace_source'), 'and a cooldown is never Replaced: it ends by itself');
    assert.deepEqual([row('hl-limitnew').state, row('hl-limitnew').cooldown], ['blocked', { status: 'rate_limited', until: null }],
      'a rate limit whose cooldown a Test cleared is still one');
    assert.ok(!row('hl-limitnew').actions.includes('replace_source'));
    assert.equal(row('hl-err').state, 'failing', 'images failing with a 500 are failing');
    assert.ok(row('hl-err').actions.includes('replace_source'), 'and offer Replace');

    const standing = await standingsOf(['hl-limit', 'hl-limitnew', 'hl-err']);
    assert.deepEqual([standing.get('hl-limit'), standing.get('hl-limitnew'), standing.get('hl-err')], ['cooling', 'cooling', 'failing']);
    const frozen = await frozenSeries(noIgnores(), 'up');
    const listed = new Set(frozen.items.map((i: any) => i.seriesId));
    assert.ok(!listed.has('s_hl_limit') && !listed.has('s_hl_limitnew'), 'a series on a rate-limited main can still update');
    assert.ok(listed.has('s_hl_err'), 'one on a main whose images fail cannot');

    // What ordinary use records from here on: a failure in the words of a rate limit is recorded as one. Reintroduce by
    // dropping the rate-limit kind from noteStage (lib/sourceHealth.ts): it is recorded as an error.
    await noteStage('hl-note', 'pages', 'fail', { error: 'suwayomi: HTTP error 429' });
    await noteStage('hl-note', 'chapters', 'fail', { error: 'suwayomi: HTTP error 500' });
    const noted = (await q(`SELECT stages FROM source_health WHERE source_id = 'hl-note'`))[0]?.stages;
    assert.equal(noted?.pages?.kind, 'rate_limited', 'a 429 in ordinary use is recorded as a rate limit');
    assert.equal(noted?.chapters?.kind, 'error');
  } finally {
    await clean();
  }
});

test('a source downloading at a raised pace says so: a quiet row of its own, and a sentence on any other (v0.55.3)', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  // The owner's Natomanga: after its image server's 429s its chapters come one at a time, at longer gaps, for hours
  // (lib/pace.ts), and nothing on Health said why. Reintroduce by dropping `paced` from sourceTrouble (lib/health.ts):
  // hp-slow has no row, and the rate-limited row says nothing of its pace.
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  const { registerAdapter } = await import('../src/lib/sources');
  const pace = await import('../src/lib/pace');
  await migrate();
  const IDS = ['hp-slow', 'hp-limit', 'hp-fast'];
  for (const id of IDS) registerAdapter(stubSource(id) as any);
  const clean = async () => {
    await q(`DELETE FROM lib_series WHERE id = 's_hp_slow'`);
    await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [IDS]);
  };
  await clean();
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id, auto_update)
           VALUES ('s_hp_slow', 'test', 'Paced Tale', 's_hp_slow', 4, 'hp-slow', 'x', true)`);
  // hp-slow's last chapter landed (status ok) at the raised pace; hp-limit is in its cooldown; hp-fast is fine.
  await q(`INSERT INTO source_health (source_id, status, blocked_until, last_error) VALUES
             ('hp-slow', 'ok', NULL, NULL),
             ('hp-limit', 'rate_limited', now() + interval '20 minutes', '0/113 pages downloaded (HTTP 429)'),
             ('hp-fast', 'ok', NULL, NULL)`);
  pace.clearPace();
  pace.noteRateLimited('hp-slow');
  pace.noteRateLimited('hp-limit');
  try {
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'sources');
    await assertSaid([c]);
    const row = (id: string) => c.items.find((i: any) => i.sourceId === id);
    const slow = row('hp-slow');
    assert.ok(slow, 'a source at a raised pace is listed with nothing else wrong');
    assert.equal(slow.state, 'slowed');
    assert.equal(slow.slowed, true);
    assert.equal(slow.info, true, 'for reference: nothing to fix, it comes back up by itself');
    assert.equal(slow.group, 'quiet');
    assert.equal(slow.detailSaid[0].code, 'sources.paced');
    assert.match(slow.detail, /^Downloading slowly: the site asked for fewer requests; 1 series use it$/);
    assert.ok(!slow.actions.includes('replace_source') && !slow.actions.includes('find_sources'), 'and nothing to replace');
    const limit = row('hp-limit');
    assert.equal(limit.state, 'blocked', 'a cooldown is still the row\'s state');
    assert.equal(limit.slowed, true, 'and its pace is said beside it');
    assert.ok(limit.detailSaid.some((d: any) => d.code === 'sources.paced'), limit.detail);
    assert.equal(row('hp-fast'), undefined, 'a source at its own pace has nothing to say');
  } finally {
    pace.clearPace();
    await clean();
  }
});

test('a failed chapter moved onto a main that rests or downloads slowly waits; onto one at full speed it is a finding (v0.55.3, lanes F and G)', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  // The owner's case: Replace moved two series off AllManga onto Natomanga, and their failed chapters followed them
  // (status `moved`, lib/chapterFailures.ts refileFailures). Natomanga answered 429: its own row reads rate_limited, its
  // cooldown long run out, and the moved chapters wait for its pause. Natomanga and Mangakakalot share one image server
  // (2xstorage.com), so a 429 at Mangakakalot slows Natomanga too (lib/pace.ts, one key per image server) while
  // Natomanga's own row reads ok: chapters moved onto it wait as well, one at a time in its queue. Onto a source at full
  // speed they are a finding, as any failed chapter is. Reintroduce by dropping `f.source_id = ANY($1)` from Health's
  // waiting count (lib/health.ts chapterFailures): "a moved chapter on a slowed main waits" fails; by dropping
  // `h.status = 'rate_limited'`: "on the rate-limited one" fails.
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { runHealthChecks } = await import('../src/lib/health');
  const { registerAdapter, unregisterAdapter } = await import('../src/lib/sources');
  const pace = await import('../src/lib/pace');
  await migrate();
  const NATO = 'fg-natomanga', NATO2 = 'fg-natomanga2', KAKA = 'fg-mangakakalot', FAST = 'fg-fast';
  const IDS = [NATO, NATO2, KAKA, FAST];
  const SERIES = ['s_fg_limited', 's_fg_slowed', 's_fg_fast'];
  for (const id of IDS) registerAdapter(stubSource(id) as any);
  const clean = async () => {
    await q('DELETE FROM chapter_failures WHERE series_id = ANY($1::text[])', [SERIES]);
    await q('DELETE FROM lib_series WHERE id = ANY($1::text[])', [SERIES]);
    await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [IDS]);
  };
  await clean();
  for (const [id, main] of [[SERIES[0], NATO], [SERIES[1], NATO2], [SERIES[2], FAST]]) {
    await q(`INSERT INTO lib_series (id, source, title, folder, source_id, source_series_id, auto_update)
             VALUES ($1, 'test', $1, $1, $2, 'x', true)`, [id, main]);
    // Two chapters each, failed at AllManga's pages and moved onto the new main: not tried there yet.
    await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, reason, attempts, at, first_at)
             VALUES ($1, 6, $2, 'moved', 'no page urls', 0, now(), now() - interval '3 days'),
                    ($1, 7, $2, 'moved', 'no page urls', 0, now(), now() - interval '3 days')`, [id, main]);
  }
  await q(`INSERT INTO source_health (source_id, status, consecutive, blocked_until, last_error) VALUES
             ($1, 'rate_limited', 5, now() - interval '10 minutes', '0/113 pages downloaded (HTTP 429)'),
             ($2, 'ok', 0, NULL, NULL), ($3, 'rate_limited', 1, now() + interval '15 minutes', '0/32 pages downloaded (HTTP 429)'),
             ($4, 'ok', 0, NULL, NULL)`, [NATO, NATO2, KAKA, FAST]);
  pace.clearPace();
  // Both have shown their pages on one image server; then Mangakakalot's were refused.
  pace.notePageHosts({ id: NATO2 }, ['https://imgs-2.2xstorage.com/a/1.jpg']);
  pace.notePageHosts({ id: KAKA }, ['https://img-r1.2xstorage.com/b/1.jpg']);
  pace.noteRateLimited(KAKA);
  try {
    assert.ok(pace.paceLevel(NATO2) > 0, 'PREMISE: a 429 at Mangakakalot slows Natomanga through their one image server');
    assert.equal(pace.paceLevel(FAST), 0, 'PREMISE: the other new main downloads at full speed');
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'chapter-failures');
    await assertSaid([c]);
    const row = (id: string) => c.items.find((i: any) => i.sourceId === id);
    assert.equal(row(NATO)?.info, true, `on the rate-limited one, its cooldown run out, they wait: ${JSON.stringify(row(NATO))}`);
    assert.equal(row(NATO2)?.info, true, `a moved chapter on a slowed main waits: ${JSON.stringify(row(NATO2))}`);
    assert.ok(row(FAST) && row(FAST).info !== true, 'onto a main at full speed they are a finding: nothing holds them back');
  } finally {
    pace.clearPace();
    await clean();
    for (const id of IDS) unregisterAdapter(id);
  }
});

test('a series whose loaded main is off or failing, with no working follower, can no longer update; one with a working follower is reference; a cooling main is not listed', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async () => {
  // Reintroduce by dropping the `OR ls.source_id = ANY($1)` clause from frozenSeries: the series on the switched-off main
  // is absent. Reintroduce "any loaded follower counts" (drop the standing test on followers): the series whose follower
  // is switched off reads as covered.
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { frozenSeries } = await import('../src/lib/health');
  const { noIgnores } = await import('../src/lib/healthIgnore');
  const { registerAdapter } = await import('../src/lib/sources');
  await migrate();
  const IDS = ['fz-off', 'fz-fail', 'fz-cool', 'fz-ok', 'fz-offfol', 'fz-offline'];
  for (const id of IDS) registerAdapter(stubSource(id) as any);
  const SERIES: Array<[string, string, string[]]> = [
    ['s_fz_off', 'fz-off', []], ['s_fz_failoff', 'fz-fail', ['fz-offfol']], ['s_fz_failok', 'fz-fail', ['fz-ok']],
    ['s_fz_cool', 'fz-cool', []], ['s_fz_offline', 'fz-offline', []], ['s_fz_offcool', 'fz-off', ['fz-cool']],
  ];
  const clean = async () => {
    await q('DELETE FROM lib_series WHERE id = ANY($1::text[])', [SERIES.map(([id]) => id)]);
    await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [IDS]);
  };
  await clean();
  for (const [id, main, fols] of SERIES) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id, auto_update)
             VALUES ($1, 'test', $1, $1, 4, $2, 'x', true)`, [id, main]);
    for (const f of fols) await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, $2, 'y')`, [id, f]);
  }
  await q(`INSERT INTO source_health (source_id, status, disabled, blocked_until, stages) VALUES
             ('fz-off', 'ok', true, NULL, '{}'::jsonb),
             ('fz-fail', 'ok', false, NULL, $1::jsonb),
             ('fz-cool', 'rate_limited', false, now() + interval '1 hour', '{}'::jsonb),
             ('fz-offfol', 'ok', true, NULL, '{}'::jsonb),
             ('fz-offline', 'ok', false, NULL, $2::jsonb)`, [failedAt('pages'), failedAt('search', 'site_offline')]);
  try {
    const c = await frozenSeries(noIgnores(), 'up');
    await assertSaid([c]);
    const item = (id: string) => c.items.find((i: any) => i.seriesId === id);
    assert.ok(item('s_fz_off'), 'the series on the switched-off main is listed');
    assert.equal(item('s_fz_off').info, undefined, 'and it is a finding');
    // Named as the rest of Health names them (sourceLabel, v0.55.1): the main source by its name, as its followers were.
    assert.equal(item('s_fz_off').detail, '4 chapters; its source Name fz-off is switched off');
    assert.deepEqual([item('s_fz_off').sourceId, item('s_fz_off').actions, item('s_fz_off').findSeries],
      ['fz-off', ['replace_source', 'find_sources', 'ignore'], 2], 'Replace first, over every series whose main source it is');
    assert.ok(item('s_fz_failoff'), 'a series whose only follower is switched off');
    assert.equal(item('s_fz_failoff').info, undefined, 'a switched-off follower carries nothing: still a finding');
    assert.equal(item('s_fz_failoff').detail, '4 chapters; its source Name fz-fail is failing');
    assert.equal(item('s_fz_offline').detail, '4 chapters; its source Name fz-offline says it is offline', "the site's own offline notice, said so");
    assert.equal(item('s_fz_failok').info, true, 'a working follower carries it: reference');
    assert.equal(item('s_fz_failok').detail, 'primary Name fz-fail failing; still following Name fz-ok');
    assert.deepEqual([item('s_fz_failok').sourceId, item('s_fz_failok').actions], ['fz-fail', ['replace_source']], 'its follower can be made the main source');
    assert.equal(item('s_fz_offcool').info, true, 'a follower in a cooldown still carries a series');
    assert.equal(item('s_fz_offcool').detail, 'primary Name fz-off switched off; still following Name fz-cool');
    assert.equal(item('s_fz_cool'), undefined, 'a main that is only cooling down is not listed');
    assert.equal(c.status, 'warn');
  } finally {
    await clean();
  }
});
