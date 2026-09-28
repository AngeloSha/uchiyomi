// The library's two source filters, against a real database.
//
// `mainSource` is the source a series was added from (lib_series.source_id); `anySource` is that OR a source
// it follows as a fallback (series_sources). GET /api/library/sources counts both per source, and the panel
// shows those counts beside each chip -- so the count is a promise about what tapping the chip returns. The
// invariant pinned here is the one genreOverview.int.test.ts pins for genres: the counts and the search agree,
// and the counts are a VIEW, hiding what the viewer may not list (a source only a hidden library reads from
// is not named at all).
//
// sourceFilter.test.ts pins the SQL's shape without a database; this pins the rows it selects.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_sf_x';
const SERIES = ['s_sf_a', 's_sf_b', 's_sf_c', 's_sf_d', 's_sf_e'] as const;
const SOURCES = ['sf-x', 'sf-y', 'sf-z', 'sf-w'] as const;

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { owned } = await import('../src/lib/ownedCatalog');
  const { viewCtxFor, SYSTEM_CTX } = await import('../src/lib/visibility');
  await migrate();

  await cleanup(q);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'SF','SfLib')`, [LIB]);

  //   a: added from x, follows y        b: added from y
  //   c: added from x                   d: added from z, soft-deleted, follows x
  //   e: added from w, in LIB (a library the bound member cannot open), follows y
  const rows: Array<[string, string, string]> = [
    ['s_sf_a', 'sf-x', 'lib'],
    ['s_sf_b', 'sf-y', 'lib'],
    ['s_sf_c', 'sf-x', 'lib'],
    ['s_sf_d', 'sf-z', 'lib'],
    ['s_sf_e', 'sf-w', LIB],
  ];
  for (const [id, source, lib] of rows) {
    await q(
      `INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id, library_id, latest_mtime)
       VALUES ($1,'T!sf',$1,$1,1,$2,$1,$3, extract(epoch from now())::bigint)`,
      [id, source, lib],
    );
  }
  const follow = (id: string, source: string) =>
    q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,$2,$1)`, [id, source]);
  await follow('s_sf_a', 'sf-y');
  await follow('s_sf_d', 'sf-x');
  await follow('s_sf_e', 'sf-y');
  await q(`UPDATE lib_series SET deleted_at = now() WHERE id = 's_sf_d'`);

  const bound = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ('sf-bound','sf-bound','x','user','password') RETURNING id`))[0].id;
  await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1,$2)', [bound, 'lib']);

  return { q, owned, viewCtxFor, SYSTEM_CTX, bound };
}

async function cleanup(q: (sql: string, params?: any[]) => Promise<any>) {
  await q('DELETE FROM series_sources WHERE series_id = ANY($1)', [SERIES]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q(`DELETE FROM users WHERE username = 'sf-bound'`).catch(() => {});
}

const ours = (r: any): string[] => r.content.map((s: any) => s.id).filter((i: string) => (SERIES as readonly string[]).includes(i)).sort();
const bySource = (rows: any[]) =>
  Object.fromEntries(rows.filter((r) => (SOURCES as readonly string[]).includes(r.id)).map((r) => [r.id, r]));

test('library source filters', { skip }, async (t) => {
  const { q, owned, viewCtxFor, SYSTEM_CTX, bound } = await setup();
  const search = (condition: any, ctx: any = SYSTEM_CTX) => owned.searchSeries(ctx, { condition }, 0, 200);

  try {
    await t.test('mainSource returns only the series added from that source', async () => {
      assert.deepEqual(ours(await search({ mainSource: { operator: 'is', value: 'sf-x' } })), ['s_sf_a', 's_sf_c']);
      // Reintroduce by consulting series_sources in mainSource: b would come back for y through a's follow.
      assert.deepEqual(ours(await search({ mainSource: { operator: 'is', value: 'sf-y' } })), ['s_sf_b']);
    });

    await t.test('anySource adds the series that follow the source as a fallback', async () => {
      assert.deepEqual(ours(await search({ anySource: { operator: 'is', value: 'sf-y' } })), ['s_sf_a', 's_sf_b', 's_sf_e']);
      assert.deepEqual(ours(await search({ anySource: { operator: 'is', value: 'sf-x' } })), ['s_sf_a', 's_sf_c'],
        'd follows x but is soft-deleted, and a filter must not bring a hidden series back');
    });

    await t.test('isNot negates, and both combine with the other conditions', async () => {
      assert.deepEqual(ours(await search({ mainSource: { operator: 'isNot', value: 'sf-x' } })), ['s_sf_b', 's_sf_e']);
      assert.deepEqual(
        ours(await search({ allOf: [{ anySource: { operator: 'is', value: 'sf-y' } }, { mainSource: { operator: 'isNot', value: 'sf-y' } }] })),
        ['s_sf_a', 's_sf_e'], 'read from y, but not added from it');
      assert.deepEqual(
        ours(await search({ allOf: [{ anySource: { operator: 'is', value: 'sf-y' } }, { libraryId: { operator: 'is', value: LIB } }] })),
        ['s_sf_e']);
    });

    await t.test('a source that is not installed still filters', async () => {
      // None of these ids is a registered adapter: the filter compares ids as stored, so a series whose
      // extension was removed can still be found by where it came from.
      const r = await search({ mainSource: { operator: 'is', value: 'sf-w' } });
      assert.deepEqual(ours(r), ['s_sf_e']);
    });

    await t.test('librarySources counts main and any per source, hidden series excluded', async () => {
      const s = bySource(await owned.librarySources(SYSTEM_CTX));
      assert.deepEqual({ main: s['sf-x'].main, any: s['sf-x'].any }, { main: 2, any: 2 }, 'd is soft-deleted: its follow of x must not count');
      assert.deepEqual({ main: s['sf-y'].main, any: s['sf-y'].any }, { main: 1, any: 3 });
      assert.deepEqual({ main: s['sf-w'].main, any: s['sf-w'].any }, { main: 1, any: 1 });
      assert.ok(!('sf-z' in s), 'z is only the source of a soft-deleted series, so it has nothing to filter to');
    });

    await t.test('every count is what the search behind it returns', async () => {
      // The chip says "{name} {n}": if these ever disagree, the panel promises a number the grid does not show.
      for (const ctx of [SYSTEM_CTX, await viewCtxFor(bound)]) {
        const rows = (await owned.librarySources(ctx)).filter((r: any) => (SOURCES as readonly string[]).includes(r.id));
        assert.ok(rows.length > 0);
        for (const r of rows) {
          const main = await search({ mainSource: { operator: 'is', value: r.id } }, ctx);
          const any = await search({ anySource: { operator: 'is', value: r.id } }, ctx);
          assert.equal(r.main, main.totalElements, `${r.id}: main says ${r.main}, the search returns ${main.totalElements}`);
          assert.equal(r.any, any.totalElements, `${r.id}: any says ${r.any}, the search returns ${any.totalElements}`);
        }
      }
    });

    await t.test('a member does not see a source only a library closed to them reads from', async () => {
      const s = bySource(await owned.librarySources(await viewCtxFor(bound)));
      assert.ok(!('sf-w' in s), 'naming w would tell the member a series they cannot open exists, and where it came from');
      assert.equal(s['sf-y'].any, 2, "e's follow of y is in a library this member cannot open");
      assert.deepEqual(ours(await search({ anySource: { operator: 'is', value: 'sf-y' } }, await viewCtxFor(bound))), ['s_sf_a', 's_sf_b']);
    });
  } finally {
    await cleanup(q);
  }
});
