// A Madara site whose search answers with another page fails the listing rather than handing back that page's widgets
// as results (v0.60.0, engines/madara.ts isListingPage). Through the engine's own adapter and the real solver client,
// against a fake FlareSolverr that answers the way the sites did on 2026-10-11: ManhuaPlus with its /home for every
// search, Newest and Popular; a stock Madara site with its search page.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
delete process.env.FLARESOLVERR_FALLBACK_URL;

const CARD = (slug: string, title: string) => `<div class="row c-tabs-item__content"><div class="tab-thumb"><a href="https://site.example/manga/${slug}/"><img alt="${title}" src="https://site.example/c/${slug}.jpg"></a></div>
<div class="tab-summary"><div class="post-title"><h3 class="h4"><a href="https://site.example/manga/${slug}/">${title}</a></h3></div></div></div>`;
const WIDGET = (slug: string, title: string) => `<article><div class="item-thumbnail"><a href="https://gone.example/manga/${slug}"><img alt="${title}" src="https://gone.example/c/${slug}.jpg"></a></div>
<h3 class="post-title"><a href="https://gone.example/manga/${slug}"> ${title} </a></h3></article>`;
const SEARCH = `<html><body class="archive search search-results post-type-archive post-type-archive-wp-manga">${CARD('love-story', 'Love Story')}${CARD('lovely', 'Lovely')}</body></html>`;
const HOME = `<html><body id='modeSwitch'>${WIDGET('demon-magic-emperor', 'Magic Emperor')}${WIDGET('martial-peak', 'Martial Peak')}</body></html>`;

let srv: Server;
let madara: typeof import('../src/lib/sources/engines/madara');
before(async () => {
  srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { url } = JSON.parse(body || '{}');
      const html = new URL(String(url)).hostname === 'gone.example' ? HOME : SEARCH;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', message: '', solution: { url, status: 200, response: html, cookies: [], userAgent: 'UA' } }));
    });
  });
  await new Promise<void>((go) => srv.listen(0, '127.0.0.1', go));
  process.env.FLARESOLVERR_URL = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  madara = await import('../src/lib/sources/engines/madara');
});
after(() => { srv.close(); });

test('a search the site answers with its homepage fails, on every listing', async () => {
  // Reintroduce by parsing whatever came back (drop the isListingPage check in `listing`): "love" finds Magic Emperor.
  const gone = madara.makeMadara({ id: 'gone', name: 'Gone Site', base: 'https://gone.example' });
  await assert.rejects(gone.search('love'), (e: any) => e?.statusCode === 502 && /not a listing/.test(e.message), 'search');
  await assert.rejects(gone.latest!(1), /not a listing/, 'Newest');
  await assert.rejects(gone.popular!(2), /not a listing/, 'Popular');
});

test('a real search page still lists its results', async () => {
  const site = madara.makeMadara({ id: 'site', name: 'Site', base: 'https://site.example' });
  assert.deepEqual((await site.search('love')).map((r) => r.title), ['Love Story', 'Lovely']);
  assert.deepEqual((await site.latest!(1)).map((r) => r.title), ['Love Story', 'Lovely']);
});
