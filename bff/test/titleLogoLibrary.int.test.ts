// The logo library behind the real queue, scanner and SQL: precedence over Wikimedia, an admin's own logo, and
// reworked entries. A stand-in transport serves the library; nothing leaves the process.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import sharp from 'sharp';
import type { PublicFetch } from '../src/lib/safeFetch';

const DSN = process.env.TEST_DATABASE_URL;
const ROOT = join(tmpdir(), `yomi-title-library-${process.pid}`);
if (DSN) {
  process.env.DATABASE_URL = DSN; process.env.CONFIG_DIR = ROOT; process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.LIBRARY_ROOT = join(ROOT, 'library'); process.env.DL_ROOT = join(ROOT, 'downloads');
  process.env.JWT_SECRET = 'title-library-test-secret-at-least-16'; process.env.LIBRARY_BACKEND = 'owned'; process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const LIB = 'title-library-lib';
const BASE = 'https://raw.githubusercontent.com/AngeloSha/uchiyomi-title-logos/main/';
let q: any, pool: any;
let art: typeof import('../src/lib/titleArt'), scan: typeof import('../src/lib/titleLogoScan');
let library: typeof import('../src/lib/titleLogoLibrary');
let runtime: typeof import('../src/lib/runtime').runtime;
let SYSTEM_CTX: typeof import('../src/lib/visibility').SYSTEM_CTX;
const realFetch = globalThis.fetch;
const id = (n: number) => `s_title_library_${n}`;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function picture(width: number, format: 'webp' | 'png' = 'webp'): Promise<Buffer> {
  const height = 24, raw = Buffer.alloc(width * height * 4);
  for (let n = 0; n < width * height; n++) raw.set([240, 240, 255, (n % width) > 4 && (n % width) < width - 4 ? 255 : 0], n * 4);
  const image = sharp(raw, { raw: { width, height, channels: 4 } });
  return format === 'png' ? image.png().toBuffer() : image.webp({ lossless: true }).toBuffer();
}

// One stand-in library per test: files by path, a clock to age its index, and every request it saw.
let files: Record<string, Buffer | Error>; let asked: string[]; let clock: number; let wiki: string[];
let wikiFound: Set<string>;
const entry = (anilistId: string, bytes: Buffer) => ({ [anilistId]: { file: `logos/${anilistId}.webp`, sha256: sha(bytes), lang: 'ko' } });
const publish = (entries: Record<string, unknown>) => { files['index.json'] = Buffer.from(JSON.stringify(entries)); };
async function row(n: number) {
  return (await q(`SELECT mode, auto_file, auto_attribution, lookup_status, library_attempt, custom_file FROM series_title_art WHERE series_id=$1`, [id(n)]))[0];
}
async function scanned() { await scan.scanTitleLogos(); await art.titleLogoQueueSettled(); }

before(async () => {
  if (!DSN) return;
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: { Media: null, Page: { media: [] } } }), { status: 200 })) as typeof fetch;
  ({ q, pool } = await import('../src/lib/db')); await (await import('../src/lib/migrate')).migrate();
  art = await import('../src/lib/titleArt'); scan = await import('../src/lib/titleLogoScan'); library = await import('../src/lib/titleLogoLibrary');
  ({ runtime } = await import('../src/lib/runtime')); ({ SYSTEM_CTX } = await import('../src/lib/visibility'));
  await q(`INSERT INTO libraries(id,name,path,anilist_lookup) VALUES($1,'Library fixture',$1,true)
    ON CONFLICT(id) DO UPDATE SET anilist_lookup=true`, [LIB]);
});
beforeEach(async () => {
  if (!DSN) return;
  runtime.stopping = false; art.cancelAutomaticTitleLogoQueue(); await art.titleLogoQueueSettled(); art.setTitleLogoQueuePaceForTests(0);
  await q('DELETE FROM lib_series WHERE library_id=$1', [LIB]);
  await q(`INSERT INTO lib_series(id,source,title,folder,books_count,library_id)
    SELECT 's_title_library_'||i,'T!library','Fixture '||i,'library-'||i,0,$1 FROM generate_series(1,3)i`, [LIB]);
  await q(`INSERT INTO series_trackers(series_id,provider,external_id,checked_at)
    SELECT id,'anilist',(10000+substring(id from '[0-9]+$')::int)::text,now() FROM lib_series WHERE library_id=$1`, [LIB]);
  await q('UPDATE server_settings SET automatic_title_logos=true,title_logo_retry_at=NULL WHERE id=1');
  files = {}; asked = []; clock = 1_000_000_000; wiki = []; wikiFound = new Set();
  const transport = async (target: string | URL): Promise<PublicFetch | null> => {
    const path = String(target).slice(BASE.length); asked.push(path);
    const body = files[path];
    if (body instanceof Error) throw body;
    return { status: body ? 200 : 404, url: String(target), headers: new Headers(), body: body ?? Buffer.alloc(0) };
  };
  const wikiPng = await picture(40, 'png');
  art.setTitleLogoSourcesForTests({
    library: library.createTitleLogoLibrary({ fetchPublic: transport as any, now: () => clock, url: () => BASE }),
    wikimedia: async (anilistId) => {
      wiki.push(anilistId);
      return wikiFound.has(anilistId) ? { kind: 'found', candidate: { bytes: wikiPng, language: 'en', showReadableTitle: false,
        attribution: { provider: 'wikimedia', pageUrl: 'https://commons.wikimedia.org/wiki/File:Fixture.png', fileName: 'Fixture.png',
          author: null, license: 'Public domain', licenseUrl: null } } } : { kind: 'missing' };
    },
  });
});
after(async () => {
  if (!DSN) return;
  runtime.stopping = false; art.cancelAutomaticTitleLogoQueue(); await art.titleLogoQueueSettled();
  art.setTitleLogoSourcesForTests(); art.setTitleLogoQueuePaceForTests();
  await q('DELETE FROM lib_series WHERE library_id=$1', [LIB]); await q('DELETE FROM libraries WHERE id=$1', [LIB]);
  await q('UPDATE server_settings SET automatic_title_logos=false,title_logo_retry_at=NULL WHERE id=1');
  await pool.end(); globalThis.fetch = realFetch; await rm(ROOT, { recursive: true, force: true });
});

test('the library answers before Wikimedia, and its logo is published with the library named as its source', { skip }, async () => {
  const logo = await picture(64);
  publish(entry('10001', logo)); files['logos/10001.webp'] = logo;
  await scanned();
  const r = await row(1);
  assert.ok(r.auto_file, 'the library logo is published');
  assert.deepEqual(r.auto_attribution, { source: 'Uchiyomi logo library', sourceUrl: 'https://github.com/AngeloSha/uchiyomi-title-logos',
    artist: null, license: null, licenseUrl: null });
  assert.equal(r.library_attempt, `10001:${sha(logo)}`);
  assert.equal(wiki.includes('10001'), false, 'Wikimedia is not asked for a manga the library answered');
  assert.deepEqual(wiki.sort(), ['10002', '10003']);
  assert.ok(await art.readTitleLogo(id(1)), 'the published logo is served');
  assert.equal((await art.titleArtsFor([id(1)])).get(id(1))!.attribution!.source, 'Uchiyomi logo library');
  assert.deepEqual(asked.sort(), ['index.json', 'logos/10001.webp']);
});

test('each library logo is tried once: a file that fails its hash falls back to Wikimedia until the entry changes', { skip }, async () => {
  const logo = await picture(64), other = await picture(48);
  publish(entry('10001', logo)); files['logos/10001.webp'] = other;
  await scanned();
  assert.equal((await row(1)).auto_file, null, 'a file that does not hash to its entry is never published');
  assert.equal((await row(1)).library_attempt, `10001:${sha(logo)}`);
  assert.ok(wiki.includes('10001'), 'Wikimedia answers instead');
  wiki = []; asked = [];
  await scanned();
  assert.deepEqual([wiki, asked], [[], []], 'the same entry is not tried again on the next pass');
  files['logos/10001.webp'] = logo; clock += 25 * 3600_000; // the library is fixed upstream; tomorrow's index read sees it
  publish({ ...entry('10001', logo), '10002': { file: 'logos/10002.webp', sha256: sha(logo), lang: 'ko' } });
  await scanned();
  assert.equal((await row(1)).auto_file, null, 'an unchanged entry is still not retried before its miss expires');
  assert.equal((await row(2)).library_attempt, `10002:${sha(logo)}`, 'a new entry is tried at once, despite a recent miss');
  publish(entry('10001', await picture(56))); files['logos/10001.webp'] = await picture(56); clock += 25 * 3600_000;
  await scanned();
  assert.ok((await row(1)).auto_file, 'a reworked entry is tried at once and published');
});

test('a library logo replaces a Wikimedia logo and is itself replaced when reworked, but never replaces an admin\'s own', { skip }, async () => {
  wikiFound.add('10001');
  await scanned();
  assert.equal((await row(1)).auto_attribution.source, 'Wikimedia Commons');
  await art.changeTitleArt(id(2), { mode: 'upload', bytes: await picture(30, 'png') }, SYSTEM_CTX);
  const custom = (await row(2)).custom_file;
  const first = await picture(64), second = await picture(60);
  publish({ ...entry('10001', first), ...entry('10002', first) });
  files['logos/10001.webp'] = first; files['logos/10002.webp'] = first; clock += 25 * 3600_000; wiki = [];
  await scanned();
  const replaced = await row(1);
  assert.equal(replaced.auto_attribution.source, 'Uchiyomi logo library', 'the curated logo wins over Wikimedia');
  assert.equal((await row(2)).mode, 'custom'); assert.equal((await row(2)).custom_file, custom);
  assert.equal(asked.includes('logos/10002.webp'), false, 'an admin\'s own logo is never even looked up');
  publish({ ...entry('10001', second) }); files['logos/10001.webp'] = second; clock += 25 * 3600_000;
  await scanned();
  const reworked = await row(1);
  assert.notEqual(reworked.auto_file, replaced.auto_file, 'the reworked logo replaces the old one');
  assert.equal(reworked.library_attempt, `10001:${sha(second)}`);
  assert.deepEqual(wiki, [], 'Wikimedia is never asked while the library answers');
});

test('an unreachable library is no answer: Wikimedia is asked and nothing is recorded as tried', { skip }, async () => {
  files['index.json'] = new Error('offline');
  await scanned();
  assert.deepEqual(wiki.sort(), ['10001', '10002', '10003']);
  for (const n of [1, 2, 3]) assert.equal((await row(n)).library_attempt, null);
  assert.deepEqual(asked, ['index.json'], 'one index read, not one per manga');
});
