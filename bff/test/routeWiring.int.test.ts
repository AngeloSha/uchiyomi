// The routes, mounted for real, driven over HTTP.
//
// Every other integration test in this directory imports `src/lib/*` and calls it directly. That proves the
// data layer and nothing else, and v0.8.0 shipped the consequence: `ownedCatalog.searchSeries` was correct,
// its unit-level behaviour was covered, and `POST /api/series/search` still returned an empty list for every
// input on every install, because the route called it with the arguments in the OLD order behind a
// `(komga.searchSeries as any)` cast:
//
//     komga.searchSeries(body, page, size, sort, { userId })   // ctx last  -- the pre-0.8.0 signature
//     komga.searchSeries(ctx, body, page, size, sort)          // ctx first -- what ContentBackend declares
//
// The arguments shifted by one, so `page` received `size` (40), the offset landed past the end of a
// four-row library, and `content` came back `[]` while `totalElements` cheerfully said 4. That endpoint is
// the library page, the search page, browse, and the command palette. The `as any` was the only reason the
// compiler stayed quiet, and it was the last such cast in the codebase.
//
// So this file exists to make "the route is wired to the function" a tested claim, not an assumed one.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const S1 = 's_rw_one';
const S2 = 's_rw_two';

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const catalogRoutes = (await import('../src/routes/catalog')).default;
  const downloadRoutes = (await import('../src/routes/downloads')).default;
  const opdsRoutes = (await import('../src/routes/opds')).default;

  await migrate();
  await q(`DELETE FROM lib_books WHERE series_id = ANY($1)`, [[S1, S2]]);
  await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [[S1, S2]]);
  await q(`DELETE FROM users WHERE username = 'rw-user'`);

  const u = await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ('rw-user','rw-user','x','user','password') RETURNING id`,
  );
  for (const [id, title] of [[S1, 'Route Wiring One'], [S2, 'Route Wiring Two']] as const) {
    await q(
      `INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!rw',$2,$3,1)`,
      [id, title, `T!rw/${id}`],
    );
    await q(
      `INSERT INTO lib_books (id, series_id, source, file, number, title)
       VALUES ($1,$2,'T!rw',$3,1,'Chapter 1')`,
      [`b_${id}`, id, `T!rw/${id}/ch1.cbz`],
    );
  }

  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(catalogRoutes);
  await app.register(downloadRoutes);
  await app.register(opdsRoutes);
  await app.ready();

  const token = app.jwt.sign({ sub: u[0].id, role: 'user' });

  // OPDS authenticates with HTTP Basic where the password is a per-user token, so the feed needs its own
  // credential rather than the JWT.
  const { issueOpdsToken } = await import('../src/lib/auth');
  const opds = await issueOpdsToken(u[0].id);
  const opdsBasic =
    'Basic ' + Buffer.from(`rw-user:${typeof opds === 'string' ? opds : (opds as any).token}`).toString('base64');

  return { app, q, token, opdsBasic, userId: u[0].id };
}

async function teardown(app: any, q: any) {
  await app.close();
  await q(`DELETE FROM lib_books WHERE series_id = ANY($1)`, [[S1, S2]]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [[S1, S2]]).catch(() => {});
  await q(`DELETE FROM users WHERE username = 'rw-user'`).catch(() => {});
}

test('the catalog routes are wired to the backend they claim', { skip }, async (t) => {
  const { app, q, token, opdsBasic } = await setup();
  const auth = { authorization: `Bearer ${token}` };

  try {
    await t.test('THE REGRESSION: search returns the rows it counted', async () => {
      // The exact shape the library page sends, and the shape that returned [] in v0.8.0.
      const r = await app.inject({
        method: 'POST',
        url: '/api/series/search',
        headers: auth,
        payload: { page: 0, size: 40 },
      });
      assert.equal(r.statusCode, 200);
      const b = r.json();
      assert.ok(b.totalElements >= 2, `expected the seeded series to be counted, got ${b.totalElements}`);
      assert.equal(
        b.content.length > 0,
        true,
        `content was empty while totalElements said ${b.totalElements} -- the arguments are shifted`,
      );
    });

    await t.test('an empty body is the same request, not a different one', async () => {
      // `{}` is what an API client following docs/api.md sends, and page/size have defaults for exactly
      // that reason. It must not fall off the end of the result set.
      const r = await app.inject({ method: 'POST', url: '/api/series/search', headers: auth, payload: {} });
      assert.equal(r.statusCode, 200);
      const b = r.json();
      assert.ok(b.content.length > 0, 'an empty body returned an empty page');
      assert.equal(b.number, 0, `page number should default to 0, got ${b.number}`);
    });

    await t.test('paging still means paging', async () => {
      const r = await app.inject({
        method: 'POST', url: '/api/series/search', headers: auth, payload: { page: 0, size: 1 },
      });
      const b = r.json();
      assert.equal(b.content.length, 1, 'size=1 should return exactly one row');
      assert.equal(b.size, 1, `size should be echoed back as 1, got ${b.size}`);

      const far = await app.inject({
        method: 'POST', url: '/api/series/search', headers: auth, payload: { page: 999, size: 40 },
      });
      assert.equal(far.json().content.length, 0, 'a page past the end should be empty, and only then');
    });

    await t.test('the query reaches the backend', async () => {
      const r = await app.inject({
        method: 'POST', url: '/api/series/search', headers: auth, payload: { query: 'Route Wiring One' },
      });
      // Series come back in the Komga-compatible shape, so the title lives under metadata.
      const titles = r.json().content.map((s: any) => s.metadata?.title ?? s.title);
      assert.equal(titles.length, 1, `full-text search should narrow to one, got ${JSON.stringify(titles)}`);
      assert.ok(titles.includes('Route Wiring One'), `search for a known title found ${JSON.stringify(titles)}`);
    });
    await t.test('THE OTHER ONE: the offline manifest reaches the configured backend', async () => {
      // download-manifest called the raw Komga HTTP client rather than `content`, from the first commit
      // onwards. In owned mode there is no Komga to answer, so it threw, hit its own catch, and returned
      // 404 for every chapter that exists. The PWA asks for this before it can store anything offline.
      const r = await app.inject({
        method: 'GET', url: `/api/books/b_${S1}/download-manifest`, headers: auth,
      });
      assert.equal(r.statusCode, 200, 'a real chapter must not 404 -- offline downloads depend on this');
      const m = r.json();
      assert.equal(m.bookId, `b_${S1}`);
      assert.ok(m.coverUrl.includes(`b_${S1}`), 'the cover url should address the book');
      assert.ok(Array.isArray(m.pages), 'pages must be a list');
    });

    await t.test('and the manifest is subject to the visibility rule', async () => {
      // The old call resolved a book id with no viewer at all. Now that it returns something, it has to
      // refuse a hidden series like every other read path.
      await q(`UPDATE lib_series SET deleted_at = now() WHERE id = $1`, [S1]);
      try {
        const r = await app.inject({
          method: 'GET', url: `/api/books/b_${S1}/download-manifest`, headers: auth,
        });
        assert.equal(r.statusCode, 404, 'a hidden series must not be downloadable for offline reading');
      } finally {
        await q(`UPDATE lib_series SET deleted_at = NULL WHERE id = $1`, [S1]);
      }
    });
    await t.test('THE THIRD ONE: every sort the OPDS root offers actually works', async () => {
      // /opds links to three feeds: recently updated (the default), A-Z, and recently added. Two of them
      // order by columns -- latest_mtime, created_at -- that the visibility-aware subquery introduced in
      // v0.8.0 stopped selecting, so both were a hard 500 for everyone, admin included. Only ?sort=title
      // worked, and nothing pointed at it first.
      for (const url of ['/opds/series', '/opds/series?sort=updated', '/opds/series?sort=title',
                         '/opds/series?sort=added']) {
        const r = await app.inject({ method: 'GET', url, headers: { authorization: opdsBasic } });
        assert.equal(r.statusCode, 200, `${url} answered ${r.statusCode}; an OPDS reader sees a dead feed`);
        assert.ok(r.body.includes('<feed'), `${url} did not return an OPDS feed`);
      }
    });
    await t.test('THE FIFTH: progress for a chapter that does not resolve is 404, never 500', async () => {
      // Migration 0004 gave read_progress a foreign key to lib_series. The route's fallback for a chapter it
      // cannot look up was seriesId 'unknown', and no series has that id -- so from 0004 onward that path
      // could only ever violate the constraint and return 500. Reached in practice by the service worker's
      // offline outbox replaying a queued page for a series deleted or merged since, where a 500 means the
      // entry is retried forever instead of being dropped.
      const gone = await app.inject({
        method: 'PUT',
        url: '/api/books/b_does_not_exist_at_all/progress',
        headers: auth,
        payload: { page: 3 },
      });
      assert.equal(gone.statusCode, 404, `an unresolvable chapter answered ${gone.statusCode}, not 404`);

      // And nothing was written on the way out.
      const rows = await q(`SELECT 1 FROM read_progress WHERE book_id = 'b_does_not_exist_at_all'`);
      assert.equal(rows.length, 0, 'a 404 still wrote a progress row');

      // The ordinary path must be untouched: a real chapter still records progress.
      const okr = await app.inject({
        method: 'PUT',
        url: `/api/books/b_${S1}/progress`,
        headers: auth,
        payload: { page: 2 },
      });
      assert.equal(okr.statusCode, 200, 'a resolvable chapter must still accept progress');
      const wrote = await q(`SELECT page FROM read_progress WHERE book_id = $1`, [`b_${S1}`]);
      assert.equal(wrote[0]?.page, 2, 'the ordinary progress write stopped working');
    });

    await t.test('THE FOURTH: the genre endpoints answer over HTTP, not just in the library', async () => {
      // Every assertion about genreOverview lives in genreOverview.int.test.ts and calls the function
      // directly, which is exactly the gap this file exists for: a correct function reached by a wrong
      // route is what shipped in v0.8.0. So drive it the way the browse page does.
      const plain = await app.inject({ method: 'GET', url: '/api/genres', headers: auth });
      assert.equal(plain.statusCode, 200);
      assert.ok(Array.isArray(plain.json().content), '/api/genres must still return { content: string[] }');

      const r = await app.inject({ method: 'GET', url: '/api/genres/overview', headers: auth });
      assert.equal(r.statusCode, 200, `/api/genres/overview answered ${r.statusCode}`);
      const rows = r.json().content;
      assert.ok(Array.isArray(rows), 'the browse page maps over content');
      for (const row of rows) {
        assert.equal(typeof row.key, 'string');
        assert.equal(typeof row.label, 'string');
        assert.ok(Array.isArray(row.covers), 'a tile with no covers array cannot render a mosaic');
      }

      // The cover count is a query parameter, and a tile that asks for six must not be handed four.
      const six = (await app.inject({ method: 'GET', url: '/api/genres/overview?covers=6', headers: auth })).json();
      for (const row of six.content) assert.ok(row.covers.length <= 6);

      // And it must be bounded rather than trusted: an unbounded slice is a way to ask for the whole library.
      const daft = await app.inject({ method: 'GET', url: '/api/genres/overview?covers=99999', headers: auth });
      assert.equal(daft.statusCode, 200, 'a silly value must clamp, not 500');
      for (const row of daft.json().content) assert.ok(row.covers.length <= 8, 'covers must be capped');

      const junk = await app.inject({ method: 'GET', url: '/api/genres/overview?covers=abc', headers: auth });
      assert.equal(junk.statusCode, 200, 'a non-numeric value must fall back, not crash');
    });

  } finally {
    await teardown(app, q);
  }
});

// ---------------------------------------------------------------------------------------------------

test('no route casts a backend method to any', () => {
  // This is the static half, and the one that generalises. `ContentBackend` exists so that a call site
  // which forgets the view context is a compile error; `(komga.method as any)(...)` turns that guarantee
  // off for one line, and the one line it was left on is the one that broke. Casting the RESULT is fine --
  // it is casting the FUNCTION that discards the signature.
  const dir = join(__dirname, '..', 'src', 'routes');
  const offenders: string[] = [];

  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      // (komga.searchSeries as any)(   /   (content.book as any)(   /   (komga as any).series(
      if (/\((?:komga|content)(?:\.\w+)?\s+as\s+any\)/.test(line)) {
        offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    'a backend call is cast to any, which is exactly how the v0.8.0 search regression got past tsc:\n  ' +
      offenders.join('\n  '),
  );
});
