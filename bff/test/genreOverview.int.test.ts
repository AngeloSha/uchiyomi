// The genre overview, and the four rules it inherits for free by going through seriesSrc.
//
// The browse page used to have genre NAMES and nothing else, so it painted them with six stock images shared
// between forty genre names: the same night-market photo under Comedy, Cooking, Historical, Music, School
// Life, Slice of Life and Sports, and a near-black gradient rectangle under everything unmapped. Covers from
// the viewer's own library cannot repeat like that and cannot be wrong.
//
// The thing worth testing is not the aggregate, it is that the aggregate is a VIEW. A genre count is a
// disclosure: "Horror (12)" tells a restricted member that twelve horror series exist somewhere, and a cover
// id tells them exactly which. So every rule that hides a series from the grid has to hide it from the count
// and from the mosaic too, and there is no second predicate here to keep in sync -- if this drifts from
// /api/series/search, one of the two is wrong.
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

const LIB = 'lib_go_x';
const SERIES = ['s_go_a', 's_go_b', 's_go_c', 's_go_d'] as const;

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { owned } = await import('../src/lib/ownedCatalog');
  const { viewCtxFor, SYSTEM_CTX } = await import('../src/lib/visibility');
  await migrate();

  await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q(`DELETE FROM users WHERE username LIKE 'go-%'`).catch(() => {});
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'GO','GoLib')`, [LIB]);

  // a and b are in the default library; c is in GoLib; d is in the default library but 18+.
  const rows: Array<[string, string[], string, number | null]> = [
    ['s_go_a', ['Cooking', 'Slice of Life'], 'lib', null],
    ['s_go_b', ['Cooking'], 'lib', null],
    ['s_go_c', ['Murim'], LIB, null],
    ['s_go_d', ['Horror'], 'lib', 18],
  ];
  for (const [id, genres, lib, age] of rows) {
    await q(
      `INSERT INTO lib_series (id, source, title, folder, books_count, genres, library_id, age_rating, latest_mtime)
       VALUES ($1,'T!go',$1,$1,1,$2,$3,$4, extract(epoch from now())::bigint)`,
      [id, genres, lib, age],
    );
  }
  const mk = async (name: string) => (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ($1,$1,'x','user','password') RETURNING id`, [name]))[0].id;

  return { q, owned, viewCtxFor, SYSTEM_CTX, free: await mk('go-free'), bound: await mk('go-bound') };
}

const byName = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.key, r]));

test('genre overview', { skip }, async (t) => {
  const { q, owned, viewCtxFor, SYSTEM_CTX, free, bound } = await setup();

  try {
    await t.test('counts and covers come back per genre', async () => {
      const g = byName(await owned.genreOverview(SYSTEM_CTX, 4));
      assert.equal(g['cooking'].series, 2, 'two series carry Cooking');
      assert.equal(g['slice of life'].series, 1);
      assert.deepEqual([...g['cooking'].covers].sort(), ['s_go_a', 's_go_b'],
        'the tile needs ids to render covers with; a name alone is what made this page repeat six images');
      assert.ok(g['cooking'].covers.length <= 4, 'never more than asked for');
    });

    await t.test('a genre nobody can see is not listed at all', async () => {
      // Restricted to the default library, so Murim exists only inside GoLib and must not appear.
      await q('DELETE FROM user_libraries WHERE user_id = $1', [bound]);
      await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1,$2)', [bound, 'lib']);
      const g = byName(await owned.genreOverview(await viewCtxFor(bound), 4));
      assert.ok(!('murim' in g), 'a genre count leaks that a library exists and roughly how big it is');
      assert.equal(g['cooking'].series, 2, 'and the genres they DO hold are unaffected');
    });

    await t.test('an age cap removes a series from the count AND the covers', async () => {
      await q('DELETE FROM user_libraries WHERE user_id = $1', [free]);
      await q('UPDATE users SET max_age_rating = 13 WHERE id = $1', [free]);
      const g = byName(await owned.genreOverview(await viewCtxFor(free), 4));
      assert.ok(!('horror' in g), 'the 18+ series was the only Horror one, so Horror must vanish for this account');

      await q('UPDATE users SET max_age_rating = NULL WHERE id = $1', [free]);
      assert.ok('horror' in byName(await owned.genreOverview(await viewCtxFor(free), 4)),
        'and come back when the cap is lifted');
    });

    await t.test('a hidden series stops counting', async () => {
      await q(`UPDATE lib_series SET deleted_at = now() WHERE id = 's_go_b'`);
      const g = byName(await owned.genreOverview(SYSTEM_CTX, 4));
      assert.equal(g['cooking'].series, 1, 'a soft-deleted series was still being counted');
      assert.deepEqual(g['cooking'].covers, ['s_go_a'], 'and would have rendered a cover for a hidden series');
      await q(`UPDATE lib_series SET deleted_at = NULL WHERE id = 's_go_b'`);
    });

    await t.test('an override renames the genre, the same way search sees it', async () => {
      // seriesSrc resolves COALESCE(o.genres, s.genres), so an admin retagging a series has to move it
      // between genres here as well -- otherwise browse and search disagree about what a genre contains.
      await q(`INSERT INTO series_overrides (series_id, genres) VALUES ('s_go_a', $1)
               ON CONFLICT (series_id) DO UPDATE SET genres = EXCLUDED.genres`, [['Retagged']]);
      const g = byName(await owned.genreOverview(SYSTEM_CTX, 4));
      assert.equal(g['retagged'].series, 1);
      assert.equal(g['cooking'].series, 1, 'the old genre must lose it');
      assert.ok(!('slice of life' in g), 'and a genre that only that series carried must disappear');
      await q(`DELETE FROM series_overrides WHERE series_id = 's_go_a'`);
    });

    await t.test('THE CASING TRAP: differently-cased spellings are one genre, counted once', async () => {
      // condSql filters genres with `lower(g) = lower($n)`, so "Slice of life" and "Slice of Life" are ONE
      // filter and therefore have to be ONE tile. Grouping on the raw string instead produces two tiles
      // whose counts each understate what clicking them returns -- and a series carrying both spellings
      // gets counted twice in whichever tile it lands in. Real libraries have both: the production library
      // this was written against has 99 distinct genre strings and 92 distinct genres.
      await q(`UPDATE lib_series SET genres = $1 WHERE id = 's_go_a'`, [['COOKING', 'cooking']]);
      await q(`UPDATE lib_series SET genres = $1 WHERE id = 's_go_b'`, [['Cooking']]);

      const rows = await owned.genreOverview(SYSTEM_CTX, 4);
      const cook = rows.filter((r: any) => r.key === 'cooking');
      assert.equal(cook.length, 1, 'three spellings of Cooking produced more than one tile');
      assert.equal(cook[0].series, 2, 'a series carrying two spellings was counted twice');
      assert.equal([...cook[0].covers].sort().join(','), 's_go_a,s_go_b', 'and appeared twice in the mosaic');

      const found = await owned.searchSeries(
        SYSTEM_CTX, { condition: { genre: { operator: 'is', value: cook[0].label } } }, 0, 200);
      assert.equal(cook[0].series, found.totalElements,
        'the tile must promise exactly what clicking it delivers');

      await q(`UPDATE lib_series SET genres = $1 WHERE id = 's_go_a'`, [['Cooking', 'Slice of Life']]);
      await q(`UPDATE lib_series SET genres = $1 WHERE id = 's_go_b'`, [['Cooking']]);
    });

    await t.test('it agrees with what search returns for the same genre', async () => {
      // The one invariant that matters: if these ever disagree, a tile promises a number the grid behind it
      // does not deliver, and there is no way to tell which of the two is lying.
      const g = byName(await owned.genreOverview(SYSTEM_CTX, 4));
      for (const key of Object.keys(g)) {
        const found = await owned.searchSeries(
          SYSTEM_CTX, { condition: { genre: { operator: 'is', value: g[key].label } } }, 0, 200);
        assert.equal(g[key].series, found.totalElements,
          `browse says ${g[key].series} series in "${g[key].label}" and search returns ${found.totalElements}`);
      }
    });
  } finally {
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]).catch(() => {});
    await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
    await q(`DELETE FROM users WHERE username LIKE 'go-%'`).catch(() => {});
  }
});
