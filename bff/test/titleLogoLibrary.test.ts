// The logo library client against a stand-in transport: what it trusts, what it refuses, and how often it asks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createTitleLogoLibrary, libraryBase, libraryPage, parseLibraryIndex } from '../src/lib/titleLogoLibrary';
import type { PublicFetch } from '../src/lib/safeFetch';

const BASE = 'https://raw.githubusercontent.com/AngeloSha/uchiyomi-title-logos/main/';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function logo(opaque = false, format: 'webp' | 'png' = 'webp'): Promise<Buffer> {
  const width = 64, height = 24, raw = Buffer.alloc(width * height * 4);
  for (let n = 0; n < width * height; n++) {
    const inside = (n % width) > 8 && (n % width) < 56;
    raw.set([255, 255, 255, opaque || inside ? 255 : 0], n * 4);
  }
  const image = sharp(raw, { raw: { width, height, channels: 4 } });
  return format === 'png' ? image.png().toBuffer() : image.webp({ lossless: true }).toBuffer();
}
function library(files: Record<string, Buffer | Error>, url = BASE) {
  const asked: string[] = []; let clock = 1_000_000;
  const fetchPublic = async (target: string | URL): Promise<PublicFetch | null> => {
    const href = String(target); asked.push(href.slice(url.length));
    const body = files[href.slice(url.length)];
    if (body instanceof Error) throw body;
    return body ? { status: 200, url: href, headers: new Headers(), body } : { status: 404, url: href, headers: new Headers(), body: Buffer.alloc(0) };
  };
  const lib = createTitleLogoLibrary({ fetchPublic: fetchPublic as any, now: () => clock, url: () => url });
  return { lib, asked, tick(ms: number) { clock += ms; } };
}
const index = (entries: Record<string, unknown>) => Buffer.from(JSON.stringify(entries));

test('the index trusts only exact logos/<id>.webp entries with a SHA-256', () => {
  const good = 'a'.repeat(64);
  const parsed = parseLibraryIndex(index({
    '30013': { file: 'logos/30013.webp', sha256: good, lang: 'ja' },
    '2': { file: 'logos/../2.webp', sha256: good },
    '3': { file: 'logos/4.webp', sha256: good },
    '5': { file: 'logos/5.webp', sha256: 'A'.repeat(64) },
    '06': { file: 'logos/06.webp', sha256: good },
    '7': { file: 'logos/7.webp', sha256: good, lang: 'not a code' },
    '8': 'logos/8.webp',
  }))!;
  assert.deepEqual([...parsed.keys()].sort(), ['30013', '7']);
  assert.deepEqual(parsed.get('30013'), { file: 'logos/30013.webp', sha256: good, lang: 'ja' });
  assert.equal(parsed.get('7')!.lang, null);
  assert.equal(parseLibraryIndex('[1,2]'), null);
  assert.equal(parseLibraryIndex('not json'), null);
});

test('the library address is https without credentials, and GitHub raw files point people at the repository', () => {
  assert.equal(libraryBase(''), null);
  assert.equal(libraryBase('http://example.com/logos/'), null);
  assert.equal(libraryBase('https://user:pw@example.com/'), null);
  assert.equal(libraryBase('https://example.com/logos?x=1'), null);
  assert.equal(libraryBase('https://mirror.example.com/logos')!.href, 'https://mirror.example.com/logos/');
  assert.equal(libraryPage(libraryBase(BASE)!), 'https://github.com/AngeloSha/uchiyomi-title-logos');
  assert.equal(libraryPage(libraryBase('https://mirror.example.com/logos/')!), 'https://mirror.example.com/logos/');
});

test('a listed logo is used only when its bytes hash to the index entry, and is attributed to the library', async () => {
  const good = await logo();
  const { lib, asked } = library({ 'index.json': index({
    '101': { file: 'logos/101.webp', sha256: sha(good), lang: 'ko' },
    '102': { file: 'logos/102.webp', sha256: 'b'.repeat(64), lang: 'en' },
  }), 'logos/101.webp': good, 'logos/102.webp': good });
  const found = await lib.lookup('101');
  assert.equal(found.attempt, `101:${sha(good)}`);
  assert.ok(found.candidate?.bytes.equals(good));
  assert.equal(found.candidate!.language, 'ko');
  assert.equal(found.candidate!.showReadableTitle, true);
  assert.deepEqual(found.candidate!.attribution, { provider: 'library', pageUrl: 'https://github.com/AngeloSha/uchiyomi-title-logos',
    fileName: 'logos/101.webp', author: null, license: null, licenseUrl: null });
  // The same file under an entry whose hash it does not match is refused, and the attempt is still named.
  assert.deepEqual(await lib.lookup('102'), { candidate: null, attempt: `102:${'b'.repeat(64)}` });
  // An id the index does not list costs no logo request at all.
  assert.deepEqual(await lib.lookup('103'), { candidate: null, attempt: null });
  assert.deepEqual(asked, ['index.json', 'logos/101.webp', 'logos/102.webp']);
});

test('an opaque or non-WebP file is refused even when its hash matches', async () => {
  const opaque = await logo(true), png = await logo(false, 'png');
  const { lib } = library({ 'index.json': index({
    '201': { file: 'logos/201.webp', sha256: sha(opaque) }, '202': { file: 'logos/202.webp', sha256: sha(png) },
  }), 'logos/201.webp': opaque, 'logos/202.webp': png });
  assert.equal((await lib.lookup('201')).candidate, null);
  assert.equal((await lib.lookup('202')).candidate, null);
});

test('the index is read once a day, an unreachable library is asked again an hour later, and empty turns it off', async () => {
  const good = await logo();
  const files: Record<string, Buffer | Error> = { 'index.json': new Error('offline') };
  const { lib, asked, tick } = library(files);
  assert.deepEqual(await lib.lookup('301'), { candidate: null, attempt: null });
  await lib.refresh(); tick(30 * 60_000); await lib.refresh();
  assert.deepEqual(asked, ['index.json'], 'no second try within the hour');
  assert.equal(lib.snapshot(), null);
  files['index.json'] = index({ '301': { file: 'logos/301.webp', sha256: sha(good) } }); files['logos/301.webp'] = good;
  tick(31 * 60_000);
  assert.ok((await lib.lookup('301')).candidate);
  tick(23 * 3600_000); await lib.refresh();
  assert.deepEqual(asked, ['index.json', 'index.json', 'logos/301.webp'], 'a day-old index is still fresh enough');
  tick(3600_000); await lib.refresh();
  assert.equal(asked.filter((a) => a === 'index.json').length, 3);
  assert.deepEqual([...lib.snapshot()!.keys()], ['301']);

  const off = library({ 'index.json': index({}) }, '');
  assert.deepEqual(await off.lib.lookup('301'), { candidate: null, attempt: null });
  assert.equal(off.lib.snapshot(), null);
  assert.deepEqual(off.asked, []);
});
