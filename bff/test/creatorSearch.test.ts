import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeMangadex, _setMangadexPacing, _resetMangadexLimiter } from '../src/lib/sources/mangadex';

const originalFetch = globalThis.fetch;
const person = '11111111-1111-4111-8111-111111111111';
before(() => _setMangadexPacing({ apiGapMs: 0, atHomeGapMs: 0 }));
after(() => { globalThis.fetch = originalFetch; _setMangadexPacing(null); _resetMangadexLimiter(); });

test('creator search resolves names and uses the chosen relationship, language and page', async () => {
  const urls: URL[] = [];
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input)); urls.push(u);
    return new Response(JSON.stringify({ data: u.pathname === '/author' ? [{ id: person }] : [{ id: 'work', attributes: { title: { en: 'A different title' } } }] }));
  }) as typeof fetch;
  const en = makeMangadex('en'), es = makeMangadex('es-419');
  const [writers, artists] = await Promise.all([
    en.searchCreator!('Creator Shared Query', 'author'), es.searchCreator!('Creator Shared Query', 'artist', 2),
  ]);
  assert.equal(urls.filter((u) => u.pathname === '/author').length, 1, 'language fan-out must share the name lookup');
  const manga = urls.filter((u) => u.pathname === '/manga');
  const author = manga.find((u) => u.searchParams.has('authors[]'))!;
  const artist = manga.find((u) => u.searchParams.has('artists[]'))!;
  assert.equal(author.searchParams.get('authors[]'), person);
  assert.equal(author.searchParams.get('availableTranslatedLanguage[]'), 'en');
  assert.equal(artist.searchParams.get('artists[]'), person);
  assert.equal(artist.searchParams.get('availableTranslatedLanguage[]'), 'es-la');
  assert.equal(artist.searchParams.get('offset'), '100');
  assert.ok(manga.every((u) => !u.searchParams.has('title')), 'a creator name is never a title query');
  assert.equal(writers[0].title, 'A different title');
  assert.equal(artists[0].source, 'mangadex-es-419');
});

test('unknown and blank creators never fall back to title search', async () => {
  const urls: URL[] = [];
  globalThis.fetch = (async (input: any) => { urls.push(new URL(String(input))); return new Response('{"data":[]}'); }) as typeof fetch;
  const adapter = makeMangadex('en');
  assert.deepEqual(await adapter.searchCreator!('', 'author'), []);
  assert.deepEqual(await adapter.searchCreator!('No Such Creator', 'author'), []);
  assert.deepEqual(urls.map((u) => u.pathname), ['/author']);
});

test('a failed name lookup can be retried instead of caching an outage', async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(calls === 1 ? '' : '{"data":[]}', { status: calls === 1 ? 503 : 200 }); }) as typeof fetch;
  const adapter = makeMangadex('en');
  await assert.rejects(adapter.searchCreator!('Retry Creator', 'artist'), /503/);
  assert.deepEqual(await adapter.searchCreator!('Retry Creator', 'artist'), []);
  assert.equal(calls, 2);
});
