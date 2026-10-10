// Outside ratings, popularity and the owner's new Library sorts (v0.58.0, lib/anilistScores.ts).
//
// The owner: a series rating "from somewhere else as well, but also keep the one where we rate it", sorting by
// popularity in the Library and on Home, and by how many chapters, "etc." -- Most popular, Top rated, My rating, Most
// chapters, Recently read. AniList answers through a scripted fetch; the Library and Home through the real routes.
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

const ON = 'lib_sc_on', OFF = 'lib_sc_off';
/** id, title, library, AniList id, link checked?, chapters. */
const SERIES: Array<[string, string, string, string | null, boolean, number]> = [
  ['s_sc_big', 'Sc Big', ON, '101', true, 3],
  ['s_sc_mean', 'Sc Mean', ON, '102', true, 5],
  ['s_sc_unchecked', 'Sc Unchecked', ON, '103', false, 1],
  ['s_sc_off', 'Sc Off', OFF, '104', true, 2],
  ['s_sc_gone', 'Sc Gone', ON, '105', true, 4],
  ['s_sc_none', 'Sc None', ON, null, false, 6],
];
const IDS = SERIES.map((s) => s[0]);
/** What the fake AniList knows: averageScore, meanScore, popularity. 105 it no longer has. */
const MEDIA: Record<number, { averageScore: number | null; meanScore: number | null; popularity: number }> = {
  101: { averageScore: 84, meanScore: 85, popularity: 312000 },
  102: { averageScore: null, meanScore: 70, popularity: 5000 },
  103: { averageScore: 99, meanScore: 99, popularity: 999999 },
  104: { averageScore: 90, meanScore: 90, popularity: 800000 },
};
const asked: number[][] = [];
const realFetch = globalThis.fetch;

let q: any, scores: typeof import('../src/lib/anilistScores'), app: any, user = '';
const H: Record<string, string> = {};

before(async () => {
  if (!DSN) return;
  globalThis.fetch = (async (u: any, init?: any) => {
    if (String(u).includes('graphql.anilist.co')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (!String(body.query).includes('popularity')) return new Response('{}', { status: 503 });
      const ids: number[] = body.variables?.ids ?? [];
      asked.push(ids);
      return new Response(JSON.stringify({ data: { Page: { media: ids.filter((id) => MEDIA[id]).map((id) => ({ id, ...MEDIA[id] })) } } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(u, init);
  }) as typeof fetch;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  scores = await import('../src/lib/anilistScores');
  await migrate();
  await q(`DELETE FROM users WHERE username = 'sc_reader'`);
  user = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms)
                    VALUES ('sc_reader', 'sc_reader', 'x', 'user', 'password', '{}') RETURNING id`))[0].id;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/personal')).default);
  await app.ready();
  H.authorization = `Bearer ${app.jwt.sign({ sub: user, role: 'user' })}`;
});

beforeEach(async () => {
  if (!DSN) return;
  asked.length = 0;
  for (const t of ['read_progress', 'ratings', 'series_trackers']) await q(`DELETE FROM ${t} WHERE series_id = ANY($1)`, [IDS]);
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [IDS]);
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [IDS]);
  await q('DELETE FROM anilist_scores');
  await q(`INSERT INTO libraries (id, name, path, anilist_lookup) VALUES ($1, 'Sc on', '/sc-on', true), ($2, 'Sc off', '/sc-off', false)
           ON CONFLICT (id) DO UPDATE SET anilist_lookup = EXCLUDED.anilist_lookup`, [ON, OFF]);
  for (const [id, title, lib, al, checked, chapters] of SERIES) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id) VALUES ($1, 'T!sc', $2, $1, $3, $4)`, [id, title, chapters, lib]);
    for (let n = 1; n <= chapters; n++) {
      await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root) VALUES ($1, $2, 'T!sc', $3, $4, $5, '/library')`,
        [`b_${id}_${n}`, id, `T!sc/${id}/ch${n}.cbz`, n, `Chapter ${n}`]);
    }
    if (al) {
      await q(`INSERT INTO series_trackers (series_id, provider, external_id, checked_at) VALUES ($1, 'anilist', $2, $3)`,
        [id, al, checked ? new Date() : null]);
    }
  }
});

after(async () => {
  globalThis.fetch = realFetch;
  if (!DSN) return;
  for (const t of ['read_progress', 'ratings', 'series_trackers']) await q(`DELETE FROM ${t} WHERE series_id = ANY($1)`, [IDS]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [IDS]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [IDS]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[ON, OFF]]).catch(() => {});
  await q('DELETE FROM anilist_scores').catch(() => {});
  await q(`DELETE FROM users WHERE username = 'sc_reader'`).catch(() => {});
  await app?.close();
});

const rowsOf = async () => new Map((await q(`SELECT anilist_id, score, popularity FROM anilist_scores`))
  .map((r: any) => [r.anilist_id, { score: r.score == null ? null : Number(r.score), popularity: r.popularity == null ? null : Number(r.popularity) }]));

test('the refresh scores every series linked to its entry, in libraries that may ask, and nothing else', { skip }, async () => {
  const r = await scores.refreshAniListScores();
  // Reintroduce by asking for every link (drop the checked rule) or every library (drop anilist_lookup): 103 or 104 is asked.
  assert.deepEqual(asked.flat().sort(), [101, 102, 105], 'checked links only, in a library whose AniList lookups are on');
  assert.deepEqual(r, { asked: 3, stored: 2, missing: 1 });
  const rows = await rowsOf();
  assert.deepEqual(rows.get('101'), { score: 84, popularity: 312000 }, 'the weighted average');
  assert.deepEqual(rows.get('102'), { score: 70, popularity: 5000 }, 'its plain mean when AniList has no weighted average');
  assert.deepEqual(rows.get('105'), { score: null, popularity: null }, 'an entry AniList no longer answers for is kept empty');
  // A fresh row is not asked again; a stale one is.
  asked.length = 0;
  assert.equal((await scores.refreshAniListScores()).asked, 0, 'nothing is asked twice within three days');
  assert.equal((await scores.refreshAniListScores({ maxAgeMs: 0 })).asked, 3, 'a stale row is asked again');
});

test('each new sort orders the Library by its own value', { skip }, async () => {
  await scores.refreshAniListScores();
  await q(`INSERT INTO ratings (user_id, series_id, stars) VALUES ($1, 's_sc_mean', 5), ($1, 's_sc_none', 3)`, [user]);
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at)
           VALUES ($1, 'b_s_sc_off_1', 's_sc_off', 0, true, now() - interval '1 day'), ($1, 'b_s_sc_gone_1', 's_sc_gone', 3, false, now())`, [user]);
  const order = async (sort: string, collapseEditions = false) => {
    const r = await app.inject({ method: 'POST', url: '/api/series/search', headers: H, payload: { sort, size: 100, collapseEditions } });
    assert.equal(r.statusCode, 200, r.body);
    return (r.json().content as any[]).map((s) => s.id).filter((id: string) => IDS.includes(id));
  };
  // Reintroduce the fall-through (drop a branch in sortSql): each reads A-Z.
  for (const collapse of [false, true]) {
    assert.deepEqual((await order('popularity,desc', collapse)).slice(0, 2), ['s_sc_big', 's_sc_mean'], 'Most popular: the most listed first, unscored after');
    assert.deepEqual((await order('score,desc', collapse)).slice(0, 2), ['s_sc_big', 's_sc_mean'], 'Top rated');
    assert.deepEqual((await order('rating,desc', collapse)).slice(0, 2), ['s_sc_mean', 's_sc_none'], 'My rating: the viewer\'s own stars');
    assert.deepEqual(await order('chapters,desc', collapse), ['s_sc_none', 's_sc_mean', 's_sc_gone', 's_sc_big', 's_sc_off', 's_sc_unchecked'], 'Most chapters');
    assert.deepEqual((await order('lastRead,desc', collapse)).slice(0, 2), ['s_sc_gone', 's_sc_off'], 'Recently read: the latest first');
  }
  // An unscored series is never ahead of a scored one, whichever the direction.
  const asc = await order('popularity,asc');
  assert.deepEqual(asc.slice(0, 2), ['s_sc_mean', 's_sc_big'], 'ascending, the scored ones still lead');
});

test('every series says its outside rating and when it was last read, beside the viewer\'s own stars', { skip }, async () => {
  await scores.refreshAniListScores();
  await q(`INSERT INTO ratings (user_id, series_id, stars) VALUES ($1, 's_sc_big', 4)`, [user]);
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1, 'b_s_sc_big_1', 's_sc_big', 0, true)`, [user]);
  const r = await app.inject({ method: 'POST', url: '/api/series/search', headers: H, payload: { sort: 'score,desc', size: 100 } });
  const byId = new Map((r.json().content as any[]).map((s) => [s.id, s]));
  // Reintroduce by dropping the field in enrichSeries: undefined.
  assert.deepEqual(byId.get('s_sc_big').yomi.anilist, { score: 84, popularity: 312000 });
  assert.equal(byId.get('s_sc_big').yomi.rating, 4, 'the own rating is kept');
  assert.match(String(byId.get('s_sc_big').yomi.lastReadAt), /^\d{4}-\d\d-\d\dT/);
  assert.equal(byId.get('s_sc_unchecked').yomi.anilist, null, 'an unchecked link shows no outside rating');
  assert.equal(byId.get('s_sc_gone').yomi.anilist, null, 'nor an entry AniList did not answer for');
  assert.equal(byId.get('s_sc_none').yomi.lastReadAt, null);
});

test("Home's Most popular rail holds the scored series, most listed first", { skip }, async () => {
  await scores.refreshAniListScores();
  const r = await app.inject({ method: 'GET', url: '/api/home', headers: H });
  assert.equal(r.statusCode, 200, r.body);
  const ids = (r.json().popular as any[]).map((s) => s.id).filter((id: string) => IDS.includes(id));
  // Reintroduce the plain order (drop the IS NOT NULL in seriesPopular): the unscored series join the rail.
  assert.deepEqual(ids, ['s_sc_big', 's_sc_mean']);
  assert.equal((r.json().popular as any[]).find((s) => s.id === 's_sc_big').yomi.anilist.score, 84, 'enriched like every rail');
});

test("the Library's saved sort takes the new ones", { skip }, async () => {
  for (const sort of ['popular', 'score', 'rating', 'chapters', 'read']) {
    const r = await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { librarySort: sort } });
    // Reintroduce the four-value enum: 400 and the chip rolls back.
    assert.equal(r.statusCode, 200, `${sort}: ${r.body}`);
  }
  const bad = await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { librarySort: 'oldest' } });
  assert.equal(bad.statusCode, 400);
});
