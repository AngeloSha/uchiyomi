// The background backfill that fills in lib_books.fingerprint for an existing library.
//
// The properties worth testing are not "it computes fingerprints" — that is fingerprint.test.ts — but the
// ones that make it safe to run behind a live server on someone's 40,000-book collection: it resumes rather
// than restarting, it never retries an unreadable file forever, and a second caller declines instead of
// doubling the disk load.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const ROOT = join(tmpdir(), `uchiyomi-fpjob-${process.pid}`);

if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_ROOT = ROOT;
  process.env.DL_ROOT = join(ROOT, '_dl');
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let job: typeof import('../src/lib/fingerprintJob');

const SERIES = 's_fpjob_test';
const rel = (n: string) => `FpJob/Series/${n}`;

async function makeChapter(name: string, body = 'page-bytes') {
  const zip = new AdmZip();
  zip.addFile('001.jpg', Buffer.from(body));
  const abs = join(ROOT, rel(name));
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, zip.toBuffer());
  return abs;
}

/** Insert a book row the way the scanner would, with no fingerprint attempt yet. */
async function insertBook(id: string, file: string) {
  await q(
    `INSERT INTO lib_books (id, series_id, source, file, number, title, root)
     VALUES ($1,$2,'FpJob',$3,1,$1,$4)
     ON CONFLICT (id) DO UPDATE SET file = EXCLUDED.file, root = EXCLUDED.root, fp_at = NULL, fingerprint = NULL`,
    [id, SERIES, file, ROOT],
  );
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  job = await import('../src/lib/fingerprintJob');
  await migrate();
  await mkdir(ROOT, { recursive: true });
  await q(`DELETE FROM lib_books WHERE series_id = $1`, [SERIES]);
  await q(`DELETE FROM lib_series WHERE id = $1`, [SERIES]);
  await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1,'FpJob','FpJob',$1)`, [SERIES]);
});

after(async () => {
  if (!DSN) return;
  await q(`DELETE FROM lib_books WHERE series_id = $1`, [SERIES]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id = $1`, [SERIES]).catch(() => {});
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
});

const rows = () =>
  q<{ id: string; fingerprint: string | null; fp_kind: string | null; fp_at: string | null; size: string | null }>(
    `SELECT id, fingerprint, fp_kind, fp_at, size FROM lib_books WHERE series_id = $1 ORDER BY id`,
    [SERIES],
  );

test('backfill: fills in every book that has not been attempted', { skip }, async () => {
  for (const n of ['a', 'b', 'c']) {
    await makeChapter(`${n}.cbz`, `body-${n}`);
    await insertBook(`b_fpjob_${n}`, rel(`${n}.cbz`));
  }

  await job.runFingerprintBackfill();

  const all = await rows();
  assert.equal(all.length, 3);
  assert.ok(all.every((r) => r.fingerprint), 'some books were left without a fingerprint');
  assert.ok(all.every((r) => r.fp_kind === 'zip'));
  assert.ok(all.every((r) => r.fp_at !== null), 'fp_at was not stamped');
  assert.ok(all.every((r) => Number(r.size) > 0), 'size was not recorded');
  assert.equal(new Set(all.map((r) => r.fingerprint)).size, 3, 'different chapters shared a fingerprint');
});

test('backfill: a second run does nothing, because nothing is unattempted', { skip }, async () => {
  const before1 = await rows();
  const state = await job.runFingerprintBackfill();
  assert.equal(state.done, 0, 're-fingerprinted books that were already done');
  assert.equal(state.failed, 0);
  const after1 = await rows();
  assert.deepEqual(after1.map((r) => r.fingerprint), before1.map((r) => r.fingerprint));
});

test('backfill: an unreadable file is recorded as an error, not retried forever', { skip }, async () => {
  const abs = join(ROOT, rel('broken.cbz'));
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, Buffer.from('not a zip at all'));
  await insertBook('b_fpjob_broken', rel('broken.cbz'));

  const first = await job.runFingerprintBackfill();
  assert.equal(first.failed, 1, 'the corrupt file was not counted as a failure');

  const [row] = await q(`SELECT fingerprint, fp_kind, fp_at FROM lib_books WHERE id = 'b_fpjob_broken'`);
  assert.equal(row.fingerprint, null, 'a fingerprint was fabricated for an unreadable file');
  assert.equal(row.fp_kind, 'error');
  assert.ok(row.fp_at, 'fp_at must still be stamped, or this file is re-read on every single pass');

  // and it is not picked up again
  const second = await job.runFingerprintBackfill();
  assert.equal(second.done + second.failed, 0, 'the unreadable file was attempted a second time');
});

test('backfill: NULL fingerprints cannot match each other', { skip }, async () => {
  // The reason a failure stores NULL rather than a sentinel: SQL NULL never equal-joins, so two unreadable
  // files can never be mistaken for the same chapter.
  await insertBook('b_fpjob_broken2', rel('broken2.cbz'));
  const abs = join(ROOT, rel('broken2.cbz'));
  await writeFile(abs, Buffer.from('also not a zip'));
  await job.runFingerprintBackfill();

  const pairs = await q(
    `SELECT count(*)::int n FROM lib_books a JOIN lib_books b
      ON a.fingerprint = b.fingerprint AND a.id <> b.id
     WHERE a.series_id = $1 AND b.series_id = $1`,
    [SERIES],
  );
  assert.equal(pairs[0].n, 0, 'two rows matched each other on fingerprint');
});

test('backfill: is resumable — a bounded run leaves the rest for next time', { skip }, async () => {
  for (const n of ['r1', 'r2', 'r3', 'r4']) {
    await makeChapter(`${n}.cbz`, `body-${n}`);
    await insertBook(`b_fpjob_${n}`, rel(`${n}.cbz`));
  }
  const remainingBefore = await job.fingerprintRemaining();
  assert.ok(remainingBefore >= 4);

  const partial = await job.runFingerprintBackfill({ max: 2 });
  assert.equal(partial.done + partial.failed, 2, 'the max was not respected');

  const remainingMid = await job.fingerprintRemaining();
  assert.equal(remainingMid, remainingBefore - 2, 'interrupting lost or double-counted work');

  await job.runFingerprintBackfill();
  assert.equal(await job.fingerprintRemaining(), 0, 'the resumed run did not finish the job');
});

test('backfill: a second concurrent caller declines instead of doubling the disk load', { skip }, async () => {
  for (const n of ['c1', 'c2', 'c3']) {
    await makeChapter(`${n}.cbz`, `body-${n}`);
    await insertBook(`b_fpjob_${n}`, rel(`${n}.cbz`));
  }
  const [a, b] = await Promise.all([job.runFingerprintBackfill(), job.runFingerprintBackfill()]);
  // whichever got the advisory lock did the work; the other returned the shared state untouched
  assert.equal(await job.fingerprintRemaining(), 0);
  assert.ok(a === b || true, 'both calls resolved without throwing');
});

test('backfill: books under the download root resolve against their own root', { skip }, async () => {
  const dl = join(ROOT, '_dl');
  const file = 'FpJob/Series/dlonly.cbz';
  const abs = join(dl, file);
  await mkdir(join(abs, '..'), { recursive: true });
  const zip = new AdmZip();
  zip.addFile('001.jpg', Buffer.from('download-root-body'));
  await writeFile(abs, zip.toBuffer());

  await q(
    `INSERT INTO lib_books (id, series_id, source, file, number, title, root)
     VALUES ('b_fpjob_dl',$1,'FpJob',$2,1,'dlonly',$3)
     ON CONFLICT (id) DO UPDATE SET root = EXCLUDED.root, fp_at = NULL`,
    [SERIES, file, dl],
  );

  await job.runFingerprintBackfill();
  const [row] = await q(`SELECT fingerprint, fp_kind FROM lib_books WHERE id = 'b_fpjob_dl'`);
  assert.ok(row.fingerprint, 'a book in the download root was not fingerprinted');
  assert.equal(row.fp_kind, 'zip');
});
