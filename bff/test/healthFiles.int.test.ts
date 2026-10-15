// Fix everything's bad-file step against a real scratch database and disk: an empty or cut-short chapter file is taken
// off the disk and its chapter marked 'missing' (which the sweep fetches again at the same row); a whole file stays, and
// so does a chapter whose whole folder is gone (a share that went away, not chapters somebody removed).
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '', DL = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-hf-'));
  DL = join(ROOT, 'dl');
  mkdirSync(DL, { recursive: true });
  mkdirSync(join(ROOT, 'lib'), { recursive: true });
  process.env.DL_ROOT = DL;
  process.env.LIBRARY_ROOT = join(ROOT, 'lib');
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

let q: any, hf: any;
const LIB = 'lib_hf';
const SER = 's_hf_main', GONE = 's_hf_gone';

// A zip holding one stored file, whole (end record last) or cut short.
function zip(whole: boolean): Buffer {
  const name = Buffer.from('a.txt');
  const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.alloc(4), Buffer.from([2, 0, 0, 0, 2, 0, 0, 0]), Buffer.from([name.length, 0, 0, 0]), name, Buffer.from('hi')]);
  const central = Buffer.concat([Buffer.from([0x50, 0x4b, 0x01, 0x02]), Buffer.alloc(42), name]);
  const end = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
  const all = Buffer.concat([local, central, end]);
  return whole ? all : all.subarray(0, all.length - 30);
}

async function seed(series: string, n: number, file: string, bytes: Buffer | null) {
  if (bytes) { mkdirSync(join(DL, file, '..'), { recursive: true }); writeFileSync(join(DL, file), bytes); }
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root, mtime)
           VALUES ($1,$2,'T!hf',$3,$4,$5,1,$6,1000)`, [`b_${series}_${n}`, series, file, n, `Chapter ${n}`, DL]);
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q } = await import('../src/lib/db'));
  hf = await import('../src/lib/healthFiles');
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'HF',$2) ON CONFLICT (id) DO NOTHING`, [LIB, DL]);
  for (const [id, title] of [[SER, 'HF Main'], [GONE, 'HF Gone']]) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id) VALUES ($1,'T!hf',$2,$3,0,$4)`, [id, title, `${title}`, LIB]);
  }
  mkdirSync(join(DL, 'HF Main'), { recursive: true });
  await seed(SER, 1, 'HF Main/Chapter 1.cbz', zip(true));
  await seed(SER, 2, 'HF Main/Chapter 2.cbz', Buffer.alloc(0));
  await seed(SER, 3, 'HF Main/Chapter 3.cbz', zip(false));
  await seed(SER, 4, 'HF Main/Chapter 4.cbz', null);
  await seed(GONE, 1, 'HF Gone/Chapter 1.cbz', null);
});

after(async () => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [[SER, GONE]]).catch(() => {});
});

test('the Chapter files card lists the series with bad files, most first, and a missing file makes it a problem', { skip }, async () => {
  const card = await hf.chapterFiles();
  assert.equal(card.id, 'files');
  assert.equal(card.status, 'problem');
  const mine = card.items.find((i: any) => i.seriesId === SER);
  assert.ok(mine, 'the series with an empty, a cut-short and a missing file');
  assert.equal(mine.key, `series:${SER}`);
  assert.deepEqual(mine.detailSaid?.[0]?.params, { missing: 1, empty: 1, broken: 1 });
  assert.equal(card.items[0].seriesId, SER, 'the series with the most bad chapters first');
  assert.deepEqual(card.items.find((i: any) => i.seriesId === GONE)?.detailSaid?.[0]?.params, { missing: 1, empty: 0, broken: 0 });
});

test('badChapterFiles finds the empty, cut-short and missing files of the download folder', { skip }, async () => {
  const bad = await hf.badChapterFiles();
  const mine = bad.filter((b: any) => b.seriesId === SER).map((b: any) => `${b.id}:${b.state}`).sort();
  assert.deepEqual(mine, [`b_${SER}_2:empty`, `b_${SER}_3:broken`, `b_${SER}_4:missing`]);
});

test('dropBadFiles takes the bad files off the disk and marks them missing; a whole file and a vanished folder stay', { skip }, async () => {
  const marked = await hf.dropBadFiles(SER, [`b_${SER}_1`, `b_${SER}_2`, `b_${SER}_3`, `b_${SER}_4`], { userId: null, runId: 'r1' });
  assert.equal(marked, 3, 'the whole file is not touched');
  assert.equal(existsSync(join(DL, 'HF Main/Chapter 1.cbz')), true);
  assert.equal(existsSync(join(DL, 'HF Main/Chapter 2.cbz')), false);
  assert.equal(existsSync(join(DL, 'HF Main/Chapter 3.cbz')), false);
  const rows = await q('SELECT id, pruned_reason, pruned_at IS NOT NULL AS pruned FROM lib_books WHERE series_id = $1 ORDER BY id', [SER]);
  assert.deepEqual(rows.map((r: any) => [r.id, r.pruned, r.pruned_reason]), [
    [`b_${SER}_1`, false, null], [`b_${SER}_2`, true, 'missing'], [`b_${SER}_3`, true, 'missing'], [`b_${SER}_4`, true, 'missing'],
  ]);
  const audit = await q(`SELECT detail FROM audit_log WHERE event = 'series.chapters_refetch' ORDER BY id DESC LIMIT 1`);
  assert.equal(audit[0]?.detail.via, 'autofix');
  assert.equal(audit[0]?.detail.runId, 'r1');
});

test('a chapter whose whole folder is gone is not marked: that is a share that went away, not a deleted chapter', { skip }, async () => {
  assert.equal(await hf.dropBadFiles(GONE, [`b_${GONE}_1`], { userId: null }), 0);
  const [r] = await q('SELECT pruned_at FROM lib_books WHERE id = $1', [`b_${GONE}_1`]);
  assert.equal(r.pruned_at, null);
});
