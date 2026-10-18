// Backup extensions (v0.82.0, lib/backupExtensions.ts), against the strict fake engine: the extensions Uchiyomi installs
// by itself to finish downloads are kept out of Discover, removed once nothing has needed them for three days --
// remembered, with the series they carried -- and put back when one of those series is stuck again. Never a series'
// main source, never more than BACKUP_EXTENSIONS_MAX at once, never one a person removed, one install at a time, and a
// wiped engine never brings back one Uchiyomi removed. The owner's ask, 2026-10-18: "once everything is fully downloaded
// it removes those backup extensions it used just for this purpose and when there is new chapters it will just use main
// until it rate limits or fail again and then it can reinstall/reuse those".
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
  main: 'eu.kanade.tachiyomi.extension.en.bkmain',
  spare: 'eu.kanade.tachiyomi.extension.en.bkspare',
  idle: 'eu.kanade.tachiyomi.extension.en.bkidle',
  busy: 'eu.kanade.tachiyomi.extension.en.bkbusy',
  pin: 'eu.kanade.tachiyomi.extension.en.bkpin',
  mine: 'eu.kanade.tachiyomi.extension.en.bkmine',
} as const;
type Key = keyof typeof PKG;
const ID: Record<Key, string> = {
  main: '7200000000000000001', spare: '7200000000000000002', idle: '7200000000000000003',
  busy: '7200000000000000004', pin: '7200000000000000005', mine: '7200000000000000006',
};
const SW = (k: Key) => `sw:${ID[k]}`;
const NAME: Record<Key, string> = { main: 'BK Main', spare: 'BK Spare', idle: 'BK Idle', busy: 'BK Busy', pin: 'BK Pin', mine: 'BK Mine' };
const SILVER = 's_bkx_silver', IRON = 's_bkx_iron', IRON2 = 's_bkx_iron2', PINS = 's_bkx_pins';
const SERIES = [SILVER, IRON, IRON2, PINS];
const LIB = 'lib_bkx';

const chapters = (title: string, upTo: number) => Array.from({ length: upTo }, (_, i) => upTo - i)
  .map((n) => ({ name: `${title} ${n}`, url: `/${title.toLowerCase().replace(/ /g, '-')}/${n}`, chapterNumber: n, uploadDate: Date.UTC(2024, 0, n), pages: 3 }));
const manga = (title: string, upTo: number) => ({ title, url: `/${title.toLowerCase().replace(/ /g, '-')}`, chapters: chapters(title, upTo) });

function seed(): FakeSeed {
  const src = (k: Key, name: string, mangas: Array<ReturnType<typeof manga>> = []) =>
    ({ id: ID[k], name, lang: 'en', pkgName: PKG[k], supportsLatest: true, isNsfw: false, baseUrl: `https://${k}.bkx.example`, mangas });
  const ext = (k: Key, name: string, installed: boolean) =>
    ({ pkgName: PKG[k], name, lang: 'en', versionName: '1.0.0', installed, obsolete: false, isNsfw: false, versionCode: 1, repo: REPO });
  return {
    sources: [
      src('main', 'BK Main', [manga('Silver Tide', 12)]),
      // The backup that carries Silver Tide, all twelve and two more.
      src('spare', 'BK Spare', [manga('Silver Tide', 14)]),
      src('idle', 'BK Idle', [manga('Iron Bloom', 6)]),
      src('busy', 'BK Busy', [manga('Iron Bloom', 7)]),
      src('pin', 'BK Pin', [manga('Pin Story', 6)]),
      src('mine', 'BK Mine'),
    ],
    extensions: [
      ext('main', 'BK Main', true), ext('spare', 'BK Spare', false), ext('idle', 'BK Idle', true),
      ext('busy', 'BK Busy', true), ext('pin', 'BK Pin', true), ext('mine', 'BK Mine', true),
    ],
    settings: {},
  };
}

let fake: FakeSuwayomi | null = null;
let q: any, env: any;
let bx: typeof import('../src/lib/backupExtensions');
let scout: typeof import('../src/lib/sourceScout');
let lock: typeof import('../src/lib/sources/suwayomi/installLock');
let sources: typeof import('../src/lib/sources');
/** The registered sources that are not an extension's, switched off so the scout asks only what a test names. */
let builtins: string[] = [];

const installed = (k: Key) => fake!.extension(PKG[k]).installed;
const row = async (k: Key) => (await q('SELECT state, why, via, last_needed_at FROM backup_extensions WHERE pkg_name = $1', [PKG[k]]))[0] ?? null;
const mangaId = (k: Key) => String(fake!.source(ID[k]).mangas[0].id);
const follows = async (series: string) => (await q('SELECT source_id, source_series_id FROM series_sources WHERE series_id = $1 ORDER BY source_id', [series]));
const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 3600_000).toISOString();

/** A backup, as Uchiyomi records one: `active`, last needed `days` ago. */
async function backup(k: Key, days = 0, state = 'active') {
  await q(`INSERT INTO backup_extensions (pkg_name, name, lang, state, via, installed_at, last_needed_at, updated_at)
           VALUES ($1, $2, 'en', $3, 'autofix', now(), $4, now())
           ON CONFLICT (pkg_name) DO UPDATE SET state = EXCLUDED.state, last_needed_at = EXCLUDED.last_needed_at, parked_at = NULL`,
  [PKG[k], NAME[k], state, daysAgo(days)]);
}
/** A series, its chapters 1..`have` here and `listed` listed by `listedOn`. */
async function series(id: string, title: string, o: { main: string | null; mainRef?: string; have: number; listed: number; listedOn: string }) {
  await q('DELETE FROM lib_series WHERE id = $1', [id]).catch(() => {});
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update, lang, source_checked_at, source_missing, finish_missing)
           VALUES ($1,'T!bkx',$2,$1,$3,$4,$5,$6,true,'en',now(),$7,$7)`,
  [id, title, o.have, LIB, o.main, o.main ? (o.mainRef ?? '1') : null, Math.max(0, o.listed - o.have)]);
  for (let n = 1; n <= o.have; n++) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, pages_checked_at, root, source_id)
             VALUES ($1,$2,'T!bkx',$3,$4,$5,3,now(),$6,$7)`, [`b_${id}_${n}`, id, `T!bkx/${title}/Chapter ${n}.cbz`, n, `Chapter ${n}`, join(ROOT, 'dl'), o.main]);
  }
  for (let n = 1; n <= o.listed; n++) {
    const chosen = { sourceId: `${o.listedOn}-c${n}`, source: o.listedOn, number: n };
    const copy = { sourceId: `${o.listedOn}-c${n}`, source: o.listedOn, groups: [], scanlator: null, lang: null, pages: null, publishedAt: null };
    await q(`INSERT INTO series_listing (series_id, number, source_id, chosen, status, copies) VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb)`,
      [id, n, o.listedOn, JSON.stringify(chosen), n <= o.have ? 'held' : 'available', JSON.stringify([copy])]);
  }
}
const follow = (series: string, k: Key, title: string) => q(
  `INSERT INTO series_sources (series_id, source_id, source_series_id, title, coverage, added_by) VALUES ($1,$2,$3,$4,1,NULL)
   ON CONFLICT (series_id, source_id) DO NOTHING`, [series, SW(k), mangaId(k), title]);
const cool = (id: string) => q(`INSERT INTO source_health (source_id, status, consecutive, blocked_until) VALUES ($1, 'rate_limited', 1, now() + interval '1 hour')
  ON CONFLICT (source_id) DO UPDATE SET status = 'rate_limited', blocked_until = now() + interval '1 hour'`, [id]);
const snapshot = (k: Key, on: boolean) => q(
  `INSERT INTO extension_catalog (pkg_name, name, lang, repo, version_name, installed, obsolete, nsfw, installed_version, last_seen, updated_at)
   VALUES ($1, $2, 'en', $3, '1.0.0', $4, false, false, CASE WHEN $4 THEN '1.0.0' END, now(), now())
   ON CONFLICT (pkg_name) DO UPDATE SET installed = EXCLUDED.installed`, [PKG[k], NAME[k], REPO, on]);

before(async () => {
  if (!DSN) return;
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-bkx-'));
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
  ({ env } = (await import('../src/env')) as any);
  bx = await import('../src/lib/backupExtensions');
  scout = await import('../src/lib/sourceScout');
  lock = await import('../src/lib/sources/suwayomi/installLock');
  sources = await import('../src/lib/sources');
  await q('DELETE FROM suwayomi_sources');
  await q(`DELETE FROM source_health WHERE source_id LIKE 'sw:%'`);
  await q('DELETE FROM backup_extensions');
  await q(`DELETE FROM extension_catalog WHERE pkg_name = ANY($1::text[])`, [Object.values(PKG)]);
  const reg = await import('../src/lib/sources/suwayomi/register');
  await reg.loadSuwayomiSources();
  await q(`UPDATE suwayomi_sources SET enabled = true WHERE source_id = ANY($1::text[])`, [Object.values(ID)]);
  await sources.reloadAll();
  const { setDisabled } = await import('../src/lib/sourceHealth');
  builtins = sources.listSources().map((s) => s.id).filter((id) => !id.startsWith('sw:'));
  for (const id of builtins) await setDisabled(id, true);
  for (const k of Object.keys(PKG) as Key[]) await snapshot(k, installed(k));
  await q(`UPDATE server_settings SET finish_downloads = true, auto_follow_on_failure = true, extension_repos = $1 WHERE id = 1`, [JSON.stringify([REPO])]);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Bkx',$2) ON CONFLICT (id) DO NOTHING`, [LIB, join(ROOT, 'dl')]);
});

after(async () => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  await fake?.close();
  if (!DSN) return;
  bx._setBackupLimits({ max: 5 });
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM backup_extensions').catch(() => {});
  await q('DELETE FROM suwayomi_sources').catch(() => {});
  await q(`DELETE FROM source_health WHERE source_id = ANY($1::text[]) OR source_id LIKE 'sw:%'`, [builtins]).catch(() => {});
  await q(`DELETE FROM extension_catalog WHERE pkg_name = ANY($1::text[])`, [Object.values(PKG)]).catch(() => {});
  await q(`DELETE FROM download_log WHERE folder LIKE 'bkx-%'`).catch(() => {});
});

test('the upgrade: what Fix everything installed becomes a backup, and what a person chose or removed stays theirs', { skip }, async () => {
  // v0.82.0's one-time seed (lib/migrate.ts seedBackupExtensions), from the audit log. Reintroduce by seeding every
  // install (drop `l.via = 'autofix'`): Seed E, a person's install, becomes a backup. By leaving out a person's own
  // follow (the `chosen` set): Seed B, which someone followed for a series by hand, becomes one.
  const { migrate, BACKUP_SEED_MIGRATION } = await import('../src/lib/migrate');
  const P = (x: string) => `pkg.bkseed.${x}`;
  const S = (x: string) => `990000000000000${{ a: '0001', b: '0002', c: '0003', e: '0005', f: '0006' }[x]}`;
  for (const x of ['a', 'b', 'c', 'e', 'f']) {
    await q(`INSERT INTO suwayomi_sources (source_id, name, lang, enabled, pkg_name, ext_name) VALUES ($1, $2, 'en', true, $3, $2)
             ON CONFLICT (source_id) DO UPDATE SET pkg_name = EXCLUDED.pkg_name`, [S(x), `Seed ${x}`, P(x)]);
  }
  const audit = (event: string, at: number, detail: Record<string, unknown>) =>
    q(`INSERT INTO audit_log (event, at, detail) VALUES ($1, now() - ($2 || ' days')::interval, $3::jsonb)`, [event, String(at), JSON.stringify(detail)]);
  await audit('extension.install', 5, { pkgName: P('a'), via: 'autofix', runId: 'r1' });
  await audit('extension.install', 5, { pkgName: P('b'), via: 'autofix', runId: 'r1' });
  await audit('series.follow_source', 1, { id: 'x', title: 'X', source: `sw:${S('b')}`, sourceSeriesId: '1', coverage: 1 });
  await audit('extension.install', 5, { pkgName: P('c'), via: 'autofix', runId: 'r1' });
  await audit('extension.enable', 2, { pkgName: P('c'), on: 1 });
  await audit('extension.uninstall', 3, { pkgName: P('d') });
  await audit('extension.install', 4, { pkgName: P('e') });
  await audit('extension.install', 5, { pkgName: P('f'), via: 'autofix', runId: 'r1' });
  await audit('series.follow_source', 1, { id: 'y', title: 'Y', source: `sw:${S('f')}`, sourceSeriesId: '1', coverage: 1, auto: true, reason: 'scout' });
  try {
    await q(`DELETE FROM schema_migrations WHERE id = $1`, [BACKUP_SEED_MIGRATION]);
    await migrate();
    const got = Object.fromEntries((await q(`SELECT pkg_name, state, via FROM backup_extensions WHERE pkg_name LIKE 'pkg.bkseed.%'`))
      .map((r: any) => [r.pkg_name.slice('pkg.bkseed.'.length), `${r.state}${r.via ? `/${r.via}` : ''}`]));
    assert.deepEqual(got, { a: 'active/autofix', d: 'refused', f: 'active/autofix' },
      'Fix everything\'s installs are backups (an automatic follow changes nothing), a person\'s removal is refused, and a person\'s install, turn-on or follow stays theirs');
  } finally {
    await q(`DELETE FROM backup_extensions WHERE pkg_name LIKE 'pkg.bkseed.%'`);
    await q(`DELETE FROM suwayomi_sources WHERE pkg_name LIKE 'pkg.bkseed.%'`);
    await q(`DELETE FROM audit_log WHERE detail->>'pkgName' LIKE 'pkg.bkseed.%' OR detail->>'source' LIKE 'sw:990000000000000%'`);
  }
});

test('a backup nothing has needed for three days is removed, and the series it carried are remembered', { skip }, async () => {
  // Iron Bloom follows BK Idle and has every chapter it lists. Reintroduce by not writing the link (parkPackage without
  // its INSERT): the series is not remembered, and nothing could ever put it back for it.
  await series(IRON, 'Iron Bloom', { main: null, have: 6, listed: 6, listedOn: SW('idle') });
  await follow(IRON, 'idle', 'Iron Bloom');
  await backup('idle', 4);
  await backup('busy', 0);
  await backup('pin', 0);
  const out = await bx.backupUpkeep();
  assert.deepEqual(out?.parked, [PKG.idle], 'removed after three days unneeded');
  assert.equal(installed('idle'), false, 'uninstalled from the engine');
  assert.equal((await row('idle'))?.state, 'parked');
  assert.deepEqual(await follows(IRON), [], 'its follow is taken off the series');
  assert.equal((await q('SELECT count(*)::int AS n FROM series_listing WHERE series_id = $1 AND source_id = $2', [IRON, SW('idle')]))[0].n, 0, 'with its listing rows');
  const link = (await q('SELECT pkg_name, source_series_id, their_title FROM backup_links WHERE series_id = $1 AND source_id = $2', [IRON, SW('idle')]))[0];
  assert.deepEqual(link, { pkg_name: PKG.idle, source_series_id: mangaId('idle'), their_title: 'Iron Bloom' }, 'remembered: the series, its id there and its title');
  assert.equal((await q('SELECT installed FROM extension_catalog WHERE pkg_name = $1', [PKG.idle]))[0].installed, false, 'and the extension check knows Uchiyomi removed it');
  assert.equal(installed('busy'), true, 'a backup needed lately stays');
  assert.equal((await q(`SELECT detail->>'via' AS via, detail->>'why' AS why FROM audit_log WHERE event = 'extension.uninstall' AND detail->>'pkgName' = $1 ORDER BY id DESC LIMIT 1`, [PKG.idle]))[0]?.why, 'idle');
});

test('a backup stays while it brings chapters: one only it lists, or one landed lately; past its retry cap, a chapter keeps nothing', { skip }, async () => {
  // Iron Bloom Two follows BK Busy, which alone lists chapter 7. Reintroduce by reading only download_log in
  // neededBackups: BK Busy is removed with chapter 7 still waiting for it. By ignoring the retry cap: it is kept for a
  // chapter that will never be asked again.
  await series(IRON2, 'Iron Bloom Two', { main: null, have: 6, listed: 6, listedOn: SW('mine') });
  const copy = { sourceId: 'busy-c7', source: SW('busy'), groups: [], scanlator: null, lang: null, pages: null, publishedAt: null };
  await q(`INSERT INTO series_listing (series_id, number, source_id, chosen, status, copies) VALUES ($1, 7, $2, $3::jsonb, 'available', $4::jsonb)`,
    [IRON2, SW('busy'), JSON.stringify({ sourceId: 'busy-c7', source: SW('busy'), number: 7 }), JSON.stringify([copy])]);
  await follow(IRON2, 'busy', 'Iron Bloom');
  await backup('busy', 5);
  let out = await bx.backupUpkeep();
  assert.ok(!out?.parked.includes(PKG.busy), 'chapter 7, which only it lists, keeps it');
  assert.ok(Date.now() - new Date((await row('busy')).last_needed_at).getTime() < 60_000, 'and it counts as needed now');

  // Chapter 7 at its retry cap: nothing will ask for it. A chapter landed from it two days ago still keeps it.
  await q(`INSERT INTO chapter_failures (series_id, number, source_id, status, attempts) VALUES ($1, 7, $2, 'error', 3)`, [IRON2, SW('busy')]);
  await q(`INSERT INTO download_log (folder, title, number, source, origin, status, started_at, finished_at)
           VALUES ('bkx-iron2', 'Iron Bloom Two', 5, $1, 'sweep', 'done', now() - interval '2 days', now() - interval '2 days')`, [SW('busy')]);
  await backup('busy', 5);
  out = await bx.backupUpkeep();
  assert.ok(!out?.parked.includes(PKG.busy), 'a chapter landed from it in the last three days keeps it');

  await q(`UPDATE download_log SET finished_at = now() - interval '5 days' WHERE folder = 'bkx-iron2'`);
  await backup('busy', 5);
  out = await bx.backupUpkeep();
  assert.deepEqual(out?.parked, [PKG.busy], 'nothing to bring, nothing landed lately: removed');
  assert.equal(installed('busy'), false);
});

test('a series\' main source is never removed, however long unused', { skip }, async () => {
  // Reintroduce by dropping the pin -- in neededBackups and parkPackage's own check together: BK Pin goes, and Pin
  // Story is left with no source at all.
  await series(PINS, 'Pin Story', { main: SW('pin'), mainRef: mangaId('pin'), have: 6, listed: 6, listedOn: SW('pin') });
  await backup('pin', 10);
  const out = await bx.backupUpkeep();
  assert.ok(!out?.parked.includes(PKG.pin));
  assert.equal(installed('pin'), true);
  assert.equal((await row('pin'))?.state, 'active');
});

test('a series stuck a few minutes, or with the switch off, gets nothing put back', { skip }, async () => {
  // Silver Tide's main source is cooling with chapters 10-12 to come; BK Spare carried it before and was removed. A
  // wait of a few minutes reinstalls nothing (a cooldown that short ends by itself). Reintroduce by dropping the hour
  // (stuckLongEnough): BK Spare is installed for it.
  await series(SILVER, 'Silver Tide', { main: SW('main'), mainRef: mangaId('main'), have: 9, listed: 12, listedOn: SW('main') });
  await cool(SW('main'));
  await backup('spare', 2, 'parked');
  await q(`INSERT INTO backup_links (series_id, source_id, pkg_name, source_series_id, their_title) VALUES ($1, $2, $3, '987654321', 'Silver Tide')
           ON CONFLICT (series_id, source_id) DO UPDATE SET source_series_id = EXCLUDED.source_series_id`, [SILVER, SW('spare'), PKG.spare]);
  await q(`INSERT INTO series_scout (series_id, reason, stuck_since) VALUES ($1, 'stuck', now() - interval '10 minutes')
           ON CONFLICT (series_id) DO UPDATE SET stuck_since = EXCLUDED.stuck_since`, [SILVER]);
  scout._resetScout();
  await scout.runScout(SILVER);
  assert.equal(installed('spare'), false, 'stuck for ten minutes: nothing reinstalled');
  // The switch: "Finish downloads on their own" off, and nothing is put back however long it waits.
  await q(`UPDATE series_scout SET stuck_since = now() - interval '2 hours' WHERE series_id = $1`, [SILVER]);
  await q('UPDATE server_settings SET finish_downloads = false, auto_follow_on_failure = false WHERE id = 1');
  try {
    scout._resetScout();
    await scout.runScout(SILVER);
    assert.equal(installed('spare'), false, 'switched off: nothing reinstalled');
  } finally {
    await q('UPDATE server_settings SET finish_downloads = true, auto_follow_on_failure = true WHERE id = 1');
  }
  assert.equal((await q('SELECT count(*)::int AS n FROM backup_links WHERE series_id = $1', [SILVER]))[0].n, 1, 'and the link is still there');
});

test('a series stuck an hour gets its backup back, found again by its title when its old id is gone', { skip }, async () => {
  // The link's id (987654321) is not the series' any more: the engine is asked for it, fails, and the series is searched
  // for again on the reinstalled source. Reintroduce by trusting the stored id (drop the `stale` retry in runScout):
  // nothing is followed, and BK Spare is removed again.
  scout._resetScout();
  const out = await scout.runScout(SILVER);
  assert.equal(out.verdict, 'followed');
  assert.equal(out.followed?.backup, PKG.spare, 'a backup extension put back');
  assert.equal(installed('spare'), true, 'reinstalled');
  assert.deepEqual(await follows(SILVER), [{ source_id: SW('spare'), source_series_id: mangaId('spare') }], 'followed under its real id');
  assert.equal((await row('spare'))?.state, 'active');
  assert.equal((await q('SELECT count(*)::int AS n FROM backup_links WHERE series_id = $1', [SILVER]))[0].n, 0, 'the link is used up');
  const audit = (await q(`SELECT detail->>'via' AS via FROM audit_log WHERE event = 'extension.install' AND detail->>'pkgName' = $1 ORDER BY id DESC LIMIT 1`, [PKG.spare]))[0];
  assert.equal(audit?.via, 'autofix', 'it stays the backup it was');
  assert.equal(sources.getSource(SW('spare'))?.backup, true, 'and out of Discover');
});

test('a backup a series uses keeps its place under the source limit, before a source nothing uses', { skip }, async () => {
  // Registration's order is unchanged (suwayomi/register.ts): the sources series use first, a backup's included.
  // Reintroduce by registering backups after every other source: BK Spare, which Silver Tide follows, is left out.
  const original = env.SUWAYOMI_MAX_SOURCES;
  env.SUWAYOMI_MAX_SOURCES = 3;
  try {
    await sources.reloadAll();
    assert.ok(sources.getSource(SW('main')), 'Silver Tide\'s main');
    assert.ok(sources.getSource(SW('spare')), 'the backup Silver Tide follows');
    assert.ok(sources.getSource(SW('pin')), 'the backup Pin Story reads from');
    assert.ok(!sources.getSource(SW('mine')), 'the source nothing uses is the one left out');
  } finally {
    env.SUWAYOMI_MAX_SOURCES = original;
    await sources.reloadAll();
  }
});

test('the cap: the backup needed longest ago makes room, one needed now never does', { skip }, async () => {
  // At most BACKUP_EXTENSIONS_MAX backups (a series' main not counted). Reintroduce plain least-recently-used (any
  // backup, needed or not): the one Silver Tide downloads from is removed.
  bx._setBackupLimits({ max: 2 });
  try {
    const got = await bx.installTrial(PKG.idle, { name: 'BK Idle', lang: 'en', via: 'scout', who: 'test' });
    assert.ok(got && got !== lock.BUSY && got.sourceId, 'PREMISE: BK Idle installed again');
    await backup('idle', 1);
    // BK Spare brought a chapter just now; BK Idle nothing. Pin Story's main is not counted.
    await q(`INSERT INTO download_log (folder, title, number, source, origin, status, started_at, finished_at)
             VALUES ('bkx-silver', 'Silver Tide', 10, $1, 'sweep', 'done', now(), now())`, [SW('spare')]);
    await backup('spare', 2);
    assert.equal(await bx.makeRoom(), true, 'room made');
    assert.equal(installed('idle'), false, 'by removing the one nothing needs');
    assert.equal(installed('spare'), true, 'never the one in use');
    assert.equal((await row('idle'))?.why, 'room');

    // Every backup needed: no room, and nothing removed.
    const again = await bx.installTrial(PKG.idle, { name: 'BK Idle', lang: 'en', via: 'scout', who: 'test' });
    assert.ok(again && again !== lock.BUSY);
    await backup('idle', 1);
    await q(`INSERT INTO download_log (folder, title, number, source, origin, status, started_at, finished_at)
             VALUES ('bkx-iron', 'Iron Bloom', 6, $1, 'sweep', 'done', now(), now())`, [SW('idle')]);
    assert.equal(await bx.makeRoom(), false, 'every one needed: no room');
    assert.equal(installed('idle'), true);
    assert.equal(installed('spare'), true);
  } finally {
    bx._setBackupLimits({ max: 5 });
  }
});

test('a wiped engine puts back the backup in use, never one Uchiyomi removed; neither is "removed outside"', { skip }, async () => {
  // BK Busy was removed by Uchiyomi (above): its snapshot says so. The engine's volume is wiped -- no repository, nothing
  // installed that was -- and the scheduled check puts back what was installed. Reintroduce by dropping markInstalled
  // from the removal: BK Busy is installed again behind everyone's back.
  const { runExtensionCheck } = await import('../src/lib/extensionMonitor');
  await snapshot('spare', true);
  fake!.extension(PKG.spare).installed = false;
  const r = await runExtensionCheck();
  assert.ok(r.reinstalled.includes('BK Spare'), 'the backup in use is put back');
  assert.equal(installed('spare'), true);
  assert.equal(installed('busy'), false, 'the one Uchiyomi removed stays removed');
  assert.ok(!r.reinstalled.includes('BK Busy'));
  assert.deepEqual(r.removedOutside, [], 'and neither is reported as removed outside Uchiyomi');
});

test('one install at a time: a backup waits for another install, or leaves it for later', { skip }, async () => {
  // Reintroduce by installing without the lock (installTrial calling its work directly): BK Busy is installed while
  // another install holds the engine.
  let release!: () => void;
  const held = lock.withInstallLock('test', () => new Promise<void>((r) => { release = r; }));
  try {
    assert.equal(await bx.installTrial(PKG.busy, { name: 'BK Busy', lang: 'en', via: 'scout', who: 'test' }), lock.BUSY, 'one that will not wait is told it is busy');
    const waiting = bx.installTrial(PKG.busy, { name: 'BK Busy', lang: 'en', via: 'scout', who: 'test', waitMs: 5_000 });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(installed('busy'), false, 'nothing installs while another holds the engine');
    release();
    await held;
    const got = await waiting;
    assert.ok(got && got !== lock.BUSY, 'then it goes');
    assert.equal(installed('busy'), true);
  } finally {
    release?.();
    await bx.removePackage(PKG.busy, { via: 'scout', why: 'test', who: 'test', waitMs: 5_000 });
  }
});

test('Keep makes a backup the admin\'s; one a person removed is never installed by Uchiyomi again', { skip }, async () => {
  // Reintroduce by dropping installTrial's refused check: BK Idle, which the admin removed, is installed again.
  assert.equal(await bx.adoptBackup(PKG.spare, { userId: null }), true);
  assert.equal(await row('spare'), null, 'no longer a backup');
  assert.ok(!sources.getSource(SW('spare'))?.backup, 'so it shows in Discover');
  assert.equal(installed('spare'), true, 'and stays installed');
  await bx.removePackage(PKG.idle, { via: 'scout', why: 'test', who: 'test', waitMs: 5_000 });
  await bx.refuseBackup(PKG.idle, { why: 'by_admin' });
  assert.equal(await bx.installTrial(PKG.idle, { name: 'BK Idle', lang: 'en', via: 'scout', who: 'test' }), null, 'refused');
  assert.equal(installed('idle'), false, 'never installed again');
  assert.equal((await q('SELECT count(*)::int AS n FROM backup_links WHERE pkg_name = $1', [PKG.idle]))[0].n, 0, 'and nothing would put it back for a series');
});

test('how long a series has waited is kept across its requests, and over once a source is followed', { skip }, async () => {
  // series_scout.stuck_since (lib/scoutRequests.ts, lib/sourceScout.ts settleScout): what stuckLongEnough reads.
  // Reintroduce by stamping it on every request (`stuck_since = now()` on conflict): a series the sweep reports stuck
  // every few minutes never waits an hour, and never gets its backup back.
  const { requestScout } = await import('../src/lib/scoutRequests');
  await q('DELETE FROM series_scout WHERE series_id = $1', [IRON]);
  await requestScout(IRON, 'stuck');
  assert.ok((await q('SELECT stuck_since FROM series_scout WHERE series_id = $1', [IRON]))[0]?.stuck_since, 'the first request starts the wait');
  await q(`UPDATE series_scout SET stuck_since = now() - interval '2 hours' WHERE series_id = $1`, [IRON]);
  await requestScout(IRON, 'refused');
  assert.equal(await bx.stuckLongEnough(IRON), true, 'a later request keeps when it started');
  await scout.settleScout(IRON, 'stuck', { verdict: 'left', title: 'Iron Bloom', searches: 1, asked: [], nextAt: new Date(Date.now() + 3600_000) }, new Date());
  assert.equal(await bx.stuckLongEnough(IRON), true, 'and so does a look that found nothing');
  await scout.settleScout(IRON, 'stuck', { verdict: 'followed', title: 'Iron Bloom', searches: 1, asked: [], nextAt: new Date(Date.now() + 3600_000) }, new Date());
  assert.equal(await bx.stuckLongEnough(IRON), false, 'a source followed ends the wait');
});
