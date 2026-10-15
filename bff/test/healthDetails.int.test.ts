// A missing description is only a finding when the series' source gives descriptions to other series.
// Skipped automatically unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}

test('a series without a description is flagged only if its source describes other series', { skip: !DSN }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { seriesDetails } = await import('../src/lib/healthMore');
  await migrate();
  const ids = ['sd_a1', 'sd_a2', 'sd_b1', 'sd_b2'];
  await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [ids]);
  const add = (id: string, src: string, summary: string | null) =>
    q(`INSERT INTO lib_series (id, source, title, folder, source_id, summary, genres, author)
       VALUES ($1,'test',$1,$1,$2,$3,ARRAY['x'],'someone')`, [id, src, summary]);
  await add('sd_a1', 'sw:detA', 'has one');
  await add('sd_a2', 'sw:detA', null);
  await add('sd_b1', 'sw:detB', null);
  await add('sd_b2', 'sw:detB', '   ');

  const flagged = new Set((await seriesDetails()).items.map((i) => i.seriesId));
  assert.equal(flagged.has('sd_a2'), true);
  assert.equal(flagged.has('sd_a1'), false);
  assert.equal(flagged.has('sd_b1'), false);
  assert.equal(flagged.has('sd_b2'), false);
  await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [ids]);
});
