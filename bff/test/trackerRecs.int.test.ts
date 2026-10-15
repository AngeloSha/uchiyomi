// Recommendations from connected trackers, and above all how few calls they make.
//
// The user's instruction for this feature was to avoid "wailing on" AniList and MyAnimeList, so most of what
// is asserted here is the request log: what a first visit costs, that the next visit costs nothing, that a
// second person sharing a favourite does not ask again, that a refusal is not retried by the next page view.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
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

type Call = { method: string; url: URL; body: any };
const calls: Call[] = [];
let route: (c: Call) => Response | null = () => null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init?: any) => {
  const url = new URL(String(u));
  if (!['graphql.anilist.co', 'api.myanimelist.net'].includes(url.hostname)) return realFetch(u, init);
  let body: any = null;
  if (typeof init?.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
  const c = { method: String(init?.method ?? 'GET').toUpperCase(), url, body };
  calls.push(c);
  return route(c) ?? new Response('unrouted', { status: 500 });
}) as typeof fetch;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const reset = (r: typeof route) => { calls.length = 0; route = r; };

const med = (id: number, english: string, over: Record<string, unknown> = {}) =>
  ({ id, idMal: id + 1000, type: 'MANGA', format: 'MANGA', isAdult: false, averageScore: 80, siteUrl: `https://anilist.co/manga/${id}`,
     title: { romaji: english, english }, synonyms: [], coverImage: { large: `https://img/${id}.jpg` }, ...over });
const listEntry = (id: number, status: string, progress: number, score: number, title: string) =>
  ({ mediaId: id, status, progress, score, media: { id, format: 'MANGA', title: { romaji: title, english: title }, synonyms: [] } });

const MY_LIST = [
  listEntry(1, 'COMPLETED', 300, 10, 'Berserk'),
  listEntry(2, 'COMPLETED', 100, 8, 'Vinland Saga'),
  listEntry(3, 'DROPPED', 5, 3, 'Dropped Thing'),
  listEntry(4, 'PLANNING', 0, 0, 'Planned Thing'),
];
// What AniList says people read after the two seeds.
const RECS: Record<number, any[]> = {
  1: [
    { rating: 40, mediaRecommendation: med(10, 'Vagabond') },
    { rating: 30, mediaRecommendation: med(11, 'Monster') },
    { rating: 25, mediaRecommendation: med(2, 'Vinland Saga') },            // already read
    { rating: 20, mediaRecommendation: med(4, 'Planned Thing') },           // already planned
    { rating: 15, mediaRecommendation: med(12, 'Library Owns This') },      // in the library
    { rating: 12, mediaRecommendation: med(13, 'Spicy One', { isAdult: true }) },
    { rating: -3, mediaRecommendation: med(14, 'Downvoted') },
    { rating: 9, mediaRecommendation: med(15, 'A Novel', { format: 'NOVEL' }) },
  ],
  2: [{ rating: 22, mediaRecommendation: med(11, 'Monster') }, { rating: 8, mediaRecommendation: med(16, 'Planetes') }],
};
const anilistRoute = (list = MY_LIST) => (c: Call) => {
  if (c.url.hostname !== 'graphql.anilist.co') return null;
  const q = String(c.body?.query ?? '');
  if (/Viewer/.test(q)) return json({ data: { Viewer: { id: 7, name: 'me' } } });
  if (/MediaListCollection/.test(q)) return json({ data: { MediaListCollection: { hasNextChunk: false, lists: [{ isCustomList: false, entries: list }] } } });
  if (/Media\(id:/.test(q)) {
    const data: Record<string, unknown> = {};
    for (const m of q.matchAll(/(m\d+): Media\(id:(\d+)/g)) data[m[1]] = { id: Number(m[2]), recommendations: { nodes: RECS[Number(m[2])] ?? [] } };
    return json({ data });
  }
  return json({ data: {} });
};

async function setup() {
  const { q } = await import('../src/lib/db');
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  const { seal } = await import('../src/lib/secretbox');
  const { resetRecsState } = await import('../src/lib/trackerRecs');
  resetRecsState();
  await q(`DELETE FROM tracker_rec_cache`);
  await q(`DELETE FROM users WHERE username LIKE 'recs-%'`);
  await q(`DELETE FROM lib_series WHERE id LIKE 's_recs_%'`);
  const mk = async (name: string) => {
    const r = await q(`INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$1,'x','user') RETURNING id`, [name]);
    return r[0].id as string;
  };
  const connect = (userId: string, provider: string) =>
    q(`INSERT INTO user_trackers (user_id, provider, access_token) VALUES ($1,$2,$3)`, [userId, provider, seal('tok')]);
  return { q, mk, connect };
}

const noLib = async () => new Set<string>();

test('first visit: one list read and ONE batched recommendation call; read, planned and owned titles are left out', { skip }, async () => {
  const { q, mk, connect } = await setup();
  const { recommendationsFor } = await import('../src/lib/trackerRecs');
  const { libraryIndex, heldFor } = await import('../src/lib/discoverIdentity');
  const { normTitle } = await import('../src/lib/trackerProviders');
  const u = await mk('recs-a');
  await connect(u, 'anilist');
  await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ('s_recs_1','test','Library Owns This','s_recs_1')`);
  reset(anilistRoute());

  const a = await recommendationsFor(u, { restrictAdult: false, inLibrary: async (titles) => {
    // What the route asks of Discover's index: a name the library holds, as a name or as the same work.
    const idx = await libraryIndex();
    return new Set(titles.filter((t) => heldFor(idx, { source: '', sourceId: '', title: t }).length).map(normTitle));
  } });
  const titles = a.content.map((r) => r.title);
  // Reintroduce by not excluding the person's own list (or by checking only some statuses).
  assert.deepEqual(titles.sort(), ['Monster', 'Planetes', 'Spicy One', 'Vagabond']);
  assert.ok(!titles.includes('Downvoted'), 'a pairing readers voted down is not suggested');
  assert.ok(!titles.includes('A Novel'));
  assert.ok(!titles.includes('Library Owns This'), 'the library already has it');
  const monster = a.content.find((r) => r.title === 'Monster')!;
  assert.deepEqual(monster.sources.map((s) => [s.provider, s.label, s.because]), [['anilist', 'AniList', 'Berserk']]);
  assert.equal(monster.cover, 'https://img/11.jpg');
  assert.deepEqual(a.sources, [{ provider: 'anilist', label: 'AniList', listed: 4, seeds: 2 }]);
  assert.equal(a.pending, false);

  // Viewer, list, and one aliased recommendation query for both seeds: three requests, not five.
  const recCalls = calls.filter((c) => /Media\(id:/.test(c.body?.query));
  assert.equal(recCalls.length, 1, 'both seeds are asked for in ONE request');
  assert.equal(calls.length, 3);
  assert.ok(!recCalls[0].body.query.includes('Dropped') && !/Media\(id:3/.test(recCalls[0].body.query), 'a disliked or dropped title does not seed');

  // Adult is shown to a viewer who has not asked to hide it, and withheld from one who has.
  const hidden = await recommendationsFor(u, { restrictAdult: true, inLibrary: noLib });
  assert.ok(!hidden.content.some((r) => r.title === 'Spicy One'));
  assert.equal(calls.length, 3, 'the second visit, with a different filter, made no request at all');
});

test('the next visit costs nothing, and a second person with the same favourite does not ask for it again', { skip }, async () => {
  const { mk, connect } = await setup();
  const { recommendationsFor } = await import('../src/lib/trackerRecs');
  const a = await mk('recs-a'); const b = await mk('recs-b');
  await connect(a, 'anilist'); await connect(b, 'anilist');
  reset(anilistRoute());
  await recommendationsFor(a, { restrictAdult: false, inLibrary: noLib });
  const first = calls.length;
  await recommendationsFor(a, { restrictAdult: false, inLibrary: noLib });
  await recommendationsFor(a, { restrictAdult: false, inLibrary: noLib });
  // Reintroduce by skipping the list cache: every page view reads the person's whole list again.
  assert.equal(calls.length, first, 'repeat visits are served from the caches');

  const before = calls.length;
  const second = await recommendationsFor(b, { restrictAdult: false, inLibrary: noLib });
  assert.ok(second.content.length > 0);
  const added = calls.slice(before);
  // Reintroduce by keying the recommendation cache per person: the seeds are asked for a second time.
  assert.equal(added.filter((c) => /Media\(id:/.test(c.body?.query)).length, 0, 'what readers recommend after a title is cached for everyone');
  assert.equal(added.filter((c) => /MediaListCollection/.test(c.body?.query)).length, 1, 'only their own list is read');
});

test('visits while a refresh runs join it instead of starting another', { skip }, async () => {
  const { mk, connect } = await setup();
  const { recommendationsFor } = await import('../src/lib/trackerRecs');
  const u = await mk('recs-a');
  await connect(u, 'anilist');
  reset(anilistRoute());
  const opts = { restrictAdult: false, inLibrary: noLib };
  const all = await Promise.all([recommendationsFor(u, opts), recommendationsFor(u, opts), recommendationsFor(u, opts)]);
  assert.ok(all.every((r) => r.content.length > 0));
  assert.equal(calls.filter((c) => /MediaListCollection/.test(c.body?.query)).length, 1);
  assert.equal(calls.filter((c) => /Media\(id:/.test(c.body?.query)).length, 1);
});

test('a refusal puts the service in a cooldown; the next visit does not ask, and old answers keep being served', { skip }, async () => {
  const { q, mk, connect } = await setup();
  const { recommendationsFor, LIST_TTL_MS } = await import('../src/lib/trackerRecs');
  const u = await mk('recs-a');
  await connect(u, 'anilist');
  reset(anilistRoute());
  const opts = { restrictAdult: false, inLibrary: noLib };
  const warm = await recommendationsFor(u, opts);
  assert.ok(warm.content.length > 0);

  // The list goes stale and AniList answers 429.
  await q(`UPDATE tracker_list_cache SET fetched_at = now() - ($2 || ' milliseconds')::interval WHERE user_id = $1`, [u, String(LIST_TTL_MS + 1000)]);
  reset((c) => (c.url.hostname === 'graphql.anilist.co' ? (/Viewer/.test(c.body?.query) ? json({ data: { Viewer: { id: 7, name: 'me' } } }) : new Response('slow down', { status: 429 })) : null));
  const stale = await recommendationsFor(u, opts);
  assert.deepEqual(stale.content.map((r) => r.title), warm.content.map((r) => r.title), 'the stale list and cached recommendations still answer');
  const n = calls.length;
  assert.ok(n >= 1 && n <= 2, `one failed attempt, not a retry loop (${n})`);

  await recommendationsFor(u, opts);
  await recommendationsFor(u, opts);
  // Reintroduce by dropping the cooldown: every page view re-sends the request that was refused.
  assert.equal(calls.length, n, 'a service that said no is left alone for a while');
  const ok = await q(`SELECT enabled FROM user_trackers WHERE user_id = $1`, [u]);
  assert.equal(ok[0].enabled, true, 'a rate limit does not switch the connection off');
});

test('a rejected token switches the connection off and shows nothing from it', { skip }, async () => {
  const { q, mk, connect } = await setup();
  const { recommendationsFor } = await import('../src/lib/trackerRecs');
  const u = await mk('recs-a');
  await connect(u, 'anilist');
  reset((c) => (c.url.hostname === 'graphql.anilist.co' ? new Response(JSON.stringify({ errors: [{ message: 'Invalid token' }] }), { status: 400 }) : null));
  const a = await recommendationsFor(u, { restrictAdult: false, inLibrary: noLib });
  assert.deepEqual(a.content, []);
  assert.equal((await q(`SELECT enabled FROM user_trackers WHERE user_id = $1`, [u]))[0].enabled, false);
});

test('MyAnimeList: one list read for every status, one call per seed, one AniList call fills in age rating', { skip }, async () => {
  const { q, mk, connect } = await setup();
  const { recommendationsFor } = await import('../src/lib/trackerRecs');
  const u = await mk('recs-a');
  await connect(u, 'myanimelist');
  const node = (id: number, title: string) => ({ id, title, alternative_titles: { en: '', synonyms: [] }, media_type: 'manga' });
  reset((c) => {
    if (c.url.hostname === 'api.myanimelist.net') {
      if (c.url.pathname.endsWith('/users/@me/mangalist')) {
        return json({ data: [
          { node: node(2, 'Berserk'), list_status: { status: 'completed', score: 10, num_chapters_read: 364 } },
          { node: node(3, 'Vagabond'), list_status: { status: 'reading', score: 9, num_chapters_read: 200 } },
          { node: node(4, 'Dropped'), list_status: { status: 'dropped', score: 2, num_chapters_read: 1 } },
        ] });
      }
      const m = c.url.pathname.match(/\/manga\/(\d+)$/);
      if (m) {
        return json({ id: Number(m[1]), recommendations: [
          { node: { id: 100, title: 'Monster', main_picture: { large: 'https://mal/100.jpg' } }, num_recommendations: 12 },
          { node: { id: 3, title: 'Vagabond', main_picture: { large: 'https://mal/3.jpg' } }, num_recommendations: 9 },
          { node: { id: 101, title: 'Mystery Title', main_picture: { medium: 'https://mal/101.jpg' } }, num_recommendations: 2 },
        ] });
      }
    }
    if (c.url.hostname === 'graphql.anilist.co' && /idMal_in/.test(c.body?.query)) {
      return json({ data: { Page: { media: [med(900, 'Monster', { idMal: 100, title: { romaji: 'Monster', english: 'Monster' } })] } } });
    }
    return null;
  });
  const a = await recommendationsFor(u, { restrictAdult: false, inLibrary: noLib, waitMs: 30_000 });
  const mal = calls.filter((c) => c.url.hostname === 'api.myanimelist.net');
  const lists = mal.filter((c) => c.url.pathname.endsWith('/mangalist'));
  // Reintroduce by one request per status: five reads of the same list.
  assert.equal(lists.length, 1, 'the whole list is one paged read, with no status filter');
  assert.equal(lists[0].url.searchParams.get('status'), null);
  assert.equal(mal.filter((c) => /\/manga\/\d+$/.test(c.url.pathname)).length, 2, 'one call per seed (Berserk and Vagabond; the dropped title is not a seed)');
  assert.equal(calls.filter((c) => /idMal_in/.test(c.body?.query)).length, 1, 'age ratings for all of it in one AniList call');
  assert.deepEqual(a.content.map((r) => r.title).sort(), ['Monster', 'Mystery Title'], 'Vagabond is on the list, so it is not suggested');
  const monster = a.content.find((r) => r.title === 'Monster')!;
  assert.equal(monster.sources[0].because, 'Berserk', 'the seed with the higher rating leads');
  // The unknown-rating title is shown to an unrestricted viewer only, and from the cache: no new calls.
  const n = calls.length;
  const safe = await recommendationsFor(u, { restrictAdult: true, inLibrary: noLib });
  assert.deepEqual(safe.content.map((r) => r.title), ['Monster']);
  assert.equal(calls.length, n);
});
