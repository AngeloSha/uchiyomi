// Ghost chapters on the Komga-compatible API (lib/komgaGhosts, server_settings.komga_ghost_chapters).
//
// The feature is one switch with two halves. The chapter LIST gains the chapters this server does not hold,
// and the PROGRESS endpoint raises `maxNumberSort` to match -- that is the chapter total the trackers read,
// and the whole point. ⚠️ It deliberately does NOT count them: the four counts stay over the real rows,
// because Mihon derives UNREAD / READING / COMPLETED from them and a chapter nobody can ever read would make
// COMPLETED unreachable (KomgaApi.kt L70-74, and `a series read to the end is still COMPLETED` below).
// The scenario the whole thing was built for is a long manhwa read up to chapter 1000 with everything behind
// it pruned, which used to tell the trackers the series had one chapter; it is `the pruned long-runner`.
//
// Over HTTP against the real plugin, because the things that can break are the route's merge order, the
// visibility gate on an id that has no row to gate on, and the interaction between the two endpoints --
// none of which a unit test of the helpers would see.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ZodError } from 'zod';

const DSN = process.env.TEST_DATABASE_URL;
const TMP = DSN ? mkdtempSync(join(tmpdir(), 'uchiyomi-kg-')) : '';
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.CACHE_DIR = join(TMP, 'cache');
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_kg_a';
/**
 * mix: 1 live, 2 tombstone, 3 live, plus ghosts 4 and 5.  long: the pruned long-runner.  solo: ghosts only.
 * ov: one chapter whose filename parsed as 0 and that an admin renumbered to 105, listed at 105 and 106.
 */
const S_MIX = 's_kg_mix', S_LONG = 's_kg_long', S_SOLO = 's_kg_solo', S_OTHER = 's_kg_other', S_OV = 's_kg_ov';
const READER = 'kg-reader', CAPPED = 'kg-capped';
const key = (t: string) => ({ 'x-api-key': t });

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const auth = await import('../src/lib/auth');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const rateLimit = (await import('@fastify/rate-limit')).default;
  const komgaCompat = (await import('../src/routes/komgaCompat')).default;
  const imageRoutes = (await import('../src/routes/images')).default;
  const sharp = (await import('sharp')).default;
  const AdmZip = require('adm-zip');

  await migrate();
  await q(`DELETE FROM users WHERE username = ANY($1)`, [[READER, CAPPED]]);
  await q(`DELETE FROM lib_series WHERE id LIKE 's_kg_%'`);
  await q(`DELETE FROM libraries WHERE id = $1`, [LIB]);

  const png = await sharp({ create: { width: 40, height: 60, channels: 3, background: '#334455' } }).png().toBuffer();
  mkdirSync(join(TMP, 'lib'), { recursive: true });
  const cbz = (name: string) => { const z = new AdmZip(); z.addFile('001.png', png); writeFileSync(join(TMP, 'lib', name), z.toBuffer()); return name; };

  const users = await q<{ id: string; username: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind, max_age_rating, disabled)
     VALUES ($1,$1,'x','user','password',NULL,false), ($2,$2,'x','user','password',16,false)
     RETURNING id, username`, [READER, CAPPED]);
  const reader = users.find((u) => u.username === READER)!.id;

  await q(`INSERT INTO libraries (id, name, path, sort_order, age_rating) VALUES ($1,'Shelf','/kg/shelf',0,NULL)`, [LIB]);
  const series = async (id: string, title: string, count: number, rating: number | null = null) =>
    q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, genres, status, author, latest_mtime, created_at, age_rating)
       VALUES ($1,'T!kg',$2,$3,$4,$5,'{Action}','ongoing','Someone',$6,'2026-01-02T03:04:05Z',$7)`,
      [id, title, `T!kg/${id}`, count, LIB, Date.parse('2026-03-04T05:06:07Z'), rating]);
  await series(S_MIX, 'Kg Mixed', 3);
  await series(S_LONG, 'Kg Long Runner', 1);
  await series(S_SOLO, 'Kg Follow Only', 0);
  await series(S_OTHER, 'Kg Rated', 1, 18); // 18-rated: the capped viewer must not reach its ghosts
  await series(S_OV, 'Kg Renumbered', 1);

  const book = (id: string, sid: string, file: string, n: number) =>
    q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root, size, updated_at)
       VALUES ($1,$2,'T!kg',$3,$4,$5,1,$6,4096,'2026-01-02T03:04:05Z')`,
      [id, sid, file, n, `Chapter ${n}`, join(TMP, 'lib')]);
  // mix: 1 live, 2 pruned tombstone, 3 live
  await book('b_kg_m1', S_MIX, cbz('m1.cbz'), 1);
  await book('b_kg_m2', S_MIX, cbz('m2.cbz'), 2);
  await book('b_kg_m3', S_MIX, cbz('m3.cbz'), 3);
  await q(`UPDATE lib_books SET pruned_at = now(), pruned_reason = 'read' WHERE id = 'b_kg_m2'`);
  // long: only chapter 1000 survives; 997..999 were read and pruned behind the reader
  await book('b_kg_l1000', S_LONG, cbz('l1000.cbz'), 1000);
  for (const n of [997, 998, 999]) {
    await book(`b_kg_l${n}`, S_LONG, cbz(`l${n}.cbz`), n);
    await q(`UPDATE lib_books SET pruned_at = now(), pruned_reason = 'read' WHERE id = $1`, [`b_kg_l${n}`]);
  }
  await book('b_kg_o1', S_OTHER, cbz('o1.cbz'), 1);
  // ov: the filename gave numFromName nothing, so the scanner stored 0 and an admin corrected it to 105 by
  // hand. The listing offers 105 and 106, so 105 is a number that IS on disk under a number that is not.
  await book('b_kg_ov1', S_OV, cbz('ov1.cbz'), 0);
  await q(`INSERT INTO book_overrides (book_id, number) VALUES ('b_kg_ov1', 105)`);

  // The listing the updater would have written. Every number the sources offered, on disk or not: the
  // anti-join is what turns the absent ones into ghosts, so the live numbers are listed here too.
  const listed = async (sid: string, numbers: number[], title = (n: number) => `Chapter ${n}`) => {
    for (const n of numbers) {
      await q(`INSERT INTO series_listing (series_id, number, title, published_at, scanlator, groups, source_id, chosen, status)
               VALUES ($1,$2,$3,'2026-02-03T04:05:06Z','Some Group','{Some Group}','src','{}'::jsonb,'available')`,
        [sid, n, title(n)]);
    }
  };
  await listed(S_MIX, [1, 2, 3, 4, 5]);          // 4 and 5 never fetched -> ghosts
  await listed(S_LONG, [997, 998, 999, 1000, 1001]); // 1001 is out; 997-999 are tombstones, not ghosts
  await listed(S_SOLO, [1, 2]);                   // a followed series with nothing on disk at all
  await listed(S_OTHER, [1, 2]);
  await listed(S_OV, [105, 106]);                 // 105 is the overridden chapter; only 106 is a ghost

  const app = Fastify();
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  app.setErrorHandler((err: any, req: any, reply: any) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'bad_request' });
    const status = err.statusCode || 500;
    if (status >= 500) { req.log.error(err); console.error('ROUTE 500:', req.url, err?.message); }
    return reply.code(status).send({ error: status >= 500 ? 'internal' : err.message || 'error' });
  });
  await app.register(rateLimit, { global: false });
  await app.register(komgaCompat);
  await app.register(imageRoutes);
  await app.ready();

  const tok = {
    read: (await auth.issueApiToken(reader, 'read', ['read'], null)).token,
    capped: (await auth.issueApiToken(users.find((u) => u.username === CAPPED)!.id, 'capped', ['read'], null)).token,
  };
  return { app, q, reader, tok };
}

async function teardown(app: any, q: any) {
  await app.close();
  await q(`UPDATE server_settings SET komga_ghost_chapters = false WHERE id = 1`).catch(() => {});
  await q(`DELETE FROM users WHERE username = ANY($1)`, [[READER, CAPPED]]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id LIKE 's_kg_%'`).catch(() => {});
  await q(`DELETE FROM libraries WHERE id = $1`, [LIB]).catch(() => {});
  rmSync(TMP, { recursive: true, force: true });
}

test('ghost chapters: the opt-in, the list, what a tap gets, and the tracker numbers', { skip }, async (t) => {
  const { app, q, reader, tok } = await setup();
  let clientSeq = 0;
  t.beforeEach(() => { clientSeq++; });
  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers, remoteAddress: `10.79.${(clientSeq >> 8) & 255}.${clientSeq & 255}` });
  const ghosts = (on: boolean) => q(`UPDATE server_settings SET komga_ghost_chapters = $1 WHERE id = 1`, [on]);
  /** The chapter list exactly as the extension asks for it. */
  const books = async (sid: string, token = tok.read) =>
    (await get(`/api/v1/series/${sid}/books?unpaged=true&media_status=READY&deleted=false`, key(token))).json();
  const complete = (bookId: string, sid: string) =>
    q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,1,true)
       ON CONFLICT (user_id, book_id) DO UPDATE SET completed = true`, [reader, bookId, sid]);
  const progress = async (sid: string, token = tok.read) =>
    (await get(`/api/v2/series/${sid}/read-progress/tachiyomi`, key(token))).json();

  try {
    // ---- off: nothing moves ---------------------------------------------------------------------------
    await t.test('off by default, and the list is exactly what it was', async () => {
      // ⚠️ The guard on the whole feature. Reintroduce by defaulting the column to true, or by dropping the
      // `ghostsEnabled()` check in the route: an install that upgrades into this finds its chapter counts
      // and tracker totals moved with nobody having asked.
      const s = await q<{ on: boolean }>(`SELECT komga_ghost_chapters AS on FROM server_settings WHERE id = 1`);
      assert.equal(s[0].on, false, 'the setting must ship off');
      const page = await books(S_MIX);
      assert.deepEqual(page.content.map((b: any) => b.number), [1, 3], 'the tombstone and the ghosts stay out');
      assert.equal(page.totalElements, 2);
      const solo = await books(S_SOLO);
      assert.equal(solo.content.length, 0, 'a follow-only series still lists nothing');
      assert.equal(solo.totalPages, 0);
    });

    await t.test('off, the progress endpoint counts only real chapters', async () => {
      const p = await progress(S_MIX);
      assert.equal(p.booksCount, 3, 'three rows on disk or tombstoned, no ghosts');
      assert.equal(p.maxNumberSort, 3);
    });

    // ---- on: the list ---------------------------------------------------------------------------------
    await t.test('on, the absent chapters join the list, in number order, labelled', async () => {
      await ghosts(true);
      const page = await books(S_MIX);
      assert.deepEqual(page.content.map((b: any) => b.number), [1, 2, 3, 4, 5],
        'ghosts merge by number rather than being appended');
      const [one, two, , four] = page.content;
      // The live chapter is untouched.
      assert.equal(one.media.status, 'READY');
      assert.equal(one.size, '4.0 KiB');
      // The tombstone: listed now, READY so the extension does not filter it, and labelled.
      assert.equal(two.id, 'b_kg_m2', 'a tombstone keeps its real id, and so its reading progress');
      assert.equal(two.media.status, 'READY', 'ERROR would be filtered out by media_status=READY');
      assert.equal(two.size, 'not downloaded');
      // The ghost: a synthetic id, no pages, the same label.
      assert.equal(four.id, 'g_s_kg_mix~4');
      assert.equal(four.media.status, 'READY');
      assert.equal(four.media.pagesCount, 0);
      assert.equal(four.size, 'not downloaded');
      assert.equal(four.sizeBytes, 0);
      assert.equal(four.name, 'Chapter 4');
      assert.equal(four.seriesTitle, 'Kg Mixed');
      // The scanlator still rides as a translator author, so the extension can show it.
      assert.deepEqual(four.metadata.authors, [{ name: 'Some Group', role: 'translator' }]);
      // ⚠️ The extension pastes `size` into `{number} - {title} ({size})` verbatim. This is the whole
      // user-visible warning, and it has to read as a sentence.
      assert.equal(`${four.number} - ${four.metadata.title} (${four.size})`, '4 - Chapter 4 (not downloaded)');
    });

    await t.test('a ghost has every field a real chapter has', async () => {
      // One missing non-nullable field fails the Kotlin decode of the WHOLE list, so a ghost cannot be a
      // thinner object than its neighbours. Reintroduce by dropping `oneshot` or a `*Lock` from
      // komgaGhostBook: this sees the difference, a phone sees an empty series.
      const page = await books(S_MIX);
      const real = page.content.find((b: any) => b.id === 'b_kg_m1');
      const ghost = page.content.find((b: any) => b.id.startsWith('g_'));
      assert.deepEqual(Object.keys(ghost).sort(), Object.keys(real).sort());
      assert.deepEqual(Object.keys(ghost.media).sort(), Object.keys(real.media).sort());
      assert.deepEqual(Object.keys(ghost.metadata).sort(), Object.keys(real.metadata).sort());
      // ⚠️ Compared against the neighbour, never against a literal: the only reason a ghost carries a media
      // type at all is to look like the rows around it, and a ghost that announced a different container
      // would be the one row in the list a client could pick out. Reintroduce by hardcoding any other type
      // in komgaGhostBook (`application/zip` is the tempting one, and is NOT what lib/ownedCatalog gives a
      // real chapter).
      assert.equal(ghost.media.mediaType, real.media.mediaType,
        'a ghost reports the same container type as the chapters beside it');
      // Dates keep the strict shape the extension parses: no Z, no millis.
      assert.match(ghost.created, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      assert.equal(ghost.metadata.releaseDate, '2026-02-03');
    });

    await t.test('a series with nothing on disk lists its chapters instead of nothing', async () => {
      // The follow-only case: before this, a followed series told the tracker it had zero chapters and
      // looked complete.
      const page = await books(S_SOLO);
      assert.deepEqual(page.content.map((b: any) => b.number), [1, 2]);
      assert.equal(page.seriesTitle, undefined);
      assert.equal(page.content[0].seriesTitle, 'Kg Follow Only',
        'the title comes from the series row, since there is no book row to take it from');
      // The unpaged envelope still has to be a page Spring could have emitted.
      assert.equal(page.size, 2);
      assert.equal(page.totalPages, 1);
      assert.equal(page.last, true);
      assert.equal(page.empty, false);
    });

    await t.test('desc keeps the merged order reversed', async () => {
      const r = await get(`/api/v1/series/${S_MIX}/books?unpaged=true&sort=metadata.numberSort,desc`, key(tok.read));
      assert.deepEqual(r.json().content.map((b: any) => b.number), [5, 4, 3, 2, 1]);
    });

    await t.test('a paged request slices the merged list, not the real rows alone', async () => {
      // The extension always asks unpaged, but Komga's own clients page, and the merge has to happen BEFORE
      // the slice or page 1 is computed from a shorter list than the envelope describes. Reintroduce by
      // slicing `rows` before the ghosts are merged in: page 1 of size 2 then answers chapter 3 alone with a
      // totalElements of 5, which is a page no Spring endpoint could have emitted.
      const page = (await get(`/api/v1/series/${S_MIX}/books?page=1&size=2&media_status=READY`, key(tok.read))).json();
      assert.deepEqual(page.content.map((b: any) => b.number), [3, 4], 'one real chapter and one ghost');
      assert.equal(page.totalElements, 5);
      assert.equal(page.totalPages, 3);
      assert.equal(page.number, 1);
      assert.equal(page.size, 2);
      assert.equal(page.first, false);
      assert.equal(page.last, false);
    });

    await t.test('a chapter an admin renumbered is listed once, not once real and once ghost', async () => {
      // ⚠️ THE ANTI-JOIN COMPARES THE OVERRIDE-AWARE NUMBER. b_kg_ov1's filename parsed as 0 and was
      // corrected to 105 by hand, and the listing offers 105 and 106. Matching the raw lib_books.number
      // leaves listing row 105 unmatched, so the same chapter comes back twice -- once as the real row at
      // 105, once as a ghost at 105 -- and the tracker counts a chapter that is on disk as missing.
      // Reintroduce by comparing `b.number = l.number` in ghostBooksFor (and ghostNumbers, for maxNumberSort).
      const page = await books(S_OV);
      assert.deepEqual(page.content.map((b: any) => b.number), [105, 106]);
      assert.equal(page.content[0].id, 'b_kg_ov1', 'the one row at 105 is the real chapter, at its real number');
      assert.equal(page.content[1].id, 'g_s_kg_ov~106', '106 is the only ghost');
      const p = await progress(S_OV);
      assert.equal(p.booksCount, 1, 'one chapter on disk');
      assert.equal(p.maxNumberSort, 106, 'and the ghost still raises the chapter total');
    });

    // ---- on: what a tap gets --------------------------------------------------------------------------
    await t.test('a ghost cannot be opened: no pages, no page bytes, no thumbnail', async () => {
      // ⚠️ NOT a placeholder image. Mihon marks a chapter read once it is viewed, so serving one page of
      // "not downloaded" would push the tracker progress this whole feature exists to keep honest.
      const id = 'g_s_kg_mix~4';
      const pages = await get(`/api/v1/books/${id}/pages`, key(tok.read));
      assert.equal(pages.statusCode, 200);
      assert.deepEqual(pages.json(), [], 'an empty page list is what Mihon turns into its own error');
      assert.equal((await get(`/api/v1/books/${id}/pages/1`, key(tok.read))).statusCode, 404);
      assert.equal((await get(`/api/v1/books/${id}/thumbnail`, key(tok.read))).statusCode, 404);
      // The single-book route still resolves it, because the list just handed the id out.
      const one = await get(`/api/v1/books/${id}`, key(tok.read));
      assert.equal(one.statusCode, 200);
      assert.equal(one.json().size, 'not downloaded');
    });

    await t.test('a tombstone still cannot be opened either', async () => {
      const pages = await get('/api/v1/books/b_kg_m2/pages', key(tok.read));
      assert.deepEqual(pages.json(), [], 'the file is gone; page_dims is a cache that outlives it');
      // ⚠️ And it must not advertise the pages it no longer has. The row was stamped with 1 page when the
      // file was here; listed under the opt-in it has to say 0, exactly as a ghost does, or Mihon opens a
      // chapter that claims a page and finds none instead of showing its own empty-chapter error.
      // Reintroduce by returning `int(dto.media?.pagesCount)` unconditionally in komgaBook.
      const one = (await get('/api/v1/books/b_kg_m2', key(tok.read))).json();
      assert.equal(one.media.pagesCount, 0, 'a listed tombstone reports no pages, like the ghosts beside it');
      assert.equal(one.size, 'not downloaded');
      const inList = (await books(S_MIX)).content.find((b: any) => b.id === 'b_kg_m2');
      assert.equal(inList.media.pagesCount, 0, 'and says the same thing in the list as on its own');
    });

    await t.test('a ghost id for a series the viewer cannot see is 404, not a disclosure', async () => {
      // ⚠️ THE SECURITY CASE. A ghost id is the only book id with no row behind it, so nothing can be looked
      // up to decide who may see it -- the series id is carried IN the id and put through seriesVisible.
      // Reintroduce by trusting the parsed id in ghostBookById: a capped viewer then reads the chapter
      // numbers, titles and dates of an 18-rated series they cannot open.
      const id = 'g_s_kg_other~2';
      assert.equal((await get(`/api/v1/books/${id}`, key(tok.capped))).statusCode, 404);
      assert.equal((await get(`/api/v1/books/${id}/pages`, key(tok.capped))).statusCode, 404);
      // The uncapped reader does see it, so the 404 above is the cap and not a broken id.
      assert.equal((await get(`/api/v1/books/${id}`, key(tok.read))).statusCode, 200);
    });

    await t.test('a ghost id for a number the listing no longer has is 404', async () => {
      assert.equal((await get('/api/v1/books/g_s_kg_mix~999', key(tok.read))).statusCode, 404);
      // And a number that IS on disk is never a ghost: it has a real row, so the anti-join excludes it.
      assert.equal((await get('/api/v1/books/g_s_kg_mix~1', key(tok.read))).statusCode, 404);
    });

    // ---- on: the tracker numbers ----------------------------------------------------------------------
    await t.test('the pruned long-runner: read to 1000, everything behind it deleted', async () => {
      // ⚠️ THE SCENARIO THE FEATURE EXISTS FOR. 997-999 are tombstones (read, then the cleanup took the
      // bytes) and 1001 is listed but never fetched. The tracker must see a 1000-chapter series read to
      // 1000 -- and it must keep seeing it after 1001 appears, because a ghost can never be marked read.
      for (const n of [997, 998, 999, 1000]) await complete(`b_kg_l${n}`, S_LONG);
      const p = await progress(S_LONG);
      assert.equal(p.booksCount, 4, 'the four rows this server has; the ghost at 1001 is not one of them');
      assert.equal(p.booksReadCount, 4);
      assert.equal(p.booksUnreadCount, 0, 'a ghost is not an unread chapter -- see the COMPLETED rule below');
      assert.equal(p.maxNumberSort, 1001, 'the chapter total Mihon reports to the trackers');
      assert.equal(p.lastReadContinuousNumberSort, 1000,
        'the tombstones are read and do not break the run; the ghost at 1001 is past it');
      // The LIST is deliberately one row longer than the counts: being listed is what gives the series its
      // chapter total, while being counted is what would cost it its status.
      const page = await books(S_LONG);
      assert.deepEqual(page.content.map((b: any) => b.number), [997, 998, 999, 1000, 1001]);
      assert.equal(page.totalElements, p.booksCount + 1);
    });

    await t.test('a series read to the end is still COMPLETED once a ghost appears', async () => {
      // ⚠️ THE ONE THE COUNTS EXIST FOR. Mihon is not told a status; it computes one from the numbers above:
      //   when (booksCount) { booksUnreadCount -> UNREAD; booksReadCount -> COMPLETED; else -> READING }
      // (KomgaApi.kt L70-74). A ghost can never be read -- there is no row for a PUT to mark -- so counting
      // ghosts in booksCount makes `booksReadCount == booksCount` unreachable and a finished series READING
      // for ever, on the very long runner this feature was built for. Reintroduce by returning `all.length`
      // for booksCount (or for booksUnreadCount) in readProgressV2: the assertion below reads READING.
      const status = (p: any) => (p.booksCount === p.booksUnreadCount ? 'UNREAD'
        : p.booksCount === p.booksReadCount ? 'COMPLETED' : 'READING');
      const on = await progress(S_LONG);
      assert.equal(status(on), 'COMPLETED', 'every chapter this server holds is read');
      // The same series with the switch off, so the comparison is the switch and nothing else.
      await ghosts(false);
      const off = await progress(S_LONG);
      assert.equal(status(off), 'COMPLETED');
      assert.deepEqual(
        [on.booksCount, on.booksReadCount, on.booksUnreadCount, on.booksInProgressCount],
        [off.booksCount, off.booksReadCount, off.booksUnreadCount, off.booksInProgressCount],
        'the switch moves no count at all',
      );
      assert.equal(on.maxNumberSort, 1001, 'only the chapter total moves, which is the whole benefit');
      assert.equal(off.maxNumberSort, 1000);
      await ghosts(true);
    });

    await t.test('a ghost in the MIDDLE never stalls the run', async () => {
      // ⚠️ THE SUBTLE ONE. Chapter 4 is a ghost and 5 is a ghost; 1, 2 and 3 are read. If a ghost broke the
      // leading run the way an unread chapter does, this would report 3 -- correct here, but on a series
      // where the gap is at chapter 5 of 1000 it reports 4 forever and drags the tracker back to 4 on the
      // next sync, because nothing can ever mark a ghost read. Reintroduce by dropping the `if (r.ghost)
      // continue` in readProgressV2 and seeding a ghost below the read chapters.
      await q(`INSERT INTO series_listing (series_id, number, title, source_id, chosen, status)
               VALUES ($1, 1.5, 'Chapter 1.5', 'src', '{}'::jsonb, 'available')`, [S_MIX]);
      for (const id of ['b_kg_m1', 'b_kg_m2', 'b_kg_m3']) await complete(id, S_MIX);
      const p = await progress(S_MIX);
      assert.equal(p.lastReadContinuousNumberSort, 3,
        'the run reads straight through the ghost at 1.5 to the last real completed chapter');
      assert.equal(p.booksCount, 3, 'the 3 rows; the ghosts at 1.5, 4 and 5 are listed, never counted');
      assert.equal(p.maxNumberSort, 5);
      // A fractional number survives the id round trip: `~` separates the series from the number and the
      // decimal stays a `.`, so nothing has to be guessed back apart.
      const page = await books(S_MIX);
      const half = page.content.find((b: any) => b.number === 1.5);
      assert.equal(half.id, 'g_s_kg_mix~1.5');
      assert.equal((await get(`/api/v1/books/${half.id}`, key(tok.read))).statusCode, 200);
      await q(`DELETE FROM series_listing WHERE series_id = $1 AND number = 1.5`, [S_MIX]);
    });

    await t.test('the series DTO carries the same counts as the progress endpoint', async () => {
      // `/api/v1/series/:id` is what the extension shows at a glance AND what the tracker's getTrackSearch
      // reads, and it takes its three read counts from readProgressV2 -- so an unread count that included
      // the ghosts at 4 and 5 would tell a reader who has finished this series that two chapters are still
      // waiting, and they would never be able to clear them. Reintroduce by counting ghosts in
      // booksUnreadCount: this reads 2 and the series never looks finished anywhere.
      const s = (await get(`/api/v1/series/${S_MIX}`, key(tok.read))).json();
      assert.equal(s.booksCount, 3, 'the chapters this server has rows for (lib_series.books_count)');
      assert.equal(s.booksReadCount, 3);
      assert.equal(s.booksUnreadCount, 0, 'a ghost is not an unread chapter of this library');
      assert.equal(s.booksInProgressCount, 0);
    });

    await t.test('turning it back off restores the old answers at once', async () => {
      // No cache to invalidate and no restart: the setting is re-read per request, like every other one.
      await ghosts(false);
      const page = await books(S_MIX);
      assert.deepEqual(page.content.map((b: any) => b.number), [1, 3]);
      assert.equal((await get('/api/v1/books/g_s_kg_mix~4', key(tok.read))).statusCode, 404);
      const p = await progress(S_MIX);
      assert.equal(p.booksCount, 3);
      assert.equal(p.maxNumberSort, 3);
    });
  } finally {
    await teardown(app, q);
  }
});
