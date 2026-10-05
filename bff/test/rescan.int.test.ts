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
import { mkdir, rm, writeFile, rename, chmod, readdir, readFile } from 'fs/promises';
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
  await q(`DELETE FROM audit_log WHERE event LIKE 'library.rescan%' OR (event = 'task.run' AND detail->>'task' = 'rescan')`).catch(() => {});
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
  assert.deepEqual(await prunedOf(ROOT, `${SRC}/Kept/Chapter 3.cbz`).then((p) => [!!p.at, p.reason]), [true, 'deleted'],
    'the gone chapter is not marked held, as Delete files marks a file it removed');
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
  assert.deepEqual([by(3)?.pruned, by(3)?.prunedReason, by(3)?.owned], [true, 'deleted', false], JSON.stringify(by(3)));
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
