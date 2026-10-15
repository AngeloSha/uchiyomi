// Metadata from Kitsu and MangaUpdates (lib/trackerMeta.ts): used only when the entry is named as the series is, and a
// service that is down is a miss, never an error. No database: `fetch` answers the two hosts from a router.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

const urls: string[] = [];
let kitsuBody: unknown = { data: [] };
let kitsuStatus = 200;
let muBody: unknown = { results: [] };
let muThrows = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init?: any) => {
  const url = new URL(String(u));
  if (url.hostname === 'kitsu.io') { urls.push(String(u)); return new Response(JSON.stringify(kitsuBody), { status: kitsuStatus }); }
  if (url.hostname === 'api.mangaupdates.com') {
    urls.push(String(u));
    if (muThrows) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(muBody), { status: 200 });
  }
  return realFetch(u, init);
}) as typeof fetch;
const reset = () => { urls.length = 0; kitsuBody = { data: [] }; kitsuStatus = 200; muBody = { results: [] }; muThrows = false; };

const kitsuEntry = (canonicalTitle: string, extra: Record<string, unknown> = {}) => ({
  id: '1', attributes: {
    canonicalTitle, titles: { en: canonicalTitle }, abbreviatedTitles: [],
    synopsis: '<p>A boy meets a <b>ghost</b>.</p>', posterImage: { large: 'https://img/p.jpg' }, coverImage: { original: 'https://img/c.jpg' }, ...extra,
  },
  relationships: { categories: { data: [{ id: 'c1' }] } },
});

test('a Kitsu entry named as the series is gives cover, banner, a plain-text summary and genres', async () => {
  const { fetchTrackerMeta } = await import('../src/lib/trackerMeta');
  reset();
  kitsuBody = { data: [kitsuEntry('Ghost Boy')], included: [{ type: 'categories', id: 'c1', attributes: { title: 'Horror' } }] };
  const m = await fetchTrackerMeta('Ghost Boy (Official)', ['Ghost Boy']);
  assert.deepEqual(m, { source: 'kitsu', cover: 'https://img/p.jpg', banner: 'https://img/c.jpg', summary: 'A boy meets a ghost.', genres: ['Horror'] });
  assert.match(urls[0], /filter%5Btext%5D=Ghost%20Boy&|filter\[text\]=Ghost%20Boy&/, 'a bracketed aside is not sent');
  assert.equal(urls.length, 1, 'MangaUpdates is not asked once Kitsu answered');
});

test('an entry that only resembles the series is another work and is not taken', async () => {
  const { fetchTrackerMeta } = await import('../src/lib/trackerMeta');
  reset();
  kitsuBody = { data: [kitsuEntry('Ghost Boy: Dark Novels')] };
  muBody = { results: [{ record: { title: 'Ghost Boy 2', description: 'x', image: { url: { original: 'https://mu/c.jpg' } }, genres: [] } }] };
  assert.equal(await fetchTrackerMeta('Ghost Boy', ['Ghost Boy']), null);
  assert.equal(urls.length, 2, 'both were asked and both declined');
});

test('MangaUpdates answers when Kitsu has nothing, by its primary title', async () => {
  const { fetchTrackerMeta } = await import('../src/lib/trackerMeta');
  reset();
  muBody = { results: [{ record: { title: 'Ghost Boy', description: 'A ghost.\n  \nMore', image: { url: { original: 'https://mu/c.jpg' } }, genres: [{ genre: 'Drama' }, { genre: 'Mystery' }] } }] };
  assert.deepEqual(await fetchTrackerMeta('Ghost Boy', ['Ghost Boy']),
    { source: 'mangaupdates', cover: 'https://mu/c.jpg', banner: null, summary: 'A ghost.\nMore', genres: ['Drama', 'Mystery'] });
});

test('a service that is down is a miss, and an entry with nothing to give is skipped', async () => {
  const { fetchTrackerMeta } = await import('../src/lib/trackerMeta');
  reset();
  kitsuStatus = 503; muThrows = true;
  assert.equal(await fetchTrackerMeta('Ghost Boy', ['Ghost Boy']), null);
  reset();
  kitsuBody = { data: [kitsuEntry('Ghost Boy', { synopsis: null, posterImage: null, coverImage: null })] };
  muBody = { results: [{ record: { title: 'Ghost Boy', description: 'From MU', image: null, genres: [] } }] };
  assert.equal((await fetchTrackerMeta('Ghost Boy', ['Ghost Boy']))?.source, 'mangaupdates');
  assert.equal(await fetchTrackerMeta('(only an aside)', ['x']), null, 'nothing to ask by');
});

test('a description is plain text: no tag survives, even one nested inside another', async () => {
  const { strip } = await import('../src/lib/trackerMeta');
  assert.equal(strip('A <b>bold</b> start'), 'A bold start');
  assert.equal(strip('<scr<b>ipt>alert(1)</script>'), 'alert(1)', 'a tag nested inside another goes too, and what remains has no brackets');
  assert.ok(!/[<>]/.test(String(strip('x <<img src=x onerror=1>> y <'))), 'no angle bracket is left');
  assert.equal(strip('<p></p>'), null);
  assert.equal(strip(42), null);
});
