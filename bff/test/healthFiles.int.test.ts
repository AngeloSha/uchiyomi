// Health's "Chapter files" against a real Postgres (lib/healthFiles.ts, v0.72.0, rebuilt from #252): the chapters the
// nightly count opened and found no page in, by series, from the stamps alone, with Fetch again on the files Uchiyomi
// downloaded itself and nothing deleted.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

const DSN = process.env.TEST_DATABASE_URL;
// Roots are read at module load: set before the first import of lib/library.ts.
const LIB = join(tmpdir(), `uchiyomi-hf-lib-${process.pid}`);
const DL = join(tmpdir(), `uchiyomi-hf-dl-${process.pid}`);
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_ROOT = LIB;
  process.env.DL_ROOT = DL;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

let q: (sql: string, p?: unknown[]) => Promise<any[]>;
const series = (id: string, title: string) =>
  q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1, 'test', $2, $2)`, [id, title]);
/** A chapter row; `counted` stamps it as the nightly count does, `pages` what it found. */
const book = (sid: string, folder: string, n: number, o: { root?: string; file?: string; pages?: number; counted?: boolean; pruned?: boolean } = {}) =>
  q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, pages_checked_at, pruned_at, root)
     VALUES ($1, $2, 'test', $3, $4, $5, $6, $7, $8, $9)`,
  [`${sid}_${n}`, sid, o.file ?? `${folder}/Chapter ${n}.cbz`, n, `Chapter ${n}`, o.pages ?? 0,
    o.counted === false ? null : new Date(), o.pruned ? new Date() : null, o.root ?? DL]);

before(async () => {
  if (!DSN) return;
  mkdirSync(DL, { recursive: true });
  mkdirSync(LIB, { recursive: true });
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q } = await import('../src/lib/db'));
  // Ours: two chapters the count found no page in, one under the downloader's own name and one not; one never counted,
  // one deleted, one fine.
  await series('hf_own', 'HF Own');
  await book('hf_own', 'HF Own', 1);
  await book('hf_own', 'HF Own', 2, { file: 'HF Own/ch 2 [group].cbz' });
  await book('hf_own', 'HF Own', 3, { counted: false });
  await book('hf_own', 'HF Own', 4, { pruned: true });
  await book('hf_own', 'HF Own', 5, { pages: 12 });
  // Somebody's own library: listed, never fetched again.
  await series('hf_lib', 'HF Library');
  await book('hf_lib', 'HF Library', 7, { root: LIB });
  // The most unreadable files: listed first.
  await series('hf_many', 'HF Many');
  for (const n of [1, 2, 3, 4, 5, 6, 7]) await book('hf_many', 'HF Many', n);
  // A whole archive on disk behind a stamp of 0: the card trusts the count and opens nothing.
  const z = new AdmZip();
  z.addFile('001.png', Buffer.from('a page'));
  mkdirSync(join(DL, 'HF Own'), { recursive: true });
  writeFileSync(join(DL, 'HF Own', 'Chapter 1.cbz'), z.toBuffer());
});

after(() => {
  rmSync(DL, { recursive: true, force: true });
  rmSync(LIB, { recursive: true, force: true });
});

test('the chapters the count found no page in, by series, most first; Fetch again only on what Uchiyomi downloaded', { skip }, async () => {
  const { chapterFiles } = await import('../src/lib/healthFiles');
  const { englishOf } = await import('../src/lib/said');
  const card = await chapterFiles();
  assert.equal(card.status, 'warn');
  assert.deepEqual(card.items.map((i) => i.seriesId), ['hf_many', 'hf_own', 'hf_lib']);
  const own = card.items.find((i) => i.seriesId === 'hf_own')!;
  // Never counted, deleted, and fine are not listed: two files, one of them under another name than the downloader's.
  assert.deepEqual(own.detailSaid, [
    { code: 'files.detail', params: { n: 2, numbers: [1, 2], more: 0 } },
    { code: 'files.notOurs', params: { n: 1 } },
  ]);
  assert.deepEqual(own.bookIds, ['hf_own_1'], 'only the file the refetch route would take back: the downloader\'s own name');
  assert.deepEqual(own.numbers, [1]);
  assert.deepEqual(own.actions, ['refetch', 'ignore']);
  assert.equal(own.key, 'series:hf_own');
  const lib = card.items.find((i) => i.seriesId === 'hf_lib')!;
  assert.deepEqual(lib.actions, ['ignore'], 'a file in a library somebody built is theirs to replace');
  assert.equal(lib.bookIds, undefined);
  const many = card.items.find((i) => i.seriesId === 'hf_many')!;
  assert.deepEqual(many.detailSaid?.[0]?.params, { n: 7, numbers: [1, 2, 3, 4, 5], more: 2 });
  assert.equal(many.detail, '7 chapter files with no page that can be read: 1, 2, 3, 4, 5 and 2 more');
  assert.deepEqual(card.summarySaid, [{ code: 'files.live', params: { n: 10, m: 3 } }]);
  assert.equal(card.summary, '10 chapter files in 3 series have no page that can be read');
  assert.equal(englishOf(card.noteSaid), card.note);
});

test('the card opens no file: a stamp is believed, and nothing on disk changes', { skip }, async () => {
  // #252 read the tail of up to 3,000 files on every run. Reintroduce a look at the file: the whole archive behind
  // hf_own_1's stamp reads fine, and the row goes.
  const { chapterFiles } = await import('../src/lib/healthFiles');
  const card = await chapterFiles();
  assert.ok(card.items.find((i) => i.seriesId === 'hf_own')?.bookIds?.includes('hf_own_1'));
  assert.ok(existsSync(join(DL, 'HF Own', 'Chapter 1.cbz')), 'and nothing was deleted');
  const [row] = await q(`SELECT pruned_at FROM lib_books WHERE id = 'hf_own_1'`);
  assert.equal(row.pruned_at, null, 'or marked');
});

test('a chapter counted again, or deleted, leaves the card; a new unreadable one is news to an ignore', { skip }, async () => {
  const { chapterFiles } = await import('../src/lib/healthFiles');
  const { findingOf } = await import('../src/lib/health');
  const { ignoreFinding, loadIgnores } = await import('../src/lib/healthIgnore');
  // Ignored while these are its chapters.
  const f = await findingOf('files', 'series:hf_lib');
  assert.deepEqual(f?.members, ['hf_lib_7']);
  await ignoreFinding('files', 'series:hf_lib', f!, null);
  let card = await chapterFiles(await loadIgnores());
  assert.ok(card.items.find((i) => i.seriesId === 'hf_lib')?.ignored);
  await book('hf_lib', 'HF Library', 8, { root: LIB });
  card = await chapterFiles(await loadIgnores());
  assert.ok(!card.items.find((i) => i.seriesId === 'hf_lib')?.info, 'another file that cannot be read is a new finding');

  // What a scan does to a file whose mtime moved (lib/library.ts persistScan), and what the delete route leaves.
  await q(`UPDATE lib_books SET pages_checked_at = NULL WHERE series_id = 'hf_many'`);
  await q(`UPDATE lib_books SET pruned_at = now(), pruned_reason = 'deleted' WHERE series_id = 'hf_own'`);
  card = await chapterFiles();
  assert.deepEqual(card.items.map((i) => i.seriesId), ['hf_lib']);
});
