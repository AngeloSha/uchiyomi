// The art backfill (Admin → Content → Art) also fills a description and genres from Kitsu / MangaUpdates, only where the
// series has none, and into series_overrides: the layer a scan never overwrites. Skipped unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(String(input?.url ?? input));
  if (url.host === 'graphql.anilist.co') return Response.json({ data: { Media: null } });
  if (url.hostname === 'kitsu.io') {
    return Response.json({
      data: [{ id: '1', attributes: { canonicalTitle: 'Tmh Ghost Boy', titles: {}, abbreviatedTitles: [], synopsis: 'From Kitsu.', posterImage: { large: 'https://img.invalid/p.jpg' } },
        relationships: { categories: { data: [{ id: 'c1' }] } } }],
      included: [{ type: 'categories', id: 'c1', attributes: { title: 'Horror' } }],
    });
  }
  if (url.hostname === 'api.mangaupdates.com') return new Response('{}', { status: 404 });
  return realFetch(input, init);
}) as typeof fetch;

test('the art backfill fills a missing description and genres from Kitsu, and leaves what a series has', { skip }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const { huntArt } = await import('../src/routes/admin');
  await migrate();
  const ids = ['tmh-empty', 'tmh-has'];
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [ids]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, summary, genres) VALUES
           ('tmh-empty','T!tmh','Tmh Ghost Boy','tmh-empty',1,NULL,'{}'),
           ('tmh-has','T!tmh','Tmh Ghost Boy','tmh-has',1,'Its own summary.','{Drama}')`);
  try {
    assert.equal(await huntArt({ id: 'tmh-empty', title: 'Tmh Ghost Boy' }), 'cover', 'the Kitsu poster stands in as the cover');
    const o = await one<{ summary: string | null; genres: string[] | null }>('SELECT summary, genres FROM series_overrides WHERE series_id = $1', ['tmh-empty']);
    assert.equal(o?.summary, 'From Kitsu.');
    assert.deepEqual(o?.genres, ['Horror']);

    await huntArt({ id: 'tmh-has', title: 'Tmh Ghost Boy' });
    const kept = await one<{ summary: string | null; genres: string[] | null }>('SELECT summary, genres FROM series_overrides WHERE series_id = $1', ['tmh-has']);
    assert.equal(kept?.summary ?? null, null, 'a series with its own description gets no override');
    assert.ok(!kept?.genres?.length, 'a series with its own genres gets no override');
  } finally {
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [ids]).catch(() => {});
  }
});
