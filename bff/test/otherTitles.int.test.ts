// A series' English / romanised / Japanese titles (lib/otherTitles.ts, GET /api/series/:id/other-titles): asked from the
// AniList entry the series is linked to, kept in series_other_titles, asked again after a month (a day when empty), and
// never asked for a series with no checked link or in a library whose AniList lookups are off. AniList is a scripted fetch.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const ON = 'lib_ot_on', OFF = 'lib_ot_off';
/** id, library, AniList id, link checked? */
const SERIES: Array<[string, string, string | null, boolean]> = [
  ['s_ot_named', ON, '201', true],
  ['s_ot_empty', ON, '202', true],
  ['s_ot_unchecked', ON, '203', false],
  ['s_ot_off', OFF, '204', true],
  ['s_ot_nolink', ON, null, false],
];
const IDS = SERIES.map((s) => s[0]);
const TITLES: Record<number, { romaji: string | null; english: string | null; native: string | null }> = {
  201: { romaji: 'Sousou no Frieren', english: 'Frieren: Beyond Journey’s End', native: '葬送のフリーレン' },
  202: { romaji: null, english: null, native: null },
};
let asked: number[] = [];
let mode: 'ok' | 'busy' | 'down' = 'ok';
const realFetch = globalThis.fetch;

let q: any, ot: typeof import('../src/lib/otherTitles'), app: any, user = '';
const H: Record<string, string> = {};

before(async () => {
  if (!DSN) return;
  globalThis.fetch = (async (u: any, init?: any) => {
    if (String(u).includes('graphql.anilist.co')) {
      const id = JSON.parse(String(init?.body ?? '{}')).variables?.id as number;
      asked.push(id);
      if (mode === 'down') return new Response('{}', { status: 503 });
      return new Response(JSON.stringify({ data: { Media: TITLES[id] ? { title: TITLES[id] } : null } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(u, init);
  }) as typeof fetch;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ot = await import('../src/lib/otherTitles');
  await migrate();
  await q(`DELETE FROM users WHERE username = 'ot_reader'`);
  user = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms)
                    VALUES ('ot_reader', 'ot_reader', 'x', 'user', 'password', '{}') RETURNING id`))[0].id;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/catalog')).default);
  await app.ready();
  H.authorization = `Bearer ${app.jwt.sign({ sub: user, role: 'user' })}`;
});

beforeEach(async () => {
  if (!DSN) return;
  asked = [];
  mode = 'ok';
  (await import('../src/lib/anilistLimit')).resetAniListQuota();
  await q('DELETE FROM series_other_titles WHERE series_id = ANY($1)', [IDS]);
  await q('DELETE FROM series_trackers WHERE series_id = ANY($1)', [IDS]);
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [IDS]);
  await q(`INSERT INTO libraries (id, name, path, anilist_lookup) VALUES ($1, 'Ot on', '/ot-on', true), ($2, 'Ot off', '/ot-off', false)
           ON CONFLICT (id) DO UPDATE SET anilist_lookup = EXCLUDED.anilist_lookup`, [ON, OFF]);
  for (const [id, lib, al, checked] of SERIES) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id) VALUES ($1, 'T!ot', $1, $1, 0, $2)`, [id, lib]);
    if (al) await q(`INSERT INTO series_trackers (series_id, provider, external_id, checked_at) VALUES ($1, 'anilist', $2, $3)`, [id, al, checked ? new Date() : null]);
  }
});

after(async () => {
  globalThis.fetch = realFetch;
  if (!DSN) return;
  await q('DELETE FROM series_other_titles WHERE series_id = ANY($1)', [IDS]).catch(() => {});
  await q('DELETE FROM series_trackers WHERE series_id = ANY($1)', [IDS]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [IDS]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[ON, OFF]]).catch(() => {});
  await q(`DELETE FROM users WHERE username = 'ot_reader'`).catch(() => {});
  await app?.close();
});

const get = async (id: string) => (await app.inject({ method: 'GET', url: `/api/series/${id}/other-titles`, headers: H })).json();
const age = (id: string, ms: number) => q(`UPDATE series_other_titles SET fetched_at = now() - ($2 || ' milliseconds')::interval WHERE series_id = $1`, [id, String(ms)]);

test('asks AniList once, keeps the three names, and answers the second read from the table', { skip }, async () => {
  const a = await get('s_ot_named');
  assert.deepEqual(a, { titles: { english: 'Frieren: Beyond Journey’s End', romaji: 'Sousou no Frieren', native: '葬送のフリーレン' } });
  const b = await get('s_ot_named');
  assert.deepEqual(b, a);
  assert.deepEqual(asked, [201]);
  assert.equal((await q('SELECT count(*)::int AS n FROM series_other_titles WHERE series_id = $1', ['s_ot_named']))[0].n, 1);
});

test('no checked link, a library with lookups off, or no link at all: null, and AniList is not asked', { skip }, async () => {
  for (const id of ['s_ot_unchecked', 's_ot_off', 's_ot_nolink']) assert.deepEqual(await get(id), { titles: null }, id);
  assert.deepEqual(asked, []);
  assert.equal((await q('SELECT count(*)::int AS n FROM series_other_titles WHERE series_id = ANY($1)', [IDS]))[0].n, 0);
});

test('correcting an AniList link never reuses the previous entry\'s cached titles', { skip }, async () => {
  await get('s_ot_named');
  await q("UPDATE series_trackers SET external_id = '202' WHERE series_id = 's_ot_named' AND provider = 'anilist'");
  assert.deepEqual(await get('s_ot_named'), { titles: null });
  assert.deepEqual(asked, [201, 202]);
  await q("UPDATE series_trackers SET external_id = '201' WHERE series_id = 's_ot_named' AND provider = 'anilist'");
  mode = 'down';
  assert.deepEqual(await get('s_ot_named'), { titles: null }, 'a failed lookup cannot fall back to another work\'s names');
});

test('a month for an answer with names, a day for an empty one', { skip }, async () => {
  await get('s_ot_named'); await get('s_ot_empty');
  assert.deepEqual(asked, [201, 202]);
  const DAY = 24 * 3600_000;
  await age('s_ot_named', 29 * DAY); await age('s_ot_empty', DAY - 3600_000);
  await get('s_ot_named'); await get('s_ot_empty');
  assert.equal(asked.length, 2, 'both still fresh');
  await age('s_ot_named', 31 * DAY); await age('s_ot_empty', DAY + 3600_000);
  await get('s_ot_named'); await get('s_ot_empty');
  assert.deepEqual(asked, [201, 202, 201, 202], 'both asked again');
});

test('an entry with no names is kept as such and answers null', { skip }, async () => {
  assert.deepEqual(await get('s_ot_empty'), { titles: null });
  const row = (await q('SELECT english, romaji, native FROM series_other_titles WHERE series_id = $1', ['s_ot_empty']))[0];
  assert.deepEqual(row, { english: null, romaji: null, native: null });
});

test('AniList down: the kept names are answered, and nothing is overwritten; with none kept, null and nothing stored', { skip }, async () => {
  await get('s_ot_named');
  await age('s_ot_named', 40 * 24 * 3600_000);
  mode = 'down';
  assert.equal((await get('s_ot_named')).titles.romaji, 'Sousou no Frieren');
  assert.equal((await q('SELECT count(*)::int AS n FROM series_other_titles WHERE series_id = $1 AND romaji IS NOT NULL', ['s_ot_named']))[0].n, 1);
  assert.deepEqual(await get('s_ot_empty'), { titles: null });
  assert.equal((await q('SELECT count(*)::int AS n FROM series_other_titles WHERE series_id = $1', ['s_ot_empty']))[0].n, 0, 'a failure is not an answer');
});

test('an unknown series is a 404; deleting a series deletes its names', { skip }, async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/series/s_ot_nope/other-titles', headers: H })).statusCode, 404);
  await get('s_ot_named');
  await q('DELETE FROM series_trackers WHERE series_id = $1', ['s_ot_named']);
  await q('DELETE FROM lib_series WHERE id = $1', ['s_ot_named']);
  assert.equal((await q('SELECT count(*)::int AS n FROM series_other_titles WHERE series_id = $1', ['s_ot_named']))[0].n, 0);
});
