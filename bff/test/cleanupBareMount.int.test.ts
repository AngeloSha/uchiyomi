// The read-chapter cleanup on a bare mount point that a download sweep has written REAL files onto, against a real
// Postgres and a real filesystem. libraryRootGone.int.test.ts covers a root that is missing, empty or unreadable, and
// a bare root holding only the empty folders a sweep's mkdir -p leaves.
//
// What it stands for: the download folder is often a network share or removable drive bind-mounted at /library-dl.
// With it not mounted, the container sees a bare directory, and the sweep goes on fetching into it -- new chapters, in
// the folders of series the catalog already knows, or in a new series' folder. The root is no longer empty, so a
// "does it hold anything" check reads it as mounted, and a series folder holding a new chapter reads as proof that the
// series is there. The cleanup must still mark nothing: every chapter it would mark "deleted" sits on the real share.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, rename, rm, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const TMP = join(tmpdir(), `uchiyomi-bm-${process.pid}`);
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

const SRC = 'T!bm';
const FETCHED = `${SRC}/Fetched`;  // a series this server downloaded, two of its chapters read
const OTHER = `${SRC}/Other`;      // a second downloaded series, also read
const NEW = `${SRC}/Brand New`;    // a series the sweep starts while the share is down
const LONG = `${SRC}/Long`;        // a downloaded series nobody has read: the bulk of a real share
const LONG_CHAPTERS = 20;
const READER = 'bm-reader';
const LANDED_AT = Date.now() - 10 * 86_400_000;

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let persistScan: () => Promise<any>;
let runCleanupOnce: () => Promise<any>;

// A 1x1 PNG: a page every reader of an archive accepts.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function cbz(root: string, rel: string, landed = LANDED_AT): Promise<void> {
  const abs = join(root, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  const zip = new AdmZip();
  for (let i = 1; i <= 2; i++) zip.addFile(`${String(i).padStart(3, '0')}.png`, PNG);
  await writeFile(abs, zip.toBuffer());
  const t = new Date(landed);
  await utimes(abs, t, t);
}

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

const marked = async () => (await q<{ file: string; pruned_reason: string | null }>(
  'SELECT file, pruned_reason FROM lib_books WHERE source = $1 AND pruned_at IS NOT NULL ORDER BY file', [SRC],
)).map((r) => `${r.file} (${r.pruned_reason})`);

/**
 * Take the share away: the real download dir moves aside and a bare directory stands at its path, the way a dropped
 * share leaves the mount point. The answer puts the share back, and whatever the "sweep" wrote onto the bare mount
 * point goes with it.
 */
async function dropShare(): Promise<() => Promise<void>> {
  const away = `${DL}.share`;
  await rename(DL, away);
  await mkdir(DL);
  return async () => {
    await rm(DL, { recursive: true, force: true });
    await rename(away, DL);
  };
}

async function wipe(): Promise<void> {
  const ids = (await q<{ id: string }>('SELECT id FROM lib_books WHERE source = $1', [SRC])).map((r) => r.id);
  await q('DELETE FROM page_hashes WHERE book_id = ANY($1)', [ids]).catch(() => {});
  await q('DELETE FROM read_progress WHERE book_id = ANY($1)', [ids]).catch(() => {});
  await q('UPDATE lib_series SET cover_book_id = NULL WHERE source = $1', [SRC]).catch(() => {});
  await q('DELETE FROM lib_books WHERE source = $1', [SRC]).catch(() => {});
  await q('DELETE FROM lib_series WHERE source = $1', [SRC]).catch(() => {});
  await q('UPDATE server_settings SET cleanup_read = false, cleanup_read_days = 30 WHERE id = 1').catch(() => {});
  await rm(TMP, { recursive: true, force: true });
  await rm(`${DL}.share`, { recursive: true, force: true });
}

/**
 * Two downloaded series of three chapters each and a longer one nobody has read, indexed by a real scan, and chapters 2
 * and 3 of the first two finished a day ago: four chapters due for the cleanup at 0 days (chapter 1 is each series'
 * cover, never due).
 */
async function seed(): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  for (const n of [1, 2, 3]) {
    await cbz(DL, `${FETCHED}/Chapter ${n}.cbz`);
    await cbz(DL, `${OTHER}/Chapter ${n}.cbz`);
  }
  for (let n = 1; n <= LONG_CHAPTERS; n++) await cbz(DL, `${LONG}/Chapter ${n}.cbz`);
  await persistScan();
  const n = (await q<{ n: number }>('SELECT count(*)::int n FROM lib_books WHERE source = $1 AND root = $2', [SRC, DL]))[0].n;
  assert.equal(n, 6 + LONG_CHAPTERS, 'PREMISE: the scan indexed every downloaded file');
  await q('UPDATE server_settings SET cleanup_read = true, cleanup_read_days = 0 WHERE id = 1');
  const [u] = await q<{ id: string }>('SELECT id FROM users WHERE username = $1', [READER]);
  for (const folder of [FETCHED, OTHER]) {
    for (const c of [2, 3]) {
      const [b] = await q<{ id: string; series_id: string }>('SELECT id, series_id FROM lib_books WHERE root = $1 AND file = $2', [DL, `${folder}/Chapter ${c}.cbz`]);
      await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at)
               VALUES ($1,$2,$3,1,true, now() - interval '1 day')`, [u.id, b.id, b.series_id]);
    }
  }
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ persistScan } = (await import('../src/lib/library')) as any);
  ({ runCleanupOnce } = (await import('../src/lib/chapterCleanup')) as any);
  await migrate();
  await q('DELETE FROM users WHERE username = $1', [READER]).catch(() => {});
  await q(`INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ($1,$1,'user','x','password')`, [READER]);
});

beforeEach(async () => {
  if (!DSN) return;
  await wipe();
  await seed();
});

after(async () => {
  if (!DSN) return;
  await wipe().catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [READER]).catch(() => {});
});

test('PREMISE: with the share there, the cleanup deletes the four due chapters', { skip }, async () => {
  const r = await runCleanupOnce();
  assert.equal(r.deleted, 4, JSON.stringify(r));
  assert.equal(r.stopped, undefined);
});

test('the cleanup on a bare mount point a sweep started a NEW series on marks nothing', { skip }, async () => {
  // The sweep's files are in a folder no due chapter lives in: every due chapter's own folder is missing.
  const files = await filesUnder(TMP);
  const restore = await dropShare();
  let r: any;
  try {
    await cbz(DL, `${NEW}/Chapter 1.cbz`, Date.now());
    await cbz(DL, `${NEW}/Chapter 2.cbz`, Date.now());
    r = await runCleanupOnce();
  } finally { await restore(); }
  assert.deepEqual(await marked(), [], `chapters on the dropped share were tombstoned: ${JSON.stringify(r)}`);
  assert.equal(r.deleted, 0);
  assert.equal(r.stopped, 'unmounted', `the run did not say the volume looks unmounted: ${JSON.stringify(r)}`);
  assert.deepEqual(await filesUnder(TMP), files, 'a file on the share went');
});

test('the cleanup on a bare mount point a sweep wrote a new chapter of a KNOWN series into marks nothing', { skip }, async () => {
  // The sweep fetched chapter 4 of a series the catalog knows, so that series' folder on the bare mount point holds a
  // real file. It is no proof the share is there: chapters 2 and 3 of that series, and of
  // the other series, are on the share, and marking them 'deleted' hides them from every reader -- and, since a
  // 'deleted' tombstone is held, the sweep never fetches them back either.
  const files = await filesUnder(TMP);
  const restore = await dropShare();
  let r: any;
  try {
    await cbz(DL, `${FETCHED}/Chapter 4.cbz`, Date.now());
    r = await runCleanupOnce();
  } finally { await restore(); }
  assert.deepEqual(await marked(), [], `chapters on the dropped share were tombstoned: ${JSON.stringify(r)}`);
  assert.equal(r.deleted, 0);
  assert.equal(r.stopped, 'unmounted', `the run did not say the volume looks unmounted: ${JSON.stringify(r)}`);
  assert.deepEqual(await filesUnder(TMP), files, 'a file on the share went');
});

test('the same, after a scan indexed the new chapter: one present file among 27 rows is no proof either', { skip }, async () => {
  // The sweep scans when it added something, so the new chapter can be a catalog row of its own whose file IS there.
  // One present file among rows whose files are almost all gone is Verify's 90 % case, not a mounted share.
  const files = await filesUnder(TMP);
  const restore = await dropShare();
  let r: any;
  try {
    await cbz(DL, `${FETCHED}/Chapter 4.cbz`, Date.now());
    const [s] = await q<{ series_id: string }>('SELECT series_id FROM lib_books WHERE root = $1 AND file = $2', [DL, `${FETCHED}/Chapter 1.cbz`]);
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, mtime)
             VALUES ('b_bm_new4', $1, $2, $3, 4, 'Chapter 4', $4, $5)`, [s.series_id, SRC, `${FETCHED}/Chapter 4.cbz`, DL, Date.now()]);
    r = await runCleanupOnce();
  } finally { await restore(); }
  assert.deepEqual(await marked(), [], `chapters on the dropped share were tombstoned: ${JSON.stringify(r)}`);
  assert.equal(r.deleted, 0);
  assert.equal(r.stopped, 'unmounted', `the run did not say the volume looks unmounted: ${JSON.stringify(r)}`);
  assert.deepEqual(await filesUnder(TMP), files, 'a file on the share went');
});

test('a series removed by hand while the share is there is still marked: the guard is not a wedge', { skip }, async () => {
  // The contrast (chapterCleanup.int.test.ts "a removed series does not wedge the cleanup"): the share is mounted,
  // one series' folder was deleted by hand. Its due rows claim bytes that do not exist and are marked; the other
  // series' due chapters are deleted.
  await rm(join(DL, OTHER), { recursive: true, force: true });
  const r = await runCleanupOnce();
  assert.equal(r.stopped, undefined, `a removed series read as an unmounted volume: ${JSON.stringify(r)}`);
  assert.equal(r.deleted, 4, JSON.stringify(r));
  assert.deepEqual(await marked(), [
    `${FETCHED}/Chapter 2.cbz (deleted)`, `${FETCHED}/Chapter 3.cbz (deleted)`,
    `${OTHER}/Chapter 2.cbz (deleted)`, `${OTHER}/Chapter 3.cbz (deleted)`,
  ]);
});
