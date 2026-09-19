// Several trackers at once.
//
// AniList was the only one, and MyAnimeList is the bigger service by users. The schema was already keyed on
// `(user_id, provider)` and the module said so in a comment -- "provider is carried everywhere so MAL/Kitsu
// can be added without a migration" -- and that held: nothing about the tables changed.
//
// What that comment did NOT cover is the part these tests are about. `linkSeries` took a provider argument
// and then hardcoded `'anilist'` in its INSERT, so any link made for a second service would have been stored
// as an AniList one and read back with the wrong external id -- pushing a user's Kitsu progress to whatever
// AniList entry happened to share that number. And the push path resolved exactly one connection, so a user
// with two trackers connected would have had one of them silently do nothing.
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

const SERIES = 's_trk_multi';

// ---- a stub for the three tracker hosts ------------------------------------------------------------------
//
// The adapters are the only code that talks to AniList, MyAnimeList and Kitsu, and none of it can be run
// against the real services in a test (a token is a person's account). So `fetch` answers those three hosts
// from a per-test router and passes everything else through to the real fetch (the pattern of
// chapterActions.int.test.ts), and every call is logged so a test can assert what was asked -- which page,
// which status, and above all that a URL the service handed back was never fetched.
type Call = { method: string; url: URL; body: any };
const calls: Call[] = [];
let route: (c: Call) => Response | null = () => null;
const TRACKER_HOSTS = ['graphql.anilist.co', 'api.myanimelist.net', 'kitsu.app', 'kitsu.io', 'example.invalid'];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init?: any) => {
  const url = new URL(String(u));
  if (!TRACKER_HOSTS.includes(url.hostname)) return realFetch(u, init);
  let body: any = null;
  if (typeof init?.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
  const c = { method: String(init?.method ?? 'GET').toUpperCase(), url, body };
  calls.push(c);
  // A stub answering example.invalid is the trap for "fetched the service's next URL": the adapters must
  // never reach it, so reaching it is a failure the test can see.
  if (url.hostname === 'example.invalid') return new Response('never fetch a service-supplied url', { status: 500 });
  return route(c) ?? new Response('unrouted', { status: 500 });
}) as typeof fetch;
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const reset = (r: typeof route) => { calls.length = 0; route = r; };
const isAuthFail = (e: unknown) => !!(e as any)?.authFailed;

// AniList: `Viewer` for whoAmI, then one MediaListCollection chunk per call from `chunks`.
const anilistRoute = (chunks: Array<{ hasNextChunk: boolean; lists: any[] }>) => (c: Call) => {
  if (c.url.hostname !== 'graphql.anilist.co') return null;
  if (/Viewer/.test(c.body?.query)) return json({ data: { Viewer: { id: 7, name: 'me' } } });
  const n = Number(c.body?.variables?.chunk) || 1;
  // a chunk past the scripted ones is an empty last chunk, so a loop that reads too far is caught by the
  // request log rather than by a stub error
  return json({ data: { MediaListCollection: chunks[n - 1] ?? { hasNextChunk: false, lists: [] } } });
};
const media = (id: number, english: string | null, romaji: string, synonyms: string[] = [], format = 'MANGA') =>
  ({ id, format, title: { romaji, english }, synonyms });
const entry = (mediaId: number, status: string, progress: number, m: ReturnType<typeof media>) =>
  ({ mediaId, status, progress, media: m });

test('every provider has a complete adapter', async () => {
  const { ADAPTERS, PROVIDERS, isProvider } = await import('../src/lib/trackerProviders');
  assert.deepEqual(PROVIDERS.sort(), ['anilist', 'kitsu', 'myanimelist']);
  for (const p of PROVIDERS) {
    const a = ADAPTERS[p];
    assert.equal(a.id, p, `${p}: the adapter must know its own id, since it is looked up by it`);
    assert.ok(a.label, `${p}: needs a display name`);
    assert.ok(a.tokenHelp, `${p}: needs to tell the user where to get a token, or nobody can connect it`);
    assert.equal(typeof a.whoAmI, 'function');
    assert.equal(typeof a.setProgress, 'function');
    assert.equal(typeof a.listLibrary, 'function', `${p}: the import intake reads the list through this`);
  }
  assert.ok(isProvider('kitsu'));
  assert.ok(!isProvider('goodreads'), 'an unknown name must not be accepted as a provider');
  assert.ok(!isProvider(undefined));
});

test('AniList list: three chunks, custom lists deduped, a light novel marked, statuses mapped', async () => {
  const { anilistAdapter } = await import('../src/lib/trackerProviders');
  const aot = media(1, 'Attack on Titan', 'Shingeki no Kyojin',
    ['Shingeki no Kyojin', 'AoT', 'attack-on-titan', 'SnK', 'Titan', 'Atak Tytanów', "L'Attaque des Titans"]);
  reset(anilistRoute([
    { hasNextChunk: true, lists: [
      { isCustomList: false, entries: [entry(1, 'CURRENT', 12, aot), entry(2, 'REPEATING', 40, media(2, null, 'Berserk'))] },
      // a custom list repeats an entry of the status list above, and holds one that lives nowhere else
      { isCustomList: true, entries: [entry(1, 'CURRENT', 12, aot), entry(3, 'PAUSED', 5, media(3, 'Vinland Saga', 'Vinland Saga'))] },
    ] },
    { hasNextChunk: true, lists: [
      { isCustomList: false, entries: [entry(4, 'PLANNING', 0, media(4, 'Mushoku Tensei', 'Mushoku Tensei', [], 'NOVEL'))] },
    ] },
    { hasNextChunk: false, lists: [
      { isCustomList: false, entries: [entry(5, 'DROPPED', 3, media(5, 'Dropped One', 'Dropped One'))] },
    ] },
  ]));
  const rows = await anilistAdapter.listLibrary('tok', { statuses: ['reading', 'plan_to_read', 'on_hold'], max: 501 });

  const listCalls = calls.filter((c) => /MediaListCollection/.test(c.body?.query));
  assert.deepEqual(listCalls.map((c) => c.body.variables.chunk), [1, 2, 3], 'every chunk is read while hasNextChunk says so');
  assert.ok(listCalls.every((c) => c.body.variables.perChunk === 500 && c.body.variables.userId === 7));
  assert.deepEqual(listCalls[0].body.variables.statuses, ['CURRENT', 'REPEATING', 'PLANNING', 'PAUSED'],
    'reading asks for CURRENT and REPEATING, on hold for PAUSED');

  // Reintroduce by dropping the `seen` check in the AniList adapter: media 1 arrives twice.
  assert.deepEqual(rows.map((r) => r.externalId), ['1', '2', '3', '4'], 'one row per media id across groups, the custom-only entry kept');
  const byId = Object.fromEntries(rows.map((r) => [r.externalId, r]));
  assert.equal(byId['1'].title, 'Attack on Titan', 'English first');
  // Reintroduce by capping after the dedupe instead of deduping first, or by dropping normTitle: the romaji
  // synonym and the hyphenated spelling are the same key as titles already taken. The abbreviations (AoT,
  // SnK) are dropped as search terms -- see the guard below -- so the cap falls on the French spelling.
  assert.deepEqual(byId['1'].altTitles, ['Shingeki no Kyojin', 'Titan', 'Atak Tytanów'],
    'romaji then synonyms, deduped by key, abbreviations dropped, capped at 3');
  assert.equal(byId['2'].title, 'Berserk', 'no English title: the romaji is the search title');
  assert.deepEqual(byId['2'].altTitles, []);
  // Reintroduce by mapping only CURRENT to reading: the re-read reads as nothing and is dropped.
  assert.equal(byId['2'].status, 'reading', 'REPEATING is still reading');
  assert.equal(byId['3'].status, 'on_hold', 'PAUSED is on hold');
  assert.equal(byId['4'].status, 'plan_to_read');
  // Reintroduce by not reading `format`: the light novel resolves to its adaptation and gets linked.
  assert.equal(byId['4'].format, 'novel', 'a NOVEL on a manga list is marked so the intake can skip it');
  assert.equal(byId['1'].format, 'manga');
  assert.deepEqual(rows.map((r) => r.progress), [12, 40, 5, 0], 'progress is carried: it seeds the push floor');
  assert.ok(!rows.some((r) => r.externalId === '5'), 'a status that was not asked for is not returned');
});

test('MyAnimeList list: one paged loop per status, English title first, rereads count as reading', async () => {
  const { malAdapter } = await import('../src/lib/trackerProviders');
  const node = (id: number, title: string, en: string, synonyms: string[] = [], media_type = 'manga') =>
    ({ id, title, alternative_titles: { en, ja: 'x', synonyms }, media_type });
  reset((c) => {
    if (c.url.hostname !== 'api.myanimelist.net') return null;
    if (c.url.pathname !== '/v2/users/@me/mangalist') return null;
    const status = c.url.searchParams.get('status'), offset = Number(c.url.searchParams.get('offset'));
    // Berserk is the gray entry: it only comes back with nsfw=true, exactly as the real service behaves
    const nsfw = c.url.searchParams.get('nsfw') === 'true';
    if (status === 'reading' && offset === 0) return json({
      data: [
        { node: node(10, 'Shingeki no Kyojin', 'Attack on Titan', ['SnK']), list_status: { status: 'reading', num_chapters_read: 30, is_rereading: true } },
        ...(nsfw ? [{ node: node(11, 'Berserk', ''), list_status: { status: 'reading', num_chapters_read: 5 } }] : []),
      ],
      paging: { next: 'https://example.invalid/v2/users/@me/mangalist?offset=2' },
    });
    if (status === 'reading' && offset === 1) return json({ data: [], paging: {} }); // the nsfw-less page ends here
    if (status === 'reading' && offset === 2) return json({
      data: [{ node: node(12, 'Mushoku Tensei', 'Mushoku Tensei', [], 'light_novel'), list_status: { status: 'reading', num_chapters_read: 1 } }],
      paging: {},
    });
    if (status === 'plan_to_read' && offset === 0) return json({
      data: [{ node: node(13, 'Vinland Saga', 'Vinland Saga'), list_status: { status: 'plan_to_read', num_chapters_read: 0 } }],
      paging: {},
    });
    return json({ error: 'bad_request', message: `unexpected ${status} ${offset}` }, 400);
  });
  const rows = await malAdapter.listLibrary('tok', { statuses: ['reading', 'plan_to_read'], max: 501 });

  // Reintroduce by omitting `nsfw`: the stub then leaves the gray entry out, as the real service does.
  assert.ok(calls.every((c) => c.url.searchParams.get('nsfw') === 'true' && c.url.searchParams.get('limit') === '1000'),
    'nsfw=true and limit=1000 on every page, or gray entries vanish and pages are ten times as many');
  assert.deepEqual(calls.map((c) => [c.url.searchParams.get('status'), c.url.searchParams.get('offset')]),
    [['reading', '0'], ['reading', '2'], ['plan_to_read', '0']], 'one loop per status, paged by our own offset');
  // Reintroduce by `fetch(d.paging.next)`: the stub 500s on example.invalid and the list throws.
  assert.ok(calls.every((c) => c.url.hostname === 'api.myanimelist.net'), 'the service-supplied next URL is never fetched');
  assert.ok(calls.every((c) => c.url.searchParams.get('fields')?.includes('media_type')), 'media_type is asked for, or novels cannot be told apart');

  assert.deepEqual(rows.map((r) => r.externalId), ['10', '11', '12', '13']);
  // Reintroduce by using `node.title` as the title: the romaji becomes the search term.
  assert.equal(rows[0].title, 'Attack on Titan', 'alternative_titles.en is the search title');
  assert.deepEqual(rows[0].altTitles, ['Shingeki no Kyojin'], 'the romaji is an alternate; the SnK abbreviation is not a search term');
  assert.equal(rows[1].title, 'Berserk', 'an empty English title falls back to the romaji');
  assert.equal(rows[0].status, 'reading', 'a re-read comes back under reading and stays there');
  assert.equal(rows[0].progress, 30);
  assert.equal(rows[2].format, 'novel');
  assert.equal(rows[3].status, 'plan_to_read');
});

test('Kitsu list: manga joined from included, planned is plan_to_read', async () => {
  const { kitsuAdapter } = await import('../src/lib/trackerProviders');
  const inc = (id: string, attributes: Record<string, unknown>) => ({ type: 'manga', id, attributes });
  const ent = (id: string, status: string, progress: number, mangaId: string) =>
    ({ id, type: 'libraryEntries', attributes: { status, progress }, relationships: { manga: { data: { type: 'manga', id: mangaId } } } });
  reset((c) => {
    if (c.url.hostname !== 'kitsu.app') return null;
    if (c.url.pathname === '/api/edge/users') return json({ data: [{ id: '42', attributes: { name: 'me' } }] });
    if (c.url.pathname !== '/api/edge/library-entries') return null;
    if (c.url.searchParams.get('page[offset]') === '0') return json({
      data: [ent('900', 'current', 10, '14916'), ent('901', 'planned', 0, '23815'), ent('902', 'current', 2, '777')],
      // included is NOT in the entries' order, and one manga has no English title at all
      included: [
        inc('777', { canonicalTitle: 'Some Novel', titles: { en: null, en_jp: 'Some Novel' }, abbreviatedTitles: [], subtype: 'novel' }),
        inc('23815', { canonicalTitle: 'Noblesse', titles: { en_us: 'Noblesse', ko_kr: '노블레스' }, abbreviatedTitles: ['ノブレス'], subtype: 'manhwa' }),
        inc('14916', { canonicalTitle: 'Attack on Titan', titles: { en: 'Attack on Titan', en_jp: 'Shingeki no Kyojin', ja_jp: '進撃の巨人' }, abbreviatedTitles: ['SNK', 'AOT', '進擊的巨人', 'Titan', 'Shingeki no Kyojin: Attack on Titan', 'AoT Manga'], subtype: 'manga' }),
      ],
      links: { next: 'https://example.invalid/api/edge/library-entries?page[offset]=3' },
    });
    if (c.url.searchParams.get('page[offset]') === '3') return json({
      data: [ent('903', 'planned', 0, '555')],
      included: [inc('555', { canonicalTitle: 'Only Canonical', titles: {}, abbreviatedTitles: [], subtype: 'manga' })],
      links: {},
    });
    return json({ errors: [{ status: '400', title: `unexpected ${c.url.search}` }] }, 400);
  });
  const rows = await kitsuAdapter.listLibrary('tok', { statuses: ['reading', 'plan_to_read'], max: 501 });

  const lists = calls.filter((c) => c.url.pathname === '/api/edge/library-entries');
  assert.equal(lists.length, 2, 'two pages, by our own offset');
  assert.ok(calls.every((c) => c.url.hostname === 'kitsu.app'), 'links.next is never fetched');
  const p = lists[0].url.searchParams;
  assert.equal(p.get('filter[userId]'), '42', 'the list is the token owner\'s');
  assert.equal(p.get('filter[kind]'), 'manga');
  // Reintroduce by dropping the status filter: the stub does not care, but the real service answers the
  // whole library, and the intake shows lists nobody ticked.
  assert.equal(p.get('filter[status]'), 'current,planned', 'reading is current, plan to read is planned, as one comma list');
  assert.equal(p.get('page[limit]'), '500', '501 is a 400 on Kitsu');
  assert.ok(p.get('fields[manga]')?.includes('subtype'), 'subtype is asked for, or novels cannot be told apart');

  // Reintroduce by returning `row.id` as the external id: the entry id belongs to one account.
  assert.deepEqual(rows.map((r) => r.externalId), ['14916', '23815', '777', '555'], 'the MANGA id is the external id, never the entry id');
  const byId = Object.fromEntries(rows.map((r) => [r.externalId, r]));
  assert.equal(byId['14916'].title, 'Attack on Titan');
  assert.deepEqual(byId['14916'].altTitles, ['Shingeki no Kyojin', 'Titan', 'Shingeki no Kyojin: Attack on Titan'],
    'romaji then abbreviatedTitles; kanji has no key and SNK/AOT are abbreviations, all dropped; capped at 3');
  assert.equal(byId['23815'].title, 'Noblesse', 'en_us when there is no en');
  assert.equal(byId['23815'].status, 'plan_to_read');
  assert.equal(byId['777'].title, 'Some Novel', 'a null en falls through to the canonical title');
  assert.equal(byId['777'].format, 'novel');
  assert.equal(byId['555'].title, 'Only Canonical');
  assert.deepEqual(rows.map((r) => r.progress), [10, 0, 2, 0]);
});

test("Kitsu progress goes to the caller's own entry: patched when it exists, created when not", async () => {
  const { kitsuAdapter } = await import('../src/lib/trackerProviders');
  reset((c) => {
    if (c.url.hostname !== 'kitsu.app') return null;
    if (c.url.pathname === '/api/edge/users') return json({ data: [{ id: '42', attributes: { name: 'me' } }] });
    if (c.method === 'GET' && c.url.pathname === '/api/edge/library-entries') {
      // this account has an entry for manga 14916 and none for 555
      const mangaId = c.url.searchParams.get('filter[mangaId]');
      return json({ data: mangaId === '14916' ? [{ id: '999', type: 'libraryEntries', attributes: { status: 'current' } }] : [] });
    }
    // any PATCH is accepted, so a write to the wrong entry is caught by the assertion below, not by a 404
    if (c.method === 'PATCH') return json({ data: { id: '999' } });
    if (c.method === 'POST' && c.url.pathname === '/api/edge/library-entries') return json({ data: { id: '1000' } }, 201);
    return json({ errors: [{ status: '404' }] }, 404);
  });

  await kitsuAdapter.setProgress('tok', '14916', 12, false);
  const lookup = calls.find((c) => c.method === 'GET' && c.url.pathname === '/api/edge/library-entries');
  assert.ok(lookup, 'the entry is looked up, not assumed');
  assert.equal(lookup!.url.searchParams.get('filter[userId]'), '42', "the CALLER's entry -- another member must not write the importer's");
  assert.equal(lookup!.url.searchParams.get('filter[mangaId]'), '14916');
  // Reintroduce by PATCHing `/library-entries/${externalId}`: the write goes to /library-entries/14916.
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(patch?.url.pathname, '/api/edge/library-entries/999', 'the PATCH addresses the entry the lookup found');
  assert.deepEqual(patch?.body?.data, { id: '999', type: 'libraryEntries', attributes: { progress: 12, status: 'current' } });
  assert.ok(!calls.some((c) => c.method === 'POST'), 'nothing is created when an entry exists');

  calls.length = 0;
  await kitsuAdapter.setProgress('tok', '555', 3, true);
  assert.ok(!calls.some((c) => c.method === 'PATCH'), 'nothing to patch');
  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post?.url.pathname, '/api/edge/library-entries', 'no entry yet: one is created on this account');
  assert.deepEqual(post?.body?.data?.attributes, { progress: 3, status: 'completed' });
  assert.deepEqual(post?.body?.data?.relationships, {
    user: { data: { type: 'users', id: '42' } },
    media: { data: { type: 'manga', id: '555' } },
  }, 'the new entry belongs to the caller and points at the manga id that was stored');
});

test('a rejected token throws authFailed; a 400 does not', async () => {
  const { anilistAdapter, malAdapter, kitsuAdapter } = await import('../src/lib/trackerProviders');
  const opts = { statuses: ['reading'] as any, max: 10 };

  // AniList says "Invalid token" with HTTP 400, and so does every validation error: only the message decides.
  reset(() => json({ data: null, errors: [{ message: 'Invalid token', status: 400 }] }, 400));
  await assert.rejects(anilistAdapter.listLibrary('bad', opts), (e) => isAuthFail(e), 'a bad AniList token is authFailed');
  reset(() => json({ data: null }, 401));
  await assert.rejects(anilistAdapter.listLibrary('bad', opts), (e) => isAuthFail(e), 'a 401 is authFailed');
  // Reintroduce by mapping every AniList 400 to authFail: this validation error disables the connection.
  reset(() => json({ errors: [{ message: 'Field "MediaListCollection" argument "perChunk" requires type Int, found "no".', status: 400 }] }, 400));
  await assert.rejects(anilistAdapter.listLibrary('good', opts), (e) => !isAuthFail(e) && /perChunk/.test((e as Error).message),
    'a validation 400 is a plain error that keeps the connection');

  reset(() => json({ error: 'invalid_token', message: 'token is invalid' }, 401));
  await assert.rejects(malAdapter.listLibrary('bad', opts), (e) => isAuthFail(e), 'MAL 401');
  reset(() => json({ error: 'bad_request', message: 'invalid parameters' }, 400));
  await assert.rejects(malAdapter.listLibrary('good', opts), (e) => !isAuthFail(e), 'MAL 400 is plain');

  reset(() => json({ errors: [{ status: '401' }] }, 401));
  await assert.rejects(kitsuAdapter.listLibrary('bad', opts), (e) => isAuthFail(e), 'Kitsu 401');
  reset(() => json({ errors: [{ status: '400' }] }, 400));
  await assert.rejects(kitsuAdapter.listLibrary('good', opts), (e) => !isAuthFail(e), 'Kitsu 400 is plain');
  reset(() => json({ errors: [{ status: '503' }] }, 503));
  await assert.rejects(kitsuAdapter.listLibrary('good', opts), (e) => !isAuthFail(e), 'an outage is not a bad token');
});

test('a text/plain 403 (Cloudflare) is a plain error, never authFailed', async () => {
  // graphql.anilist.co sits behind Cloudflare, which answers `403 error code: 1010` (text/plain) to a client
  // signature it dislikes -- a verdict on the caller, never on the token (a bad token there is a 400 "Invalid
  // token"). Mapped to authFail, one such block during a push disabled the connection with "rejected the
  // saved token" and the person pasted a new token for nothing. MAL's 403 is its DoS block and Kitsu's is a
  // forbidden action: none of the three says the token is bad, so all three keep the connection.
  // Reintroduce by adding 403 back to the authFail condition in anilistCall / malCall / kitsuCall.
  const { anilistAdapter, malAdapter, kitsuAdapter } = await import('../src/lib/trackerProviders');
  const opts = { statuses: ['reading'] as any, max: 10 };
  const cloudflare = () => new Response('error code: 1010', { status: 403, headers: { 'content-type': 'text/plain' } });
  const plain403 = (e: unknown) => !isAuthFail(e) && /403/.test((e as Error).message);

  reset(cloudflare);
  await assert.rejects(anilistAdapter.listLibrary('good', opts), plain403, 'AniList list: a 403 keeps the connection');
  reset(cloudflare);
  await assert.rejects(anilistAdapter.setProgress('good', '1', 5, false), plain403, 'AniList push: a 403 keeps the connection');

  reset(() => json({ error: 'forbidden', message: 'DoS protection' }, 403));
  await assert.rejects(malAdapter.listLibrary('good', opts), plain403, 'MAL list: a 403 keeps the connection');
  reset(() => json({ error: 'forbidden', message: 'DoS protection' }, 403));
  await assert.rejects(malAdapter.setProgress('good', '1', 5, false), plain403, 'MAL push: a 403 keeps the connection');

  reset(() => json({ errors: [{ status: '403' }] }, 403));
  await assert.rejects(kitsuAdapter.listLibrary('good', opts), plain403, 'Kitsu list: a 403 keeps the connection');
  reset(() => json({ errors: [{ status: '403' }] }, 403));
  await assert.rejects(kitsuAdapter.setProgress('good', '1', 5, false), plain403, 'Kitsu push: a 403 keeps the connection');
});

test('three-letter synonyms are not offered as alternate titles', async () => {
  // AniList's synonyms carry `MHA`, `BNHA`, `HeroAca` for Boku no Hero Academia. An abbreviation never matches
  // a result exactly, only by containment, and three letters are contained in almost anything: 'AoT' picked
  // 'Chaotic Love Story' on the first source that lacked the series. Reintroduce by dropping the
  // `key.length < MIN_ALT_KEY` check in titlesOf: MHA and BNHA come back as alternates.
  const { anilistAdapter, kitsuAdapter } = await import('../src/lib/trackerProviders');
  reset(anilistRoute([{ hasNextChunk: false, lists: [{ isCustomList: false, entries: [
    entry(1, 'CURRENT', 3, media(1, 'My Hero Academia', 'Boku no Hero Academia', ['MHA', 'BNHA', 'HeroAca', 'Ajin'])),
    // no English title and a four-letter romaji: the search TITLE is exempt, only alternates are filtered
    entry(2, 'CURRENT', 1, media(2, null, 'Ajin', ['Ajin: Demi-Human', 'AJ'])),
  ] }] }]));
  const rows = await anilistAdapter.listLibrary('tok', { statuses: ['reading'], max: 10 });
  assert.deepEqual(rows[0].altTitles, ['Boku no Hero Academia', 'HeroAca'], 'MHA, BNHA and the four-letter Ajin are dropped; HeroAca (7) stays');
  assert.equal(rows[1].title, 'Ajin', 'a short title is still the title');
  assert.deepEqual(rows[1].altTitles, ['Ajin: Demi-Human'], 'AJ is dropped');

  // Kitsu's abbreviatedTitles are the same abbreviations upper-cased.
  reset((c) => {
    if (c.url.pathname === '/api/edge/users') return json({ data: [{ id: '42', attributes: { name: 'me' } }] });
    return json({
      data: [{ id: '1', attributes: { status: 'current', progress: 0 }, relationships: { manga: { data: { id: '10' } } } }],
      included: [{ type: 'manga', id: '10', attributes: { canonicalTitle: 'My Hero Academia', titles: { en: 'My Hero Academia', en_jp: 'Boku no Hero Academia' }, abbreviatedTitles: ['MHA', 'BNHA'], subtype: 'manga' } }],
      links: {},
    });
  });
  const k = await kitsuAdapter.listLibrary('tok', { statuses: ['reading'], max: 10 });
  assert.deepEqual(k[0].altTitles, ['Boku no Hero Academia']);
});

test('the cap stops reading', async () => {
  const { anilistAdapter, malAdapter, kitsuAdapter } = await import('../src/lib/trackerProviders');
  const full = (from: number) => ({
    hasNextChunk: true,
    lists: [{ isCustomList: false, entries: Array.from({ length: 500 }, (_, i) => entry(from + i, 'CURRENT', 1, media(from + i, `T${from + i}`, `T${from + i}`))) }],
  });
  reset(anilistRoute([full(1), full(501), full(1001)]));
  const a = await anilistAdapter.listLibrary('tok', { statuses: ['reading'], max: 501 });
  assert.equal(a.length, 501, 'exactly the cap, so the intake can tell "more than 500" from "500"');
  // Reintroduce by looping on hasNextChunk alone: a third chunk is asked for.
  assert.deepEqual(calls.filter((c) => /MediaListCollection/.test(c.body?.query)).map((c) => c.body.variables.chunk), [1, 2],
    'reading stops at the cap; chunk 3 is never asked for');

  reset((c) => c.url.hostname === 'api.myanimelist.net'
    ? json({ data: [{ node: { id: 1, title: 'A', alternative_titles: {} }, list_status: { status: c.url.searchParams.get('status'), num_chapters_read: 0 } },
                    { node: { id: 2, title: 'B', alternative_titles: {} }, list_status: { status: c.url.searchParams.get('status'), num_chapters_read: 0 } }],
             paging: { next: 'https://example.invalid/more' } })
    : null);
  const m = await malAdapter.listLibrary('tok', { statuses: ['reading', 'completed'], max: 2 });
  assert.equal(m.length, 2);
  assert.equal(calls.length, 1, 'the cap ends the loop before the second page and the second status');

  reset((c) => {
    if (c.url.pathname === '/api/edge/users') return json({ data: [{ id: '42', attributes: {} }] });
    return json({
      data: [{ id: '1', attributes: { status: 'current', progress: 0 }, relationships: { manga: { data: { id: '10' } } } },
             { id: '2', attributes: { status: 'current', progress: 0 }, relationships: { manga: { data: { id: '11' } } } }],
      included: [{ type: 'manga', id: '10', attributes: { canonicalTitle: 'A' } }, { type: 'manga', id: '11', attributes: { canonicalTitle: 'B' } }],
      links: { next: 'https://example.invalid/more' },
    });
  });
  const k = await kitsuAdapter.listLibrary('tok', { statuses: ['reading'], max: 1 });
  assert.equal(k.length, 1);
  assert.equal(calls.filter((c) => c.url.pathname === '/api/edge/library-entries').length, 1, 'one page was enough');
});

test('multi-provider tracking', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const trackers = await import('../src/lib/trackers');
  await migrate();

  await q('DELETE FROM series_trackers WHERE series_id = $1', [SERIES]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [SERIES]).catch(() => {});
  await q(`DELETE FROM users WHERE username = 'trk-multi'`).catch(() => {});
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!trk',$1,$2,1)`,
    [SERIES, `T!trk/${SERIES}`]);
  const u = await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind)
     VALUES ('trk-multi','trk-multi','x','user','password') RETURNING id`);
  const userId = u[0].id;

  try {
    await t.test('THE BUG: a link is stored under the provider it was made for', async () => {
      await trackers.linkSeries(SERIES, '111', 'On AniList', null, 'anilist');
      await trackers.linkSeries(SERIES, '222', 'On MAL', null, 'myanimelist');
      await trackers.linkSeries(SERIES, '333', 'On Kitsu', null, 'kitsu');

      const rows = await q<{ provider: string; external_id: string }>(
        'SELECT provider, external_id FROM series_trackers WHERE series_id = $1 ORDER BY provider', [SERIES]);
      assert.deepEqual(rows, [
        { provider: 'anilist', external_id: '111' },
        { provider: 'kitsu', external_id: '333' },
        { provider: 'myanimelist', external_id: '222' },
      ], 'each link must keep its own id -- the INSERT used to write every one as anilist');
    });

    await t.test('the default is still AniList, so existing callers are unchanged', async () => {
      await q('DELETE FROM series_trackers WHERE series_id = $1', [SERIES]);
      await trackers.linkSeries(SERIES, '444', 'Default');
      const r = await q<{ provider: string }>('SELECT provider FROM series_trackers WHERE series_id = $1', [SERIES]);
      assert.equal(r[0].provider, 'anilist');
    });

    await t.test('status lists every provider, connected or not', async () => {
      const st = await trackers.statusFor(userId);
      assert.equal(st.length, 3, 'the UI offers what it is told about, so all three must be listed');
      for (const s of st) {
        assert.ok(s.label, 'each needs a display name');
        assert.ok(s.tokenHelp, 'each needs to say where a token comes from');
      }
      assert.deepEqual(st.map((s) => s.connected), [false, false, false]);
    });

    await t.test('connections are independent: one does not disturb another', async () => {
      await trackers.saveConnection(userId, 'anilist', 'token-a', 'me-on-anilist', new Date(Date.now() + 86400000));
      await trackers.saveConnection(userId, 'myanimelist', 'token-m', 'me-on-mal', new Date(Date.now() + 86400000));

      const st = await trackers.statusFor(userId);
      const byId = Object.fromEntries(st.map((s) => [s.provider, s]));
      assert.equal(byId.anilist.connected, true);
      assert.equal(byId.anilist.accountName, 'me-on-anilist');
      assert.equal(byId.myanimelist.connected, true);
      assert.equal(byId.myanimelist.accountName, 'me-on-mal');
      assert.equal(byId.kitsu.connected, false, 'an unconnected provider stays unconnected');

      await trackers.disconnect(userId, 'anilist');
      const after = Object.fromEntries((await trackers.statusFor(userId)).map((s) => [s.provider, s]));
      assert.equal(after.anilist.connected, false, 'disconnecting one');
      assert.equal(after.myanimelist.connected, true, 'must not disconnect the other');
    });

    await t.test('the high-water mark is per provider, not shared', async () => {
      // The floor stops a tracker being walked backwards. Sharing it across services would mean progress
      // pushed to one silently blocking the other, which is the same class of bug as the shared link id.
      await q('DELETE FROM tracker_progress WHERE user_id = $1 AND series_id = $2', [userId, SERIES]);
      for (const [p, n] of [['anilist', 10], ['myanimelist', 3]] as const) {
        await q(
          `INSERT INTO tracker_progress (user_id, series_id, provider, chapters, pushed_at)
           VALUES ($1,$2,$3,$4,now())`, [userId, SERIES, p, n]);
      }
      const rows = await q<{ provider: string; chapters: number }>(
        'SELECT provider, chapters FROM tracker_progress WHERE user_id = $1 AND series_id = $2 ORDER BY provider',
        [userId, SERIES]);
      assert.deepEqual(rows, [
        { provider: 'anilist', chapters: 10 },
        { provider: 'myanimelist', chapters: 3 },
      ]);

      await trackers.clearTrackerFloor(userId, SERIES, 'myanimelist');
      const left = await q<{ provider: string }>(
        'SELECT provider FROM tracker_progress WHERE user_id = $1 AND series_id = $2', [userId, SERIES]);
      assert.deepEqual(left, [{ provider: 'anilist' }],
        'clearing the floor for one provider must leave the others alone');
    });

    await t.test('pushing with nothing connected does nothing, quietly', async () => {
      await trackers.disconnect(userId, 'myanimelist');
      await trackers.pushSeriesProgress(userId, SERIES);   // must not throw
    });
  } finally {
    await q('DELETE FROM series_trackers WHERE series_id = $1', [SERIES]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = $1', [SERIES]).catch(() => {});
    await q(`DELETE FROM users WHERE username = 'trk-multi'`).catch(() => {});
  }
});
