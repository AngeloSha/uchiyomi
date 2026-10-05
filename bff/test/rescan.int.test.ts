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
let rescanState: any;
let runFingerprintBackfill: () => Promise<any>;
let app: any, adminTok: string;

const ADMIN = 'rs-admin';
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
  await chmod(join(ROOT, SRC, 'Locked'), 0o755).catch(() => {});
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
  await mkdir(ROOT, { recursive: true });
  await mkdir(DL, { recursive: true });
  Object.assign(rescanState, { running: null, phase: null, done: 0, of: null, startedAt: null, plan: null, error: null });
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ persistScan, scanCount } = (await import('../src/lib/library')) as any);
  ({ previewRescan, startRescan, rescanState } = (await import('../src/lib/rescan')) as any);
  ({ runFingerprintBackfill } = (await import('../src/lib/fingerprintJob')) as any);
  await migrate();
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
  const adminId = (await q<{ id: string }>(
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
