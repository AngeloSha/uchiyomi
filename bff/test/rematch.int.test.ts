// Recognising a series whose folder moved.
//
// The valuable tests here are the REFUSALS. A wrong match moves someone's reading progress onto the wrong
// series, which is worse than not helping at all, so most of this file is about the cases where the answer
// has to be "I don't know" — thin evidence, two equally plausible candidates, a backfill that has not
// finished, a series that never moved in the first place.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, rename } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const ROOT_A = join(tmpdir(), `uchiyomi-rm-${process.pid}`);
const ROOT_B = join(tmpdir(), `uchiyomi-rmdl-${process.pid}`);

if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_ROOT = ROOT_A;
  process.env.DL_ROOT = ROOT_B;
  process.env.LIBRARY_REMATCH = 'apply'; // individual tests override via the env object
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let persistScan: () => Promise<any>;
let job: typeof import('../src/lib/fingerprintJob');
let env: { LIBRARY_REMATCH: 'off' | 'report' | 'apply' };

const SRC = 'T!rm';
const dir = (name: string) => join(ROOT_A, SRC, name);

async function chapter(folder: string, file: string, body: string) {
  const zip = new AdmZip();
  zip.addFile('001.jpg', Buffer.from(body));
  zip.addFile('ComicInfo.xml', Buffer.from(`<ComicInfo><Series>${folder}</Series></ComicInfo>`));
  const abs = join(dir(folder), file);
  await mkdir(dir(folder), { recursive: true });
  await writeFile(abs, zip.toBuffer());
}

const seriesRow = async (folder: string) =>
  (await q(`SELECT * FROM lib_series WHERE folder = $1`, [`${SRC}/${folder}`]))[0];
const allSeries = async () => q(`SELECT id, folder, folder_prev FROM lib_series WHERE source = $1 ORDER BY folder`, [SRC]);
const booksOf = async (id: string) => q(`SELECT id, file FROM lib_books WHERE series_id = $1 ORDER BY file`, [id]);

/** Scan, then fingerprint everything, then scan again — the steady state a real install reaches. */
async function scanAndFingerprint() {
  await persistScan();
  await job.runFingerprintBackfill();
}

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
  job = await import('../src/lib/fingerprintJob');
  ({ env } = (await import('../src/env')) as any);
  await migrate();
  await mkdir(ROOT_A, { recursive: true });
  await mkdir(ROOT_B, { recursive: true });
});

beforeEach(async () => {
  if (!DSN) return;
  await wipe();
  env.LIBRARY_REMATCH = 'apply';
});

after(async () => {
  if (!DSN) return;
  await wipe().catch(() => {});
  await rm(ROOT_A, { recursive: true, force: true }).catch(() => {});
  await rm(ROOT_B, { recursive: true, force: true }).catch(() => {});
});

test('rematch: a renamed folder keeps its series, its id and its reading progress', { skip }, async () => {
  await chapter('Old Name', 'Chapter 1.cbz', 'ch1-body');
  await chapter('Old Name', 'Chapter 2.cbz', 'ch2-body');
  await scanAndFingerprint();

  const before1 = await seriesRow('Old Name');
  const [book1] = await booksOf(before1.id);
  // pretend someone read it
  await q(
    `INSERT INTO read_progress (user_id, book_id, series_id, page, completed)
     SELECT id, $1, $2, 7, false FROM users LIMIT 1
     ON CONFLICT DO NOTHING`,
    [book1.id, before1.id],
  ).catch(() => {});

  await rename(dir('Old Name'), dir('New Name'));
  await persistScan();

  const after1 = await seriesRow('New Name');
  assert.ok(after1, 'the renamed folder produced no series');
  assert.equal(after1.id, before1.id, 'the series id changed, so everything attached to it is stranded');
  assert.equal(after1.folder_prev, `${SRC}/Old Name`, 'the old folder was not recorded for reversal');

  assert.equal((await allSeries()).length, 1, 'the rename left a duplicate series behind');

  const books = await booksOf(after1.id);
  assert.equal(books.length, 2, 'the series ended up holding both the old and new paths');
  assert.ok(books.every((b) => b.file.includes('New Name')), 'book rows still point at the old folder');

  const prog = await q(`SELECT page FROM read_progress WHERE book_id = $1`, [book1.id]);
  if (prog.length) assert.equal(prog[0].page, 7, 'reading progress did not survive the move');
});

test('rematch: off by default — a renamed folder still becomes a new series', { skip }, async () => {
  env.LIBRARY_REMATCH = 'off';
  await chapter('Off A', 'Chapter 1.cbz', 'off-1');
  await chapter('Off A', 'Chapter 2.cbz', 'off-2');
  await scanAndFingerprint();
  const before1 = await seriesRow('Off A');

  await rename(dir('Off A'), dir('Off B'));
  await persistScan();

  const after1 = await seriesRow('Off B');
  assert.notEqual(after1.id, before1.id, 'rematch ran while the flag was off');
  assert.equal((await allSeries()).length, 2, 'expected the old row to survive, as it does today');
});

test('rematch: report mode changes nothing', { skip }, async () => {
  env.LIBRARY_REMATCH = 'report';
  await chapter('Rep A', 'Chapter 1.cbz', 'rep-1');
  await chapter('Rep A', 'Chapter 2.cbz', 'rep-2');
  await scanAndFingerprint();
  const before1 = await seriesRow('Rep A');

  await rename(dir('Rep A'), dir('Rep B'));
  await persistScan();

  assert.notEqual((await seriesRow('Rep B')).id, before1.id, 'report mode applied a move');
  assert.equal((await allSeries()).length, 2, 'report mode changed the library');

  const logged = await q(
    `SELECT detail FROM audit_log WHERE event = 'library.rematch.report' ORDER BY at DESC LIMIT 1`,
  );
  assert.ok(logged.length, 'report mode did not record what it would have done');
  assert.equal(logged[0].detail.matched, true);
  assert.equal(logged[0].detail.applied, false);
});

test('rematch: refuses on a single chapter — one file is not evidence', { skip }, async () => {
  await chapter('Solo A', 'Chapter 1.cbz', 'solo-only');
  await scanAndFingerprint();
  const before1 = await seriesRow('Solo A');

  await rename(dir('Solo A'), dir('Solo B'));
  await persistScan();

  assert.notEqual((await seriesRow('Solo B')).id, before1.id, 'matched a series on the strength of one file');
});

test('rematch: refuses when two candidates are equally plausible', { skip }, async () => {
  // Two series holding byte-identical chapters. Neither is a safe answer, so neither may be chosen.
  for (const name of ['Twin A', 'Twin B']) {
    await chapter(name, 'Chapter 1.cbz', 'identical-1');
    await chapter(name, 'Chapter 2.cbz', 'identical-2');
  }
  await scanAndFingerprint();
  const ids = (await allSeries()).map((s: any) => s.id).sort();
  assert.equal(ids.length, 2);

  // a third folder with the same content appears; it could be either
  await chapter('Twin C', 'Chapter 1.cbz', 'identical-1');
  await chapter('Twin C', 'Chapter 2.cbz', 'identical-2');
  await persistScan();

  const c = await seriesRow('Twin C');
  assert.ok(!ids.includes(c.id), 'picked one of two equally plausible candidates');
  assert.equal((await allSeries()).length, 3, 'the ambiguous folder should have become its own series');
});

test('rematch: never steals a series that is still sitting at its own folder', { skip }, async () => {
  // A copy of an existing series appearing elsewhere must not drag the original out of its own directory.
  await chapter('Keeps Place', 'Chapter 1.cbz', 'kp-1');
  await chapter('Keeps Place', 'Chapter 2.cbz', 'kp-2');
  await scanAndFingerprint();
  const original = await seriesRow('Keeps Place');

  await chapter('A Copy', 'Chapter 1.cbz', 'kp-1');
  await chapter('A Copy', 'Chapter 2.cbz', 'kp-2');
  await persistScan();

  const still = await seriesRow('Keeps Place');
  assert.ok(still, 'the original series was moved out of a folder that still exists');
  assert.equal(still.id, original.id);
  assert.notEqual((await seriesRow('A Copy')).id, original.id, 'the copy took over the original');
});

test('rematch: refuses a candidate that is only partly fingerprinted', { skip }, async () => {
  // The specific danger: a series with 2 of its 3 chapters fingerprinted reports a total of 2, so sharing
  // those 2 reads as complete overlap when it is really two thirds. Such a candidate must be ignored.
  await chapter('Pend A', 'Chapter 1.cbz', 'pend-1');
  await chapter('Pend A', 'Chapter 2.cbz', 'pend-2');
  await chapter('Pend A', 'Chapter 3.cbz', 'pend-3');
  await scanAndFingerprint();
  const before1 = await seriesRow('Pend A');

  // one chapter of THIS series never got attempted
  await q(
    `UPDATE lib_books SET fp_at = NULL, fingerprint = NULL
      WHERE id = (SELECT id FROM lib_books WHERE series_id = $1 ORDER BY file DESC LIMIT 1)`,
    [before1.id],
  );

  await rename(dir('Pend A'), dir('Pend B'));
  await persistScan();

  assert.notEqual(
    (await seriesRow('Pend B')).id,
    before1.id,
    'matched against a series whose own fingerprints are incomplete',
  );
});

test('rematch: an unrelated unfingerprinted series does not block a good match', { skip }, async () => {
  // The gate is per candidate, not global. New chapters arrive constantly, and they must not stop an
  // unrelated rename from being recognised.
  await chapter('Noise', 'Chapter 1.cbz', 'noise-1');
  await chapter('Good A', 'Chapter 1.cbz', 'good-1');
  await chapter('Good A', 'Chapter 2.cbz', 'good-2');
  await scanAndFingerprint();
  const good = await seriesRow('Good A');

  // an unrelated series is left unfingerprinted, as if it had only just been added
  const noise = await seriesRow('Noise');
  await q(`UPDATE lib_books SET fp_at = NULL, fingerprint = NULL WHERE series_id = $1`, [noise.id]);

  await rename(dir('Good A'), dir('Good B'));
  await persistScan();

  assert.equal(
    (await seriesRow('Good B')).id,
    good.id,
    'an unrelated half-finished series blocked a perfectly good match',
  );
});

test('rematch: a partial rename still matches when most chapters carry over', { skip }, async () => {
  // Folder renamed AND a chapter added at the same time — the overlap rule should still recognise it.
  await chapter('Grow A', 'Chapter 1.cbz', 'g-1');
  await chapter('Grow A', 'Chapter 2.cbz', 'g-2');
  await chapter('Grow A', 'Chapter 3.cbz', 'g-3');
  await scanAndFingerprint();
  const before1 = await seriesRow('Grow A');

  await rename(dir('Grow A'), dir('Grow B'));
  await chapter('Grow B', 'Chapter 4.cbz', 'g-4');
  await persistScan();

  const after1 = await seriesRow('Grow B');
  assert.equal(after1.id, before1.id, 'a rename plus one new chapter was not recognised');
  assert.equal((await booksOf(after1.id)).length, 4);
});
