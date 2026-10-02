// One rate limit for every MangaDex source (v0.52.0, #123).
//
// MangaDex in five languages is five adapters and ONE address to MangaDex's limit. Before v0.52.0 nothing spaced
// MangaDex's requests and a 429 was thrown with the headers that said how long to wait; with an adapter per
// language, that would be five sources each earning its own 429. These pin the shared limiter (sources/mangadex.ts
// mdGet): a 429 one language earns holds the others back until the moment MangaDex named; a pause too long to wait
// is refused without a request, as our own timeout; starts are spaced across adapters, /at-home/server on a spacing
// of its own; a 200 that says nothing is left pauses ahead of time; and the list import and the reading-direction
// lookup come through the same door. Real time, kept short: the pauses here are one or two seconds.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeMangadex, mangadexOriginalLanguages, _setMangadexPacing, _resetMangadexLimiter } from '../src/lib/sources/mangadex';
import { titlesFromMangadexList } from '../src/lib/mangadexList';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; _resetMangadexLimiter(); _setMangadexPacing(null); });

/** Answer every request with `answer(url)`, and write down when each one was SENT. */
function serve(answer: (u: URL) => Response): Array<{ url: URL; at: number }> {
  const log: Array<{ url: URL; at: number }> = [];
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    log.push({ url, at: Date.now() });
    return answer(url);
  }) as typeof fetch;
  return log;
}
const ok = (body: unknown = { data: [] }, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const tooMany = (headers: Record<string, string>) => new Response('{}', { status: 429, headers });
/** MangaDex's X-RateLimit-Retry-After: a moment in epoch seconds, one or two seconds from now. */
const soon = () => Math.ceil(Date.now() / 1000) + 1;
const langOf = (u: URL) => u.searchParams.get('availableTranslatedLanguage[]');

test("a 429 in one language holds every other language back until MangaDex's moment", async () => {
  // Reintroduce by keeping the pause per adapter (a `pausedUntil` inside makeMangadex): MangaDex (PT-BR) is
  // asked at once, and "PT-BR was asked before the pause ended" fails.
  _setMangadexPacing({ apiGapMs: 0 });
  const until = soon();
  const log = serve((u) => (langOf(u) === 'es-la' ? tooMany({ 'x-ratelimit-retry-after': String(until) }) : ok()));
  await assert.rejects(makeMangadex('es-419').search('x'), /mangadex 429/);
  await makeMangadex('pt-BR').search('x');
  const pt = log.find((r) => langOf(r.url) === 'pt-br');
  assert.ok(pt, 'MangaDex (PT-BR) was never asked');
  assert.ok(pt!.at >= until * 1000, `PT-BR was asked before the pause ended (${until * 1000 - pt!.at} ms early)`);
});

test('a pause longer than the patience is refused at once, without a request, as our own timeout', async () => {
  // Reintroduce by sleeping out any pause however long (drop the maxWaitMs check in turn()): the second call waits
  // the thirty seconds, asks, and fails as a plain 429 -- "refused as our own timeout" fails.
  _setMangadexPacing({ apiGapMs: 0, maxWaitMs: 200 });
  const log = serve(() => tooMany({ 'retry-after': '30' }));
  await assert.rejects(makeMangadex('fr').search('x'), /mangadex 429/);
  const sent = log.length;
  const t0 = Date.now();
  const err = await makeMangadex('de').popular!(1).then(() => null, (e: unknown) => e as { selfTimeout?: boolean; message?: string });
  assert.ok(err?.selfTimeout, 'refused as our own timeout, so Discover records "slow", not a cooldown, for German');
  assert.match(String(err?.message), /rate limit/, 'the downloader reads it as rate_limited');
  assert.equal(log.length, sent, 'a request was sent during the pause');
  assert.ok(Date.now() - t0 < 150, 'it waited instead of refusing');
});

test('starts are spaced across adapters: three languages asking at once are a gap apart, never a burst', async () => {
  // Reintroduce by not reserving the slot before the wait (`nextAt` set after the sleep): all three go together.
  _setMangadexPacing({ apiGapMs: 120 });
  const log = serve(() => ok());
  await Promise.all(['es-419', 'pt-BR', 'fr'].map((c) => makeMangadex(c).search('x')));
  const at = log.map((r) => r.at).sort((a, b) => a - b);
  assert.equal(at.length, 3);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 118, `two starts ${at[i] - at[i - 1]} ms apart`);
});

test('/at-home/server keeps a spacing of its own, and API requests do not queue behind it', async () => {
  // Reintroduce by giving getPageUrls the API's kind: the two page lookups go out together (gap 0).
  _setMangadexPacing({ apiGapMs: 0, atHomeGapMs: 150 });
  const log = serve((u) => (u.pathname.startsWith('/at-home')
    ? ok({ baseUrl: 'https://uploads.example', chapter: { hash: 'h', data: ['1.png'] } })
    : ok({ data: null })));
  const a = makeMangadex('es-419');
  await Promise.all([a.getPageUrls('c-1'), a.getPageUrls('c-2'), a.getSeries('m-1')]);
  const home = log.filter((r) => r.url.pathname.startsWith('/at-home')).map((r) => r.at).sort((x, y) => x - y);
  const api = log.find((r) => r.url.pathname.startsWith('/manga/'))!.at;
  assert.ok(home[1] - home[0] >= 148, `two /at-home lookups ${home[1] - home[0]} ms apart`);
  assert.ok(api - home[0] < 100, 'a title lookup waited for the /at-home spacing');
});

test('a 200 that says nothing is left pauses ahead of time, instead of spending a request on a 429', async () => {
  // Reintroduce by dropping the X-RateLimit-Remaining read in mdGet: the next request goes out at once.
  _setMangadexPacing({ apiGapMs: 0 });
  const until = soon();
  let first = true;
  const log = serve(() => {
    const h = first ? { 'x-ratelimit-remaining': '0', 'x-ratelimit-retry-after': String(until) } : {};
    first = false;
    return ok({ data: [] }, h);
  });
  await makeMangadex('it').search('a');
  await makeMangadex('ru').search('b');
  assert.equal(log.length, 2);
  assert.ok(log[1].at >= until * 1000, `the next request went out ${until * 1000 - log[1].at} ms before the window reopened`);
});

test('the list import and the reading-direction lookup wait for the same pause', async () => {
  // Reintroduce by putting lib/mangadexList.ts back on a bare fetch: it asks MangaDex in the middle of the pause,
  // and "a request went out during the pause" fails.
  _setMangadexPacing({ apiGapMs: 0, maxWaitMs: 100 });
  const log = serve(() => tooMany({ 'retry-after': '60' }));
  await assert.rejects(makeMangadex('ko').search('x'), /mangadex 429/);
  const sent = log.length;
  await assert.rejects(titlesFromMangadexList('https://mangadex.org/list/00000000-0000-4000-8000-000000000001/mine'), /slow down/);
  await assert.rejects(mangadexOriginalLanguages(['00000000-0000-4000-8000-000000000002']), /rate limit/);
  assert.equal(log.length, sent, 'a request went out during the pause');
});
