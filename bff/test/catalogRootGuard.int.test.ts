// Is a library root there (lib/catalogRootGuard.ts, #323), at a cost a NAS can carry, and without starving the root that
// is there.
//
// - A root that is there is judged on a sample: its catalogued files are asked in a random order and the walk stops
//   once enough are present (ENOUGH_PRESENT). The owner's download folder alone catalogues 18,000 chapters, and the
//   passes that ask run several times a day -- on a NAS each stat is a network round trip.
// - A root that is not there still walks every row, so what the cleanup says it found is exact.
// - The nightly page count picks its batch AFTER leaving out a root that is not there: picked from the newest rows
//   first, a down root with a full batch of them waiting starved the root that was there, night after night.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const TMP = join(tmpdir(), `uchiyomi-crg-${process.pid}`);
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
  // Two files a night: the down root's three newer chapters would fill it.
  process.env.REPAIR_COUNT_MAX = '2';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AdmZip = require('adm-zip');

const SRC = 'T!crg';
let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let guard: typeof import('../src/lib/catalogRootGuard');
let runRepair: (log?: any, opts?: any) => Promise<any> | false;

async function clean() {
  await q('DELETE FROM lib_books WHERE source = $1', [SRC]).catch(() => {});
  await q('DELETE FROM lib_series WHERE source = $1', [SRC]).catch(() => {});
}

/** A series of `n` chapters under `root`, their files written when `present`. */
async function series(id: string, root: string, n: number, o: { present: boolean; mtime: number; pages?: number }) {
  const folder = `${SRC}/${id}`;
  await mkdir(join(root, folder), { recursive: true });
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1, $2, $1, $3, $4)`, [id, SRC, folder, n]);
  for (let i = 1; i <= n; i++) {
    const file = `${folder}/ch${i}.cbz`;
    if (o.present) {
      const zip = new AdmZip();
      zip.addFile('001.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      zip.addFile('002.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      await writeFile(join(root, file), zip.toBuffer());
    }
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, mtime, pages)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [`${id}_${i}`, id, SRC, file, i, `Chapter ${i}`, root, o.mtime, o.pages ?? 2]);
  }
}

before(async () => {
  if (!DSN) return;
  await mkdir(ROOT, { recursive: true });
  await mkdir(DL, { recursive: true });
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  guard = await import('../src/lib/catalogRootGuard');
  ({ runRepair } = (await import('../src/lib/repair')) as any);
  await migrate();
  await clean();
});

after(async () => {
  if (!DSN) return;
  await clean();
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
  await (await import('../src/lib/db')).pool.end().catch(() => {});
});

test('a root that is there is judged on a sample, not on every file it catalogues', { skip }, async () => {
  await series('crg_big', DL, 120, { present: true, mtime: Date.now() - 86_400_000 });
  try {
    const c = await guard.catalogFileCounts(DL);
    assert.ok(c.present >= 32, `enough present to say so: ${JSON.stringify(c)}`);
    assert.ok(c.present + c.missing + c.unchecked < 120, `every one of 120 files was asked: ${JSON.stringify(c)}`);
    assert.equal(await guard.catalogRootUnavailable(DL), null, 'and it is there');
  } finally {
    await clean();
  }
});

test('a root that is not there still walks every row: the count it reports is exact', { skip }, async () => {
  await series('crg_gone', ROOT, 60, { present: false, mtime: Date.now() - 86_400_000 });
  await writeFile(join(ROOT, 'stray.txt'), 'x');
  try {
    assert.deepEqual(await guard.catalogFileCounts(ROOT), { present: 0, missing: 60, unchecked: 0 });
    assert.match(String(await guard.catalogRootUnavailable(ROOT)), /no catalogued chapter file is there/);
  } finally {
    await rm(join(ROOT, 'stray.txt'), { force: true });
    await clean();
  }
});

test('a root that is not there does not starve the one that is, in the nightly page count', { skip }, async () => {
  // The library's three chapters are the newest waiting, and its share is down (the folder holds a stray file only).
  // The download root's chapter is older, and there. A batch of two picked from the newest first held only the
  // library's, which the guard then skipped: the download root was never counted, night after night.
  await series('crg_down', ROOT, 3, { present: false, mtime: Date.now() - 3_600_000, pages: 0 });
  await writeFile(join(ROOT, 'stray.txt'), 'x');
  await series('crg_up', DL, 1, { present: true, mtime: Date.now() - 86_400_000 * 5, pages: 0 });
  try {
    const r = await runRepair(undefined, { only: ['count'], userId: null });
    assert.ok(r, 'PREMISE: the repair ran');
    const [up] = await q<{ pages: number; pages_checked_at: Date | null }>(`SELECT pages, pages_checked_at FROM lib_books WHERE id = 'crg_up_1'`);
    assert.ok(up.pages_checked_at, 'the download root\'s chapter was not counted');
    assert.equal(up.pages, 2);
    const stamped = await q(`SELECT id FROM lib_books WHERE series_id = 'crg_down' AND pages_checked_at IS NOT NULL`);
    assert.deepEqual(stamped, [], 'and nothing under the root that is not there was stamped');
  } finally {
    await rm(join(ROOT, 'stray.txt'), { force: true });
    await clean();
  }
});
