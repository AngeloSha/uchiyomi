// Managing libraries: nesting, pinning, inherited age ratings, and access from the library's side.
//
// The old model was "a library IS a folder", assignment was a pure function of the path, and the only way to
// create one was to pick from a list of top-level folders -- which on a real install are the source names the
// downloader wrote. So the only options offered were the ones an admin should not pick, and the folder they
// actually wanted could not be reached at all.
//
// Four things here are easy to get wrong and expensive to discover in production:
//
//   1. NESTING. `Manga/Seinen` inside `Manga` must resolve to the inner one, and deleting the inner must
//      return its series to `Manga` -- not to the default library, which would tear the contents out of the
//      parent every time someone removed a sub-library.
//   2. PINNING. A series moved by hand must survive a rescan, survive a library being created whose path
//      contains it, and survive that library being re-pathed. Otherwise the hand-move silently undoes itself
//      later, which is worse than not offering it.
//   3. INHERITED RATINGS. A library's rating has to reach its series, or marking a library 18+ does nothing.
//      A series rating must still beat it, or one title can never be let through.
//   4. THE GRANT TRAP. `user_libraries` having no rows means EVERY library. So "grant access" to an
//      unrestricted member, done naively, RESTRICTS them to just that one. That is the single easiest way to
//      lock someone out of their own library, and it is the reason this file exists.
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

const OUTER = 'lib_t_outer';
const INNER = 'lib_t_inner';
const SERIES = ['s_lm_a', 's_lm_b', 's_lm_c'] as const;
const FOLDERS: Record<string, string> = {
  s_lm_a: 'Manga/Shounen/Alpha',   // outer only
  s_lm_b: 'Manga/Seinen/Beta',     // inner
  s_lm_c: 'Elsewhere/Gamma',       // neither
};

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const adminRoutes = (await import('../src/routes/admin')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [SERIES]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[OUTER, INNER]]).catch(() => {});
  await q(`DELETE FROM users WHERE username LIKE 'lm-%'`).catch(() => {});

  for (const id of SERIES) {
    await q(
      `INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!lm',$1,$2,1)`,
      [id, FOLDERS[id]],
    );
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title)
             VALUES ($1,$2,'T!lm',$3,1,'Chapter 1')`, [`b_${id}`, id, `${FOLDERS[id]}/ch1.cbz`]);
  }
  const mk = async (name: string, role = 'user') => (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ($1,$1,'x',$2,'password') RETURNING id`, [name, role]))[0].id;

  const free = await mk('lm-free');
  const bound = await mk('lm-bound');
  const admin = await mk('lm-admin', 'admin');

  // The real routes, so the grant trap is exercised through the endpoint rather than around it. Asserting
  // the property without calling the code is how a correct function reached by a wrong route ships.
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.ready();
  const auth = { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` };

  return { q, free, bound, app, auth };
}

async function cleanup(q: any) {
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [SERIES]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[OUTER, INNER]]).catch(() => {});
  await q(`DELETE FROM users WHERE username LIKE 'lm-%'`).catch(() => {});
}

const libOf = async (q: any, id: string) =>
  (await q<{ library_id: string }>('SELECT library_id FROM lib_series WHERE id = $1', [id]))[0].library_id;

test('library management', { skip }, async (t) => {
  const { q, free, bound, app, auth } = await setup();
  const { content } = await import('../src/lib/backend');
  const { libraryIdFor } = await import('../src/lib/library');

  try {
    await t.test('NESTING: the most specific library wins', async () => {
      const libs = [{ id: 'lib', path: '' }, { id: OUTER, path: 'Manga' }, { id: INNER, path: 'Manga/Seinen' }];
      assert.equal(libraryIdFor('Manga/Shounen/Alpha', libs), OUTER, 'only the outer contains it');
      assert.equal(libraryIdFor('Manga/Seinen/Beta', libs), INNER, 'both contain it; the deeper one wins');
      assert.equal(libraryIdFor('Elsewhere/Gamma', libs), 'lib', 'neither contains it');
      assert.equal(libraryIdFor('Manga', libs), OUTER, 'the library folder itself belongs to it');
    });

    await t.test('creating a nested library takes only from less specific ones', async () => {
      await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Outer','Manga')`, [OUTER]);
      await q(
        `UPDATE lib_series s SET library_id = $1
          WHERE NOT s.library_pinned AND (s.folder = $2 OR s.folder LIKE $2 || '/%')
            AND length((SELECT l.path FROM libraries l WHERE l.id = s.library_id)) < length($2::text)`,
        [OUTER, 'Manga'],
      );
      assert.equal(await libOf(q, 's_lm_a'), OUTER);
      assert.equal(await libOf(q, 's_lm_b'), OUTER);
      assert.equal(await libOf(q, 's_lm_c'), 'lib', 'a series outside the path must not be claimed');

      await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Inner','Manga/Seinen')`, [INNER]);
      await q(
        `UPDATE lib_series s SET library_id = $1
          WHERE NOT s.library_pinned AND (s.folder = $2 OR s.folder LIKE $2 || '/%')
            AND length((SELECT l.path FROM libraries l WHERE l.id = s.library_id)) < length($2::text)`,
        [INNER, 'Manga/Seinen'],
      );
      assert.equal(await libOf(q, 's_lm_b'), INNER, 'the inner library should have taken it from the outer');
      assert.equal(await libOf(q, 's_lm_a'), OUTER, 'and left the rest of the outer alone');
    });

    await t.test('THE PIN: a hand-moved series is not taken back', async () => {
      // Gamma lives at Elsewhere/, but an admin filed it under the inner library on purpose.
      await q('UPDATE lib_series SET library_id = $2, library_pinned = true WHERE id = $1', ['s_lm_c', INNER]);

      // A library is created whose path contains a pinned series -> must not claim it.
      await q('UPDATE lib_series SET library_id = $2, library_pinned = true WHERE id = $1', ['s_lm_a', INNER]);
      await q(
        `UPDATE lib_series s SET library_id = $1
          WHERE NOT s.library_pinned AND (s.folder = $2 OR s.folder LIKE $2 || '/%')
            AND length((SELECT l.path FROM libraries l WHERE l.id = s.library_id)) < length($2::text)`,
        [OUTER, 'Manga'],
      );
      assert.equal(await libOf(q, 's_lm_a'), INNER,
        'a pinned series was taken back by the folder rule, so the hand-move silently undid itself');

      // And a rescan must not recompute it either.
      const libs = [{ id: 'lib', path: '' }, { id: OUTER, path: 'Manga' }, { id: INNER, path: 'Manga/Seinen' }];
      assert.equal(libraryIdFor(FOLDERS.s_lm_a, libs), OUTER,
        'the folder rule still says OUTER, which is exactly why the pin has to be checked separately');

      await q('UPDATE lib_series SET library_id = $2, library_pinned = false WHERE id = $1', ['s_lm_a', OUTER]);
    });

    await t.test('deleting a nested library returns its series to the ENCLOSING one', async () => {
      assert.equal(await libOf(q, 's_lm_b'), INNER);
      await q(
        `UPDATE lib_series s SET library_id = COALESCE((
           SELECT l.id FROM libraries l
            WHERE l.id <> $1 AND (l.path = '' OR s.folder = l.path OR s.folder LIKE l.path || '/%')
            ORDER BY length(l.path) DESC LIMIT 1), 'lib')
          WHERE s.library_id = $1`,
        [INNER],
      );
      assert.equal(await libOf(q, 's_lm_b'), OUTER,
        'sending it to the default would tear a nested library out of its parent on delete');
      assert.equal(await libOf(q, 's_lm_c'), 'lib', 'and a series outside every path goes to the default');
      await q('DELETE FROM libraries WHERE id = $1', [INNER]);
    });

    await t.test('RATINGS INHERIT from the library, and a series still beats it', async () => {
      const { viewCtxFor } = await import('../src/lib/visibility');
      const ids = async (userId: string) => {
        const r = await content.searchSeries(await viewCtxFor(userId), {}, 0, 100);
        return new Set<string>(r.content.map((x: any) => x.id));
      };
      await q('UPDATE users SET max_age_rating = 13 WHERE id = $1', [free]);
      await q('UPDATE libraries SET age_rating = 18 WHERE id = $1', [OUTER]);
      try {
        let seen = await ids(free);
        assert.ok(!seen.has('s_lm_a'), 'an 18+ library must hide its series from a member capped at 13');
        assert.ok(seen.has('s_lm_c'), 'and must not affect a series outside it');

        // One title inside the adult library, rated lower on purpose.
        await q('UPDATE lib_series SET age_rating = 6 WHERE id = $1', ['s_lm_a']);
        seen = await ids(free);
        assert.ok(seen.has('s_lm_a'), 'a series rating must beat the library it is in');

        // And an override beats the series.
        await q(`INSERT INTO series_overrides (series_id, age_rating, updated_at) VALUES ($1,18,now())
                 ON CONFLICT (series_id) DO UPDATE SET age_rating = 18`, ['s_lm_a']);
        seen = await ids(free);
        assert.ok(!seen.has('s_lm_a'), 'an admin override must beat both');
      } finally {
        await q('DELETE FROM series_overrides WHERE series_id = $1', ['s_lm_a']);
        await q('UPDATE lib_series SET age_rating = NULL WHERE id = ANY($1)', [SERIES]);
        await q('UPDATE libraries SET age_rating = NULL WHERE id = $1', [OUTER]);
        await q('UPDATE users SET max_age_rating = NULL WHERE id = $1', [free]);
      }
    });

    await t.test('THE GRANT TRAP: granting to an unrestricted member must not reduce their access', async () => {
      const { viewCtxFor } = await import('../src/lib/visibility');
      // `members` is the full list of who may see the library, so it revokes everyone absent from it. That
      // makes these tests order-dependent unless grants are cleared first.
      await q(`DELETE FROM user_libraries WHERE user_id = ANY($1)`, [[free, bound]]);
      assert.equal((await viewCtxFor(free)).libraryIds, null, 'starts unrestricted');

      // Through the real route. The naive implementation inserts one row here, which would silently turn an
      // unrestricted member into one who can see ONLY this library -- the opposite of what "grant" means.
      const r = await app.inject({
        method: 'PATCH', url: `/api/admin/libraries/${OUTER}`, headers: auth,
        payload: { members: [free] },
      });
      assert.equal(r.statusCode, 200);
      assert.equal((await viewCtxFor(free)).libraryIds, null,
        'granting a library to an unrestricted member turned them into a restricted one');
    });

    await t.test('revoking from an unrestricted member writes out the others', async () => {
      // "Everything except this one" cannot be said by deleting a row that does not exist. Without writing
      // the rest out explicitly, revoke silently does nothing at all.
      const { viewCtxFor } = await import('../src/lib/visibility');
      await q(`DELETE FROM user_libraries WHERE user_id = ANY($1)`, [[free, bound]]);
      assert.equal((await viewCtxFor(bound)).libraryIds, null, 'starts unrestricted');

      const r = await app.inject({
        method: 'PATCH', url: `/api/admin/libraries/${OUTER}`, headers: auth,
        payload: { members: [] },   // nobody may see this library
      });
      assert.equal(r.statusCode, 200);

      const ctx = await viewCtxFor(bound);
      assert.ok(ctx.libraryIds, 'the member must now be restricted, or the revoke did nothing');
      assert.ok(!ctx.libraryIds!.includes(OUTER), 'and must not see the revoked library');
      assert.ok(ctx.libraryIds!.includes('lib'), 'but must keep everything else');
    });

    await t.test('a bulk move pins every series, and reports what no longer exists', async () => {
      // The browser could loop the single-series route once per title; a bulk move of a whole shelf is
      // exactly where that is worst. What matters is that it behaves identically to the single move --
      // pinning each one -- and that it says what it skipped rather than quietly applying to fewer series
      // than were ticked.
      // The delete test above removed the inner library; this one needs the nested shape back.
      await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Inner','Manga/Seinen')
               ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`, [INNER]);
      await q('UPDATE lib_series SET library_pinned = false, library_id = $2 WHERE id = ANY($1)',
        [SERIES, 'lib']);

      const r = await app.inject({
        method: 'POST', url: '/api/admin/series/library', headers: auth,
        payload: { seriesIds: [...SERIES, 's_lm_gone'], libraryId: OUTER },
      });
      assert.equal(r.statusCode, 200);
      assert.equal(r.json().applied, SERIES.length);
      assert.deepEqual(r.json().skipped, [{ id: 's_lm_gone' }], 'a vanished series must be reported, not hidden');

      const rows = await q<{ id: string; library_id: string; library_pinned: boolean }>(
        'SELECT id, library_id, library_pinned FROM lib_series WHERE id = ANY($1)', [SERIES]);
      for (const row of rows) {
        assert.equal(row.library_id, OUTER, `${row.id} did not move`);
        assert.equal(row.library_pinned, true, `${row.id} moved but was not pinned, so a rescan would undo it`);
      }

      // And back to automatic: unpinning has to re-derive the folder rule, not leave them parked where the
      // bulk move put them.
      const back = await app.inject({
        method: 'POST', url: '/api/admin/series/library', headers: auth,
        payload: { seriesIds: [...SERIES], libraryId: null },
      });
      assert.equal(back.statusCode, 200);
      const after = await q<{ id: string; library_id: string; library_pinned: boolean }>(
        'SELECT id, library_id, library_pinned FROM lib_series WHERE id = ANY($1) ORDER BY id', [SERIES]);
      assert.deepEqual(after.map((x) => x.library_pinned), [false, false, false]);
      assert.equal(after.find((x) => x.id === 's_lm_b')!.library_id, INNER, 'Manga/Seinen/Beta belongs to the inner library');
      assert.equal(after.find((x) => x.id === 's_lm_c')!.library_id, 'lib', 'Elsewhere/Gamma belongs to neither');
    });

    await t.test('a moved series comes back out of the API pinned, or the UI cannot say so', async () => {
      await app.inject({
        method: 'POST', url: `/api/admin/series/s_lm_c/library`, headers: auth,
        payload: { libraryId: OUTER },
      });
      const { SYSTEM_CTX } = await import('../src/lib/visibility');
      const dto: any = await content.series(SYSTEM_CTX, 's_lm_c');
      assert.equal(dto.libraryId, OUTER);
      assert.equal(dto.libraryPinned, true,
        'the edit modal seeds its Library control from this, so without it every series reads as automatic');

      await app.inject({
        method: 'POST', url: `/api/admin/series/s_lm_c/library`, headers: auth, payload: { libraryId: null },
      });
      assert.equal((await content.series(SYSTEM_CTX, 's_lm_c') as any).libraryPinned, false);
    });

    await t.test('the library page can filter by library, and cannot filter to one it may not see', async () => {
      // Without this the tab row on /library is decorative: every library shows the whole collection.
      const { SYSTEM_CTX, viewCtxFor } = await import('../src/lib/visibility');
      const ids = async (ctx: any, libraryId: string) =>
        (await content.searchSeries(ctx, { condition: { allOf: [{ libraryId: { operator: 'is', value: libraryId } }] } }, 0, 50))
          .content.map((s: any) => s.id).filter((id: string) => (SERIES as readonly string[]).includes(id)).sort();

      assert.deepEqual(await ids(SYSTEM_CTX, INNER), ['s_lm_b']);
      assert.deepEqual(await ids(SYSTEM_CTX, OUTER), ['s_lm_a']);

      // A member restricted away from the inner library asking for it by id gets nothing, rather than an
      // error that would confirm it exists.
      await q('DELETE FROM user_libraries WHERE user_id = $1', [bound]);
      await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1,$2)', [bound, 'lib']);
      assert.deepEqual(await ids(await viewCtxFor(bound), INNER), [],
        'filtering by a forbidden library returned its contents');
      await q('DELETE FROM user_libraries WHERE user_id = $1', [bound]);
    });

    await t.test('the preview promises what the create actually does', async () => {
      // The preview is the only thing anyone reads before committing, so it has to run the SAME predicate as
      // the handler. Its first version asked for `library_id = 'lib'`, which was right when libraries could
      // not nest and now reports 0 for a nested library whose series the enclosing one already holds.
      await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Inner','Manga/Seinen')
               ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`, [INNER]);
      await q(`UPDATE lib_series SET library_pinned = false, library_id = $2 WHERE id = ANY($1)`, [SERIES, OUTER]);

      const pv = (await app.inject({
        method: 'GET', url: '/api/admin/libraries/preview?path=' + encodeURIComponent('Manga/Seinen'), headers: auth,
      })).json();
      assert.equal(pv.series, 1, 'a nested library reported 0 because the preview only looked at the default library');
      assert.deepEqual(pv.sample, ['s_lm_b']);

      // And a pinned series is never promised, because the handler will not take it.
      await q('UPDATE lib_series SET library_pinned = true WHERE id = $1', ['s_lm_b']);
      assert.equal((await app.inject({
        method: 'GET', url: '/api/admin/libraries/preview?path=' + encodeURIComponent('Manga/Seinen'), headers: auth,
      })).json().series, 0, 'the preview counted a series the handler would leave alone');
      await q('UPDATE lib_series SET library_pinned = false WHERE id = $1', ['s_lm_b']);
    });

    await t.test('browsing folders refuses to leave the root, and 404s a path that is not there', async () => {
      const get = (p: string) => app.inject({
        method: 'GET', url: '/api/admin/libraries/folders?path=' + encodeURIComponent(p), headers: auth });

      assert.equal((await get('../../etc')).statusCode, 400, 'a traversal must not be answered');
      assert.equal((await get('definitely/not/a/real/folder')).statusCode, 404,
        'a typo must be told apart from a real but empty folder');

      const root = (await app.inject({ method: 'GET', url: '/api/admin/libraries/folders', headers: auth })).json();
      assert.equal(root.path, '');
      assert.equal(root.parent, null, 'the root has nowhere to go up to, and the UI disables the button on this');
      assert.ok(Array.isArray(root.folders));
    });

    // ---- three ways to widen access by accident ----
    //
    // No grant rows means EVERY library. That is deliberate and it is why nobody was locked out when
    // per-library access shipped. The cost is that "nothing" had no representation, so removing a member's
    // LAST grant left zero rows and therefore handed them the whole collection. Three separate gestures
    // reach that state, all of them phrased as taking access away, and none of them says anything.

    await t.test('WIDENING 1: revoking a member from their only library must not unrestrict them', async () => {
      const { viewCtxFor } = await import('../src/lib/visibility');
      await q('DELETE FROM user_libraries WHERE user_id = $1', [bound]);
      await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1,$2)', [bound, OUTER]);

      const r = await app.inject({
        method: 'PATCH', url: `/api/admin/libraries/${OUTER}`, headers: auth, payload: { members: [] },
      });
      assert.equal(r.statusCode, 200);

      const ctx = await viewCtxFor(bound);
      assert.ok(ctx.libraryIds, 'removing their last library made them unrestricted, so they now see everything');
      assert.ok(!ctx.libraryIds!.includes(OUTER));
      assert.equal((await content.searchSeries(ctx, {}, 0, 50)).content.length, 0,
        'and they can still read the collection');
    });

    await t.test('WIDENING 2: deleting a library a member was confined to must not unrestrict them', async () => {
      const { viewCtxFor } = await import('../src/lib/visibility');
      await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Inner','Manga/Seinen')
               ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`, [INNER]);
      await q('DELETE FROM user_libraries WHERE user_id = $1', [bound]);
      await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1,$2)', [bound, INNER]);

      const r = await app.inject({ method: 'DELETE', url: `/api/admin/libraries/${INNER}`, headers: auth });
      assert.equal(r.statusCode, 200);

      const ctx = await viewCtxFor(bound);
      assert.ok(ctx.libraryIds, 'deleting their only library promoted them to seeing every library');
      assert.equal((await content.searchSeries(ctx, {}, 0, 50)).content.length, 0);
    });

    await t.test('WIDENING 3: unticking every library on a member must not unrestrict them', async () => {
      const { viewCtxFor } = await import('../src/lib/visibility');
      await q('DELETE FROM user_libraries WHERE user_id = $1', [bound]);
      const r = await app.inject({
        method: 'PATCH', url: `/api/admin/users/${bound}`, headers: auth, payload: { libraries: [] },
      });
      assert.equal(r.statusCode, 200);

      const ctx = await viewCtxFor(bound);
      assert.ok(ctx.libraryIds, 'an empty list wrote no rows, which reads as every library');
      assert.equal((await content.searchSeries(ctx, {}, 0, 50)).content.length, 0);

      // And it has to be reversible: granting one back must clear the marker rather than sit beside it.
      await app.inject({
        method: 'PATCH', url: `/api/admin/users/${bound}`, headers: auth, payload: { libraries: [OUTER] },
      });
      const back = await viewCtxFor(bound);
      assert.deepEqual(back.libraryIds, [OUTER], 'the marker row outlived the grant that replaced it');

      // And the admin list has to describe all three states apart, or the member row says the wrong thing:
      // null for unrestricted, [] for "nothing", the real ids otherwise. The marker is a row, not a library.
      const who = async () => (await app.inject({ method: 'GET', url: '/api/admin/users', headers: auth }))
        .json().content.find((u: any) => u.id === bound).libraries;
      assert.deepEqual(await who(), [OUTER]);
      await app.inject({ method: 'PATCH', url: `/api/admin/users/${bound}`, headers: auth, payload: { libraries: [] } });
      assert.deepEqual(await who(), [], 'a member who can open nothing must not read as "1 library"');
      await app.inject({ method: 'PATCH', url: `/api/admin/users/${bound}`, headers: auth, payload: { libraries: null } });
      assert.equal(await who(), null, 'nor may unrestricted come back as an empty list');

      await q('DELETE FROM user_libraries WHERE user_id = $1', [bound]);
    });

    await t.test('a rating given at creation time is actually stored', async () => {
      // The UI used to create the library and then PATCH the rating as a second request, skipping it
      // entirely when the rating was null. A failed second call produced a library that showed everything
      // to everyone, under a success toast. One request now, so there is no half-created state.
      await q('DELETE FROM libraries WHERE id <> $1 AND path = $2', ['lib', 'Manga/Josei']).catch(() => {});
      const r = await app.inject({
        method: 'POST', url: '/api/admin/libraries', headers: auth,
        payload: { name: 'Grown-ups only', path: 'Manga/Josei', ageRating: 18 },
      });
      assert.equal(r.statusCode, 200);
      const made = r.json().id;
      const row = (await q<{ age_rating: number | null }>(
        'SELECT age_rating FROM libraries WHERE id = $1', [made]))[0];
      assert.equal(row.age_rating, 18, 'the rating was accepted and then dropped on the floor');

      // And omitting it still means unrated, rather than 0 (which would be a real cap).
      const plain = await app.inject({
        method: 'POST', url: '/api/admin/libraries', headers: auth,
        payload: { name: 'Everything else', path: 'Manga/Seinen/Plain' },
      });
      assert.equal(plain.statusCode, 200);
      assert.equal((await q<{ age_rating: number | null }>(
        'SELECT age_rating FROM libraries WHERE id = $1', [plain.json().id]))[0].age_rating, null);

      await q('DELETE FROM libraries WHERE id = ANY($1)', [[made, plain.json().id]]).catch(() => {});
    });

    await t.test('a library carries its rating and its member list back out', async () => {
      await app.inject({
        method: 'PATCH', url: `/api/admin/libraries/${OUTER}`, headers: auth,
        payload: { ageRating: 18, name: 'Grown-ups' },
      });
      const list = (await app.inject({ method: 'GET', url: '/api/admin/libraries', headers: auth })).json();
      const row = list.content.find((l: any) => l.id === OUTER);
      assert.equal(row.name, 'Grown-ups');
      assert.equal(row.age_rating, 18, 'the UI cannot show a rating it is not sent');
      assert.ok(Array.isArray(row.members), 'nor who can see it');
    });
  } finally {
    await app.close();
    await cleanup(q);
  }
});
