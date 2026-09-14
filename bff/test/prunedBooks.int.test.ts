// A tombstone is LISTED but never SERVED.
//
// The read-chapter cleanup (lib/chapterCleanup.ts) deletes a chapter's file and keeps its row, marked
// pruned_at, so that reading history and the updater's have-set survive. That leaves a row with no pages
// behind it in a table that every surface reads as "a chapter you can open". Each surface below used to
// hand one out: next/previous walked onto it, Continue Reading offered it, the OPDS feed advertised a CBZ
// that 404s, the offline manifest promised pages, and the two backfills tried to open its file once per
// run, forever. This file pins the rule at every one of those sites, against real rows.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// A viewer that sees every library. Written out rather than imported because importing from src/lib pulls
// in env.ts, which validates the environment at module load, before the block below has set DATABASE_URL.
const SYSTEM_CTX = { userId: null, libraryIds: null, maxAgeRating: null } as const;

const DSN = process.env.TEST_DATABASE_URL;
const TMP = join(tmpdir(), `uchiyomi-prn-${process.pid}`);
const ROOT = join(TMP, 'lib');
const DL = join(TMP, 'dl');

if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.CACHE_DIR = join(TMP, 'cache'); // serveImage writes here; never the live cache
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LIBRARY_ROOT = ROOT;
  process.env.DL_ROOT = DL;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let owned: any;
let tombstoneBooks: (ids: string[]) => Promise<void>;
let app: any;
let uid: string;
let jwtHeaders: Record<string, string>;
let imgCookie = '';
let IMG_COOKIE = '';
let opdsHeaders: Record<string, string>;

const S = 's_prn_series';
const FOLDER = 'T!prn/Pruned';
const B = { one: 'b_prn_1', two: 'b_prn_2', three: 'b_prn_3', lib: 'b_prn_lib' };
const USER = 'prn-user';

const exists = (p: string) => stat(p).then(() => true).catch(() => false);

/** A real one-page archive, so a live chapter's manifest and page count are checkable against bytes. */
async function cbz(abs: string) {
  const sharp = (await import('sharp')).default;
  const png = await sharp({ create: { width: 300, height: 400, channels: 3, background: '#224466' } }).png().toBuffer();
  const z = new AdmZip();
  z.addFile('001.png', png);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, z.toBuffer());
}

/**
 * Three downloaded chapters and one from the read library. The rows are inserted the way persistScan would
 * write them (file relative to its root, ON CONFLICT (root, file)), so a scan in a test keeps their ids.
 */
async function seed() {
  for (const n of [1, 2, 3]) await cbz(join(DL, FOLDER, `ch${n}.cbz`));
  // Numbered like the others: a scan re-derives `number` from the file name, and an unnumbered name reads as 0.
  await cbz(join(ROOT, FOLDER, 'ch4.cbz'));
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!prn','Pruned Test',$2,4)`, [S, FOLDER]);
  const book = (id: string, n: number, file: string, root: string) =>
    q(
      `INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root)
       VALUES ($1,$2,'T!prn',$3,$4,$5,1,$6)`,
      [id, S, file, n, `Chapter ${n}`, root],
    );
  await book(B.one, 1, `${FOLDER}/ch1.cbz`, DL);
  await book(B.two, 2, `${FOLDER}/ch2.cbz`, DL);
  await book(B.three, 3, `${FOLDER}/ch3.cbz`, DL);
  await book(B.lib, 4, `${FOLDER}/ch4.cbz`, ROOT);
  // The cover is set after the books exist: fk_lib_series_cover_book_id rejects a book that is not there yet.
  await q('UPDATE lib_series SET cover_book_id = $2 WHERE id = $1', [S, B.one]);
}

async function progress(bookId: string, completed: boolean) {
  await q(
    `INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at)
     VALUES ($1,$2,$3,0,$4, now())
     ON CONFLICT (user_id, book_id) DO UPDATE SET completed = EXCLUDED.completed, updated_at = now()`,
    [uid, bookId, S, completed],
  );
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ owned } = (await import('../src/lib/ownedCatalog')) as any);
  ({ tombstoneBooks } = await import('../src/lib/chapterCleanup'));
  const auth = await import('../src/lib/auth');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const catalogRoutes = (await import('../src/routes/catalog')).default;
  const downloadRoutes = (await import('../src/routes/downloads')).default;
  const opdsRoutes = (await import('../src/routes/opds')).default;
  await migrate();

  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  uid = (await q<{ id: string }>(
    `INSERT INTO users (display_name, username, role, password_hash, auth_kind)
     VALUES ($1,$1,'user','x','password') RETURNING id`,
    [USER],
  ))[0].id;

  const cookie = (await import('@fastify/cookie')).default;
  const imageRoutes = (await import('../src/routes/images')).default;
  ({ IMG_COOKIE } = await import('../src/lib/auth'));
  app = Fastify();
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(catalogRoutes);
  await app.register(downloadRoutes);
  await app.register(opdsRoutes);
  await app.register(imageRoutes);
  await app.ready();
  jwtHeaders = { authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'user' })}` };
  imgCookie = `${IMG_COOKIE}=${app.jwt.sign({ sub: uid, typ: 'img' })}`;
  // OPDS authenticates with HTTP Basic where the password is a per-user token, not the JWT.
  const t0 = await auth.issueOpdsToken(uid);
  opdsHeaders = { authorization: 'Basic ' + Buffer.from(`${USER}:${typeof t0 === 'string' ? t0 : (t0 as any).token}`).toString('base64') };
});

beforeEach(async () => {
  if (!DSN) return;
  await q('DELETE FROM read_progress WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
  await seed();
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM read_progress WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
});

/** The <entry> block whose <id> ends with this id. */
const entryFor = (xml: string, id: string) => xml.split('<entry>').find((e) => e.includes(`:${id}</id>`)) || '';

test('next and previous skip a deleted chapter', { skip }, async () => {
  // Reintroduce by deleting `AND bk.pruned_at IS NULL` from adjacentBook in lib/ownedCatalog.ts: next of 1
  // is 2, a chapter with no pages, and the reader's "next chapter" button lands on a 404.
  await tombstoneBooks([B.two]);
  assert.equal((await owned.bookNext(SYSTEM_CTX, B.one)).id, B.three, 'next of chapter 1 must be 3, not the tombstone');
  assert.equal((await owned.bookPrevious(SYSTEM_CTX, B.three)).id, B.one, 'previous of chapter 3 must be 1, not the tombstone');
  // The tombstone's own neighbours are still meaningful: a reader who was IN chapter 2 when it went can step out.
  assert.equal((await owned.bookNext(SYSTEM_CTX, B.two)).id, B.three);
  assert.equal((await owned.bookPrevious(SYSTEM_CTX, B.two)).id, B.one);
});

test('Continue reading never offers a deleted chapter', { skip }, async () => {
  const onDeck = async () => {
    const r = await app.inject({ method: 'GET', url: '/api/home', headers: jwtHeaders });
    assert.equal(r.statusCode, 200);
    return (r.json().onDeck as any[]).filter((b) => b.seriesId === S).map((b) => b.id);
  };

  // Finished chapter 1: the rail offers the lowest chapter not yet finished. With 2 deleted, that is 3.
  // Reintroduce by deleting `AND b.pruned_at IS NULL` from the fallback subquery in routes/catalog.ts.
  await progress(B.one, true);
  await tombstoneBooks([B.two]);
  assert.deepEqual(await onDeck(), [B.three], 'the "next unread" pick must step over the tombstone');

  // Part-way through chapter 2 when it was deleted: the progress row survives (by design), so the pick
  // itself is the tombstone. The resolved list is where it is caught.
  // Reintroduce by dropping `!b.pruned` from the filter on the resolved books.
  await progress(B.two, false);
  assert.deepEqual(await onDeck(), [], 'a part-read tombstone must not be offered as the place to continue');
});

test('the OPDS chapter feed omits a deleted chapter', { skip }, async () => {
  // Reintroduce by deleting `AND b.pruned_at IS NULL` from the /opds/series/:id query in routes/opds.ts: the
  // tombstone is advertised as a downloadable CBZ, and, its page count being reset, stat'ed on every fetch.
  await tombstoneBooks([B.two]);
  const r = await app.inject({ method: 'GET', url: `/opds/series/${S}`, headers: opdsHeaders });
  assert.equal(r.statusCode, 200);
  assert.ok(entryFor(r.body, B.one), 'a live chapter is listed');
  assert.ok(entryFor(r.body, B.three), 'a live chapter is listed');
  assert.equal(entryFor(r.body, B.two), '', 'the tombstone was advertised to an OPDS reader');
});

test('the download manifest of a deleted chapter answers 410', { skip }, async () => {
  // 410, not 404: the chapter exists and is listed, it is its pages that are gone. The client shows why
  // instead of saving a zero-page chapter.
  // Reintroduce by deleting the `book.pruned` check in routes/downloads.ts.
  await tombstoneBooks([B.two]);
  const live = await app.inject({ method: 'GET', url: `/api/books/${B.one}/download-manifest`, headers: jwtHeaders });
  assert.equal(live.statusCode, 200, 'a live chapter still has a manifest');
  assert.equal(live.json().pages.length, 1);
  const gone = await app.inject({ method: 'GET', url: `/api/books/${B.two}/download-manifest`, headers: jwtHeaders });
  assert.equal(gone.statusCode, 410);
  assert.equal(gone.json().error, 'pruned');
});

test("a deleted chapter's thumbnail is a 404, not a server error", { skip }, async () => {
  // Every chapter row asked for its thumbnail regardless of the tombstone (it no longer does), and the
  // reader's page images still can: a file that is not there is a 404, not the ENOENT-as-500 that showed
  // up in the log and the browser console once per deleted row on every visit.
  // Reintroduce by calling cbzPageAt directly in serveLibBookThumb (routes/images.ts): 500.
  await tombstoneBooks([B.two]);
  await rm(join(DL, FOLDER, 'ch2.cbz'));   // a tombstone's file is GONE; the mark alone still has bytes behind it
  const gone = await app.inject({ method: 'GET', url: `/img/books/${B.two}/thumb`, headers: { cookie: imgCookie } });
  assert.equal(gone.statusCode, 404, `thumb of a tombstone: ${gone.statusCode}`);
  const page = await app.inject({ method: 'GET', url: `/img/books/${B.two}/page/1`, headers: { cookie: imgCookie } });
  assert.equal(page.statusCode, 404, `page of a tombstone: ${page.statusCode}`);
  const live = await app.inject({ method: 'GET', url: `/img/books/${B.one}/thumb`, headers: { cookie: imgCookie } });
  assert.equal(live.statusCode, 200, 'a live chapter still has a thumbnail');
});

test('the book DTO says whether Uchiyomi downloaded it', { skip }, async () => {
  // Only a chapter under DL_ROOT may be deleted from the server or fetched again; the web greys the buttons
  // per row from this flag. Reintroduce by removing `owned` from bookDto in lib/ownedCatalog.ts.
  //
  // THE BOOK COLUMN-LIST TRAP applies to the flag beside it: removing `b.pruned_at` from booksSrc's inner
  // SELECT gives bookDto no error of its own -- `pruned` simply reads false for every tombstone, and it is
  // the "a tombstone must say so" assertion below that catches it. (adjacentBook and bookPages happen to
  // name the column in SQL and fail loudly; the DTO leg would not.)
  const one = await owned.book(SYSTEM_CTX, B.one);
  assert.equal(one.owned, true, 'a chapter under DL_ROOT is ours');
  assert.equal(one.pruned, false);
  const lib = await owned.book(SYSTEM_CTX, B.lib);
  assert.equal(lib.owned, false, 'a chapter from the read library is not ours to delete or re-fetch');
  await tombstoneBooks([B.two]);
  const two = await owned.book(SYSTEM_CTX, B.two);
  assert.equal(two.pruned, true, 'a tombstone must say so');
  assert.equal(two.owned, true, 'still ours: a tombstone can be fetched again');
  // The list path reads through the same column list; both DTO producers have to agree.
  const listed = (await owned.seriesBooks(SYSTEM_CTX, S, 0, 50)).content;
  assert.deepEqual(
    listed.map((b: any) => [b.id, b.owned, b.pruned]),
    [[B.one, true, false], [B.two, true, true], [B.three, true, false], [B.lib, false, false]],
  );
});

test('the cover moves to the next live chapter', { skip }, async () => {
  // Every thumbnail falls back to the cover chapter's first page. The cleanup vetoes the cover chapter, but
  // an admin's manual delete does not, so the scan's cover pick has to prefer a live chapter.
  // Reintroduce by dropping `(pruned_at IS NOT NULL),` from the ORDER BY in persistScan's cover UPDATE in
  // lib/library.ts: the cover stays on chapter 1, whose first page no longer exists.
  await rm(join(DL, FOLDER, 'ch1.cbz'));
  await tombstoneBooks([B.one]);
  const { persistScan } = await import('../src/lib/library');
  await persistScan();
  const [s] = await q<{ cover_book_id: string }>('SELECT cover_book_id FROM lib_series WHERE id = $1', [S]);
  assert.equal(s.cover_book_id, B.two, 'the cover must follow the lowest LIVE chapter');
  // The scan must not have resurrected the tombstone: its file is gone.
  const [b] = await q<{ pruned_at: string | null }>('SELECT pruned_at FROM lib_books WHERE id = $1', [B.one]);
  assert.ok(b.pruned_at, 'a scan that did not find the file must leave the mark');
  assert.equal(await exists(join(DL, FOLDER, 'ch1.cbz')), false);
});
