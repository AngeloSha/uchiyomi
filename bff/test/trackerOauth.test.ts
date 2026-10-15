// What is fixed about how each tracker connects: AniList by the implicit grant, MyAnimeList by the code flow, anything
// else by a pasted token. (The parts that read the saved application are in trackerOauth.int.test.ts; they need Postgres.)
import test from 'node:test';
import assert from 'node:assert/strict';

// Loading the module loads the database client, whose settings are checked at import; nothing here queries.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@localhost:1/unused';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';

test('each tracker has one way of signing in', async () => {
  const { METHOD } = await import('../src/lib/trackerOauth');
  assert.deepEqual(METHOD, { anilist: 'oauth-implicit', myanimelist: 'oauth-code' });
});

