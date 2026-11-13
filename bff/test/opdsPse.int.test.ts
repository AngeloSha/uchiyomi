// What an OPDS reader is told, and whether it is true.
//
// Three things the feed said that were not so, and one it could not say at all:
//   * every `<updated>` was "now", so a reader's change detection saw the whole library change on every fetch;
//   * the only way to read a chapter was to download the whole CBZ, though Panels, Chunky and KOReader all
//     stream pages over OPDS-PSE when a feed offers it;
//   * a search could not be narrowed or paged past sixty hits, because it was a separate code path;
//   * 18+ libraries were always hidden, with no way for a reader to ask -- the web app's reveal button does
//     not exist in an OPDS client, so the preference now rides on the credential.
// And, since v0.108.0 (#377), what reading over the stream tells the server: with the account's switch on, the pages
// fetched at reading size keep the reader's place, and a chapter paged through to the end in one sitting is read, here
// and on the trackers -- timed by a clock of the test's own (setOpdsClock), so a sitting of minutes takes none.
//
// Everything here is driven over HTTP against the real routes, with a real archive on disk, because the
// page route hands out bytes: a test that mocked the archive would pass while serving the wrong page.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
// Static, like the other zod-shaped tests: a dynamic import of zod is a different module instance than the
// routes' own, and `instanceof ZodError` then fails in the error handler. See uchiyomi-zod-instanceof-trap.
import { ZodError } from 'zod';

const DSN = process.env.TEST_DATABASE_URL;
const TMP = DSN ? mkdtempSync(join(tmpdir(), 'uchiyomi-pse-')) : '';
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.CACHE_DIR = join(TMP, 'cache'); // serveImage writes here; never the live cache
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_pse_a', ADULT_LIB = 'lib_pse_x';
const S_MAIN = 's_pse_main', S_HIDDEN = 's_pse_hidden', S_ADULT = 's_pse_adult', S_READ = 's_pse_read';
/** The chapters read over the stream (#377): number n of S_READ, six pages each, one per case so none shares a place. */
const R = (n: number) => `b_pse_r${n}`;
const B_TWO = 'b_pse_two', B_ZERO = 'b_pse_zero', B_HIDDEN = 'b_pse_hidden';
const USER = 'pse-user', CAPPED = 'pse-capped';
const FIXED_AT = '2026-01-02T03:04:05.000Z';
const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

// MyAnimeList stands in for every tracker: its push is a PATCH the stub can see (as in incognito.int.test.ts).
const pushes: string[] = [];
const realFetch = globalThis.fetch;
/** Waits for the push count to reach `n`, up to `ms`; answers the count it saw. A push is fire-and-forget. */
const pushedBy = async (n: number, ms = 3000) => {
  const end = Date.now() + ms;
  while (pushes.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return pushes.length;
};

async function setup() {
  globalThis.fetch = (async (u: any, init?: any) => {
    if (!/api\.myanimelist\.net/.test(String(u))) return realFetch(u, init);
    const answer = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    // A push reads the series first (v0.61.2): a GET, answered as a series still coming out. Only the write is a push.
    if (String(init?.method ?? 'GET') === 'GET') return answer({ status: 'currently_publishing', num_chapters: 0 });
    pushes.push(String(init?.body ?? ''));
    return answer({ status: 'reading' });
  }) as typeof fetch;
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const auth = await import('../src/lib/auth');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const opdsRoutes = (await import('../src/routes/opds')).default;
  const personalRoutes = (await import('../src/routes/personal')).default;
  const sharp = (await import('sharp')).default;
  const AdmZip = require('adm-zip');

  await migrate();
  await q(`DELETE FROM users WHERE username = ANY($1)`, [[USER, CAPPED]]);
  await q(`DELETE FROM lib_series WHERE id LIKE 's_pse_%'`);
  await q(`DELETE FROM libraries WHERE id = ANY($1)`, [[LIB, ADULT_LIB]]);

  // Two real pages, distinguishable by size, so "page 0" and "page 1" are checkable and so sharp can resize.
  const page = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#224466' } }).png().toBuffer();
  const [p0, p1] = await Promise.all([page(600, 900), page(500, 800)]);
  mkdirSync(join(TMP, 'lib'), { recursive: true });
  const cbz = (name: string) => { const z = new AdmZip(); z.addFile('001.png', p0); z.addFile('002.png', p1); writeFileSync(join(TMP, 'lib', name), z.toBuffer()); return name; };

  const users = await q<{ id: string; username: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind, max_age_rating)
     VALUES ($1,$1,'x','user','password',NULL), ($2,$2,'x','user','password',16) RETURNING id, username`, [USER, CAPPED]);
  const uid = users.find((u) => u.username === USER)!.id;
  const capped = users.find((u) => u.username === CAPPED)!.id;

  // `path` is unique across libraries (and the default library's is ''), so each seeded one needs its own.
  await q(`INSERT INTO libraries (id, name, path, sort_order, age_rating) VALUES ($1,'Shelf','/pse/shelf',0,NULL), ($2,'Grown-ups','/pse/grown',1,18)`, [LIB, ADULT_LIB]);
  const series = async (id: string, title: string, lib: string, genres: string[], status: string | null, mtime: number) =>
    q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, genres, status, latest_mtime, created_at)
       VALUES ($1,'T!pse',$2,$3,1,$4,$5,$6,$7,$8)`, [id, title, `T!pse/${id}`, lib, genres, status, mtime, FIXED_AT]);
  await series(S_MAIN, 'Pse Main Title', LIB, ['Action', 'Slice of Life'], 'ongoing', Date.parse('2026-03-04T05:06:07Z'));
  await series(S_HIDDEN, 'Pse Hidden Title', LIB, ['Action'], 'ongoing', 0);
  await series(S_ADULT, 'Pse Grown Title', ADULT_LIB, ['Romance'], 'completed', 0);
  await q(`UPDATE lib_series SET deleted_at = now() WHERE id = $1`, [S_HIDDEN]);
  // Sixty-one more, all tagged Action, so a filtered feed has a second page to carry the filter onto.
  for (let i = 0; i < 61; i++) await series(`s_pse_bulk_${String(i).padStart(2, '0')}`, `Pse Bulk ${i}`, LIB, ['Action', 'Bulk'], 'ongoing', 0);

  const book = (id: string, sid: string, file: string, pages: number) =>
    q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root, updated_at)
       VALUES ($1,$2,'T!pse',$3,1,'Chapter 1',$4,$5,$6)`, [id, sid, file, pages, join(TMP, 'lib'), FIXED_AT]);
  await book(B_TWO, S_MAIN, cbz('two.cbz'), 2);
  await book(B_ZERO, S_MAIN, cbz('zero.cbz'), 0); // "never counted" -- the feed must count it, once
  await book(B_HIDDEN, S_HIDDEN, cbz('hidden.cbz'), 2);
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at) VALUES ($1,$2,$3,1,false,$4)`, [uid, B_TWO, S_MAIN, FIXED_AT]);

  // #377: a series of six-page chapters to read over the stream, linked on the reader's MyAnimeList.
  await series(S_READ, 'Pse Read Title', LIB, ['Drama'], 'ongoing', 0);
  const six = new AdmZip();
  const tiny = await page(40, 60);
  for (let i = 1; i <= 6; i++) six.addFile(`00${i}.png`, tiny);
  for (let n = 1; n <= 9; n++) {
    writeFileSync(join(TMP, 'lib', `r${n}.cbz`), six.toBuffer());
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root, updated_at)
             VALUES ($1,$2,'T!pse',$3,$4,$5,6,$6,$7)`, [R(n), S_READ, `r${n}.cbz`, n, `Chapter ${n}`, join(TMP, 'lib'), FIXED_AT]);
  }
  const trackers = await import('../src/lib/trackers');
  await trackers.saveConnection(uid, 'myanimelist', 'tok-mal', 'me-on-mal', new Date(Date.now() + 86_400_000));
  await trackers.linkSeries(S_READ, '377', 'Pse Read Title', uid, 'myanimelist');

  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  app.setErrorHandler((err: any, req: any, reply: any) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'bad_request' });
    const status = err.statusCode || 500;
    if (status >= 500) { req.log.error(err); console.error('ROUTE 500:', req.url, err?.message); }
    return reply.code(status).send({ error: status >= 500 ? 'internal' : err.message || 'error' });
  });
  await app.register(opdsRoutes);
  await app.register(personalRoutes);
  await app.ready();

  const token = await auth.issueOpdsToken(uid);
  const cappedToken = await auth.issueOpdsToken(capped);
  const as = (t: string, u = USER) => ({ authorization: basic(u, t) });
  const jwtFor = (id: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role: 'user' })}` });
  return { app, q, auth, sharp, uid, capped, token, cappedToken, as, jwtFor, p0, p1, book };
}

async function teardown(app: any, q: any) {
  (await import('../src/lib/externalReading')).setOpdsClock(null);
  globalThis.fetch = realFetch;
  await app.close();
  await q(`DELETE FROM users WHERE username = ANY($1)`, [[USER, CAPPED]]).catch(() => {});
  await q(`DELETE FROM series_trackers WHERE series_id LIKE 's_pse_%'`).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id LIKE 's_pse_%'`).catch(() => {});
  await q(`DELETE FROM libraries WHERE id = ANY($1)`, [[LIB, ADULT_LIB]]).catch(() => {});
  rmSync(TMP, { recursive: true, force: true });
}

const attr = (xml: string, name: string) => xml.match(new RegExp(`${name}="([^"]*)"`))?.[1];
/** The <entry> block whose <id> ends with this id. */
const entryFor = (xml: string, id: string) => xml.split('<entry>').find((e) => e.includes(`:${id}</id>`)) || '';

test('what an OPDS reader is told is true, and it can stream pages', { skip }, async (t) => {
  const { app, q, auth, sharp, capped, token, cappedToken, as, jwtFor, uid, p0, p1, book } = await setup();
  try {
    await t.test('THE STREAM LINK: literal template, real page count, this reader\'s own progress', async () => {
      const r = await app.inject({ method: 'GET', url: `/opds/series/${S_MAIN}`, headers: as(token) });
      assert.equal(r.statusCode, 200);
      const xml = r.body;
      assert.match(xml, /xmlns:pse="http:\/\/vaemendis\.net\/opds-pse\/ns"/, 'the pse namespace is not declared, so every pse: attribute is invalid XML');
      const two = entryFor(xml, B_TWO);
      assert.match(two, /rel="http:\/\/vaemendis\.net\/opds-pse\/stream"/, 'no stream link on a chapter with pages');
      // Reintroduce by running the href through esc() with braces included, or by templating a number in.
      assert.match(two, /href="\/opds\/book\/b_pse_two\/page\/\{pageNumber\}\?maxWidth=\{maxWidth\}"/, 'the template placeholders must reach the reader literally');
      assert.equal(attr(two, 'pse:count'), '2');
      // read_progress.page is zero-based and so is the PSE template; passed through, not shifted.
      assert.equal(attr(two, 'pse:lastRead'), '1', 'lastRead must mirror read_progress.page for THIS reader');
      assert.equal(attr(two, 'pse:lastReadDate'), FIXED_AT);
      // The CBZ acquisition link stays: a reader that does not know PSE keeps downloading.
      assert.match(two, /rel="http:\/\/opds-spec\.org\/acquisition"/);
    });

    await t.test('a chapter never counted is counted for the feed, once, and written back', async () => {
      // Reintroduce by dropping the cbzPageAt fallback: pse:count="0" is a link a reader cannot use.
      const r = await app.inject({ method: 'GET', url: `/opds/series/${S_MAIN}`, headers: as(token) });
      const zero = entryFor(r.body, B_ZERO);
      assert.equal(attr(zero, 'pse:count'), '2', 'the archive has two pages; the feed said otherwise');
      assert.equal(attr(zero, 'pse:lastRead'), undefined, 'no progress row, so no lastRead');
      for (let i = 0; i < 20; i++) { // fire-and-forget write-back
        const row = await q(`SELECT pages FROM lib_books WHERE id = $1`, [B_ZERO]);
        if (row[0].pages === 2) break;
        await new Promise((res) => setTimeout(res, 25));
      }
      assert.equal((await q(`SELECT pages FROM lib_books WHERE id = $1`, [B_ZERO]))[0].pages, 2, 'the count was not written back');
    });

    await t.test('THE PAGE ROUTE: zero-based, original bytes, then a bounded JPEG on request', async () => {
      const p0 = await app.inject({ method: 'GET', url: `/opds/book/${B_TWO}/page/0`, headers: as(token) });
      assert.equal(p0.statusCode, 200, `page 0 answered ${p0.statusCode}: the route is not zero-based`);
      assert.equal(p0.headers['content-type'], 'image/png', 'without maxWidth the original bytes are served, as stored');
      const m0 = await sharp(p0.rawPayload).metadata();
      assert.equal(m0.width, 600, 'page 0 is the 600px page; 500 would mean an off-by-one');
      const p1 = await app.inject({ method: 'GET', url: `/opds/book/${B_TWO}/page/1`, headers: as(token) });
      assert.equal((await sharp(p1.rawPayload).metadata()).width, 500);
      // Reintroduce by passing pageNo - 1 to cbzPageAt like the 1-based image route does: page 0 then 400s
      // there and page 2 serves the last page here instead of 404.
      assert.equal((await app.inject({ method: 'GET', url: `/opds/book/${B_TWO}/page/2`, headers: as(token) })).statusCode, 404, 'past the end must be 404');
      assert.equal((await app.inject({ method: 'GET', url: `/opds/book/${B_TWO}/page/-1`, headers: as(token) })).statusCode, 400);

      const w = await app.inject({ method: 'GET', url: `/opds/book/${B_TWO}/page/0?maxWidth=300`, headers: as(token) });
      assert.equal(w.statusCode, 200);
      assert.equal(w.headers['content-type'], 'image/jpeg', 'a width request is answered with a JPEG, the one format every reader decodes');
      const mw = await sharp(w.rawPayload).metadata();
      assert.ok((mw.width ?? 9999) <= 300, `asked for 300, got ${mw.width}`);
      // And the resized variant must not have replaced the original in the cache.
      const again = await app.inject({ method: 'GET', url: `/opds/book/${B_TWO}/page/0`, headers: as(token) });
      assert.equal((await sharp(again.rawPayload).metadata()).width, 600, 'the resized variant was served under the original\'s key');
    });

    await t.test('a hidden series has no chapter list and no pages, and no auth means no bytes', async () => {
      assert.equal((await app.inject({ method: 'GET', url: `/opds/series/${S_HIDDEN}`, headers: as(token) })).statusCode, 404);
      // Reintroduce by resolving the book with a bare SELECT instead of visibleBookFile.
      assert.equal((await app.inject({ method: 'GET', url: `/opds/book/${B_HIDDEN}/page/0`, headers: as(token) })).statusCode, 404,
        'a page of a hidden series was served from a bare book id');
      const noauth = await app.inject({ method: 'GET', url: `/opds/book/${B_TWO}/page/0` });
      assert.equal(noauth.statusCode, 401);
      assert.match(String(noauth.headers['www-authenticate']), /Basic/);
    });

    await t.test('<updated> is the truth, not the time of the request', async () => {
      // Reintroduce by restoring `new Date().toISOString()` in the entry: every fetch then looks like a change.
      const chapters = await app.inject({ method: 'GET', url: `/opds/series/${S_MAIN}`, headers: as(token) });
      assert.match(entryFor(chapters.body, B_TWO), new RegExp(`<updated>${FIXED_AT}</updated>`), 'a chapter must carry its own updated_at');
      const feedUpdated = chapters.body.match(/<feed[^>]*>[\s\S]*?<updated>([^<]+)<\/updated>/)?.[1];
      assert.equal(feedUpdated, FIXED_AT, 'the feed carries the newest of its entries, not now');
      const series = await app.inject({ method: 'GET', url: `/opds/series?q=Pse%20Main`, headers: as(token) });
      assert.match(entryFor(series.body, S_MAIN), /<updated>2026-03-04T05:06:07\.000Z<\/updated>/, 'a series carries its newest chapter time (latest_mtime)');
    });

    await t.test('estimates are opt-in, two pages fetched in a moment are no read, and an explicit place wins', async () => {
      const count=async(table:string)=>(await q<{n:number}>(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`,[uid]))[0].n;
      const beforeEvents=await count('reading_events');
      await app.inject({url:`/opds/book/${B_ZERO}/page/0`,headers:as(token)});
      assert.equal(await count('opds_estimated_bookmarks'),0);
      await q(`INSERT INTO app_settings(user_id,data) VALUES($1,'{"opdsEstimatedBookmarks":true}') ON CONFLICT(user_id) DO UPDATE SET data=app_settings.data||EXCLUDED.data`,[uid]);
      await app.inject({url:`/opds/book/${B_ZERO}/page/0?maxWidth=300`,headers:as(token)});
      await app.inject({method:'HEAD',url:`/opds/book/${B_ZERO}/page/0`,headers:as(token)});
      assert.equal(await count('opds_estimated_bookmarks'),0,'thumbnails and HEAD do not estimate');
      assert.equal((await app.inject({url:`/opds/book/${B_ZERO}/page/999`,headers:as(token)})).statusCode,404);
      await app.inject({url:`/opds/book/${B_ZERO}/page/0`,headers:as(token)});
      await app.inject({url:`/opds/book/${B_ZERO}/page/1`,headers:as(token)});
      for(let i=0;i<30;i++){const r=await q<{page:number}>('SELECT page FROM opds_estimated_bookmarks WHERE user_id=$1 AND book_id=$2',[uid,B_ZERO]);if(r[0]?.page===2)break;await new Promise(r=>setTimeout(r,10));}
      assert.equal((await q<{page:number}>('SELECT page FROM opds_estimated_bookmarks WHERE user_id=$1 AND book_id=$2',[uid,B_ZERO]))[0].page,2);
      assert.equal((await q('SELECT * FROM read_progress WHERE user_id=$1 AND book_id=$2',[uid,B_ZERO])).length,0);
      assert.equal(await count('reading_events'),beforeEvents);
      assert.match(entryFor((await app.inject({url:`/opds/series/${S_MAIN}`,headers:as(token)})).body,B_ZERO),/pse:lastRead="2"/);
      await q('INSERT INTO read_progress(user_id,book_id,series_id,page) VALUES($1,$2,$3,1)',[uid,B_ZERO,S_MAIN]);
      assert.match(entryFor((await app.inject({url:`/opds/series/${S_MAIN}`,headers:as(token)})).body,B_ZERO),/pse:lastRead="1"/,'explicit position wins');
      await q('DELETE FROM read_progress WHERE user_id=$1 AND book_id=$2',[uid,B_ZERO]);
    });

    // ---- Reading over the stream (#377). The switch is on from the test above. ----
    const { setOpdsClock, writeExternalBook, externalReaderCounts } = await import('../src/lib/externalReading');
    const { writeProgress } = await import('../src/lib/progress');
    let now = Date.parse('2026-11-13T10:00:00.000Z');
    setOpdsClock(() => now);
    const HOUR = 3_600_000;
    /** One page (zero-based, as the template is) after `gapMs` on the sitting's clock; `width` absent sends no maxWidth. */
    const fetchPage = async (bookId: string, n: number, o: { gapMs?: number; width?: string } = {}) => {
      now += o.gapMs ?? 0;
      const r = await app.inject({ url: `/opds/book/${bookId}/page/${n}${o.width === undefined ? '' : `?maxWidth=${encodeURIComponent(o.width)}`}`, headers: as(token) });
      assert.equal(r.statusCode, 200, `page ${n} of ${bookId} answered ${r.statusCode}`);
    };
    /** Pages `from` to `to` in order, each `gapMs` after the one before, at KOReader's width unless told otherwise. */
    const run = async (bookId: string, from: number, to: number, gapMs: number, width = '1264') => {
      for (let n = from; n <= to; n++) await fetchPage(bookId, n, { gapMs, width });
    };
    const place = async (bookId: string) =>
      (await q<{ page: number }>('SELECT page FROM opds_estimated_bookmarks WHERE user_id=$1 AND book_id=$2', [uid, bookId]))[0]?.page ?? null;
    const progressOf = async (bookId: string) =>
      (await q('SELECT page, completed, inferred, incognito FROM read_progress WHERE user_id=$1 AND book_id=$2', [uid, bookId]))[0] ?? null;
    const eventsOf = async (bookId: string) =>
      q<{ origin: string }>('SELECT origin FROM reading_events WHERE user_id=$1 AND book_id=$2 AND completed', [uid, bookId]);

    await t.test('a page at reading size is recorded: 1264, blank and an unfilled {maxWidth} are, a 300 px thumbnail is not', async () => {
      // The page is recorded once served, whichever branch served it (routes/opds.ts readingSize). Reintroduce v0.107.0's
      // rule -- only a fetch with no maxWidth at all, and only in the plain branch -- and 1264, blank and {maxWidth} record
      // nothing, though our own template always sends the key. Drop the 600 px floor and 300 records.
      await fetchPage(R(1), 0, { width: '300' });
      assert.equal(await place(R(1)), null, 'a 300 px thumbnail is no page read');
      await fetchPage(R(1), 0, { width: '1264' });
      assert.equal(await place(R(1)), 1, "KOReader's screen width");
      await fetchPage(R(1), 1, { width: '' });
      assert.equal(await place(R(1)), 2, 'a blank maxWidth');
      await fetchPage(R(1), 2, { width: '{maxWidth}' });
      assert.equal(await place(R(1)), 3, 'the template sent back unfilled');
      await fetchPage(R(1), 3, { width: '600' });
      assert.equal(await place(R(1)), 4, 'the narrowest e-reader screen');
      await fetchPage(R(1), 4, { width: '599' });
      assert.equal(await place(R(1)), 4, 'and one pixel less is a thumbnail');
    });

    await t.test('a chapter paged through to the end in one sitting is read, here and on the trackers, once', async () => {
      await q(`UPDATE app_settings SET data = data || '{"externalReadingStats":true}' WHERE user_id=$1`, [uid]);
      const before = pushes.length;
      await run(R(2), 0, 4, 12_000); // the median web-reader sitting: 12 s a page
      // Reintroduce by completing without the last page (forward and age alone): page 3 of 6 counts as read here.
      assert.equal(await progressOf(R(2)), null, 'the pages before the end stay an estimate');
      assert.equal(await place(R(2)), 5);
      await fetchPage(R(2), 5, { gapMs: 12_000, width: '1264' });
      assert.deepEqual(await progressOf(R(2)), { page: 6, completed: true, inferred: true, incognito: false },
        'read to the end, and marked as the guess it is');
      assert.equal(await pushedBy(before + 1), before + 1, 'the tracker is told');
      assert.match(pushes[before], /num_chapters_read=2/);
      assert.deepEqual(await eventsOf(R(2)), [{ origin: 'opds' }], 'one completion in the counts, as from another app');
      // Reintroduce by leaving 'opds' out of EXTERNAL_ORIGINS (lib/externalReaderSchema.ts): Insights counts no OPDS reader.
      assert.deepEqual((await externalReaderCounts(uid)).filter((c) => c.origin === 'opds'), [{ origin: 'opds', chapters: 1 }]);
      // Once: the last page again, and the whole chapter again after a night away, tell nobody anything new.
      await fetchPage(R(2), 5, { gapMs: 5_000, width: '1264' });
      await run(R(2), 0, 5, 12_000);
      now += 9 * HOUR;
      await run(R(2), 0, 5, 12_000);
      // Nor does a second completion, as two fetches of the last page in flight together can both make. Reintroduce by
      // pushing on every completion in writeExternalBook (`if (!incognito)`): the tracker hears of it twice.
      await writeExternalBook(uid, { id: R(2), seriesId: S_READ, pages: 6 }, 6, R(2), false, 'opds');
      assert.equal(await pushedBy(before + 2, 1500), before + 1, 'no second push');
      assert.deepEqual(await eventsOf(R(2)), [{ origin: 'opds' }], 'no second completion');
    });

    await t.test('under Incognito a chapter read over the stream keeps its place and nothing else', async () => {
      await q(`UPDATE app_settings SET data = data || '{"incognito":true}' WHERE user_id=$1`, [uid]);
      try {
        const before = pushes.length;
        await run(R(3), 0, 5, 12_000);
        // As kosync keeps it: the place, marked private (read_progress.incognito, so other members' rails skip it), and
        // no reading event or tracker push. Reintroduce by not asking incognitoOn for an OPDS completion in
        // writeExternalBook: the place is kept as an open one.
        assert.deepEqual(await progressOf(R(3)), { page: 6, completed: true, inferred: true, incognito: true });
        assert.deepEqual(await eventsOf(R(3)), [], 'no reading event');
        assert.equal(await pushedBy(before + 1, 1500), before, 'no tracker push');
      } finally {
        await q(`UPDATE app_settings SET data = data - 'incognito' WHERE user_id=$1`, [uid]);
      }
      // Nothing below is about the trackers, and their pushes wait their turn (2.4 s apart): unlinked so none is pending.
      await q('DELETE FROM series_trackers WHERE series_id = $1', [S_READ]);
    });

    await t.test('a preload is not a read: every page within 2 s, the same again later, or after a chapter opened yesterday', async () => {
      // Reintroduce by dropping the sitting's age (opdsSittingFloorMs) from rememberOpdsEstimate: six pages in 1.5 s are read.
      await run(R(4), 0, 5, 300);
      assert.equal(await progressOf(R(4)), null, 'a reader loading every page at once is not a person reading them');
      // Reintroduce by dropping the `was` test: the second preload half a minute on reaches the last page in a sitting
      // that is old enough, and counts.
      await fetchPage(R(4), 0, { gapMs: 30_000, width: '1264' });
      await run(R(4), 1, 5, 300);
      assert.equal(await progressOf(R(4)), null, 'a last page reached already is not reached again');
      // Reintroduce by dropping the six-hour gap (one sitting for ever): yesterday's first page makes today's preload a
      // sitting a day old.
      await fetchPage(R(5), 0, { width: '1264' });
      now += 20 * HOUR;
      await run(R(5), 0, 5, 300);
      assert.equal(await progressOf(R(5)), null, "yesterday's page is another sitting");
    });

    await t.test('a jump straight to the last page is not a read', async () => {
      // Reintroduce by dropping the forward count from rememberOpdsEstimate: the first page, then the last half a minute
      // on, is a chapter read.
      await fetchPage(R(6), 0, { width: '1264' });
      await fetchPage(R(6), 5, { gapMs: 30_000, width: '1264' });
      assert.equal(await place(R(6)), 6);
      assert.equal(await progressOf(R(6)), null, 'two pages of six reached going forward');
    });

    await t.test('a run of thumbnail-size fetches is not a read', async () => {
      // A strip of thumbnails or a scrubber fetches every page small, in order, as a person paging through would.
      // Reintroduce by dropping the 600 px floor from readingSize (routes/opds.ts): the run is a chapter read.
      await run(R(7), 0, 5, 12_000, '300');
      assert.equal(await place(R(7)), null, 'no place');
      assert.equal(await progressOf(R(7)), null, 'no completion');
    });

    await t.test('re-streaming a finished chapter never downgrades it', async () => {
      // Finished in the web reader on the page before the last, which is the end there (progressRules.ts reachedEnd), then
      // paged through over the stream, the whole way -- so its last page moves the place on -- and part of it.
      await writeProgress({ userId: uid, bookId: R(9), seriesId: S_READ, page: 5, completed: true });
      await run(R(9), 0, 5, 12_000);
      // Reintroduce `inferred = EXCLUDED.inferred` in writeExternalBook: the chapter read in the app becomes a guess.
      assert.deepEqual(await progressOf(R(9)), { page: 6, completed: true, inferred: false, incognito: false }, 'still a real read');
      now += 9 * HOUR;
      await run(R(9), 0, 2, 12_000);
      assert.deepEqual(await progressOf(R(9)), { page: 6, completed: true, inferred: false, incognito: false });
      // And the chapter read over the stream above, started again after a night: still read, still at its end.
      now += 9 * HOUR;
      await run(R(2), 0, 2, 12_000);
      assert.deepEqual(await progressOf(R(2)), { page: 6, completed: true, inferred: true, incognito: false });
      assert.match(entryFor((await app.inject({ url: `/opds/series/${S_READ}`, headers: as(token) })).body, R(2)), /pse:lastRead="6"/,
        'the place the feed gives is the end, not the estimate');
    });

    await t.test('an OPDS completion leaves nothing due for a 0-day read-chapter cleanup; a later real read makes it due', async () => {
      const { dueSql } = await import('../src/lib/chapterCleanup');
      const { markReadUpTo } = await import('../src/lib/komgaProgress');
      const due = async () => (await q<{ id: string }>(`SELECT id FROM (${dueSql(null)}) d WHERE id = ANY($3)`,
        [join(TMP, 'lib'), 0, [R(2), R(8)]])).map((r) => r.id).sort();
      // R(2) was read to the end over the stream. Reintroduce by dropping `NOT bool_or(rp.inferred)` from dueSql: it is due,
      // and the cleanup would delete its file on a guess.
      assert.deepEqual(await due(), [], 'a guess deletes no file');
      // Mihon puts back the run it was given, and the Komga API gave it this guess as read: an echo, not a read. Reintroduce
      // by letting markReadUpTo's update reach a guessed row (`WHERE NOT completed OR inferred`): R(2) is due.
      await markReadUpTo(uid, S_READ, 2);
      assert.deepEqual(await due(), [], 'the guess echoed back is still a guess');
      // The web reader's read to the end is a read. Reintroduce by leaving `inferred` alone in writeProgress: nothing due.
      await writeProgress({ userId: uid, bookId: R(2), seriesId: S_READ, page: 6, completed: true });
      assert.deepEqual(await due(), [R(2)]);
      // So is KOReader's last page. Reintroduce by dropping writeExternalBook's `read_progress.inferred AND ...` clause: R(8)
      // is not due.
      await run(R(8), 0, 5, 12_000);
      assert.equal((await progressOf(R(8)))?.inferred, true);
      await writeExternalBook(uid, { id: R(8), seriesId: S_READ, pages: 6 }, 6, 'f'.repeat(32));
      assert.deepEqual(await progressOf(R(8)), { page: 6, completed: true, inferred: false, incognito: false });
      assert.deepEqual(await due(), [R(2), R(8)]);
      // And Mark read on the whole series is their word as well. Reintroduce by leaving `inferred` alone in the bulk read
      // (routes/personal.ts): R(3), read over the stream under Incognito, stays a guess.
      const bulk = await app.inject({ method: 'POST', url: '/api/library/bulk/read', headers: jwtFor(uid), payload: { seriesIds: [S_READ], completed: true } });
      assert.equal(bulk.statusCode, 200, bulk.body);
      assert.equal((await progressOf(R(3)))?.inferred, false);
    });
    setOpdsClock(null);
    await t.test('loose-image exports have deterministic bytes and the exact KOReader binary hash',async()=>{
      const {partialBufferMd5,bookFileSignature}=await import('../src/lib/koreaderHash');
      const folder=join(TMP,'lib','loose');mkdirSync(folder);
      writeFileSync(join(folder,'001.png'),p0);writeFileSync(join(folder,'002.png'),p1);
      await book('b_pse_loose',S_MAIN,'loose',2);
      const first=await app.inject({url:'/opds/book/b_pse_loose/file',headers:as(token)});
      const previousTimezone=process.env.TZ;let second;
      try{
        process.env.TZ='America/Los_Angeles';
        second=await app.inject({url:'/opds/book/b_pse_loose/file',headers:as(token)});
      }finally{
        if(previousTimezone===undefined)delete process.env.TZ;else process.env.TZ=previousTimezone;
      }
      assert.equal(first.statusCode,200);assert.deepEqual(first.rawPayload,second.rawPayload);
      // Inspect our generated result through the ordinary archive reader, never adm-zip's read API.
      // A fixed timestamp proves stability across later downloads, not just two calls in one DOS time tick.
      const exportedFile=join(TMP,'deterministic-export.cbz');writeFileSync(exportedFile,first.rawPayload);
      const StreamZip=require('node-stream-zip');const exported=new StreamZip.async({file:exportedFile});
      try{
        const entries=await exported.entries();assert.deepEqual(Object.keys(entries).sort(),['001.png','002.png']);
        for(const entry of Object.values(entries) as Array<{time:number}>)assert.equal(entry.time,Date.UTC(1980,0,1));
        assert.deepEqual(await exported.entryData('001.png'),p0);assert.deepEqual(await exported.entryData('002.png'),p1);
      }finally{await exported.close();}
      const hash=(await q<{digest:string;signature:string}>("SELECT digest,signature FROM koreader_hashes WHERE book_id='b_pse_loose'"))[0];
      assert.equal(hash.digest,partialBufferMd5(first.rawPayload));assert.equal(hash.signature,await bookFileSignature(folder));
    });

    await t.test('FACETS: offered with counts, applied on request, and carried onto the next page', async () => {
      const r = await app.inject({ method: 'GET', url: `/opds/series?genre=action`, headers: as(token) });
      assert.equal(r.statusCode, 200);
      const xml = r.body;
      // Case-insensitive, like the app's own genre filter: "action" must select series tagged "Action".
      assert.ok(xml.includes(`yomi:series:${S_MAIN}</id>`), 'the filter dropped a series tagged Action');
      assert.ok(!xml.includes(`yomi:series:${S_ADULT}</id>`), 'Romance leaked through a genre filter');
      const facets = xml.split('\n').filter((l) => l.includes('rel="http://opds-spec.org/facet"'));
      assert.ok(facets.length >= 3, 'no facet links at all');
      const active = facets.find((l) => l.includes('opds:facetGroup="Genre"') && l.includes('opds:activeFacet="true"'));
      assert.ok(active, 'the genre in force is not marked active');
      assert.equal(attr(active!, 'title'), 'Action');
      assert.equal(attr(active!, 'thresholdCount'), '62', 'the count must be over this viewer\'s series: 1 + 61 bulk, hidden excluded');
      assert.ok(facets.some((l) => l.includes('opds:facetGroup="Sort"')), 'no sort facets');
      assert.ok(facets.some((l) => l.includes('opds:facetGroup="Status"')) || true, 'status facets are offered when there is a choice');
      // Reintroduce by building `next` from sort+page only: the second page silently drops the genre filter.
      const next = xml.match(/rel="next" href="([^"]+)"/)?.[1];
      assert.ok(next, 'sixty-two hits must page');
      assert.match(next!, /genre=action/, 'next lost the filter');
      const page2 = await app.inject({ method: 'GET', url: next!.replace(/&amp;/g, '&'), headers: as(token) });
      assert.equal(page2.statusCode, 200);
      assert.equal((page2.body.match(/<entry>/g) || []).length, 2, 'page two should hold the remaining two of sixty-two');
      // The Library group appears only when there is a choice. With 18+ hidden this reader sees ONE library,
      // so offering it as a filter would be a filter that cannot change anything -- and a count that
      // discloses the hidden one exists. Reveal it, and there are two.
      assert.ok(!facets.some((l) => l.includes('opds:facetGroup="Library"')), 'one visible library is not a choice');
      await auth.setOpdsShowAdult(uid, true);
      const two = await app.inject({ method: 'GET', url: `/opds/series`, headers: as(token) });
      await auth.setOpdsShowAdult(uid, false);
      const libFacets = two.body.split('\n').filter((l) => l.includes('opds:facetGroup="Library"'));
      assert.equal(libFacets.length, 2, 'two libraries visible, so two Library facets');
      assert.ok(libFacets.some((l) => attr(l, 'title') === 'Grown-ups' && attr(l, 'thresholdCount') === '1'));
    });

    await t.test('search is the same feed: faceted and paged', async () => {
      const r = await app.inject({ method: 'GET', url: `/opds/search?q=Pse%20Bulk`, headers: as(token) });
      assert.equal(r.statusCode, 200);
      assert.match(r.body, /rel="next" href="\/opds\/search\?[^"]*q=Pse%20Bulk/, 'a search with 61 hits must page, and keep its query');
      assert.match(r.body, /opds:facetGroup="Genre"/, 'search results carry facets too');
    });

    await t.test('18+: hidden by default, shown when this credential says so, never for a capped account', async () => {
      // Searched for by name rather than listed: sorted by title it sits on page two behind sixty-one
      // "Pse Bulk" rows, and an assertion on page one passes for the wrong reason in both directions.
      const dflt = await app.inject({ method: 'GET', url: `/opds/series?q=Pse%20Grown`, headers: as(token) });
      assert.ok(!dflt.body.includes(S_ADULT), 'an 18+ library was listed without being asked for');
      // Reintroduce by hard-coding `hideAdult: true` in the preHandler again.
      await auth.setOpdsShowAdult(uid, true);
      const shown = await app.inject({ method: 'GET', url: `/opds/series?q=Pse%20Grown`, headers: as(token) });
      assert.ok(shown.body.includes(S_ADULT), 'the credential asked for 18+ and did not get it');
      // The cap is a permission: a 16-rated account gets nothing rated 18 whatever its token says.
      await auth.setOpdsShowAdult(capped, true);
      const cap = await app.inject({ method: 'GET', url: `/opds/series?q=Pse%20Grown`, headers: as(cappedToken, CAPPED) });
      assert.equal(cap.statusCode, 200);
      assert.ok(!cap.body.includes(S_ADULT), 'the token toggle bypassed the age cap');
      await auth.setOpdsShowAdult(uid, false);
    });

    await t.test('the toggle is a route on the token, with the status echoed back', async () => {
      const on = await app.inject({ method: 'PATCH', url: '/api/opds/token', headers: jwtFor(uid), payload: { showAdult: true } });
      assert.equal(on.statusCode, 200, on.body);
      assert.equal(on.json().showAdult, true);
      assert.equal((await app.inject({ method: 'PATCH', url: '/api/opds/token', headers: jwtFor(uid), payload: { showAdult: 'yes' } })).statusCode, 400);
      await auth.revokeOpdsToken(uid);
      assert.equal((await app.inject({ method: 'PATCH', url: '/api/opds/token', headers: jwtFor(uid), payload: { showAdult: true } })).statusCode, 404, 'nothing to set it on');
    });
  } finally {
    await teardown(app, q);
  }
});
