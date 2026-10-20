// The admin's deletes on a series folder the server may not read (EACCES), against a real Postgres and a real
// filesystem: Delete files, deleting chosen chapters, and the bulk delete's crash recovery.
//
// A permissions slip on one folder (a mode change, a PUID that no longer owns it) makes every stat under it fail with
// EACCES while the files are on disk. Until this, each of the three read any failed stat as "the file is gone":
// Delete files tombstoned every chapter of the folder as removed by hand (another series' file proved the root
// mounted), and Forget would then erase everyone's history of chapters whose bytes were still there. A failed stat is
// a file already gone only when it says so (ENOENT, ENOTDIR); anything else leaves the row live and is said.
//
// Run as a user mode bits apply to: root reads through them, so these are skipped under root.
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, rm, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const TMP = join(tmpdir(), `uchiyomi-du-${process.pid}`);
const ROOT = join(TMP, 'lib');
const DL = join(TMP, 'dl');

if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.CACHE_DIR = join(TMP, 'cache');
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LIBRARY_ROOT = ROOT;
  process.env.DL_ROOT = DL;
  process.env.MIN_FREE_GB = '0';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const skipUnreadable = skip || (asRoot ? 'running as root: mode bits do not stop root' : false);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

const SRC = 'T!du';
const OWN = `${SRC}/Own`;          // a series in the read library (LIBRARY_ROOT)
const OTHER = `${SRC}/Other`;      // its neighbour, whose present file proves the root mounted
const FETCHED = `${SRC}/Fetched`;  // a series this server downloaded (DL_ROOT)

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let persistScan: () => Promise<any>;
let deleteSeriesFiles: (id: string) => Promise<any>;
let deleteChapterFiles: (id: string, bookIds: string[], o: any) => Promise<any>;
let startBulkChapterDelete: (input: any) => Promise<any>;
let readBulkChapterDeleteRun: (id: string) => Promise<any>;
let closeInterruptedBulkChapterDeleteRuns: () => Promise<number>;
let setBulkChapterDeleteTestHooks: (hooks: any) => void;

// A 1x1 PNG: a page every reader of an archive accepts.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const LANDED_AT = Date.now() - 10 * 86_400_000;

async function cbz(root: string, rel: string, pages = 2): Promise<void> {
  const abs = join(root, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  const zip = new AdmZip();
  for (let i = 1; i <= pages; i++) zip.addFile(`${String(i).padStart(3, '0')}.png`, PNG);
  await writeFile(abs, zip.toBuffer());
  const t = new Date(LANDED_AT);
  await utimes(abs, t, t);
}

/** Every file under TMP but the cache, relative: what must all still be there after a delete that could not look. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(relative(TMP, p));
    }
  };
  await walk(dir);
  return out.filter((f) => !f.startsWith('cache')).sort();
}

const rows = () => q<{ id: string; file: string; root: string; pruned_at: Date | null; pruned_reason: string | null }>(
  'SELECT id, file, root, pruned_at, pruned_reason FROM lib_books WHERE source = $1 ORDER BY root, file', [SRC]);
const seriesOf = async (folder: string) =>
  (await q<{ id: string }>('SELECT id FROM lib_series WHERE source = $1 AND folder = $2', [SRC, folder]))[0]?.id;
const marked = async () => (await rows()).filter((x) => x.pruned_at).map((x) => `${x.file} (${x.pruned_reason})`);

async function wipe(): Promise<void> {
  const ids = (await q<{ id: string }>('SELECT id FROM lib_books WHERE source = $1', [SRC])).map((r) => r.id);
  await q('DELETE FROM read_progress WHERE book_id = ANY($1)', [ids]).catch(() => {});
  const sids = (await q<{ id: string }>('SELECT id FROM lib_series WHERE source = $1', [SRC]).catch(() => [])).map((r) => r.id);
  await q('DELETE FROM admin_bulk_delete_runs WHERE series_ids && $1::text[]', [sids]).catch(() => {});
  await q('UPDATE lib_series SET cover_book_id = NULL WHERE source = $1', [SRC]).catch(() => {});
  await q('DELETE FROM lib_books WHERE source = $1', [SRC]).catch(() => {});
  await q('DELETE FROM lib_series WHERE source = $1', [SRC]).catch(() => {});
  setBulkChapterDeleteTestHooks?.({});
  for (const d of [join(ROOT, OWN), join(DL, FETCHED)]) await chmod(d, 0o755).catch(() => {});
  await rm(TMP, { recursive: true, force: true });
}

/** Three chapters of your own, one of a neighbour beside them, three this server fetched, all indexed by a real scan. */
async function seed(): Promise<void> {
  for (const n of [1, 2, 3]) {
    await cbz(ROOT, `${OWN}/Chapter ${n}.cbz`);
    await cbz(DL, `${FETCHED}/Chapter ${n}.cbz`);
  }
  await cbz(ROOT, `${OTHER}/Chapter 1.cbz`);
  await persistScan();
  const all = await rows();
  assert.equal(all.length, 7, `PREMISE: the scan indexed the seven files: ${JSON.stringify(all)}`);
  assert.ok(all.every((r) => !r.pruned_at), 'PREMISE: nothing is marked yet');
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ persistScan } = (await import('../src/lib/library')) as any);
  ({ deleteSeriesFiles, deleteChapterFiles } = (await import('../src/lib/libraryAdmin')) as any);
  ({
    startBulkChapterDelete, readBulkChapterDeleteRun, closeInterruptedBulkChapterDeleteRuns, setBulkChapterDeleteTestHooks,
  } = (await import('../src/lib/bulkChapterDelete')) as any);
  await migrate();
});

beforeEach(async () => {
  if (!DSN) return;
  await wipe();
  await seed();
});

after(async () => {
  if (!DSN) return;
  await wipe().catch(() => {});
});

test('Delete files leaves the chapters of a folder it may not read (EACCES) unmarked, and says so', { skip: skipUnreadable }, async () => {
  // A permissions slip on the removed series' folder, with another series' file on the same root proving the share is
  // mounted: stat answers EACCES, not ENOENT, and the files are there. Reconciling them as removed by hand tombstones
  // chapters whose bytes are on disk, and Forget then erases everyone's history of them while the files stay.
  const id = await seriesOf(OWN);
  assert.ok(id, 'PREMISE: the scan made the series');
  await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [id]);
  const folder = join(ROOT, OWN);
  const files = await filesUnder(TMP);
  await chmod(folder, 0o000);
  let r: any;
  try { r = await deleteSeriesFiles(id); } finally { await chmod(folder, 0o755); }
  assert.deepEqual(await marked(), [], `chapters the server could not look at were marked: ${JSON.stringify(r)}`);
  assert.deepEqual(await filesUnder(TMP), files, 'a file went');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.files, 0);
  assert.equal(r.unchecked, 3, `the answer does not say three chapter files could not be looked at: ${JSON.stringify(r)}`);
});

test('PREMISE: Delete files on the same folder, readable, removes its three files and marks them', { skip }, async () => {
  // The other side of the case above: the same fixture with the mode bits right deletes as it always did, so the
  // unmarked rows there are the EACCES and nothing else.
  const id = await seriesOf(OWN);
  await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [id]);
  const r = await deleteSeriesFiles(id);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.files, 3, JSON.stringify(r));
  assert.ok(!r.unchecked, JSON.stringify(r));
  assert.deepEqual((await marked()).sort(), [1, 2, 3].map((n) => `${OWN}/Chapter ${n}.cbz (deleted)`));
});

test('deleting chosen chapters in a folder the server may not read marks none, and skips each as not removed', { skip: skipUnreadable }, async () => {
  // The same slip on a fetched series: Delete on the series page, Fix everything and the bulk delete all come here.
  // `outside_root` would tell the admin the file is outside the download folder; it is in it, and was not removed.
  const id = await seriesOf(FETCHED);
  const ids = (await rows()).filter((x) => x.root === DL).map((x) => x.id);
  assert.equal(ids.length, 3, 'PREMISE: three fetched chapters');
  const folder = join(DL, FETCHED);
  const files = await filesUnder(TMP);
  await chmod(folder, 0o000);
  let r: any;
  try { r = await deleteChapterFiles(id, ids, { userId: null }); } finally { await chmod(folder, 0o755); }
  assert.deepEqual(await marked(), [], `chapters the server could not look at were marked: ${JSON.stringify(r)}`);
  assert.deepEqual(await filesUnder(TMP), files, 'a file went');
  assert.equal(r.applied, 0, JSON.stringify(r));
  assert.deepEqual(r.skipped.map((s: any) => s.reason), ['unlink_failed', 'unlink_failed', 'unlink_failed'], JSON.stringify(r));
});

test("the bulk delete's crash recovery leaves a chapter in a folder it may not read live, and says why", { skip: skipUnreadable }, async () => {
  // The server died after committing the intent for Chapter 2 and before its unlink, and comes back up with the
  // series folder unreadable. Recovery never deletes; it may only tombstone a file that is not there, and EACCES is not
  // that. The cover (Chapter 1) is kept by the bulk delete, so Chapter 2 is the first it takes.
  const id = await seriesOf(FETCHED);
  const file2 = `${FETCHED}/Chapter 2.cbz`;
  const b2 = (await rows()).find((x) => x.file === file2)!;
  let crashed!: () => void;
  const reached = new Promise<void>((res) => { crashed = res; });
  setBulkChapterDeleteTestHooks({
    afterUnlink: (item: any) => {
      if (item.id !== b2.id) return;
      crashed();
      return 'simulate_crash';
    },
  });
  const run = await startBulkChapterDelete({ ids: [id], pause: false, userId: null, busy: () => false });
  assert.ok(run?.id, 'PREMISE: the run started');
  await reached;
  for (let i = 0; ; i++) {
    const [item] = await q<{ state: string }>('SELECT state FROM admin_bulk_delete_items WHERE run_id = $1 AND book_id = $2', [run.id, b2.id]);
    if (item?.state === 'intent') break;
    assert.ok(i < 300, 'PREMISE: the intent was committed');
    await new Promise((res) => setTimeout(res, 10));
  }
  setBulkChapterDeleteTestHooks({});
  await new Promise((res) => setTimeout(res, 20));
  // As if the unlink never ran: the file is back where it was, and the next process owns the old worker's row.
  await cbz(DL, file2);
  await q('UPDATE admin_bulk_delete_runs SET worker_id = gen_random_uuid() WHERE id = $1', [run.id]);
  const files = await filesUnder(TMP);
  const folder = join(DL, FETCHED);
  await chmod(folder, 0o000);
  try { assert.equal(await closeInterruptedBulkChapterDeleteRuns(), 1); } finally { await chmod(folder, 0o755); }
  assert.deepEqual(await marked(), [], 'the recovery tombstoned a chapter it could not look at');
  assert.deepEqual(await filesUnder(TMP), files, 'a file went');
  const [item] = await q<{ state: string; reason: string | null }>(
    'SELECT state, reason FROM admin_bulk_delete_items WHERE run_id = $1 AND book_id = $2', [run.id, b2.id]);
  assert.deepEqual(item, { state: 'unresolved', reason: 'interrupted_unreadable' });
  const done = await readBulkChapterDeleteRun(run.id);
  assert.equal(done.status, 'interrupted');
  assert.deepEqual(done.results[0].chapterSkips, { interrupted_unreadable: 1 }, JSON.stringify(done.results));
});
