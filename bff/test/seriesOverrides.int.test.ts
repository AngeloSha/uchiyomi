// Series metadata edits have to survive the next scan.
//
// persistScan rewrites lib_series on every pass (`ON CONFLICT (library_id, folder) DO UPDATE SET ... author, status,
// genres`), and scans happen constantly: the admin button, every series added, every updater sweep. So there
// is nowhere in lib_series an edit can live. Title and summary already solved this by living in
// series_overrides and being COALESCEd at read time; author, status and genres were read from ComicInfo and
// silently clobbered every scan, with no way to pin them.
//
// The interesting case is genres, because it is the one field where "cleared" and "not set" are different
// things. NULL means inherit what was scanned; '{}' means the admin deliberately emptied it.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
// A viewer that sees every library. Written out rather than imported because importing from
// src/lib pulls in env.ts, which validates the environment at module load, before the block below
// has set DATABASE_URL. Note this still respects soft delete: it only bypasses library scoping.
const SYSTEM_CTX = { userId: null, libraryIds: null, maxAgeRating: null } as const;

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let owned: any;

const S = 's_ov_series';

/** What the scanner would write: the ComicInfo values, overwriting whatever is there. */
const rescan = () =>
  q(
    `INSERT INTO lib_series (id, source, title, summary, author, status, genres, folder, books_count)
     VALUES ($1,'T!ov','Scanned Title','Scanned summary.','Scanned Author','ONGOING',
             ARRAY['Action','Fantasy'],$1,2)
     ON CONFLICT (library_id, folder) DO UPDATE SET title=EXCLUDED.title, summary=EXCLUDED.summary,
       author=EXCLUDED.author, status=EXCLUDED.status, genres=EXCLUDED.genres`,
    [S],
  );

const override = (cols: Record<string, unknown>) => {
  const keys = Object.keys(cols);
  const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  return q(
    `INSERT INTO series_overrides (series_id, ${keys.join(', ')}, updated_at)
     VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}, now())
     ON CONFLICT (series_id) DO UPDATE SET ${set}, updated_at = now()`,
    [S, ...keys.map((k) => cols[k])],
  );
};

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ owned } = (await import('../src/lib/ownedCatalog')) as any);
  await migrate();
});

beforeEach(async () => {
  if (!DSN) return;
  await q(`DELETE FROM series_overrides WHERE series_id = $1`, [S]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id = $1`, [S]);
  await rescan();
});

after(async () => {
  if (!DSN) return;
  await q(`DELETE FROM series_overrides WHERE series_id = $1`, [S]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id = $1`, [S]).catch(() => {});
});

test('with no override, the scanned values are what you see', { skip }, async () => {
  const dto = await owned.series(SYSTEM_CTX, S);
  assert.equal(dto.metadata.author, 'Scanned Author');
  assert.equal(dto.metadata.status, 'ONGOING');
  assert.deepEqual(dto.metadata.genres, ['Action', 'Fantasy']);
});

test('THE BUG: an edited author survives a rescan', { skip }, async () => {
  await override({ author: 'Real Author' });
  await rescan(); // this used to put 'Scanned Author' back
  assert.equal((await owned.series(SYSTEM_CTX, S)).metadata.author, 'Real Author');
});

test('an edited status survives a rescan', { skip }, async () => {
  await override({ status: 'COMPLETED' });
  await rescan();
  assert.equal((await owned.series(SYSTEM_CTX, S)).metadata.status, 'COMPLETED');
});

test('edited genres survive a rescan', { skip }, async () => {
  await override({ genres: ['Romance', 'Slice of Life'] });
  await rescan();
  assert.deepEqual((await owned.series(SYSTEM_CTX, S)).metadata.genres, ['Romance', 'Slice of Life']);
});

test('edited genres drive Browse and the genre filter, not just the detail page', { skip }, async () => {
  await override({ genres: ['Romance'] });

  const byNew = await owned.searchSeries(SYSTEM_CTX, { condition: { genre: { value: 'Romance' } } }, 0, 40);
  assert.ok(byNew.content.some((s: any) => s.id === S), 'the series is not findable by its new genre');

  const byOld = await owned.searchSeries(SYSTEM_CTX, { condition: { genre: { value: 'Action' } } }, 0, 40);
  assert.ok(!byOld.content.some((s: any) => s.id === S), 'the series is still findable by the scanned genre');

  const all = await owned.genres(SYSTEM_CTX);
  assert.ok(all.includes('Romance'), 'the overridden genre is missing from the Browse tiles');
});

test('an empty genre list means cleared, not "use what was scanned"', { skip }, async () => {
  // This is the distinction NULL vs '{}' exists for. Without it there would be no way to say
  // "this series genuinely has no genres" that a rescan would not immediately undo.
  await override({ genres: [] });
  await rescan();
  assert.deepEqual((await owned.series(SYSTEM_CTX, S)).metadata.genres, [], 'clearing genres did not stick');
});

test('clearing an override back to NULL restores the scanned value', { skip }, async () => {
  await override({ author: 'Real Author' });
  assert.equal((await owned.series(SYSTEM_CTX, S)).metadata.author, 'Real Author');
  await override({ author: null });
  assert.equal((await owned.series(SYSTEM_CTX, S)).metadata.author, 'Scanned Author', 'clearing did not fall back to the scan');
});

test('overriding one field does not disturb the others', { skip }, async () => {
  await override({ author: 'Real Author' });
  const dto = await owned.series(SYSTEM_CTX, S);
  assert.equal(dto.metadata.status, 'ONGOING', 'status changed when only author was set');
  assert.deepEqual(dto.metadata.genres, ['Action', 'Fantasy'], 'genres changed when only author was set');
});
