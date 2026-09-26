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

test('library health checks', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async (t) => {
  const { q, health } = await setup();
  const report = await health.runHealthChecks();

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
  const { runHealthChecks } = await import('../src/lib/health');
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
    assert.equal(check.status, 'warn');
    const titles = check.items.map((i: any) => i.title);
    assert.ok(titles.includes('Frozen Fixture'), `the frozen series is named: ${titles.join(', ')}`);
    assert.ok(!titles.includes('Routed Fixture'), 'a series whose adapter is loaded is not');
    assert.match(check.items.find((i: any) => i.title === 'Frozen Fixture').detail, /sw:999999999 is no longer installed/);
    // Reintroduce by dropping the EXISTS subquery from frozenSeries(): "a switched-off source is said to be
    // switched off" fails, the detail reads "no longer installed" for a source that is right there.
    assert.ok(titles.includes('Off Fixture'), 'a series on a switched-off source is still frozen');
    assert.match(check.items.find((i: any) => i.title === 'Off Fixture').detail, /sw:health-off is switched off/,
      'a switched-off source is said to be switched off');
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
  const { runHealthChecks } = await import('../src/lib/health');
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
    const covered = check.items.find((i: any) => i.title === 'Covered Fixture');
    assert.ok(covered, 'the series with a dead primary is still listed');
    assert.equal(covered.info, true, 'a dead primary with a live follower is not frozen');
    assert.match(covered.detail, /primary sw:888888888 gone; still following Health Follower/);
    assert.match(check.summary, /1 lost its primary but still follows another/);
    const orphaned = check.items.find((i: any) => i.title === 'Orphaned Fixture');
    assert.ok(orphaned, 'a dead primary with a dead follower is listed');
    assert.notEqual(orphaned.info, true, 'and it is a real finding');
    assert.match(orphaned.detail, /sw:777777777 is no longer installed/);
    assert.equal(check.status, 'warn');
  } finally {
    for (const id of [S_COVERED, S_ORPHANED]) await q('DELETE FROM lib_series WHERE id = $1', [id]);
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
    const row = c.items.find((i: any) => i.title === `sw:${ID}`);
    assert.ok(row, 'still listed');
    assert.equal(row.info, true, 'hidden by language is off');
    assert.match(row.detail, /turned off/);
    assert.ok(!c.items.some((i: any) => !i.info && i.title === `sw:${ID}`), 'never counted as a fault');
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
  await q(`UPDATE lib_books SET short_confirmed_at = now() WHERE id = $1`, [`b_${S_SHORT}_5`]);
  // A tombstoned chapter: the bytes are gone, so a page count taken before they went says nothing anybody
  // can act on. Reintroduce by dropping `b.pruned_at IS NULL` from shortChapters(): it is reported again.
  await q(`UPDATE lib_books SET pruned_at = now(), pruned_reason = 'deleted' WHERE id = $1`, [`b_${S_SHORT}_6`]);
  try {
    const c = (await runHealthChecks()).checks.find((x: any) => x.id === 'short-chapters');
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
    assert.match(c.summary, /1 confirmed short at the source/);
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
    return c.items.find((i: any) => i.title === 'Gaps Result Fixture');
  };
  const stamp = async (ago: string, result: Record<string, unknown>) =>
    q(`UPDATE lib_series SET gaps_checked_at = now() - $2::interval, gaps_result = $3::jsonb WHERE id = $1`,
      [S_GR, ago, JSON.stringify({ at: new Date().toISOString(), have_count: 5, ...result })]);
  try {
    const first = await item();
    assert.ok(first, 'never looked at: a plain finding');
    assert.notEqual(first.info, true);
    assert.equal(first.fixed, undefined, 'nothing has been decided about it yet');

    await stamp('1 hour', { why: 'no_candidate', sweep: 0 });
    const asked = await item();
    assert.equal(asked.info, true, 'asked, and the answer was no: greyed');
    assert.equal(asked.fixed?.what, 'no other source lists them');
    assert.match(asked.detail, /no other source lists them, checked \d{4}-\d{2}-\d{2}$/);

    await stamp('8 days', { why: 'no_candidate', sweep: 0 });
    assert.notEqual((await item()).info, true, 'an answer older than a week is worth asking again');

    await stamp('1 hour', { why: 'cooldown', sweep: 0 });
    assert.notEqual((await item()).info, true, 'a cooldown is not an answer: nobody was asked');

    // Something landed since the search ran, so the hole may have moved.
    await stamp('1 hour', { why: 'no_candidate', sweep: 0, have_count: 4 });
    assert.notEqual((await item()).info, true, 'an answer about a different library is not about this one');

    // Every missing chapter is listed on a source we already follow: the ordinary sweep's job, not a search's.
    await stamp('1 hour', { why: 'listed', sweep: 3 });
    const listed = await item();
    assert.equal(listed.info, true, 'a hole the chapter sweep is about to fill is not a finding');
    assert.match(listed.detail, /the next chapter sweep will fetch them/);
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
