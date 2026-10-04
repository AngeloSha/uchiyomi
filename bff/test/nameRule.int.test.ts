// New files only (v0.55.2, discussion #150): the scanner reads a chapter's number out of a file name by the rule the
// row was born with (lib_books.name_rule, lib/naming.ts numberByRule). Every chapter already in a library keeps the
// first number in its name; a file the scanner meets for the first time -- a new one, or a renamed one, which is a
// new row -- is read by rule 2. What the owner promised on #150: "Chapters already in your library keep their
// numbers, so nothing gets renumbered behind your back."
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, rename } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;

// Read at module load by library.ts, so set before its first import.
const ROOT_A = join(tmpdir(), `uchiyomi-rule-lib-${process.pid}`);
const ROOT_B = join(tmpdir(), `uchiyomi-rule-dl-${process.pid}`);

if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_ROOT = ROOT_A;
  process.env.DL_ROOT = ROOT_B;
}

const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

type Q = <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let q: Q;
let persistScan: () => Promise<{ series: number; books: number; ms: number }>;
let numFromName: (name: string) => number;
let chapterFromName: (name: string) => { number: number; end: number | null };

const SRC = 'T!rule';
const TITLE = 'Hand Collected';
const FOLDER = `${SRC}/${TITLE}`;

/** A minimal valid CBZ: one page. */
async function writeCbz(file: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile('001.jpg', Buffer.from(`page-of-${file}`));
  const abs = join(ROOT_A, SRC, TITLE, file);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, zip.toBuffer());
}

/** Every row of the folder, keyed by its file name. */
async function rows(): Promise<Map<string, { id: string; number: number; rule: number }>> {
  const r = await q<{ id: string; file: string; number: number; rule: number }>(
    `SELECT b.id, b.file, b.number::float8 AS number, b.name_rule AS rule
       FROM lib_books b JOIN lib_series s ON s.id = b.series_id WHERE s.folder = $1`, [FOLDER]);
  return new Map(r.map((x) => [x.file.slice(FOLDER.length + 1), { id: x.id, number: Number(x.number), rule: Number(x.rule) }]));
}
const numbers = async (): Promise<Record<string, number>> =>
  Object.fromEntries([...(await rows())].map(([f, r]) => [f, r.number]));

async function wipe() {
  await q(`DELETE FROM lib_books WHERE root = $1 OR root = $2`, [ROOT_A, ROOT_B]);
  await q(`DELETE FROM lib_series WHERE source LIKE 'T!rule%'`);
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as { q: Q });
  ({ persistScan } = await import('../src/lib/library'));
  ({ numFromName, chapterFromName } = await import('../src/lib/naming'));
  await migrate();
});

beforeEach(async () => {
  if (!DSN) return;
  await wipe();
  await rm(ROOT_A, { recursive: true, force: true });
  await rm(ROOT_B, { recursive: true, force: true });
  await mkdir(ROOT_A, { recursive: true });
  await mkdir(ROOT_B, { recursive: true });
});

after(async () => {
  if (!DSN) return;
  await wipe().catch(() => {});
  await rm(ROOT_A, { recursive: true, force: true }).catch(() => {});
  await rm(ROOT_B, { recursive: true, force: true }).catch(() => {});
});

// Hand-named comics, each read differently by the two rules (the cases #150 named).
const COMICS = ['Vol 2 Ch 5.cbz', 'Batman (1987) #12.cbz', 'Watchmen (1986).cbz', 'Vol 3 Chapter 12.cbz', 'Diabolik (1962) n.1.cbz'];

/**
 * The folder as a library scanned before v0.55.2 holds it: the rows v0.55.1's scan wrote, which name no name_rule
 * (the column's default makes them rule 1) and carry the first number in each name.
 */
async function asBefore(files: string[]): Promise<void> {
  await persistScan();
  // persistScan created the series; put its rows back as the old scan left them.
  await q(`UPDATE lib_books b SET name_rule = DEFAULT, number = v.n
             FROM unnest($1::text[], $2::real[]) AS v(f, n), lib_series s
            WHERE s.id = b.series_id AND s.folder = $3 AND b.file = $3 || '/' || v.f`,
    [files, files.map((f) => numFromName(f)), FOLDER]);
}

test('a rescan never renumbers a chapter already in the library', { skip }, async () => {
  for (const f of COMICS) await writeCbz(f);
  await asBefore(COMICS);
  const before = await rows();
  for (const f of COMICS) {
    assert.equal(before.get(f)!.rule, 1, `${f} is not a rule-1 row`);
    // The test means something only where the rules disagree.
    assert.notEqual(numFromName(f), chapterFromName(f).number, `${f} reads the same by both rules`);
  }
  await persistScan();
  await persistScan();
  // Reintroduce by reading every file with NAME_RULE: `Vol 2 Ch 5.cbz` moves from 2 to 5.
  assert.deepEqual(await numbers(), Object.fromEntries(COMICS.map((f) => [f, numFromName(f)])),
    'a rescan renumbered a chapter already in the library');
  const after = await rows();
  for (const f of COMICS) {
    assert.equal(after.get(f)!.id, before.get(f)!.id, `${f} changed its id`);
    assert.equal(after.get(f)!.rule, 1, `${f} changed its rule`);
  }
});

test('a newly added file, and a renamed one, are read by rule 2', { skip }, async () => {
  for (const f of COMICS) await writeCbz(f);
  await asBefore(COMICS);
  // A new chapter beside the old ones, and an old one renamed: both are new rows.
  await writeCbz('Vol 2 Ch 6.cbz');
  await rename(join(ROOT_A, SRC, TITLE, 'Vol 3 Chapter 12.cbz'), join(ROOT_A, SRC, TITLE, 'Vol 3 Chapter 12 - The Return.cbz'));
  await persistScan();
  const now = await rows();
  assert.deepEqual([now.get('Vol 2 Ch 6.cbz')!.number, now.get('Vol 2 Ch 6.cbz')!.rule], [6, 2], 'a new file is not read by rule 2');
  assert.deepEqual([now.get('Vol 3 Chapter 12 - The Return.cbz')!.number, now.get('Vol 3 Chapter 12 - The Return.cbz')!.rule], [12, 2],
    'a renamed file is not read by rule 2');
  // ...and its neighbours still read as they did.
  assert.deepEqual([now.get('Vol 2 Ch 5.cbz')!.number, now.get('Vol 2 Ch 5.cbz')!.rule], [2, 1]);
  // Reintroduce by inserting every new row as rule 1 (the column's default): the first assertion reads [6, 1], and the
  // next scan would read the new file as chapter 2.
});

test('the scan drill: hand-named comics scanned twice, then more, then a library that already held them', { skip }, async () => {
  const DRILL = [
    'Batman #12 (1987).cbz', 'Batman 01-07 (1987).cbz', 'Watchmen (1986).cbz', 'Vol 3 Chapter 12.cbz', 'Vol.3 Ch.13 - Title.cbz',
    'Ch.14 - Title [Group].cbz', 'Capitolo 15.cbz', 'Chapter 16 - Episode #5.cbz', 'Chapter 16.5.cbz', 'Oneshot.cbz',
  ];
  for (const f of DRILL) await writeCbz(f);
  await persistScan();
  const first = await rows();
  assert.deepEqual(Object.fromEntries([...first].map(([f, r]) => [f, r.number])),
    Object.fromEntries(DRILL.map((f) => [f, chapterFromName(f).number])), 'the first scan does not read rule 2');
  assert.ok([...first.values()].every((r) => r.rule === 2), 'a new file is not rule 2');
  // The second scan changes nothing: not a number, not an id, not a rule.
  await persistScan();
  assert.deepEqual(await rows(), first, 'a second scan changed a row');
  // More files, and a rescan: only they are new.
  await writeCbz('Batman #13 (1987).cbz');
  await writeCbz('Vol 4 Chapter 20.cbz');
  await persistScan();
  const more = await rows();
  assert.equal(more.get('Batman #13 (1987).cbz')!.number, 13);
  assert.equal(more.get('Vol 4 Chapter 20.cbz')!.number, 20);
  for (const [f, r] of first) assert.deepEqual(more.get(f), r, `${f} changed when other files arrived`);

  // The same folder in a library v0.55.1 scanned: every row rule 1, with the first number. Its numbers are kept.
  await wipe();
  await asBefore([...DRILL, 'Batman #13 (1987).cbz', 'Vol 4 Chapter 20.cbz']);
  const kept = await numbers();
  await persistScan();
  assert.deepEqual(await numbers(), kept, 'a library scanned before v0.55.2 was renumbered');
  assert.equal(kept['Vol 4 Chapter 20.cbz'], 4, 'the rule-1 drill row does not hold the first number');
});

test('after a rollback to v0.55.1, the next scan reads rule-2 rows by rule 2 again', { skip }, async () => {
  for (const f of COMICS) await writeCbz(f);
  await persistScan();
  const fresh = await numbers();
  // v0.55.1's scan names no name_rule and reads every file by the first number: rule-2 rows included.
  await q(`UPDATE lib_books b SET number = v.n
             FROM unnest($1::text[], $2::real[]) AS v(f, n), lib_series s
            WHERE s.id = b.series_id AND s.folder = $3 AND b.file = $3 || '/' || v.f`,
    [COMICS, COMICS.map((f) => numFromName(f)), FOLDER]);
  // ...and a file it added in the meantime is rule 1 for good, by the column's default.
  await writeCbz('Vol 5 Ch 30.cbz');
  const s = await q<{ id: string }>(`SELECT id FROM lib_series WHERE folder = $1`, [FOLDER]);
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, mtime, root)
           VALUES ('b_rule_v0551', $1, $2, $3, 5, 'Vol 5 Ch 30', 0, $4)`, [s[0].id, SRC, `${FOLDER}/Vol 5 Ch 30.cbz`, ROOT_A]);
  await persistScan();
  assert.deepEqual(await numbers(), { ...fresh, 'Vol 5 Ch 30.cbz': 5 });
});
