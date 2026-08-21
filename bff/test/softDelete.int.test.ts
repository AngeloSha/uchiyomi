// Deleting and merging have to survive the next library scan.
//
// The scanner walks the folders on disk and upserts what it finds, and it has no prune path at all. So the
// obvious implementations of both features quietly undo themselves: a deleted series comes back under a new
// id on the next scan, and a merged one has its chapters pulled straight back out, because the folder is
// still sitting there. Scans happen constantly — the admin button, every add, every updater sweep.
//
// These are the tests that catch that. Everything else about delete and merge is comparatively forgiving.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const ROOT_A = join(tmpdir(), `uchiyomi-sd-${process.pid}`);
const ROOT_B = join(tmpdir(), `uchiyomi-sddl-${process.pid}`);

if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_ROOT = ROOT_A;
  process.env.DL_ROOT = ROOT_B;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let persistScan: () => Promise<any>;
let owned: any;

const SRC = 'T!sd';
const dir = (name: string) => join(ROOT_A, SRC, name);

async function chapter(folder: string, file: string, body: string) {
  const zip = new AdmZip();
  zip.addFile('001.jpg', Buffer.from(body));
  await mkdir(dir(folder), { recursive: true });
  await writeFile(join(dir(folder), file), zip.toBuffer());
}

const row = async (folder: string) =>
  (await q(`SELECT * FROM lib_series WHERE folder = $1`, [`${SRC}/${folder}`]))[0];
const booksOf = async (id: string) =>
  q(`SELECT id, file FROM lib_books WHERE series_id = $1 ORDER BY file`, [id]);

async function wipe() {
  await q(`DELETE FROM lib_books WHERE source = $1`, [SRC]);
  await q(`DELETE FROM lib_series WHERE source = $1`, [SRC]);
  await rm(join(ROOT_A, SRC), { recursive: true, force: true }).catch(() => {});
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ persistScan } = await import('../src/lib/library'));
  ({ owned } = (await import('../src/lib/ownedCatalog')) as any);
  await migrate();
  await mkdir(ROOT_A, { recursive: true });
  await mkdir(ROOT_B, { recursive: true });
});

beforeEach(async () => { if (DSN) await wipe(); });

after(async () => {
  if (!DSN) return;
  await wipe().catch(() => {});
  await rm(ROOT_A, { recursive: true, force: true }).catch(() => {});
  await rm(ROOT_B, { recursive: true, force: true }).catch(() => {});
});

test('delete: a hidden series stays hidden across a rescan, with its id intact', { skip }, async () => {
  await chapter('Gone', 'Chapter 1.cbz', 'gone-1');
  await chapter('Gone', 'Chapter 2.cbz', 'gone-2');
  await persistScan();
  const before1 = await row('Gone');

  await q(`UPDATE lib_series SET deleted_at = now() WHERE id = $1`, [before1.id]);

  // the scan that would previously have resurrected it
  await persistScan();

  const after1 = await row('Gone');
  assert.equal(after1.id, before1.id, 'the scanner minted a new id for a deleted series');
  assert.ok(after1.deleted_at, 'the scan cleared deleted_at and brought the series back');
  const all = await q(`SELECT id FROM lib_series WHERE source = $1`, [SRC]);
  assert.equal(all.length, 1, 'the scan created a second copy of a deleted series');
});

test('delete: a hidden series is invisible to the catalog but its rows survive', { skip }, async () => {
  await chapter('Hidden', 'Chapter 1.cbz', 'h-1');
  await persistScan();
  const s = await row('Hidden');

  // something the user owns, attached to it
  await q(
    `INSERT INTO read_progress (user_id, book_id, series_id, page, completed)
     SELECT id, (SELECT id FROM lib_books WHERE series_id = $1 LIMIT 1), $1, 4, false FROM users LIMIT 1
     ON CONFLICT DO NOTHING`,
    [s.id],
  ).catch(() => {});

  await q(`UPDATE lib_series SET deleted_at = now() WHERE id = $1`, [s.id]);

  await assert.rejects(() => owned.series(s.id), /not found/i, 'a deleted series is still served');
  const found = await owned.searchSeries({ fullTextSearch: 'Hidden' }, 0, 40);
  assert.equal(found.content.length, 0, 'a deleted series still shows up in search');

  // but the rows the user cares about are untouched
  const prog = await q(`SELECT 1 FROM read_progress WHERE series_id = $1`, [s.id]);
  if (prog.length) assert.equal(prog.length, 1, 'reading progress was destroyed by a delete');
  const books = await booksOf(s.id);
  assert.equal(books.length, 1, 'the chapter rows were destroyed by a delete');
});

test('delete: restoring brings it back exactly as it was', { skip }, async () => {
  await chapter('Restore', 'Chapter 1.cbz', 'r-1');
  await persistScan();
  const before1 = await row('Restore');

  await q(`UPDATE lib_series SET deleted_at = now() WHERE id = $1`, [before1.id]);
  await persistScan();
  await q(`UPDATE lib_series SET deleted_at = NULL WHERE id = $1`, [before1.id]);

  const back = await owned.series(before1.id);
  assert.equal(back.id, before1.id);
  assert.equal(back.booksCount, 1);
});

test('merge: stays merged across a rescan — the books do not migrate back', { skip }, async () => {
  await chapter('Keep', 'Chapter 1.cbz', 'k-1');
  await chapter('Absorb', 'Chapter 2.cbz', 'a-2');
  await persistScan();
  const keep = await row('Keep');
  const absorb = await row('Absorb');

  // merge Absorb into Keep, the way the endpoint will
  await q(`UPDATE lib_books SET series_id = $1 WHERE series_id = $2`, [keep.id, absorb.id]);
  await q(`UPDATE lib_series SET merged_into = $1 WHERE id = $2`, [keep.id, absorb.id]);

  assert.equal((await booksOf(keep.id)).length, 2, 'setup: both chapters should be under Keep');

  // the scan that would previously have un-merged them
  await persistScan();

  const books = await booksOf(keep.id);
  assert.equal(books.length, 2, 'the scan pulled the absorbed chapters back out of the merged series');
  assert.equal((await booksOf(absorb.id)).length, 0, 'the absorbed series got its chapters back');
  assert.equal((await row('Absorb')).merged_into, keep.id, 'the merge marker was cleared by a scan');
});

test('merge: new chapters appearing in the absorbed folder land in the survivor', { skip }, async () => {
  await chapter('Keep2', 'Chapter 1.cbz', 'k2-1');
  await chapter('Absorb2', 'Chapter 2.cbz', 'a2-2');
  await persistScan();
  const keep = await row('Keep2');
  const absorb = await row('Absorb2');
  await q(`UPDATE lib_books SET series_id = $1 WHERE series_id = $2`, [keep.id, absorb.id]);
  await q(`UPDATE lib_series SET merged_into = $1 WHERE id = $2`, [keep.id, absorb.id]);

  // the source keeps downloading into the old folder, because that is where it has always downloaded
  await chapter('Absorb2', 'Chapter 3.cbz', 'a2-3');
  await persistScan();

  const books = await booksOf(keep.id);
  assert.equal(books.length, 3, 'a new chapter in the absorbed folder did not reach the merged series');
  assert.equal((await booksOf(absorb.id)).length, 0);
});

test('merge: the absorbed series is invisible to the catalog', { skip }, async () => {
  await chapter('Keep3', 'Chapter 1.cbz', 'k3-1');
  await chapter('Absorb3', 'Chapter 1.cbz', 'a3-1');
  await persistScan();
  const keep = await row('Keep3');
  const absorb = await row('Absorb3');
  await q(`UPDATE lib_series SET merged_into = $1 WHERE id = $2`, [keep.id, absorb.id]);

  await assert.rejects(() => owned.series(absorb.id), /not found/i);
  const found = await owned.searchSeries({ fullTextSearch: 'Absorb3' }, 0, 40);
  assert.equal(found.content.length, 0, 'the absorbed series still appears in search');
});

test('overrides: a renamed series is findable and sorted by its NEW name everywhere', { skip }, async () => {
  // This is what makes rename mean anything. Previously the override applied only on the detail page, so a
  // renamed series was unfindable by its new name and sorted under the old one.
  await chapter('Zzz Original', 'Chapter 1.cbz', 'ov-1');
  await persistScan();
  const s = await row('Zzz Original');

  await q(
    `INSERT INTO series_overrides (series_id, title, summary, updated_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (series_id) DO UPDATE SET title = $2, summary = $3`,
    [s.id, 'Aaa Renamed', 'A better summary.'],
  );

  const dto = await owned.series(s.id);
  assert.equal(dto.name, 'Aaa Renamed', 'the override is not applied by the catalog');
  assert.equal(dto.metadata.summary, 'A better summary.');

  const byNew = await owned.searchSeries({ fullTextSearch: 'Aaa Renamed' }, 0, 40);
  assert.equal(byNew.content.length, 1, 'the series is not findable by its new name');

  const byOld = await owned.searchSeries({ fullTextSearch: 'Zzz Original' }, 0, 40);
  assert.equal(byOld.content.length, 0, 'the series is still findable by its old name');

  // and the reader header follows
  const [book] = await booksOf(s.id);
  const b = await owned.book(book.id);
  assert.equal(b.seriesTitle, 'Aaa Renamed', 'the reader still shows the old series name');
});
