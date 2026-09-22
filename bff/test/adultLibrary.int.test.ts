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
// Since v0.42.0 (issue #64) the same rule covers Discover's SOURCES, not just the library's series. The
// chip used to hide 18+ libraries while Discover went on listing every adult provider and painting its
// newest covers -- on the reporting install twelve of fourteen enabled sources are NSFW, so "Show 18+" off
// left a clean library behind a wall of adult covers. The `surfaceable` half of the sweep below is that
// claim: the source list, its two walls, the per-source search, the cross-source search and `/find` all
// honour the chip, while `fill/scan`, `detail` and `add` deliberately do not -- a series whose own source
// is adult must stay fillable. Those listing tests assert on each fake source's own CALL COUNTER as well as
// on the body, because a source that is asked and answers nothing passes a body-only assertion for the
// wrong reason, and being asked at all is an outbound request to an adult site.
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

// ---------------------------------------------------------------- Discover's sources (v0.42.0, issue #64)
const CLEAN_SRC = 'al-src-clean';
const ADULT_SRC = 'al-src-adult';
/** A series in the CLEAN library whose own source is the adult one: the case fill/scan must keep serving. */
const FILL_SERIES = 's_fill_adultsrc';
const FILL_BOOKS = ['b_fill_one', 'b_fill_two', 'b_fill_three'];

/**
 * What each fake source was actually ASKED, not merely what it answered.
 *
 * ⚠️ The body alone proves nothing: a source that is asked and answers nothing is indistinguishable from
 * one that was never asked, so a body-only assertion would pass over a fix that does not exist. Being asked
 * is itself the thing being prevented — an outbound query to an adult site on behalf of someone who asked
 * not to see one, whose results then land in the shared search entry under that term.
 */
const asked: Record<string, { search: number; latest: number; popular: number }> = {
  [CLEAN_SRC]: { search: 0, latest: 0, popular: 0 },
  [ADULT_SRC]: { search: 0, latest: 0, popular: 0 },
};
/** A copy of the counters, so an assertion compares a delta rather than an absolute anyone may have bumped. */
const snap = () => JSON.parse(JSON.stringify(asked)) as typeof asked;

/**
 * One source, adult or not, that answers everything Discover asks of it.
 *
 * `search` answers with the term as the title so `pickBest` matches it (that is what `/find` and the fill
 * scan run the answer through); the two walls answer with a title carrying the source id, so a body
 * assertion can name which source painted a cover.
 */
function fakeSource(id: string, name: string, isNsfw?: boolean) {
  const wall = (n: number) => ({ sourceId: `${id}-${n}`, source: id, title: `Zzz Wall ${id} ${n}` });
  return {
    id, name, isNsfw,
    async search(term: string) { asked[id].search++; return [{ sourceId: `${id}-1`, source: id, title: term }]; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: `Zzz Detail ${id}` }; },
    async listChapters() {
      return [1, 2, 3, 4, 5].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `${id}-c${n}`, pages: 1 }));
    },
    async getPageUrls() { return []; },
    async latest() { asked[id].latest++; return [wall(1), wall(2)]; },
    async popular() { asked[id].popular++; return [wall(3)]; },
  };
}

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const catalogRoutes = (await import('../src/routes/catalog')).default;
  const personalRoutes = (await import('../src/routes/personal')).default;
  const downloadRoutes = (await import('../src/routes/downloads')).default;
  const opdsRoutes = (await import('../src/routes/opds')).default;
  const sourceRoutes = (await import('../src/routes/sources')).default;
  const { registerAdapter } = await import('../src/lib/sources');

  await migrate();
  // Two sources and nothing else: the registry is whatever this process registered, so `listSources()`
  // here is exactly this pair and a count assertion over it means something.
  registerAdapter(fakeSource(CLEAN_SRC, 'Zzz Clean Source') as any);
  registerAdapter(fakeSource(ADULT_SRC, 'Zzz Adult Source', true) as any);
  await q('DELETE FROM lib_books WHERE id = ANY($1)', [[ADULT_BOOK, CLEAN_BOOK, ...FILL_BOOKS]]);
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[ADULT_SERIES, CLEAN_SERIES, FILL_SERIES]]);
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

  // A series on the CLEAN shelf whose own source is the adult one, with MIN_HAVE (3) chapters so the fill
  // scan has something to match against. This is the shape the #64 fix must NOT break: the chip hides
  // providers from Discover, and a series already in the library still has to be fillable from its own.
  await q(
    `INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, latest_mtime, created_at)
     VALUES ($1,'T!al','Zzz Fillable Title',$2,3,$3,$4,$5, 1, now())`,
    [FILL_SERIES, `T!al/${FILL_SERIES}`, CLEAN_LIB, ADULT_SRC, `${ADULT_SRC}-1`],
  );
  for (const [i, bid] of FILL_BOOKS.entries()) {
    await q(
      `INSERT INTO lib_books (id, series_id, source, file, number, title, mtime)
       VALUES ($1,$2,'T!al',$3,$4,$5,1)`,
      [bid, FILL_SERIES, `T!al/${FILL_SERIES}/ch${i + 1}.cbz`, i + 1, `Chapter ${i + 1}`],
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
  await app.register(sourceRoutes);
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
  // `query`, not `fullTextSearch`: the route's zod schema takes the former and silently drops the latter,
  // so the wrong key turns this case into a plain unfiltered listing that passes for the wrong reason.
  { name: 'search by title', method: 'POST', url: '/api/series/search', payload: { query: 'Zzz', size: 100 } },
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

    // ------------------------------------------------------- Discover's sources (v0.42.0, issue #64)
    // `surfaceable()` in routes/sources.ts is `browsable()` applied to the source registry, and every one
    // of these reads a listing route that used to consult the age CAP alone.

    const get = async (url: string, who: any = auth) => app.inject({ method: 'GET', url, headers: who });
    const json = async (url: string, who: any = auth) => (await get(url, who)).json();

    await t.test("Discover's source list leaves out an adult source until it is asked for", async () => {
      // Reintroduce by putting `reachable(req)` back in place of `surfaceable(req)` at the `content:` of
      // GET /api/sources: "an adult provider was listed on Discover with the reveal off" fails.
      const hidden = await json('/api/sources');
      const ids = hidden.content.map((s: any) => s.id);
      assert.equal(ids.includes(ADULT_SRC), false, 'an adult provider was listed on Discover with the reveal off');
      assert.equal(ids.includes(CLEAN_SRC), true, 'the clean provider vanished too, so the filter is too wide');
      assert.equal(hidden.hiddenAdult, 1, 'the source list did not say how many providers it was hiding');

      const shown = await json('/api/sources?adult=1');
      assert.equal(shown.content.map((s: any) => s.id).includes(ADULT_SRC), true,
        'the adult provider stayed hidden even with ?adult=1, which makes the filter a deletion');
      assert.equal(shown.hiddenAdult, 0, 'nothing is hidden once the reveal is on, so the count must be 0');

      // An admin is not exempt here either, for the same reason as the library sweep above: this is a tidy
      // screen and not a permission, and an admin browsing Discover asked for the same thing everyone else did.
      const asAdmin = await json('/api/sources', tok(admin, 'admin'));
      assert.equal(asAdmin.content.map((s: any) => s.id).includes(ADULT_SRC), false,
        'the admin was shown an adult provider by default');
      assert.equal(asAdmin.hiddenAdult, 1);
    });

    await t.test('the newest and popular walls answer empty for a hidden source, without asking it', async () => {
      // Reintroduce by deleting the `surfaceable(req).some(...)` short-circuit from /api/sources/latest:
      // "the newest wall painted an adult source's covers" fails.
      for (const [listing, counter] of [['latest', 'latest'], ['popular', 'popular']] as const) {
        const before = snap();
        const r = await get(`/api/sources/${listing}?source=${ADULT_SRC}`);
        assert.equal(r.statusCode, 200, `the ${listing} wall answered ${r.statusCode}; the hide is not a permission`);
        assert.deepEqual(r.json().content, [], `the ${listing} wall painted an adult source's covers`);
        assert.equal(asked[ADULT_SRC][counter], before[ADULT_SRC][counter],
          `the ${listing} wall asked an adult source anyway and merely dropped the answer`);

        // The clean source keeps working while the reveal is off, or the filter is a blackout.
        const ok = await json(`/api/sources/${listing}?source=${CLEAN_SRC}`);
        assert.ok(ok.content.length > 0, `the ${listing} wall lost the clean source too`);

        const revealed = await json(`/api/sources/${listing}?source=${ADULT_SRC}&adult=1`);
        assert.ok(revealed.content.length > 0, `the ${listing} wall could not be revealed with ?adult=1`);
        assert.equal(asked[ADULT_SRC][counter], before[ADULT_SRC][counter] + 1,
          `the ${listing} wall answered from somewhere other than the revealed source`);
      }
    });

    await t.test('searching one hidden source answers empty rather than 403, and does not ask it', async () => {
      // An empty page, not `denySource`: 403 is the permission answer, and the same account with ?adult=1
      // gets results. Reintroduce by deleting the `surfaceable` line from GET /api/sources/search.
      const before = snap();
      const r = await get(`/api/sources/search?source=${ADULT_SRC}&q=Zzzonesearch`);
      assert.equal(r.statusCode, 200, 'a hidden source was REFUSED rather than hidden; the hide is not a permission');
      assert.deepEqual(r.json().content, [], 'the per-source search answered from an adult source with the reveal off');
      assert.equal(asked[ADULT_SRC].search, before[ADULT_SRC].search, 'the adult source was searched anyway');

      const revealed = await json(`/api/sources/search?source=${ADULT_SRC}&q=Zzzonesearch&adult=1`);
      assert.ok(revealed.content.length > 0, 'the per-source search could not be revealed with ?adult=1');
    });

    await t.test('the cross-source search does not even ask an adult source', async () => {
      // ⚠️ Asserted on the adapter's OWN counter, not only on the body: `searchAll` fans out and a source
      // that is asked and answers nothing looks exactly like one that was never asked. Each call uses its
      // own term, because the answers live in a shared entry keyed by the normalised term for five minutes.
      // Reintroduce by writing `const ask = reachable(req)` back: "an adult source was asked" fails.
      const before = snap();
      const hidden = await json('/api/sources/search-all?q=Zzzfanouthidden');
      assert.equal(asked[ADULT_SRC].search, before[ADULT_SRC].search, 'an adult source was asked by the cross-source search');
      assert.equal(asked[CLEAN_SRC].search, before[CLEAN_SRC].search + 1, 'the clean source was not asked, so this proves nothing');
      assert.equal((hidden.sources ?? []).some((s: any) => s.id === ADULT_SRC), false,
        'the per-source progress lines named an adult source the search never asked');
      assert.equal(JSON.stringify(hidden.content).includes(ADULT_SRC), false, 'an adult provider was offered on a search card');

      const shown = await json('/api/sources/search-all?q=Zzzfanoutshown&adult=1');
      assert.equal(asked[ADULT_SRC].search > before[ADULT_SRC].search, true, 'the cross-source search could not be revealed');
      assert.equal((shown.sources ?? []).some((s: any) => s.id === ADULT_SRC), true,
        'the adult source is still missing from the progress lines with ?adult=1');
    });

    await t.test('/api/sources/find skips an adult source, and naming it does not override the hide', async () => {
      // Reintroduce by writing `reachable` back into `allowed` in GET /api/sources/find.
      const before = snap();
      const hidden = await json('/api/sources/find?q=Zzzfindterm');
      assert.equal(hidden.content.some((c: any) => c.source === ADULT_SRC), false, 'find returned an adult provider');
      assert.equal(hidden.content.some((c: any) => c.source === CLEAN_SRC), true, 'find lost the clean provider too');
      assert.equal(asked[ADULT_SRC].search, before[ADULT_SRC].search, 'find asked an adult source anyway');

      // `sources=` narrows the fan-out; it must never widen it back past the hide.
      const named = await json(`/api/sources/find?q=Zzzfindnamed&sources=${ADULT_SRC}`);
      assert.deepEqual(named.content, [], 'naming a hidden source in `sources=` brought it back');

      assert.equal((await json('/api/sources/find?q=Zzzfindshown&adult=1')).content.some((c: any) => c.source === ADULT_SRC),
        true, 'find could not be revealed with ?adult=1');
    });

    await t.test('a capped account is still REFUSED by id, not merely unsurfaced', async () => {
      // The hide and the cap are different rules and the cap is the one that says no. Reintroduce by
      // deleting the `sourceAllowedFor` refusal from /api/sources/latest: the 403 becomes a 200.
      await q('UPDATE users SET max_age_rating = 13 WHERE id = $1', [uid]);
      try {
        for (const url of [
          `/api/sources/latest?source=${ADULT_SRC}&adult=1`,
          `/api/sources/popular?source=${ADULT_SRC}&adult=1`,
          `/api/sources/search?source=${ADULT_SRC}&q=Zzzcapped&adult=1`,
          `/api/sources/detail?source=${ADULT_SRC}&sourceId=${ADULT_SRC}-1&adult=1`,
        ]) {
          const r = await get(url);
          assert.equal(r.statusCode, 403, `${url} answered ${r.statusCode}; the age cap stopped being a refusal`);
          assert.equal(r.json().error, 'forbidden');
        }
        // …and the count must not become a side channel: `reachable` already dropped the source, so there
        // is nothing to hide and nothing to count. A capped account must not learn the number either.
        const capped = await json('/api/sources');
        assert.equal(capped.hiddenAdult, 0, 'a 13+ account was told how many adult providers exist');
        assert.equal(capped.content.some((s: any) => s.id === ADULT_SRC), false);
      } finally {
        await q('UPDATE users SET max_age_rating = NULL WHERE id = $1', [uid]);
      }
    });

    await t.test('filling and detail are NOT hidden: a series whose own source is adult stays serviceable', async () => {
      // The deliberate exception, and the reason `surfaceable` is a separate helper rather than a change to
      // `reachable`. Both calls run with the reveal OFF. Reintroduce by using `surfaceable` for `allowed`
      // in POST /api/sources/fill/scan: "its own adult source was not offered" fails.
      const scan = await app.inject({
        method: 'POST', url: '/api/sources/fill/scan', headers: auth, payload: { seriesId: FILL_SERIES },
      });
      assert.equal(scan.statusCode, 200, `the fill scan answered ${scan.statusCode} for a series on an adult source`);
      const own = scan.json().candidates.find((c: any) => c.source === ADULT_SRC);
      assert.ok(own?.pinned, 'its own adult source was not offered, so the series became unfillable with the chip off');

      // Detail is an explicit act on a source the person just named, so the chip does not reach it either.
      const detail = await get(`/api/sources/detail?source=${ADULT_SRC}&sourceId=${ADULT_SRC}-1`);
      assert.equal(detail.statusCode, 200, 'the add dialog could not read a named adult source with the reveal off');
      assert.equal(detail.json().count, 5, 'the detail answer lost its chapters');
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
    await q('DELETE FROM lib_books WHERE id = ANY($1)', [[ADULT_BOOK, CLEAN_BOOK, ...FILL_BOOKS]]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [[ADULT_SERIES, CLEAN_SERIES, FILL_SERIES]]).catch(() => {});
    await q('DELETE FROM libraries WHERE id = ANY($1)', [[ADULT_LIB, CLEAN_LIB]]).catch(() => {});
    await q('DELETE FROM users WHERE username = ANY($1)', [USERS]).catch(() => {});
  }
});
