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
const S_CLEAN = 's_health_clean';

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const health = await import('../src/lib/health');
  await migrate();
  for (const id of [S_GAPS, S_CLEAN]) await q(`DELETE FROM lib_series WHERE id = $1`, [id]);

  const series = async (id: string, title: string) =>
    q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'test',$2,$1)`, [id, title]);
  const book = async (sid: string, n: number, pages: number) =>
    q(`INSERT INTO lib_books (id, series_id, source, file, title, number, pages)
       VALUES ($1,$2,'test',$3,$4,$5,$6)`,
      [`b_${sid}_${n}`, sid, `/test/${sid}/${n}.cbz`, `Chapter ${n}`, n, pages]);

  await series(S_GAPS, 'Health Gaps Fixture');
  // chapters 1,2,3 then 7,8 — a hole at 4-6
  for (const n of [1, 2, 3, 7, 8]) await book(S_GAPS, n, 20);

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
