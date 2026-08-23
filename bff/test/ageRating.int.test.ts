// Age ratings, and the cap that enforces them.
//
// The README and the site say "built for a household" eleven times, and a household often includes children.
// Komga and Kavita both let you cap an account by rating; this could not, and `ageRating` was hardcoded
// `null` in the catalog. Per-library access was the only workaround, and it relies on remembering to file
// every new adult title into the right library, forever.
//
// The whole enforcement is ONE CLAUSE in `visible()`, which is the single predicate every read path already
// shares -- so these tests are about proving that clause reaches everywhere, and that it fails safe.
//
// Two decisions are pinned here because both could reasonably have gone the other way and both would be
// discovered the hard way:
//
//   * UNRATED IS VISIBLE. Treating NULL as adults-only would empty most of an existing library the first
//     time a parent set a cap, and they would reasonably read that as the app being broken.
//   * AN ADMIN OVERRIDE WINS over what the scan read, like every other piece of series metadata, so a
//     mis-tagged ComicInfo can be corrected and the correction survives a rescan.
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

const KID = 's_age_kid';      // rated 6
const TEEN = 's_age_teen';    // rated 13
const ADULT = 's_age_adult';  // rated 18
const UNRATED = 's_age_none'; // no rating at all
const ALL = [KID, TEEN, ADULT, UNRATED];

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  await migrate();
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM series_overrides WHERE series_id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [ALL]).catch(() => {});
  await q(`DELETE FROM users WHERE username LIKE 'age-%'`).catch(() => {});

  for (const [id, rating] of [[KID, 6], [TEEN, 13], [ADULT, 18], [UNRATED, null]] as const) {
    await q(
      `INSERT INTO lib_series (id, source, title, folder, books_count, age_rating) VALUES ($1,'T!age',$1,$2,1,$3)`,
      [id, `T!age/${id}`, rating],
    );
    await q(
      `INSERT INTO lib_books (id, series_id, source, file, number, title)
       VALUES ($1,$2,'T!age',$3,1,'Chapter 1')`,
      [`b_${id}`, id, `T!age/${id}/ch1.cbz`],
    );
  }

  const mk = async (name: string, cap: number | null) => {
    const r = await q<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, auth_kind, max_age_rating)
       VALUES ($1,$1,'x','user','password',$2) RETURNING id`, [name, cap],
    );
    return r[0].id;
  };
  return {
    q,
    child: await mk('age-child', 13),
    grown: await mk('age-grown', null),
    admin: (await q<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, auth_kind, max_age_rating)
       VALUES ('age-admin','age-admin','x','admin','password',6) RETURNING id`))[0].id,
  };
}

test('age ratings', { skip }, async (t) => {
  const { q, child, grown, admin } = await setup();
  const { viewCtxFor, seriesVisible } = await import('../src/lib/visibility');
  const { content } = await import('../src/lib/backend');

  const idsFor = async (userId: string, role?: string) => {
    const ctx = await viewCtxFor(userId, role);
    const res = await content.searchSeries(ctx, {}, 0, 100);
    return new Set<string>(res.content.map((s: any) => s.id));
  };

  try {
    await t.test('an uncapped member sees everything, exactly as before', async () => {
      const seen = await idsFor(grown);
      for (const id of ALL) assert.ok(seen.has(id), `${id} should be visible to an uncapped member`);
    });

    await t.test('THE POINT: a capped member is refused above the cap', async () => {
      const seen = await idsFor(child);
      assert.ok(seen.has(KID), 'below the cap');
      assert.ok(seen.has(TEEN), 'at the cap: 13 <= 13');
      assert.ok(!seen.has(ADULT), 'an 18-rated series reached a member capped at 13');
    });

    await t.test('UNRATED STAYS VISIBLE, or a cap empties an existing library', async () => {
      const seen = await idsFor(child);
      assert.ok(seen.has(UNRATED),
        'unrated content vanished for a capped member -- almost nothing in a real library carries a rating, ' +
        'so this would look like the app losing the library rather than a policy taking effect');
    });

    await t.test('an admin is never capped, even with a cap set on the row', async () => {
      // The admin row above deliberately carries max_age_rating = 6. Role wins, the same way it does for
      // library access, so an admin can always see what they are administering.
      const seen = await idsFor(admin, 'admin');
      for (const id of ALL) assert.ok(seen.has(id), `${id} should be visible to an admin`);
    });

    await t.test('the cap reaches a chapter, not just the series list', async () => {
      // booksSrc joins lib_series specifically so series-level rules reach chapters. If that join stopped
      // carrying the age clause, a book id would open a chapter of a series the viewer cannot see.
      const kidCtx = await viewCtxFor(child);
      const grownCtx = await viewCtxFor(grown);
      assert.ok(await content.book(grownCtx, `b_${ADULT}`), 'an uncapped member can open it');
      assert.equal(await content.book(kidCtx, `b_${ADULT}`).catch(() => null), null,
        'a capped member reached a chapter of a series above their cap');
      assert.deepEqual(await content.bookPages(kidCtx, `b_${ADULT}`), [],
        'page dimensions leaked for a series above the cap');
    });

    await t.test('the cap reaches the image server and OPDS', async () => {
      // Both resolve through visibleBookFile / seriesVisible rather than the catalog, so they are the two
      // paths a series-level rule has historically failed to reach.
      const { visibleBookFile } = await import('../src/lib/visibility');
      const kidCtx = await viewCtxFor(child);
      const grownCtx = await viewCtxFor(grown);
      assert.ok(await visibleBookFile(`b_${ADULT}`, grownCtx), 'uncapped can fetch the file');
      assert.equal(await visibleBookFile(`b_${ADULT}`, kidCtx), null,
        'the image server would have served raw page bytes above the cap');
      assert.equal(await seriesVisible(ADULT, kidCtx), false);
      assert.equal(await seriesVisible(ADULT, grownCtx), true);
    });

    await t.test('an admin override beats what the scan read, and survives a rescan', async () => {
      // A mis-tagged ComicInfo has to be correctable, and the correction must not be undone by the next scan.
      await q(
        `INSERT INTO series_overrides (series_id, age_rating, updated_at) VALUES ($1, 6, now())
         ON CONFLICT (series_id) DO UPDATE SET age_rating = 6, updated_at = now()`, [ADULT],
      );
      try {
        assert.ok((await idsFor(child)).has(ADULT), 'the override should have lowered it below the cap');
        assert.equal(await seriesVisible(ADULT, await viewCtxFor(child)), true);
      } finally {
        await q('DELETE FROM series_overrides WHERE series_id = $1', [ADULT]);
      }
    });

    await t.test('an override can also raise a rating the scan got wrong', async () => {
      await q(
        `INSERT INTO series_overrides (series_id, age_rating, updated_at) VALUES ($1, 18, now())
         ON CONFLICT (series_id) DO UPDATE SET age_rating = 18, updated_at = now()`, [KID],
      );
      try {
        assert.ok(!(await idsFor(child)).has(KID), 'raising a rating above the cap should hide it');
      } finally {
        await q('DELETE FROM series_overrides WHERE series_id = $1', [KID]);
      }
    });

    await t.test('THE UPGRADE: nothing changes for an install with no ratings and no caps', async () => {
      // Every existing install is in exactly this state after the migration runs.
      await q('UPDATE lib_series SET age_rating = NULL WHERE id = ANY($1)', [ALL]);
      try {
        const seen = await idsFor(child);
        for (const id of ALL) {
          assert.ok(seen.has(id), `${id} disappeared on upgrade for a member who happens to have a cap`);
        }
      } finally {
        await q('UPDATE lib_series SET age_rating = 18 WHERE id = $1', [ADULT]);
        await q('UPDATE lib_series SET age_rating = 13 WHERE id = $1', [TEEN]);
        await q('UPDATE lib_series SET age_rating = 6 WHERE id = $1', [KID]);
      }
    });
  } finally {
    await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [ALL]).catch(() => {});
    await q('DELETE FROM series_overrides WHERE series_id = ANY($1)', [ALL]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [ALL]).catch(() => {});
    await q(`DELETE FROM users WHERE username LIKE 'age-%'`).catch(() => {});
  }
});

// ---------------------------------------------------------------------------------------------------

test('ComicInfo AgeRating is parsed into a minimum age', async () => {
  const { parseComicInfoAgeRating } = await import('../src/lib/ageRating');

  assert.equal(parseComicInfoAgeRating('Everyone'), 6);
  assert.equal(parseComicInfoAgeRating('Everyone 10+'), 10);
  assert.equal(parseComicInfoAgeRating('Teen'), 13);
  assert.equal(parseComicInfoAgeRating('MA15+'), 15);
  assert.equal(parseComicInfoAgeRating('Mature 17+'), 17);
  assert.equal(parseComicInfoAgeRating('Adults Only 18+'), 18);
  assert.equal(parseComicInfoAgeRating('R18+'), 18);
  assert.equal(parseComicInfoAgeRating('  teen  '), 13, 'whitespace and case must not matter');

  // "nobody has said" is a third state, and must never be guessed at in either direction.
  assert.equal(parseComicInfoAgeRating('Unknown'), null);
  assert.equal(parseComicInfoAgeRating('Rating Pending'), null);
  assert.equal(parseComicInfoAgeRating(''), null);
  assert.equal(parseComicInfoAgeRating(null), null);
  assert.equal(parseComicInfoAgeRating('some nonsense'), null,
    'an unrecognised label must be unrated, not adults-only: guessing high hides a library');

  // Bare numbers are common in hand-written files and worth keeping.
  assert.equal(parseComicInfoAgeRating('16'), 16);
  assert.equal(parseComicInfoAgeRating('16+'), 16);
  assert.equal(parseComicInfoAgeRating('2019'), null, 'a stray year must not become a rating');
  assert.equal(parseComicInfoAgeRating('99'), null, 'out of range is unrated, not clamped');
});
