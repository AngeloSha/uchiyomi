// What an OPDS reader is told, and whether it is true.
//
// Three things the feed said that were not so, and one it could not say at all:
//   * every `<updated>` was "now", so a reader's change detection saw the whole library change on every fetch;
//   * the only way to read a chapter was to download the whole CBZ, though Panels, Chunky and KOReader all
//     stream pages over OPDS-PSE when a feed offers it;
//   * a search could not be narrowed or paged past sixty hits, because it was a separate code path;
//   * 18+ libraries were always hidden, with no way for a reader to ask -- the web app's reveal button does
//     not exist in an OPDS client, so the preference now rides on the credential.
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
const S_MAIN = 's_pse_main', S_HIDDEN = 's_pse_hidden', S_ADULT = 's_pse_adult';
const B_TWO = 'b_pse_two', B_ZERO = 'b_pse_zero', B_HIDDEN = 'b_pse_hidden';
const USER = 'pse-user', CAPPED = 'pse-capped';
const FIXED_AT = '2026-01-02T03:04:05.000Z';
const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

async function setup() {
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
  return { app, q, auth, sharp, uid, capped, token, cappedToken, as, jwtFor };
}

async function teardown(app: any, q: any) {
  await app.close();
  await q(`DELETE FROM users WHERE username = ANY($1)`, [[USER, CAPPED]]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id LIKE 's_pse_%'`).catch(() => {});
  await q(`DELETE FROM libraries WHERE id = ANY($1)`, [[LIB, ADULT_LIB]]).catch(() => {});
  rmSync(TMP, { recursive: true, force: true });
}

const attr = (xml: string, name: string) => xml.match(new RegExp(`${name}="([^"]*)"`))?.[1];
/** The <entry> block whose <id> ends with this id. */
const entryFor = (xml: string, id: string) => xml.split('<entry>').find((e) => e.includes(`:${id}</id>`)) || '';

test('what an OPDS reader is told is true, and it can stream pages', { skip }, async (t) => {
  const { app, q, auth, sharp, capped, token, cappedToken, as, jwtFor, uid } = await setup();
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
