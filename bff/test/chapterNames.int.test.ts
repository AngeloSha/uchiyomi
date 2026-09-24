// A chapter's own name: stored when it lands, healed from the listing, and kept across a rescan.
//
// A downloaded file is named from its number alone (`Chapter 12.cbz`, lib/downloader.ts), so the title the
// scanner derives from it is the number said twice. The source's name for the chapter reaches the row by
// two roads -- setBookMeta when a copy lands, and replaceListing's heal on every check for chapters fetched
// before the first road existed -- and one thing could undo both: persistScan re-deriving every title from
// its filename on each add, sweep and manual scan. All three are pinned here, plus the filter that keeps
// "Chapter 12" from replacing a real name.
//
// The pure filter runs everywhere; the rest is skipped unless TEST_DATABASE_URL is set.
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

test('chapterName drops a title that only restates the number, in the usual spellings', () => {
  for (const bare of ['Chapter 12', 'chapter 012', 'Ch. 12', 'Ch.12', 'ch 12', 'Episode 12', 'Ep. 12', '12', '  Chapter 12  ', '']) {
    assert.equal(lib.chapterName(bare, 12), null, `"${bare}" is the number again`);
  }
  assert.equal(lib.chapterName(null, 12), null);
  assert.equal(lib.chapterName('Chapter 12.5', 12.5), null, 'a decimal number is matched whole');
  assert.equal(lib.chapterName('Romance Dawn', 1), 'Romance Dawn');
  assert.equal(lib.chapterName('Chapter 12: The Sound of Thunder', 12), 'Chapter 12: The Sound of Thunder', 'a name that includes the number is still a name');
  assert.equal(lib.chapterName('Chapter 13', 12), 'Chapter 13', 'another number is not a restatement of this one');
  assert.equal(lib.chapterName('Chapter 120', 12), 'Chapter 120');
});

test('a landed copy stores its real name, and a bare one never replaces it', { skip }, async () => {
  assert.deepEqual(await titles(), { 1: 'Chapter 1', 2: 'Chapter 2', 3: 'Chapter 3' }, 'the scanner names each from its file');
  await lib.setBookMeta(FOLDER, [
    { number: 1, source: 'a', title: 'Romance Dawn' },
    { number: 2, source: 'a', title: 'Chapter 2' },
  ]);
  assert.deepEqual(await titles(), { 1: 'Romance Dawn', 2: 'Chapter 2', 3: 'Chapter 3' });
  // A refetch from a source that knows no names: the stamp moves, the name stays.
  await lib.setBookMeta(FOLDER, [{ number: 1, source: 'b', title: 'Ch. 1' }]);
  assert.equal((await titles())[1], 'Romance Dawn');
});

test('a source check heals a bare title from the listing, and only a bare one', { skip }, async () => {
  const id = await seriesId();
  await q(`UPDATE lib_books SET title = 'Hand-set name' WHERE series_id = $1 AND number = 3`, [id]);
  const row = (number: number, title: string | null) => ({
    number, title, publishedAt: null, scanlator: null, groups: [], sourceId: 'a',
    chosen: { sourceId: `c/${number}`, number, title: title ?? undefined } as any, copies: [], status: 'available' as any,
  });
  await replaceListing(id, [row(1, 'Romance Dawn'), row(2, 'Chapter 2'), row(3, 'Listing name')]);
  assert.deepEqual(await titles(), { 1: 'Romance Dawn', 2: 'Chapter 2', 3: 'Hand-set name' },
    'a real name fills a bare title; a bare listing title changes nothing; a title that is already a name is left alone');
});

test('a rescan keeps a chapter\'s stored name, and a file with a name of its own still wins', { skip }, async () => {
  // Reintroduce by going back to `title=EXCLUDED.title` in persistScan's upsert: chapter 1 reads `Chapter 1`.
  await writeCbz(join(ROOT_B, SRC, TITLE, 'Chapter 4 - Named File.cbz'));
  await lib.persistScan();
  await lib.setBookMeta(FOLDER, [{ number: 1, source: 'a', title: 'Romance Dawn' }]);
  // A row whose file says more than its number, holding some other title: the file is the authority.
  await q(`UPDATE lib_books SET title = 'Stale' WHERE file LIKE '%Chapter 4 - Named File.cbz'`);
  await lib.persistScan();
  const t = await titles();
  assert.equal(t[1], 'Romance Dawn', 'the name survives a scan that found the same number-only file');
  assert.equal(t[2], 'Chapter 2', 'a chapter with no name is still titled from its file');
  assert.equal(t[4], 'Chapter 4 - Named File', 'a file carrying its own name is titled from it');
});
