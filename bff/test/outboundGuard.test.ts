// Fetches of URLs a site, a source or a caller named stay on the public internet, carry the engine's credentials to the
// engine only, and stop reading at a byte cap (lib/safeFetch.ts, used by the downloader's page fetch, the source icon
// lookup and the cover proxy).
//
// The audit had the downloader fetch a loopback page URL from a site's HTML and store the internal service's answer
// as a member-readable page; the icon lookup follow a favicon redirect into the network; the cover proxy attach an
// engine source's Basic credentials to a caller's own host; and a 49 KB gzip response decode into a 48 MiB buffer.
// Loopback servers stand in for "the internal network" and a fetch stub for the public site. No database.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DL_ROOT = mkdtempSync(join(tmpdir(), 'uy-outbound-'));
process.env.DOWNLOAD_PAGE_GAP_MS = '0';
process.env.DOWNLOAD_MIN_GAP_MS = '0';
process.env.MIN_FREE_GB = '0';
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';

const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
let internal: Server, engine: Server;
let internalHits: Array<{ url: string; auth?: string }> = [];
let engineHits: Array<{ url: string; auth?: string }> = [];
let internalBase = '', engineBase = '';
const realFetch = globalThis.fetch;

const serve = (hits: typeof internalHits) => createServer((req, res) => {
  hits.push({ url: req.url || '', auth: req.headers.authorization });
  if (req.url === '/huge.gz') {
    res.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'gzip' });
    return res.end(gzipSync(Buffer.alloc(48 * 1024 * 1024)));
  }
  res.writeHead(200, { 'content-type': 'image/png' });
  res.end(PIXEL);
});

before(async () => {
  internal = serve(internalHits);
  engine = serve(engineHits);
  await new Promise<void>((go) => internal.listen(0, '127.0.0.1', go));
  await new Promise<void>((go) => engine.listen(0, '127.0.0.1', go));
  internalBase = `http://127.0.0.1:${(internal.address() as AddressInfo).port}`;
  engineBase = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
  process.env.SUWAYOMI_URL = engineBase;     // read once, at module load: set before any import below
  process.env.SUWAYOMI_USERNAME = 'engine-user';
  process.env.SUWAYOMI_PASSWORD = 'engine-pass';
  // The "public site": https://site.invalid answers a page, or a 302 into the internal network. Followed the way
  // fetch's default `redirect: 'follow'` follows, so the code that did not check hops would really be walked in.
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = String(input instanceof URL ? input.href : input);
    if (u.startsWith('https://site.invalid/redirect')) {
      const loc = `${internalBase}/secret.png`;
      if (init?.redirect === 'manual') return new Response(null, { status: 302, headers: { location: loc } });
      return realFetch(loc, init);
    }
    if (u.startsWith('https://site.invalid/')) return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
    return realFetch(input, init);
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((r) => internal.close(r));
  await new Promise((r) => engine.close(r));
});

const site = (id: string) => ({
  id, name: id, async search() { return []; }, async getSeries() { return null; },
  async listChapters() { return []; }, async getPageUrls() { return []; },
});

test('the downloader does not fetch a page URL on the internal network, directly or through a redirect', async () => {
  // Reintroduce by going back to fetch(u) in fetchPages: the internal server is asked twice and its answers
  // become pages 1 and 2.
  const { fetchPages } = await import('../src/lib/downloader');
  internalHits.length = 0;
  const r = await fetchPages(site('og-site') as any, [`${internalBase}/admin/export`, 'https://site.invalid/redirect', 'https://site.invalid/p3.png'],
    [0, 1, 2], { chapterSourceId: 'https://site.invalid/ch1', gap: 0, workers: 1 });
  assert.equal(internalHits.length, 0, `the internal network was asked: ${JSON.stringify(internalHits)}`);
  assert.equal(r.page[0], null);
  assert.equal(r.page[1], null);
  assert.ok(r.page[2]?.equals(PIXEL), 'an ordinary public page still downloads');
});

test("an engine source's pages come from the engine with its credentials; nobody else gets either", async () => {
  const { fetchPages } = await import('../src/lib/downloader');
  const { makeSuwayomiAdapter } = await import('../src/lib/sources/suwayomi/sources');
  const sw = makeSuwayomiAdapter({ id: '42', name: 'Ext', lang: 'en' } as any);
  engineHits.length = 0;
  const ok = await fetchPages(sw, [`${engineBase}/api/v1/manga/1/chapter/1/page/0`], [0], { chapterSourceId: 'c1', gap: 0, workers: 1 });
  assert.ok(ok.page[0], 'the engine page was fetched');
  assert.match(engineHits[0]?.auth ?? '', /^Basic /, 'with the engine credentials');
  // Reintroduce by attaching suwayomiImageHeaders() whatever the URL: the caller's host receives the engine login.
  assert.deepEqual((sw.imageHeaders as (u: string) => Record<string, string>)('https://attacker.example/cover.jpg'), {});
  // a site adapter naming the engine's address is refused like any other internal URL
  engineHits.length = 0;
  const no = await fetchPages(site('og-site2') as any, [`${engineBase}/api/v1/manga/1/thumbnail`], [0], { chapterSourceId: 'c1', gap: 0, workers: 1 });
  assert.equal(no.page[0], null);
  assert.equal(engineHits.length, 0);
});

test('a response body is counted as it is decoded, and refused past its cap', async () => {
  // Reintroduce with Buffer.from(await r.arrayBuffer()): the ~49 KB gzip body comes back as 48 MiB.
  const { readCapped, ResponseTooLarge } = await import('../src/lib/safeFetch');
  const r = await realFetch(`${internalBase}/huge.gz`);
  await assert.rejects(readCapped(r, 16 * 1024 * 1024), ResponseTooLarge);
  const small = await realFetch(`${internalBase}/ok.png`);
  assert.ok((await readCapped(small, 1024 * 1024)).equals(PIXEL));
});

test('the icon helper refuses internal hosts and redirects into them', async () => {
  const { fetchPublic, MAX_ICON_BYTES } = await import('../src/lib/safeFetch');
  internalHits.length = 0;
  assert.equal(await fetchPublic(`${internalBase}/favicon.ico`, { maxBytes: MAX_ICON_BYTES }), null);
  assert.equal(await fetchPublic('https://site.invalid/redirect', { maxBytes: MAX_ICON_BYTES }), null);
  assert.equal(internalHits.length, 0);
  const ok = await fetchPublic('https://site.invalid/favicon.ico', { maxBytes: MAX_ICON_BYTES });
  assert.ok(ok?.body.equals(PIXEL));
});
