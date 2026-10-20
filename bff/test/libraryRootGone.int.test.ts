// A library or download root that is not there, is empty, or cannot be read, against a real Postgres and a real
// filesystem.
//
// What it stands for: /library and /library-dl are often a network share or removable drive bind-mounted into the
// container. One that isn't mounted, a share that dropped (every stat fails) or a permissions slip leaves the server
// looking at a folder that says nothing true about the files. Every job that reads a root and writes what it saw back
// into the catalog is run here against each of the three, and must change nothing on that evidence: no row marked
// pruned or missing, no file removed, no "checked" stamp that the next night trusts -- and the problem has to be said
// (Health, a result, a log).
//
//   missing     the root path does not exist (ENOENT)
//   empty       an empty directory where the files were (a bare mount point; Docker creates one for a missing source)
//   unreadable  the root is mode 000 (EACCES); skipped when the tests run as root, which reads through mode bits
//
// A failed stat is a file already gone only when it says so (ENOENT, ENOTDIR); anything else leaves the row alone.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, rename, rm, stat, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const TMP = join(tmpdir(), `uchiyomi-rg-${process.pid}`);
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
  process.env.REPAIR_PACE_MS = '0';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const skipUnreadable = skip || (asRoot ? 'running as root: mode bits do not stop root' : false);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

type Kind = 'missing' | 'empty' | 'unreadable';
const KINDS: Kind[] = ['missing', 'empty', 'unreadable'];
const skipFor = (k: Kind) => (k === 'unreadable' ? skipUnreadable : skip);

const SRC = 'T!rg';
const OWN = `${SRC}/Own`;          // the read library's series (LIBRARY_ROOT)
const FETCHED = `${SRC}/Fetched`;  // a series this server downloaded (DL_ROOT)
const READER = 'rg-reader';
const LANDED_AT = Date.now() - 10 * 86_400_000;

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let persistScan: () => Promise<any>;
let lastScanReport: () => any;
let runCleanupOnce: () => Promise<any>;
let verifyChapterFiles: () => Promise<any>;
let runRepair: (log?: any, opts?: any) => Promise<any> | false;
let runFingerprintBackfill: (o?: any) => Promise<any>;
let runPageHashBackfill: (o?: any) => Promise<any>;
let previewRescan: () => Promise<any>;
let diskAndFolders: () => Promise<any>;

// A 1x1 PNG: a page every reader of an archive accepts.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function cbz(root: string, rel: string, pages = 2): Promise<void> {
  const abs = join(root, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  const zip = new AdmZip();
  for (let i = 1; i <= pages; i++) zip.addFile(`${String(i).padStart(3, '0')}.png`, PNG);
  await writeFile(abs, zip.toBuffer());
  const t = new Date(LANDED_AT);
  await utimes(abs, t, t);
}

/** Every file under TMP, relative: what must still be there once a root is put back. */
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

/** What a job could get wrong about a chapter on the evidence of a broken root. */
const rows = () => q<{ id: string; file: string; root: string; pruned_at: Date | null; pruned_reason: string | null; counted: boolean; printed: boolean; hashed: boolean }>(
  `SELECT b.id, b.file, b.root, b.pruned_at, b.pruned_reason, b.pages_checked_at IS NOT NULL AS counted, b.fp_at IS NOT NULL AS printed,
          EXISTS (SELECT 1 FROM page_hashes p WHERE p.book_id = b.id AND p.page = 0) AS hashed
     FROM lib_books b WHERE b.source = $1 ORDER BY b.root, b.file`, [SRC]);
const seriesRows = () => q<{ folder: string; deleted_at: Date | null; books_count: number }>(
  'SELECT folder, deleted_at, books_count FROM lib_series WHERE source = $1 ORDER BY folder', [SRC]);
const under = (all: Awaited<ReturnType<typeof rows>>, root: string) => all.filter((r) => r.root === root);

/**
 * Break `dir` the `kind` way; the answer puts it back exactly. `empty` leaves a fresh directory behind the path (the
 * files are kept beside it), so whatever a job wrote into the bare mount point goes when it is put back.
 */
async function breakDir(dir: string, kind: Kind): Promise<() => Promise<void>> {
  if (kind === 'unreadable') {
    await chmod(dir, 0o000);
    return async () => { await chmod(dir, 0o755); };
  }
  const away = `${dir}.away`;
  await rename(dir, away);
  if (kind === 'empty') await mkdir(dir);
  return async () => {
    await rm(dir, { recursive: true, force: true });
    await rename(away, dir);
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
  for (const d of [ROOT, DL, join(ROOT, OWN), join(DL, FETCHED), join(DL, `${SRC}/Locked`)]) await chmod(d, 0o755).catch(() => {});
  await rm(TMP, { recursive: true, force: true });
}

/** Three chapters of your own, three this server fetched, all indexed by a real scan. */
async function seed(): Promise<void> {
  for (const n of [1, 2, 3]) {
    await cbz(ROOT, `${OWN}/Chapter ${n}.cbz`);
    await cbz(DL, `${FETCHED}/Chapter ${n}.cbz`);
  }
  await persistScan();
  const all = await rows();
  assert.equal(all.length, 6, `PREMISE: the scan indexed the six files: ${JSON.stringify(all)}`);
  assert.ok(all.every((r) => !r.pruned_at && !r.counted && !r.printed && !r.hashed), 'PREMISE: nothing is stamped yet');
}

/** The reader finished chapters 2 and 3 of the fetched series a day ago: due for the read-chapter cleanup at 0 days. */
async function readFetched(): Promise<void> {
  await q('UPDATE server_settings SET cleanup_read = true, cleanup_read_days = 0 WHERE id = 1');
  const [u] = await q<{ id: string }>('SELECT id FROM users WHERE username = $1', [READER]);
  for (const n of [2, 3]) {
    const [b] = await q<{ id: string; series_id: string }>('SELECT id, series_id FROM lib_books WHERE root = $1 AND file = $2', [DL, `${FETCHED}/Chapter ${n}.cbz`]);
    await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at)
             VALUES ($1,$2,$3,1,true, now() - interval '1 day')`, [u.id, b.id, b.series_id]);
  }
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ persistScan, lastScanReport } = (await import('../src/lib/library')) as any);
  ({ runCleanupOnce } = (await import('../src/lib/chapterCleanup')) as any);
  ({ verifyChapterFiles } = (await import('../src/lib/verifyFiles')) as any);
  ({ runRepair } = (await import('../src/lib/repair')) as any);
  ({ runFingerprintBackfill } = (await import('../src/lib/fingerprintJob')) as any);
  ({ runPageHashBackfill } = (await import('../src/lib/pageHashJob')) as any);
  ({ previewRescan } = (await import('../src/lib/rescan')) as any);
  ({ diskAndFolders } = (await import('../src/lib/healthDisk')) as any);
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

// ---- the scan --------------------------------------------------------------------------------------------------------

for (const kind of KINDS) {
  test(`a scan with the library root ${kind} changes no row, and Health says the folder is not right`, { skip: skipFor(kind) }, async () => {
    const before1 = await rows();
    const series1 = await seriesRows();
    const files = await filesUnder(TMP);
    const restore = await breakDir(ROOT, kind);
    let card: any;
    try {
      await persistScan();
      card = await diskAndFolders();
    } finally { await restore(); }
    assert.deepEqual(await rows(), before1, 'a scan of a broken root changed a chapter row');
    assert.deepEqual(await seriesRows(), series1, 'a scan of a broken root changed a series row (hidden, or recounted)');
    assert.deepEqual(await filesUnder(TMP), files, 'a file went');
    const item = card.items.find((i: any) => i.key === 'folder:library');
    assert.ok(item, `Health did not name the library folder: ${JSON.stringify(card.items)}`);
    assert.equal(card.status, 'problem');
    if (kind === 'unreadable') {
      const walk = lastScanReport()?.walk ?? [];
      assert.ok(walk.some((w: any) => w.root === 'library' && w.folder === '' && w.reason === 'unreadable'),
        `the scan's report does not say the root could not be read: ${JSON.stringify(walk)}`);
    }
  });
}

// ---- Rescan everything (the preview) ---------------------------------------------------------------------------------

for (const kind of KINDS) {
  test(`Rescan everything with the library root ${kind} plans nothing and says the folder looks unmounted`, { skip: skipFor(kind) }, async () => {
    const before1 = await rows();
    const restore = await breakDir(ROOT, kind);
    let plan: any;
    try { plan = await previewRescan(); } finally { await restore(); }
    assert.deepEqual(plan.mark, [], 'a chapter under a broken root was planned as gone');
    assert.ok(plan.unmounted.some((u: any) => u.root === ROOT), `the library root was not reported: ${JSON.stringify(plan.unmounted)}`);
    assert.deepEqual((await rows()).map((r) => [r.id, r.pruned_at, r.printed]), before1.map((r) => [r.id, r.pruned_at, r.printed]),
      'the preview changed a row (a mark, or a fingerprint stamped from a file it could not read)');
  });
}

// ---- Verify chapter files ---------------------------------------------------------------------------------------------

for (const which of ['library', 'downloads'] as const) {
  for (const kind of KINDS) {
    test(`Verify with the ${which} root ${kind} marks nothing missing and reports the root`, { skip: skipFor(kind) }, async () => {
      const dir = which === 'library' ? ROOT : DL;
      const files = await filesUnder(TMP);
      const restore = await breakDir(dir, kind);
      let r: any;
      try { r = await verifyChapterFiles(); } finally { await restore(); }
      assert.equal(r.missing, 0, `rows were marked missing: ${JSON.stringify(r)}`);
      assert.equal(r.readLibraryMissing, 0, `read-library chapters were counted missing: ${JSON.stringify(r)}`);
      assert.ok(r.unmounted.some((u: string) => u.startsWith(dir)), `the broken root was not reported: ${JSON.stringify(r.unmounted)}`);
      assert.ok((await rows()).every((x) => !x.pruned_at), 'a row was pruned');
      assert.deepEqual(await filesUnder(TMP), files, 'a file went');
    });
  }
}

test('Verify does not mark the chapters of a download folder it may not read as missing', { skip: skipUnreadable }, async () => {
  // A permissions slip on one series folder (EACCES), with the rest of the download root fine: those files are there,
  // and marking them 'missing' has the sweep fetch them again over the top. Only "not there" (ENOENT) is missing.
  for (const n of [1, 2]) await cbz(DL, `${SRC}/Locked/Chapter ${n}.cbz`);
  await persistScan();
  const locked = join(DL, `${SRC}/Locked`);
  await chmod(locked, 0o000);
  let r: any;
  try { r = await verifyChapterFiles(); } finally { await chmod(locked, 0o755); }
  const marked = (await rows()).filter((x) => x.pruned_at).map((x) => x.file);
  assert.deepEqual(marked, [], `chapters in a folder the server may not read were marked missing: ${JSON.stringify(r)}`);
  assert.equal(r.missing, 0);
});

// ---- the read-chapter cleanup (hourly, unattended) -------------------------------------------------------------------

for (const kind of KINDS) {
  test(`the read-chapter cleanup with the download root ${kind} marks nothing and says why`, { skip: skipFor(kind) }, async () => {
    await readFetched();
    const files = await filesUnder(TMP);
    const restore = await breakDir(DL, kind);
    let r: any;
    try { r = await runCleanupOnce(); } finally { await restore(); }
    assert.equal(r.deleted, 0, `chapters were marked deleted: ${JSON.stringify(r)}`);
    assert.ok(r.skipped === 'read_only' || r.stopped === 'unmounted', `the run did not say why it did nothing: ${JSON.stringify(r)}`);
    assert.ok((await rows()).every((x) => !x.pruned_at), 'a row was pruned');
    assert.deepEqual(await filesUnder(TMP), files, 'a file went');
  });
}

test('the read-chapter cleanup on a bare mount point with an empty folder a sweep left marks nothing', { skip }, async () => {
  // The downloader mkdir -p's a series folder before it writes, so a sweep that ran while the share was down leaves
  // empty series folders on the bare mount point. An empty folder is no proof the volume is there (Verify's rule):
  // every due chapter's file is missing, so the run must stop as unmounted, not tombstone them as deleted.
  await readFetched();
  const files = await filesUnder(TMP);
  const restore = await breakDir(DL, 'empty');
  let r: any;
  try {
    await mkdir(join(DL, FETCHED), { recursive: true });
    r = await runCleanupOnce();
  } finally { await restore(); }
  const marked = (await rows()).filter((x) => x.pruned_at).map((x) => `${x.file} (${x.pruned_reason})`);
  assert.deepEqual(marked, [], `chapters on the unmounted disk were tombstoned: ${JSON.stringify(r)}`);
  assert.equal(r.stopped, 'unmounted');
  assert.deepEqual(await filesUnder(TMP), files, 'a file went');
});

test('the read-chapter cleanup leaves a chapter it may not look at (EACCES) unmarked, for the next run', { skip: skipUnreadable }, async () => {
  // A folder the server may not read says nothing about whether the file is there: stat answers EACCES, not ENOENT.
  // Marking it 'deleted' hides a chapter whose bytes are on disk (and throws away its measurements) without deleting it.
  await readFetched();
  const folder = join(DL, FETCHED);
  const files = await filesUnder(TMP);
  await chmod(folder, 0o000);
  let r: any;
  try { r = await runCleanupOnce(); } finally { await chmod(folder, 0o755); }
  const marked = (await rows()).filter((x) => x.pruned_at).map((x) => `${x.file} (${x.pruned_reason})`);
  assert.deepEqual(marked, [], `chapters the server could not look at were marked: ${JSON.stringify(r)}`);
  assert.equal(r.deleted, 0);
  assert.equal(r.failed, 2, 'both are counted as not removed, for the next run');
  assert.deepEqual(await filesUnder(TMP), files, 'a file went');
});

// ---- the nightly repair's page count ----------------------------------------------------------------------------------

for (const kind of KINDS) {
  test(`the nightly page count with the library root ${kind} stamps nothing there, and still counts the download root`, { skip: skipFor(kind) }, async () => {
    // A stamp is for good: `pages = 0` with pages_checked_at set is what Health's Chapter files card lists as a file
    // nobody can open, and the count never reopens it (only a changed mtime clears it). Stamped from a share that is
    // not there, every uncounted chapter of the library would read as broken once it is back.
    const restore = await breakDir(ROOT, kind);
    let r: any;
    try { r = await runRepair(undefined, { only: ['count'], userId: null }); } finally { await restore(); }
    assert.ok(r, 'PREMISE: the repair ran');
    const all = await rows();
    assert.deepEqual(under(all, ROOT).filter((x) => x.counted).map((x) => x.file), [], `chapters under a ${kind} root were stamped as counted`);
    assert.ok(under(all, DL).every((x) => x.counted), 'the download root, which is fine, was not counted');
  });
}

test('the nightly page count does not stamp a chapter in a folder it may not read', { skip: skipUnreadable }, async () => {
  const folder = join(ROOT, OWN);
  await chmod(folder, 0o000);
  try { await runRepair(undefined, { only: ['count'], userId: null }); } finally { await chmod(folder, 0o755); }
  const all = await rows();
  assert.deepEqual(under(all, ROOT).filter((x) => x.counted).map((x) => x.file), [], 'an unreadable folder\'s chapters were stamped 0 pages');
  assert.ok(under(all, DL).every((x) => x.counted));
});

// ---- the background fingerprint and page-hash passes ------------------------------------------------------------------

for (const job of ['count', 'fingerprint', 'pagehash']) {
  test(`${job} still records a missing queued file when other catalogued files prove the root is mounted`, { skip }, async () => {
    const run = async () => {
      if (job === 'count') await runRepair(undefined, { only: ['count'], userId: null });
      else if (job === 'fingerprint') await runFingerprintBackfill();
      else await runPageHashBackfill();
    };
    await run();
    const target = under(await rows(), ROOT)[0];
    await rm(join(ROOT, target.file));
    if (job === 'count') await q('UPDATE lib_books SET pages = 0, pages_checked_at = NULL WHERE id = $1', [target.id]);
    else if (job === 'fingerprint') await q('UPDATE lib_books SET fp_at = NULL WHERE id = $1', [target.id]);
    else await q('DELETE FROM page_hashes WHERE book_id = $1', [target.id]);
    await run();
    const field = job === 'count' ? 'counted' : job === 'fingerprint' ? 'printed' : 'hashed';
    assert.ok((await rows()).find((r) => r.id === target.id)![field], 'a queued subset was mistaken for the whole root');
  });
  for (const kind of ['stray file', 'one of many catalog files']) {
    test(`${job} leaves a populated bare mount unmarked (${kind})`, { skip }, async () => {
      if (kind === 'one of many catalog files') {
        for (let n = 100; n < 120; n++) await cbz(ROOT, `${OWN}/Chapter ${n}.cbz`);
        await persistScan();
      }
      const original = await rows();
      const restore = await breakDir(ROOT, 'empty');
      const run = async () => {
        if (job === 'count') await runRepair(undefined, { only: ['count'], userId: null });
        else if (job === 'fingerprint') await runFingerprintBackfill();
        else await runPageHashBackfill();
      };
      try {
        const rel = kind === 'stray file' ? 'Uncatalogued/Chapter 999.cbz' : under(original, ROOT)[0].file;
        await cbz(ROOT, rel);
        await run();
        const all = await rows();
        const field = job === 'count' ? 'counted' : job === 'fingerprint' ? 'printed' : 'hashed';
        assert.ok(under(all, ROOT).every((x) => !x[field]), `${job} stamped rows on a populated bare mount`);
        assert.ok(under(all, DL).every((x) => x[field]), 'the healthy second root did not run');
      } finally { await restore(); }
      await run();
      const field = job === 'count' ? 'counted' : job === 'fingerprint' ? 'printed' : 'hashed';
      assert.ok(under(await rows(), ROOT).every((x) => x[field]), 'the recovered root did not resume');
    });
  }
}

for (const kind of KINDS) {
  test(`the fingerprint pass with the library root ${kind} stamps nothing there`, { skip: skipFor(kind) }, async () => {
    // fp_at is stamped even for a failed read, so it is never attempted again: a file stamped from a share that is not
    // there can never be recognised after a move (Rescan everything pairs on the fingerprint).
    const restore = await breakDir(ROOT, kind);
    try { await runFingerprintBackfill(); } finally { await restore(); }
    const all = await rows();
    assert.deepEqual(under(all, ROOT).filter((x) => x.printed).map((x) => x.file), [], `chapters under a ${kind} root were stamped as fingerprinted`);
    assert.ok(under(all, DL).every((x) => x.printed), 'the download root, which is fine, was not fingerprinted');
  });

  test(`the page-hash pass with the library root ${kind} marks nothing there as looked at`, { skip: skipFor(kind) }, async () => {
    const restore = await breakDir(ROOT, kind);
    try { await runPageHashBackfill(); } finally { await restore(); }
    const all = await rows();
    assert.deepEqual(under(all, ROOT).filter((x) => x.hashed).map((x) => x.file), [], `chapters under a ${kind} root were marked as hashed`);
    assert.ok(under(all, DL).every((x) => x.hashed), 'the download root, which is fine, was not hashed');
  });
}

test('PREMISE: with every root fine, each job does its work on both roots', { skip }, async () => {
  // So the tests above fail for the right reason: the jobs do reach these rows when nothing is broken.
  await runRepair(undefined, { only: ['count'], userId: null });
  await runFingerprintBackfill();
  await runPageHashBackfill();
  const all = await rows();
  assert.ok(all.every((x) => x.counted && x.printed && x.hashed), JSON.stringify(all));
  assert.ok((await stat(ROOT)).isDirectory());
});
