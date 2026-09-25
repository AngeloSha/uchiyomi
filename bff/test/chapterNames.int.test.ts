// A chapter's own name: stored when it lands, healed from the listing, never taken from a filename.
//
// A downloaded file is named from its number alone (`Chapter 12.cbz`, lib/downloader.ts), so the title the
// scanner derives from it is the number said twice. The source's name for the chapter reaches the row by two
// roads -- setBookMeta when a copy lands, and replaceListing's heal on every check for chapters fetched before
// the first road existed -- and it goes to its OWN column, `chapter_name`. The first version of this change
// wrote names into `title`, which is the filename's: on a library built by hand that showed
// `One Piece v02 c012 [Digital]` as the chapter's name, and every screen printing the title alone lost the
// number. So `title` is pinned here as never touched, and a hand-built library as never named.
//
// The pure rule runs everywhere; the rest is skipped unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
// Roots are read at module load, so they are set before the first import of library.ts. Placeholders
// otherwise: env.ts validates at load, and the pure test below still imports the module.
const ROOT_A = join(tmpdir(), `uchiyomi-names-lib-${process.pid}`);
const ROOT_B = join(tmpdir(), `uchiyomi-names-dl-${process.pid}`);
process.env.DATABASE_URL = DSN || process.env.DATABASE_URL || 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
process.env.LIBRARY_ROOT = ROOT_A;
process.env.DL_ROOT = ROOT_B;
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

type Q = <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let q: Q;
let lib: typeof import('../src/lib/library');
let replaceListing: typeof import('../src/lib/seriesListing')['replaceListing'];

const SRC = 'T!names';
const TITLE = 'Named Series';
const FOLDER = `${SRC}/${TITLE}`;

async function writeCbz(abs: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile('001.jpg', Buffer.from('page-bytes'));
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, zip.toBuffer());
}

const names = async (): Promise<Record<number, string | null>> => {
  const rows = await q<{ number: number; chapter_name: string | null }>(
    `SELECT b.number, b.chapter_name FROM lib_books b JOIN lib_series s ON s.id = b.series_id WHERE s.folder = $1 ORDER BY b.number`, [FOLDER]);
  return Object.fromEntries(rows.map((r) => [Number(r.number), r.chapter_name]));
};
const titles = async (): Promise<Record<number, string>> => {
  const rows = await q<{ number: number; title: string }>(
    `SELECT b.number, b.title FROM lib_books b JOIN lib_series s ON s.id = b.series_id WHERE s.folder = $1 ORDER BY b.number`, [FOLDER]);
  return Object.fromEntries(rows.map((r) => [Number(r.number), r.title]));
};
const seriesId = async () => (await q<{ id: string }>('SELECT id FROM lib_series WHERE folder = $1', [FOLDER]))[0].id;

async function wipe() {
  await q(`DELETE FROM lib_books WHERE root = $1 OR root = $2`, [ROOT_A, ROOT_B]);
  await q(`DELETE FROM lib_series WHERE folder = $1`, [FOLDER]);
}

before(async () => {
  lib = await import('../src/lib/library');
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as { q: Q });
  ({ replaceListing } = await import('../src/lib/seriesListing'));
  await migrate();
});

beforeEach(async () => {
  if (!DSN) return;
  await wipe();
  await rm(ROOT_A, { recursive: true, force: true });
  await rm(ROOT_B, { recursive: true, force: true });
  await mkdir(ROOT_A, { recursive: true });
  await mkdir(ROOT_B, { recursive: true });
  // Exactly what the downloader writes: the number and nothing else.
  for (const n of [1, 2, 3]) await writeCbz(join(ROOT_B, SRC, TITLE, `Chapter ${n}.cbz`));
  await lib.persistScan();
});

after(async () => {
  if (!DSN) return;
  await wipe().catch(() => {});
  await rm(ROOT_A, { recursive: true, force: true }).catch(() => {});
  await rm(ROOT_B, { recursive: true, force: true }).catch(() => {});
});

test('chapterName: the number said again is no name, in the ways sources say it; what follows it is', () => {
  for (const bare of ['Chapter 12', 'chapter 012', 'Ch. 12', 'Ch.12', 'ch 12', 'Episode 12', 'Ep. 12', '12', '  Chapter 12  ', '',
                      'Vol.3 Chapter 12', 'Volume 3 - Ch. 12', 'Capítulo 12', 'Chapitre 12', 'Kapitel 12', 'Глава 12', '第12話', '第12章', '12화', 'Chapter 12.']) {
    assert.equal(lib.chapterName(bare, 12), null, `"${bare}" is the number again`);
  }
  assert.equal(lib.chapterName(null, 12), null);
  assert.equal(lib.chapterName('Chapter 12.5', 12.5), null, 'a decimal number is matched whole');
  assert.equal(lib.chapterName('Romance Dawn', 1), 'Romance Dawn');
  // What follows the number is the name. Reintroduce the whole-string rule and this reads the full title.
  assert.equal(lib.chapterName('Chapter 12: The Sound of Thunder', 12), 'The Sound of Thunder');
  assert.equal(lib.chapterName('Vol.3 Chapter 12 - The Return', 12), 'The Return');
  assert.equal(lib.chapterName('Episode 4: Arrival', 4), 'Arrival');
  // Another number is not this one: 12 must not match the front of 120 or 12.5, nor 13.
  assert.equal(lib.chapterName('Chapter 13', 12), 'Chapter 13');
  assert.equal(lib.chapterName('Chapter 120', 12), 'Chapter 120');
  assert.equal(lib.chapterName('Chapter 12.5', 12), 'Chapter 12.5');
  assert.equal(lib.chapterName('Log. 12', 12), 'Log. 12', '"Log" is not a chapter word; the source means it');
});

test('a landed copy stores its real name beside the title, and a bare one never replaces it', { skip }, async () => {
  assert.deepEqual(await names(), { 1: null, 2: null, 3: null }, 'the scanner names nothing');
  await lib.setBookMeta(FOLDER, [
    { number: 1, source: 'a', title: 'Romance Dawn' },
    { number: 2, source: 'a', title: 'Chapter 2' },
  ]);
  assert.deepEqual(await names(), { 1: 'Romance Dawn', 2: null, 3: null });
  // Reintroduce the first design (the name into `title`) and this reads { 1: 'Romance Dawn', ... }.
  assert.deepEqual(await titles(), { 1: 'Chapter 1', 2: 'Chapter 2', 3: 'Chapter 3' }, 'the title is still the file\'s');
  // A refetch from a source that knows no names: the stamp moves, the name stays.
  await lib.setBookMeta(FOLDER, [{ number: 1, source: 'b', title: 'Ch. 1' }]);
  assert.equal((await names())[1], 'Romance Dawn');
});

test('a source check fills a missing name from the listing, and never replaces one', { skip }, async () => {
  const id = await seriesId();
  await q(`UPDATE lib_books SET chapter_name = 'Named on download' WHERE series_id = $1 AND number = 3`, [id]);
  const row = (number: number, title: string | null) => ({
    number, title, publishedAt: null, scanlator: null, groups: [], sourceId: 'a',
    chosen: { sourceId: `c/${number}`, number, title: title ?? undefined } as any, copies: [], status: 'available' as any,
  });
  await replaceListing(id, [row(1, 'Vol.1 Chapter 1: Romance Dawn'), row(2, 'Chapter 2'), row(3, 'Listing name')]);
  assert.deepEqual(await names(), { 1: 'Romance Dawn', 2: null, 3: 'Named on download' },
    'a real name fills a missing one; a bare listing title fills nothing; a name already there is kept');
  assert.deepEqual(await titles(), { 1: 'Chapter 1', 2: 'Chapter 2', 3: 'Chapter 3' }, 'the heal never touches a title');
});

test('a rescan leaves names alone, and a file with a name of its own is titled from it', { skip }, async () => {
  await writeCbz(join(ROOT_B, SRC, TITLE, 'Chapter 4 - Named File.cbz'));
  await lib.persistScan();
  await lib.setBookMeta(FOLDER, [{ number: 1, source: 'a', title: 'Romance Dawn' }]);
  await lib.persistScan();
  assert.equal((await names())[1], 'Romance Dawn', 'the name survives a scan');
  const t = await titles();
  assert.equal(t[1], 'Chapter 1');
  assert.equal(t[4], 'Chapter 4 - Named File', 'a file carrying its own name is titled from it, as always');
});

test('a library built by hand is never named from its filenames, and the name reaches the chapter list', { skip }, async () => {
  // The case the column exists for: files named anything at all, in a library nobody downloaded into.
  const HAND = 'Hand Built';
  const handFolder = `${SRC}/${HAND}`;
  for (const f of ['One Piece v02 c012 [Digital].cbz', 'Tome 01.cbz'])
    await writeCbz(join(ROOT_A, SRC, HAND, f));
  await lib.persistScan();
  const hand = await q<{ chapter_name: string | null }>(
    `SELECT b.chapter_name FROM lib_books b JOIN lib_series s ON s.id = b.series_id WHERE s.folder = $1`, [handFolder]);
  assert.ok(hand.length >= 2, 'PREMISE: the hand-built files were scanned');
  assert.ok(hand.every((r) => r.chapter_name === null), 'a filename became a chapter name');
  // Through the real catalog, whose column list is explicit: a column missing there reads as null silently.
  const { owned } = await import('../src/lib/ownedCatalog');
  const { SYSTEM_CTX } = await import('../src/lib/visibility');
  await lib.setBookMeta(FOLDER, [{ number: 2, source: 'a', title: 'The Great Line' }]);
  const books = (await owned.seriesBooks(SYSTEM_CTX, await seriesId(), 0, 100)).content as any[];
  assert.equal(books.find((b) => b.number === 2)?.chapterName, 'The Great Line');
  assert.equal(books.find((b) => b.number === 1)?.chapterName, null);
  await q(`DELETE FROM lib_books WHERE root = $1`, [ROOT_A]);
  await q(`DELETE FROM lib_series WHERE folder = $1`, [handFolder]);
});
