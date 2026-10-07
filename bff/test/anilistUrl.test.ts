// ANILIST_API_URL (v0.55.7): the test knob the tracker calls read (lib/trackerProviders.ts) moves the title and id
// lookups too (lib/anilist.ts) -- the art lookup, the anime banner, the Art picker's candidates, Discover's Trending
// rail, and the by-id reads of the online-match check and the direction backfill. The browser walk points it at a fake
// AniList (web/test/e2e/fakeAniList.mjs), so no walk asks the real one. Unset, it is AniList's own endpoint.
// Reintroduce the hard-coded address in any one lookup: "every AniList lookup goes where ANILIST_API_URL says" fails.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
// Read once, when the module loads: set before the import below.
process.env.ANILIST_API_URL = 'http://anilist.example/graphql/';

test('every AniList lookup goes where ANILIST_API_URL says, with its trailing slash dropped', async () => {
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: any) => {
    asked.push(String(u));
    return new Response(JSON.stringify({ data: { Media: null, Page: { media: [] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const al = await import('../src/lib/anilist');
    await al.fetchAniListArt('Walk Nightfall', ['Walk Nightfall']);
    await al.fetchAnimeBanner('Walk Nightfall', ['Walk Nightfall']);
    await al.fetchAniListCandidates('Walk Nightfall');
    await al.fetchTrendingManhwa(1);
    await al.fetchAniListEntries([970002]);
    await al.fetchAniListCountries([970002]);
    assert.equal(asked.length, 6, JSON.stringify(asked));
    assert.deepEqual([...new Set(asked)], ['http://anilist.example/graphql'], 'every AniList lookup goes where ANILIST_API_URL says');
  } finally {
    globalThis.fetch = realFetch;
  }
});
