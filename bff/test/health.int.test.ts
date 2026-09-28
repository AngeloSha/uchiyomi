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
    // switched off" fails, the detail reads "no longer installed" for a source that is right there.
    assert.match(detail('Off Fixture'), /sw:health-off is switched off/, 'a switched-off source is said to be switched off');
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

const S_ENGINE = 's_health_engine', S_GONE = 's_health_gone';

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
  await migrate();
  for (const id of [S_ENGINE, S_GONE]) await q('DELETE FROM lib_series WHERE id = $1', [id]);
  await q(`DELETE FROM suwayomi_sources WHERE source_id = 'health-engine'`);
  // Enabled and remembered, but not registered: exactly what every extension source is while the engine is away.
  await q(`INSERT INTO suwayomi_sources (source_id, name, lang, enabled) VALUES ('health-engine', 'Engine Source', 'en', true)`);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id)
           VALUES ($1, 'test', 'Engine Fixture', $1, 12, 'sw:health-engine', '1')`, [S_ENGINE]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id)
           VALUES ($1, 'test', 'Gone Fixture', $1, 3, 'gone-pack-source', '1')`, [S_GONE]);
  try {
    const detail = async (engine: 'off' | 'switched_off' | 'unreachable' | 'up', title: string) => {
      const c = await frozenSeries(noIgnores(), engine);
      await assertSaid([c]);
      return { detail: c.items.find((i) => i.title === title)!.detail, note: c.note ?? '' };
    };
    for (const engine of ['off', 'switched_off'] as const) {
      const r = await detail(engine, 'Engine Fixture');
      assert.match(r.detail, /^12 chapters; its source sw:health-engine can’t be reached because the extension engine is off$/, `the engine is the reason (${engine})`);
      assert.doesNotMatch(r.detail, /source limit/);
      assert.match(r.note, /^Series that came from extensions wait for the extension engine; Admin → Extensions shows how to bring it back\. /);
    }
    assert.match((await detail('unreachable', 'Engine Fixture')).detail, /because the extension engine isn’t answering$/);
    const up = await detail('up', 'Engine Fixture');
    assert.match(up.detail, /sw:health-engine is over the source limit \(SUWAYOMI_MAX_SOURCES\)/, 'with the engine up, the limit is the reason');
    assert.doesNotMatch(up.note, /wait for the extension engine/);
    // A source that is not an extension's is not the engine's to explain.
    for (const engine of ['off', 'switched_off', 'unreachable', 'up'] as const) {
      assert.match((await detail(engine, 'Gone Fixture')).detail, /gone-pack-source is no longer installed$/, `a non-extension source (${engine})`);
    }
  } finally {
    for (const id of [S_ENGINE, S_GONE]) await q('DELETE FROM lib_series WHERE id = $1', [id]);
    await q(`DELETE FROM suwayomi_sources WHERE source_id = 'health-engine'`);
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
  // so the counts are checked against the items rather than assumed to be ours alone: the summary's
  // "failing" figure must be exactly the non-info items, and the two quiet figures exactly the info ones.
  const counts = (c: any) => ({
    failing: Number(c.summary.match(/^(\d+) source/)?.[1] ?? 0),
    off: Number(c.summary.match(/(\d+) turned off by you/)?.[1] ?? 0),
    idle: Number(c.summary.match(/(\d+) no series use/)?.[1] ?? 0),
    live: c.items.filter((i: any) => !i.info).length,
    info: c.items.filter((i: any) => i.info).length,
  });
  try {
    const first = (await runHealthChecks()).checks.find((c: any) => c.id === 'sources');
    await assertSaid([first]);
    assert.equal(first.status, 'warn', 'a source that is down is still a warning');
    const n1 = counts(first);
    assert.equal(n1.failing, n1.live, `the verdict counts only live faults (summary: ${first.summary})`);
    assert.equal(n1.off + n1.idle, n1.info, 'and says how many are turned off or unused');
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
    assert.deepEqual(down.actions, ['test', 'disable', 'ignore'], 'a live failing source offers Test and Turn off');
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
  await q(`INSERT INTO series_trackers (series_id, provider, external_id, title) VALUES ($1,'anilist','hl-dup-1','Dup'), ($2,'anilist','hl-dup-1','Dup')`, [D1, D2]);
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
