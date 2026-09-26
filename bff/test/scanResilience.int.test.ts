// #109: chapters on disk that never reach the library.
//
// Two Unraid installs reported the same shape: a Fetch shows "Fetching 1 chapters" for a second and adds
// nothing, a series added from Discover downloads but never appears, nothing in the log, and a manual Library
// Scan changes nothing -- while the same files moved into the library folder are picked up at once. The
// downloads root is walked SECOND, so one folder the scan could not index anywhere before it ended the whole
// pass, on every run, and every caller swallowed the throw. So:
//
//   - one folder that cannot be indexed is skipped, and every other folder still is;
//   - the skip is reported: the scan's report, and the Health page's Library scan check;
//   - a NUL in a ComicInfo field (Postgres refuses it; a source's description can carry one into the file)
//     costs nothing: stripped, and the series is indexed;
//   - a folder with a deleted twin in another library goes to the live row;
//   - a Fetch whose chapter is already on disk but cannot be indexed says so on its card.
//
// v0.48.2, because v0.48.0 did not fix it for one of the two reporters (the walk dropped folders before the
// database saw them; scanWalk.test.ts has the walk itself):
//   - requests that arrive during a scan share one follow-up scan, and scans never overlap;
//   - a Fetch, and an add, whose DOWNLOAD the scan never indexes end as an error that says so, not "done";
//   - Admin → Health → Downloads missing from the library lists every such chapter, with the reason;
//   - a downloads folder the scan cannot read is on the Health page, not skipped in silence.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
// Read at module load by lib/library.ts, so set before the first import of it.
const LIB_ROOT = join(tmpdir(), `uchiyomi-sr-lib-${process.pid}`);
const DL = join(tmpdir(), `uchiyomi-sr-dl-${process.pid}`);
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LIBRARY_ROOT = LIB_ROOT;
  process.env.DL_ROOT = DL;
  process.env.MIN_FREE_GB = '0';
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

/** The folder a Postgres trigger refuses: the stand-in for whatever a real library holds that cannot be indexed. */
const BOOM = 'Zsr/Boom';
const SRC = 'sr-src';
/** A source whose chapters really download (the page fetch is stubbed): what landed is the subject. */
const SRC_DL = 'sr-src-dl';
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const realFetch = globalThis.fetch;

function cbz(abs: string, series: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile('001.jpg', Buffer.from('page-bytes'));
  zip.addFile('ComicInfo.xml', Buffer.from(`<?xml version="1.0"?><ComicInfo><Series>${series}</Series><Summary>A summary.</Summary></ComicInfo>`));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, zip.toBuffer());
}

let q: any, persistScan: any, lastScanReport: any, runHealthChecks: any;
const books = async (folder: string) =>
  (await q(`SELECT b.number::float8 AS n, s.id, s.title, s.deleted_at FROM lib_books b JOIN lib_series s ON s.id = b.series_id
             WHERE s.folder = $1 AND b.pruned_at IS NULL ORDER BY b.number`, [folder])) as Array<{ n: number; id: string; title: string; deleted_at: Date | null }>;

before(async () => {
  if (!DSN) return;
  rmSync(LIB_ROOT, { recursive: true, force: true });
  rmSync(DL, { recursive: true, force: true });
  mkdirSync(LIB_ROOT, { recursive: true });
  mkdirSync(DL, { recursive: true });
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ persistScan, lastScanReport } = (await import('../src/lib/library')) as any);
  ({ runHealthChecks } = (await import('../src/lib/health')) as any);
  await migrate();
  await q(`DELETE FROM lib_series WHERE folder LIKE 'Zsr/%' OR folder LIKE 'Zzz SR DL/%'`);
  await q(`CREATE OR REPLACE FUNCTION sr_boom() RETURNS trigger AS $$
             BEGIN IF NEW.folder IN ('${BOOM}', 'Zsr/Stuck') OR NEW.folder LIKE '%Refused%' THEN RAISE EXCEPTION 'refused for the test: %', NEW.folder; END IF; RETURN NEW; END
           $$ LANGUAGE plpgsql`);
  await q('DROP TRIGGER IF EXISTS sr_boom ON lib_series');
  await q('CREATE TRIGGER sr_boom BEFORE INSERT OR UPDATE ON lib_series FOR EACH ROW EXECUTE FUNCTION sr_boom()');
});

after(async () => {
  if (!DSN) return;
  await q('DROP TRIGGER IF EXISTS sr_boom ON lib_series').catch(() => {});
  await q('DROP FUNCTION IF EXISTS sr_boom()').catch(() => {});
  await q(`DELETE FROM lib_series WHERE folder LIKE 'Zsr/%' OR folder LIKE 'Zzz SR DL/%'`).catch(() => {});
  await q(`DELETE FROM libraries WHERE id = 'lib_sr_twin'`).catch(() => {});
  await q(`DELETE FROM users WHERE username = 'sr-admin'`).catch(() => {});
  globalThis.fetch = realFetch;
  rmSync(LIB_ROOT, { recursive: true, force: true });
  rmSync(DL, { recursive: true, force: true });
});

test('one folder that cannot be indexed does not stop the scan', { skip }, async () => {
  // In the LIBRARY root, which is walked first: everything under the downloads root comes after it.
  cbz(join(LIB_ROOT, BOOM, 'Chapter 1.cbz'), 'Boom');
  cbz(join(DL, 'Zsr/Downloaded', 'Chapter 1.cbz'), 'Downloaded');
  cbz(join(DL, 'Zsr/Downloaded', 'Chapter 2.cbz'), 'Downloaded');

  // Reintroduce by removing the per-folder catch in persistScan: this throws "refused for the test", and --
  // as every caller used to swallow it -- nothing under the downloads root is ever indexed.
  const r = await persistScan();
  assert.deepEqual((await books('Zsr/Downloaded')).map((b) => b.n), [1, 2], 'a download after the bad folder was not indexed');
  assert.equal(r.skipped, 1);
  assert.equal((await books(BOOM)).length, 0);

  const report = lastScanReport();
  assert.equal(report.skippedTotal, 1);
  assert.equal(report.skipped[0].folder, BOOM);
  assert.equal(report.skipped[0].root, 'library');
  assert.match(report.skipped[0].error, /refused for the test/);
});

test("the Health page's Library scan check names the folder and the scanner's reason", { skip }, async () => {
  const report = await runHealthChecks();
  const c = report.checks.find((x: any) => x.id === 'library-scan');
  assert.ok(c, 'no library-scan check on the Health page');
  assert.equal(c.status, 'problem');
  assert.match(c.summary, /could not index 1 folder/);
  assert.ok(c.items.some((i: any) => i.title === `Library / ${BOOM}` && /refused for the test/.test(i.detail)), JSON.stringify(c.items));
});

test('a NUL in a ComicInfo field is stripped, and the series is indexed', { skip }, async () => {
  // A source's description can carry a `\u0000` (JSON allows the escape) and the downloader copied it into the
  // file; Postgres refuses it in any text value. Reintroduce by dropping XML_FORBIDDEN from field() in
  // lib/library.ts: this folder is skipped ("invalid byte sequence ... 0x00") and has no books.
  cbz(join(DL, 'Zsr/Nul', 'Chapter 1.cbz'), 'Nul\u0000Title');
  await persistScan();
  const b = await books('Zsr/Nul');
  assert.equal(b.length, 1, `the NUL cost the series: ${JSON.stringify(lastScanReport().skipped)}`);
  assert.equal(b[0].title, 'NulTitle');
});

test('a folder with a deleted twin in another library goes to the live row', { skip }, async () => {
  // A folder is unique per LIBRARY, so a deleted row can sit beside the live one. Deleted FIRST, so an
  // unordered lookup meets it first. Reintroduce by dropping the ORDER BY on the `known` lookup: the scan
  // takes the deleted twin, `continue`s, and the live series never gets its chapters.
  await q(`INSERT INTO libraries (id, name, path) VALUES ('lib_sr_twin','Twin','Elsewhere') ON CONFLICT (id) DO NOTHING`);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, deleted_at)
           VALUES ('s_sr_twin_dead','Zsr','Twin','Zsr/Twin',0,'lib_sr_twin', now())`);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id)
           VALUES ('s_sr_twin_live','Zsr','Twin','Zsr/Twin',0,'lib')`);
  cbz(join(DL, 'Zsr/Twin', 'Chapter 1.cbz'), 'Twin');
  await persistScan();
  const b = await books('Zsr/Twin');
  assert.deepEqual(b.map((x) => [x.id, x.n]), [['s_sr_twin_live', 1]], JSON.stringify(b));
});

test('a Fetch whose chapter is on disk but cannot be indexed says so on its card', { skip }, async () => {
  const { registerAdapter } = await import('../src/lib/sources');
  const { startDownloadJob } = await import('../src/routes/sources');
  registerAdapter({
    id: SRC, name: 'Zzz SR',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: SRC, title: sid }; },
    async listChapters() { return []; },
    async getPageUrls() { throw new Error('the file is on disk; nothing should be fetched'); },
    async latest() { return []; },
  } as any);
  // The trigger lets the row in once (as the add would have written it), then refuses the scan's update.
  await q('ALTER TABLE lib_series DISABLE TRIGGER sr_boom');
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id)
           VALUES ('s_sr_stuck','Zsr','Stuck','Zsr/Stuck',0,'lib',$1,'stuck-1')`, [SRC]);
  await q('ALTER TABLE lib_series ENABLE TRIGGER sr_boom');
  cbz(join(DL, 'Zsr/Stuck', 'Chapter 1.cbz'), 'Stuck');

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/sources')).default);
  await app.ready();
  await q(`DELETE FROM users WHERE username = 'sr-admin'`);
  const admin = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                          VALUES ('sr-admin','sr-admin','x','admin','password') RETURNING id`))[0].id;
  const card = async () =>
    ((await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` } }))
      .json().content as any[]).find((j) => j.folder === 'Zsr/Stuck');

  startDownloadJob({
    folder: 'Zsr/Stuck', title: 'Stuck', seriesId: 's_sr_stuck',
    chapters: [{ number: 1, title: 'Chapter 1', sourceId: `${SRC}-c1`, source: SRC } as any],
    meta: { series: 'Stuck' }, by: admin,
  });
  const t0 = Date.now();
  let c: any;
  while (Date.now() - t0 < 15_000) {
    c = await card();
    if (c && c.status !== 'downloading') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await app.close();
  // Reintroduce by dropping the `unindexed` check in startDownloadJob: the card ends `done` with no reason --
  // "Fetching 1 chapters" for a second, then nothing, which is exactly what #109 reported.
  assert.equal(c?.status, 'error', JSON.stringify(c));
  assert.match(c?.reason ?? '', /Chapter 1 is on disk, but the library scan could not add it \(the library refused it: refused for the test/);
  await q(`DELETE FROM users WHERE username = 'sr-admin'`).catch(() => {});
});

// ---- v0.48.2 --------------------------------------------------------------------------------------------

/** A signed-in admin and the jobs route, for reading job cards as the web app does. */
async function jobsApp() {
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/sources')).default);
  await app.ready();
  await q(`DELETE FROM users WHERE username = 'sr-admin'`);
  const admin: string = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                          VALUES ('sr-admin','sr-admin','x','admin','password') RETURNING id`))[0].id;
  const token = app.jwt.sign({ sub: admin, role: 'admin' });
  const card = async (folder: string) =>
    ((await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: { authorization: `Bearer ${token}` } }))
      .json().content as any[]).find((j) => j.folder === folder);
  const settled = async (folder: string) => {
    const t0 = Date.now();
    let c: any;
    while (Date.now() - t0 < 20_000) {
      c = await card(folder);
      if (c && c.status !== 'downloading') return c;
      await new Promise((r) => setTimeout(r, 50));
    }
    return c;
  };
  return { app, admin, settled };
}

function registerDownloader() {
  return import('../src/lib/sources').then(({ registerAdapter }) => registerAdapter({
    id: SRC_DL, name: 'Zzz SR DL',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: SRC_DL, title: sid }; },
    async listChapters() { return [1, 2].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `${SRC_DL}-c${n}`, pages: 1 })); },
    async getPageUrls(chId: string) { return [`https://example.invalid/${chId}/p1.png`]; },
    async latest() { return []; },
  } as any));
}

test('requests during a scan share one follow-up, and a chapter that landed meanwhile is in it', { skip }, async () => {
  // Reintroduce by starting a scan on every call: the calls get three different scans, overlapping.
  await persistScan(); // nothing of an earlier test's still running: `first` must start a scan of its own
  const first = persistScan();
  cbz(join(DL, 'Zsr/Meanwhile', 'Chapter 1.cbz'), 'Meanwhile');
  const second = persistScan();
  const third = persistScan();
  assert.notEqual(first, second, 'a request during a scan was answered with the scan already running');
  assert.equal(second, third, 'two requests during one scan started two more scans');
  await Promise.all([first, second, third]);
  assert.deepEqual((await books('Zsr/Meanwhile')).map((b) => b.n), [1], 'the follow-up scan did not see the chapter');
  // And nothing left running or queued: the next call starts a fresh scan of its own.
  const next = persistScan();
  assert.notEqual(next, second);
  await next;
});

test('a Fetch whose download the scan never indexes ends as an error that says so', { skip }, async () => {
  // v0.48.0 checked only chapters it FOUND on disk. One that downloaded into a folder the scan never indexed
  // ended "done" -- the card green, the chapter nowhere. Reintroduce by checking `onDisk` alone in
  // startDownloadJob: this card reads `done`.
  await registerDownloader();
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  await q('ALTER TABLE lib_series DISABLE TRIGGER sr_boom');
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id)
           VALUES ('s_sr_refused','Zsr','Refused','Zsr/Refused',0,'lib',$1,'refused-1')`, [SRC_DL]);
  await q('ALTER TABLE lib_series ENABLE TRIGGER sr_boom');
  const { startDownloadJob } = await import('../src/routes/sources');
  const { app, admin, settled } = await jobsApp();
  try {
    startDownloadJob({
      folder: 'Zsr/Refused', title: 'Refused', seriesId: 's_sr_refused',
      chapters: [{ number: 1, title: 'Chapter 1', sourceId: `${SRC_DL}-c1`, source: SRC_DL } as any],
      meta: { series: 'Refused' }, by: admin,
    });
    const c = await settled('Zsr/Refused');
    assert.ok(existsSync(join(DL, 'Zsr/Refused', 'Chapter 1.cbz')), 'the chapter never downloaded; the test proves nothing');
    assert.equal(c?.status, 'error', JSON.stringify(c));
    assert.match(c?.reason ?? '', /Chapter 1 is on disk, but the library scan could not add it \(the library refused it: refused for the test/);
  } finally {
    globalThis.fetch = realFetch;
    await app.close();
  }
});

test('an add whose download the scan never indexes ends as an error that says so', { skip }, async () => {
  // The Discover half of #109: the add downloaded every chapter into a folder the scan never indexed, and ended
  // "done" with the series nowhere in the library. Reintroduce by dropping the check at the end of the add's
  // run: this card reads `done`.
  await registerDownloader();
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  const { addSeriesFromSource } = await import('../src/routes/sources');
  const { app, admin, settled } = await jobsApp();
  try {
    const r = await addSeriesFromSource({ source: SRC_DL, sourceId: 'Refused Add', chapterCount: 2, userId: admin, wait: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    const c = await settled('Zzz SR DL/Refused Add');
    assert.ok(existsSync(join(DL, 'Zzz SR DL/Refused Add', 'Chapter 2.cbz')), 'the chapters never downloaded; the test proves nothing');
    assert.equal(c?.status, 'error', JSON.stringify(c));
    assert.match(c?.reason ?? '', /Chapters 1, 2 are on disk, but the library scan could not add them/);
  } finally {
    globalThis.fetch = realFetch;
    await app.close();
  }
});

test('Admin → Health → Downloads missing from the library lists them, with the reason', { skip }, async () => {
  // Reintroduce by counting a file as present whenever its FOLDER has a series row: Zsr/Refused has one.
  const { clearCensusCache } = await import('../src/lib/downloadCensus');
  // Straight in the downloads folder: never a series, whatever the scan does.
  cbz(join(DL, 'Loose.cbz'), 'Loose');
  await new Promise((r) => setTimeout(r, 20)); // its mtime strictly before the scan below begins
  await persistScan();
  // Landed after that scan began: not scanned yet, which is not the same as missing.
  cbz(join(DL, 'Zsr/Late', 'Chapter 1.cbz'), 'Late');
  clearCensusCache();
  const report = await runHealthChecks();
  const c = report.checks.find((x: any) => x.id === 'downloads-missing');
  assert.ok(c, 'no downloads-missing check on the Health page');
  assert.equal(c.status, 'problem');
  const item = (folder: string) => c.items.find((i: any) => i.title === `Downloads / ${folder}`);
  assert.match(item('Zsr/Refused')?.detail ?? '', /1 chapter not in the library \(Chapter 1\.cbz\): the library refused it: refused for the test/, JSON.stringify(c.items));
  assert.equal(item('Zsr/Refused')?.seriesId, 's_sr_refused', 'the item does not lead to its series');
  assert.match(item('Zzz SR DL/Refused Add')?.detail ?? '', /2 chapters not in the library/);
  assert.match(item('(the folder itself)')?.detail ?? '', /straight in the downloads folder: only a folder can be a series/);
  assert.equal(item('Zsr/Late'), undefined, 'a chapter newer than the last scan was called missing');
  assert.match(c.note ?? '', /1 landed after the last scan began/);
  // Every indexed download is present, and not listed.
  assert.equal(item('Zsr/Downloaded'), undefined);
  rmSync(join(DL, 'Loose.cbz'), { force: true });
  clearCensusCache();
});

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
test('a downloads folder the scan cannot read is on the Health page, not skipped in silence', { skip: skip || (asRoot && 'root reads everything') }, async () => {
  // Reintroduce by returning quietly on a failed listing in findSeriesDirs: Library scan says all is well.
  cbz(join(DL, 'Zsr/Locked', 'Chapter 1.cbz'), 'Locked');
  chmodSync(join(DL, 'Zsr/Locked'), 0o000);
  try {
    await persistScan();
    const report = await runHealthChecks();
    const c = report.checks.find((x: any) => x.id === 'library-scan');
    assert.equal(c.status, 'problem', JSON.stringify(c));
    assert.ok(c.items.some((i: any) => i.title === 'Downloads / Zsr/Locked' && /could not be read \(EACCES\)/.test(i.detail)), JSON.stringify(c.items));
    assert.match(c.summary, /left out 1 folder or file it could not read/);
  } finally {
    chmodSync(join(DL, 'Zsr/Locked'), 0o755);
  }
});
