// "Rescan everything" (lib/rescan.ts, v0.55.4, discussion #150): the chapters whose files are gone from your own
// folders, found and shown first, then marked on Apply.
//
// The tests that matter are the ways this could destroy something or lie: a preview that calls a file gone when it
// was renamed (its old row holds everyone's reading history), when its folder could not be read, or when the whole
// volume is simply not mounted; a plan that would touch the download folder, which is Verify's; and a preview that
// changes anything at all.
//
// Driven against a real library on disk: every file is a real one-page archive, the rows are the ones persistScan
// writes, and the route is driven for real at the end (mounted admin routes).
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, rename, chmod, readdir, readFile, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const TMP = join(tmpdir(), `uchiyomi-rs-${process.pid}`);
const ROOT = join(TMP, 'lib');
const DL = join(TMP, 'dl');

if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LIBRARY_ROOT = ROOT;
  process.env.DL_ROOT = DL;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let persistScan: () => Promise<any>;
let scanCount: () => number;
let previewRescan: () => Promise<any>;
let startRescan: (log?: any) => Promise<any> | false;
let startApply: (input: any, who: any, opts?: any) => any;
let rescanState: any;
let PLAN_TTL_MS: number;
let runtime: any;
let verifyState: any;
let runFingerprintBackfill: () => Promise<any>;
let numFromName: (name: string) => number;
let app: any, adminTok: string, adminId: string;

const ADMIN = 'rs-admin';
const READER = 'rs-reader';
const SRC = 'T!rs';

/** A real one-page archive. Its page names its own path, so no two files share a fingerprint unless one IS the other. */
async function cbz(root: string, rel: string) {
  const z = new AdmZip();
  z.addFile('001.jpg', Buffer.from(`page-of-${rel}`));
  const abs = join(root, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, z.toBuffer());
}

interface BookRow { id: string; series_id: string; file: string; root: string; pruned_at: string | null; pruned_reason: string | null }
const allRows = () => q<BookRow>(`SELECT id, series_id, file, root, pruned_at, pruned_reason FROM lib_books ORDER BY root, file`);
async function rowOf(root: string, rel: string): Promise<BookRow> {
  const r = (await q<BookRow>(`SELECT id, series_id, file, root, pruned_at, pruned_reason FROM lib_books WHERE root = $1 AND file = $2`, [root, rel]))[0];
  assert.ok(r, `no row for ${root}/${rel}`);
  return r;
}
const seriesOf = async (folder: string) => (await q<{ id: string }>(`SELECT id FROM lib_series WHERE folder = $1`, [folder]))[0]?.id;

/**
 * The library: Kept (three chapters) and Gone (two) in your own folder, Fetched (two) in the download folder.
 * Scanned, so every row is the one persistScan writes.
 */
async function seed() {
  for (const n of [1, 2, 3]) await cbz(ROOT, `${SRC}/Kept/Chapter ${n}.cbz`);
  for (const n of [1, 2]) await cbz(ROOT, `${SRC}/Gone/Chapter ${n}.cbz`);
  for (const n of [1, 2]) await cbz(DL, `${SRC}/Fetched/Chapter ${n}.cbz`);
  await persistScan();
}

async function wipe() {
  // The whole tables, as verifyFiles.int.test.ts does: the suite runs with --test-concurrency=1.
  await q(`DELETE FROM read_progress`).catch(() => {});
  await q(`DELETE FROM lib_books`).catch(() => {});
  await q(`DELETE FROM lib_series`).catch(() => {});
  await q(`DELETE FROM series_trackers WHERE external_id LIKE 'rs-%'`).catch(() => {});
  await chmod(join(ROOT, SRC), 0o755).catch(() => {});
  await chmod(join(ROOT, SRC, 'Locked'), 0o755).catch(() => {});
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
  await mkdir(ROOT, { recursive: true });
  await mkdir(DL, { recursive: true });
  Object.assign(rescanState, { running: null, phase: null, done: 0, of: null, startedAt: null, plan: null, error: null, appliedAt: null, lastApplied: null });
  await q('DELETE FROM users WHERE username = $1', [READER]).catch(() => {});
}

/** A preview, the way the panel starts one. */
async function preview(): Promise<any> {
  const run = startRescan();
  assert.ok(run, 'the preview did not start');
  return run;
}
/** An Apply of `plan`, the way the panel presses it; the result once it is done. */
async function apply(plan: any, opts: any = {}): Promise<any> {
  const r = startApply({ plan: plan.id }, { userId: adminId }, opts);
  assert.ok(r.ok, `Apply was refused: ${JSON.stringify(r)}`);
  return r.run;
}
const prunedOf = async (root: string, rel: string) => {
  const r = await rowOf(root, rel);
  return { at: r.pruned_at, reason: r.pruned_reason };
};
const exists = (p: string) => readFile(p).then(() => true).catch(() => false);

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ persistScan, scanCount } = (await import('../src/lib/library')) as any);
  ({ previewRescan, startRescan, startApply, rescanState, PLAN_TTL_MS } = (await import('../src/lib/rescan')) as any);
  ({ runtime } = (await import('../src/lib/runtime')) as any);
  ({ verifyState } = (await import('../src/lib/verifyFiles')) as any);
  ({ runFingerprintBackfill } = (await import('../src/lib/fingerprintJob')) as any);
  ({ numFromName } = (await import('../src/lib/naming')) as any);
  await migrate();
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
  adminId = (await q<{ id: string }>(
    `INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ($1,$1,'admin','x','password') RETURNING id`, [ADMIN]))[0].id;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const adminRoutes = (await import('../src/routes/admin')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.ready();
  adminTok = `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}`;
});

beforeEach(async () => { if (DSN) await wipe(); });

after(async () => {
  if (!DSN) return;
  await wipe().catch(() => {});
  await q(`DELETE FROM audit_log WHERE event LIKE 'library.rescan%' OR (event = 'task.run' AND detail->>'task' = 'rescan')
             OR (event = 'series.merge' AND detail->>'via' = 'rescan')`).catch(() => {});
  await q('UPDATE server_settings SET rescan_last_run = NULL, rescan_last_result = NULL WHERE id = 1').catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
  await app?.close().catch(() => {});
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
});

// ---- the preview ----------------------------------------------------------------------------------------------------

test('the preview scans first, so a file added by hand is in the library before anything is looked at', { skip }, async () => {
  // Reintroduce by dropping persistScan() from previewRescan: Chapter 4 has no row, and the plan looked at five.
  await seed();
  await cbz(ROOT, `${SRC}/Kept/Chapter 4.cbz`);
  const before = scanCount();
  const plan = await previewRescan();
  assert.ok(scanCount() > before, 'the preview did not scan');
  const four = await rowOf(ROOT, `${SRC}/Kept/Chapter 4.cbz`);
  assert.equal(four.pruned_at, null);
  assert.equal(plan.looked, 8, `every live row's file was looked for, the new one included: ${JSON.stringify(plan)}`);
  assert.deepEqual(plan.mark, [], 'nothing is gone');
});

test('a gone file in your own folder is planned, one in the download folder only counted, and the preview changes no row', { skip }, async () => {
  // Reintroduce by planning the download folder's rows too (drop the DL_ROOT branch in previewRescan): Fetched's
  // chapter 2 is in plan.mark.
  await seed();
  await rm(join(ROOT, SRC, 'Kept', 'Chapter 3.cbz'));
  await rm(join(DL, SRC, 'Fetched', 'Chapter 2.cbz'));
  const before = await allRows();
  const plan = await previewRescan();
  const three = await rowOf(ROOT, `${SRC}/Kept/Chapter 3.cbz`);
  assert.deepEqual(plan.mark, [{ id: three.id, seriesId: three.series_id, file: three.file }], JSON.stringify(plan));
  assert.equal(plan.downloads, 1, 'the download folder\'s gone file is counted');
  assert.deepEqual(plan.moved, []);
  assert.deepEqual(plan.unmounted, []);
  assert.equal(plan.looked, 7);
  assert.deepEqual(await allRows(), before, 'the preview changed a row');
});

test('an empty library folder looks unmounted and plans nothing', { skip }, async () => {
  // ⚠️ An unmounted share is an empty, readable mount point: every file looks gone. Reintroduce by dropping
  // `if (!present)` in previewRescan: the root is reported as "5 of 5 missing" by the 90 % rule, the second net over
  // the same hole, instead of plainly unmounted -- and with both gone, all five of your own rows are planned.
  await seed();
  await rm(join(ROOT, SRC), { recursive: true, force: true });
  // A folder a sweep could have left behind on the bare mount point proves nothing either.
  await mkdir(join(ROOT, SRC, 'Kept'), { recursive: true });
  const plan = await previewRescan();
  assert.deepEqual(plan.unmounted, [{ root: ROOT }], JSON.stringify(plan));
  assert.deepEqual(plan.mark, [], 'a row under an unmounted folder was planned');
  assert.deepEqual(plan.emptied, [], 'nothing under it is called empty either');
  assert.equal(plan.looked, 2, 'the download folder was still looked at');
});

test('a folder with almost every file gone is refused, with the share of it', { skip }, async () => {
  // One stray file on a bare mount must not turn "unmounted" into "mark the other nineteen". Reintroduce by dropping
  // the REFUSE_ABOVE test: nineteen rows are planned.
  for (let n = 1; n <= 20; n++) await cbz(ROOT, `${SRC}/Long/Chapter ${n}.cbz`);
  await persistScan();
  for (let n = 2; n <= 20; n++) await rm(join(ROOT, SRC, 'Long', `Chapter ${n}.cbz`));
  const plan = await previewRescan();
  assert.deepEqual(plan.unmounted, [{ root: ROOT, missing: 19, of: 20 }]);
  assert.deepEqual(plan.mark, []);
  // The boundary: nine in ten is not MORE than 90 %, and that folder is planned.
  await q(`DELETE FROM lib_books WHERE file LIKE $1 AND number > 10`, [`${SRC}/Long/%`]);
  const again = await previewRescan();
  assert.deepEqual(again.unmounted, []);
  assert.equal(again.mark.length, 9);
});

test('a file that cannot be checked is not a gone file', { skip }, async () => {
  // A folder the server may not read answers EACCES, not "not there". Reintroduce by reading every failed stat as
  // gone (look() in lib/rescan.ts): Locked's chapters are planned.
  if (process.getuid?.() === 0) return; // root reads through any mode bits: nothing to test
  await seed();
  for (const n of [1, 2]) await cbz(ROOT, `${SRC}/Locked/Chapter ${n}.cbz`);
  await persistScan();
  await chmod(join(ROOT, SRC, 'Locked'), 0o000);
  try {
    const plan = await previewRescan();
    assert.deepEqual(plan.mark, [], `an unreadable folder's chapters were planned: ${JSON.stringify(plan.mark)}`);
    assert.equal(plan.unchecked, 2, 'they are counted as not checked');
    assert.equal(plan.looked, 7);
  } finally {
    await chmod(join(ROOT, SRC, 'Locked'), 0o755);
  }
  // A folder where no file could be checked at all -- a NAS answering every stat with an I/O error -- is not a folder
  // with nothing gone: it looks unmounted. Reintroduce by skipping a root that saw nothing: no folder is reported.
  await chmod(join(ROOT, SRC), 0o000);
  try {
    const plan = await previewRescan();
    assert.deepEqual(plan.unmounted, [{ root: ROOT }], `a folder where nothing could be checked read as fine: ${JSON.stringify(plan)}`);
    assert.deepEqual(plan.mark, []);
  } finally {
    await chmod(join(ROOT, SRC), 0o755);
  }
});

test('a moved or renamed file is paired before anything is planned', { skip }, async () => {
  // A renamed file is a new row to the scan, and its old row reads as gone -- the old row holding everyone's reading
  // history. The new row has never been fingerprinted (the scan just made it), so the preview does it. Reintroduce by
  // planning every gone row (drop pairMoved): both chapters below are in plan.mark.
  await seed();
  await runFingerprintBackfill();
  await rename(join(ROOT, SRC, 'Kept', 'Chapter 3.cbz'), join(ROOT, SRC, 'Kept', 'Chapter 3 - The End.cbz'));
  await mkdir(join(ROOT, SRC, 'Elsewhere'), { recursive: true });
  await rename(join(ROOT, SRC, 'Kept', 'Chapter 2.cbz'), join(ROOT, SRC, 'Elsewhere', 'Chapter 2.cbz'));
  await rm(join(ROOT, SRC, 'Gone', 'Chapter 2.cbz'));
  const three = await rowOf(ROOT, `${SRC}/Kept/Chapter 3.cbz`);
  const two = await rowOf(ROOT, `${SRC}/Kept/Chapter 2.cbz`);
  const gone = await rowOf(ROOT, `${SRC}/Gone/Chapter 2.cbz`);
  const plan = await previewRescan();
  const renamed = await rowOf(ROOT, `${SRC}/Kept/Chapter 3 - The End.cbz`);
  const moved = await rowOf(ROOT, `${SRC}/Elsewhere/Chapter 2.cbz`);
  assert.deepEqual(plan.moved.map((m: any) => [m.id, m.to.id]).sort(), [[three.id, renamed.id], [two.id, moved.id]].sort(),
    `the renamed and the moved file are paired with their new rows: ${JSON.stringify(plan.moved)}`);
  assert.deepEqual(plan.mark.map((m: any) => m.id), [gone.id], 'only the file that really went is planned');
});

test('a series with every chapter gone is listed, and one with a chapter left is not', { skip }, async () => {
  // Reintroduce by listing every series that lost a chapter: Kept is in plan.emptied.
  await seed();
  await rm(join(ROOT, SRC, 'Gone'), { recursive: true });
  await rm(join(ROOT, SRC, 'Kept', 'Chapter 1.cbz'));
  const plan = await previewRescan();
  assert.deepEqual(plan.emptied, [{ seriesId: await seriesOf(`${SRC}/Gone`), chapters: 2 }]);
  assert.equal(plan.mark.length, 3);
});

test('a hidden series, a merged one and one being renumbered are not looked at', { skip }, async () => {
  // A renumber in flight names files at temporary names; a hidden series is Delete files' business, and a merged one's
  // rows are its survivor's. Reintroduce by dropping LOOKED_AT's series terms: their gone chapters are planned.
  await seed();
  for (const f of ['Hidden', 'Merged', 'Renumbering']) await cbz(ROOT, `${SRC}/${f}/Chapter 1.cbz`);
  for (const f of ['Hidden', 'Merged', 'Renumbering']) await cbz(ROOT, `${SRC}/${f}/Chapter 2.cbz`);
  await persistScan();
  await q(`UPDATE lib_series SET deleted_at = now() WHERE folder = $1`, [`${SRC}/Hidden`]);
  await q(`UPDATE lib_series SET merged_into = $2 WHERE folder = $1`, [`${SRC}/Merged`, await seriesOf(`${SRC}/Kept`)]);
  await q(`UPDATE lib_series SET renumber_plan = '{"v":1,"phase":"temp"}'::jsonb WHERE folder = $1`, [`${SRC}/Renumbering`]);
  for (const f of ['Hidden', 'Merged', 'Renumbering']) await rm(join(ROOT, SRC, f, 'Chapter 2.cbz'));
  const plan = await previewRescan();
  assert.deepEqual(plan.mark, [], JSON.stringify(plan.mark));
  // Seven, and Merged's chapter 1: the scan files a merged folder's files under the survivor, Kept, where it is looked
  // at as Kept's. Hidden's and Renumbering's rows are not counted as looked at.
  assert.equal(plan.looked, 8, 'their rows are not counted as looked at');
});

test('the preview answers started, its progress and plan are on the status route, and a second press is refused', { skip }, async () => {
  // Detached like Verify: a scan and a stat per chapter over a share outlive the proxy. Reintroduce by awaiting the
  // preview in the run route: the answer carries no `started`.
  await seed();
  await rm(join(ROOT, SRC, 'Gone'), { recursive: true });
  await q(`UPDATE lib_series SET age_rating = 18 WHERE folder = $1`, [`${SRC}/Gone`]);
  const run = await app.inject({ method: 'POST', url: '/api/admin/tasks/rescan/run', headers: { authorization: adminTok } });
  assert.equal(run.statusCode, 200, run.body);
  assert.deepEqual(run.json(), { ok: true, started: true });
  for (let i = 0; i < 200 && rescanState.running; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(rescanState.running, null, 'the detached preview finished');

  const status = async (adult: boolean) =>
    (await app.inject({ method: 'GET', url: `/api/admin/tasks/rescan/status${adult ? '?adult=1' : ''}`, headers: { authorization: adminTok } })).json();
  const s = await status(true);
  assert.equal(s.running, null);
  assert.equal(s.plan?.gone, 2, JSON.stringify(s));
  assert.equal(s.plan.emptied, 1);
  assert.equal(s.plan.stale, false);
  assert.deepEqual(s.plan.emptiedList, [{ seriesId: await seriesOf(`${SRC}/Gone`), chapters: 2, title: 'Gone' }], 'the series with nothing left is named');
  // An admin who hides 18+ is told how many, never which: the list is a listing (routes/rescan.ts listable).
  const hidden = await status(false);
  assert.equal(hidden.plan.emptied, 1);
  assert.deepEqual(hidden.plan.emptiedList, [], 'an 18+ series was named to an admin who hides 18+');

  // A second press while a preview is out is refused, not raced. Held by hand, as Verify's test holds its flag.
  rescanState.running = 'preview';
  try {
    const busy = await app.inject({ method: 'POST', url: '/api/admin/tasks/rescan/run', headers: { authorization: adminTok } });
    assert.deepEqual(busy.json(), { ok: false, error: 'busy' });
    assert.equal(startRescan(), false);
  } finally { rescanState.running = null; }
});

test('rescan never runs at boot or on a schedule', { skip: false }, async () => {
  // A boot with the share not yet mounted is the empty mount point on every start (Verify's reason). The one caller
  // is the admin's Tasks panel. Reintroduce by calling startRescan from server.ts: the list below grows.
  const SRC_DIR = join(__dirname, '..', 'src');
  const callers: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.ts$/.test(e.name) && /\b(startRescan|previewRescan)\(/.test(await readFile(p, 'utf8'))) callers.push(p.slice(SRC_DIR.length + 1));
    }
  };
  await walk(SRC_DIR);
  assert.deepEqual(callers.sort(), ['lib/rescan.ts', 'routes/admin.ts'], 'the rescan is called from somewhere new');
});

// ---- Apply ----------------------------------------------------------------------------------------------------------

test('Apply marks your own folder\'s gone chapters and nothing else: no row erased, no file touched, the download folder left to Verify', { skip }, async () => {
  // The row IS everyone's reading history of the chapter, and the download folder's are Verify's to mark 'missing'
  // for the sweep. Reintroduce by erasing the planned rows instead of tombstoning them: the row count drops.
  await seed();
  await rm(join(ROOT, SRC, 'Kept', 'Chapter 3.cbz'));
  await rm(join(DL, SRC, 'Fetched', 'Chapter 2.cbz'));
  const before = (await allRows()).length;
  const plan = await preview();
  const r = await apply(plan);
  assert.equal(r.marked, 1, JSON.stringify(r));
  assert.equal(r.downloads, 1);
  assert.equal((await allRows()).length, before, 'a row was erased');
  assert.deepEqual(await prunedOf(ROOT, `${SRC}/Kept/Chapter 3.cbz`).then((p) => [!!p.at, p.reason]), [true, 'rescan_missing'],
    'the gone chapter records that Rescan found its filesystem entry absent');
  assert.equal((await prunedOf(DL, `${SRC}/Fetched/Chapter 2.cbz`)).at, null, 'the download folder\'s row was marked: that is Verify\'s');
  for (const n of [1, 2]) {
    assert.equal((await prunedOf(ROOT, `${SRC}/Kept/Chapter ${n}.cbz`)).at, null);
    assert.ok(await exists(join(ROOT, SRC, 'Kept', `Chapter ${n}.cbz`)), 'Apply touched a file');
  }
});

test('Apply asks every row again, with scans held: a file that came back, and a row that moved, are left alone', { skip }, async () => {
  // Minutes pass between the preview and the press. Reintroduce by marking the plan as it stands (drop the look in
  // applyPlan): Kept's chapter 3, back on disk, is marked. Reintroduce by running outside withScansHeld: the scan
  // asked for inside the Apply starts at once.
  await seed();
  await rm(join(ROOT, SRC, 'Kept', 'Chapter 3.cbz'));
  await rm(join(ROOT, SRC, 'Gone', 'Chapter 1.cbz'));
  const plan = await preview();
  assert.equal(plan.mark.length, 2, 'precondition');
  let pending: Promise<any> | null = null;
  const r = await apply(plan, {
    held: async () => {
      // The file comes back, and a rename (or a renumber's commit) moves the other row to a new file.
      await cbz(ROOT, `${SRC}/Kept/Chapter 3.cbz`);
      await q(`UPDATE lib_books SET file = $2 WHERE root = $3 AND file = $1`, [`${SRC}/Gone/Chapter 1.cbz`, `${SRC}/Gone/Chapter 01.cbz`, ROOT]);
      const n = scanCount();
      pending = persistScan();
      await new Promise((res) => setTimeout(res, 100));
      assert.equal(scanCount(), n, 'a scan started inside the Apply');
    },
  });
  await pending;
  assert.deepEqual([r.marked, r.back, r.changed], [0, 1, 1], JSON.stringify(r));
  assert.equal((await prunedOf(ROOT, `${SRC}/Kept/Chapter 3.cbz`)).at, null, 'a file back on disk was marked');
  assert.equal((await prunedOf(ROOT, `${SRC}/Gone/Chapter 01.cbz`)).at, null, 'a row that moved was marked');
});

test('a file paired since the preview is kept, not marked', { skip }, async () => {
  // The preview pairs what it can see; a moved file the scan and the backfill met after it is paired at Apply, before
  // the mark wipes the fingerprint. Reintroduce by dropping the twin check in applyPlan: chapter 3 is marked.
  await seed();
  await runFingerprintBackfill();
  const bytes = await readFile(join(ROOT, SRC, 'Kept', 'Chapter 3.cbz'));
  await rm(join(ROOT, SRC, 'Kept', 'Chapter 3.cbz'));
  const plan = await preview();
  assert.equal(plan.mark.length, 1, 'precondition: the preview had nothing to pair it with');
  await mkdir(join(ROOT, SRC, 'Moved'), { recursive: true });
  await writeFile(join(ROOT, SRC, 'Moved', 'Chapter 3.cbz'), bytes);
  await persistScan();
  await runFingerprintBackfill();
  const r = await apply(plan);
  assert.deepEqual([r.marked, r.moved], [0, 1], JSON.stringify(r));
  assert.equal((await prunedOf(ROOT, `${SRC}/Kept/Chapter 3.cbz`)).at, null, 'a moved file was marked as gone');
});

// ---- a chapter follows its file (v0.55.7) --------------------------------------------------------------------------

/** A reader with an account of their own, for the history a chapter carries. */
const aReader = async () => (await q<{ id: string }>(
  `INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ($1,$1,'user','x','password') RETURNING id`, [READER]))[0].id;
const titlesOf = async (series: string) => {
  const { owned } = (await import('../src/lib/ownedCatalog')) as any;
  const books = (await owned.seriesBooks({ userId: null, libraryIds: null, maxAgeRating: null }, series, 0, 50)).content;
  return books.map((b: any) => b.name).sort();
};

test('a chapter follows its renamed file: one row, its own id and everyone\'s history, on the new file', { skip }, async () => {
  // The v0.55.4 known issue "renamed files show twice": the old row stayed live with no file, the new row held the
  // file and none of the history. Reintroduce by skipping followFiles in applyPlan: Kept lists chapter 3 twice and the
  // reader's progress is on the row with no file.
  await seed();
  await runFingerprintBackfill();
  const kept = await seriesOf(`${SRC}/Kept`);
  const three = await rowOf(ROOT, `${SRC}/Kept/Chapter 3.cbz`);
  const two = await rowOf(ROOT, `${SRC}/Kept/Chapter 2.cbz`);
  const uid = await aReader();
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,1,true)`, [uid, three.id, kept]);
  await q(`INSERT INTO bookmarks (user_id, book_id, series_id, page) VALUES ($1,$2,$3,1)`, [uid, three.id, kept]);
  await rename(join(ROOT, SRC, 'Kept', 'Chapter 3.cbz'), join(ROOT, SRC, 'Kept', 'Chapter 3 - The End.cbz'));
  // And one moved out into a folder of its own, a series of its own: a pair across two series is left as it was.
  await mkdir(join(ROOT, SRC, 'Elsewhere'), { recursive: true });
  await rename(join(ROOT, SRC, 'Kept', 'Chapter 2.cbz'), join(ROOT, SRC, 'Elsewhere', 'Chapter 2.cbz'));

  const plan = await preview();
  assert.deepEqual([plan.moved.length, plan.follow, plan.mark.length], [2, 1, 0], JSON.stringify(plan));
  const fresh = await rowOf(ROOT, `${SRC}/Kept/Chapter 3 - The End.cbz`);
  assert.deepEqual(await titlesOf(kept), ['Chapter 1', 'Chapter 2', 'Chapter 3', 'Chapter 3 - The End'], 'precondition: the rename shows twice');

  const r = await apply(plan);
  assert.deepEqual(await titlesOf(kept), ['Chapter 1', 'Chapter 2', 'Chapter 3 - The End'], 'the renamed chapter still shows twice');
  const now = await rowOf(ROOT, `${SRC}/Kept/Chapter 3 - The End.cbz`);
  assert.equal(now.id, three.id, 'the chapter at the new file is not the row that holds its history');
  assert.equal((await q(`SELECT 1 FROM lib_books WHERE id = $1`, [fresh.id])).length, 0, 'the duplicate row was kept');
  assert.deepEqual((await q(`SELECT book_id, completed FROM read_progress WHERE user_id = $1`, [uid])).map((x) => [x.book_id, x.completed]),
    [[three.id, true]], 'the reader\'s progress did not follow the chapter');
  assert.deepEqual([r.followed, r.twins, r.marked, r.moved], [1, 0, 0, 2], JSON.stringify(r));
  const s = (await q(`SELECT books_count, cover_book_id FROM lib_series WHERE id = $1`, [kept]))[0];
  assert.equal(s.books_count, 3, 'the count still has the duplicate');
  // The pair across two series: both rows as they were.
  assert.equal((await rowOf(ROOT, `${SRC}/Kept/Chapter 2.cbz`)).id, two.id);
  assert.ok((await rowOf(ROOT, `${SRC}/Elsewhere/Chapter 2.cbz`)).id !== two.id);
  // The next scan finds the file on the row that took it: no new row, nothing marked.
  await persistScan();
  assert.equal((await rowOf(ROOT, `${SRC}/Kept/Chapter 3 - The End.cbz`)).id, three.id);
  assert.equal((await q(`SELECT count(*)::int AS n FROM lib_books WHERE series_id = $1`, [kept]))[0].n, 3);
});

test('a renamed file someone opened since the scan is kept beside its old chapter, both with their history', { skip }, async () => {
  // A row that holds anything of anyone's is never removed. Reintroduce by dropping the HOLDS test in followFiles: the
  // new row goes, and the reader's bookmark and reading event point at nothing.
  await seed();
  await runFingerprintBackfill();
  const kept = await seriesOf(`${SRC}/Kept`);
  const one = await rowOf(ROOT, `${SRC}/Kept/Chapter 1.cbz`);
  await rename(join(ROOT, SRC, 'Kept', 'Chapter 1.cbz'), join(ROOT, SRC, 'Kept', 'Chapter 01.cbz'));
  const plan = await preview();
  const fresh = await rowOf(ROOT, `${SRC}/Kept/Chapter 01.cbz`);
  // "Chapter 01" sorts before "Chapter 1": the new row is the series' cover now.
  assert.equal((await q(`SELECT cover_book_id FROM lib_series WHERE id = $1`, [kept]))[0].cover_book_id, fresh.id, 'precondition');
  const uid = await aReader();
  await q(`INSERT INTO bookmarks (user_id, book_id, series_id, page) VALUES ($1,$2,$3,1)`, [uid, fresh.id, kept]);
  await q(`INSERT INTO reading_events (user_id, series_id, book_id, page) VALUES ($1,$2,$3,1)`, [uid, kept, fresh.id]);

  const r = await apply(plan);
  assert.equal((await q(`SELECT 1 FROM lib_books WHERE id = $1`, [fresh.id])).length, 1, 'the new row with a reader\'s bookmark on it was removed');
  assert.equal((await q(`SELECT 1 FROM lib_books WHERE id = $1 AND file = $2`, [one.id, `${SRC}/Kept/Chapter 1.cbz`])).length, 1,
    'the old row was moved onto a file another row holds');
  assert.equal((await q(`SELECT count(*)::int AS n FROM bookmarks b JOIN lib_books x ON x.id = b.book_id WHERE b.user_id = $1`, [uid]))[0].n, 1);
  assert.deepEqual([r.followed, r.twins], [0, 1], JSON.stringify(r));
});

test('a renamed chapter that was the cover stays the cover, and Apply asks each pair again', { skip }, async () => {
  // The cover moves to the old row, the same chapter on the same file. Between the preview and the press, an old file
  // came back (two copies now: both kept) and a new file was renamed again (not the file the preview paired).
  // Reintroduce by following the pairs as the preview saw them (drop the looks in followFiles): chapter 2's old row is
  // pointed at a file that is not there.
  await seed();
  await runFingerprintBackfill();
  const kept = await seriesOf(`${SRC}/Kept`);
  const one = await rowOf(ROOT, `${SRC}/Kept/Chapter 1.cbz`);
  const two = await rowOf(ROOT, `${SRC}/Kept/Chapter 2.cbz`);
  const three = await rowOf(ROOT, `${SRC}/Kept/Chapter 3.cbz`);
  for (const n of [1, 2, 3]) await rename(join(ROOT, SRC, 'Kept', `Chapter ${n}.cbz`), join(ROOT, SRC, 'Kept', `Chapter 0${n}.cbz`));
  const plan = await preview();
  assert.equal(plan.follow, 3, JSON.stringify(plan));
  const r = await apply(plan, {
    held: async () => {
      await writeFile(join(ROOT, SRC, 'Kept', 'Chapter 3.cbz'), await readFile(join(ROOT, SRC, 'Kept', 'Chapter 03.cbz')));
      await rename(join(ROOT, SRC, 'Kept', 'Chapter 02.cbz'), join(ROOT, SRC, 'Kept', 'Chapter 002.cbz'));
    },
  });
  const fileOf = async (id: string) => (await q(`SELECT file FROM lib_books WHERE id = $1`, [id]))[0]?.file;
  assert.equal(await fileOf(two.id), `${SRC}/Kept/Chapter 2.cbz`, 'a pair whose new file moved on since the preview was followed');
  assert.equal(await fileOf(three.id), `${SRC}/Kept/Chapter 3.cbz`, 'a pair whose old file came back was followed');
  assert.equal(await fileOf(one.id), `${SRC}/Kept/Chapter 01.cbz`);
  assert.equal((await q(`SELECT cover_book_id FROM lib_series WHERE id = $1`, [kept]))[0].cover_book_id, one.id, 'the cover is not the chapter it was');
  assert.deepEqual([r.followed, r.back, r.changed], [1, 1, 1], JSON.stringify(r));
});

test('Apply is refused for a stale preview, an applied one, and beside another job', { skip }, async () => {
  // Reintroduce by dropping a line of clashing() (lib/rescan.ts): its job is let through below.
  await seed();
  await rm(join(ROOT, SRC, 'Kept', 'Chapter 3.cbz'));
  const plan = await preview();
  const who = { userId: adminId };
  assert.deepEqual(startApply({ plan: '00000000-0000-4000-8000-000000000000' }, who), { ok: false, error: 'stale' }, 'a plan a newer preview replaced');
  plan.at -= PLAN_TTL_MS + 1;
  assert.deepEqual(startApply({ plan: plan.id }, who), { ok: false, error: 'stale' }, 'a plan older than its time');
  plan.at += PLAN_TTL_MS + 1;
  const flags: Array<[any, string, string]> = [
    [runtime, 'updating', 'sweep_running'], [runtime, 'autofixing', 'autofix_running'], [runtime, 'repairing', 'repair_running'],
    [verifyState, 'running', 'verify_running'], [runtime, 'cleaning', 'cleanup_running'],
  ];
  for (const [o, k, error] of flags) {
    o[k] = true;
    try { assert.deepEqual(startApply({ plan: plan.id }, who), { ok: false, error }, `Apply ran beside ${k}`); } finally { o[k] = false; }
  }
  const scan = persistScan();
  assert.deepEqual(startApply({ plan: plan.id }, who), { ok: false, error: 'scan_running' }, 'Apply ran beside a scan');
  await scan;
  rescanState.running = 'preview';
  try { assert.deepEqual(startApply({ plan: plan.id }, who), { ok: false, error: 'busy' }); } finally { rescanState.running = null; }
  assert.equal((await prunedOf(ROOT, `${SRC}/Kept/Chapter 3.cbz`)).at, null, 'a refused Apply marked something');
  await apply(plan);
  assert.deepEqual(startApply({ plan: plan.id }, who), { ok: false, error: 'applied' }, 'a plan was applied twice');
  rescanState.plan = null;
  assert.deepEqual(startApply({ plan: plan.id }, who), { ok: false, error: 'no_plan' });
});

test('a library folder that no longer holds what the preview saw is left alone at Apply', { skip }, async () => {
  // The share went between the preview and the press: every planned file still reads gone, and so does every other.
  // Reintroduce by dropping the stillMounted look in applyPlan: chapter 3 is marked on a bare mount point.
  await seed();
  await rm(join(ROOT, SRC, 'Kept', 'Chapter 3.cbz'));
  const plan = await preview();
  await rm(join(ROOT, SRC), { recursive: true });
  await mkdir(join(ROOT, SRC, 'Kept'), { recursive: true });
  const r = await apply(plan);
  assert.deepEqual(r.unmounted, [{ root: ROOT }], JSON.stringify(r));
  assert.equal(r.marked, 0);
  assert.equal((await prunedOf(ROOT, `${SRC}/Kept/Chapter 3.cbz`)).at, null, 'a row under a bare mount point was marked');
});

test('a row already marked keeps its mark: Verify\'s missing is never relabelled', { skip }, async () => {
  // Reintroduce by dropping `b.pruned_at IS NULL` from LOOKED_AT: the missing row is planned; by dropping the pruned
  // test in applyPlan: the row marked meanwhile is counted as marked, not as changed.
  await seed();
  await rm(join(ROOT, SRC, 'Kept', 'Chapter 2.cbz'));
  await rm(join(ROOT, SRC, 'Kept', 'Chapter 3.cbz'));
  await q(`UPDATE lib_books SET pruned_at = now(), pruned_reason = 'missing' WHERE root = $1 AND file = $2`, [ROOT, `${SRC}/Kept/Chapter 2.cbz`]);
  const plan = await preview();
  const three = await rowOf(ROOT, `${SRC}/Kept/Chapter 3.cbz`);
  assert.deepEqual(plan.mark.map((m: any) => m.id), [three.id], 'a row already marked was planned');
  // Marked by something else between the preview and the press.
  await q(`UPDATE lib_books SET pruned_at = now(), pruned_reason = 'missing' WHERE id = $1`, [three.id]);
  const r = await apply(plan);
  assert.deepEqual([r.marked, r.changed], [0, 1], JSON.stringify(r));
  for (const n of [2, 3]) assert.equal((await prunedOf(ROOT, `${SRC}/Kept/Chapter ${n}.cbz`)).reason, 'missing', `chapter ${n}'s mark was relabelled`);
});

test('everyone\'s history stays, nothing a reader owns changes, and a file that comes back is picked up again', { skip }, async () => {
  // Reintroduce by clearing the marked rows' progress in applyPlan: the snapshot differs. Reintroduce by dropping
  // `pruned_at=NULL` from persistScan's upsert: the chapter put back stays marked.
  await seed();
  const kept = await seriesOf(`${SRC}/Kept`);
  const three = await rowOf(ROOT, `${SRC}/Kept/Chapter 3.cbz`);
  const uid = (await q<{ id: string }>(
    `INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ($1,$1,'user','x','password') RETURNING id`, [READER]))[0].id;
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,1,true)`, [uid, three.id, kept]);
  await q(`INSERT INTO bookmarks (user_id, book_id, series_id, page) VALUES ($1,$2,$3,1)`, [uid, three.id, kept]);
  await q(`INSERT INTO notes (user_id, series_id, book_id, body) VALUES ($1,$2,$3,'a note')`, [uid, kept, three.id]);
  await q(`INSERT INTO favorites (user_id, series_id) VALUES ($1,$2)`, [uid, kept]);
  await q(`INSERT INTO ratings (user_id, series_id, stars) VALUES ($1,$2,4)`, [uid, kept]);
  await q(`INSERT INTO listing_progress (user_id, series_id, number) VALUES ($1,$2,7)`, [uid, kept]);
  await q(`INSERT INTO tracker_progress (user_id, series_id, provider, chapters) VALUES ($1,$2,'anilist',3)`, [uid, kept]);
  const owned = async () => {
    const out: Record<string, unknown> = {};
    for (const t of ['read_progress', 'bookmarks', 'notes', 'favorites', 'ratings', 'listing_progress', 'tracker_progress']) {
      out[t] = await q(`SELECT * FROM ${t} WHERE user_id = $1 ORDER BY 1, 2`, [uid]);
    }
    return JSON.stringify(out);
  };
  const before = await owned();
  await rm(join(ROOT, SRC, 'Kept', 'Chapter 3.cbz'));
  const r = await apply(await preview());
  assert.equal(r.marked, 1);
  assert.equal(await owned(), before, 'a reader\'s progress, bookmark, note, favourite, rating, read mark or tracker floor changed');
  // The file comes back: the next scan picks it up on the same row, and the history is there.
  await cbz(ROOT, `${SRC}/Kept/Chapter 3.cbz`);
  await persistScan();
  const back = await rowOf(ROOT, `${SRC}/Kept/Chapter 3.cbz`);
  assert.deepEqual([back.id, back.pruned_at], [three.id, null], 'the chapter put back is not the live row it was');
  assert.equal((await q(`SELECT book_id FROM read_progress WHERE user_id = $1`, [uid]))[0].book_id, three.id);
});

test('a chapter Rescan everything marked says why on the book, so the series page can say "File no longer on disk"', { skip }, async () => {
  // The DTO had only `pruned`, and the web said "Deleted from the server" for every tombstone -- here about a file the
  // admin removed by hand. Reintroduce by dropping `prunedReason` from bookDto (or `b.pruned_reason` from booksSrc's
  // columns): the marked book reads undefined.
  await seed();
  await rm(join(ROOT, SRC, 'Kept', 'Chapter 3.cbz'));
  await apply(await preview());
  const { owned } = (await import('../src/lib/ownedCatalog')) as any;
  const ctx = { userId: null, libraryIds: null, maxAgeRating: null };
  const books = (await owned.seriesBooks(ctx, await seriesOf(`${SRC}/Kept`), 0, 50)).content;
  const by = (n: number) => books.find((b: any) => b.name === `Chapter ${n}`);
  assert.deepEqual([by(3)?.pruned, by(3)?.prunedReason, by(3)?.owned], [true, 'rescan_missing', false], JSON.stringify(by(3)));
  assert.deepEqual([by(1)?.pruned, by(1)?.prunedReason], [false, null], 'a chapter with its file has no reason');
});

test('a series with nothing left is listed, never hidden or forgotten, and the covers and counts are recomputed', { skip }, async () => {
  // Reintroduce by dropping refreshSeries from applyPlan: Kept's cover stays on the chapter just marked.
  await seed();
  await rm(join(ROOT, SRC, 'Gone'), { recursive: true });
  await rm(join(ROOT, SRC, 'Kept', 'Chapter 1.cbz'));
  const kept = await seriesOf(`${SRC}/Kept`);
  const gone = await seriesOf(`${SRC}/Gone`);
  assert.equal((await q(`SELECT cover_book_id FROM lib_series WHERE id = $1`, [kept]))[0].cover_book_id,
    (await rowOf(ROOT, `${SRC}/Kept/Chapter 1.cbz`)).id, 'precondition: the cover is chapter 1');
  const plan = await preview();
  assert.deepEqual(plan.emptied, [{ seriesId: gone, chapters: 2 }]);
  const r = await apply(plan);
  assert.equal(r.marked, 3);
  assert.equal(r.emptied, 1);
  const s = await q<{ id: string; deleted_at: string | null; books_count: number; cover_book_id: string }>(
    `SELECT id, deleted_at, books_count, cover_book_id FROM lib_series WHERE id = ANY($1) ORDER BY title`, [[kept, gone]]);
  assert.deepEqual(s.map((x) => [x.id, x.deleted_at, x.books_count]), [[gone, null, 2], [kept, null, 3]],
    'a series was hidden, or its count is not every row');
  assert.equal(s.find((x) => x.id === kept)!.cover_book_id, (await rowOf(ROOT, `${SRC}/Kept/Chapter 2.cbz`)).id, 'the cover is still a chapter with no file');
});

test('the Apply answers started, the panel and the Tasks row say what it did, the audit says who, and a restart keeps it', { skip }, async () => {
  // Reintroduce by awaiting the Apply in its route: the answer carries no `started`. Reintroduce by dropping the
  // UPDATE server_settings in startApply: the Tasks row is empty after the simulated restart.
  await seed();
  await rm(join(ROOT, SRC, 'Kept', 'Chapter 3.cbz'));
  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: adminTok }, ...(payload ? { payload } : {}) });
  await call('POST', '/api/admin/tasks/rescan/run');
  for (let i = 0; i < 200 && rescanState.running; i++) await new Promise((r) => setTimeout(r, 25));
  const id = (await call('GET', '/api/admin/tasks/rescan/status')).json().plan.id;

  assert.equal((await call('POST', '/api/admin/tasks/rescan/apply', { plan: 'not-a-plan' })).statusCode, 400);
  const started = await call('POST', '/api/admin/tasks/rescan/apply', { plan: id });
  assert.equal(started.statusCode, 200, started.body);
  assert.deepEqual(started.json(), { ok: true, started: true });
  for (let i = 0; i < 200 && rescanState.running; i++) await new Promise((r) => setTimeout(r, 25));
  const status = (await call('GET', '/api/admin/tasks/rescan/status')).json();
  assert.equal(status.last?.marked, 1, JSON.stringify(status));
  assert.ok(status.lastRun);
  assert.equal(status.plan.applied, true);
  assert.deepEqual((await call('POST', '/api/admin/tasks/rescan/apply', { plan: id })).json(), { ok: false, error: 'applied' });
  const row = async () => (await call('GET', '/api/admin/tasks')).json().content.find((t: any) => t.id === 'rescan');
  const t = await row();
  assert.deepEqual([t.name, t.running, t.lastResult?.marked], ['Rescan everything', false, 1], JSON.stringify(t));
  const audit = await q<{ user_id: string; detail: any }>(`SELECT user_id, detail FROM audit_log WHERE event = 'library.rescan' ORDER BY at DESC LIMIT 1`);
  assert.deepEqual([audit[0]?.user_id, audit[0]?.detail?.marked], [adminId, 1], 'the audit entry does not say who or what');
  // A restart is a fresh process: the in-memory state is what it was at boot.
  Object.assign(rescanState, { appliedAt: null, lastApplied: null, plan: null });
  const after1 = await row();
  assert.ok(after1.lastRun, 'the last Apply is gone after a restart');
  assert.equal(after1.lastResult?.marked, 1, 'the last result is gone after a restart');
});

// ---- the opt-in: chapter numbers by the newer file-name rules --------------------------------------------------------

/** Hand-named comics, each read differently by the two rules, and one read the same (the #150 cases). */
const COMICS = ['Vol 2 Ch 5.cbz', 'Batman (1987) #12.cbz', 'Batman 01-07 (1987).cbz', 'Chapter 9.cbz', 'Vol 3 Ch 8.cbz'];

/**
 * A folder of COMICS as a library scanned before v0.55.2 holds it: every row rule 1, numbered by the first number in
 * its name, with no range (nameRule.int.test.ts asBefore). Returns its series id and its rows by file name.
 */
async function handNamed(folder: string): Promise<{ id: string; rows: Map<string, string> }> {
  for (const f of COMICS) await cbz(ROOT, `${SRC}/${folder}/${f}`);
  await persistScan();
  await q(`UPDATE lib_books b SET name_rule = DEFAULT, number = v.n, number_end = NULL
             FROM unnest($1::text[], $2::real[]) AS v(f, n) WHERE b.root = $3 AND b.file = $4 || '/' || v.f`,
    [COMICS, COMICS.map((f) => numFromName(f)), ROOT, `${SRC}/${folder}`]);
  const id = await seriesOf(`${SRC}/${folder}`);
  const rows = new Map((await q<{ id: string; file: string }>(`SELECT id, file FROM lib_books WHERE series_id = $1`, [id]))
    .map((r) => [r.file.slice(`${SRC}/${folder}/`.length), r.id]));
  return { id, rows };
}
const numbersOf = async (series: string) => Object.fromEntries((await q<{ file: string; number: number; number_end: number | null; name_rule: number }>(
  `SELECT file, number, number_end, name_rule FROM lib_books WHERE series_id = $1`, [series]))
  .map((r) => [r.file.split('/').pop(), [Number(r.number), r.number_end == null ? null : Number(r.number_end), Number(r.name_rule)]]));

/** A reader who finished three of Comics' chapters, with a tracker connected and the series linked to it. */
async function reader(series: string, rows: Map<string, string>): Promise<string> {
  const uid = (await q<{ id: string }>(
    `INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ($1,$1,'user','x','password') RETURNING id`, [READER]))[0].id;
  for (const f of ['Vol 2 Ch 5.cbz', 'Batman (1987) #12.cbz', 'Batman 01-07 (1987).cbz']) {
    await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,1,true)`, [uid, rows.get(f), series]);
  }
  await q(`INSERT INTO user_trackers (user_id, provider, access_token) VALUES ($1,'anilist','x')`, [uid]);
  await q(`INSERT INTO series_trackers (series_id, provider, external_id) VALUES ($1,'anilist','rs-1')`, [series]);
  await q(`INSERT INTO tracker_progress (user_id, series_id, provider, chapters) VALUES ($1,$2,'anilist',7)`, [uid, series]);
  return uid;
}

test('the preview lists each series the new rules would renumber, with its readers, its hand numbers and its tracker moves', { skip }, async () => {
  // Reintroduce by counting a row with a number set by hand as changed (drop its `continue` in readAgain): Comics reads
  // four chapters and no hand number. Reintroduce by listing every rule-1 row: Plain is listed.
  const { id, rows } = await handNamed('Comics');
  for (const n of [1, 2]) await cbz(ROOT, `${SRC}/Plain/Chapter ${n}.cbz`);
  await persistScan();
  await q(`UPDATE lib_books SET name_rule = DEFAULT WHERE file LIKE $1`, [`${SRC}/Plain/%`]);
  await q(`INSERT INTO book_overrides (book_id, number) VALUES ($1, 8)`, [rows.get('Vol 3 Ch 8.cbz')]);
  await reader(id, rows);
  const plan = await previewRescan();
  assert.deepEqual(plan.numbers, [{
    seriesId: id, chapters: 3, readers: 1, overrides: 1, tracked: true, up: 2, down: 1,
    examples: [
      { file: `${SRC}/Comics/Batman (1987) #12.cbz`, from: '1987', to: '12' },
      { file: `${SRC}/Comics/Batman 01-07 (1987).cbz`, from: '1', to: '1–7' },
      { file: `${SRC}/Comics/Vol 2 Ch 5.cbz`, from: '2', to: '5' },
    ],
  }], JSON.stringify(plan.numbers));
});

test('a series numbered by posting order, and one being renumbered, are left out of the opt-in', { skip }, async () => {
  // Their numbers are their posts', or a renumber's, not their files'. Reintroduce by dropping the posting-order term
  // from RENUMBERABLE: Posts is listed.
  const posts = await handNamed('Posts');
  const moving = await handNamed('Moving');
  await q(`UPDATE lib_series SET numbering = 'posting_order' WHERE id = $1`, [posts.id]);
  await q(`UPDATE lib_series SET renumber_plan = '{"v":1,"phase":"temp"}'::jsonb WHERE id = $1`, [moving.id]);
  const plan = await previewRescan();
  assert.deepEqual(plan.numbers, [], JSON.stringify(plan.numbers));
});

test('Apply renumbers only the series ticked, keeps hand numbers and Verify\'s marks, and tells no tracker', { skip }, async () => {
  // Reintroduce by renumbering every series the preview listed: Other is renumbered. By pushing to the trackers after:
  // the reader's tracker records an error (or is called). By re-reading a row Verify marked 'missing': its rule moves.
  const comics = await handNamed('Comics');
  const other = await handNamed('Other');
  await q(`INSERT INTO book_overrides (book_id, number) VALUES ($1, 8)`, [comics.rows.get('Vol 3 Ch 8.cbz')]);
  await cbz(ROOT, `${SRC}/Comics/Vol 4 Ch 9.cbz`);
  await persistScan();
  // A chapter Verify marked 'missing', read by the old rule.
  await q(`UPDATE lib_books SET name_rule = DEFAULT, number = 4, pruned_at = now(), pruned_reason = 'missing' WHERE root = $1 AND file = $2`,
    [ROOT, `${SRC}/Comics/Vol 4 Ch 9.cbz`]);
  await rm(join(ROOT, SRC, 'Comics', 'Vol 4 Ch 9.cbz'));
  const uid = await reader(comics.id, comics.rows);
  const before = { comics: await numbersOf(comics.id), other: await numbersOf(other.id) };
  const floors = await q(`SELECT * FROM tracker_progress WHERE user_id = $1`, [uid]);
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: any) => { calls.push(String(u)); return new Response('{}', { status: 200 }); }) as typeof fetch;
  try {
    const call = (method: string, url: string, payload?: unknown) =>
      app.inject({ method, url: `${url}${url.includes('?') ? '&' : '?'}adult=1`, headers: { authorization: adminTok }, ...(payload ? { payload } : {}) });
    await call('POST', '/api/admin/tasks/rescan/run');
    for (let i = 0; i < 200 && rescanState.running; i++) await new Promise((r) => setTimeout(r, 25));
    const plan = (await call('GET', '/api/admin/tasks/rescan/status')).json().plan;
    assert.deepEqual(plan.numbers.map((n: any) => [n.title, n.chapters]), [['Comics', 3], ['Other', 4]], JSON.stringify(plan.numbers));
    assert.equal(plan.numbersTotal, 2);
    // A series the preview did not list is refused: its cost was never in front of the admin.
    assert.deepEqual((await call('POST', '/api/admin/tasks/rescan/apply', { plan: plan.id, renumber: ['s_not_listed'] })).json(), { ok: false, error: 'not_in_plan' });
    const started = (await call('POST', '/api/admin/tasks/rescan/apply', { plan: plan.id, renumber: [comics.id] })).json();
    assert.deepEqual(started, { ok: true, started: true });
    for (let i = 0; i < 200 && rescanState.running; i++) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 200)); // a push would be on its way by now
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(rescanState.lastApplied?.renumbered, { series: 1, chapters: 3 }, JSON.stringify(rescanState.lastApplied));
  const after = await numbersOf(comics.id);
  assert.deepEqual(after, {
    'Vol 2 Ch 5.cbz': [5, null, 2], 'Batman (1987) #12.cbz': [12, null, 2], 'Batman 01-07 (1987).cbz': [1, 7, 2],
    'Chapter 9.cbz': [9, null, 2],
    // A number set by hand keeps its row as it was, and so does the chapter Verify marked.
    'Vol 3 Ch 8.cbz': before.comics['Vol 3 Ch 8.cbz'], 'Vol 4 Ch 9.cbz': before.comics['Vol 4 Ch 9.cbz'],
  });
  assert.deepEqual(await numbersOf(other.id), before.other, 'a series nobody ticked was renumbered');
  assert.deepEqual(await q(`SELECT * FROM tracker_progress WHERE user_id = $1`, [uid]), floors, 'a tracker floor moved');
  assert.equal((await q(`SELECT last_error FROM user_trackers WHERE user_id = $1`, [uid]))[0].last_error, null, 'a tracker was pushed to');
  // Only a tracker's address counts: the Health summary an Apply asks for checks the solver and the release feed.
  assert.deepEqual(calls.filter((u) => /anilist|myanimelist|kitsu/i.test(u)), [], 'a tracker was called');
  const audit = await q<{ detail: any }>(`SELECT detail FROM audit_log WHERE event = 'library.rescan_numbers' ORDER BY at DESC LIMIT 1`);
  assert.deepEqual([audit[0]?.detail?.series, audit[0]?.detail?.chapters], [1, 3], 'the renumber is not in the Activity feed');
  // Rule 2 from here on: the next scan reads them the same way.
  await persistScan();
  assert.deepEqual(await numbersOf(comics.id), after, 'the next scan read the series by its old rule again');
});

test('an opt-in that fails part way changes no number', { skip }, async () => {
  // One transaction. Reintroduce by writing the numbers outside it (q in place of qq in renumberSeries): Comics is
  // renumbered although the Apply threw.
  const comics = await handNamed('Comics');
  const before = await numbersOf(comics.id);
  const plan = await preview();
  const r = startApply({ plan: plan.id, renumber: [comics.id] }, { userId: adminId }, { renumbered: async () => { throw new Error('the disk went away'); } });
  assert.ok(r.ok);
  await assert.rejects(r.run, /the disk went away/);
  assert.deepEqual(await numbersOf(comics.id), before, 'part of a failed renumber stayed');
  assert.equal(rescanState.lastApplied, null, 'a failed Apply left a result standing');
});

// ---- merge a series whose files all went into one other (v0.55.7) --------------------------------------------------

/**
 * Zagor as @Kedryn had it (#150): unpacked into two folders, each a series, fingerprinted, then every file moved into one
 * folder "Zagor". Returns the two old series and their rows by file name; the next preview's scan makes Zagor.
 * `fingerprinted: false`: as his rows most likely were -- never read before the move (the v0.55.7 integration's case).
 */
async function zagor(o: { fingerprinted?: boolean } = {}): Promise<{ s1: string; s2: string; rows: Map<string, string> }> {
  for (const n of [1, 2]) await cbz(ROOT, `${SRC}/Zagor 1-2/Zagor 00${n}.cbz`);
  for (const n of [3, 4]) await cbz(ROOT, `${SRC}/Zagor 3-4/Zagor 00${n}.cbz`);
  await persistScan();
  if (o.fingerprinted !== false) await runFingerprintBackfill();
  const rows = new Map((await q<{ id: string; file: string }>(`SELECT id, file FROM lib_books WHERE file LIKE $1`, [`${SRC}/Zagor %`]))
    .map((r) => [r.file.split('/').pop()!, r.id]));
  await mkdir(join(ROOT, SRC, 'Zagor'), { recursive: true });
  for (const [dir, ns] of [['Zagor 1-2', [1, 2]], ['Zagor 3-4', [3, 4]]] as const) {
    for (const n of ns) await rename(join(ROOT, SRC, dir, `Zagor 00${n}.cbz`), join(ROOT, SRC, 'Zagor', `Zagor 00${n}.cbz`));
    await rm(join(ROOT, SRC, dir), { recursive: true });
  }
  return { s1: await seriesOf(`${SRC}/Zagor 1-2`), s2: await seriesOf(`${SRC}/Zagor 3-4`), rows };
}

test('the Zagor case: two folders moved into one are offered as merges, and the ticked ones are merged with everyone\'s history', { skip }, async () => {
  // Reintroduce by merging every offer (ignore `merge` in applyPlan): Zagor 3-4, not ticked, is merged too. Reintroduce
  // by not handing the merged pairs to FOLLOW: Zagor lists every chapter twice. By dropping the link carry: Zagor has no
  // tracker link.
  await seed();
  const { s1, s2, rows } = await zagor();
  const uid = await aReader();
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,1,true)`, [uid, rows.get('Zagor 001.cbz'), s1]);
  await q(`INSERT INTO favorites (user_id, series_id) VALUES ($1,$2)`, [uid, s1]);
  await q(`INSERT INTO series_trackers (series_id, provider, external_id) VALUES ($1,'anilist','rs-zagor')`, [s1]);
  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: adminTok }, ...(payload ? { payload } : {}) });
  await call('POST', '/api/admin/tasks/rescan/run');
  for (let i = 0; i < 200 && rescanState.running; i++) await new Promise((r) => setTimeout(r, 25));
  const zagorId = await seriesOf(`${SRC}/Zagor`);
  const plan = (await call('GET', '/api/admin/tasks/rescan/status')).json().plan;
  assert.deepEqual(plan.merges, [
    { seriesId: s1, title: 'Zagor 1-2', into: { seriesId: zagorId, title: 'Zagor' }, chapters: 2 },
    { seriesId: s2, title: 'Zagor 3-4', into: { seriesId: zagorId, title: 'Zagor' }, chapters: 2 },
  ], JSON.stringify(plan));
  assert.equal(plan.mergesTotal, 2);
  assert.deepEqual(plan.emptiedList.map((e: any) => [e.title, e.into?.title]).sort(), [['Zagor 1-2', 'Zagor'], ['Zagor 3-4', 'Zagor']],
    'a series with nothing left does not say where its files went');
  assert.equal(plan.gone, 0, 'a moved chapter was planned as gone');
  // An admin who hides 18+ is told how many, never which: Zagor rated 18 is named neither as a merge nor as where the
  // files went (routes/rescan.ts listable, for both series). Reintroduce by filtering merges on the series alone: the
  // merges are offered.
  await q(`UPDATE lib_series SET age_rating = 18 WHERE id = $1`, [zagorId]);
  const hiding = (await call('GET', '/api/admin/tasks/rescan/status')).json().plan;
  assert.deepEqual([hiding.merges, hiding.mergesTotal], [[], 2], 'a merge into an 18+ series was offered to an admin who hides 18+');
  assert.ok(hiding.emptiedList.length === 2 && hiding.emptiedList.every((e: any) => !e.into), 'an 18+ series was named as where files went');
  await q(`UPDATE lib_series SET age_rating = NULL WHERE id = $1`, [zagorId]);

  const started = (await call('POST', '/api/admin/tasks/rescan/apply', { plan: plan.id, merge: [s1] })).json();
  assert.deepEqual(started, { ok: true, started: true });
  for (let i = 0; i < 200 && rescanState.running; i++) await new Promise((r) => setTimeout(r, 25));
  const r = rescanState.lastApplied;
  // Zagor 1-2 is in Zagor: its chapters are the rows that hold their history, on the files, once each.
  assert.equal((await q(`SELECT merged_into FROM lib_series WHERE id = $1`, [s1]))[0].merged_into, zagorId, 'the ticked series was not merged');
  assert.equal((await q(`SELECT merged_into FROM lib_series WHERE id = $1`, [s2]))[0].merged_into, null, 'a series nobody ticked was merged');
  assert.deepEqual(await titlesOf(zagorId), ['Zagor 001', 'Zagor 002', 'Zagor 003', 'Zagor 004'], 'Zagor lists a chapter twice');
  for (const f of ['Zagor 001.cbz', 'Zagor 002.cbz']) {
    assert.equal((await rowOf(ROOT, `${SRC}/Zagor/${f}`)).id, rows.get(f), `${f} is not the row that holds its history`);
  }
  assert.equal((await q(`SELECT series_id FROM read_progress WHERE user_id = $1`, [uid]))[0].series_id, zagorId, 'the reader\'s progress was left behind');
  assert.equal((await q(`SELECT count(*)::int AS n FROM favorites WHERE user_id = $1 AND series_id = $2`, [uid, zagorId]))[0].n, 1, 'the favourite was left behind');
  assert.deepEqual((await q(`SELECT external_id FROM series_trackers WHERE series_id = $1`, [zagorId])).map((x) => x.external_id), ['rs-zagor'],
    'the tracker link went with the merged series');
  const audit = await q<{ detail: any }>(`SELECT detail FROM audit_log WHERE event = 'series.merge' AND detail->>'from' = $1`, [s1]);
  assert.deepEqual([audit.length, audit[0]?.detail?.into, audit[0]?.detail?.via, audit[0]?.detail?.plan], [1, zagorId, 'rescan', plan.id], 'the merge is not in the Activity feed');
  assert.deepEqual([r.merged, r.notMerged, r.followed], [1, 0, 2], JSON.stringify(r));
  // The result lists only what has nothing left now: Zagor 1-2 is gone into Zagor.
  const after = (await call('GET', '/api/admin/tasks/rescan/status')).json().plan;
  assert.deepEqual(after.emptiedList.map((e: any) => e.title), ['Zagor 3-4']);
  // The next scan keeps it so: Zagor's files on the rows they are on, Zagor 1-2's folder gone.
  await persistScan();
  assert.deepEqual(await titlesOf(zagorId), ['Zagor 001', 'Zagor 002', 'Zagor 003', 'Zagor 004']);
});

test('a merge is offered only for a series whose every chapter went into one other series', { skip }, async () => {
  // Files split across two series, or one gone and one moved: the series is listed, and nothing is offered. Reintroduce
  // by offering every series with a moved chapter (drop `pairs.length === r.n && to.size === 1` in previewRescan): Split
  // and Half are offered.
  for (const n of [1, 2]) await cbz(ROOT, `${SRC}/Split/Chapter ${n}.cbz`);
  for (const n of [1, 2]) await cbz(ROOT, `${SRC}/Half/Part ${n}.cbz`);
  await persistScan();
  await runFingerprintBackfill();
  for (const d of ['A', 'B', 'C']) await mkdir(join(ROOT, SRC, d), { recursive: true });
  await rename(join(ROOT, SRC, 'Split', 'Chapter 1.cbz'), join(ROOT, SRC, 'A', 'Chapter 1.cbz'));
  await rename(join(ROOT, SRC, 'Split', 'Chapter 2.cbz'), join(ROOT, SRC, 'B', 'Chapter 2.cbz'));
  await rename(join(ROOT, SRC, 'Half', 'Part 1.cbz'), join(ROOT, SRC, 'C', 'Part 1.cbz'));
  await rm(join(ROOT, SRC, 'Half', 'Part 2.cbz'));
  for (const d of ['Split', 'Half']) await rm(join(ROOT, SRC, d), { recursive: true });
  await cbz(ROOT, `${SRC}/Kept/Chapter 1.cbz`); // a file still there, so the folder is not "unmounted"
  const plan = await previewRescan();
  assert.deepEqual(plan.merges, [], JSON.stringify(plan.merges));
  assert.deepEqual(plan.emptied.map((e: any) => [e.seriesId, e.into]).sort(),
    [[await seriesOf(`${SRC}/Half`), undefined], [await seriesOf(`${SRC}/Split`), undefined]].sort());
});

test('a merge whose series changed since the preview is left alone, and an unoffered one is refused', { skip }, async () => {
  // Apply asks again. Reintroduce by merging the offer as the preview saw it (drop stillMerges' refusal): the merge into
  // a series hidden since is made.
  await seed();
  const { s1, s2 } = await zagor();
  const plan = await preview();
  const zagorId = await seriesOf(`${SRC}/Zagor`);
  assert.equal(plan.merges.length, 2, 'precondition');
  assert.deepEqual(startApply({ plan: plan.id, merge: [await seriesOf(`${SRC}/Kept`)] }, { userId: adminId }), { ok: false, error: 'not_in_plan' },
    'a series the preview did not offer was let through');
  // Zagor 3-4's folder has a chapter again: its rows are not all gone any more.
  await cbz(ROOT, `${SRC}/Zagor 3-4/Zagor 009.cbz`);
  await persistScan();
  // And Zagor itself is hidden since the preview: nothing may be merged into it.
  await q(`UPDATE lib_series SET deleted_at = now() WHERE id = $1`, [zagorId]);
  const r = await (startApply({ plan: plan.id, merge: [s1, s2] }, { userId: adminId }) as any).run;
  assert.deepEqual((await q(`SELECT id, merged_into FROM lib_series WHERE id = ANY($1) ORDER BY title`, [[s1, s2]])).map((x) => x.merged_into),
    [null, null], 'a series was merged although it changed since the preview');
  assert.deepEqual([r.merged, r.notMerged], [0, 2], JSON.stringify(r));

  // Zagor visible again, offered again -- and merged away into another series since that preview: left alone too.
  await q(`UPDATE lib_series SET deleted_at = NULL WHERE id = $1`, [zagorId]);
  const again = await preview();
  assert.deepEqual(again.merges.map((m: any) => m.seriesId), [s1], JSON.stringify(again.merges));
  await q(`UPDATE lib_series SET merged_into = $2 WHERE id = $1`, [zagorId, await seriesOf(`${SRC}/Kept`)]);
  const r2 = await (startApply({ plan: again.id, merge: [s1] }, { userId: adminId }) as any).run;
  assert.equal((await q(`SELECT merged_into FROM lib_series WHERE id = $1`, [s1]))[0].merged_into, null, 'merged into a series merged away');
  assert.deepEqual([r2.merged, r2.notMerged], [0, 1], JSON.stringify(r2));
});

test('a merge whose target is being renumbered, or written into, waits; a twin with history of its own is kept', { skip }, async () => {
  // Reintroduce by dropping the renumbering test in stillMerges: Zagor 1-2 is merged into a series mid-renumber.
  const { busyFolders } = (await import('../src/lib/bulkNewest')) as any;
  await seed();
  const { s1, s2, rows } = await zagor();
  const plan = await preview();
  const zagorId = await seriesOf(`${SRC}/Zagor`);
  // A renumber of Zagor began since the preview.
  await q(`UPDATE lib_series SET renumber_plan = '{"v":1,"phase":"temp"}'::jsonb WHERE id = $1`, [zagorId]);
  const r1 = await (startApply({ plan: plan.id, merge: [s1] }, { userId: adminId }) as any).run;
  assert.equal((await q(`SELECT merged_into FROM lib_series WHERE id = $1`, [s1]))[0].merged_into, null, 'merged into a series mid-renumber');
  assert.deepEqual([r1.merged, r1.notMerged], [0, 1], JSON.stringify(r1));
  await q(`UPDATE lib_series SET renumber_plan = NULL WHERE id = $1`, [zagorId]);

  // A download into Zagor as the next Apply reaches it: left for the next Rescan, counted busy.
  const again = await preview();
  busyFolders.add(`${SRC}/Zagor`);
  try {
    const r2 = await (startApply({ plan: again.id, merge: [s1, s2] }, { userId: adminId }) as any).run;
    assert.deepEqual([r2.merged, r2.notMerged, r2.busy], [0, 0, 1], JSON.stringify(r2));
  } finally { busyFolders.delete(`${SRC}/Zagor`); }

  // Someone opened Zagor's copy of chapter 3 since the scan: Zagor 3-4 is merged, and that chapter is kept twice.
  const third = await preview();
  const copy = await rowOf(ROOT, `${SRC}/Zagor/Zagor 003.cbz`);
  const uid = await aReader();
  await q(`INSERT INTO bookmarks (user_id, book_id, series_id, page) VALUES ($1,$2,$3,1)`, [uid, copy.id, zagorId]);
  const r3 = await (startApply({ plan: third.id, merge: [s2] }, { userId: adminId }) as any).run;
  assert.equal((await q(`SELECT merged_into FROM lib_series WHERE id = $1`, [s2]))[0].merged_into, zagorId);
  assert.equal((await rowOf(ROOT, `${SRC}/Zagor/Zagor 004.cbz`)).id, rows.get('Zagor 004.cbz'));
  assert.equal((await rowOf(ROOT, `${SRC}/Zagor/Zagor 003.cbz`)).id, copy.id, 'the copy with a bookmark on it was removed');
  assert.deepEqual([r3.merged, r3.followed, r3.twins], [1, 1, 1], JSON.stringify(r3));
});

// ---- one writer per series ------------------------------------------------------------------------------------------

test('a series being downloaded into is left alone at Apply, and every other one it changes is held until it is done', { skip }, async () => {
  // v0.55.4 integration (lanes J × K): a Fetch -- several chapters at once since v0.55.4, a lane per image server -- or
  // the slow archive's chapter chose its numbers by the series as it is, and the opt-in is about to change them.
  // Reintroduce by dropping the test in holdSeries (lib/rescan.ts): Comics is renumbered and Kept's chapter marked under
  // the download. By dropping the mark: a Fetch on Gone is let in during the Apply. By letting go of every folder it
  // looked at: the archive's own mark on Kept is gone after the Apply.
  const { jobBusy } = (await import('../src/routes/sources')) as any;
  const { busyFolders } = (await import('../src/lib/bulkNewest')) as any;
  await seed();
  const comics = await handNamed('Comics');
  await rm(join(ROOT, SRC, 'Kept', 'Chapter 3.cbz'));
  await rm(join(ROOT, SRC, 'Gone', 'Chapter 1.cbz'));
  const plan = await preview();
  assert.equal(plan.mark.length, 2, 'precondition: a gone chapter in Kept and in Gone');
  assert.deepEqual(plan.numbers.map((n: any) => n.seriesId), [comics.id], 'precondition: Comics is in the opt-in');
  const before = await numbersOf(comics.id);
  const kept = `${SRC}/Kept`, gone = `${SRC}/Gone`, comicsFolder = `${SRC}/Comics`;
  // The slow archive is fetching a chapter of Kept, and of Comics, right now: lib/archive.ts begin() marks the folder.
  busyFolders.add(kept);
  busyFolders.add(comicsFolder);
  let during: boolean | null = null;
  try {
    const r = startApply({ plan: plan.id, renumber: [comics.id] }, { userId: adminId }, { held: async () => { during = jobBusy(gone); } });
    assert.ok(r.ok, JSON.stringify(r));
    const out = await r.run;
    assert.deepEqual([out.busy, out.marked, out.back, out.changed], [2, 1, 0, 0], JSON.stringify(out));
    assert.deepEqual(out.renumbered, { series: 0, chapters: 0 }, 'a series being downloaded into was renumbered');
    assert.equal((await prunedOf(ROOT, `${kept}/Chapter 3.cbz`)).at, null, 'a chapter of a series being downloaded into was marked');
    assert.equal((await prunedOf(ROOT, `${gone}/Chapter 1.cbz`)).reason, 'rescan_missing', 'a free series was not marked');
    assert.deepEqual(await numbersOf(comics.id), before, 'a series being downloaded into was renumbered');
    assert.equal(during, true, 'a Fetch could start in a series the Apply was changing');
    assert.equal(busyFolders.has(gone), false, 'the Apply kept its hold on Gone after it was done');
    assert.ok(busyFolders.has(kept) && busyFolders.has(comicsFolder), 'the Apply let go of the archive\'s own marks');
  } finally {
    busyFolders.delete(kept);
    busyFolders.delete(comicsFolder);
  }
  // The next Rescan has them, once the download is done.
  const again = await preview();
  const out2 = await (startApply({ plan: again.id, renumber: [comics.id] }, { userId: adminId }) as any).run;
  assert.deepEqual([out2.busy, out2.marked, out2.renumbered.series], [0, 1, 1], JSON.stringify(out2));
});

// ---- the v0.55.7 integration: a row never fingerprinted, and the tracker link a merge carries ------------------------

test('the Zagor case, never fingerprinted: the files are paired by name and time, offered as merges, and the chapters follow', { skip }, async () => {
  // The owner's decision for #150: @Kedryn's Zagor rows were most likely never fingerprinted before he moved the files,
  // so no fingerprint could pair them. `mv` keeps a file's name, time and size. Reintroduce by dropping the fallback
  // (nameTwins in pairMoved): every chapter is planned as gone and nothing is offered. By dropping it from stillMerges or
  // followFiles: nothing is merged, or Zagor lists every chapter twice.
  await seed();
  const { s1, s2, rows } = await zagor({ fingerprinted: false });
  const printed = await q<{ n: number }>(`SELECT count(*)::int AS n FROM lib_books WHERE id = ANY($1) AND fingerprint IS NOT NULL`, [[...rows.values()]]);
  assert.equal(printed[0].n, 0, 'precondition: the old rows were never fingerprinted');
  const plan = await preview();
  const zagorId = await seriesOf(`${SRC}/Zagor`);
  assert.deepEqual(plan.mark, [], 'a moved chapter never fingerprinted was planned as gone');
  assert.deepEqual(plan.moved.map((m: any) => [m.file.split('/').pop(), m.to.file, m.to.seriesId, m.by]).sort(),
    ['Zagor 001.cbz', 'Zagor 002.cbz', 'Zagor 003.cbz', 'Zagor 004.cbz'].map((f) => [f, `${SRC}/Zagor/${f}`, zagorId, 'name']));
  assert.deepEqual(plan.merges.map((m: any) => [m.seriesId, m.into, m.chapters]).sort(), [[s1, zagorId, 2], [s2, zagorId, 2]].sort());
  const r = await (startApply({ plan: plan.id, merge: [s1, s2] }, { userId: adminId }) as any).run;
  assert.deepEqual([r.merged, r.notMerged, r.followed, r.twins, r.marked], [2, 0, 4, 0, 0], JSON.stringify(r));
  assert.deepEqual(await titlesOf(zagorId), ['Zagor 001', 'Zagor 002', 'Zagor 003', 'Zagor 004'], 'Zagor lists a chapter twice');
  for (const [f, id] of rows) assert.equal((await rowOf(ROOT, `${SRC}/Zagor/${f}`)).id, id, `${f} is not the row that holds its history`);
});

test('a never-fingerprinted file is paired only when nothing else could be its file, and the fallback never marks a row', { skip }, async () => {
  // The negatives of the fallback (lib/rescan.ts nameTwins): a second live copy with the same name and time; a file whose
  // time changed; a file renamed in place; two gone rows that would both be one live file; a file of the same name and
  // time that a scan saw beside the gone one (two folders unpacked at the same instant: it did not arrive, it was there).
  // Each is no pair, and Apply marks them as it marks any gone file -- while the one clean move beside them is kept.
  // Reintroduce by pairing on the name alone (drop `b.mtime = x.mtime`): the touched file is paired. By dropping the
  // one-candidate rule: Ep 1 is paired with one of its two copies. By dropping the one-claimant rule: both Ep 5 rows pair
  // with one file. By dropping `b.created_at > x.seen` (or a scan stamping new rows with now(), lib/library.ts): Twin A's
  // deleted Ep 6 is paired with Twin B's.
  await seed();
  const T0 = 1_700_000_000; // seconds: every file's own time, set by hand so two files can share one
  const files: Array<[string, number]> = [
    ['Solo/Ep 1.cbz', T0 + 1], ['Solo/Ep 2.cbz', T0 + 2], ['Solo/Ep 3.cbz', T0 + 3], ['Solo/Ep 4.cbz', T0 + 4],
    ['Solo/Ep 5.cbz', T0 + 5], ['Duo/Ep 5.cbz', T0 + 5], ['Twin A/Ep 6.cbz', T0 + 6], ['Twin B/Ep 6.cbz', T0 + 6],
  ];
  for (const [f, t] of files) { await cbz(ROOT, `${SRC}/${f}`); await utimes(join(ROOT, SRC, f), t, t); }
  await persistScan();
  const id = async (f: string) => (await rowOf(ROOT, `${SRC}/${f}`)).id;
  const ids = Object.fromEntries(await Promise.all(files.map(async ([f]) => [f, await id(f)] as const)));
  for (const d of ['Elsewhere', 'Copy', 'Moved']) await mkdir(join(ROOT, SRC, d), { recursive: true });
  const at = (f: string) => join(ROOT, SRC, f);
  // Ep 1 moved, and a copy of it -- same name, same time -- in a third folder: two files it could be.
  await rename(at('Solo/Ep 1.cbz'), at('Elsewhere/Ep 1.cbz'));
  await writeFile(at('Copy/Ep 1.cbz'), await readFile(at('Elsewhere/Ep 1.cbz')));
  await utimes(at('Copy/Ep 1.cbz'), T0 + 1, T0 + 1);
  // Ep 2 moved, then touched.
  await rename(at('Solo/Ep 2.cbz'), at('Moved/Ep 2.cbz'));
  await utimes(at('Moved/Ep 2.cbz'), T0 + 200, T0 + 200);
  // Ep 3 renamed in place: another name.
  await rename(at('Solo/Ep 3.cbz'), at('Solo/Episode 3.cbz'));
  // Ep 4 moved, cleanly: the one pair.
  await rename(at('Solo/Ep 4.cbz'), at('Moved/Ep 4.cbz'));
  // Two Ep 5s with one time, and only one of them moved: one file both gone rows could be.
  await rename(at('Solo/Ep 5.cbz'), at('Moved/Ep 5.cbz'));
  await rm(at('Duo/Ep 5.cbz'));
  // Twin A's Ep 6 deleted; Twin B's, with its name and time, was scanned beside it all along.
  await rm(at('Twin A/Ep 6.cbz'));
  const plan = await preview();
  assert.deepEqual(plan.moved.map((m: any) => [m.id, m.to.file, m.by]), [[ids['Solo/Ep 4.cbz'], `${SRC}/Moved/Ep 4.cbz`, 'name']],
    JSON.stringify(plan.moved));
  const planned = new Set(plan.mark.map((m: any) => m.id));
  for (const f of ['Solo/Ep 1.cbz', 'Solo/Ep 2.cbz', 'Solo/Ep 3.cbz', 'Solo/Ep 5.cbz', 'Duo/Ep 5.cbz', 'Twin A/Ep 6.cbz']) {
    assert.ok(planned.has(ids[f]), `${f} was paired although something else could be its file`);
  }
  const r = await apply(plan);
  assert.equal(r.marked, 6, JSON.stringify(r));
  assert.equal((await prunedOf(ROOT, `${SRC}/Solo/Ep 4.cbz`)).at, null, 'the clean move was marked');
});

test('a never-fingerprinted file that turns up in another folder after the preview is kept at Apply, not marked', { skip }, async () => {
  // Apply asks the fallback again before it marks, as it asks the fingerprints (markGone). Reintroduce by dropping the
  // name pairing there: the late file's row is marked "deleted" while its file is on disk under another folder.
  await seed();
  await cbz(ROOT, `${SRC}/Late/Ch 1.cbz`);
  await persistScan();
  const row = await rowOf(ROOT, `${SRC}/Late/Ch 1.cbz`);
  const aside = join(TMP, 'aside.cbz');
  await rename(join(ROOT, SRC, 'Late', 'Ch 1.cbz'), aside);
  const plan = await preview();
  assert.ok(plan.mark.some((m: any) => m.id === row.id), 'precondition: the file is planned as gone');
  await mkdir(join(ROOT, SRC, 'Later'), { recursive: true });
  await rename(aside, join(ROOT, SRC, 'Later', 'Ch 1.cbz'));
  await persistScan();
  const r = await apply(plan);
  assert.equal((await prunedOf(ROOT, `${SRC}/Late/Ch 1.cbz`)).at, null, 'a row whose file is on disk under another folder was marked');
  assert.ok(r.moved >= 1, JSON.stringify(r));
});

test('a merge carries the tracker link as the online-match check would judge it, and the recheck may verify it', { skip }, async () => {
  // The v0.55.7 integration (lanes A x B). A person's link goes as it is; an automatic one keeps its checked_at only where
  // every name the absorbed series goes by is one the other will go by -- else it goes unchecked, for the recheck
  // (lib/matchCheck.ts) to hold to the names the series has now; and nothing is carried over a link the other series
  // has. Reintroduce by carrying checked_at as it is: Zagor 3-4's AniList link lands checked, and the recheck never looks
  // at it. By replacing on conflict: Zagor's own checked link is replaced by an unchecked one.
  const { checkMatches } = (await import('../src/lib/matchCheck')) as any;
  await seed();
  const { s1, s2 } = await zagor();
  const plan = await preview();
  const zagorId = await seriesOf(`${SRC}/Zagor`);
  const uid = await aReader();
  // Zagor goes by Zagor 1-2's name too (an other name); not by Zagor 3-4's.
  await q(`INSERT INTO series_alt_titles (series_id, norm, title, origin) VALUES ($1, 'zagor12', 'Zagor 1-2', 'admin')`, [zagorId]);
  const link = (series: string, provider: string, ext: string, o: { checked?: boolean; by?: string } = {}) =>
    q(`INSERT INTO series_trackers (series_id, provider, external_id, title, linked_by, checked_at) VALUES ($1,$2,$3,'x',$4,$5)`,
      [series, provider, ext, o.by ?? null, o.checked ? new Date('2026-10-01T00:00:00Z') : null]);
  await link(zagorId, 'p-over', 'rs-t-over', { checked: true });
  await link(s1, 'p-carry', 'rs-s1-carry', { checked: true });
  await link(s1, 'p-over', 'rs-s1-over');
  await link(s2, 'anilist', '977002', { checked: true });
  await link(s2, 'p-person', 'rs-s2-person', { checked: true, by: uid });
  const r = await (startApply({ plan: plan.id, merge: [s1, s2] }, { userId: adminId }) as any).run;
  assert.equal(r.merged, 2, JSON.stringify(r));
  const got = Object.fromEntries((await q<{ provider: string; external_id: string; linked_by: string | null; checked_at: Date | null }>(
    `SELECT provider, external_id, linked_by, checked_at FROM series_trackers WHERE series_id = $1`, [zagorId]))
    .map((t) => [t.provider, [t.external_id, t.linked_by, t.checked_at ? t.checked_at.toISOString() : null]]));
  const checked = '2026-10-01T00:00:00.000Z';
  assert.deepEqual(got, {
    'p-over': ['rs-t-over', null, checked],
    'p-carry': ['rs-s1-carry', null, checked],
    anilist: ['977002', null, null],
    'p-person': ['rs-s2-person', uid, checked],
  });
  // The recheck takes the carried AniList link up, and holds it to the names Zagor goes by: an entry named "Zagor 3-4" is
  // another work's to Zagor (its title went nowhere with the merge), so the link goes.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input?.url ?? input));
    if (url.host !== 'graphql.anilist.co') throw new Error(`unexpected request in a test: ${url}`);
    const ids: number[] = JSON.parse(String(init?.body ?? '{}'))?.variables?.ids ?? [];
    return Response.json({ data: { Page: { media: ids.filter((i) => i === 977002).map((i) => ({
      id: i, type: 'MANGA', title: { romaji: 'Zagor 3-4', english: null, native: null }, synonyms: [], relations: { edges: [] } })) } } });
  }) as typeof fetch;
  try {
    const m = await checkMatches({ info() {}, warn() {} });
    assert.deepEqual(m.links, { checked: 1, removed: 1 }, JSON.stringify(m));
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual((await q(`SELECT provider FROM series_trackers WHERE series_id = $1 ORDER BY provider`, [zagorId])).map((t) => t.provider),
    ['p-carry', 'p-over', 'p-person']);
  await q(`DELETE FROM series_trackers WHERE series_id = ANY($1)`, [[zagorId, s1, s2]]);
  await q(`DELETE FROM audit_log WHERE event = 'library.match_check'`).catch(() => {});
});

test('a link carried while the online-match check runs goes unchecked', { skip }, async () => {
  // The check may be judging that very link against the old names (lib/matchCheck.ts): carried as checked, its verdict
  // would land on nothing and the link would stand unjudged. Reintroduce by dropping `!matchCheckState.running`: the
  // link keeps its checked_at.
  const { matchCheckState } = (await import('../src/lib/matchCheck')) as any;
  await seed();
  const { s1 } = await zagor();
  const plan = await preview();
  const zagorId = await seriesOf(`${SRC}/Zagor`);
  await q(`INSERT INTO series_alt_titles (series_id, norm, title, origin) VALUES ($1, 'zagor12', 'Zagor 1-2', 'admin')`, [zagorId]);
  await q(`INSERT INTO series_trackers (series_id, provider, external_id, title, checked_at) VALUES ($1, 'p-race', 'rs-race', 'x', now())`, [s1]);
  matchCheckState.running = true;
  try {
    const r = await (startApply({ plan: plan.id, merge: [s1] }, { userId: adminId }) as any).run;
    assert.equal(r.merged, 1, JSON.stringify(r));
  } finally { matchCheckState.running = false; }
  const t = await q<{ checked_at: Date | null }>(`SELECT checked_at FROM series_trackers WHERE series_id = $1 AND provider = 'p-race'`, [zagorId]);
  assert.deepEqual(t.map((x) => x.checked_at), [null], 'a link carried during a match check kept its checked_at');
  await q(`DELETE FROM series_trackers WHERE series_id = ANY($1)`, [[zagorId, s1]]);
});

test('a list that held a series merged by Rescan everything holds the series it went into, once', { skip }, async () => {
  // The v0.55.7 integration (lanes B x C): lists go with a merge (lib/libraryAdmin.ts mergeSeries), so a list shows the
  // survivor -- once, where it held both -- and its unread badge and sort read the survivor's rows. Pinned for the
  // rescan's merge: reintroduce by dropping the collection_items move from mergeSeries and the list keeps a series
  // merged away, which the list's page no longer shows at all.
  await seed();
  const { s1, s2 } = await zagor();
  const plan = await preview();
  const zagorId = await seriesOf(`${SRC}/Zagor`);
  const uid = await aReader();
  const [both, one] = (await q<{ id: string }>(
    `INSERT INTO collections (user_id, name) VALUES ($1, 'Both'), ($1, 'One') RETURNING id`, [uid])).map((c) => c.id);
  await q(`INSERT INTO collection_items (collection_id, series_id, position) VALUES ($1,$2,0), ($1,$3,1), ($1,$4,2), ($5,$2,0)`,
    [both, s1, zagorId, s2, one]);
  const r = await (startApply({ plan: plan.id, merge: [s1, s2] }, { userId: adminId }) as any).run;
  assert.equal(r.merged, 2, JSON.stringify(r));
  const items = async (c: string) => (await q<{ series_id: string }>(
    `SELECT series_id FROM collection_items WHERE collection_id = $1 ORDER BY position, series_id`, [c])).map((x) => x.series_id);
  assert.deepEqual(await items(both), [zagorId], 'the list that held all three holds Zagor, once');
  assert.deepEqual(await items(one), [zagorId], 'the list that held Zagor 1-2 holds Zagor');
  await q(`DELETE FROM collections WHERE id = ANY($1)`, [[both, one]]);
});
