// Fill what a series is missing (description, genres, author, cover) from the other sources it is attached to.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_mf';
const EMPTY = 's_mf_empty';
const FULL = 's_mf_full';
const PARTIAL = 's_mf_partial';
const BROKEN = 's_mf_broken_first';
const SERIES = [EMPTY, FULL, PARTIAL, BROKEN];
const MAIN = 'mf-main';
const FOLLOW = 'mf-follow';
const DOWN = 'mf-down';

const info = { sourceId: 'x', source: FOLLOW, title: 'T', summary: '  A fuller description.  ', genres: [' Action ', '', 'Drama'], author: ' Some Author ', coverUrl: 'https://img.example/cover.jpg' };
const adapter = (id: string, getSeries: () => Promise<unknown>) => ({
  id, name: id,
  async search() { return []; }, getSeries, async listChapters() { return []; }, async getPageUrls() { return []; }, async latest() { return []; }, async popular() { return []; },
});

test('metaFill fills only empty fields, from the attached sources in order', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const { registerAdapter } = await import('../src/lib/sources');
  const { fillMissingMeta, seriesMissingMeta } = await import('../src/lib/metaFill');
  await migrate();
  // The main source never describes anything; the follower describes everything; a third is unreachable.
  registerAdapter(adapter(MAIN, async () => ({ sourceId: 'x', source: MAIN, title: 'T' })) as any);
  registerAdapter(adapter(FOLLOW, async () => info) as any);
  registerAdapter(adapter(DOWN, async () => { throw new Error('down'); }) as any);

  const cleanup = async () => {
    await q('DELETE FROM series_overrides WHERE series_id = ANY($1)', [SERIES]).catch(() => {});
    await q('DELETE FROM series_art WHERE series_id = ANY($1)', [SERIES]).catch(() => {});
    await q('DELETE FROM series_sources WHERE series_id = ANY($1)', [SERIES]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]).catch(() => {});
    await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  };
  await cleanup();
  await q(`INSERT INTO libraries (id, name, path, age_rating) VALUES ($1,'MF','/mf',NULL)`, [LIB]);
  const mk = (id: string, main: string, summary: string | null, author: string | null, genres: string[]) => q(
    `INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, summary, author, genres, latest_mtime, created_at)
     VALUES ($1,'T!mf',$2,$3,0,$4,$5,'m-1',$6,$7,$8,1,now())`, [id, `Zzz MF ${id}`, `T!mf/${id}`, LIB, main, summary, author, genres]);
  const follow = (id: string, src: string) => q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,$2,'f-1')`, [id, src]);
  await mk(EMPTY, MAIN, null, null, []);
  await follow(EMPTY, FOLLOW);
  await mk(FULL, MAIN, 'Scanned description.', 'Scanned Author', ['Romance']);
  await q(`INSERT INTO series_art (series_id, cover) VALUES ($1, 'https://img.example/own.jpg')`, [FULL]);
  await follow(FULL, FOLLOW);
  await mk(PARTIAL, MAIN, 'Scanned description.', null, []);
  await q(`INSERT INTO series_overrides (series_id, genres) VALUES ($1, ARRAY['Chosen'])`, [PARTIAL]);
  await follow(PARTIAL, FOLLOW);
  await mk(BROKEN, DOWN, null, null, []);
  await follow(BROKEN, FOLLOW);

  try {
    await t.test('a series missing everything is filled from its follower, trimmed, and the fields are reported', async () => {
      const r = await fillMissingMeta(EMPTY);
      assert.deepEqual(r.filled.sort(), ['author', 'cover', 'genres', 'summary']);
      assert.deepEqual(r.from, [FOLLOW]);
      assert.equal(r.tried, 2, 'the main source (which had nothing) is asked first, then the follower');
      const o = await one<{ summary: string; genres: string[]; author: string }>('SELECT summary, genres, author FROM series_overrides WHERE series_id = $1', [EMPTY]);
      assert.deepEqual(o, { summary: 'A fuller description.', genres: ['Action', 'Drama'], author: 'Some Author' });
      assert.equal((await one<{ cover: string }>('SELECT cover FROM series_art WHERE series_id = $1', [EMPTY]))?.cover, info.coverUrl);
    });

    await t.test('asked again, nothing more is asked or written', async () => {
      const r = await fillMissingMeta(EMPTY);
      assert.deepEqual(r, { filled: [], from: [], tried: 0 });
    });

    await t.test('nothing already set is replaced, by a scan, an override or an earlier cover', async () => {
      const r = await fillMissingMeta(FULL);
      assert.deepEqual(r, { filled: [], from: [], tried: 0 });
      assert.equal(await one('SELECT 1 FROM series_overrides WHERE series_id = $1', [FULL]), null, 'a series that lacks nothing got an override row');
      assert.equal((await one<{ cover: string }>('SELECT cover FROM series_art WHERE series_id = $1', [FULL]))?.cover, 'https://img.example/own.jpg');
    });

    await t.test('only the empty fields of a partly filled series are written', async () => {
      const r = await fillMissingMeta(PARTIAL);
      assert.deepEqual(r.filled.sort(), ['author', 'cover']);
      const o = await one<{ summary: string | null; genres: string[]; author: string }>('SELECT summary, genres, author FROM series_overrides WHERE series_id = $1', [PARTIAL]);
      assert.equal(o?.summary, null, 'the scanned description was shadowed by an override');
      assert.deepEqual(o?.genres, ['Chosen'], "a person's genres were replaced");
      assert.equal(o?.author, 'Some Author');
    });

    await t.test('a source that fails is skipped and the next one is tried', async () => {
      const r = await fillMissingMeta(BROKEN);
      assert.deepEqual(r.from, [FOLLOW]);
      assert.ok(r.filled.includes('summary'));
    });

    await t.test('an unknown series is a quiet no-op, and the nightly pick lists only series that still lack something', async () => {
      assert.deepEqual(await fillMissingMeta('s_mf_nope'), { filled: [], from: [], tried: 0 });
      // Everything of ours has been filled by now; with one emptied again, only that one is picked.
      await q('DELETE FROM series_overrides WHERE series_id = $1', [EMPTY]);
      await q('DELETE FROM series_art WHERE series_id = $1', [EMPTY]);
      const mine = (await seriesMissingMeta(1000)).filter((id) => SERIES.includes(id));
      assert.deepEqual(mine, [EMPTY]);
    });
  } finally {
    await cleanup();
  }
});

test('the nightly repair pass and a manual follow both call it', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  assert.match(read('src/lib/repair.ts'), /step === 'directions'\) \{ await stepDirections\(r, log\); await stepMeta\(log\); \}/);
  assert.match(read('src/lib/repair.ts'), /if \(runtime\.stopping \|\| cancelled\(\)\) break;\n\s+const res = await fillMissingMeta\(id\);/, 'the step does not stop for a Cancel');
  assert.match(read('src/routes/admin.ts'), /void fillMissingMeta\(id\);\n\s+void updateSeries\(id, 0\)\.catch\(\(\) => \{\}\);\n\s+return \{ ok: true, sources: list \};/);
});
