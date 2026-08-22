// The scanner walks any depth now. This file exists to prove it did not change anything for libraries that
// already exist.
//
// lib_series.folder is UNIQUE and is the natural key a minted series id hangs off; lib_books is keyed
// (root, file). If the new walk emits even slightly different relative paths, every install re-mints every
// id on the next scan, and read_progress ends up pointing at rows nothing renders. The first test here is
// the one that matters: same fixtures, same ids, byte-identical folder/file/source.
//
// The old walk was exactly two levels, so `Series/ch1.cbz` directly under the root was invisible. That is
// what the README documented for two releases, which is how it went unnoticed.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const ROOT = join(tmpdir(), `uchiyomi-depth-${process.pid}`);
const DL = join(tmpdir(), `uchiyomi-depthdl-${process.pid}`);

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

async function cbz(relDir: string, name: string, body: string) {
  const zip = new AdmZip();
  zip.addFile('001.jpg', Buffer.from(body));
  await mkdir(join(ROOT, relDir), { recursive: true });
  await writeFile(join(ROOT, relDir, name), zip.toBuffer());
}

async function looseChapter(relDir: string, chapterName: string) {
  await mkdir(join(ROOT, relDir, chapterName), { recursive: true });
  await writeFile(join(ROOT, relDir, chapterName, '001.jpg'), Buffer.from('img'));
}

const seriesRows = () =>
  q<{ id: string; folder: string; source: string }>(
    `SELECT id, folder, source FROM lib_series WHERE source LIKE 'T!%' OR folder LIKE '%' ORDER BY folder`,
  );

async function wipe() {
  await q(`DELETE FROM lib_books`);
  await q(`DELETE FROM lib_series`);
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
  await mkdir(ROOT, { recursive: true });
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ persistScan } = await import('../src/lib/library'));
  await migrate();
  await mkdir(ROOT, { recursive: true });
  await mkdir(DL, { recursive: true });
});

beforeEach(async () => { if (DSN) await wipe(); });

after(async () => {
  if (!DSN) return;
  await q(`DELETE FROM lib_books`).catch(() => {});
  await q(`DELETE FROM lib_series`).catch(() => {});
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
  await rm(DL, { recursive: true, force: true }).catch(() => {});
});

test('THE PROOF: a two-level library keeps its ids and paths across a rescan', { skip }, async () => {
  // This is what every existing install is. If it re-mints, everyone's reading progress is stranded.
  await cbz('Aqua/One Piece', 'Chapter 1.cbz', 'op-1');
  await cbz('Aqua/One Piece', 'Chapter 2.cbz', 'op-2');
  await cbz('Mangafreak/Bleach', 'Chapter 1.cbz', 'bl-1');
  await persistScan();

  const before1 = await seriesRows();
  const booksBefore = await q<{ id: string; root: string; file: string }>(
    `SELECT id, root, file FROM lib_books ORDER BY file`,
  );

  await persistScan(); // the pass that would re-mint if paths shifted

  assert.deepEqual(await seriesRows(), before1, 'series ids, folders or sources changed');
  assert.deepEqual(
    await q(`SELECT id, root, file FROM lib_books ORDER BY file`),
    booksBefore,
    'book ids or paths changed',
  );
});

test('two-level folder and source are exactly what they always were', { skip }, async () => {
  await cbz('Aqua/One Piece', 'Chapter 1.cbz', 'op-1');
  await persistScan();
  const [s] = await seriesRows();
  assert.equal(s.folder, 'Aqua/One Piece');
  assert.equal(s.source, 'Aqua', 'source must stay the level-1 directory');
  const [b] = await q<{ file: string }>(`SELECT file FROM lib_books`);
  assert.equal(b.file, 'Aqua/One Piece/Chapter 1.cbz');
});

test('THE FIX: a deeper library is found', { skip }, async () => {
  await cbz('Comics/Manga/Author/Series', 'ch1.cbz', 'deep');
  await persistScan();
  const rows = await seriesRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].folder, 'Comics/Manga/Author/Series');
  assert.equal(rows[0].source, 'Author', 'source is the segment above the series');
});

test('a series directly under the root is found, which is what the docs used to describe', { skip }, async () => {
  await cbz('One Piece', 'Chapter 1.cbz', 'flat');
  await persistScan();
  const rows = await seriesRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].folder, 'One Piece');
  assert.equal(rows[0].source, 'Library', 'a root-level series has no group above it');
});

test('a loose-image chapter folder stays a chapter and does not become a series', { skip }, async () => {
  await looseChapter('Aqua/Solo Leveling', 'Chapter 1');
  await looseChapter('Aqua/Solo Leveling', 'Chapter 2');
  await persistScan();
  const rows = await seriesRows();
  assert.equal(rows.length, 1, 'a chapter folder was promoted to a series');
  assert.equal(rows[0].folder, 'Aqua/Solo Leveling');
  assert.equal((await q(`SELECT id FROM lib_books`)).length, 2);
});

test('a folder nested inside a loose-image chapter is not descended into', { skip }, async () => {
  // Without the "chapters win, do not descend" rule, an extras folder inside a chapter becomes a series
  // and its pages get counted twice.
  await looseChapter('Aqua/Solo Leveling', 'Chapter 1');
  await mkdir(join(ROOT, 'Aqua/Solo Leveling/Chapter 1/extras'), { recursive: true });
  await writeFile(join(ROOT, 'Aqua/Solo Leveling/Chapter 1/extras/001.jpg'), Buffer.from('x'));
  await persistScan();
  assert.equal((await seriesRows()).length, 1, 'a folder inside a chapter became a series');
});

test('a directory holding both chapters and chapter-bearing children yields both', { skip }, async () => {
  await cbz('Aqua/Berserk', 'Chapter 1.cbz', 'b-1');
  await cbz('Aqua/Berserk/Extras', 'Omake.cbz', 'b-x');
  await persistScan();
  const folders = (await seriesRows()).map((r) => r.folder);
  assert.ok(folders.includes('Aqua/Berserk'), 'the parent lost its own chapters');
  // The parent has chapters so we do not descend, which means Extras is simply not seen. That is the
  // deliberate trade: never re-path an existing series to pick up a nested extra.
  assert.equal(folders.length, 1);
});

test('hidden and NAS junk directories are skipped', { skip }, async () => {
  await cbz('.hidden/Series', 'ch1.cbz', 'h');
  await cbz('@eaDir/Series', 'ch1.cbz', 'e');
  await cbz('Aqua/Real', 'ch1.cbz', 'r');
  await persistScan();
  const folders = (await seriesRows()).map((r) => r.folder);
  assert.deepEqual(folders, ['Aqua/Real'], 'junk directories were scanned');
});

test('a symlink loop terminates instead of recursing forever', { skip }, async () => {
  await cbz('Aqua/Looped', 'ch1.cbz', 'l');
  await symlink(join(ROOT, 'Aqua'), join(ROOT, 'Aqua/self'), 'dir').catch(() => {});
  await persistScan(); // must return rather than blow the stack
  assert.ok((await seriesRows()).length >= 1, 'the scan did not complete');
});

test('an empty folder is still skipped', { skip }, async () => {
  await mkdir(join(ROOT, 'Aqua/Nothing Here'), { recursive: true });
  await persistScan();
  assert.equal((await seriesRows()).length, 0);
});
