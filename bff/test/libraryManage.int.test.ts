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
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
// A real library root, for the folder browser's counts: two folders whose names differ by one character.
const LM_ROOT = mkdtempSync(join(tmpdir(), 'yomi-libmanage-'));
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LIBRARY_ROOT = LM_ROOT;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// Minted by POST /api/admin/libraries (lib_<hex>), as every library is: the outer one, and the inner one, which a
// subtest deletes and a later one declares again. MADE is every id the file declared, for cleanup.
let OUTER = '';
let INNER = '';
const MADE: string[] = [];
/** The folders this file declares libraries on: one a crashed run left holding any of them is taken away first. */
const LM_PATHS = ['Manga', 'Manga/Seinen', 'Manga/Shounen', 'Manga/Josei', 'Manga/Seinen/Plain', 'Elsewhere', 'Lm Other/Place',
  'Lm_Wild', 'Lm%', 'Lm Thief', 'Lm Twice', 'Lm Nope'];
/** Where every one of SERIES is, by id. */
const placesOf = async (q: any): Promise<Record<string, string>> => Object.fromEntries(
  (await q('SELECT id, library_id FROM lib_series WHERE id = ANY($1)', [SERIES])).map((r: any) => [r.id, r.library_id]));
/** The series whose library differs between two placesOf. */
const movedBetween = (a: Record<string, string>, b: Record<string, string>) => Object.keys(b).filter((id) => a[id] !== b[id]).sort();
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
  await q(`DELETE FROM libraries WHERE id <> 'lib' AND (path = ANY($1)
             OR id IN (SELECT library_id FROM library_paths WHERE path = ANY($1)))`, [LM_PATHS]).catch(() => {});
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

  /** Declare a library through the route, as the dialog does, and answer the id it minted. */
  const declare = async (name: string, path: string): Promise<string> => {
    const r = await app.inject({ method: 'POST', url: '/api/admin/libraries', headers: auth, payload: { name, path } });
    assert.equal(r.statusCode, 200, `declaring ${path}: ${r.body}`);
    MADE.push(r.json().id);
    return r.json().id;
  };

  return { q, free, bound, app, auth, declare };
}

async function cleanup(q: any) {
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [SERIES]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [MADE]).catch(() => {});
  await q(`DELETE FROM users WHERE username LIKE 'lm-%'`).catch(() => {});
}

const libOf = async (q: any, id: string) =>
  (await q<{ library_id: string }>('SELECT library_id FROM lib_series WHERE id = $1', [id]))[0].library_id;

test('library management', { skip }, async (t) => {
  const { q, free, bound, app, auth, declare } = await setup();
  const { content } = await import('../src/lib/backend');
  const { libraryIdFor } = await import('../src/lib/library');

  try {
    await t.test('NESTING: the most specific library wins', async () => {
      const libs = [{ id: 'lib', path: '' }, { id: 'outer', path: 'Manga' }, { id: 'inner', path: 'Manga/Seinen' }];
      assert.equal(libraryIdFor('Manga/Shounen/Alpha', libs), 'outer', 'only the outer contains it');
      assert.equal(libraryIdFor('Manga/Seinen/Beta', libs), 'inner', 'both contain it; the deeper one wins');
      assert.equal(libraryIdFor('Elsewhere/Gamma', libs), 'lib', 'neither contains it');
      assert.equal(libraryIdFor('Manga', libs), 'outer', 'the library folder itself belongs to it');
    });

    // Through the route from here on. These used to run a copy of the handler's claim SQL, so changing the handler
    // could not fail them.
    await t.test('creating a nested library takes only from less specific ones', async () => {
      OUTER = await declare('Outer', 'Manga');
      assert.equal(await libOf(q, 's_lm_a'), OUTER);
      assert.equal(await libOf(q, 's_lm_b'), OUTER);
      assert.equal(await libOf(q, 's_lm_c'), 'lib', 'a series outside the path must not be claimed');

      INNER = await declare('Inner', 'Manga/Seinen');
      assert.equal(await libOf(q, 's_lm_b'), INNER, 'the inner library should have taken it from the outer');
      assert.equal(await libOf(q, 's_lm_a'), OUTER, 'and left the rest of the outer alone');
    });

    await t.test('THE PIN: a hand-moved series is not taken back', async () => {
      // Gamma lives at Elsewhere/, but an admin filed it under the inner library on purpose.
      await q('UPDATE lib_series SET library_id = $2, library_pinned = true WHERE id = $1', ['s_lm_c', INNER]);

      // A library is created whose path contains a pinned series -> must not claim it.
      await q('UPDATE lib_series SET library_id = $2, library_pinned = true WHERE id = $1', ['s_lm_a', INNER]);
      const shounen = await declare('Shounen', 'Manga/Shounen');
      assert.equal(await libOf(q, 's_lm_a'), INNER,
        'a pinned series was taken back by the folder rule, so the hand-move silently undid itself');
      // Nor does re-pathing the library whose folder holds it.
      const r = await app.inject({ method: 'PATCH', url: `/api/admin/libraries/${OUTER}`, headers: auth, payload: { path: 'Manga' } });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(await libOf(q, 's_lm_a'), INNER, 'saving the outer library took a pinned series back');
      const del = await app.inject({ method: 'DELETE', url: `/api/admin/libraries/${shounen}`, headers: auth });
      assert.equal(del.statusCode, 200, del.body);
      assert.equal(await libOf(q, 's_lm_a'), INNER, 'removing a library moved a series pinned elsewhere');

      // And a rescan must not recompute it either.
      const libs = [{ id: 'lib', path: '' }, { id: OUTER, path: 'Manga' }, { id: INNER, path: 'Manga/Seinen' }];
      assert.equal(libraryIdFor(FOLDERS.s_lm_a, libs), OUTER,
        'the folder rule still says OUTER, which is exactly why the pin has to be checked separately');

      await q('UPDATE lib_series SET library_id = $2, library_pinned = false WHERE id = $1', ['s_lm_a', OUTER]);
    });

    await t.test('deleting a nested library returns its series to the ENCLOSING one', async () => {
      assert.equal(await libOf(q, 's_lm_b'), INNER);
      const r = await app.inject({ method: 'DELETE', url: `/api/admin/libraries/${INNER}`, headers: auth });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(await libOf(q, 's_lm_b'), OUTER,
        'sending it to the default would tear a nested library out of its parent on delete');
      assert.equal(await libOf(q, 's_lm_c'), 'lib', 'and a series outside every path goes to the default');
      assert.equal((await q('SELECT 1 FROM libraries WHERE id = $1', [INNER])).length, 0, 'the library is gone');
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
      INNER = await declare('Inner', 'Manga/Seinen');
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
      // The preview is the only thing anyone reads before committing, so it has to run the SAME statement as
      // the handler (lib/libraryFolders.ts). Its first version asked for `library_id = 'lib'`, which was right when
      // libraries could not nest and reported 0 for a nested library whose series the enclosing one already holds.
      const gone = await app.inject({ method: 'DELETE', url: `/api/admin/libraries/${INNER}`, headers: auth });
      assert.equal(gone.statusCode, 200, gone.body);
      await q(`UPDATE lib_series SET library_pinned = false, library_id = $2 WHERE id = ANY($1)`, [SERIES, OUTER]);
      const preview = async (query: string) =>
        (await app.inject({ method: 'GET', url: `/api/admin/libraries/preview?${query}`, headers: auth })).json();

      // A pinned series is never promised, because the handler will not take it.
      await q('UPDATE lib_series SET library_pinned = true WHERE id = $1', ['s_lm_b']);
      assert.equal((await preview('path=' + encodeURIComponent('Manga/Seinen'))).series, 0,
        'the preview counted a series the handler would leave alone');
      await q('UPDATE lib_series SET library_pinned = false WHERE id = $1', ['s_lm_b']);

      const pv = await preview('path=' + encodeURIComponent('Manga/Seinen'));
      assert.equal(pv.series, 1, 'a nested library reported 0 because the preview only looked at the default library');
      assert.deepEqual(pv.sample, ['s_lm_b']);
      // And the create moves exactly that. Reintroduce a predicate of the preview's own (the old `library_id = 'lib'`):
      // it promises 0 here while the create moves Beta.
      let before = await placesOf(q);
      INNER = await declare('Inner', 'Manga/Seinen');
      assert.deepEqual(movedBetween(before, await placesOf(q)), ['s_lm_b'], 'the create moved something the preview did not promise');

      // An edit, both ways at once: the inner library moving from Manga/Seinen to Manga/Shounen gives Beta back to the
      // outer one and takes Alpha from it. Reintroduce the claim alone (no release): Beta stays, and both counts drop.
      const edit = await preview(`id=${INNER}&path=` + encodeURIComponent('Manga/Shounen'));
      assert.deepEqual([edit.series, edit.sample], [2, ['s_lm_a', 's_lm_b']], 'the preview of an edit is not what leaves and what comes');
      before = await placesOf(q);
      const r = await app.inject({ method: 'PATCH', url: `/api/admin/libraries/${INNER}`, headers: auth, payload: { path: 'Manga/Shounen' } });
      assert.equal(r.statusCode, 200, r.body);
      const after = await placesOf(q);
      assert.deepEqual(movedBetween(before, after), ['s_lm_a', 's_lm_b'], 'the edit moved something other than what the preview promised');
      assert.equal(r.json().moved, 2);
      assert.deepEqual([after.s_lm_a, after.s_lm_b], [INNER, OUTER], 'Alpha came in and Beta went back to the enclosing library');
      // And back, for what follows.
      const back = await app.inject({ method: 'PATCH', url: `/api/admin/libraries/${INNER}`, headers: auth, payload: { path: 'Manga/Seinen' } });
      assert.equal(back.json().moved, 2, back.body);
      assert.deepEqual([await libOf(q, 's_lm_a'), await libOf(q, 's_lm_b')], [OUTER, INNER]);
    });

    await t.test('a folder name with _ or % in it is a name, not a pattern', async () => {
      // The claim used `LIKE path || '/%'`, so a library on Lm_Wild also took LmXWild/Zeta (`_` is any one character)
      // and one on Lm% took everything under any folder starting Lm. Reintroduce the LIKE in underSql: Zeta moves.
      await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES
                 ('s_lm_zeta','T!lm','s_lm_zeta','LmXWild/Zeta',1), ('s_lm_eta','T!lm','s_lm_eta','Lm_Wild/Eta',1)`);
      try {
        const wild = await declare('Wild', 'Lm_Wild');
        const any = await declare('Any', 'Lm%');
        assert.equal(await libOf(q, 's_lm_eta'), wild, 'a series really under Lm_Wild was not claimed');
        assert.equal(await libOf(q, 's_lm_zeta'), 'lib', 'LmXWild/Zeta was claimed by a library on Lm_Wild or Lm%');
        // The folder browser counts the same way. Reintroduce the LIKE in its count: Lm_Wild counts 2.
        mkdirSync(join(LM_ROOT, 'Lm_Wild'), { recursive: true });
        mkdirSync(join(LM_ROOT, 'LmXWild'), { recursive: true });
        const root = (await app.inject({ method: 'GET', url: '/api/admin/libraries/folders', headers: auth })).json();
        assert.deepEqual(root.folders.filter((f: any) => f.name.startsWith('Lm')).map((f: any) => [f.name, f.series]),
          [['Lm_Wild', 1], ['LmXWild', 1]], 'a folder counted series under another folder its name matches as a pattern');
        for (const l of [wild, any]) {
          const r = await app.inject({ method: 'DELETE', url: `/api/admin/libraries/${l}`, headers: auth });
          assert.equal(r.statusCode, 200, r.body);
        }
        assert.equal(await libOf(q, 's_lm_eta'), 'lib', 'removing the library did not release its series');
      } finally {
        await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [['s_lm_zeta', 's_lm_eta']]);
      }
    });

    await t.test('browsing folders refuses to leave the root, and 404s a path that is not there', async () => {
      const get = (p: string) => app.inject({
        method: 'GET', url: '/api/admin/libraries/folders?path=' + encodeURIComponent(p), headers: auth });

      assert.equal((await get('../../etc')).statusCode, 400, 'a traversal must not be answered');
      assert.equal((await get('definitely/not/a/real/folder')).statusCode, 404,
        'a typo must be told apart from a real but empty folder');
      // CodeQL #34: the query's trailing slashes were trimmed with /\/+$/, which starts again from every slash of a
      // run that does not end the string -- one request held the server for half a minute. Reintroduce it in the route:
      // "a long run of slashes holds the request" fails.
      const t0 = Date.now();
      assert.equal((await get(`x${'/'.repeat(200_000)}y`)).statusCode, 404);
      assert.ok(Date.now() - t0 < 5000, 'a long run of slashes holds the request');

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
        payload: { name: 'Grown-ups only', path: 'Manga/Josei', ageRating: 18, anilistLookup: false },
      });
      assert.equal(r.statusCode, 200);
      const made = r.json().id;
      const row = (await q<{ age_rating: number | null; anilist_lookup: boolean }>(
        'SELECT age_rating, anilist_lookup FROM libraries WHERE id = $1', [made]))[0];
      assert.equal(row.age_rating, 18, 'the rating was accepted and then dropped on the floor');
      assert.equal(row.anilist_lookup, false, 'the create route dropped the AniList privacy choice');

      // And omitting it still means unrated, rather than 0 (which would be a real cap).
      const plain = await app.inject({
        method: 'POST', url: '/api/admin/libraries', headers: auth,
        payload: { name: 'Everything else', path: 'Manga/Seinen/Plain' },
      });
      assert.equal(plain.statusCode, 200);
      assert.equal((await q<{ age_rating: number | null }>(
        'SELECT age_rating FROM libraries WHERE id = $1', [plain.json().id]))[0].age_rating, null);
      assert.equal((await q<{ anilist_lookup: boolean }>(
        'SELECT anilist_lookup FROM libraries WHERE id = $1', [plain.json().id]))[0].anilist_lookup, true,
        'omitting the switch did not preserve the compatible on-by-default behaviour');

      await q('DELETE FROM libraries WHERE id = ANY($1)', [[made, plain.json().id]]).catch(() => {});
    });

    await t.test('a library carries its rating and its member list back out', async () => {
      await app.inject({
        method: 'PATCH', url: `/api/admin/libraries/${OUTER}`, headers: auth,
        payload: { ageRating: 18, name: 'Grown-ups', anilistLookup: false },
      });
      const list = (await app.inject({ method: 'GET', url: '/api/admin/libraries', headers: auth })).json();
      const row = list.content.find((l: any) => l.id === OUTER);
      assert.equal(row.name, 'Grown-ups');
      assert.equal(row.age_rating, 18, 'the UI cannot show a rating it is not sent');
      assert.equal(row.anilist_lookup, false, 'the UI cannot show the AniList privacy choice it is not sent');
      assert.ok(Array.isArray(row.members), 'nor who can see it');

      const { automaticAniListAllowed } = await import('../src/lib/anilistPolicy');
      assert.equal(await automaticAniListAllowed({ id: 's_lm_a' }), false,
        'automatic enrichment did not follow the series current library');
      const on = await app.inject({ method: 'PATCH', url: `/api/admin/libraries/${OUTER}`, headers: auth,
        payload: { anilistLookup: true } });
      assert.equal(on.statusCode, 200, on.body);
      assert.equal(await automaticAniListAllowed({ id: 's_lm_a' }), true, 're-enabling did not take effect immediately');
      const bad = await app.inject({ method: 'PATCH', url: `/api/admin/libraries/${OUTER}`, headers: auth,
        payload: { anilistLookup: 'sometimes' } });
      assert.equal(bad.statusCode, 400, 'a non-boolean privacy setting was accepted');
    });
  } finally {
    await app.close();
    await cleanup(q);
  }
});

after(() => rmSync(LM_ROOT, { recursive: true, force: true }));

test('unpinning files a series by every folder a library holds (#148)', { skip }, async () => {
  // Automatic again means the folder rule decides, and the rule reads every folder a library holds -- not only the
  // first, which is all libraries.path keeps. Reintroduce by reading `SELECT id, path FROM libraries` in the single
  // route: Gamma goes to the default library; in the bulk route: Beta does.
  const { q, app, auth } = await setup();
  try {
    // Its first folder holds nothing; the series are under its second and third.
    const made = await app.inject({ method: 'POST', url: '/api/admin/libraries', headers: auth,
      payload: { name: 'Two', paths: ['Lm Other/Place', 'Elsewhere', 'Manga/Seinen'] } });
    assert.equal(made.statusCode, 200, made.body);
    const TWO = made.json().id;
    MADE.push(TWO);
    await q('UPDATE lib_series SET library_id = $2, library_pinned = true WHERE id = ANY($1)', [SERIES, 'lib']);

    const one = await app.inject({ method: 'POST', url: '/api/admin/series/s_lm_c/library', headers: auth, payload: { libraryId: null } });
    assert.equal(one.statusCode, 200, one.body);
    assert.equal(await libOf(q, 's_lm_c'), TWO, 'Elsewhere/Gamma is under the library\'s second folder');

    const bulk = await app.inject({ method: 'POST', url: '/api/admin/series/library', headers: auth,
      payload: { seriesIds: ['s_lm_a', 's_lm_b'], libraryId: null } });
    assert.equal(bulk.statusCode, 200, bulk.body);
    assert.equal(await libOf(q, 's_lm_b'), TWO, 'Manga/Seinen/Beta is under the library\'s third folder');
    assert.equal(await libOf(q, 's_lm_a'), 'lib', 'Manga/Shounen/Alpha is under none of its folders');
  } finally {
    await app.close();
    await cleanup(q);
  }
});

test('several folders per library (#148)', { skip }, async (t) => {
  // @Kedryn: "i want 'Uchiyomi manga' to have all those listed folders BUT '18 porn comics' and 'comix'". A library
  // holds a list of folders; adding one moves its series in, removing one moves them back out to whichever library
  // holds them now, and a series filed by hand stays where it was filed. Alpha is under Manga/Shounen, Beta under
  // Manga/Seinen, Gamma under Elsewhere.
  const { q, app, auth } = await setup();
  const { libraryIdFor } = await import('../src/lib/library');
  const send = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
  const preview = async (id: string, paths: string[]) => (await app.inject({ method: 'GET', headers: auth,
    url: `/api/admin/libraries/preview?id=${id}&` + paths.map((p) => 'paths=' + encodeURIComponent(p)).join('&') }));
  const listed = async (id: string) => (await app.inject({ method: 'GET', url: '/api/admin/libraries', headers: auth }))
    .json().content.find((l: any) => l.id === id);
  let PICKS = '';
  let NESTED = '';
  try {
    await t.test('a library declared on two folders holds the series of both', async () => {
      const r = await send('POST', '/api/admin/libraries', { name: 'Nested', paths: ['Manga'] });
      assert.equal(r.statusCode, 200, r.body);
      NESTED = r.json().id;
      MADE.push(NESTED);
      const p = await send('POST', '/api/admin/libraries', { name: 'Picks', paths: ['Manga/Shounen', 'Lm Other/Place'] });
      assert.equal(p.statusCode, 200, p.body);
      PICKS = p.json().id;
      MADE.push(PICKS);
      assert.deepEqual(await placesOf(q), { s_lm_a: PICKS, s_lm_b: NESTED, s_lm_c: 'lib' });
      const row = await listed(PICKS);
      // Reintroduce by answering libraries.path alone: no `paths`, and the dialog cannot show the second folder.
      assert.deepEqual([row.path, row.paths], ['Manga/Shounen', ['Manga/Shounen', 'Lm Other/Place']], 'GET does not carry every folder, first first');
    });

    await t.test('adding folders moves their series in, and leaves a series filed by hand where it was filed', async () => {
      const pin = await send('POST', '/api/admin/series/s_lm_c/library', { libraryId: 'lib' });
      assert.equal(pin.statusCode, 200, pin.body);
      const want = ['Manga/Shounen', 'Lm Other/Place', 'Manga/Seinen', 'Elsewhere'];
      const pv = await preview(PICKS, want);
      assert.equal(pv.statusCode, 200, pv.body);
      // Reintroduce by previewing the first folder only: the preview promises nothing for Beta.
      assert.deepEqual([pv.json().series, pv.json().sample], [1, ['s_lm_b']], 'the preview does not sum every folder');
      const before = await placesOf(q);
      const r = await send('PATCH', `/api/admin/libraries/${PICKS}`, { paths: want });
      assert.equal(r.statusCode, 200, r.body);
      const after = await placesOf(q);
      assert.deepEqual(movedBetween(before, after), ['s_lm_b'], 'the save moved something other than what the preview promised');
      assert.equal(r.json().moved, 1);
      assert.equal(after.s_lm_c, 'lib', 'a series filed by hand was taken by a folder added to another library');
      assert.deepEqual((await listed(PICKS)).paths, ['Manga/Shounen', 'Elsewhere', 'Lm Other/Place', 'Manga/Seinen']);
    });

    await t.test('ROLLBACK: libraries.path stays the first folder, which is what v0.55.0 files by', async () => {
      // v0.55.0 reads libraries.path and nothing else (lib/library.ts at v0.55.0: `SELECT id, path FROM libraries`).
      // Reintroduce by writing the last folder there in setFolders: v0.55.0 would file a new Manga/Shounen series
      // into the nested library.
      const [row] = await q<{ path: string }>('SELECT path FROM libraries WHERE id = $1', [PICKS]);
      assert.equal(row.path, 'Manga/Shounen', 'libraries.path is not the first folder');
      const v0550 = await q<{ id: string; path: string }>('SELECT id, path FROM libraries ORDER BY length(path) DESC');
      assert.equal(libraryIdFor('Manga/Shounen/New Title', v0550), PICKS, 'v0.55.0 would not file a new folder by the first one');
    });

    await t.test('removing a folder moves its series back out, to the library that holds them now', async () => {
      const want = ['Lm Other/Place', 'Manga/Seinen', 'Elsewhere'];
      const pv = await preview(PICKS, want);
      assert.deepEqual([pv.json().series, pv.json().sample], [1, ['s_lm_a']], pv.body);
      const r = await send('PATCH', `/api/admin/libraries/${PICKS}`, { paths: want });
      assert.equal(r.statusCode, 200, r.body);
      // Not to the default: the nested library holds Manga, and Manga/Shounen/Alpha is in it.
      assert.deepEqual(await placesOf(q), { s_lm_a: NESTED, s_lm_b: PICKS, s_lm_c: 'lib' });
      assert.equal((await q<{ path: string }>('SELECT path FROM libraries WHERE id = $1', [PICKS]))[0].path, 'Lm Other/Place',
        'the first folder went and libraries.path still names it');
    });

    await t.test('a folder another library holds is refused, by name, and nothing is saved', async () => {
      // Reintroduce by checking libraries.path alone (v0.55.0's duplicate check): Manga/Seinen, a second folder of
      // Picks, is not seen as held, and the save dies on library_paths' key with a 500 that names nobody.
      const r = await send('POST', '/api/admin/libraries', { name: 'Thief', paths: ['Lm Thief', 'Manga/Seinen'] });
      assert.equal(r.statusCode, 409, r.body);
      assert.deepEqual([r.json().error, r.json().path, r.json().library?.id], ['duplicate', 'Manga/Seinen', PICKS], r.body);
      assert.match(r.json().message, /"Picks" already covers Manga\/Seinen/);
      assert.equal((await q(`SELECT 1 FROM libraries WHERE name = 'Thief'`)).length, 0, 'the refused library was created');
      // An edit too, and its name is not half-saved.
      const e = await send('PATCH', `/api/admin/libraries/${NESTED}`, { name: 'Renamed', paths: ['Manga', 'Elsewhere'] });
      assert.equal(e.statusCode, 409, e.body);
      assert.equal(e.json().library?.name, 'Picks');
      assert.equal((await listed(NESTED)).name, 'Nested', 'a refused save renamed the library');
      assert.deepEqual((await listed(NESTED)).paths, ['Manga']);
      // And the preview refuses it as the save would, rather than guessing between two libraries on one folder.
      assert.equal((await preview(NESTED, ['Manga', 'Elsewhere'])).statusCode, 409);
    });

    await t.test('every folder is checked as `path` always was, and `path` alone is still one folder', async () => {
      for (const paths of [['Manga', '../etc'], ['Manga', ' /etc'], []]) {
        const r = await send('PATCH', `/api/admin/libraries/${NESTED}`, { paths });
        assert.equal(r.statusCode, 400, `${JSON.stringify(paths)}: ${r.body}`);
      }
      assert.equal((await send('PATCH', `/api/admin/libraries/${NESTED}`, { paths: ['x'.repeat(301)] })).statusCode, 400);
      assert.deepEqual((await listed(NESTED)).paths, ['Manga'], 'a refused folder list was half-saved');
      // The same folder twice, or with a trailing slash, is held once.
      const twice = await send('PATCH', `/api/admin/libraries/${NESTED}`, { paths: ['Manga', 'Manga/', 'Lm Twice'] });
      assert.equal(twice.statusCode, 200, twice.body);
      assert.deepEqual((await listed(NESTED)).paths, ['Manga', 'Lm Twice']);
      // `path` alone replaces the list with that one folder, as a v0.55.0 client means it.
      const one = await send('PATCH', `/api/admin/libraries/${PICKS}`, { path: 'Manga/Seinen' });
      assert.equal(one.statusCode, 200, one.body);
      assert.deepEqual((await listed(PICKS)).paths, ['Manga/Seinen']);
      assert.equal(await libOf(q, 's_lm_b'), PICKS);
      // An unknown library is a 404, not a folder list for nobody.
      assert.equal((await send('PATCH', '/api/admin/libraries/lib_nope', { paths: ['Lm Nope'] })).statusCode, 404);
    });

    await t.test('the folders on offer leave out every folder a library holds', async () => {
      // Reintroduce `taken` from libraries.path alone: Manga/Shounen, the nested library's second folder, is offered as
      // a folder to split out.
      const r = await send('PATCH', `/api/admin/libraries/${NESTED}`, { paths: ['Manga', 'Manga/Shounen'] });
      assert.equal(r.statusCode, 200, r.body);
      const { candidates } = (await app.inject({ method: 'GET', url: '/api/admin/libraries', headers: auth })).json();
      const offered = candidates.map((c: any) => c.path);
      assert.ok(!offered.includes('Manga/Shounen'), `a second folder of a library is offered: ${offered.join(', ')}`);
      assert.ok(!offered.includes('Manga'), 'a first folder is offered');
    });

    await t.test('removing a library releases its series to the libraries that hold them', async () => {
      // Gamma, under Elsewhere, is filed into the nested library by hand first.
      const pin = await send('POST', '/api/admin/series/s_lm_c/library', { libraryId: NESTED });
      assert.equal(pin.statusCode, 200, pin.body);
      const r = await send('DELETE', `/api/admin/libraries/${NESTED}`);
      assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual(await placesOf(q), { s_lm_a: 'lib', s_lm_b: PICKS, s_lm_c: 'lib' });
      assert.equal((await q('SELECT 1 FROM library_paths WHERE library_id = $1', [NESTED])).length, 0, 'its folders outlived it');
      // v0.55.1 integration: what it held by hand is filed by hand nowhere now. Reintroduce by moving it pinned
      // (applyMoves in lib/libraryFolders.ts setting the library alone): Gamma stays pinned in the default library, and
      // no library's folder can reach it again.
      const [gamma] = await q<{ library_pinned: boolean }>('SELECT library_pinned FROM lib_series WHERE id = $1', ['s_lm_c']);
      assert.equal(gamma.library_pinned, false, 'a series the removed library held by hand is still pinned');
      const take = await send('PATCH', `/api/admin/libraries/${PICKS}`, { paths: ['Manga/Seinen', 'Elsewhere'] });
      assert.equal(take.statusCode, 200, take.body);
      assert.equal(await libOf(q, 's_lm_c'), PICKS, 'and the library holding its folder takes it');
    });
  } finally {
    await app.close();
    await cleanup(q);
  }
});

// ---- Bulk hide (v0.37.0, the safe half of PR #53's bulk delete) ----
//
// The library page's select bar can remove a whole selection from the library. That MUST be the single
// DELETE /api/admin/series/:id once per id and nothing more: hide only, per-series audit, skips with reasons.
// Files are never touched here -- deleting them is the irreversible step behind the per-title typed confirm
// on Content → Library, and a bulk that did both would let "Select all" plus one tap wipe hand-curated
// folders with no undo.
const BH = ['s_bh_a', 's_bh_b', 's_bh_c', 's_bh_merged', 's_bh_hidden'] as const;

test('bulk hide', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const adminRoutes = (await import('../src/routes/admin')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();
  const wipe = async () => {
    await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [BH]).catch(() => {});
    await q('DELETE FROM series_trackers WHERE series_id = ANY($1)', [BH]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [BH]).catch(() => {});
    await q(`DELETE FROM audit_log WHERE event = 'series.delete' AND detail->>'id' = ANY($1)`, [BH]).catch(() => {});
    await q(`DELETE FROM users WHERE username LIKE 'bh-%'`).catch(() => {});
  };
  await wipe();
  // Real files under a real, writable root: deleteSeriesFiles refuses a series with nothing on disk, so
  // without these the "hide only" assertions below would pass against a route that deleted files too.
  const root = mkdtempSync(join(tmpdir(), 'yomi-bulkhide-'));
  for (const id of BH) {
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, 'ch1.cbz'), 'not really a zip');
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!bh','Title ' || $1,$1,1)`, [id]);
    await q(`INSERT INTO lib_books (id, series_id, source, root, file, number, title) VALUES ($1,$2,'T!bh',$3,$4,1,'Chapter 1')`, [`b_${id}`, id, root, `${id}/ch1.cbz`]);
  }
  await q('UPDATE lib_series SET merged_into = $2 WHERE id = $1', ['s_bh_merged', 's_bh_a']);
  await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', ['s_bh_hidden']);
  // A tracker link on one of them: deleteSeries drops it (it is what the duplicate check matches on), and
  // the bulk path must go through deleteSeries rather than flip deleted_at itself.
  await q(`INSERT INTO series_trackers (series_id, provider, external_id) VALUES ('s_bh_b','anilist','T!bh-1')`);
  const mk = async (name: string, role: string) => (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x',$2,'password') RETURNING id`, [name, role]))[0].id;
  const admin = await mk('bh-admin', 'admin');
  const member = await mk('bh-member', 'user');
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.ready();
  const as = (sub: string, role: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub, role })}` });
  const hide = (ids: string[], who = as(admin, 'admin')) =>
    app.inject({ method: 'POST', url: '/api/admin/series/bulk/hide', headers: who, payload: { ids } });

  try {
    await t.test('a member cannot hide anything', async () => {
      // Reintroduce by mounting the route outside the admin plugin (before its requireAdmin hook).
      const r = await hide(['s_bh_a'], as(member, 'user'));
      assert.equal(r.statusCode, 403);
      const rows = await q<{ deleted_at: string | null }>('SELECT deleted_at FROM lib_series WHERE id = $1', ['s_bh_a']);
      assert.equal(rows[0].deleted_at, null, 'a 403 must not have hidden it first');
    });

    await t.test('hides three, skips a merged one, a hidden one and an unknown one, each with its reason', async () => {
      // Reintroduce the skips by dropping the three `if (row...)` lines: the merged row is hidden under its
      // survivor's feet (the merge page can no longer find it), the already-hidden one is counted a second
      // time, and an unknown id is a 500 from deleteSeries instead of a reason. Reintroduce the "hide only"
      // rule by calling deleteSeriesFiles after deleteSeries: the lib_books rows below gain pruned_at.
      const r = await hide(['s_bh_a', 's_bh_b', 's_bh_c', 's_bh_merged', 's_bh_hidden', 's_bh_nope', 's_bh_b']);
      assert.equal(r.statusCode, 200, r.body);
      const body = r.json();
      assert.equal(body.ok, true);
      assert.equal(body.hidden, 3, 'three live series, hidden once each (s_bh_b is listed twice and counts once)');
      assert.deepEqual(body.skipped, [
        { id: 's_bh_merged', reason: 'merged' },
        { id: 's_bh_hidden', reason: 'already_hidden' },
        { id: 's_bh_nope', reason: 'not_found' },
      ], 'every series that was not hidden is named, with why');

      const rows = await q<{ id: string; deleted_at: string | null; merged_into: string | null }>(
        'SELECT id, deleted_at, merged_into FROM lib_series WHERE id = ANY($1) ORDER BY id', [BH]);
      const at = Object.fromEntries(rows.map((x) => [x.id, x.deleted_at !== null]));
      assert.deepEqual(at, { s_bh_a: true, s_bh_b: true, s_bh_c: true, s_bh_hidden: true, s_bh_merged: false },
        'the three live ones are hidden; the merged one is left as it was');
      assert.equal(rows.find((x) => x.id === 's_bh_merged')!.merged_into, 's_bh_a', 'the merge pointer survives');

      // Hide only: every chapter row is still a live, unpruned book.
      const books = await q<{ pruned_at: string | null }>('SELECT pruned_at FROM lib_books WHERE series_id = ANY($1)', [BH]);
      assert.equal(books.length, BH.length, 'no book row was deleted');
      assert.ok(books.every((b) => b.pruned_at === null), 'no book was pruned: a bulk remove never touches files');
      for (const id of BH) assert.ok(existsSync(join(root, id, 'ch1.cbz')), `${id}'s chapter file is gone: a bulk remove deleted files`);
      // ...and the tracker link went with the hide, as the single route's deleteSeries does.
      assert.equal((await q('SELECT 1 FROM series_trackers WHERE series_id = $1', ['s_bh_b'])).length, 0,
        'the bulk path bypassed deleteSeries and left the tracker link in place');
    });

    await t.test('one series.delete audit row per hidden series, carrying its title', async () => {
      // Reintroduce by logging once per batch with the id list (what PR #53 did): the audit page shows one
      // opaque line for 200 series and no title to search for.
      const rows = await q<{ detail: { id: string; title: string; books: number }; user_id: string }>(
        `SELECT detail, user_id FROM audit_log WHERE event = 'series.delete' AND detail->>'id' = ANY($1) ORDER BY detail->>'id'`, [BH]);
      assert.deepEqual(rows.map((x) => [x.detail.id, x.detail.title, x.detail.books]),
        [['s_bh_a', 'Title s_bh_a', 1], ['s_bh_b', 'Title s_bh_b', 1], ['s_bh_c', 'Title s_bh_c', 1]],
        'exactly the three hidden series, one row each, titled, no row for a skipped one');
      assert.ok(rows.every((x) => x.user_id === admin), 'attributed to the admin who did it');
    });

    await t.test('a second pass over the same selection hides nothing and says so', async () => {
      const r = await hide(['s_bh_a', 's_bh_b']);
      assert.equal(r.statusCode, 200);
      assert.equal(r.json().hidden, 0);
      assert.deepEqual(r.json().skipped.map((s: any) => s.reason), ['already_hidden', 'already_hidden']);
    });

    await t.test('an empty or oversized list is a bad request, not a server error', async () => {
      assert.equal((await hide([])).statusCode, 400);
      assert.equal((await hide(Array.from({ length: 501 }, (_, i) => `x${i}`))).statusCode, 400);
      assert.equal((await app.inject({ method: 'POST', url: '/api/admin/series/bulk/hide', headers: as(admin, 'admin'), payload: {} })).statusCode, 400);
    });
  } finally {
    await app.close();
    await wipe();
    rmSync(root, { recursive: true, force: true });
  }
});
