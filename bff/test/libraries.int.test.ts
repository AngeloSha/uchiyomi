// Multiple libraries, declared rather than inferred.
//
// The first test here is the non-negotiable one: upgrading must change nothing. lib_series.folder is the
// natural key a minted series id hangs off, and library_id changes the unique constraint it lives under, so
// getting this wrong re-mints every id on the next scan and strands everyone's reading progress on rows
// nothing points at.
//
// The second thing pinned here is WHY libraries are declared and never inferred. The obvious rule -- each
// top-level folder is a library -- is wrong on a real install: the top level holds source names written by
// the downloader, and lib_series.source is literally that first path segment. Inferring would silently
// rename one library into three named after its scrapers, on upgrade.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const ROOT = join(tmpdir(), `uchiyomi-libs-${process.pid}`);
const DL = join(tmpdir(), `uchiyomi-libsdl-${process.pid}`);

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
let libraryIdFor: (folderRel: string, libs: Array<{ id: string; path: string }>) => string;

async function cbz(relDir: string, name: string, body: string) {
  const zip = new AdmZip();
  zip.addFile('001.jpg', Buffer.from(body));
  await mkdir(join(ROOT, relDir), { recursive: true });
  await writeFile(join(ROOT, relDir, name), zip.toBuffer());
}

const rows = () =>
  q<{ id: string; folder: string; library_id: string }>(
    'SELECT id, folder, library_id FROM lib_series ORDER BY folder',
  );

async function wipe() {
  await q('DELETE FROM lib_books');
  await q('DELETE FROM lib_series');
  await q(`DELETE FROM libraries WHERE id <> 'lib'`);
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
  await mkdir(ROOT, { recursive: true });
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const lib = await import('../src/lib/library');
  persistScan = lib.persistScan;
  libraryIdFor = (lib as any).libraryIdFor;
  await migrate();
  await mkdir(ROOT, { recursive: true });
  await mkdir(DL, { recursive: true });
});

beforeEach(async () => { if (DSN) await wipe(); });

after(async () => {
  if (!DSN) return;
  await wipe().catch(() => {});
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
  await rm(DL, { recursive: true, force: true }).catch(() => {});
});

test('THE NON-NEGOTIABLE: a scan after the migration changes no ids and no folders', { skip }, async () => {
  await cbz('Aqua/One Piece', 'Chapter 1.cbz', 'op');
  await cbz('Mangafreak/Bleach', 'Chapter 1.cbz', 'bl');
  await persistScan();

  const before1 = await rows();
  const booksBefore = await q('SELECT id, root, file FROM lib_books ORDER BY file');
  assert.equal(before1.length, 2, 'setup');

  await persistScan();

  assert.deepEqual(await rows(), before1, 'series ids, folders or libraries changed on rescan');
  assert.deepEqual(await q('SELECT id, root, file FROM lib_books ORDER BY file'), booksBefore, 'book rows changed');
});

test('an install with no declared library puts everything in library zero', { skip }, async () => {
  await cbz('Aqua/One Piece', 'Chapter 1.cbz', 'op');
  await persistScan();
  const [s] = await rows();
  assert.equal(s.library_id, 'lib');
  assert.equal(s.folder, 'Aqua/One Piece', 'folder must stay relative to the ROOT, not the library');
});

test('libraries are declared, so a source folder does not silently become one', { skip }, async () => {
  // The live instance's top level is Aqua Manga (EN) / Mangafreak (EN) / ManhuaPlus (EN). Inferring would
  // turn one library into three named after scrapers.
  await cbz('Aqua Manga (EN)/Solo Leveling', 'Chapter 1.cbz', 'sl');
  await cbz('Mangafreak (EN)/Berserk', 'Chapter 1.cbz', 'bk');
  await persistScan();
  const libs = await q<{ id: string }>('SELECT id FROM libraries');
  assert.equal(libs.length, 1, 'scanning invented libraries');
  assert.ok((await rows()).every((r) => r.library_id === 'lib'));
});

test('longest declared prefix wins', { skip }, async () => {
  const libs = [
    { id: 'lib', path: '' },
    { id: 'manga', path: 'Comics/Manga' },
    { id: 'comics', path: 'Comics' },
  ];
  assert.equal(libraryIdFor('Comics/Manga/Berserk', libs), 'manga');
  assert.equal(libraryIdFor('Comics/Marvel/X-Men', libs), 'comics');
  assert.equal(libraryIdFor('Anything/Else', libs), 'lib', 'library zero must catch everything else');
});

test('promoting a subdirectory only flips library_id, and keeps every id', { skip }, async () => {
  await cbz('Comics/Manga/Berserk', 'Chapter 1.cbz', 'bk');
  await cbz('Other/Thing', 'Chapter 1.cbz', 'ot');
  await persistScan();
  const before1 = await rows();
  const bookIds = await q<{ id: string }>('SELECT id FROM lib_books ORDER BY id');

  await q(`INSERT INTO libraries (id, name, path) VALUES ('manga','Manga','Comics/Manga')`);
  // the reassignment the admin API performs, deliberately and separately from any scan
  await q(
    `UPDATE lib_series SET library_id = $1 WHERE library_id = 'lib' AND (folder = $2 OR folder LIKE $2 || '/%')`,
    ['manga', 'Comics/Manga'],
  );

  const after1 = await rows();
  assert.deepEqual(after1.map((r) => r.id).sort(), before1.map((r) => r.id).sort(), 'a series id changed');
  assert.deepEqual(after1.map((r) => r.folder).sort(), before1.map((r) => r.folder).sort(), 'a folder changed');
  assert.equal(after1.find((r) => r.folder === 'Comics/Manga/Berserk')!.library_id, 'manga');
  assert.equal(after1.find((r) => r.folder === 'Other/Thing')!.library_id, 'lib', 'an unrelated series moved');
  assert.deepEqual(await q('SELECT id FROM lib_books ORDER BY id'), bookIds, 'book ids changed');
});

test('a scan after promotion is still a no-op', { skip }, async () => {
  // The dangerous case: the scan recomputes a library for a folder whose row already moved. If it did, the
  // conflict target would miss and a second row would be minted with a fresh id.
  await cbz('Comics/Manga/Berserk', 'Chapter 1.cbz', 'bk');
  await persistScan();
  await q(`INSERT INTO libraries (id, name, path) VALUES ('manga','Manga','Comics/Manga')`);
  await q(`UPDATE lib_series SET library_id = 'manga' WHERE folder LIKE 'Comics/Manga%'`);
  const before1 = await rows();

  await persistScan();

  assert.deepEqual(await rows(), before1, 'the scan re-minted or re-homed a promoted series');
  assert.equal((await rows()).length, 1, 'a duplicate series row was created');
});

test('a new folder under a declared library is assigned to it', { skip }, async () => {
  await q(`INSERT INTO libraries (id, name, path) VALUES ('manga','Manga','Comics/Manga')`);
  await cbz('Comics/Manga/Vinland Saga', 'Chapter 1.cbz', 'vs');
  await cbz('Elsewhere/Thing', 'Chapter 1.cbz', 'el');
  await persistScan();
  const r = await rows();
  assert.equal(r.find((x) => x.folder === 'Comics/Manga/Vinland Saga')!.library_id, 'manga');
  assert.equal(r.find((x) => x.folder === 'Elsewhere/Thing')!.library_id, 'lib');
});

test('the widened index allows the same folder string in two libraries', { skip }, async () => {
  await q(`INSERT INTO libraries (id, name, path) VALUES ('two','Two','Two')`);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id)
           VALUES ('s_l1','T!l','A','Shared/Berserk',1,'lib')`);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id)
           VALUES ('s_l2','T!l','B','Shared/Berserk',1,'two')`);
  const n = await q(`SELECT id FROM lib_series WHERE folder = 'Shared/Berserk'`);
  assert.equal(n.length, 2, 'the unique index is still folder-only');
});

test('a library cannot be deleted while series still point at it', { skip }, async () => {
  // RESTRICT, because read_progress cascades from lib_series: a cascading library delete would destroy
  // reading progress two hops away as a side effect of tidying shelves.
  await q(`INSERT INTO libraries (id, name, path) VALUES ('manga','Manga','Comics/Manga')`);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id)
           VALUES ('s_l3','T!l','C','Comics/Manga/X',1,'manga')`);
  await assert.rejects(
    () => q(`DELETE FROM libraries WHERE id = 'manga'`),
    /violates foreign key|still referenced/i,
  );
});
