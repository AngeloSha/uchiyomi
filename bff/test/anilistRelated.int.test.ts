// Related works, "Because you read" and the trending rails (v0.61.0, lib/anilistRelated.ts), against Postgres.
//
// The owner approved Related works + "Because you read X", trending manga and manhua beside the manhwa, and Discover
// opening on a search. What these pin: what the background job asks AniList and never asks it (a library whose lookups
// are off sends nothing, even when switched off while a round runs), that no page ever asks AniList, and what each
// viewer is shown -- a held work as the library's series only when they may list it, never named when they may not, and
// nothing 18+ to a viewer hiding it or capped below it. AniList answers through a scripted fetch.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const ON = 'lib_rel_on', OFF = 'lib_rel_off', ON2 = 'lib_rel_on2', ADULT = 'lib_rel_adult';
const LIBS = [ON, OFF, ON2, ADULT];
/** id, title, library, AniList id (null: none), link checked?, genres. */
const SERIES: Array<[string, string, string, string | null, boolean, string[]]> = [
  ['s_rel_main', 'Rel Main', ON, '1001', true, ['Action']],
  ['s_rel_sequel', 'Rel Sequel', ON, '1002', true, []],
  // Held, in an 18+ library: listed to no one hiding 18+, visible to no one capped below it.
  ['s_rel_hidden', 'Rel Parent Hidden', ADULT, '1003', true, []],
  // Held by its name alone: no AniList link.
  ['s_rel_named', 'Named Held Work', ON, null, false, []],
  ['s_rel_off', 'Rel Off', OFF, '1010', true, []],
  ['s_rel_unchecked', 'Rel Unchecked', ON, '1011', false, []],
  ['s_rel_on2', 'Rel On Two', ON2, '1020', true, []],
  // Recommended after Rel Main, and held: by its AniList entry, and by its name.
  ['s_rec_held', 'Rec Held Series', ON, '2001', true, ['Drama']],
  ['s_rec_named', 'Rec Named Work', ON, null, false, ['Drama']],
  ['s_genre_match', 'Genre Match', ON, null, false, ['Action']],
];
const IDS = SERIES.map((s) => s[0]);

/** An AniList node as the related query selects it. */
const n = (id: number, title: string, o: Record<string, any> = {}) => ({
  id, type: 'MANGA', format: 'MANGA', status: 'RELEASING', isAdult: false, countryOfOrigin: 'KR',
  title: { romaji: title, english: title, native: null }, synonyms: [], coverImage: { large: `https://s4.anilist.co/c/${id}.jpg` },
  genres: ['Action'], averageScore: 70, ...o,
});
const rel = (relationType: string, node: any) => ({ relationType, node });
const rec = (rating: number, node: any) => ({ rating, mediaRecommendation: node });
/** What the fake AniList answers the related query with, by id. 1003 and 1020 it answers empty; 2001 not at all. */
const MEDIA: Record<number, any> = {
  1001: {
    id: 1001,
    relations: { edges: [
      rel('ALTERNATIVE', n(1007, 'Rel Alternative Outside')),
      rel('SPIN_OFF', n(1004, 'Named Held Work')),
      rel('SIDE_STORY', n(1006, 'Rel Side Adult', { isAdult: true })),
      rel('PARENT', n(1003, 'Rel Parent Hidden Entry')),
      rel('PREQUEL', n(1005, 'Rel Prequel Outside')),
      rel('SEQUEL', n(1002, 'Rel Sequel Entry')),
    ] },
    recommendations: { nodes: [
      rec(40, n(2001, 'Rec Held By Entry')),
      rec(30, n(2002, 'Rec Named Work')),
      rec(25, n(2003, 'Rec Adult', { isAdult: true })),
      rec(20, n(2004, 'Rec Ecchi', { genres: ['Ecchi'] })),
      rec(15, n(2005, 'Rec Five')),
      rec(12, n(2006, 'Rec Six')),
      rec(11, n(2007, 'Rec Seven')),
      rec(10, n(2008, 'Rec Eight')),
    ] },
  },
  // Read more recently than Rel Main, but leaving only three once what is held is out: not a rail.
  1002: {
    id: 1002,
    relations: { edges: [rel('PREQUEL', n(1001, 'Rel Main Entry'))] },
    recommendations: { nodes: [
      rec(9, n(2001, 'Rec Held By Entry')), rec(8, n(3001, 'Rec Few One')), rec(7, n(3002, 'Rec Few Two')), rec(6, n(3003, 'Rec Few Three')),
    ] },
  },
  1003: { id: 1003, relations: { edges: [] }, recommendations: { nodes: [] } },
  1010: { id: 1010, relations: { edges: [rel('SEQUEL', n(1999, 'Off Sequel'))] }, recommendations: { nodes: [] } },
  1020: { id: 1020, relations: { edges: [] }, recommendations: { nodes: [] } },
};
/** What the fake AniList answers the trending query with, by country. */
const TRENDS: Record<string, any[]> = {
  KR: [{ id: 4001, title: { english: 'Trend Korea' }, coverImage: { large: 'https://s4.anilist.co/t/4001.jpg' }, genres: ['Action'] }],
  JP: [
    { id: 4101, title: { english: 'Trend Japan' }, coverImage: { large: 'https://s4.anilist.co/t/4101.jpg' }, genres: ['Action'] },
    { id: 4102, title: { english: 'Trend Japan Ecchi' }, coverImage: { large: 'https://s4.anilist.co/t/4102.jpg' }, genres: ['ecchi'] },
  ],
  CN: [{ id: 4201, title: { english: 'Trend China' }, coverImage: { large: 'https://s4.anilist.co/t/4201.jpg' }, genres: ['Action'] }],
};

type Asked = { kind: 'related'; ids: number[] } | { kind: 'trending'; country: string; query: string } | { kind: 'other' };
const asked: Asked[] = [];
let failRelated = false;
/** Run once, at the first related request: what a library switched off mid-round looks like. */
let onFirstRelated: (() => Promise<void>) | null = null;
const realFetch = globalThis.fetch;

let q: any, related: typeof import('../src/lib/anilistRelated'), anilist: typeof import('../src/lib/anilist');
let di: typeof import('../src/lib/discoverIdentity'), visibility: typeof import('../src/lib/visibility');
let app: any;
const users = { reader: '', capped: '' };
const tok = (id: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role: 'user' })}` });
const get = async (url: string, who = users.reader) => {
  const r = await app.inject({ method: 'GET', url, headers: tok(who) });
  return { status: r.statusCode as number, body: r.body as string, json: () => r.json() };
};
const relatedAsked = () => asked.filter((a): a is Extract<Asked, { kind: 'related' }> => a.kind === 'related');
const anyAniList = () => asked.length;

before(async () => {
  if (!DSN) return;
  globalThis.fetch = (async (u: any, init?: any) => {
    if (String(u).includes('graphql.anilist.co')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const query = String(body.query);
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
      if (query.includes('recommendations(')) {
        const ids: number[] = body.variables?.ids ?? [];
        asked.push({ kind: 'related', ids });
        if (onFirstRelated) { const f = onFirstRelated; onFirstRelated = null; await f(); }
        if (failRelated) return new Response('down', { status: 500 });
        return json({ data: { Page: { media: ids.filter((id) => MEDIA[id]).map((id) => MEDIA[id]) } } });
      }
      if (query.includes('TRENDING_DESC')) {
        const country = String(body.variables?.country);
        asked.push({ kind: 'trending', country, query });
        // Page 2 is asked when page 1 cannot fill the rail: nothing more on it.
        return json({ data: { Page: { media: body.variables?.page === 2 ? [] : TRENDS[country] ?? [] } } });
      }
      asked.push({ kind: 'other' });
      return new Response('{}', { status: 503 });
    }
    return realFetch(u, init);
  }) as typeof fetch;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  related = await import('../src/lib/anilistRelated');
  anilist = await import('../src/lib/anilist');
  di = await import('../src/lib/discoverIdentity');
  visibility = await import('../src/lib/visibility');
  await migrate();
  await q(`DELETE FROM users WHERE username = ANY($1)`, [['rel_reader', 'rel_capped']]);
  users.reader = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms)
                            VALUES ('rel_reader', 'rel_reader', 'x', 'user', 'password', '{}') RETURNING id`))[0].id;
  users.capped = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms, max_age_rating)
                            VALUES ('rel_capped', 'rel_capped', 'x', 'user', 'password', '{}', 13) RETURNING id`))[0].id;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/sources')).default);
  await app.ready();
});

beforeEach(async () => {
  if (!DSN) return;
  asked.length = 0;
  failRelated = false;
  onFirstRelated = null;
  for (const t of ['read_progress', 'series_trackers', 'series_overrides']) await q(`DELETE FROM ${t} WHERE series_id = ANY($1)`, [IDS]);
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [IDS]);
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [IDS]);
  await q('DELETE FROM anilist_related');
  await q(`INSERT INTO libraries (id, name, path, anilist_lookup, age_rating) VALUES
             ($1, 'Rel on', '/rel-on', true, NULL), ($2, 'Rel off', '/rel-off', false, NULL),
             ($3, 'Rel on two', '/rel-on2', true, NULL), ($4, 'Rel adult', '/rel-adult', true, 18)
           ON CONFLICT (id) DO UPDATE SET anilist_lookup = EXCLUDED.anilist_lookup, age_rating = EXCLUDED.age_rating`, LIBS);
  for (const [id, title, lib, al, checked, genres] of SERIES) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, genres) VALUES ($1, 'T!rel', $2, $1, 1, $3, $4)`,
      [id, title, lib, genres]);
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root) VALUES ($1, $2, 'T!rel', $3, 1, 'Chapter 1', '/library')`,
      [`b_${id}_1`, id, `T!rel/${id}/ch1.cbz`]);
    if (al) {
      await q(`INSERT INTO series_trackers (series_id, provider, external_id, checked_at) VALUES ($1, 'anilist', $2, $3)`,
        [id, al, checked ? new Date() : null]);
    }
  }
  await q(`UPDATE server_settings SET adult_genres = '["Ecchi"]'::jsonb WHERE id = 1`);
  visibility.invalidateAdultFilter();
  // What the library holds is read once a minute: these rows are new.
  di.resetDiscoverIdentity();
});

after(async () => {
  globalThis.fetch = realFetch;
  if (!DSN) return;
  for (const t of ['read_progress', 'series_trackers', 'series_overrides']) await q(`DELETE FROM ${t} WHERE series_id = ANY($1)`, [IDS]).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [IDS]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [IDS]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [LIBS]).catch(() => {});
  await q('DELETE FROM anilist_related').catch(() => {});
  await q(`UPDATE server_settings SET adult_genres = '[]'::jsonb WHERE id = 1`).catch(() => {});
  await q(`DELETE FROM users WHERE username = ANY($1)`, [['rel_reader', 'rel_capped']]).catch(() => {});
  await app?.close();
});

/** A row as the job would store it, without asking anyone. */
const store = async (id: number) => {
  const r = anilist.normaliseRelated(MEDIA[id]);
  await q(`INSERT INTO anilist_related (anilist_id, relations, recs) VALUES ($1, $2::jsonb, $3::jsonb)`,
    [String(id), JSON.stringify(r.relations), JSON.stringify(r.recs)]);
};
const rowOf = async (id: string) => (await q(`SELECT relations, recs, fetched_at FROM anilist_related WHERE anilist_id = $1`, [id]))[0];
/** The reader finished a chapter of each, the last most recently. */
const read = async (...seriesIds: string[]) => {
  for (const [i, id] of seriesIds.entries()) {
    await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at)
             VALUES ($1, $2, $3, 0, true, now() - ($4::int * interval '1 hour'))`, [users.reader, `b_${id}_1`, id, seriesIds.length - i]);
  }
};

test('the refresh asks about checked links in libraries that may look things up, and nothing else', { skip }, async () => {
  const r = await related.refreshAniListRelated({ gapMs: 0 });
  // Reintroduce by dropping the anilist_lookup join from the candidates (or the checked rule): 1010 is chosen -- asked,
  // or `skipped` by the read before the request -- and 1011 asked.
  const ids = relatedAsked().flatMap((a) => a.ids).sort();
  assert.deepEqual(ids, [1001, 1002, 1003, 1020, 2001], 'checked links only, in a library whose AniList lookups are on');
  assert.deepEqual(r, { asked: 5, stored: 4, missing: 1, skipped: 0 });
  assert.equal(relatedAsked().every((a) => a.ids.length <= 10), true, 'more than ten entries a request');
  assert.equal(await rowOf('1010'), undefined, 'a library whose lookups are off has a row');
  // An entry AniList did not answer is kept empty, so it waits for the row to go stale.
  const gone = await rowOf('2001');
  assert.deepEqual([gone.relations, gone.recs], [[], []]);
  const main = await rowOf('1001');
  assert.deepEqual(main.relations.map((x: any) => x.rel), ['SEQUEL', 'PREQUEL', 'PARENT', 'SIDE_STORY', 'SPIN_OFF', 'ALTERNATIVE']);
  assert.equal(main.recs.length, 8);
  assert.equal(main.relations.find((x: any) => x.id === 1006).adult, true, 'the adult flag is not kept raw');
});

test('a library switched off between two requests is not asked about', { skip }, async () => {
  // One id a request; the library is switched off as the first request is answered -- after the ids were chosen.
  onFirstRelated = async () => { await q(`UPDATE libraries SET anilist_lookup = false WHERE id = $1`, [ON2]); };
  const r = await related.refreshAniListRelated({ gapMs: 0, chunk: 1 });
  // Reintroduce by asking each chunk as chosen (drop the read before the request): 1020 is asked.
  const ids = relatedAsked().flatMap((a) => a.ids);
  assert.ok(!ids.includes(1020), `asked about an entry of a library switched off mid-round: ${ids}`);
  assert.equal(r.skipped, 1);
  assert.equal(await rowOf('1020'), undefined);
  assert.equal(relatedAsked().length, 4, 'one id a request');
});

test('a fresh row is not asked again, a stale one is, and a failure leaves what is stored', { skip }, async () => {
  await related.refreshAniListRelated({ gapMs: 0 });
  asked.length = 0;
  assert.equal((await related.refreshAniListRelated({ gapMs: 0 })).asked, 0, 'a fresh row was asked again');
  assert.equal(relatedAsked().length, 0);
  await q(`UPDATE anilist_related SET fetched_at = now() - interval '8 days' WHERE anilist_id = '1001'`);
  const again = await related.refreshAniListRelated({ gapMs: 0 });
  assert.deepEqual(relatedAsked().flatMap((a) => a.ids), [1001], 'a week-old row is not asked again');
  assert.equal(again.asked, 1);
  // AniList down: the round throws, so the next tries again -- and nothing stored is lost.
  failRelated = true;
  await q(`UPDATE anilist_related SET fetched_at = now() - interval '8 days' WHERE anilist_id = '1001'`);
  await assert.rejects(related.refreshAniListRelated({ gapMs: 0 }), /anilist 500/);
  const row = await rowOf('1001');
  assert.equal(row.relations.length, 6, 'a failure wiped the stored answer');
  assert.ok(Date.now() - new Date(row.fetched_at).getTime() > 7 * 24 * 3600_000, 'a failure counted as an answer');
});

test('no page asks AniList: Related, Because you read and More like this read the table only', { skip }, async () => {
  await read('s_rel_main');
  const r = await get('/api/series/s_rel_main/related');
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(r.json(), { lookups: true, content: [] });
  const b = await get('/api/discover/because');
  assert.equal(b.status, 200, b.body);
  assert.deepEqual(b.json(), { seed: null, content: [] });
  const s = await get('/api/series/s_rel_main/similar');
  assert.equal(s.status, 200, s.body);
  assert.deepEqual((s.json().content as any[]).map((x) => x.id), ['s_genre_match'], 'More like this without a row is the genre matches');
  // Reintroduce by asking on a miss (fetchAniListRelated in relatedFor when the row is absent): AniList is asked.
  assert.equal(anyAniList(), 0, `a page asked AniList: ${JSON.stringify(asked)}`);
});

test('Related: held works as the library\'s series, the rest as AniList\'s, and nothing a viewer may not see', { skip }, async () => {
  await store(1001);
  const shape = (body: any) => (body.content as any[]).map((c) => [c.relation, c.series?.id ?? `al:${c.outside?.anilistId}`]);
  // Hiding 18+ (the default): the held main story in the 18+ library is left out, and so is the adult side story.
  const hiding = await get('/api/series/s_rel_main/related');
  assert.equal(hiding.status, 200, hiding.body);
  assert.equal(hiding.json().lookups, true);
  assert.deepEqual(shape(hiding.json()), [
    ['SEQUEL', 's_rel_sequel'], ['PREQUEL', 'al:1005'], ['SPIN_OFF', 's_rel_named'], ['ALTERNATIVE', 'al:1007'],
  ]);
  // Never named -- not as the library's series, not as AniList's entry. Reintroduce by showing a held work the viewer may
  // not list as an outside card (or as itself): "Rel Parent Hidden" is in the answer.
  assert.doesNotMatch(hiding.body, /Rel Parent Hidden|s_rel_hidden/, 'a held work the viewer may not see is named');
  assert.ok(!(hiding.json().content as any[]).some((c) => c.outside?.anilistId === 1003), 'a held work the viewer may not see is shown as AniList\'s');
  assert.doesNotMatch(hiding.body, /Rel Side Adult/, 'an 18+ entry is shown to a viewer hiding 18+');
  const outside = (hiding.json().content as any[]).find((c) => c.outside)?.outside;
  assert.deepEqual(outside, { anilistId: 1005, title: 'Rel Prequel Outside', cover: 'https://s4.anilist.co/c/1005.jpg', format: 'MANGA', status: 'RELEASING', score: 70 });
  const sequel = (hiding.json().content as any[])[0].series;
  assert.equal(sequel.metadata.title, 'Rel Sequel', 'not the library\'s series');
  assert.ok(sequel.yomi, 'the held series is not enriched like every rail');
  // Showing 18+: both are there, the held one as the library's series.
  const showing = await get('/api/series/s_rel_main/related?adult=1');
  assert.deepEqual(shape(showing.json()), [
    ['SEQUEL', 's_rel_sequel'], ['PREQUEL', 'al:1005'], ['PARENT', 's_rel_hidden'], ['SIDE_STORY', 'al:1006'], ['SPIN_OFF', 's_rel_named'],
    ['ALTERNATIVE', 'al:1007'],
  ]);
  // Capped below 18, whatever it asks: neither.
  const capped = await get('/api/series/s_rel_main/related?adult=1', users.capped);
  assert.deepEqual(shape(capped.json()), [
    ['SEQUEL', 's_rel_sequel'], ['PREQUEL', 'al:1005'], ['SPIN_OFF', 's_rel_named'], ['ALTERNATIVE', 'al:1007'],
  ]);
  assert.doesNotMatch(capped.body, /Rel Parent Hidden|Rel Side Adult/);
  // A series the viewer may not open is a 404, like every by-id route.
  assert.equal((await get('/api/series/s_rel_hidden/related?adult=1', users.capped)).status, 404);
  assert.equal((await get('/api/series/s_nope/related')).status, 404);
});

test('Related says nothing for a library whose lookups are off, or a series with no checked link', { skip }, async () => {
  await store(1010);
  // A row exists (another library linked the entry, or lookups were on once): still nothing. Reintroduce by reading the
  // row whatever the library says: Off Sequel is shown.
  const off = await get('/api/series/s_rel_off/related');
  assert.equal(off.status, 200, off.body);
  assert.deepEqual(off.json(), { lookups: false, content: [] });
  const unchecked = await get('/api/series/s_rel_unchecked/related');
  assert.deepEqual(unchecked.json(), { lookups: false, content: [] });
  const none = await get('/api/series/s_rel_named/related');
  assert.deepEqual(none.json(), { lookups: false, content: [] });
  assert.equal(anyAniList(), 0);
});

test('Because you read: the latest read that leaves four, less what the server holds and what is 18+', { skip }, async () => {
  await store(1001);
  await store(1002);
  // Rel Sequel was read last, but leaves three once Rec Held By Entry (held) is out: Rel Main is the seed.
  await read('s_rel_main', 's_rel_sequel');
  const titles = (body: any) => (body.content as any[]).map((t) => t.title);
  const hiding = await get('/api/discover/because');
  assert.equal(hiding.status, 200, hiding.body);
  assert.deepEqual(hiding.json().seed, { id: 's_rel_main', title: 'Rel Main' }, 'not the first seed that leaves four');
  // Reintroduce by keeping what is held: Rec Held By Entry (by its AniList entry) and Rec Named Work (by name) are on it.
  assert.deepEqual(titles(hiding.json()), ['Rec Five', 'Rec Six', 'Rec Seven', 'Rec Eight'], 'what the server holds, or what is 18+, is on the rail');
  const card = hiding.json().content[0];
  assert.deepEqual(card, { id: 2005, title: 'Rec Five', cover: 'https://s4.anilist.co/c/2005.jpg', banner: null, description: '', genres: ['Action'],
    score: 70, chapters: null, status: 'RELEASING' }, 'not the trending shape');
  // Showing 18+: the adult one and the one in an adult genre are on it.
  const showing = await get('/api/discover/because?adult=1');
  assert.deepEqual(titles(showing.json()), ['Rec Adult', 'Rec Ecchi', 'Rec Five', 'Rec Six', 'Rec Seven', 'Rec Eight']);
  // The admin's display title names the seed.
  await q(`INSERT INTO series_overrides (series_id, title) VALUES ('s_rel_main', 'Main As Shown')`);
  assert.deepEqual((await get('/api/discover/because')).json().seed, { id: 's_rel_main', title: 'Main As Shown' });
  // The seed must be one the viewer may list, in a library that looks things up.
  await q(`UPDATE libraries SET anilist_lookup = false WHERE id = $1`, [ON]);
  assert.deepEqual((await get('/api/discover/because')).json(), { seed: null, content: [] }, 'a library whose lookups are off seeds the rail');
  assert.equal(anyAniList(), 0);
});

test('Because you read is behind the canDownload gate, as everything on Discover is', { skip }, async () => {
  await q(`UPDATE users SET perms = '{"canDownload": false}'::jsonb WHERE id = $1`, [users.reader]);
  try {
    assert.equal((await get('/api/discover/because')).status, 403);
    assert.equal((await get('/api/discover/trending?country=JP')).status, 403);
  } finally {
    await q(`UPDATE users SET perms = '{}'::jsonb WHERE id = $1`, [users.reader]);
  }
});

test('More like this leads with the held recommendations, then the genre matches, each once', { skip }, async () => {
  await store(1001);
  const s = await get('/api/series/s_rel_main/similar');
  assert.equal(s.status, 200, s.body);
  // Reintroduce the genre matches alone: Rec Held Series and Rec Named Work are missing, and Genre Match is first.
  assert.deepEqual((s.json().content as any[]).map((x) => x.id), ['s_rec_held', 's_rec_named', 's_genre_match']);
  // The capped account is shown the same: none of these is 18+.
  const c = await get('/api/series/s_rel_main/similar', users.capped);
  assert.deepEqual((c.json().content as any[]).map((x) => x.id), ['s_rec_held', 's_rec_named', 's_genre_match']);
  assert.equal(anyAniList(), 0);
});

test('the trending rails: one cache per country, novels never asked for, adult genres left out for a viewer hiding 18+', { skip }, async () => {
  const titles = async (url: string) => {
    const r = await get(url);
    assert.equal(r.status, 200, r.body);
    return (r.json().content as any[]).map((t) => t.title);
  };
  // Hiding 18+: the Ecchi title (case aside) is not on the rail. Reintroduce the unfiltered answer: it is.
  assert.deepEqual(await titles('/api/discover/trending?country=JP'), ['Trend Japan'], 'an adult-genre title shown to a viewer hiding 18+');
  const jp = asked.filter((a): a is Extract<Asked, { kind: 'trending' }> => a.kind === 'trending');
  assert.deepEqual(jp.map((a) => a.country), ['JP', 'JP'], 'not page 1 and page 2 of Japan');
  // Reintroduce the hard-coded country, or the novels: these fail.
  assert.match(jp[0].query, /\$country:CountryCode/);
  assert.match(jp[0].query, /countryOfOrigin:\$country/);
  assert.match(jp[0].query, /format_not_in:\[NOVEL\]/, 'light novels are asked for');
  assert.match(jp[0].query, /isAdult:false/);
  // The answer is filtered, never the cache: showing 18+, the same cached pull has it.
  assert.deepEqual(await titles('/api/discover/trending?country=jp&adult=1'), ['Trend Japan', 'Trend Japan Ecchi']);
  assert.equal(asked.length, 2, 'the cache was not used');
  // Each country its own: Korea is the default, China asked for by name.
  assert.deepEqual(await titles('/api/discover/trending'), ['Trend Korea']);
  assert.deepEqual(await titles('/api/discover/trending?country=CN'), ['Trend China']);
  assert.deepEqual(asked.map((a) => (a.kind === 'trending' ? a.country : a.kind)), ['JP', 'JP', 'KR', 'KR', 'CN', 'CN']);
  assert.equal((await get('/api/discover/trending?country=US')).status, 400);
  assert.equal((await get('/api/discover/trending?country=KR&country=JP')).status, 400);
});
