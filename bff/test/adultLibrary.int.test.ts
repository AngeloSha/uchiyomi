// A library rated 18+ stays off every browsing surface until it is asked for.
//
// This is a SURFACING filter and not a permission — `max_age_rating` is the permission and has its own
// tests. The rule here is narrower and the owner chose it deliberately: scope is the LIBRARY's own
// `age_rating`, not a series override, and the reveal lasts one browser session.
//
// The test is written as a sweep over every listing endpoint rather than a handful of spot checks, because
// "everywhere" is a completeness claim and the way it fails is that somebody adds a thirteenth rail. A leak
// through `/api/updates` is exactly as bad as one through the library grid, and much easier to miss.
//
// The other half is just as important: hiding must not become an access control. The reader, the chapter
// list, page bytes, the offline manifest, next/previous and reading-progress writes all have to keep
// working while the library is hidden, because the browser session that hides it cannot reach a service
// worker flushing progress with the app closed, an <img> tag, or an OPDS client.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
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

const ADULT_LIB = 'lib_ad_test';
const CLEAN_LIB = 'lib_cl_test';
const ADULT_SERIES = 's_adult_one';
const CLEAN_SERIES = 's_clean_one';
const ADULT_BOOK = 'b_adult_one';
const CLEAN_BOOK = 'b_clean_one';
const ADULT_TITLE = 'Zzz Adult Only Title';
const CLEAN_TITLE = 'Zzz Clean Title';
const USERS = ['al-user', 'al-admin'];

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const catalogRoutes = (await import('../src/routes/catalog')).default;
  const personalRoutes = (await import('../src/routes/personal')).default;
  const downloadRoutes = (await import('../src/routes/downloads')).default;
  const opdsRoutes = (await import('../src/routes/opds')).default;

  await migrate();
  await q('DELETE FROM lib_books WHERE id = ANY($1)', [[ADULT_BOOK, CLEAN_BOOK]]);
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[ADULT_SERIES, CLEAN_SERIES]]);
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[ADULT_LIB, CLEAN_LIB]]);
  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]);

  await q(`INSERT INTO libraries (id, name, path, age_rating) VALUES ($1,'Adult Shelf','/adult',18)`, [ADULT_LIB]);
  await q(`INSERT INTO libraries (id, name, path, age_rating) VALUES ($1,'Clean Shelf','/clean',NULL)`, [CLEAN_LIB]);

  // Both carry a shared genre, and the adult one carries a genre of its own. The shared one keeps the
  // browse-by-genre case honest; the exclusive one makes the genre list a real assertion, because a genre
  // NAME is itself a disclosure -- "this library contains something tagged Hentai" is the leak even when no
  // title is shown.
  for (const [sid, bid, title, lib, genres] of [
    [ADULT_SERIES, ADULT_BOOK, ADULT_TITLE, ADULT_LIB, `ARRAY['Zzztestgenre','Zzzadultgenre']`],
    [CLEAN_SERIES, CLEAN_BOOK, CLEAN_TITLE, CLEAN_LIB, `ARRAY['Zzztestgenre']`],
  ] as const) {
    await q(
      `INSERT INTO lib_series (id, source, title, folder, books_count, library_id, genres, latest_mtime, created_at)
       VALUES ($1,'T!al',$2,$3,1,$4,${genres}, 1, now())`,
      [sid, title, `T!al/${sid}`, lib],
    );
    await q(
      `INSERT INTO lib_books (id, series_id, source, file, number, title, mtime)
       VALUES ($1,$2,'T!al',$3,1,'Chapter 1',1)`,
      [bid, sid, `T!al/${sid}/ch1.cbz`],
    );
  }

  const mk = async (username: string, role: string) =>
    (await q<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
       VALUES ($1,$1,'x',$2,'password') RETURNING id`, [username, role],
    ))[0].id;
  const uid = await mk('al-user', 'user');
  const admin = await mk('al-admin', 'admin');

  // The reader has both series favourited, in a collection, bookmarked, and in their reading history, so
  // every id-gathering surface has something to leak.
  for (const sid of [ADULT_SERIES, CLEAN_SERIES]) {
    await q('INSERT INTO favorites (user_id, series_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [uid, sid]);
  }
  const col = (await q<{ id: string }>(
    `INSERT INTO collections (user_id, name) VALUES ($1,'Zzz Test Collection') RETURNING id`, [uid],
  ))[0].id;
  for (const sid of [ADULT_SERIES, CLEAN_SERIES]) {
    await q('INSERT INTO collection_items (collection_id, series_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [col, sid]);
  }
  for (const [sid, bid] of [[ADULT_SERIES, ADULT_BOOK], [CLEAN_SERIES, CLEAN_BOOK]] as const) {
    await q(
      `INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at)
       VALUES ($1,$2,$3,1,false, now()) ON CONFLICT (user_id, book_id) DO UPDATE SET updated_at = now()`,
      [uid, bid, sid],
    );
    await q(
      `INSERT INTO reading_events (user_id, book_id, series_id, page, completed, created_at)
       VALUES ($1,$2,$3,1,true, now())`, [uid, bid, sid],
    );
    await q('INSERT INTO bookmarks (user_id, book_id, series_id, page) VALUES ($1,$2,$3,1) ON CONFLICT DO NOTHING',
      [uid, bid, sid]);
  }

  // /api/updates only reports favourites with chapters newer than the recorded baseline, and inserts the
  // baseline itself on first sight. Seeding it at zero is what makes both series show up as having one new
  // chapter, so the sweep has something to find there.
  for (const sid of [ADULT_SERIES, CLEAN_SERIES]) {
    await q(`INSERT INTO series_seen (user_id, series_id, seen_books_count) VALUES ($1,$2,0)
             ON CONFLICT (user_id, series_id) DO UPDATE SET seen_books_count = 0`, [uid, sid]);
  }

  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(catalogRoutes);
  await app.register(personalRoutes);
  await app.register(downloadRoutes);
  await app.register(opdsRoutes);
  await app.ready();

  const tok = (id: string, role = 'user') => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role })}` });

  // OPDS authenticates with HTTP Basic where the password is a per-user token, not the JWT.
  const { issueOpdsToken } = await import('../src/lib/auth');
  const t0 = await issueOpdsToken(uid);
  const opdsAuth = {
    authorization: 'Basic ' + Buffer.from(`al-user:${typeof t0 === 'string' ? t0 : (t0 as any).token}`).toString('base64'),
  };
  return { app, q, uid, admin, col, tok, opdsAuth };
}

/**
 * Every endpoint that can put a series in front of a browsing reader.
 *
 * `POST /api/series/search` is the library grid, the search page, browse-by-genre and the command palette
 * all at once; the rest each have their own surface. Several answer with ids rather than titles (the genre
 * mosaic, the offline planner), so the needle is "title OR id" and not just the title -- a cover id IS a
 * surfacing of the series, and checking only titles would have passed while the mosaic still rendered it.
 */
interface Listing { name: string; method: 'GET' | 'POST'; url: string; payload?: any; opds?: boolean }
const LISTINGS: Listing[] = [
  { name: 'library grid / search', method: 'POST', url: '/api/series/search', payload: { page: 0, size: 100 } },
  { name: 'search by title', method: 'POST', url: '/api/series/search', payload: { fullTextSearch: 'Zzz', size: 100 } },
  { name: 'search by genre', method: 'POST', url: '/api/series/search', payload: { condition: { genre: { operator: 'is', value: 'Zzztestgenre' } }, size: 100 } },
  { name: 'home', method: 'GET', url: '/api/home' },
  { name: 'featured', method: 'GET', url: '/api/featured' },
  { name: 'trending', method: 'GET', url: '/api/trending' },
  { name: 'genre overview', method: 'GET', url: '/api/genres/overview?covers=8' },
  { name: 'genre list', method: 'GET', url: '/api/genres' },
  { name: 'updates', method: 'GET', url: '/api/updates' },
  { name: 'favourites', method: 'GET', url: '/api/favorites' },
  { name: 'bookmarks', method: 'GET', url: '/api/bookmarks' },
  { name: 'history', method: 'GET', url: '/api/history?limit=100' },
  { name: 'wrapped', method: 'GET', url: '/api/wrapped' },
  { name: 'offline plan', method: 'GET', url: '/api/offline/plan' },
  { name: 'opds series feed', method: 'GET', url: '/opds/series', opds: true },
  { name: 'opds search', method: 'GET', url: '/opds/search?q=Zzz', opds: true },
];

/** With `?adult=1`, the same request. Query strings already present have to keep working. */
const reveal = (url: string) => `${url}${url.includes('?') ? '&' : '?'}adult=1`;

test('an 18+ library stays off browsing surfaces until it is revealed', { skip }, async (t) => {
  const { app, q, uid, admin, col, tok, opdsAuth } = await setup();
  const auth = tok(uid);

  const body = async (r: Listing, url = r.url, who: any = auth) =>
    (await app.inject({ method: r.method, url, headers: r.opds ? opdsAuth : who, payload: r.payload })).body;

  /** The genre list answers with names only, so it gets its own needle. */
  const needles = (r: Listing) => (r.name === 'genre list' ? ['Zzzadultgenre'] : [ADULT_TITLE, ADULT_SERIES]);
  const cleanNeedles = (r: Listing) => (r.name === 'genre list' ? ['Zzztestgenre'] : [CLEAN_TITLE, CLEAN_SERIES]);
  const has = (hay: string, needle: string[]) => needle.some((n) => hay.includes(n));

  try {
    await t.test('THE RULE: no listing shows an 18+ library without being asked', async () => {
      const all = [...LISTINGS, { name: 'collection', method: 'GET' as const, url: `/api/collections/${col}` }];
      const leaked: string[] = [];
      const emptied: string[] = [];
      for (const r of all) {
        const hidden = await body(r);
        if (has(hidden, needles(r))) leaked.push(r.name);
        // A filter that empties the page is not a filter.
        if (!has(hidden, cleanNeedles(r))) emptied.push(r.name);
      }
      assert.deepEqual(leaked, [], `these surfaced an 18+ library unasked: ${leaked.join(', ')}`);
      assert.deepEqual(emptied, [], `these lost the CLEAN series too, so the filter is too wide: ${emptied.join(', ')}`);
    });

    await t.test('…and every one of them shows it when it is asked for', async () => {
      // The other half of the claim. A filter nothing can turn off is a deletion, and an endpoint that
      // ignores the parameter would pass the test above for the wrong reason.
      const all = [...LISTINGS, { name: 'collection', method: 'GET' as const, url: `/api/collections/${col}` }];
      const stuck: string[] = [];
      for (const r of all) {
        if (r.opds) continue; // see the OPDS case below
        if (!has(await body(r, reveal(r.url)), needles(r))) stuck.push(r.name);
      }
      assert.deepEqual(stuck, [], `these stayed hidden even with ?adult=1: ${stuck.join(', ')}`);
    });

    await t.test('OPDS is hidden and STAYS hidden, because an OPDS reader has no button', async () => {
      // Panels and KOReader have no session and no way to pass the parameter, so the feeds get the default
      // and keep it. That is the right default for a surface nobody can filter. Downloading a chapter the
      // client already knows the id of still works -- that goes through visible(), not browsable().
      for (const r of LISTINGS.filter((x) => x.opds)) {
        assert.equal(has(await body(r, reveal(r.url)), needles(r)), false,
          `${r.name} let a query parameter defeat the default`);
        assert.equal(has(await body(r), cleanNeedles(r)), true, `${r.name} lost the clean series`);
      }
      // The download resolver, checked directly rather than over HTTP: the route also stats the file on
      // disk and this fixture has no bytes, so a 404 would not tell us which of the two failed.
      const { visibleBookFile, SYSTEM_CTX } = await import('../src/lib/visibility');
      const found = await visibleBookFile(ADULT_BOOK, { ...SYSTEM_CTX, hideAdultLibraries: true });
      assert.ok(found, 'hiding a library from the feed also stopped its chapters resolving for download');
    });

    await t.test('the recommendation pool is filtered, and its cache is not shared between the two', async () => {
      // Driven as the ADMIN, who has no favourites and no reading history: /api/foryou excludes anything
      // already favourited or finished, so the reader's pool is empty by construction and would pass this
      // for the wrong reason. The admin also has no pool cached yet, which is the point of the third call.
      const who = tok(admin, 'admin');
      const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: who })).body;

      const hidden = await get('/api/foryou');
      assert.equal(hidden.includes(CLEAN_TITLE), true, 'the recommendations rail was empty, so this proves nothing');
      assert.equal(hidden.includes(ADULT_TITLE), false, 'the recommendations rail surfaced an 18+ library');

      assert.equal((await get('/api/foryou?adult=1')).includes(ADULT_TITLE), true,
        'the recommendations rail could not be revealed');

      // …and back again. The pool is cached for ten minutes, keyed by user; keyed ONLY by user, this is
      // exactly where a revealed pool gets handed back after the reveal is turned off.
      assert.equal((await get('/api/foryou')).includes(ADULT_TITLE), false,
        'the cached revealed pool was replayed after hiding');
    });

    await t.test('an admin is not exempt: this is a tidy screen, not a permission', async () => {
      const r = { method: 'POST' as const, url: '/api/series/search', payload: { page: 0, size: 100 } };
      assert.equal((await body(r, r.url, tok(admin, 'admin'))).includes(ADULT_TITLE), false,
        'the admin was shown the 18+ library by default');
      assert.equal((await body(r, reveal(r.url), tok(admin, 'admin'))).includes(ADULT_TITLE), true);
    });

    await t.test('the count agrees with the page it counted', async () => {
      // totalElements and content are two queries. If only one carries the filter, infinite scroll stops
      // early or spins forever on a page that never arrives.
      const r = await app.inject({ method: 'POST', url: '/api/series/search', headers: auth, payload: { page: 0, size: 100 } });
      const j = r.json();
      assert.equal(j.content.length, j.totalElements, `content ${j.content.length} vs totalElements ${j.totalElements}`);
    });

    await t.test('the library list drops the 18+ shelf for a capped account and flags it for everyone else', async () => {
      const seen = async (who: any) => (await app.inject({ method: 'GET', url: '/api/libraries', headers: who })).json();
      const mine = await seen(auth);
      const adultRow = mine.find((l: any) => l.id === ADULT_LIB);
      assert.ok(adultRow, 'the 18+ library vanished from the list, so nothing can offer to reveal it');
      assert.equal(adultRow.adult, true, 'the client cannot tell which library is the adult one');
      assert.equal(mine.find((l: any) => l.id === CLEAN_LIB).adult, false);

      // An account that may never open it must not be told it exists. This list had no notion of the cap.
      await q('UPDATE users SET max_age_rating = 13 WHERE id = $1', [uid]);
      try {
        const capped = await seen(auth);
        assert.equal(capped.some((l: any) => l.id === ADULT_LIB), false,
          'a 13+ account was shown the name of a library it can never open');
        assert.equal(capped.some((l: any) => l.id === CLEAN_LIB), true);
      } finally {
        await q('UPDATE users SET max_age_rating = NULL WHERE id = $1', [uid]);
      }
    });

    await t.test('hiding is not an access control: reading keeps working', async () => {
      // Everything below runs WITHOUT ?adult=1, i.e. while the library is hidden. None of it can be gated
      // on a browser session: the service worker flushes progress with the app closed, an <img> carries no
      // parameter, and an OPDS reader has no button.
      const cases: Array<[string, () => Promise<number>]> = [
        ['the series page', async () => (await app.inject({ method: 'GET', url: `/api/series/${ADULT_SERIES}`, headers: auth })).statusCode],
        ['its chapter list', async () => (await app.inject({ method: 'GET', url: `/api/series/${ADULT_SERIES}/books`, headers: auth })).statusCode],
        ['the chapter', async () => (await app.inject({ method: 'GET', url: `/api/books/${ADULT_BOOK}`, headers: auth })).statusCode],
        ['its page list', async () => (await app.inject({ method: 'GET', url: `/api/books/${ADULT_BOOK}/pages`, headers: auth })).statusCode],
        ['the offline manifest', async () => (await app.inject({ method: 'GET', url: `/api/books/${ADULT_BOOK}/download-manifest`, headers: auth })).statusCode],
        ['a progress write', async () => (await app.inject({
          method: 'PUT', url: `/api/books/${ADULT_BOOK}/progress`, headers: auth, payload: { page: 2, completed: false },
        })).statusCode],
      ];
      const broken: string[] = [];
      for (const [what, run] of cases) {
        const code = await run();
        if (code >= 400) broken.push(`${what} -> ${code}`);
      }
      assert.deepEqual(broken, [], `hiding broke these, which would lose reading progress or 404 a bookmark: ${broken.join(', ')}`);
    });

    await t.test('a series rated below 18 inside an 18+ library is still hidden', async () => {
      // Scope is the LIBRARY's rating, by the owner's choice. This is the opposite of how the age CAP
      // works, where a series rating beats the library it sits in, and the two rules coexist on purpose.
      await q(
        `INSERT INTO series_overrides (series_id, age_rating) VALUES ($1, 6)
         ON CONFLICT (series_id) DO UPDATE SET age_rating = 6`, [ADULT_SERIES]);
      try {
        const r = { method: 'POST' as const, url: '/api/series/search', payload: { page: 0, size: 100 } };
        assert.equal((await body(r)).includes(ADULT_TITLE), false,
          'rating the series 6 let it out of the 18+ library it lives in');
      } finally {
        await q('DELETE FROM series_overrides WHERE series_id = $1', [ADULT_SERIES]);
      }
    });
  } finally {
    await app.close();
    await q('DELETE FROM series_seen WHERE user_id = $1', [uid]).catch(() => {});
    await q('DELETE FROM bookmarks WHERE user_id = $1', [uid]).catch(() => {});
    await q('DELETE FROM reading_events WHERE user_id = $1', [uid]).catch(() => {});
    await q('DELETE FROM read_progress WHERE user_id = $1', [uid]).catch(() => {});
    await q('DELETE FROM collection_items WHERE collection_id = $1', [col]).catch(() => {});
    await q('DELETE FROM collections WHERE id = $1', [col]).catch(() => {});
    await q('DELETE FROM favorites WHERE user_id = $1', [uid]).catch(() => {});
    await q('DELETE FROM lib_books WHERE id = ANY($1)', [[ADULT_BOOK, CLEAN_BOOK]]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [[ADULT_SERIES, CLEAN_SERIES]]).catch(() => {});
    await q('DELETE FROM libraries WHERE id = ANY($1)', [[ADULT_LIB, CLEAN_LIB]]).catch(() => {});
    await q('DELETE FROM users WHERE username = ANY($1)', [USERS]).catch(() => {});
  }
});
