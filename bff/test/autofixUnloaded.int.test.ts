// Fix everything and an extension source that is not loaded (v0.55.1 integration, lib/autofix.ts configCause and
// preflight), against the strict fake engine. Since v0.55.1 Health tells two cases apart that v0.55.0 read as one --
// switched on and not registered: a source the last registration left out because SUWAYOMI_MAX_SOURCES was full
// (register.ts leftOutByLimit, "Free a slot") and an extension the engine no longer offers ("no longer installed", with
// Replace). Fix everything reads them the same way: the first is a setting and keeps its series, the second is
// Replaced -- onto a source that can update its series, never one failing at its pages (lane C's rule) -- and what
// Replace cannot place goes to the extensions phase, once. A source that only asked for room is no target at all. And
// an engine that answers with no registration since it came back is registered first: without one, every extension
// source would read as no longer installed.
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
  alpha: 'eu.kanade.tachiyomi.extension.en.alphareader',
  delta: 'eu.kanade.tachiyomi.extension.en.deltareader',
  foxtrot: 'eu.kanade.tachiyomi.extension.en.foxtrotreader',
  echo: 'eu.kanade.tachiyomi.extension.en.echoreader',
  charlie: 'eu.kanade.tachiyomi.extension.en.charliereader',
  lima: 'eu.kanade.tachiyomi.extension.en.limareader',
  mike: 'eu.kanade.tachiyomi.extension.en.mikereader',
};
const ID = {
  alpha: '7100000000000000100', delta: '7100000000000000200', foxtrot: '7100000000000000300', echo: '7100000000000000400',
  charlie: '7100000000000000500', lima: '7100000000000000600', mike: '7100000000000000700',
};
/** An extension source still switched on here, which the engine no longer offers: uninstalled in the engine's own page. */
const GONE = '7100000000000000999';
const sw = (id: string) => `sw:${id}`;
/** `n` chapters, newest first. Lone Story has twelve: a listing long enough for Find to trust an exact title one way. */
const chapters = (title: string, n: number) => Array.from({ length: n }, (_, i) => n - i)
  .map((k) => ({ name: `${title} ${k}`, url: `/${title}/${k}`, chapterNumber: k, uploadDate: Date.UTC(2024, 0, k), pages: 3 }));
const LONE = 12;
const manga = (title: string) => ({ title, url: `/${title.toLowerCase().replace(/ /g, '-')}`, chapters: chapters(title, title === 'Lone Story' ? LONE : 5) });

/**
 * In the engine's order, every one installed but Lima and Mike, and every one a series reads through, so the source limit
 * of four leaves Charlie Reader out. Alpha Reader works. Delta Reader works and carries Beta Story. Foxtrot Reader carries
 * Lone Story and fails at its page lists. Echo Reader works but its images answer 429. Lima Reader (not installed) carries
 * Lone Story and is the first a run would install; Mike Reader (not installed) carries Alpha Story.
 */
function seed(): FakeSeed {
  const src = (id: string, name: string, pkgName: string, mangas: Array<ReturnType<typeof manga>>, fail: Record<string, true> = {}) =>
    ({ id, name, lang: 'en', pkgName, supportsLatest: true, isNsfw: false, baseUrl: `https://${pkgName}.example`, mangas, fail });
  const ext = (pkgName: string, name: string, installed: boolean, versionCode = 1) =>
    ({ pkgName, name, lang: 'en', versionName: '1.0.0', installed, obsolete: false, isNsfw: false, versionCode, repo: BASE });
  return {
    sources: [
      src(ID.alpha, 'Alpha Reader', PKG.alpha, [manga('Alpha Story')]),
      src(ID.delta, 'Delta Reader', PKG.delta, [manga('Delta Story'), manga('Beta Story')]),
      src(ID.foxtrot, 'Foxtrot Reader', PKG.foxtrot, [manga('Lone Story')], { pages: true }),
      src(ID.echo, 'Echo Reader', PKG.echo, [manga('Echo Story')]),
      src(ID.charlie, 'Charlie Reader', PKG.charlie, [manga('Charlie Story')]),
      src(ID.lima, 'Lima Reader', PKG.lima, [manga('Lone Story')]),
      src(ID.mike, 'Mike Reader', PKG.mike, [manga('Alpha Story')]),
    ],
    extensions: [
      ext(PKG.alpha, 'Alpha Reader', true),
      ext(PKG.delta, 'Delta Reader', true),
      ext(PKG.foxtrot, 'Foxtrot Reader', true),
      ext(PKG.echo, 'Echo Reader', true),
      ext(PKG.charlie, 'Charlie Reader', true),
      // The most updated first, with no downloads to rank by: Lima before Mike.
      ext(PKG.lima, 'Lima Reader', false, 5),
      ext(PKG.mike, 'Mike Reader', false, 1),
    ],
    settings: {},
  };
}

const LIB = 'lib_afu';
const ALL: string[] = [];
const S = (k: string) => `s_afu_${k}`;

let fake: FakeSuwayomi | null = null;
let q: any, autofix: typeof import('../src/lib/autofix'), env: any, reg: typeof import('../src/lib/sources/suwayomi/register');
let sources: typeof import('../src/lib/sources');
let adminId = '';
const realFetch = globalThis.fetch;

/** A series of `n` chapters on disk (`missing` left out), reading through `main` (the engine's own id for it, when it has one). */
async function series(k: string, title: string, main: string | null, o: { n?: number; missing?: number } = {}) {
  const id = S(k);
  ALL.push(id);
  const ref = main && main !== sw(GONE) ? String(fake!.manga(title).id) : main ? '1' : null;
  const nums = Array.from({ length: o.n ?? 5 }, (_, i) => i + 1).filter((n) => n !== o.missing);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update, lang)
           VALUES ($1,'T!afu',$2,$3,$4,$5,$6,$7,true,'en')`, [id, title, `T!afu/${title}`, nums.length, LIB, main, ref]);
  for (const n of nums) {
    const file = `T!afu/${title}/Chapter ${n}.cbz`;
    const z = new AdmZip();
    for (let i = 0; i < 3; i++) z.addFile(`${i}.png`, Buffer.alloc(80, 1));
    z.addFile('ComicInfo.xml', Buffer.from(`<?xml version="1.0"?><ComicInfo><Series>${title}</Series></ComicInfo>`));
    mkdirSync(join(DL, `T!afu/${title}`), { recursive: true });
    writeFileSync(join(DL, file), z.toBuffer());
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, pages_checked_at, root, source_id)
             VALUES ($1,$2,'T!afu',$3,$4,$5,3,now(),$6,$7)`, [`b_${id}_${n}`, id, file, n, `Chapter ${n}`, DL, main]);
  }
}
/** Only these series are the run's: every other this file added is paused (a paused series is never a target). */
async function only(...keys: string[]) {
  await q('UPDATE lib_series SET auto_update = (id = ANY($2)) WHERE id = ANY($1)', [ALL, keys.map(S)]);
}
const mainOf = async (k: string) => (await q('SELECT source_id FROM lib_series WHERE id = $1', [S(k)]))[0]?.source_id ?? null;
/** Every main-source switch the run made, its own Replace and Find runs' included, as `title -> source`. */
const switches = async (runId: string) =>
  (await q(`SELECT detail->>'title' AS title, detail->>'to' AS "to" FROM audit_log
             WHERE event = 'series.main_source'
               AND (detail->>'runId' = $1 OR detail->>'runId' IN (SELECT id::text FROM source_find_runs WHERE scope->>'autofix' = $1))
             ORDER BY id`, [runId])).map((r: any) => `${r.title} -> ${r.to}`);
const installs = async (runId: string) =>
  (await q(`SELECT detail->>'pkgName' AS pkg FROM audit_log WHERE event = 'extension.install' AND detail->>'runId' = $1 ORDER BY id`, [runId]))
    .map((r: any) => r.pkg);
/** The sources the run's own Replace runs were started on. */
const replaced = async (runId: string) =>
  (await q(`SELECT scope->>'sourceId' AS src FROM source_find_runs WHERE scope->>'autofix' = $1 AND scope->>'mode' = 'replace' AND scope->>'only' IS NULL
             ORDER BY started_at`, [runId])).map((r: any) => r.src);
/** The Find runs the run started that asked only this source: one per package and kind of target it was tried for. */
const asking = async (runId: string, id: string) =>
  (await q(`SELECT scope->'seriesIds' AS ids FROM source_find_runs WHERE scope->>'autofix' = $1 AND scope->'only' = $2::jsonb ORDER BY started_at`,
    [runId, JSON.stringify([id])])).map((r: any) => r.ids);
async function runOnce() {
  const started = autofix.startAutofix(adminId);
  assert.ok('runId' in started);
  await autofix.autofixSettled();
  const run = await autofix.autofixRun((started as { runId: string }).runId);
  assert.equal(run?.status, 'done');
  return run!;
}
/** Register what the engine offers, under a source limit of `limit`. */
async function reload(limit: number) {
  env.SUWAYOMI_MAX_SOURCES = limit;
  await sources.reloadAll();
}

before(async () => {
  if (!DSN) return;
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-afu-'));
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
  // The fake engine, and nothing else: GitHub has no releases to rank by, and MangaDex finds nothing.
  globalThis.fetch = (async (u: any, init?: any) => {
    const url = String(u);
    if (url.includes('127.0.0.1')) return realFetch(u, init);
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q } = (await import('../src/lib/db')) as any);
  ({ env } = (await import('../src/env')) as any);
  autofix = await import('../src/lib/autofix');
  sources = await import('../src/lib/sources');
  reg = await import('../src/lib/sources/suwayomi/register');
  const find = await import('../src/lib/findSources');
  find.setFindTiming({ paceMs: 0, quietMs: 20, busyMs: 50, wallMs: 10_000 });
  autofix.setAutofixTiming({ quietMs: 20 });
  (await import('../src/lib/githubRelease')).resetReleaseCache();
  await q('DELETE FROM suwayomi_sources');
  await q(`DELETE FROM source_health WHERE source_id LIKE 'sw:%'`);
  await reg.loadSuwayomiSources();
  await q('UPDATE suwayomi_sources SET enabled = true');
  // Switched on here, and gone from the engine: what an uninstall in the engine's own page leaves behind.
  await q(`INSERT INTO suwayomi_sources (source_id, name, lang, nsfw, enabled, pkg_name, ext_name)
           VALUES ($1, 'Beta Shelf', 'en', false, true, 'eu.kanade.tachiyomi.extension.en.betashelf', 'Beta Shelf')`, [GONE]);
  await q(`DELETE FROM users WHERE username = 'afu-admin'`);
  adminId = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind)
                      VALUES ('afu-admin','afu-admin','x','admin','password') RETURNING id`))[0].id;
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Unloaded',$2) ON CONFLICT (id) DO NOTHING`, [LIB, DL]);
  await series('alpha', 'Alpha Story', sw(ID.alpha));
  await series('delta', 'Delta Story', sw(ID.delta));
  await series('echo', 'Echo Story', sw(ID.echo));
  await series('charlie', 'Charlie Story', sw(ID.charlie));
  await series('beta', 'Beta Story', sw(GONE));
  // Lone Story is carried only by Foxtrot Reader (failing at its page lists) and Lima Reader (not installed); its chapter
  // 3 is missing, and the last search for it found nobody had it -- a gap target as well as a frozen one.
  await series('lone', 'Lone Story', sw(GONE), { n: LONE, missing: 3 });
  await q(`UPDATE lib_series SET gaps_checked_at = now(), gaps_result = $2::jsonb WHERE id = $1`, [S('lone'), JSON.stringify({
    at: new Date().toISOString(), why: 'no_candidate', have_count: LONE - 1, unfillable: ['3'], scanned: 1,
    sweep: 0, capped: 0, landed: 0, fetched: 0, coverage: null, followed: null,
  })]);
  // Foxtrot Reader is read through as a follower, so it registers under the limit before Charlie Reader.
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id, title) VALUES ($1, $2, $3, 'Lone Story')`,
    [S('alpha'), sw(ID.foxtrot), String(fake.manga('Lone Story').id)]);
  const at = new Date().toISOString();
  await q(`INSERT INTO source_health (source_id, stages) VALUES ($1, $2::jsonb)`,
    [sw(ID.foxtrot), JSON.stringify({ pages: { failAt: at, failBy: 'test', streak: 4, kind: 'error', error: 'suwayomi: HTTP error 500' } })]);
  // The owner's Mangakakalot: its searches and chapter lists answer, its images asked for room five times in a row.
  await q(`INSERT INTO source_health (source_id, status, consecutive, last_error, stages) VALUES ($1, 'rate_limited', 5, '0/32 pages downloaded (HTTP 429)', $2::jsonb)`,
    [sw(ID.echo), JSON.stringify({ images: { failAt: at, failBy: 'traffic', streak: 5, kind: 'rate_limited', error: '0/32 pages downloaded (HTTP 429)' } })]);
  await reload(4);
});

after(async () => {
  globalThis.fetch = realFetch;
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  await fake?.close();
  if (!DSN) return;
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM suwayomi_sources').catch(() => {});
  await q(`DELETE FROM users WHERE username = 'afu-admin'`).catch(() => {});
});

test('a source the engine no longer offers is Replaced, as Health says; one the limit left out keeps its series', { skip }, async (t) => {
  assert.ok(reg.leftOutByLimit(sw(ID.charlie)), 'PREMISE: the limit of four left Charlie Reader out');
  assert.ok(!reg.leftOutByLimit(sw(GONE)) && !sources.getSource(sw(GONE)), 'PREMISE: Beta Shelf is switched on, not loaded, and not left out');
  const run = await runOnce();

  await t.test('a source the engine no longer offers is Replaced onto a source that can update its series', async () => {
    // Health reads Beta Shelf as no longer installed, with Replace (lane A). Reintroduce v0.55.0's reading of "switched
    // on" as the limit (configCause in lib/autofix.ts): Beta Story is never moved, run after run.
    assert.deepEqual(await replaced(run.id), [sw(GONE)], 'the run Replaces Beta Shelf, and no other source');
    assert.equal(await mainOf('beta'), sw(ID.delta), 'a source the engine no longer offers is Replaced');
    assert.ok((await switches(run.id)).includes(`Beta Story -> ${sw(ID.delta)}`), 'PREMISE: the switches the run made are read');
  });

  await t.test('never onto a source failing at its page lists: what nothing that works carries stays, and is said', async () => {
    // Lane C's rule, for this source too: Lone Story's only match is on Foxtrot Reader, failing at its pages.
    // Reintroduce by asking and promoting any source (lib/findSources.ts findFor's canTake and replaceFor's carries):
    // Lone Story is moved onto Foxtrot Reader.
    assert.ok(!(await switches(run.id)).includes(`Lone Story -> ${sw(ID.foxtrot)}`), 'never onto a source failing at its page lists');
    assert.ok(run.log!.some((l) => l.code === 'autofix.item.stillOn' && l.params?.name === 'Beta Shelf' && l.params?.n === 1),
      'and the series it could not place is said to be still on it');
  });

  await t.test('a source the limit left out keeps its series, and asks for a slot', async () => {
    // It works; only the limit keeps it out. Reintroduce by Replacing it (configCause without the limit): Charlie Story
    // is moved, or a Replace is started on Charlie Reader.
    assert.equal(await mainOf('charlie'), sw(ID.charlie), 'a source the limit left out keeps its series');
    assert.ok(run.summary!.needsYou.some((n) => n.said.code === 'autofix.needs.freeSlot'), 'and Free a slot is Needs you');
  });

  await t.test('a source that only asked for room is no target at all', async () => {
    assert.equal(await mainOf('echo'), sw(ID.echo), 'a rate-limited source keeps its series');
    assert.ok(!(await replaced(run.id)).includes(sw(ID.echo)), 'and is never Replaced');
  });

  await t.test('what Replace could not place goes to the extensions phase, which finds no room under the limit', async () => {
    assert.deepEqual(await installs(run.id), [], 'nothing is installed past the limit');
    assert.ok(run.summary!.needsYou.some((n) => n.said.code === 'autofix.needs.noRoom' && n.said.params?.name === 'Lima Reader'),
      'and the package it would have tried for Lone Story asks for room');
  });
});

test('with room, the extensions phase tries a package for a series on a source no longer installed, once', { skip }, async () => {
  // Lone Story is a frozen target (its main is no longer installed) and a gap target (a chapter nobody had): one target,
  // asked about in one run on the package that carries it. Reintroduce by listing it twice (drop the `out.some` in
  // extensionTargets): a second run asks Lima Reader about it as a gap's series.
  await reload(10);
  await only('lone');
  const run = await runOnce();
  assert.deepEqual(await installs(run.id), [PKG.lima], 'PREMISE: the package that carries it, first in the order');
  assert.equal(await mainOf('lone'), sw(ID.lima), 'Lone Story moves to the package that carries it');
  assert.deepEqual(await asking(run.id, sw(ID.lima)), [[S('lone')]], 'and the package is asked about it once');
});

test('an engine that answers with no registration since it came back: its sources are registered first, and nothing moves', { skip }, async () => {
  // Uchiyomi booted while the engine was still starting, and the retry has not run yet: no extension source is
  // registered, and the last load found nobody. Every engine source then reads as not loaded and not left out by the
  // limit -- no longer installed. Reintroduce by not registering in preflight (lib/autofix.ts): Alpha Story is Replaced,
  // then moved onto Mike Reader by the extensions phase.
  await only('alpha');
  for (const s of sources.listSources()) if (s.id.startsWith('sw:')) sources.unregisterAdapter(s.id);
  await reg.loadSuwayomiSources(() => Promise.reject(new Error('connect ECONNREFUSED')), { quiet: true });
  assert.ok(!reg.lastSuwayomiLoad()?.reachable && !sources.getSource(sw(ID.alpha)), 'PREMISE: nothing registered, and the last load failed');
  const run = await runOnce();
  assert.equal(await mainOf('alpha'), sw(ID.alpha), 'its series stay on their working sources');
  assert.deepEqual((await replaced(run.id)).filter((x: string) => x !== sw(GONE)), [], 'no working source is Replaced');
  assert.deepEqual(await installs(run.id), [], 'and nothing is installed');
  assert.ok(reg.lastSuwayomiLoad()?.reachable && sources.getSource(sw(ID.alpha)), 'the run registered the engine\'s sources');
});
