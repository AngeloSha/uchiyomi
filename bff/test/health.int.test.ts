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
    for (const c of report.checks) {
      assert.equal(c.items.length === 0, c.status === 'ok', `${c.id}: status and items disagree`);
      assert.ok(c.summary.length > 0);
    }
  });

  for (const id of [S_GAPS, S_CLEAN]) await q(`DELETE FROM lib_series WHERE id = $1`, [id]);
});


const S_FROZEN = 's_health_frozen', S_ROUTED = 's_health_routed';

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
  for (const id of [S_FROZEN, S_ROUTED]) await q('DELETE FROM lib_series WHERE id = $1', [id]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id)
           VALUES ($1, 'test', 'Frozen Fixture', $1, 31, 'sw:999999999', '9')`, [S_FROZEN]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id)
           VALUES ($1, 'test', 'Routed Fixture', $1, 5, 'health-live', 'x')`, [S_ROUTED]);
  try {
    const report = await runHealthChecks();
    const check = report.checks.find((c: any) => c.id === 'frozen-series');
    assert.ok(check, 'the check exists');
    assert.equal(check.status, 'warn');
    const titles = check.items.map((i: any) => i.title);
    assert.ok(titles.includes('Frozen Fixture'), `the frozen series is named: ${titles.join(', ')}`);
    assert.ok(!titles.includes('Routed Fixture'), 'a series whose adapter is loaded is not');
    assert.match(check.items.find((i: any) => i.title === 'Frozen Fixture').detail, /sw:999999999 is no longer installed/);
  } finally {
    for (const id of [S_FROZEN, S_ROUTED]) await q('DELETE FROM lib_series WHERE id = $1', [id]);
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
