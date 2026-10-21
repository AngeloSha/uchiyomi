// The read-chapter cleanup deletes the chapter a series' cover is drawn from, and keeps its page as the cover (v0.97.0,
// #332, @TIGamingTV).
//
// That chapter used to be vetoed outright, so every series kept its lowest chapter for ever, read or not: @TIGamingTV's
// `[cleanup]` lines said 30 of his 34 read chapters stayed for it, on series whose cover comes from their source and not
// from that chapter at all. The owner: delete the chapter, and keep the cover where it needs keeping. So where a series'
// cover IS its first page (no picture of its own, or Use the first page chosen), the job copies that page into the series'
// art before the chapter goes (lib/seriesArt.ts keepCoverPage), and the cover route reads it ahead of any chapter
// (routes/images.ts firstPageInput).
//
// Asserted against a real database, real archives and the real cover route: the chapter goes and the cover stays the
// same picture, after the cover chapter moves on too; a page kept already is not replaced by the next chapter's; a series
// with a picture of its own keeps no page, and Use the first page keeps one; behind a number hidden by hand, the page kept
// is the one the cover shows; a page that cannot be written keeps the chapter for the next run, and a chapter with no
// page to read still goes.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const TMP = join(tmpdir(), `uchiyomi-ccp-${process.pid}`);
const ROOT = join(TMP, 'lib');
const DL = join(TMP, 'dl');
const CACHE = join(TMP, 'cache');
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.CACHE_DIR = CACHE; // serveImage writes here; never the live cache
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LIBRARY_ROOT = ROOT;
  process.env.DL_ROOT = DL;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let cc: typeof import('../src/lib/chapterCleanup');
let notice: typeof import('../src/lib/noticeChapters');
let keptFile = '';
let app: any;
let imgCookie = '';

const S = 's_ccp_series';
const FOLDER = 'T!ccp/Kept';
const USER = 'ccp-alice';
const B = { 1: 'b_ccp_1', 2: 'b_ccp_2', 3: 'b_ccp_3' } as const;
/** Each chapter's one page has a colour of its own, so the cover's colour says which page it is. */
const COLOUR = { 1: '#cc2222', 2: '#2222cc', 3: '#22cc22' } as const;
const page: Record<number, Buffer> = {};
/** The files landed ten days ago, as a download would have: a realistic mtime, not 1970. */
const LANDED_AT = Date.now() - 10 * 86_400_000;
const exists = (p: string) => stat(p).then(() => true, () => false);
const fileOf = (n: number) => join(DL, FOLDER, `ch${n}.cbz`);

/** A series of three downloaded chapters, one page each, chapter 1 its cover chapter, with no cover picture of its own. */
async function fresh() {
  await q('DELETE FROM read_progress WHERE series_id = $1', [S]);
  await q('UPDATE lib_series SET cover_book_id = NULL WHERE id = $1', [S]);
  await q('DELETE FROM lib_books WHERE series_id = $1', [S]);
  await q('DELETE FROM lib_series WHERE id = $1', [S]);
  await rm(TMP, { recursive: true, force: true });
  await rm(keptFile, { force: true });
  await rm(`${keptFile}.part`, { recursive: true, force: true });
  notice.setHiddenNumbersActive(false);
  const sharp = (await import('sharp')).default;
  await mkdir(join(DL, FOLDER), { recursive: true });
  await mkdir(ROOT, { recursive: true });
  for (const n of [1, 2, 3] as const) {
    page[n] = await sharp({ create: { width: 300, height: 400, channels: 3, background: COLOUR[n] } }).png().toBuffer();
    const z = new AdmZip();
    z.addFile('001.png', page[n]);
    await writeFile(fileOf(n), z.toBuffer());
  }
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!ccp','Kept Cover',$2,3)`, [S, FOLDER]);
  for (const n of [1, 2, 3] as const) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root, mtime)
             VALUES ($1,$2,'T!ccp',$3,$4,$5,1,$6,$7)`, [B[n], S, `${FOLDER}/ch${n}.cbz`, n, `Chapter ${n}`, DL, LANDED_AT]);
  }
  // Set once the books exist (fk_lib_series_cover_book_id). Art known to be none, so nothing asks AniList.
  await q('UPDATE lib_series SET cover_book_id = $2 WHERE id = $1', [S, B[1]]);
  await q('INSERT INTO series_art (series_id, banner, cover, checked_at) VALUES ($1, NULL, NULL, now())', [S]);
  await q('UPDATE server_settings SET cleanup_read = true, cleanup_read_days = 0 WHERE id = 1');
}

/** Alice read chapter `n` to the end yesterday. */
const finish = (n: 1 | 2 | 3) => q(
  `INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at)
   VALUES ((SELECT id FROM users WHERE username = $1), $2, $3, 1, true, now() - interval '1 day')`, [USER, B[n], S]);

/** The scan moves the cover chapter to the lowest live chapter (lib/library.ts); here by hand, to chapter `n`. */
const coverChapter = (n: 1 | 2 | 3) => q('UPDATE lib_series SET cover_book_id = $2 WHERE id = $1', [S, B[n]]);

/** The series' cover as the library draws it, drawn afresh: 'r', 'g' or 'b', the colour of the page it shows. */
async function coverColour(): Promise<string> {
  await rm(CACHE, { recursive: true, force: true });
  const r = await app.inject({ method: 'GET', url: `/img/series/${S}/thumb`, headers: { cookie: imgCookie } });
  assert.equal(r.statusCode, 200, `the cover: ${r.statusCode}`);
  const sharp = (await import('sharp')).default;
  const [red, green, blue] = (await sharp(r.rawPayload).stats()).channels.map((c) => c.mean);
  return red > green && red > blue ? 'r' : blue > green ? 'b' : 'g';
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  await migrate();
  cc = await import('../src/lib/chapterCleanup');
  notice = await import('../src/lib/noticeChapters');
  keptFile = (await import('../src/lib/seriesArt')).artFile(S, 'page');
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  const uid = (await q<{ id: string }>(
    `INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ($1,$1,'user','x','password') RETURNING id`, [USER]))[0].id;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const { IMG_COOKIE } = await import('../src/lib/auth');
  app = Fastify();
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/images')).default);
  await app.ready();
  imgCookie = `${IMG_COOKIE}=${app.jwt.sign({ sub: uid, typ: 'img' })}`;
});

beforeEach(async () => {
  if (DSN) await fresh();
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  notice?.setHiddenNumbersActive(false);
  await q('UPDATE server_settings SET cleanup_read = false, cleanup_read_days = 30 WHERE id = 1').catch(() => {});
  await q('DELETE FROM read_progress WHERE series_id = $1', [S]).catch(() => {});
  await q('UPDATE lib_series SET cover_book_id = NULL WHERE id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
  await rm(keptFile, { force: true }).catch(() => {});
  await (await import('../src/lib/db')).pool.end().catch(() => {});
});

test("the cover's chapter goes, and its page stays the cover", { skip }, async () => {
  assert.equal(await coverColour(), 'r', 'the cover is the first page of chapter 1, the cover chapter');
  await finish(1);
  const r = await cc.runCleanupOnce();
  // Reintroduce the veto on the cover chapter (dueSql): nothing is deleted.
  assert.equal(r.deleted, 1, 'the cover chapter was kept');
  assert.equal(await exists(fileOf(1)), false);
  // Reintroduce the delete without keepCoverPage: there is no page.
  assert.deepEqual(await readFile(keptFile), page[1], "the series' first page was not kept as it was");
  assert.equal(await coverColour(), 'r');
  // Reintroduce firstPageInput reading the chapters first: once the cover chapter moves on, the cover is chapter 2's page.
  await coverChapter(2);
  assert.equal(await coverColour(), 'r', "the cover turned into the next chapter's page");
});

test('a page kept already stays the cover when the next cover chapter goes', { skip }, async () => {
  await finish(1);
  assert.equal((await cc.runCleanupOnce()).deleted, 1);
  await coverChapter(2);
  await finish(2);
  // The chapter the cover would have fallen back to is not held either.
  assert.equal((await cc.runCleanupOnce()).deleted, 1, 'the next cover chapter was kept');
  assert.equal(await exists(fileOf(2)), false);
  // Reintroduce keepCoverPage writing over a page it kept: chapter 2's page replaces the cover people saw.
  assert.deepEqual(await readFile(keptFile), page[1], 'the kept page was replaced');
  assert.equal(await coverColour(), 'r');
});

test('a series with a cover picture of its own keeps no page; Use the first page keeps one', { skip }, async () => {
  // Reintroduce coverPageBooks without its picture test: a page is kept for every series the cleanup reaches.
  const own: Array<[string, string]> = [
    ["the source's cover", `UPDATE series_art SET cover = 'https://covers.invalid/c.jpg' WHERE series_id = $1`],
    ["an admin's link", `INSERT INTO series_overrides (series_id, cover) VALUES ($1, 'https://covers.invalid/o.jpg')`],
    ["an admin's upload", `INSERT INTO series_overrides (series_id, cover) VALUES ($1, 'upload')`],
  ];
  for (const [what, sql] of own) {
    await fresh();
    await q(sql, [S]);
    await finish(1);
    assert.equal((await cc.runCleanupOnce()).deleted, 1, `${what}: the chapter was kept`);
    assert.equal(await exists(keptFile), false, `${what}: a page was kept for a series whose cover is not its page`);
  }
  // Use the first page, chosen over the source's cover: the page IS the cover. Reintroduce coverPageBooks without
  // `o.cover = 'first_page'`: no page is kept.
  await fresh();
  await q(`UPDATE series_art SET cover = 'https://covers.invalid/c.jpg' WHERE series_id = $1`, [S]);
  await q(`INSERT INTO series_overrides (series_id, cover) VALUES ($1, 'first_page')`, [S]);
  await finish(1);
  assert.equal((await cc.runCleanupOnce()).deleted, 1);
  assert.deepEqual(await readFile(keptFile), page[1], 'Use the first page kept no page');
});

test('behind a number hidden by hand, the page kept is the one the cover shows', { skip }, async () => {
  // Chapter 1, the cover chapter, is at a number hidden by hand: its pages are nobody's, so the cover is the first page
  // of chapter 2, the lowest shown (firstPageBookOf), and that is the page the cleanup keeps when 2 goes. Reintroduce
  // coverPageBooks matching cover_book_id alone: no page is kept.
  notice.setHiddenNumbersActive(true);
  await q(`UPDATE lib_series SET hidden_numbers = '{1}' WHERE id = $1`, [S]);
  assert.equal(await coverColour(), 'b', "the cover is the first shown chapter's page");
  await finish(2);
  assert.equal((await cc.runCleanupOnce()).deleted, 1);
  assert.deepEqual(await readFile(keptFile), page[2], 'the page the cover shows was not kept');
  assert.equal(await coverColour(), 'b');
});

test('a page that cannot be written keeps the chapter for the next run; a chapter with no page to read still goes', { skip }, async () => {
  // A directory where the page is written before it is renamed into place: the write fails, as on a full disk.
  await mkdir(`${keptFile}.part`, { recursive: true });
  await finish(1);
  const r = await cc.runCleanupOnce();
  // Reintroduce deleting the chapter when its page could not be kept: the cover's only copy is gone.
  assert.equal(r.deleted, 0, 'the chapter went without its page');
  assert.equal(r.failed, 1, 'and the run did not count it as not removed');
  assert.equal(await exists(fileOf(1)), true);
  assert.equal((await q('SELECT pruned_at FROM lib_books WHERE id = $1', [B[1]]))[0].pruned_at, null);
  await rm(`${keptFile}.part`, { recursive: true, force: true });
  assert.equal((await cc.runCleanupOnce()).deleted, 1, 'the next run did not take it');
  assert.deepEqual(await readFile(keptFile), page[1]);

  // A chapter that is no archive has no page to give: nothing to keep, and it is not held for one. Reintroduce treating a
  // page that cannot be read as one that cannot be written: the chapter stays, run after run.
  await fresh();
  await writeFile(fileOf(1), 'x'.repeat(100));
  await finish(1);
  assert.equal((await cc.runCleanupOnce()).deleted, 1, 'a chapter with no page to read was held');
  assert.equal(await exists(keptFile), false);
});
