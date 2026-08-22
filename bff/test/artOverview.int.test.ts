// The admin Art Review gallery's query.
//
// This test exists because of a specific failure. v0.6.0 shipped this query with ORDER BY written above
// WHERE, which Postgres rejects outright, so GET /api/admin/art/overview returned a 500 and the whole Art
// tab was dead in a published release. It was not caught by 211 passing tests, because the query lived as a
// template literal inside a route handler and nothing in the suite executed it.
//
// So the assertion that matters most here is the dullest one: that it runs at all. A syntax error in an
// admin SQL string cannot survive a test that calls it.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let artOverview: typeof import('../src/lib/seriesArt')['artOverview'];

const LIVE = 's_art_live', GONE = 's_art_deleted', MERGED = 's_art_merged';
const ALL = [LIVE, GONE, MERGED];

async function wipe() {
  await q(`DELETE FROM series_art WHERE series_id = ANY($1)`, [ALL]).catch(() => {});
  await q(`DELETE FROM series_overrides WHERE series_id = ANY($1)`, [ALL]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [ALL]);
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ artOverview } = await import('../src/lib/seriesArt'));
  await migrate();
});

beforeEach(async () => {
  if (!DSN) return;
  await wipe();
  for (const [id, title] of [[LIVE, 'Art Live'], [GONE, 'Art Deleted'], [MERGED, 'Art Merged']] as const) {
    await q(
      `INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!art',$2,$1,3)`,
      [id, title],
    );
  }
  await q(`UPDATE lib_series SET deleted_at = now() WHERE id = $1`, [GONE]);
  await q(`UPDATE lib_series SET merged_into = $2 WHERE id = $1`, [MERGED, LIVE]);
});

after(async () => { if (DSN) await wipe().catch(() => {}); });

test('THE BUG: the query is valid SQL and actually runs', { skip }, async () => {
  // v0.6.0 failed exactly here, with: syntax error at or near "WHERE".
  const rows = await artOverview();
  assert.ok(Array.isArray(rows), 'artOverview did not return rows');
});

test('a deleted series is not offered for art review', { skip }, async () => {
  const rows = await artOverview();
  assert.ok(!rows.some((r) => r.id === GONE), 'a hidden series showed up in Art Review');
});

test('a merged-away series is not offered either', { skip }, async () => {
  const rows = await artOverview();
  assert.ok(!rows.some((r) => r.id === MERGED), 'an absorbed series showed up in Art Review');
});

test('a live series is present, with its art flags', { skip }, async () => {
  const row = (await artOverview()).find((r) => r.id === LIVE);
  assert.ok(row, 'the live series was missing from Art Review');
  assert.equal(row.has_banner, false);
  assert.equal(row.has_cover, false);
  assert.equal(row.override_banner, false);
});

test('series with art sort after series without, so the gallery leads with what needs work', { skip }, async () => {
  // The ORDER BY is the reason this endpoint exists: worst-first. If the clause order is ever rearranged
  // again, this is what notices that the meaning changed rather than just the syntax.
  await q(
    `INSERT INTO series_art (series_id, banner, cover) VALUES ($1,'http://x/b.jpg','http://x/c.jpg')
     ON CONFLICT (series_id) DO UPDATE SET banner = EXCLUDED.banner, cover = EXCLUDED.cover`,
    [LIVE],
  );
  const other = 's_art_bare';
  await q(`DELETE FROM lib_series WHERE id = $1`, [other]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!art','Art Bare',$1,1)`, [other]);
  try {
    const rows = await artOverview();
    const bare = rows.findIndex((r) => r.id === other);
    const dressed = rows.findIndex((r) => r.id === LIVE);
    assert.ok(bare >= 0 && dressed >= 0, 'both fixtures should be listed');
    assert.ok(bare < dressed, 'a series with no art should sort before one that already has art');
  } finally {
    await q(`DELETE FROM lib_series WHERE id = $1`, [other]).catch(() => {});
  }
});
