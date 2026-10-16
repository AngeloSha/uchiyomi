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
  ({ mediaId: id, status, progress, score, media: { id, format: 'MANGA', isAdult: false, genres: [], title: { romaji: title, english: title }, synonyms: [] } });

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

const lib = (id: string, lookup = true) =>
  import('../src/lib/db').then(({ q }) => q(`INSERT INTO libraries (id, name, path, anilist_lookup) VALUES ($1,$1,$1,$2)
    ON CONFLICT (id) DO UPDATE SET anilist_lookup = $2`, [id, lookup]));

async function setup() {
  const { q } = await import('../src/lib/db');
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  const { seal } = await import('../src/lib/secretbox');
  const { resetRecsState } = await import('../src/lib/trackerRecs');
  resetRecsState();
  // The server's one AniList quota (v0.73.0, lib/anilistLimit.ts) remembers a 429 for a minute; each case starts as a
  // fresh process would, or the 429 one case scripts holds every later case's AniList calls.
  (await import('../src/lib/anilistLimit')).resetAniListQuota();
  await q(`DELETE FROM tracker_rec_cache`);
  await q(`DELETE FROM users WHERE username LIKE 'recs-%'`);
  await q(`DELETE FROM lib_series WHERE id LIKE 's_recs_%'`);
  await q(`DELETE FROM libraries WHERE id LIKE 'lib_recs_%'`);
  const mk = async (name: string) => {
    const r = await q(`INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$1,'x','user') RETURNING id`, [name]);
    return r[0].id as string;
  };
  const connect = (userId: string, provider: string) =>
    q(`INSERT INTO user_trackers (user_id, provider, access_token) VALUES ($1,$2,$3)`, [userId, provider, seal('tok')]);
  return { q, mk, connect };
}

const noLib = async () => new Set<string>();
/** The viewer as the route builds it (lib/visibility.ts viewCtxFor): open, hiding 18+, or capped below it. */
const OPEN = (userId: string) => ({ userId, libraryIds: null, maxAgeRating: null, hideAdultLibraries: false, adultGenres: [] as string[], adultSources: [] as string[] });
const HIDING = (userId: string, adultGenres: string[] = []) => ({ ...OPEN(userId), hideAdultLibraries: true, adultGenres });
const CAPPED = (userId: string) => ({ ...OPEN(userId), maxAgeRating: 13 });

test('first visit: one list read and ONE batched recommendation call; read, planned and owned titles are left out', { skip }, async () => {
  const { q, mk, connect } = await setup();
  const { recommendationsFor } = await import('../src/lib/trackerRecs');
  const { libraryIndex, heldFor } = await import('../src/lib/discoverIdentity');
  const { normTitle } = await import('../src/lib/trackerProviders');
  const u = await mk('recs-a');
  await connect(u, 'anilist');
  await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ('s_recs_1','test','Library Owns This','s_recs_1')`);
  reset(anilistRoute());

  const a = await recommendationsFor(u, { ctx: OPEN(u), inLibrary: async (titles) => {
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
  const hidden = await recommendationsFor(u, { ctx: HIDING(u), inLibrary: noLib });
  assert.ok(hidden.content.length > 0, 'the premise: a viewer hiding 18+ still gets the all-ages suggestions');
  assert.ok(!hidden.content.some((r) => r.title === 'Spicy One'));
  assert.equal(calls.length, 3, 'the second visit, with a different filter, made no request at all');
});

test('the next visit costs nothing, and a second person with the same favourite does not ask for it again', { skip }, async () => {
  const { mk, connect } = await setup();
  const { recommendationsFor } = await import('../src/lib/trackerRecs');
  const a = await mk('recs-a'); const b = await mk('recs-b');
  await connect(a, 'anilist'); await connect(b, 'anilist');
  reset(anilistRoute());
  await recommendationsFor(a, { ctx: OPEN(a), inLibrary: noLib });
  const first = calls.length;
  await recommendationsFor(a, { ctx: OPEN(a), inLibrary: noLib });
  await recommendationsFor(a, { ctx: OPEN(a), inLibrary: noLib });
  // Reintroduce by skipping the list cache: every page view reads the person's whole list again.
  assert.equal(calls.length, first, 'repeat visits are served from the caches');

  const before = calls.length;
  const second = await recommendationsFor(b, { ctx: OPEN(b), inLibrary: noLib });
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
  const opts = { ctx: OPEN(u), inLibrary: noLib };
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
  const opts = { ctx: OPEN(u), inLibrary: noLib };
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
  const a = await recommendationsFor(u, { ctx: OPEN(u), inLibrary: noLib });
  assert.deepEqual(a.content, []);
  assert.equal((await q(`SELECT enabled FROM user_trackers WHERE user_id = $1`, [u]))[0].enabled, false);
});

test('MyAnimeList: one list read for every status, one call per seed, one AniList call fills in age rating', { skip }, async () => {
  const { q, mk, connect } = await setup();
  const { recommendationsFor } = await import('../src/lib/trackerRecs');
  const u = await mk('recs-a');
  await connect(u, 'myanimelist');
  const node = (id: number, title: string) => ({ id, title, alternative_titles: { en: '', synonyms: [] }, media_type: 'manga', nsfw: 'white' });
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
  const a = await recommendationsFor(u, { ctx: OPEN(u), inLibrary: noLib, waitMs: 30_000 });
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
  const safe = await recommendationsFor(u, { ctx: HIDING(u), inLibrary: noLib });
  assert.deepEqual(safe.content.map((r) => r.title), ['Monster']);
  assert.equal(calls.length, n);
});

// ---- the viewer (#248 review): each item and each seed judged as Discover judges them, and the library's series only
// when this viewer may browse them.

test('an account capped below 18 is neither shown adult work nor told an adult title it read', { skip }, async () => {
  // The capped member's own AniList list holds an adults-only title they rated 10: it must not be named back to them
  // ("Because you read …"), nor seed. Reintroduce the unjudged seeds: the capped answer names "Adult Seed".
  const { mk, connect } = await setup();
  const { recommendationsFor } = await import('../src/lib/trackerRecs');
  const u = await mk('recs-a');
  await connect(u, 'anilist');
  const adultSeed = { ...listEntry(20, 'COMPLETED', 200, 10, 'Adult Seed'), media: { id: 20, format: 'MANGA', isAdult: true, genres: [], title: { romaji: 'Adult Seed', english: 'Adult Seed' }, synonyms: [] } };
  RECS[20] = [{ rating: 50, mediaRecommendation: med(21, 'After The Adult Seed') }];
  reset(anilistRoute([...MY_LIST, adultSeed]));
  const capped = await recommendationsFor(u, { ctx: CAPPED(u), inLibrary: noLib });
  assert.ok(capped.content.length > 0, 'the premise: the capped member still gets all-ages suggestions');
  assert.ok(!capped.content.some((r) => r.sources.some((x) => x.because === 'Adult Seed')), 'an adult seed was named to a capped account');
  assert.ok(!capped.content.some((r) => r.title === 'Spicy One'), 'an adult suggestion was shown to a capped account');
  assert.ok(!calls.some((c) => /Media\(id:20/.test(c.body?.query ?? '')), 'the adult seed was asked about for a capped account');
  // The premise, the other way round: an open viewer's seeds include it.
  const open = await recommendationsFor(u, { ctx: OPEN(u), inLibrary: noLib });
  assert.ok(open.content.some((r) => r.sources.some((x) => x.because === 'Adult Seed')), 'the premise: an open viewer is told it');
  delete RECS[20];
});

test('a viewer hiding 18+ is not shown a title in a genre the admin named adult', { skip }, async () => {
  // The rule every Discover rail applies (lib/anilistRelated.ts adultOk). #248 as opened passed one boolean and never
  // read the admin's genres. Reintroduce it: "Genre Tagged" shows to the viewer hiding 18+.
  const { mk, connect } = await setup();
  const { recommendationsFor } = await import('../src/lib/trackerRecs');
  const u = await mk('recs-a');
  await connect(u, 'anilist');
  const was = RECS[1];
  RECS[1] = [...was, { rating: 35, mediaRecommendation: med(17, 'Genre Tagged', { genres: ['Ecchi'] }) }];
  try {
    reset(anilistRoute());
    const open = await recommendationsFor(u, { ctx: OPEN(u), inLibrary: noLib });
    assert.ok(open.content.some((r) => r.title === 'Genre Tagged'), 'the premise: it is all-ages to AniList, and an open viewer sees it');
    const plain = await recommendationsFor(u, { ctx: HIDING(u, []), inLibrary: noLib });
    assert.ok(plain.content.some((r) => r.title === 'Genre Tagged'), 'the premise: hiding 18+ with no adult genres named keeps it');
    const named = await recommendationsFor(u, { ctx: HIDING(u, [' ecchi ']), inLibrary: noLib });
    assert.ok(!named.content.some((r) => r.title === 'Genre Tagged'), 'a title in an admin-named adult genre was shown to a viewer hiding 18+');
  } finally { RECS[1] = was; }
});

test('a series from a library taken away neither seeds nor is named; nor one whose library looks nothing up', { skip }, async () => {
  // Rated five stars and read in the library, linked (checked) to AniList, not on the person's AniList list: a local seed.
  // Reintroduce by dropping the browsable() line: the revoked viewer's answer names "Library Seed". By dropping the
  // anilist_lookup join: its AniList id is sent to AniList from a library that said no (#168).
  const { q, mk, connect } = await setup();
  const { recommendationsFor } = await import('../src/lib/trackerRecs');
  const u = await mk('recs-a');
  await connect(u, 'anilist');
  await lib('lib_recs_a');
  await lib('lib_recs_off', false);
  for (const [id, library, title, ext] of [['s_recs_seed', 'lib_recs_a', 'Library Seed', '50'], ['s_recs_quiet', 'lib_recs_off', 'Quiet Seed', '51']]) {
    await q(`INSERT INTO lib_series (id, source, title, folder, library_id) VALUES ($1,'test',$2,$1,$3)`, [id, title, library]);
    await q(`INSERT INTO series_trackers (series_id, provider, external_id, title, checked_at) VALUES ($1,'anilist',$2,$3, now())`, [id, ext, title]);
    await q(`INSERT INTO ratings (user_id, series_id, stars) VALUES ($1,$2,5)`, [u, id]);
    // Read in earnest (twelve chapters): a series only rated, or only sampled, says nothing about taste (barelyRead).
    for (let n = 1; n <= 12; n++) {
      await q(`INSERT INTO lib_books (id, series_id, source, file, number) VALUES ($1,$2,'test',$3,$4)`, [`b_${id}_${n}`, id, `/recs/${id}/${n}.cbz`, n]);
      await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,0,true)`, [u, `b_${id}_${n}`, id]);
    }
  }
  RECS[50] = [{ rating: 30, mediaRecommendation: med(60, 'After The Library Seed') }];
  RECS[51] = [{ rating: 30, mediaRecommendation: med(61, 'After The Quiet Seed') }];
  try {
    reset(anilistRoute());
    const revoked = await recommendationsFor(u, { ctx: { ...OPEN(u), libraryIds: ['lib_recs_other'] }, inLibrary: noLib });
    assert.ok(!revoked.content.some((r) => r.sources.some((x) => x.because === 'Library Seed')), 'a series from a library taken away was named');
    assert.ok(!calls.some((c) => /Media\(id:50/.test(c.body?.query ?? '')), 'its AniList id was sent for a viewer who may not see it');
    const open = await recommendationsFor(u, { ctx: OPEN(u), inLibrary: noLib });
    assert.ok(open.content.some((r) => r.sources.some((x) => x.because === 'Library Seed')), 'the premise: with access it seeds');
    assert.ok(!open.content.some((r) => r.sources.some((x) => x.because === 'Quiet Seed')), 'a library whose lookups are off seeded');
    assert.ok(!calls.some((c) => /Media\(id:51/.test(c.body?.query ?? '')), 'its AniList id was sent from a library that looks nothing up');
  } finally { delete RECS[50]; delete RECS[51]; }
});
