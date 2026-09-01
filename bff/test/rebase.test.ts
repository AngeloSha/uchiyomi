// Pointing a stored series URL at wherever the site lives now.
//
// A series id is an absolute URL captured when the series was added. Aqua Manga moved from aquareader.net to
// aquareader.org, the site's `base` was updated to match, and nothing happened: every engine resolves a
// stored id as `id.startsWith('http') ? id : base + path`, so 176 of 224 series went on asking the dead host.
//
// The reason nobody noticed for weeks is the SHAPE of the failure. The old host answers a 404 *page* rather
// than an HTTP error, so the fetch succeeds, the chapter parser finds nothing in a page of prose, and zero
// chapters is indistinguishable from a series with nothing new. Every surface reported the library healthy
// while 79% of it silently stopped updating.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rebase } from '../src/lib/sources/slug';

const OLD = 'https://aquareader.net/manga/mr-devourer-please-act-like-a-final-boss/';
const BASE = 'https://aquareader.org';

test('THE DEAD DOMAIN: a stored ref follows the site to its new host', () => {
  assert.equal(rebase(OLD, BASE), 'https://aquareader.org/manga/mr-devourer-please-act-like-a-final-boss/');
});

test('the path is kept exactly: only the host moves', () => {
  const r = new URL(rebase(OLD, BASE));
  assert.equal(r.pathname, '/manga/mr-devourer-please-act-like-a-final-boss/');
  assert.equal(r.host, 'aquareader.org');
});

test('a ref already on the right host is returned untouched', () => {
  const cur = 'https://aquareader.org/manga/something/';
  assert.equal(rebase(cur, BASE), cur, 'no rewriting, no new string, nothing to go wrong');
});

test('a protocol change is followed too', () => {
  assert.equal(rebase('http://old.example/manga/x/', 'https://new.example'), 'https://new.example/manga/x/');
});

test('a relative id is left alone: the caller builds those from the base already', () => {
  assert.equal(rebase('some-slug', BASE), 'some-slug');
  assert.equal(rebase('', BASE), '');
});

test('an id that cannot be parsed is never rewritten', () => {
  // Better to ask the wrong host than to invent a URL out of something we did not understand.
  assert.equal(rebase('http://[not a url', BASE), 'http://[not a url');
  assert.equal(rebase(OLD, 'not-a-base'), OLD);
});

test('query and fragment survive', () => {
  assert.equal(
    rebase('https://old.example/manga/x/?page=2#ch3', 'https://new.example'),
    'https://new.example/manga/x/?page=2#ch3',
  );
});

// The helper passing its own tests proves nothing about whether the engines call it. This is the wiring.
test('THE WIRING: every engine resolves a stored ref against the configured base', async () => {
  const { makeMadara } = await import('../src/lib/sources/engines/madara');
  const { makeManganato } = await import('../src/lib/sources/engines/manganato');
  const { makeMangaThemesia } = await import('../src/lib/sources/engines/mangathemesia');

  const asked: string[] = [];
  globalThis.fetch = (async (_u: any, init: any) => {
    asked.push(JSON.parse(init.body).url);
    return new Response(JSON.stringify({
      status: 'ok',
      solution: { url: 'x', status: 200, response: '<html></html>', cookies: [], userAgent: 't' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;

  const engines: Array<[string, any]> = [
    ['madara', makeMadara({ id: 'm1', name: 'M1', base: 'https://new.example' })],
    ['manganato', makeManganato({ id: 'm2', name: 'M2', base: 'https://new.example' })],
    ['mangathemesia', makeMangaThemesia({ id: 'm3', name: 'M3', base: 'https://new.example' })],
  ];

  for (const [name, a] of engines) {
    asked.length = 0;
    await a.listChapters('https://old.example/manga/a-series/').catch(() => {});
    assert.ok(asked.length, `${name} made no request at all`);
    assert.ok(
      asked.every((u) => !u.includes('old.example')),
      `${name} still asked the dead host: ${asked.find((u) => u.includes('old.example'))}`,
    );
    assert.ok(
      asked.some((u) => u.includes('new.example')),
      `${name} did not ask the configured host, asked: ${asked[0]}`,
    );
  }
});
