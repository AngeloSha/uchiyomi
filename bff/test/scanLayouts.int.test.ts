// A series folder that holds its own cover is still a series.
//
// Reported in #34 by @ThomasRunting, with the diagnosis: a Tranga library -- top-level series folders, each
// with its `.cbz` chapters and a thumbnail image -- scanned to `{series: 0, books: 0}` in four seconds, with
// no error anywhere. `listChapters` called any subfolder holding an image a chapter, so every series folder
// read as a chapter OF THE ROOT; the root therefore "had chapters", and `findSeriesDirs` treated a directory
// with chapters as a series and declined to descend. At the root that pushed nothing and walked nothing.
//
// The same one-line test hides three more layouts, all common: Mihon's local source (`cover.jpg` beside
// chapter folders), Komga/Kavita (`cover.*` beside archives), and any of those under a source wrapper folder
// -- where the failure is worse than zero, because the WRAPPER becomes a series whose "chapters" are the
// real series.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const ROOT = join(tmpdir(), `uchiyomi-layouts-${process.pid}`);
const DL = join(tmpdir(), `uchiyomi-layoutsdl-${process.pid}`);

if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_ROOT = ROOT;
  process.env.DL_ROOT = DL;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let persistScan: () => Promise<any>;
let listChapters: (abs: string) => Promise<string[]>;

async function cbz(relDir: string, name: string) {
  const zip = new AdmZip();
  zip.addFile('001.jpg', Buffer.from('img'));
  await mkdir(join(ROOT, relDir), { recursive: true });
  await writeFile(join(ROOT, relDir, name), zip.toBuffer());
}
async function img(relDir: string, name: string) {
  await mkdir(join(ROOT, relDir), { recursive: true });
  await writeFile(join(ROOT, relDir, name), Buffer.from('img'));
}

const series = () => q<{ folder: string; books_count: number }>(
  `SELECT folder, books_count FROM lib_series ORDER BY folder`);

async function wipe() {
  await q(`DELETE FROM lib_books`);
  await q(`DELETE FROM lib_series`);
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
  await mkdir(ROOT, { recursive: true });
  await mkdir(DL, { recursive: true });
}

before(async () => {
  if (!DSN) return;
  ({ q } = await import('../src/lib/db'));
  await (await import('../src/lib/migrate')).migrate();
  ({ persistScan, listChapters } = await import('../src/lib/library'));
});
beforeEach(async () => { if (DSN) await wipe(); });
after(async () => {
  if (!DSN) return;
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
  await rm(DL, { recursive: true, force: true }).catch(() => {});
  const { pool } = await import('../src/lib/db');
  await pool.end();
});

test('THE TRANGA LAYOUT: a cover beside the archives does not turn the series into a chapter of the root', { skip }, async () => {
  // ⚠️ The reported case, exactly: 38 series at the root, each holding .cbz files and one image, scanned
  // to zero. Reintroduce by restoring `.some((n) => IMG.test(n))` in listChapters, OR by dropping `&& rel`
  // in findSeriesDirs -- each lock alone is enough to hold this one, which is why there are two.
  await cbz('Solo Leveling', 'Chapter 1.cbz');
  await cbz('Solo Leveling', 'Chapter 2.cbz');
  await img('Solo Leveling', 'Solo Leveling.jpg');          // thumbnail named after the series, as Tranga writes
  await cbz('Omniscient Reader', 'Chapter 1.cbz');
  await img('Omniscient Reader', 'cover.png');

  const r = await persistScan();
  assert.equal(r.series, 2, `expected 2 series, scan reported ${JSON.stringify(r)}`);
  assert.deepEqual(await series(), [
    { folder: 'Omniscient Reader', books_count: 1 },
    { folder: 'Solo Leveling', books_count: 2 },
  ]);
});

test("the root's own listing is not a chapter list", { skip }, async () => {
  // What the reporter measured directly: `listChapters('/library')` returning every series name.
  await cbz('A', 'c1.cbz'); await img('A', 'cover.jpg');
  await cbz('B', 'c1.cbz'); await img('B', 'cover.jpg');
  assert.deepEqual(await listChapters(ROOT), [], 'series folders must not read as chapters of the root');
  assert.deepEqual(await listChapters(join(ROOT, 'A')), ['c1.cbz'], 'and the cover is not a chapter of the series either');
});

test("Mihon's local-source layout: cover.jpg beside chapter FOLDERS", { skip }, async () => {
  // No archives at all here, so the archive rule cannot save it. At the ROOT the `&& rel` guard still
  // catches it -- see the wrapper variant below for the case only the subfolder rule holds.
  await img('Tower of God/Chapter 1', '001.jpg');
  await img('Tower of God/Chapter 2', '001.jpg');
  await img('Tower of God', 'cover.jpg');

  const r = await persistScan();
  assert.equal(r.series, 1);
  assert.deepEqual(await series(), [{ folder: 'Tower of God', books_count: 2 }]);
  assert.deepEqual(await listChapters(join(ROOT, 'Tower of God')), ['Chapter 1', 'Chapter 2'],
    'the chapter folders are the chapters; the cover is not one');
});

test("Mihon's layout under a wrapper folder: the case only the subfolder rule holds", { skip }, async () => {
  // ⚠️ `Local/Tower of God/cover.jpg + Chapter N/`: no archives anywhere, and the wrapper is not the root,
  // so neither the archive rule nor the root guard applies. `Tower of God` holds an image and used to read
  // as a chapter of `Local`, which then became a series called "Local" with one chapter -- the wrong shelf,
  // with the real chapters unreachable inside it.
  // Reintroduce by dropping the image-bearing-subfolder check from isImageChapterDir: a series named 'Local'
  // appears and 'Local/Tower of God' does not. (Measured: the archive rule alone passes every OTHER test in
  // this file, which is exactly why this one exists.)
  await img('Local/Tower of God/Chapter 1', '001.jpg');
  await img('Local/Tower of God/Chapter 2', '001.jpg');
  await img('Local/Tower of God', 'cover.jpg');

  const r = await persistScan();
  assert.equal(r.series, 1);
  const rows = await series();
  assert.deepEqual(rows, [{ folder: 'Local/Tower of God', books_count: 2 }]);
});

test('under a source wrapper the failure was WORSE than zero: the wrapper became the series', { skip }, async () => {
  // `Tranga/SeriesA/cover.jpg + .cbz`: the root has no images so it descends fine, but `Tranga/` holds
  // image-bearing subfolders and used to read as a series with N "chapters" named after the real series --
  // wrong data rather than no data, and read_progress would have hung off rows for chapters that do not
  // exist. Reintroduce by restoring the old listChapters: a series named 'Tranga' appears.
  await cbz('Tranga/Beginning After the End', 'Ch 1.cbz');
  await img('Tranga/Beginning After the End', 'cover.jpg');
  await cbz('Tranga/The Greatest Estate Developer', 'Ch 1.cbz');
  await img('Tranga/The Greatest Estate Developer', 'cover.jpg');

  const r = await persistScan();
  assert.equal(r.series, 2);
  const rows = await series();
  assert.deepEqual(rows.map((x) => x.folder), ['Tranga/Beginning After the End', 'Tranga/The Greatest Estate Developer']);
  assert.ok(!rows.some((x) => x.folder === 'Tranga'), 'the wrapper folder must not be a series');
});

test('layouts that already worked still do, with the same folders', { skip }, async () => {
  // The scanner's relative paths are the natural key everything hangs off (see scanDepth.int.test.ts), so a
  // fix that changed them would re-mint every series id on every install.
  await cbz('Source/Plain Archives', 'c1.cbz');
  await img('Source/Loose Pages/Ch 1', '001.jpg');
  await img('Source/Loose Pages/Ch 2', '001.jpg');
  await cbz('Flat At Root', 'c1.cbz');

  const r = await persistScan();
  assert.equal(r.series, 3);
  assert.deepEqual((await series()).map((x) => `${x.folder}:${x.books_count}`),
    ['Flat At Root:1', 'Source/Loose Pages:2', 'Source/Plain Archives:1']);
});

test('a stray image in a source folder does not make the source folder a series', { skip }, async () => {
  // e.g. someone drops a poster.jpg into the wrapper. The wrapper holds series (image-bearing subfolders),
  // so it is not a chapter of the root; and having no archives or chapter folders of its own, it is not a
  // series either. The image is simply ignored.
  await img('Source', 'poster.jpg');
  await cbz('Source/Real Series', 'c1.cbz');

  const r = await persistScan();
  assert.equal(r.series, 1);
  assert.deepEqual((await series()).map((x) => x.folder), ['Source/Real Series']);
});
