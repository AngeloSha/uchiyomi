import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createTitleLogoProvider, TitleLogoProviderUnavailable } from '../src/lib/titleLogoProvider';
import type { PublicFetch } from '../src/lib/safeFetch';

const ID = '87216';
const QID = 'Q24862683';
const claim = (value: unknown, language?: string, rank = 'normal') => ({
  rank, mainsnak: { snaktype: 'value', datavalue: { value } },
  ...(language ? { qualifiers: { P407: [{ datavalue: { value: { id: language } } }] } } : {}),
});
const entity = (logos: unknown[] = [claim('Manga logo.svg')]) => ({
  id: QID, labels: { en: { value: 'Manga' }, ja: { value: '漫画' } }, aliases: {},
  claims: { P8731: [claim(ID)], P154: logos },
});
const reply = (url: string, value: unknown, status = 200, headers: Record<string, string> = {}): PublicFetch => ({
  url, status, headers: new Headers({ 'content-type': 'application/json', ...headers }),
  body: Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)),
});
const thumb = (name: string) => `https://thumb.wikimedia.org/wikipedia/commons/thumb/a/aa/${encodeURIComponent(name)}/1200px-${encodeURIComponent(name)}.png`;
const metadata = (name: string) => ({
  thumburl: thumb(name), mime: 'image/svg+xml',
  extmetadata: {
    Artist: { value: '<b>Example &amp; Artist</b>' },
    LicenseShortName: { value: 'Public domain' },
    LicenseUrl: { value: 'https://creativecommons.org/publicdomain/zero/1.0/' },
    ImageDescription: { value: 'The title logo for Manga' },
  },
});
const png = async (kind: 'logo' | 'opaque' | 'empty' = 'logo') => {
  const data = Buffer.alloc(64 * 24 * 4);
  for (let y = 0; y < 24; y++) for (let x = 0; x < 64; x++) {
    const p = (y * 64 + x) * 4;
    data[p] = data[p + 1] = data[p + 2] = 255;
    data[p + 3] = kind === 'opaque' || (kind === 'logo' && x > 5 && x < 58 && y > 5 && y < 18) ? 255 : 0;
  }
  return sharp(data, { raw: { width: 64, height: 24, channels: 4 } }).png().toBuffer();
};

type Fixture = {
  item?: any; search?: any; entities?: any; image?: Buffer;
  info?: (name: string) => any;
  intercept?: (url: URL, opts: any) => PublicFetch | null | undefined;
};
async function fixture(options: Fixture = {}) {
  const image = options.image ?? await png();
  const asked: Array<{ url: URL; opts: any }> = [];
  const waits: number[] = [];
  let clock = 1_700_000_000_000;
  const lookup = createTitleLogoProvider({
    now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; },
    fetchPublic: async (input, opts) => {
      const url = new URL(String(input));
      asked.push({ url, opts });
      const intercepted = options.intercept?.(url, opts);
      if (intercepted !== undefined) return intercepted;
      if (url.hostname === 'www.wikidata.org') {
        assert.equal(url.pathname, '/w/api.php');
        if (url.searchParams.get('action') === 'query') {
          assert.equal(url.searchParams.get('list'), 'search');
          assert.equal(url.searchParams.get('srsearch'), `haswbstatement:P8731=${ID}`);
          return reply(url.href, options.search ?? { query: { search: [{ title: QID }], searchinfo: { totalhits: 1 } } });
        }
        assert.equal(url.searchParams.get('action'), 'wbgetentities');
        return reply(url.href, { entities: options.entities ?? { [QID]: options.item ?? entity() } });
      }
      if (url.hostname === 'commons.wikimedia.org') {
        assert.equal(url.pathname, '/w/api.php');
        assert.equal(url.searchParams.get('prop'), 'imageinfo');
        const name = url.searchParams.get('titles')!.slice(5);
        return reply(url.href, { query: { pages: [{ title: `File:${name}`, imageinfo: [options.info?.(name) ?? metadata(name)] }] } });
      }
      assert.equal(url.hostname, 'thumb.wikimedia.org', `an unrecognised image host was fetched: ${url.href}`);
      return reply(url.href, image, 200, { 'content-type': 'image/png' });
    },
  });
  return { lookup, asked, waits, image, advance: (ms: number) => { clock += ms; } };
}

test('a checked AniList manga ID leads through verified claims to a local raster candidate and safe attribution', async () => {
  const f = await fixture();
  const r = await f.lookup(ID);
  assert.equal(r.kind, 'found');
  if (r.kind !== 'found') return;
  assert.ok(r.candidate.bytes.equals(f.image));
  assert.equal(r.candidate.language, null);
  assert.equal(r.candidate.showReadableTitle, true, 'a filename did not establish an English logo');
  assert.deepEqual(r.candidate.attribution, {
    provider: 'wikimedia', pageUrl: 'https://commons.wikimedia.org/wiki/File:Manga_logo.svg', fileName: 'Manga logo.svg',
    author: 'Example & Artist', license: 'Public domain', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  });
  assert.equal(f.asked.length, 4);
  assert.deepEqual(f.waits, [1000, 1000, 1000], 'API and image reads are serial and paced');
  for (const { opts } of f.asked) {
    assert.equal(opts.maxHops, 0, 'redirects must not escape the fixed provider endpoints');
    assert.equal(opts.timeoutMs, 10_000);
    assert.ok(opts.maxBytes > 0 && opts.maxBytes <= 8 * 1024 * 1024);
    assert.match(opts.headers['user-agent'], /Uchiyomi.*https:\/\/github\.com\/AngeloSha\/uchiyomi/);
    assert.equal(opts.headers.authorization, undefined);
  }
  for (const { url } of f.asked.filter((a) => a.url.pathname === '/w/api.php')) assert.equal(url.searchParams.get('maxlag'), '5');
});

test('only explicitly interactive metadata queries omit maxlag; both modes retain every transport guard and pacing', async () => {
  const manual = await fixture();
  assert.equal((await manual.lookup(ID, { interactive: true })).kind, 'found');
  for (const { url, opts } of manual.asked) {
    assert.equal(url.searchParams.has('maxlag'), false);
    assert.equal(opts.maxHops, 0);
    assert.equal(opts.timeoutMs, 10_000);
  }
  assert.deepEqual(manual.waits, [1000, 1000, 1000]);
  const background = await fixture();
  assert.equal((await background.lookup(ID, { interactive: false })).kind, 'found');
  for (const { url } of background.asked.filter((a) => a.url.pathname === '/w/api.php')) assert.equal(url.searchParams.get('maxlag'), '5');
  const throttled = await fixture({ intercept: (url) => reply(url.href, {}, 429, { 'retry-after': '120' }) });
  await assert.rejects(throttled.lookup(ID, { interactive: true }), (error: any) => error.retryAfterMs === 120_000);
  assert.equal(throttled.asked.length, 1, 'interactive mode does not retry a provider throttle');
});

test('qualified English wins over an original-language logo, independently of incoming order and preferred rank', async () => {
  const item = entity([claim('Manga Japanese.svg', 'Q5287', 'preferred'), claim('Manga English.svg', 'Q1860')]);
  item.claims.P364 = [claim({ id: 'Q5287' })];
  const f = await fixture({ item });
  const r = await f.lookup(ID);
  assert.equal(r.kind, 'found');
  if (r.kind === 'found') {
    assert.equal(r.candidate.attribution.fileName, 'Manga English.svg');
    assert.equal(r.candidate.language, 'en');
    assert.equal(r.candidate.showReadableTitle, false);
  }
});

test('the explicitly original language is preferred to an unclassified logo and retains a readable title', async () => {
  const item = entity([claim('Manga unclassified.svg'), claim('Manga original.svg', 'Q5287'), claim('Manga French.svg', 'Q150')]);
  item.claims.P364 = [claim({ id: 'Q5287' })];
  const f = await fixture({ item });
  const r = await f.lookup(ID);
  assert.equal(r.kind, 'found');
  if (r.kind === 'found') {
    assert.equal(r.candidate.attribution.fileName, 'Manga original.svg');
    assert.equal(r.candidate.language, 'ja');
    assert.equal(r.candidate.showReadableTitle, true);
  }
});

test('duplicate artwork statements retain the strongest explicit language qualification instead of the first statement', async () => {
  const f = await fixture({ item: entity([claim('Same logo.svg'), claim('Same logo.svg', 'Q1860')]) });
  const r = await f.lookup(ID);
  assert.equal(r.kind, 'found');
  if (r.kind === 'found') {
    assert.equal(r.candidate.language, 'en');
    assert.equal(r.candidate.showReadableTitle, false);
  }
  assert.equal(f.asked.length, 4);
});

test('unknown language stays unknown; the word English in a filename does not suppress the readable title', async () => {
  const f = await fixture({ item: entity([claim('Manga English logo.svg')]) });
  const r = await f.lookup(ID);
  assert.equal(r.kind, 'found');
  if (r.kind === 'found') assert.equal(r.candidate.language, null);
  if (r.kind === 'found') assert.equal(r.candidate.showReadableTitle, true);
});

test('an empty identity result is a real miss; arbitrary, padded and non-numeric IDs never initiate a lookup', async () => {
  const f = await fixture({ search: { query: { search: [] } } });
  for (const id of ['', ' 87216', '0', '0001', '-1', '1e3', '1|P31=Q5', 'https://example.com', '12345678901']) {
    assert.deepEqual(await f.lookup(id), { kind: 'missing' });
  }
  assert.equal(f.asked.length, 0);
  assert.deepEqual(await f.lookup(ID), { kind: 'missing' });
  assert.equal(f.asked.length, 1);
});

test('search hits must retain the exact non-deprecated manga ID; ambiguous verified identities do not pick a first result', async () => {
  const wrong = entity(); wrong.claims.P8731 = [claim('999')];
  const deprecated = entity(); deprecated.claims.P8731 = [claim(ID, undefined, 'deprecated')];
  for (const item of [wrong, deprecated]) {
    const f = await fixture({ item });
    assert.deepEqual(await f.lookup(ID), { kind: 'missing' });
    assert.equal(f.asked.length, 2);
  }
  const f = await fixture({ search: { query: { search: [{ title: QID }, { title: 'Q2' }] } }, entities: { [QID]: entity(), Q2: { ...entity(), id: 'Q2' } } });
  assert.deepEqual(await f.lookup(ID), { kind: 'missing' });
  assert.equal(f.asked.length, 2);
});

test('deprecated logos and explicitly unrelated season/sequel artwork are not downloaded', async () => {
  const f = await fixture({ item: entity([
    claim('Manga season 2 logo.svg', 'Q1860'), claim('Manga final season logo.svg'), claim('Manga sequel logo.svg'),
    claim('Manga Reze Arc logo.svg'), claim('Manga old logo.svg', 'Q1860', 'deprecated'), claim('Manga.svg'),
  ]) });
  const r = await f.lookup(ID);
  assert.equal(r.kind, 'found');
  if (r.kind === 'found') assert.equal(r.candidate.attribution.fileName, 'Manga.svg');
  assert.equal(f.asked.filter((a) => a.url.hostname === 'commons.wikimedia.org').length, 1);
});

test('an explicitly season-named manga can use its matching title, but a hidden season marker in the description is refused', async () => {
  const item = entity([claim('Manga season 2 logo.svg')]);
  item.labels.en.value = 'Manga season 2';
  const good = await fixture({ item });
  assert.equal((await good.lookup(ID)).kind, 'found');
  const bad = await fixture({ info: (name) => ({ ...metadata(name), extmetadata: { ImageDescription: { value: 'The logo for season 2' } } }) });
  assert.deepEqual(await bad.lookup(ID), { kind: 'missing' });
  assert.equal(bad.asked.length, 3, 'a rejected description does not fetch the image');
});

test('only a fixed Wikimedia HTTPS PNG thumbnail can be fetched, including against lookalike hosts and raw SVGs', async () => {
  for (const url of [
    'https://127.0.0.1/a.png', 'http://thumb.wikimedia.org/wikipedia/commons/thumb/a/a.png',
    'https://thumb.wikimedia.org.evil.test/wikipedia/commons/thumb/a/a.png',
    'https://thumb.wikimedia.org:8443/wikipedia/commons/thumb/a/a.png',
    'https://user:pass@thumb.wikimedia.org/wikipedia/commons/thumb/a/a.png',
    'https://upload.wikimedia.org/wikipedia/commons/a/raw.svg',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a.svg',
  ]) {
    const f = await fixture({ info: (name) => ({ ...metadata(name), thumburl: url }) });
    assert.deepEqual(await f.lookup(ID), { kind: 'missing' }, url);
    assert.equal(f.asked.length, 3, 'the unsafe/unconverted image was never fetched');
  }
});

test('opaque, empty, corrupt or SVG-disguised images do not become logo candidates', async () => {
  for (const image of [await png('opaque'), await png('empty'), Buffer.from('<svg onload="alert(1)"></svg>'), Buffer.from('89504e470d0a1a0a', 'hex')]) {
    const f = await fixture({ image });
    assert.deepEqual(await f.lookup(ID), { kind: 'missing' });
  }
});

test('a valid compressed image exceeding the decoded pixel budget is refused before it can become artwork', async () => {
  const image = await sharp({ create: { width: 4000, height: 2001, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from([255, 255, 255, 255]), raw: { width: 1, height: 1, channels: 4 }, left: 20, top: 20 }])
    .png().toBuffer();
  assert.ok(image.length < 8 * 1024 * 1024, 'PREMISE: the wire-byte budget alone accepts this image');
  const f = await fixture({ image });
  assert.deepEqual(await f.lookup(ID), { kind: 'missing' });
});

test('transparent greyscale artwork is accepted as a logo, alongside RGBA artwork', async () => {
  const image = await sharp(await png()).toColourspace('b-w').png().toBuffer();
  assert.equal((await sharp(image).metadata()).channels, 2, 'PREMISE: this image has a greyscale channel and alpha');
  const f = await fixture({ image });
  const r = await f.lookup(ID);
  assert.equal(r.kind, 'found');
  if (r.kind === 'found') assert.ok(r.candidate.bytes.equals(image));
});

test('a dead asset can fall back to another qualified candidate without downloading any original SVG', async () => {
  const f = await fixture({ item: entity([claim('A logo.svg'), claim('B logo.svg')]), intercept: (url) => url.hostname === 'thumb.wikimedia.org' && url.href.includes('A%20logo') ? reply(url.href, Buffer.alloc(0), 404) : undefined });
  const r = await f.lookup(ID);
  assert.equal(r.kind, 'found');
  if (r.kind === 'found') assert.equal(r.candidate.attribution.fileName, 'B logo.svg');
});

test('metadata is plain text and unsafe licence links are not exposed', async () => {
  const f = await fixture({ info: (name) => ({ ...metadata(name), extmetadata: {
    Artist: { value: '&lt;img src=x onerror=evil()&gt; Artist <b>Name</b>' },
    LicenseShortName: { value: '<b>CC0</b>' }, LicenseUrl: { value: 'javascript:alert(1)' },
  } }) });
  const r = await f.lookup(ID);
  assert.equal(r.kind, 'found');
  if (r.kind === 'found') {
    assert.equal(r.candidate.attribution.author, 'Artist Name');
    assert.equal(r.candidate.attribution.license, 'CC0');
    assert.equal(r.candidate.attribution.licenseUrl, null);
  }
});

test('429, provider blocks, maxlag, malformed/incomplete JSON and unreachable providers remain retryable errors, not misses', async () => {
  const failures = [
    (url: URL) => reply(url.href, {}, 429, { 'retry-after': '120' }),
    (url: URL) => reply(url.href, {}, 403),
    (url: URL) => reply(url.href, {}, 503),
    (url: URL) => reply(url.href, { error: { code: 'maxlag' } }),
    (url: URL) => reply(url.href, Buffer.from('{broken')),
    (url: URL) => reply(url.href, {}),
    (_url: URL) => null,
  ];
  for (const failure of failures) {
    let failing = true;
    const f = await fixture({ search: { query: { search: [] } }, intercept: (url) => failing ? failure(url) : undefined });
    await assert.rejects(f.lookup(ID), (error: any) => error instanceof TitleLogoProviderUnavailable && error.retryAfterMs >= 60_000);
    failing = false;
    await assert.rejects(f.lookup(ID), TitleLogoProviderUnavailable, 'a provider outage has a shared cooldown');
    assert.equal(f.asked.length, 1, 'a local cooldown never sends another HTTP request');
    f.advance(5 * 60_000);
    assert.deepEqual(await f.lookup(ID), { kind: 'missing' }, 'an outage was not remembered as a miss');
    assert.equal(f.asked.length, 2);
  }
});

test('429, 503 and maxlag share their full deadline across manga IDs and interactive calls without extending local refusals', async () => {
  const start = 1_700_000_000_000;
  const cases = [
    { status: 429, body: {}, headers: { 'retry-after': '120' }, duration: 120_000 },
    { status: 503, body: {}, headers: { 'retry-after': '120' }, duration: 120_000 },
    { status: 200, body: { error: { code: 'maxlag' } }, headers: { 'retry-after': '120' }, duration: 120_000 },
    { status: 503, body: {}, headers: {}, duration: 300_000 },
    { status: 200, body: { error: { code: 'maxlag' } }, headers: {}, duration: 300_000 },
    { status: 429, body: {}, headers: { 'retry-after': '172800' }, duration: 172_800_000 },
    { status: 503, body: {}, headers: { 'retry-after': new Date(start + 120_000).toUTCString() }, duration: 120_000 },
  ];
  for (const scenario of cases) {
    let clock = start;
    let calls = 0;
    const lookup = createTitleLogoProvider({ now: () => clock, sleep: async (ms) => { clock += ms; },
      fetchPublic: async (input) => {
        calls++;
        const url = String(input);
        return calls === 1 ? reply(url, scenario.body, scenario.status, scenario.headers)
          : reply(url, { query: { search: [] } });
      } });
    await assert.rejects(lookup(ID), (error: any) => error.retryAfterMs === scenario.duration);
    clock += 5000;
    await assert.rejects(lookup('90001', { interactive: true }), (error: any) => error.retryAfterMs === scenario.duration - 5000);
    clock += 25_000;
    await assert.rejects(lookup('90002'), (error: any) => error.retryAfterMs === scenario.duration - 30_000);
    clock = start + scenario.duration - 1;
    await assert.rejects(lookup('90003'), (error: any) => error.retryAfterMs === 1);
    assert.equal(calls, 1, 'no other manga or interactive action bypasses the provider deadline');
    clock++;
    assert.deepEqual(await lookup('90004', { interactive: true }), { kind: 'missing' });
    assert.equal(calls, 2, 'local refusals did not move the deadline');
  }
});

test('an already queued concurrent lookup rechecks cooldown before its HTTP request', async () => {
  let clock = 1_700_000_000_000;
  let calls = 0;
  const lookup = createTitleLogoProvider({ now: () => clock, sleep: async (ms) => { clock += ms; },
    fetchPublic: async (input) => { calls++; return reply(String(input), {}, 429, { 'retry-after': '120' }); } });
  const results = await Promise.allSettled([lookup(ID), lookup('90001', { interactive: true })]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal(result.reason.retryAfterMs, 120_000);
  }
  assert.equal(calls, 1, 'a queued second lookup must not contact a resting provider');
});

test('image rate limits carry Retry-After and an unexpected redirected response cannot be accepted', async () => {
  const f = await fixture({ intercept: (url) => url.hostname === 'thumb.wikimedia.org' ? reply(url.href, {}, 429, { 'retry-after': '120' }) : undefined });
  await assert.rejects(f.lookup(ID), (error: any) => error.retryAfterMs === 120_000);
  const redirected = await fixture({ intercept: (url) => ({ ...reply(url.href, {}), url: 'https://elsewhere.test/image.png' }) });
  await assert.rejects(redirected.lookup(ID), TitleLogoProviderUnavailable);
});

test('decoded metadata beyond its cap and missing requested identity objects are not cached as misses', async () => {
  const oversized = await fixture({ intercept: (url, opts) => reply(url.href, Buffer.alloc(opts.maxBytes + 1)) });
  await assert.rejects(oversized.lookup(ID), TitleLogoProviderUnavailable);
  const incomplete = await fixture({ entities: {} });
  await assert.rejects(incomplete.lookup(ID), TitleLogoProviderUnavailable);
});
