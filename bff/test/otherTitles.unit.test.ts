// AniList's three titles of an entry (lib/anilist.ts fetchAniListTitles): asked by id at ANILIST_API_URL, trimmed, and a
// failure thrown rather than answered as "no names" (lib/otherTitles.ts would keep that for a day).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.ANILIST_API_URL = 'http://anilist.example/graphql';

const answer = (body: unknown, status = 200) => async (_u: any, init: any) => {
  seen.push({ url: String(_u), body: JSON.parse(init.body) });
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
};
const seen: Array<{ url: string; body: any }> = [];

test('reads the entry by id, trims the names and nulls the missing ones', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = answer({ data: { Media: { title: { romaji: ' Sousou no Frieren ', english: 'Frieren: Beyond Journey’s End', native: '' } } } }) as any;
  try {
    const { fetchAniListTitles } = await import('../src/lib/anilist');
    const t = await fetchAniListTitles(118586);
    assert.deepEqual(t, { english: 'Frieren: Beyond Journey’s End', romaji: 'Sousou no Frieren', native: null });
    assert.equal(seen.at(-1)!.url, 'http://anilist.example/graphql');
    assert.equal(seen.at(-1)!.body.variables.id, 118586);
  } finally { globalThis.fetch = real; }
});

test('an entry AniList does not have is null; a server error throws', async () => {
  const real = globalThis.fetch;
  try {
    const { fetchAniListTitles } = await import('../src/lib/anilist');
    globalThis.fetch = answer({ errors: [{ message: 'Not Found.' }], data: { Media: null } }, 404) as any;
    assert.equal(await fetchAniListTitles(1), null);
    globalThis.fetch = answer({}, 500) as any;
    await assert.rejects(fetchAniListTitles(1), /anilist 500/);
  } finally { globalThis.fetch = real; }
});
