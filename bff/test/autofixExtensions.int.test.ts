// Fix everything's extensions phase (v0.55.0, lib/autofix.ts), against the strict fake engine: for series that no
// source carries, it installs at most AUTOFIX_INSTALLS extensions in the series' language -- ranked by the series' own
// translation groups -- switches on only the source in that language, searches the series there under Find's limits,
// keeps what now carries a series and removes what this run installed that carries none. An install that would not
// fit under the source limit is not made, and says so.
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
  amber: 'eu.kanade.tachiyomi.extension.en.ambercomics',
  birch: 'eu.kanade.tachiyomi.extension.en.birchreader',
  old: 'eu.kanade.tachiyomi.extension.en.oldshelf',
  coral: 'eu.kanade.tachiyomi.extension.ja.coraltoons',
};
const ID = {
  ball: '6716343437498271985', velvetEn: '7000000000000000100', velvetEs: '7000000000000000101', ember: '7000000000000000200',
  amber: '7000000000000000300', birch: '7000000000000000400', old: '7000000000000000500', coral: '7000000000000000600',
};
/** The extension the library's three series came from, uninstalled long ago: nothing provides this id now. */
const GONE = 'sw:5550001';
const chapters = (title: string) => [5, 4, 3, 2, 1].map((n) => ({ name: `${title} ${n}`, url: `/${title}/${n}`, chapterNumber: n, uploadDate: Date.UTC(2024, 0, n), pages: 3 }));
const manga = (title: string) => ({ title, url: `/${title.toLowerCase().replace(/ /g, '-')}`, chapters: chapters(title) });

function seed(): FakeSeed {
  const src = (id: string, name: string, lang: string, pkgName: string, mangas: Array<ReturnType<typeof manga>> = []) =>
    ({ id, name, lang, pkgName, supportsLatest: true, isNsfw: false, baseUrl: `https://${pkgName}.example`, mangas });
  return {
    sources: [
      src(ID.ball, 'Manga Ball', 'en', PKG.ball),
      src(ID.velvetEn, 'Velvet Scans', 'en', PKG.velvet, [manga('Moon River')]),
      src(ID.velvetEs, 'Velvet Scans', 'es', PKG.velvet),
      src(ID.ember, 'Ember Pages', 'en', PKG.ember, [manga('Lost Song')]),
      src(ID.amber, 'Amber Comics', 'en', PKG.amber),
      src(ID.birch, 'Birch Reader', 'en', PKG.birch, [manga('Night Bloom')]),
      // Both named to sort first: dropping the obsolete or the language guard installs them before Amber Comics.
      src(ID.old, 'Acorn Shelf', 'en', PKG.old, [manga('Night Bloom')]),
      src(ID.coral, 'Abyss Toons', 'ja', PKG.coral, [manga('Night Bloom')]),
    ],
    extensions: [
      { pkgName: PKG.ball, name: 'Manga Ball', lang: 'en', versionName: '1.4.7', installed: true, repo: BASE },
      { pkgName: PKG.velvet, name: 'Velvet Scans', lang: 'all', versionName: '1.0.0', installed: false, repo: BASE },
      { pkgName: PKG.ember, name: 'Ember Pages', lang: 'en', versionName: '1.0.0', installed: false, repo: BASE },
      { pkgName: PKG.amber, name: 'Amber Comics', lang: 'en', versionName: '1.0.0', installed: false, repo: BASE },
      { pkgName: PKG.birch, name: 'Birch Reader', lang: 'en', versionName: '1.0.0', installed: false, repo: BASE },
      { pkgName: PKG.old, name: 'Acorn Shelf', lang: 'en', versionName: '1.0.0', installed: false, obsolete: true, repo: BASE },
      { pkgName: PKG.coral, name: 'Abyss Toons', lang: 'ja', versionName: '1.0.0', installed: false, repo: BASE },
    ],
    settings: {},
  };
}

const SERIES = { lost: 's_afx_lost', moon: 's_afx_moon', night: 's_afx_night' };
const TITLE = { lost: 'Lost Song', moon: 'Moon River', night: 'Night Bloom' };
/** Each series' own translation group on disk: what ranks the candidates (no site is named in the code). */
const GROUP = { lost: 'Ember Pages', moon: 'Velvet Scans', night: null as string | null };
const LIB = 'lib_afx';

let fake: FakeSuwayomi | null = null;
let q: any, autofix: typeof import('../src/lib/autofix'), env: any, adminId = '';

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
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q } = (await import('../src/lib/db')) as any);
  ({ env } = (await import('../src/env')) as any);
  autofix = await import('../src/lib/autofix');
  const find = await import('../src/lib/findSources');
  find.setFindTiming({ paceMs: 0, quietMs: 20, busyMs: 50, wallMs: 10_000 });
  autofix.setAutofixTiming({ quietMs: 20 });
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
  for (const k of ['lost', 'moon', 'night'] as const) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
             VALUES ($1,'T!afx',$2,$3,5,$4,$5,'1',true)`, [SERIES[k], TITLE[k], `T!afx/${TITLE[k]}`, LIB, GONE]);
    for (const n of [1, 2, 3, 4, 5]) {
      const file = `T!afx/${TITLE[k]}/Chapter ${n}.cbz`;
      const z = new AdmZip();
      for (let i = 0; i < 3; i++) z.addFile(`${i}.png`, Buffer.alloc(80, 1));
      z.addFile('ComicInfo.xml', Buffer.from(`<?xml version="1.0"?><ComicInfo><Series>${TITLE[k]}</Series></ComicInfo>`));
      mkdirSync(join(DL, `T!afx/${TITLE[k]}`), { recursive: true });
      writeFileSync(join(DL, file), z.toBuffer());
      await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, pages_checked_at, root, scanlator, source_id)
               VALUES ($1,$2,'T!afx',$3,$4,$5,3,now(),$6,$7,$8)`,
        [`b_${SERIES[k]}_${n}`, SERIES[k], file, n, `Chapter ${n}`, DL, GROUP[k], GONE]);
    }
  }
});

after(async () => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  await fake?.close();
  if (!DSN) return;
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [Object.values(SERIES)]).catch(() => {});
  await q('DELETE FROM suwayomi_sources').catch(() => {});
  await q(`DELETE FROM users WHERE username = 'afx-admin'`).catch(() => {});
});

const installs = async (runId: string) =>
  (await q(`SELECT detail->>'pkgName' AS pkg FROM audit_log WHERE event = 'extension.install' AND detail->>'runId' = $1 ORDER BY at, id`, [runId]))
    .map((r: any) => r.pkg);

test('the extensions phase: ranked by the series\' own groups, at most three, only their language, kept when they carry', { skip }, async (t) => {
  const started = autofix.startAutofix(adminId);
  assert.ok('runId' in started);
  await autofix.autofixSettled();
  const run = await autofix.autofixRun(started.runId);
  assert.equal(run?.status, 'done');

  await t.test('at most AUTOFIX_INSTALLS installs, the series\' own groups first, in their language, never an obsolete one', async () => {
    // What was installed, from the audit: a package installed and removed again in the run counts too.
    // Reintroduce by dropping the obsolete or the language filter in extensions() (Acorn Shelf, Abyss Toons sort first),
    // or the budget check (Birch Reader, the fourth candidate, is installed too).
    const pkgs = await installs(started.runId);
    assert.ok(!pkgs.includes(PKG.old), 'never an obsolete package');
    assert.ok(!pkgs.includes(PKG.coral), 'never one in another language');
    assert.ok(pkgs.length <= 3 && !pkgs.includes(PKG.birch), `never more than three a run: ${pkgs.join(', ')}`);
    assert.deepEqual(pkgs, [PKG.ember, PKG.velvet, PKG.amber], 'the two the series\' groups name first, then the next in English');
  });

  await t.test('only the source in the series\' language is switched on', async () => {
    // Reintroduce by adopting the package's sources as the install route does (adoptExtensionSources(provided, true)):
    // Velvet Scans' Spanish source is switched on too, and takes a slot under the limit.
    const rows = new Map((await q(`SELECT source_id, enabled FROM suwayomi_sources WHERE source_id = ANY($1)`, [[ID.velvetEn, ID.velvetEs]]))
      .map((r: any) => [r.source_id, r.enabled]));
    assert.equal(rows.get(ID.velvetEn), true, 'its English source is on');
    assert.equal(rows.get(ID.velvetEs), false, 'only the series\' language is switched on');
  });

  await t.test('the series it carries move to it; what carries one is kept, what this run installed for nothing goes', async () => {
    const main = async (id: string) => (await q('SELECT source_id FROM lib_series WHERE id = $1', [id]))[0].source_id;
    assert.equal(await main(SERIES.lost), `sw:${ID.ember}`, 'Lost Song moved to the extension its group runs');
    assert.equal(await main(SERIES.moon), `sw:${ID.velvetEn}`, 'and Moon River to Velvet Scans\' English source');
    assert.equal(await main(SERIES.night), GONE, 'Night Bloom: nothing in reach carries it');
    // Reintroduce by keeping every package this run installed (drop the uninstall in keepOrRemove): Amber Comics stays.
    assert.equal(fake!.extension(PKG.ember).installed, true, 'a package that carries a series is kept');
    assert.equal(fake!.extension(PKG.velvet).installed, true);
    assert.equal(fake!.extension(PKG.amber).installed, false, 'one this run installed that carries nothing is removed again');
    assert.equal(fake!.extension(PKG.ball).installed, true, 'and nothing it did not install is ever removed');
    const installed = run!.summary!.done.find((d) => d.kind === 'installed');
    assert.deepEqual(installed?.said, { code: 'autofix.done.installed', params: { names: ['Ember Pages', 'Velvet Scans'], more: 0, n: 2 } });
    assert.equal(run!.summary!.done.find((d) => d.kind === 'uninstalled')?.n, 1);
    const via = await q(`SELECT DISTINCT detail->>'via' AS via FROM audit_log WHERE event IN ('extension.install','extension.uninstall') AND detail->>'runId' = $1`, [started.runId]);
    assert.deepEqual(via.map((r: any) => r.via), ['autofix'], 'audited as Fix everything\'s');
    // Night Bloom is not a person's yet: the run stopped at its three installs with Birch Reader -- which carries it --
    // still untried (v0.55.0 integration: Needs you never holds what a run could still fix). The next run continues.
    assert.ok(!run!.summary!.needsYou.some((n) => n.check === 'frozen-series'), 'a series the next install may carry is Needs you');
    assert.ok(run!.log!.some((l) => l.code === 'autofix.item.skipped' && l.params?.why === 'installs'), 'PREMISE: the install budget ran out');
    assert.ok(run!.summary!.clears.some((c) => c.said.code === 'autofix.clears.nextRun'), 'the next run continues it');
    assert.equal(run!.summary!.again, true, 'and Run again is offered');
  });
});

test('an install that would not fit under the source limit is not made, and it is Needs you', { skip }, async () => {
  // Reintroduce by installing whatever the limit says (drop the wouldFit check in tryPackage): Birch Reader is installed.
  const original = env.SUWAYOMI_MAX_SOURCES;
  const on = (await q('SELECT count(*)::int AS n FROM suwayomi_sources WHERE enabled'))[0].n;
  env.SUWAYOMI_MAX_SOURCES = on;
  try {
    const started = autofix.startAutofix(adminId);
    assert.ok('runId' in started);
    await autofix.autofixSettled();
    const run = await autofix.autofixRun(started.runId);
    assert.deepEqual(await installs(started.runId), [], 'an install that would not fit is not made');
    assert.equal(fake!.extension(PKG.birch).installed, false);
    const need = run!.summary!.needsYou.find((n) => n.said.code === 'autofix.needs.noRoom');
    assert.equal(need?.check, 'extension-cap');
    // Reintroduce by dropping the tried filter in extensions(): Amber Comics, which the last run found carrying nothing,
    // is the first candidate again.
    assert.deepEqual(need?.said.params, { name: 'Birch Reader' }, 'naming the package that may carry the series, never one the last run found carrying nothing');
    // Every candidate tried or out of room: the series nothing in reach carries is a person's now.
    assert.ok(run!.summary!.needsYou.some((n) => n.check === 'frozen-series'), 'the series nothing carries is Needs you');
  } finally {
    env.SUWAYOMI_MAX_SOURCES = original;
  }
});
