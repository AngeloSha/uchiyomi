// Fix everything's extensions phase (lib/autofix.ts), against the strict fake engine: for series that no source carries,
// it installs extensions in the series' language one at a time -- ranked by the series' own translation groups, then by
// how often each is downloaded (its repository's GitHub releases, stubbed here), then by its version (lib/extensionRank.ts)
// -- switches on only the source in that language, searches the series there under Find's limits, keeps what now
// carries a series and removes a miss at once. Since v0.55.1 there is no cap: it goes on until the series are found or
// the run's time is spent, the next run continues down the list, and no package is tried twice for one series in a
// month; an 18+ package is tried only for a series rated 18+, after the others. An install that would not fit under the
// source limit is not made, and says so.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FakeSeed, FakeSuwayomi } from './fixtures/fakeSuwayomi';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '', DL = '';
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

const BASE = 'https://repo.example/repo.json';
const PKG = {
  ball: 'eu.kanade.tachiyomi.extension.en.mangaball',
  velvet: 'eu.kanade.tachiyomi.extension.all.velvetscans',
  ember: 'eu.kanade.tachiyomi.extension.en.emberpages',
  cedar: 'eu.kanade.tachiyomi.extension.en.cedarhub',
  amber: 'eu.kanade.tachiyomi.extension.en.ambercomics',
  dune: 'eu.kanade.tachiyomi.extension.en.dunecomics',
  birch: 'eu.kanade.tachiyomi.extension.en.birchreader',
  pine: 'eu.kanade.tachiyomi.extension.en.pinereader',
  fir: 'eu.kanade.tachiyomi.extension.en.firreader',
  rose: 'eu.kanade.tachiyomi.extension.en.rosevelvet',
  old: 'eu.kanade.tachiyomi.extension.en.oldshelf',
  coral: 'eu.kanade.tachiyomi.extension.ja.coraltoons',
};
const ID = {
  ball: '6716343437498271985', velvetEn: '7000000000000000100', velvetEs: '7000000000000000101', ember: '7000000000000000200',
  cedar: '7000000000000000300', amber: '7000000000000000400', dune: '7000000000000000500', birch: '7000000000000000600',
  pine: '7000000000000000700', fir: '7000000000000000750', rose: '7000000000000000800', old: '7000000000000000900', coral: '7000000000000001000',
};
/** The extension the library's series came from, uninstalled long ago: nothing provides this id now. */
const GONE = 'sw:5550001';
const chapters = (title: string) => [5, 4, 3, 2, 1].map((n) => ({ name: `${title} ${n}`, url: `/${title}/${n}`, chapterNumber: n, uploadDate: Date.UTC(2024, 0, n), pages: 3 }));
const manga = (title: string) => ({ title, url: `/${title.toLowerCase().replace(/ /g, '-')}`, chapters: chapters(title) });

/**
 * How often each package is downloaded a day, as the repository's GitHub releases say (its apk and jar together):
 * Rose Velvet (18+), Acorn Shelf (obsolete) and Abyss Toons (Japanese) most of all, so that dropping the guard that
 * keeps each out puts it first. Dune Comics, Birch Reader and Pine Reader live elsewhere: no count, their version decides.
 */
const PER_DAY: Record<string, number> = {
  [PKG.velvet]: 300, [PKG.ember]: 200, [PKG.cedar]: 5_000, [PKG.amber]: 1_000, [PKG.rose]: 9_000, [PKG.old]: 8_000, [PKG.coral]: 7_000,
};
const GH = 'https://github.com/keiyoushi/extensions/releases/download/8ef06cd-0';
const files = (pkg: string) => (PER_DAY[pkg] !== undefined
  ? { apkUrl: `${GH}/tachiyomi-${pkg.split('.').slice(-2).join('.')}-v1.0.0.apk`, jarUrl: `${GH}/tachiyomi-${pkg.split('.').slice(-2).join('.')}-v1.0.0.jar` }
  : { apkUrl: `https://repo.example/apk/tachiyomi-${pkg.split('.').slice(-2).join('.')}-v1.0.0.apk`, jarUrl: null });

function seed(): FakeSeed {
  const src = (id: string, name: string, lang: string, pkgName: string, mangas: Array<ReturnType<typeof manga>> = [], o: { isNsfw?: boolean } = {}) =>
    ({ id, name, lang, pkgName, supportsLatest: true, isNsfw: !!o.isNsfw, baseUrl: `https://${pkgName}.example`, mangas });
  const ext = (pkgName: string, name: string, lang: string, o: { installed?: boolean; obsolete?: boolean; isNsfw?: boolean; versionCode?: number } = {}) =>
    ({ pkgName, name, lang, versionName: '1.0.0', installed: !!o.installed, obsolete: !!o.obsolete, isNsfw: !!o.isNsfw, versionCode: o.versionCode ?? 1, repo: BASE, ...files(pkgName) });
  return {
    sources: [
      src(ID.ball, 'Manga Ball', 'en', PKG.ball),
      src(ID.velvetEn, 'Velvet Scans', 'en', PKG.velvet, [manga('Moon River')]),
      src(ID.velvetEs, 'Velvet Scans', 'es', PKG.velvet),
      src(ID.ember, 'Ember Pages', 'en', PKG.ember, [manga('Lost Song')]),
      src(ID.cedar, 'Cedar Hub', 'en', PKG.cedar, [manga('Quiet Harbor')]),
      src(ID.amber, 'Amber Comics', 'en', PKG.amber),
      src(ID.dune, 'Dune Comics', 'en', PKG.dune, [manga('Time Story')]),
      src(ID.birch, 'Birch Reader', 'en', PKG.birch, [manga('Night Bloom')]),
      src(ID.pine, 'Pine Reader', 'en', PKG.pine, [manga('Pine Lake')]),
      src(ID.fir, 'Fir Reader', 'en', PKG.fir, [manga('Fir Lake')]),
      src(ID.rose, 'Rose Velvet', 'en', PKG.rose, [manga('Night Bloom'), manga('Scarlet Night'), manga('Thorn Garden')], { isNsfw: true }),
      src(ID.old, 'Acorn Shelf', 'en', PKG.old, [manga('Night Bloom')]),
      src(ID.coral, 'Abyss Toons', 'ja', PKG.coral, [manga('Night Bloom')]),
    ],
    extensions: [
      ext(PKG.ball, 'Manga Ball', 'en', { installed: true }),
      ext(PKG.velvet, 'Velvet Scans', 'all'),
      ext(PKG.ember, 'Ember Pages', 'en'),
      ext(PKG.cedar, 'Cedar Hub', 'en'),
      ext(PKG.amber, 'Amber Comics', 'en'),
      ext(PKG.dune, 'Dune Comics', 'en', { versionCode: 20 }),
      ext(PKG.birch, 'Birch Reader', 'en', { versionCode: 5 }),
      ext(PKG.pine, 'Pine Reader', 'en', { versionCode: 1 }),
      ext(PKG.fir, 'Fir Reader', 'en', { versionCode: 1 }),
      ext(PKG.rose, 'Rose Velvet', 'en', { isNsfw: true }),
      ext(PKG.old, 'Acorn Shelf', 'en', { obsolete: true }),
      ext(PKG.coral, 'Abyss Toons', 'ja'),
    ],
    settings: {},
  };
}

const LIB = 'lib_afx', ADULT_LIB = 'lib_afx_adult';
/** Every series this file adds, for the cleanup. */
const ALL: string[] = [];
const S = (k: string) => `s_afx_${k}`;

let fake: FakeSuwayomi | null = null;
let q: any, autofix: typeof import('../src/lib/autofix'), env: any, adminId = '';
const realFetch = globalThis.fetch;
/** GitHub asked for the repository's releases. */
let ghAsked = 0;

/** A series of five chapters on disk -- each with its translation group, when it has one -- on `main`. */
async function series(k: string, title: string, o: { main?: string | null; group?: string | null; library?: string; lang?: string } = {}) {
  const id = S(k);
  ALL.push(id);
  const main = o.main === undefined ? GONE : o.main;
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update, lang)
           VALUES ($1,'T!afx',$2,$3,5,$4,$5,$6,true,$7)`, [id, title, `T!afx/${title}`, o.library ?? LIB, main, main ? '1' : null, o.lang ?? null]);
  for (const n of [1, 2, 3, 4, 5]) {
    const file = `T!afx/${title}/Chapter ${n}.cbz`;
    const z = new AdmZip();
    for (let i = 0; i < 3; i++) z.addFile(`${i}.png`, Buffer.alloc(80, 1));
    z.addFile('ComicInfo.xml', Buffer.from(`<?xml version="1.0"?><ComicInfo><Series>${title}</Series></ComicInfo>`));
    mkdirSync(join(DL, `T!afx/${title}`), { recursive: true });
    writeFileSync(join(DL, file), z.toBuffer());
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, pages_checked_at, root, scanlator, source_id)
             VALUES ($1,$2,'T!afx',$3,$4,$5,3,now(),$6,$7,$8)`, [`b_${id}_${n}`, id, file, n, `Chapter ${n}`, DL, o.group ?? null, main]);
  }
}
/** Only these series are the run's: every other this file added is paused (a paused series is never a target). */
async function only(...keys: string[]) {
  await q('UPDATE lib_series SET auto_update = (id = ANY($2)) WHERE id = ANY($1)', [ALL, keys.map(S)]);
}
const mainOf = async (k: string) => (await q('SELECT source_id FROM lib_series WHERE id = $1', [S(k)]))[0]?.source_id ?? null;

before(async () => {
  if (!DSN) return;
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-afx-'));
  DL = join(ROOT, 'dl');
  mkdirSync(DL, { recursive: true });
  mkdirSync(join(ROOT, 'lib'), { recursive: true });
  const { startFakeSuwayomi } = await import('./fixtures/fakeSuwayomi');
  fake = await startFakeSuwayomi({ seed: seed() });
  // ⚠️ Before anything from src: env.ts reads these once.
  process.env.DATABASE_URL = DSN;
  process.env.SUWAYOMI_URL = fake.url;
  process.env.EXTENSION_ENGINE = '1';
  delete process.env.UCHIYOMI_PLATFORM;
  delete process.env.HOST_OS;
  delete process.env.FLARESOLVERR_URL;
  process.env.DL_ROOT = DL;
  process.env.LIBRARY_ROOT = join(ROOT, 'lib');
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.MIN_FREE_GB = '0';
  process.env.REPAIR_PACE_MS = '0';
  process.env.UCHIYOMI_PING_URL = '';
  // GitHub's releases list for the repository the packages' files are on; everything else (the fake engine) as is.
  const day = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  globalThis.fetch = (async (u: any, init?: any) => {
    const url = String(u);
    if (url.startsWith('https://api.github.com/repos/keiyoushi/extensions/releases')) {
      ghAsked++;
      const assets = Object.entries(PER_DAY).flatMap(([pkg, n]) => {
        const f = files(pkg);
        // The apk most, the jar the rest: counted together.
        return [{ browser_download_url: f.apkUrl, download_count: n - Math.floor(n / 4) }, { browser_download_url: f.jarUrl, download_count: Math.floor(n / 4) }];
      });
      return new Response(JSON.stringify([{ published_at: day, assets }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(u, init);
  }) as typeof fetch;
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q } = (await import('../src/lib/db')) as any);
  ({ env } = (await import('../src/env')) as any);
  autofix = await import('../src/lib/autofix');
  const find = await import('../src/lib/findSources');
  find.setFindTiming({ paceMs: 0, quietMs: 20, busyMs: 50, wallMs: 10_000 });
  autofix.setAutofixTiming({ quietMs: 20 });
  (await import('../src/lib/githubRelease')).resetReleaseCache();
  await q('DELETE FROM suwayomi_sources');
  await q(`DELETE FROM source_health WHERE source_id LIKE 'sw:%'`);
  const reg = await import('../src/lib/sources/suwayomi/register');
  await reg.loadSuwayomiSources();
  await q(`UPDATE suwayomi_sources SET enabled = true WHERE source_id = $1`, [ID.ball]);
  await (await import('../src/lib/sources')).reloadAll();
  await q(`DELETE FROM users WHERE username = 'afx-admin'`);
  adminId = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                      VALUES ('afx-admin','afx-admin','x','admin','password') RETURNING id`))[0].id;
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Ext',$2) ON CONFLICT (id) DO NOTHING`, [LIB, DL]);
  await q(`INSERT INTO libraries (id, name, path, age_rating) VALUES ($1,'Ext adult',$2, 18) ON CONFLICT (id) DO UPDATE SET age_rating = 18`,
    [ADULT_LIB, join(DL, 'adult')]);
  await series('lost', 'Lost Song', { group: 'Ember Pages' });
  await series('moon', 'Moon River', { group: 'Velvet Scans' });
  await series('night', 'Night Bloom');
});

after(async () => {
  globalThis.fetch = realFetch;
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  await fake?.close();
  if (!DSN) return;
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = ANY($1)', [[LIB, ADULT_LIB]]).catch(() => {});
  await q('DELETE FROM suwayomi_sources').catch(() => {});
  await q(`DELETE FROM users WHERE username = 'afx-admin'`).catch(() => {});
});

/** What the run installed, in order, from the audit: a package installed and removed again in the run counts too. */
const installs = async (runId: string) =>
  (await q(`SELECT detail->>'pkgName' AS pkg FROM audit_log WHERE event = 'extension.install' AND detail->>'runId' = $1 ORDER BY id`, [runId]))
    .map((r: any) => r.pkg);
/** Installs and removals, in order: `+pkg` installed, `-pkg` removed. */
const moves = async (runId: string) =>
  (await q(`SELECT event, detail->>'pkgName' AS pkg FROM audit_log WHERE event IN ('extension.install', 'extension.uninstall')
             AND detail->>'runId' = $1 ORDER BY id`, [runId])).map((r: any) => `${r.event === 'extension.install' ? '+' : '-'}${r.pkg}`);
async function runOnce() {
  const started = autofix.startAutofix(adminId);
  assert.ok('runId' in started);
  await autofix.autofixSettled();
  const run = await autofix.autofixRun((started as { runId: string }).runId);
  assert.equal(run?.status, 'done');
  return run!;
}

test('the extensions phase: the groups first, then the most downloaded, with no cap, kept when they carry and removed at once when not', { skip }, async (t) => {
  const run = await runOnce();

  await t.test('with no cap it goes past three until the series is found, in the order the groups and the downloads give', async () => {
    // v0.55.1: the owner's first run tried three extensions by name and stopped. Reintroduce a cap of three (the
    // AUTOFIX_INSTALLS default): it stops at Cedar Hub, before Birch Reader, which carries Night Bloom. Reintroduce the
    // order by name (lib/extensionRank.ts rankPackages): Amber Comics comes before Cedar Hub, the most downloaded.
    assert.deepEqual(await installs(run.id), [PKG.velvet, PKG.ember, PKG.cedar, PKG.amber, PKG.dune, PKG.birch],
      'the two the series\' groups name, then the most downloaded a day, then the most updated');
    assert.ok(ghAsked >= 1, 'PREMISE: the downloads came from the repository\'s GitHub releases');
  });

  await t.test('never an obsolete package, one in another language, or an 18+ one for a series not rated 18+', async () => {
    // Acorn Shelf (obsolete), Abyss Toons (Japanese) and Rose Velvet (18+) are the most downloaded, and each carries
    // Night Bloom. Reintroduce by dropping the obsolete or the language filter in extensions(): it is installed before
    // Cedar Hub, and carries Night Bloom off.
    const pkgs = await installs(run.id);
    for (const p of [PKG.old, PKG.coral, PKG.rose]) assert.ok(!pkgs.includes(p), `${p} is never tried for these series`);
  });

  await t.test('each miss is removed right after its searches, before the next is installed', async () => {
    // So a miss never holds a slot under the source limit. Reintroduce v0.55.0's removal at the phase's end (settle
    // only in extensions' finally): the three misses are removed after Birch Reader is installed.
    assert.deepEqual(await moves(run.id), [
      `+${PKG.velvet}`, `+${PKG.ember}`, `+${PKG.cedar}`, `-${PKG.cedar}`, `+${PKG.amber}`, `-${PKG.amber}`, `+${PKG.dune}`, `-${PKG.dune}`, `+${PKG.birch}`,
    ]);
  });

  await t.test('only the source in the series\' language is switched on', async () => {
    // Reintroduce by adopting the package's sources as the install route does (adoptExtensionSources(provided, true)):
    // Velvet Scans' Spanish source is switched on too, and takes a slot under the limit.
    const rows = new Map((await q(`SELECT source_id, enabled FROM suwayomi_sources WHERE source_id = ANY($1)`, [[ID.velvetEn, ID.velvetEs]]))
      .map((r: any) => [r.source_id, r.enabled]));
    assert.equal(rows.get(ID.velvetEn), true, 'its English source is on');
    assert.equal(rows.get(ID.velvetEs), false, 'only the series\' language is switched on');
  });

  await t.test('the series move to what carries them; what carries one is kept, what carried none is gone, and the end says it in one line', async () => {
    assert.equal(await mainOf('lost'), `sw:${ID.ember}`, 'Lost Song moved to the extension its group runs');
    assert.equal(await mainOf('moon'), `sw:${ID.velvetEn}`, 'Moon River to Velvet Scans\' English source');
    assert.equal(await mainOf('night'), `sw:${ID.birch}`, 'and Night Bloom to the sixth extension tried');
    for (const p of [PKG.velvet, PKG.ember, PKG.birch]) assert.equal(fake!.extension(p).installed, true, `${p} carries a series: kept`);
    for (const p of [PKG.cedar, PKG.amber, PKG.dune]) assert.equal(fake!.extension(p).installed, false, `${p} carried none: removed`);
    assert.equal(fake!.extension(PKG.ball).installed, true, 'and nothing it did not install is ever removed');
    // v0.55.1: one line however many it tried, naming the ones kept.
    const done = run.summary!.done.filter((d) => d.kind === 'installed' || d.kind === 'uninstalled');
    assert.deepEqual(done.map((d) => d.said), [{ code: 'autofix.done.tried', params: { n: 6, names: ['Velvet Scans', 'Ember Pages', 'Birch Reader'], more: 0 } }]);
    const via = await q(`SELECT DISTINCT detail->>'via' AS via FROM audit_log WHERE event IN ('extension.install','extension.uninstall') AND detail->>'runId' = $1`, [run.id]);
    assert.deepEqual(via.map((r: any) => r.via), ['autofix'], 'audited as Fix everything\'s');
    assert.ok(!run.summary!.needsYou.some((n) => n.check === 'frozen-series'), 'nothing is left without a source');
    assert.equal(run.summary!.again, false);
  });
});

test('an 18+ package is tried only for a series rated 18+, and after the others', { skip }, async () => {
  // Scarlet Night is rated 18+ (its library is); Thorn Garden is not. Rose Velvet, 18+ and the most downloaded, is the
  // only one that carries either. Reintroduce by trying it for any series (drop `t.adult` in extensions()): Thorn Garden
  // moves onto it. By ranking 18+ with the others (drop `nsfw` from rankPackages): it is the first one installed.
  await series('scarlet', 'Scarlet Night', { library: ADULT_LIB });
  await series('thorn', 'Thorn Garden');
  await only('scarlet', 'thorn');
  const run = await runOnce();
  assert.equal(await mainOf('scarlet'), `sw:${ID.rose}`, 'the series rated 18+ moves to it');
  assert.equal(await mainOf('thorn'), GONE, 'an 18+ package is never tried for a series not rated 18+');
  assert.deepEqual(await installs(run.id), [PKG.cedar, PKG.amber, PKG.dune, PKG.fir, PKG.pine, PKG.rose], 'and it comes after the others');
  // Cedar Hub missed Night Bloom in the last run, and is still tried for these, which it has never been asked about.
});

test('no package is tried twice for the same series within a month', { skip }, async () => {
  // Ghost Story is carried by nothing. The first run tries every package it may; the second, none of them again.
  // Reintroduce by reading no earlier run (recentlyTried in lib/autofix.ts answering false): the second run installs
  // them all again.
  await series('ghost', 'Ghost Story');
  await only('ghost');
  const first = await runOnce();
  assert.deepEqual(await installs(first.id), [PKG.cedar, PKG.amber, PKG.dune, PKG.fir, PKG.pine], 'PREMISE: every package it may try');
  const second = await runOnce();
  assert.deepEqual(await installs(second.id), [], 'no package is tried twice for the same series');
  // Nothing left to try: the series nothing in reach carries is a person's now.
  assert.ok(second.summary!.needsYou.some((n) => n.check === 'frozen-series'), 'and the series nothing carries is Needs you');
});

test('the run\'s time stops it, and the next run continues where it stopped', { skip }, async () => {
  // Only Dune Comics carries Time Story, third in its order. The first run's time runs out after its first package;
  // the second run takes up from the second. Reintroduce by not recording the misses (settle without `missed`): the
  // second run starts again at Cedar Hub.
  await series('time', 'Time Story');
  await only('time');
  const installsSoFar = () => fake!.graphqlCalls('updateExtension').length;
  const at = installsSoFar();
  // The clock jumps three hours once the first package has been installed: the run's time is spent from then on.
  autofix.setAutofixTiming({ quietMs: 20, clock: () => Date.now() + (installsSoFar() > at ? 3 * 60 * 60 * 1000 : 0) });
  let first;
  try {
    first = await runOnce();
  } finally {
    autofix.setAutofixTiming({ quietMs: 20 });
  }
  assert.deepEqual(await installs(first.id), [PKG.cedar], 'the time budget stops it after the package in flight');
  assert.ok(first.log!.some((l) => l.code === 'autofix.item.skipped' && l.params?.why === 'time'), 'and the log says so');
  assert.ok(!first.summary!.needsYou.some((n) => n.check === 'frozen-series'), 'what it did not reach is not Needs you');
  assert.equal(first.summary!.again, true, 'Run again is offered');
  const second = await runOnce();
  assert.deepEqual(await installs(second.id), [PKG.amber, PKG.dune], 'the next run continues where it stopped');
  assert.equal(await mainOf('time'), `sw:${ID.dune}`);
});

test('an install that would not fit under the source limit is not made, and it is Needs you', { skip }, async () => {
  // Reintroduce by installing whatever the limit says (drop the wouldFit check in tryPackage): Cedar Hub is installed.
  await series('room', 'Room Story');
  await only('room');
  const original = env.SUWAYOMI_MAX_SOURCES;
  const on = (await q('SELECT count(*)::int AS n FROM suwayomi_sources WHERE enabled'))[0].n;
  env.SUWAYOMI_MAX_SOURCES = on;
  try {
    const run = await runOnce();
    assert.deepEqual(await installs(run.id), [], 'an install that would not fit is not made');
    assert.equal(fake!.extension(PKG.cedar).installed, false);
    const need = run.summary!.needsYou.find((n) => n.said.code === 'autofix.needs.noRoom');
    assert.equal(need?.check, 'extension-cap');
    assert.deepEqual(need?.said.params, { name: 'Cedar Hub' }, 'naming the package it would have tried first');
    assert.ok(run.summary!.needsYou.some((n) => n.check === 'frozen-series'), 'the series nothing carries is Needs you');
  } finally {
    env.SUWAYOMI_MAX_SOURCES = original;
  }
});

test('a frozen series with no main moves to the new source that carries it, only while that source can update it', { skip }, async () => {
  // Neither has a main source, so each follows the extension its group runs and is then switched onto it. v0.55.1: only
  // while the source can update it -- Replace's rule wherever Fix everything makes a source a series' main; a package
  // installed before can bring back a source already failing (its health row outlives the uninstall while a series
  // still points at it). And only once the follow's own listing refresh is out of the series, or the switch is refused
  // `busy`. Reintroduce by switching whatever the new source is (drop `takes` in tryPackage): Pine Lake moves onto Pine
  // Reader. By switching at once (drop quietSeries): Fir Lake stays without a main.
  await series('fir', 'Fir Lake', { main: null, group: 'Fir Reader', lang: 'en' });
  await series('pine', 'Pine Lake', { main: null, group: 'Pine Reader', lang: 'en' });
  await only('fir', 'pine');
  const at = new Date().toISOString();
  await q(`INSERT INTO source_health (source_id, stages) VALUES ($1, $2::jsonb) ON CONFLICT (source_id) DO UPDATE SET stages = EXCLUDED.stages`,
    [`sw:${ID.pine}`, JSON.stringify({ pages: { failAt: at, failBy: 'test', streak: 4, kind: 'error', error: 'suwayomi: HTTP error 500' } })]);
  const run = await runOnce();
  // Pine Lake, which no source can update yet, sends it on down the list after them.
  assert.deepEqual((await installs(run.id)).slice(0, 2), [PKG.fir, PKG.pine], 'PREMISE: the packages their groups run, tried first');
  assert.equal(await mainOf('fir'), `sw:${ID.fir}`, 'a frozen series with no main moves to the new source that carries it');
  assert.equal(await mainOf('pine'), null, 'a source failing at its page lists is never made its main source');
  assert.deepEqual((await q('SELECT source_id FROM series_sources WHERE series_id = $1', [S('pine')])).map((r: any) => r.source_id), [`sw:${ID.pine}`],
    'though it follows it now');
});

test('a gap an earlier run filled is no reason to install; the same answer about the series as it is, is', { skip }, async () => {
  // v0.55.0 integration (lib/autofix.ts extensionTargets). A run that fills a gap from an extension it installed leaves
  // the series' stored answer "asked, and nobody has it" behind; the next run read that answer alone, installed another
  // package for a series with nothing missing -- and, under the source limit, told the admin to free a slot for it (the
  // integration's autofix walk). The answer counts only while it is about the series as it is now (health.ts
  // gapsAnswered: nothing landed since) and the series still has a hole. Reintroduce by reading the stored answer alone:
  // "a gap an earlier run filled is no reason to install" finds an install.
  const GAP = S('gapsong');
  ALL.push(GAP);
  await only();
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
           VALUES ($1,'T!afx','Gap Song','T!afx/Gap Song',5,$2,$3,'gap-song',true)`, [GAP, LIB, `sw:${ID.ball}`]);
  for (const n of [1, 2, 3, 4, 5]) {
    const file = `T!afx/Gap Song/Chapter ${n}.cbz`;
    const z = new AdmZip();
    for (let i = 0; i < 3; i++) z.addFile(`${i}.png`, Buffer.alloc(80, 1));
    mkdirSync(join(DL, 'T!afx/Gap Song'), { recursive: true });
    writeFileSync(join(DL, file), z.toBuffer());
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, pages_checked_at, root, source_id)
             VALUES ($1,$2,'T!afx',$3,$4,$5,3,now(),$6,$7)`, [`b_${GAP}_${n}`, GAP, file, n, `Chapter ${n}`, DL, `sw:${ID.ball}`]);
  }
  const answer = (have: number) => JSON.stringify({
    at: new Date().toISOString(), why: 'no_candidate', have_count: have, unfillable: ['3'], scanned: 1,
    sweep: 0, capped: 0, landed: 0, fetched: 0, coverage: null, followed: null,
  });
  // Whole: chapter 3 came in after the search that found nobody had it, for the four chapters there were then.
  await q('UPDATE lib_series SET gaps_checked_at = now(), gaps_result = $2::jsonb WHERE id = $1', [GAP, answer(4)]);
  const first = await runOnce();
  assert.deepEqual(await installs(first.id), [], 'a gap an earlier run filled is no reason to install');
  // The premise: chapter 3 gone again, and the same answer about the series as it is now -- that is a reason to look.
  await q('DELETE FROM lib_books WHERE id = $1', [`b_${GAP}_3`]);
  rmSync(join(DL, 'T!afx/Gap Song/Chapter 3.cbz'), { force: true });
  await q('UPDATE lib_series SET gaps_checked_at = now(), gaps_result = $2::jsonb WHERE id = $1', [GAP, answer(4)]);
  const second = await runOnce();
  assert.ok((await installs(second.id)).length > 0, 'PREMISE: a fresh "nobody has it" about the series as it is sends the run looking');
});

test('with nothing left to try, the run\'s time running out is no reason to run again', { skip }, async () => {
  // Ghost Story was searched for on every package in reach, in vain (above); Quiet Harbor is carried by Cedar Hub, the
  // first left in the order. The run's time runs out once Cedar Hub is installed, and every package after it has already
  // missed Ghost Story: nothing is left to try, so the phase ends as finished and Ghost Story is Needs you -- not a Run
  // again that would try nothing. Reintroduce by asking the time before `forIt` in extensions(): Run again is offered.
  await series('quiet', 'Quiet Harbor');
  await only('ghost', 'quiet');
  const installsSoFar = () => fake!.graphqlCalls('updateExtension').length;
  const at = installsSoFar();
  autofix.setAutofixTiming({ quietMs: 20, clock: () => Date.now() + (installsSoFar() > at ? 3 * 60 * 60 * 1000 : 0) });
  let run;
  try {
    run = await runOnce();
  } finally {
    autofix.setAutofixTiming({ quietMs: 20 });
  }
  assert.deepEqual(await installs(run.id), [PKG.cedar], 'PREMISE: only Cedar Hub was left to try for these series');
  assert.equal(await mainOf('quiet'), `sw:${ID.cedar}`, 'PREMISE: Quiet Harbor moved to it');
  assert.equal(run.summary!.again, false, 'with nothing left to try, the run\'s time running out is no reason to run again');
  assert.ok(!run.log!.some((l) => l.code === 'autofix.item.skipped' && l.params?.why === 'time'), 'the run was not cut short');
  assert.ok(run.summary!.needsYou.some((n) => n.check === 'frozen-series'), 'and the series nothing in reach carries is Needs you');
});
