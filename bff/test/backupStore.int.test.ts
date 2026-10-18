// Trying extensions from the repository (v0.83.0, lib/sourceScout.ts storeLook), against the strict fake engine: for the
// series the scout asked every installed source about in vain, Uchiyomi installs a repository extension -- the best
// match first, one at a time, at most one an hour and six a day -- asks it about every such series in the language,
// keeps it as a backup when one follows it, and removes it at once when none does, remembering what it did not have.
// The owner's answer, 2026-10-18: "Yes, a few at a time".
//
// The tests share the engine and run in order: each says what the ones before it left.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FakeSeed, FakeSuwayomi } from './fixtures/fakeSuwayomi';

const DSN = process.env.TEST_DATABASE_URL;
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
let ROOT = '';

const REPO = 'https://repo.example/repo.json';
const PKG = {
  main: 'eu.kanade.tachiyomi.extension.en.bsmain',
  /** No English source at all: a miss for the language. Tried first (the highest version). */
  nolang: 'eu.kanade.tachiyomi.extension.all.bsnolang',
  /** English, and has none of the series. */
  miss: 'eu.kanade.tachiyomi.extension.en.bsmiss',
  /** English, and has Gold Harbor and Copper Vale: one install for both. */
  hit: 'eu.kanade.tachiyomi.extension.en.bshit',
  /** 18+, and the only one that has Iron Gate, which is not. */
  adult: 'eu.kanade.tachiyomi.extension.en.bsadult',
  /** Japanese: never for an English series. */
  ja: 'eu.kanade.tachiyomi.extension.ja.bsja',
} as const;
type Key = keyof typeof PKG;
const ID: Record<Key, string> = {
  main: '7300000000000000001', nolang: '7300000000000000002', miss: '7300000000000000003',
  hit: '7300000000000000004', adult: '7300000000000000005', ja: '7300000000000000006',
};
const SW = (k: Key) => `sw:${ID[k]}`;
const GOLD = 's_bks_gold', COPPER = 's_bks_copper', IRONG = 's_bks_iron', TIN = 's_bks_tin';
const SERIES = [GOLD, COPPER, IRONG, TIN];
const LIB = 'lib_bks';

const chapters = (title: string, upTo: number) => Array.from({ length: upTo }, (_, i) => upTo - i)
  .map((n) => ({ name: `${title} ${n}`, url: `/${title.toLowerCase().replace(/ /g, '-')}/${n}`, chapterNumber: n, uploadDate: Date.UTC(2024, 0, n), pages: 3 }));
const manga = (title: string, upTo: number) => ({ title, url: `/${title.toLowerCase().replace(/ /g, '-')}`, chapters: chapters(title, upTo) });

function seed(): FakeSeed {
  const src = (k: Key, name: string, lang: string, mangas: Array<ReturnType<typeof manga>> = [], o: { isNsfw?: boolean; id?: string } = {}) =>
    ({ id: o.id ?? ID[k], name, lang, pkgName: PKG[k], supportsLatest: true, isNsfw: !!o.isNsfw, baseUrl: `https://${k}.bks.example`, mangas });
  const ext = (k: Key, name: string, lang: string, versionCode: number, o: { installed?: boolean; isNsfw?: boolean } = {}) =>
    ({ pkgName: PKG[k], name, lang, versionName: '1.0.0', installed: !!o.installed, obsolete: false, isNsfw: !!o.isNsfw, versionCode, repo: REPO });
  return {
    sources: [
      src('main', 'BS Main', 'en', [manga('Gold Harbor', 12), manga('Copper Vale', 8), manga('Iron Gate', 8), manga('Tin Road', 8)]),
      src('nolang', 'BS Nolang', 'es', [manga('Gold Harbor', 14)]),
      src('miss', 'BS Miss', 'en', [manga('Other Story', 10)]),
      src('hit', 'BS Hit', 'en', [manga('Gold Harbor', 14), manga('Copper Vale', 8)]),
      src('adult', 'BS Adult', 'en', [manga('Iron Gate', 10)], { isNsfw: true }),
      src('ja', 'BS Ja', 'ja', [manga('Gold Harbor', 14)]),
    ],
    extensions: [
      ext('main', 'BS Main', 'en', 1, { installed: true }),
      ext('nolang', 'BS Nolang', 'all', 9),
      ext('miss', 'BS Miss', 'en', 5),
      ext('hit', 'BS Hit', 'en', 3),
      ext('adult', 'BS Adult', 'en', 10, { isNsfw: true }),
      ext('ja', 'BS Ja', 'ja', 20),
    ],
    settings: {},
  };
}

let fake: FakeSuwayomi | null = null;
let q: any;
let bx: typeof import('../src/lib/backupExtensions');
let scout: typeof import('../src/lib/sourceScout');
let builtins: string[] = [];

const installed = (k: Key) => fake!.extension(PKG[k]).installed;
const tried = async () => (await q(`SELECT detail->>'pkgName' AS pkg FROM audit_log WHERE event = 'extension.install' AND detail->>'reason' = 'store' ORDER BY id`))
  .map((r: any) => r.pkg);
const misses = async () => (await q(`SELECT pkg_name, series_id, lang FROM backup_misses ORDER BY pkg_name, series_id NULLS FIRST`))
  .map((r: any) => `${r.pkg_name.split('.').pop()}:${r.series_id ?? `lang ${r.lang}`}`).sort();
const follows = async (series: string) => (await q('SELECT source_id FROM series_sources WHERE series_id = $1 ORDER BY source_id', [series])).map((r: any) => r.source_id);

/** A series on BS Main -- cooling -- with chapters 1..`have` here of 1..`listed`, that every installed source said no to an hour ago. */
async function stuck(id: string, title: string, have: number, listed: number) {
  await q('DELETE FROM lib_series WHERE id = $1', [id]).catch(() => {});
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update, lang, source_checked_at, source_missing, finish_missing)
           VALUES ($1,'T!bks',$2,$1,$3,$4,$5,'1',true,'en',now(),$6,$6)`, [id, title, have, LIB, SW('main'), listed - have]);
  for (let n = 1; n <= have; n++) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, pages_checked_at, root, source_id)
             VALUES ($1,$2,'T!bks',$3,$4,$5,3,now(),$6,$7)`, [`b_${id}_${n}`, id, `T!bks/${title}/Chapter ${n}.cbz`, n, `Chapter ${n}`, join(ROOT, 'dl'), SW('main')]);
  }
  for (let n = 1; n <= listed; n++) {
    const chosen = { sourceId: `main-c${n}`, source: SW('main'), number: n };
    const copy = { sourceId: `main-c${n}`, source: SW('main'), groups: [], scanlator: null, lang: null, pages: null, publishedAt: null };
    await q(`INSERT INTO series_listing (series_id, number, source_id, chosen, status, copies) VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb)`,
      [id, n, SW('main'), JSON.stringify(chosen), n <= have ? 'held' : 'available', JSON.stringify([copy])]);
  }
  await q(`INSERT INTO series_scout (series_id, reason, verdict, stuck_since, next_at) VALUES ($1, 'stuck', 'exhausted', now() - interval '2 hours', now() + interval '1 hour')
           ON CONFLICT (series_id) DO UPDATE SET verdict = 'exhausted', stuck_since = EXCLUDED.stuck_since`, [id]);
}

before(async () => {
  if (!DSN) return;
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-bks-'));
  for (const d of ['dl', 'lib', 'packs']) mkdirSync(join(ROOT, d), { recursive: true });
  const { startFakeSuwayomi } = await import('./fixtures/fakeSuwayomi');
  fake = await startFakeSuwayomi({ seed: seed() });
  // ⚠️ Before anything from src: env.ts reads these once.
  process.env.DATABASE_URL = DSN;
  process.env.SUWAYOMI_URL = fake.url;
  process.env.EXTENSION_ENGINE = '1';
  delete process.env.UCHIYOMI_PLATFORM;
  delete process.env.HOST_OS;
  delete process.env.FLARESOLVERR_URL;
  process.env.DL_ROOT = join(ROOT, 'dl');
  process.env.LIBRARY_ROOT = join(ROOT, 'lib');
  process.env.SOURCES_DIR = join(ROOT, 'packs');
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.MIN_FREE_GB = '0';
  process.env.UCHIYOMI_PING_URL = '';
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q } = (await import('../src/lib/db')) as any);
  bx = await import('../src/lib/backupExtensions');
  scout = await import('../src/lib/sourceScout');
  const sources = await import('../src/lib/sources');
  await q('DELETE FROM suwayomi_sources');
  await q(`DELETE FROM source_health WHERE source_id LIKE 'sw:%'`);
  await q('DELETE FROM backup_extensions');
  await q('DELETE FROM backup_misses');
  const reg = await import('../src/lib/sources/suwayomi/register');
  await reg.loadSuwayomiSources();
  await q(`UPDATE suwayomi_sources SET enabled = true WHERE source_id = $1`, [ID.main]);
  await sources.reloadAll();
  const { setDisabled } = await import('../src/lib/sourceHealth');
  builtins = sources.listSources().map((s) => s.id).filter((id) => !id.startsWith('sw:'));
  for (const id of builtins) await setDisabled(id, true);
  await q(`INSERT INTO source_health (source_id, status, consecutive, blocked_until) VALUES ($1, 'rate_limited', 1, now() + interval '6 hours')
           ON CONFLICT (source_id) DO UPDATE SET status = 'rate_limited', blocked_until = now() + interval '6 hours'`, [SW('main')]);
  await q(`UPDATE server_settings SET finish_downloads = true, auto_follow_on_failure = true WHERE id = 1`);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Bks',$2) ON CONFLICT (id) DO NOTHING`, [LIB, join(ROOT, 'dl')]);
  await stuck(GOLD, 'Gold Harbor', 9, 12);
  await stuck(COPPER, 'Copper Vale', 5, 8);
  await stuck(IRONG, 'Iron Gate', 5, 8);
});

after(async () => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  await fake?.close();
  if (!DSN) return;
  bx._setBackupLimits({ trialsPerHour: 1, trialsPerDay: 6, max: 5 });
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM backup_extensions').catch(() => {});
  await q('DELETE FROM backup_misses').catch(() => {});
  await q('DELETE FROM suwayomi_sources').catch(() => {});
  await q(`DELETE FROM source_health WHERE source_id = ANY($1::text[]) OR source_id LIKE 'sw:%'`, [builtins]).catch(() => {});
  await q(`DELETE FROM audit_log WHERE detail->>'pkgName' LIKE 'eu.kanade.tachiyomi.extension.%.bs%'`).catch(() => {});
  await q(`DELETE FROM download_log WHERE folder LIKE 'bks-%'`).catch(() => {});
});

test('the best match first; one with no source in the language is removed at once, and an hour passes before the next', { skip }, async () => {
  // BS Nolang has the highest version, and no English source. Reintroduce by dropping the hourly bound (trialAllowed
  // answering true): a second extension is installed straight after the first.
  scout._resetScout();
  const first = await scout.storeLook();
  assert.equal(first?.pkg, PKG.nolang, 'the best ranked: no group names one, so the most updated');
  assert.deepEqual(first?.asked, [], 'it has no English source to ask');
  assert.equal(first?.kept, false);
  assert.equal(installed('nolang'), false, 'removed at once');
  assert.deepEqual(await misses(), ['bsnolang:lang en'], 'and remembered for the language');
  assert.equal(await scout.storeLook(), null, 'one install an hour');
  assert.deepEqual(await tried(), [PKG.nolang]);
});

test('one install is asked about every series waiting in its language; a miss is removed and remembered for each', { skip }, async () => {
  // Reintroduce by asking one series per install: BS Miss is installed three times.
  bx._setBackupLimits({ trialsPerHour: 99, trialsPerDay: 99 });
  scout._resetScout();
  const look = await scout.storeLook();
  assert.equal(look?.pkg, PKG.miss, 'the language\'s miss is never tried again; the next best is');
  assert.deepEqual([...(look?.asked ?? [])].sort(), [COPPER, GOLD, IRONG].sort(), 'every series waiting, with one install');
  assert.equal(look?.kept, false);
  assert.equal(installed('miss'), false, 'removed at once');
  assert.deepEqual(await misses(), ['bsmiss:s_bks_copper', 'bsmiss:s_bks_gold', 'bsmiss:s_bks_iron', 'bsnolang:lang en']);
});

test('one that has them is kept as a backup and followed, by every series it has', { skip }, async () => {
  scout._resetScout();
  const look = await scout.storeLook();
  assert.equal(look?.pkg, PKG.hit);
  assert.deepEqual([...(look?.followed ?? [])].sort(), [COPPER, GOLD].sort(), 'both series it has follow it, from one install');
  assert.equal(look?.kept, true);
  assert.equal(installed('hit'), true);
  assert.deepEqual(await follows(GOLD), [SW('hit')]);
  assert.deepEqual(await follows(COPPER), [SW('hit')]);
  const row = (await q('SELECT state, via FROM backup_extensions WHERE pkg_name = $1', [PKG.hit]))[0];
  assert.deepEqual(row, { state: 'active', via: 'scout' }, 'a backup, out of Discover and removed when unused');
  assert.ok((await misses()).includes('bshit:s_bks_iron'), 'and what it did not have is remembered');
  assert.deepEqual(await tried(), [PKG.nolang, PKG.miss, PKG.hit], 'three installs in all, for three series');
});

test('never an 18+ extension for a series that is not, nor one in another language', { skip }, async () => {
  // Iron Gate, not 18+, is left, and only BS Adult (18+) has it; BS Ja is Japanese. Reintroduce by dropping the 18+ rule
  // in storeLook (forIt without `x.adult`): BS Adult is installed for it.
  scout._resetScout();
  assert.equal(await scout.storeLook(), null, 'nothing left that may be tried');
  assert.equal(installed('adult'), false);
  assert.equal(installed('ja'), false);
});

test('the cap holds for the repository\'s extensions too, and the switch turns it all off', { skip }, async () => {
  // Tin Road waits, rated 18+. Within BACKUP_EXTENSIONS_MAX only: BS Hit, in use, holds the one place. Reintroduce by
  // installing whatever the cap says (drop makeRoom in storeLook): an extension is installed for it.
  await stuck(TIN, 'Tin Road', 5, 8);
  await q(`UPDATE lib_series SET age_rating = 18 WHERE id = $1`, [TIN]);
  await q(`INSERT INTO download_log (folder, title, number, source, origin, status, started_at, finished_at)
           VALUES ('bks-gold', 'Gold Harbor', 10, $1, 'sweep', 'done', now(), now())`, [SW('hit')]);
  bx._setBackupLimits({ max: 1 });
  try {
    scout._resetScout();
    assert.equal(await scout.storeLook(), null, 'no room: nothing installed');
    assert.equal(installed('adult'), false);
    assert.equal(installed('miss'), false);
    assert.equal(installed('hit'), true, 'and the one in use stays');
  } finally {
    bx._setBackupLimits({ max: 5 });
  }
  await q('UPDATE server_settings SET finish_downloads = false, auto_follow_on_failure = false WHERE id = 1');
  try {
    scout._resetScout();
    assert.equal(await scout.storeLook(), null, 'switched off: nothing tried');
    assert.equal(installed('adult'), false);
    assert.equal(installed('miss'), false);
  } finally {
    await q('UPDATE server_settings SET finish_downloads = true, auto_follow_on_failure = true WHERE id = 1');
  }
  // With room and the switch on: the next best for Tin Road, and then, Tin Road being rated 18+, an 18+ extension.
  scout._resetScout();
  assert.equal((await scout.storeLook())?.pkg, PKG.miss, 'PREMISE: it was the room, and the switch, that held it');
  scout._resetScout();
  assert.equal((await scout.storeLook())?.pkg, PKG.adult, 'for a series rated 18+, an 18+ extension may be tried');
});
