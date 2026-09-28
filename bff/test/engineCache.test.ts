// The extension engine's page cache is kept empty (lib/sources/suwayomi/cache.ts).
//
// Found live on 2026-09-27: the engine keeps every page it serves in /tmp/Tachidesk/manga-cache, inside its
// container's writable layer, with no limit -- 17 GB of pages Uchiyomi had already written into CBZs, and a host
// whose system disk was full. The keeper asks the engine to empty that cache with its own clearCachedImages:
//   * after an extension download job ends,
//   * at most every 30 minutes while no extension download is in flight,
//   * never while one is (the engine writes each page as a .tmp and renames it; a clear mid-chapter fails it),
//     nor in the minute after one ended, when the next chapter of the job is about to start,
//   * never when there is no engine, nor before the engine has answered once,
// and asks for the pages only, never the thumbnails.
//
// The clock is node:test's mocked Date, so a three-hour stretch runs in milliseconds and the download records
// (lib/downloadActivity.ts, which stamps with Date.now) share the keeper's clock. The engine is the strict fake
// (test/fixtures/fakeSuwayomi.ts): the mutation Uchiyomi sends is held to the pinned engine's schema.
import test, { before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeSuwayomi, suwayomiQueryErrors, type FakeSuwayomi } from './fixtures/fakeSuwayomi';

process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.DATABASE_URL ||= 'postgres://unused/unused';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
delete process.env.EXTENSION_ENGINE;

let fake: FakeSuwayomi;
before(async () => {
  fake = await startFakeSuwayomi();
  // ⚠️ Set BEFORE any src module loads: env.ts parses it once.
  process.env.SUWAYOMI_URL = fake.url;
});
after(async () => { await fake.close(); });

const cache = () => import('../src/lib/sources/suwayomi/cache');
const activity = () => import('../src/lib/downloadActivity');

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 27, 12, 0, 0);

afterEach(async () => {
  mock.timers.reset();
  (await activity()).clearActivity();
  (await cache()).stopEngineCacheKeeper();
});

/** A keeper whose clears are counted instead of sent, on the mocked clock, with the real in-flight checks. */
async function counted(overrides: Record<string, unknown> = {}) {
  const { engineCacheKeeper } = await cache();
  const at: number[] = [];
  const logged: string[] = [];
  const keeper = engineCacheKeeper({
    configured: () => true,
    answered: () => true,
    clear: async () => { at.push(Date.now()); return true; },
    log: { info: (m: string) => logged.push(`info ${m}`), warn: (m: string) => logged.push(`warn ${m}`) },
    ...overrides,
  });
  return { keeper, at, logged };
}

const advance = (ms: number) => mock.timers.tick(ms);

/** One tick a minute for `minutes` minutes, the way the production interval runs it. */
async function run(keeper: { tick(): Promise<string> }, minutes: number): Promise<void> {
  for (let i = 0; i < minutes; i++) {
    advance(MIN);
    await keeper.tick();
  }
}

/**
 * The mutation itself, against the strict fake: accepted by the pinned schema, empties the page cache, leaves the
 * thumbnail cache alone.
 *
 * Reintroduce by asking for `cachedThumbnails: true` as well: every extension cover is fetched through the engine
 * again and the thumbnail assertion fails. Or misspell the input field (`cachedPage`): the engine refuses the
 * mutation with WrongType, and the schema assertion names it.
 */
test('the keeper asks the engine to empty its page cache, and nothing else', async () => {
  const { CLEAR_PAGES_M, engineCacheKeeper } = await cache();
  assert.deepEqual(suwayomiQueryErrors(CLEAR_PAGES_M), [], 'the pinned engine would refuse the clear');

  fake.reset();
  const { gql, engineAnswered } = await import('../src/lib/sources/suwayomi/client');
  // Nothing has talked to the engine in this process yet: the production keeper leaves it alone.
  assert.equal(engineAnswered(), false);
  assert.equal(await engineCacheKeeper().tick(), 'unanswered', 'the production keeper ticked before the engine answered');
  assert.equal(fake.cacheClears.length, 0, 'the keeper called an engine that had not answered yet');
  // Fill the engine's caches the way a download does: fetch a chapter's pages, and a cover.
  const manga = fake.manga('Ball Runner');
  const { fetchChapters } = (await gql<any>('mutation($m:Int!){ fetchChapters(input:{mangaId:$m}){ chapters { id } } }', { m: manga.id }));
  const pages = await gql<any>('mutation($c:Int!){ fetchChapterPages(input:{chapterId:$c}){ pages } }', { c: fetchChapters.chapters[0].id });
  for (const p of pages.fetchChapterPages.pages) assert.equal((await fetch(fake.url + p)).status, 200);
  assert.equal((await fetch(`${fake.url}/api/v1/manga/${manga.id}/thumbnail`)).status, 200);
  assert.ok(fake.pageCache.size > 0 && fake.thumbnailCache.size === 1, 'the fake did not keep what it served');

  // The production keeper, every dependency its own: the real switch, the real in-flight checks, the real client
  // -- which has now had its answers.
  assert.equal(engineAnswered(), true, 'the client did not note that the engine answered');
  assert.equal(await engineCacheKeeper().tick(), 'cleared');
  assert.equal(fake.pageCache.size, 0, 'the pages the engine kept are still there');
  assert.equal(fake.thumbnailCache.size, 1, 'the keeper emptied the engine\'s thumbnail cache too');
  assert.deepEqual(fake.cacheClears, [{ cachedPages: true, cachedThumbnails: null, downloadedThumbnails: null }]);
});

/**
 * Reintroduce by deleting the `jobEnded` condition: the pages of a job that ended eight minutes after the last clear
 * wait for the thirty-minute mark, and the clear at 9 min is missing.
 */
test('after an extension download job ends, the cache is cleared', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 });
  const { beginDownload, startedDownload, endDownload } = await activity();
  const { keeper, at } = await counted();
  assert.equal(await keeper.tick(), 'cleared', 'the first idle tick after start clears what an older version left');

  advance(5 * MIN);
  const one = beginDownload({ folder: 'Night Shelf', title: 'Night Shelf', number: 1, source: 'sw:5550003' });
  startedDownload(one);
  advance(3 * MIN);
  endDownload(one, { status: 'done', pages: 3 });
  // The next chapter of the same job starts twenty seconds later: the moment between them is not the end.
  advance(20_000);
  const two = beginDownload({ folder: 'Night Shelf', title: 'Night Shelf', number: 2, source: 'sw:5550003' });
  assert.equal(await keeper.tick(), 'busy', 'the keeper did not see the next chapter in flight');
  advance(40_000);
  endDownload(two, { status: 'failed', reason: 'boom' }); // a failed chapter can leave pages behind too
  assert.equal(await keeper.tick(), 'waiting', 'cleared the moment the last chapter ended, before the job had settled');
  advance(30_000);
  assert.equal(await keeper.tick(), 'waiting');
  advance(31_000);
  assert.equal(await keeper.tick(), 'cleared', 'the job ended over a minute ago and its pages are still in the engine');
  assert.deepEqual(at.map((t) => (t - T0) / 1000), [0, 9 * 60 + 61]);
  // Nothing new since: the next clear is the idle one, thirty minutes after this.
  await run(keeper, 29);
  assert.equal(at.length, 2);
  await run(keeper, 1);
  assert.equal(at.length, 3);
});

/**
 * Reintroduce by deleting the `busy()` check: a clear lands mid-chapter at the thirty-minute mark and the first
 * assertion fails.
 */
test('never while an extension download is in flight, however long it takes', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 });
  const { beginDownload, startedDownload, endDownload } = await activity();
  const { keeper, at } = await counted();
  await keeper.tick();
  assert.equal(at.length, 1);

  const id = beginDownload({ folder: 'Night Shelf', title: 'Night Shelf', number: 1, source: 'sw:5550003' });
  await run(keeper, 180); // queued behind its source's gate for three hours, then fetching
  startedDownload(id);
  await run(keeper, 5);
  assert.equal(at.length, 1, 'the page cache was cleared while an extension chapter was downloading');

  // A download from a built-in source does not hold the engine's cache: it never went through the engine.
  endDownload(id, { status: 'done', pages: 3 });
  const md = beginDownload({ folder: 'Other', title: 'Other', number: 1, source: 'mangadex' });
  startedDownload(md);
  await run(keeper, 2);
  assert.equal(at.length, 2, 'a MangaDex download held the extension engine\'s cache');
  endDownload(md, { status: 'done', pages: 3 });
});

/**
 * The completion pass fetches missing pages under the source's gate without recording a download; the gate is
 * what says it is in flight. Reintroduce by dropping `gateBusy(SW_PREFIX)` from extensionDownloadInFlight.
 */
test('page fetches under an extension source\'s gate count as in flight', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 });
  const { withGate } = await import('../src/lib/gate');
  const { keeper, at } = await counted();
  let release!: () => void;
  const holding = withGate('sw:5550003', () => new Promise<void>((r) => { release = r; }));
  await new Promise((r) => setImmediate(r));
  await run(keeper, 45);
  assert.equal(at.length, 0, 'cleared while pages were being fetched under the gate');
  release();
  await holding;
  await run(keeper, 1);
  assert.equal(at.length, 1);
});

/**
 * Reintroduce by deleting the `due` gap (clear on every idle tick): three idle hours make 181 clears, not 7.
 */
test('at most every 30 minutes while idle', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 });
  const { keeper, at } = await counted();
  await keeper.tick();
  await run(keeper, 180);
  assert.equal(at.length, 7, `${at.length} clears in three idle hours`);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 30 * MIN, `two clears ${(at[i] - at[i - 1]) / MIN} min apart`);
});

/**
 * Reintroduce by moving the `configured()` check below the others (or deleting it): an install with no engine
 * calls one every half hour and logs the failure.
 */
test('never when there is no engine', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 });
  const { beginDownload, endDownload } = await activity();
  const { keeper, at, logged } = await counted({ configured: () => false });
  for (let i = 0; i < 6; i++) {
    const id = beginDownload({ folder: 'X', title: 'X', number: i, source: 'sw:1' });
    await run(keeper, 10);
    endDownload(id, { status: 'done', pages: 1 });
    await run(keeper, 20);
  }
  assert.equal(at.length, 0, 'the keeper called an engine that is not there');
  assert.deepEqual(logged, [], 'the keeper logged about an engine that is not there');
});

/**
 * Errors are only logged, and once: an engine gone away is tried again every five minutes, quietly, and one line
 * says when it works again. Reintroduce by logging on every failure: the log has three warnings. Or drop the
 * backoff (`retryAt = now + d.retryMs`): a failing engine is asked on every one-minute tick and the attempts
 * read 5 where they should read 1.
 */
test('a failed clear is logged once and retried every five minutes', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 });
  let fail = true;
  let attempts = 0;
  const { keeper, logged } = await counted({ clear: async () => { attempts++; if (fail) throw new Error('suwayomi unreachable: fetch failed'); return true; } });
  assert.equal(await keeper.tick(), 'failed');
  await run(keeper, 4);
  assert.equal(attempts, 1, 'asked again before five minutes were up');
  await run(keeper, 1); // five minutes: tried again
  assert.equal(attempts, 2, 'not tried again at five minutes');
  await run(keeper, 5); // and again
  assert.equal(attempts, 3);
  assert.deepEqual(logged.filter((l) => l.startsWith('warn')).length, 1, logged.join('\n'));
  assert.match(logged[0], /could not clear its page cache \(suwayomi unreachable: fetch failed\)/);
  fail = false;
  await run(keeper, 5);
  assert.equal(logged.length, 2);
  assert.match(logged[1], /^info .*cleared again/);
  // An engine that answers "could not delete everything" is a failure too, not a success.
  const partial = await counted({ clear: async () => false });
  assert.equal(await partial.keeper.tick(), 'failed');
  assert.match(partial.logged[0], /could not delete every cached page/);
});

/**
 * Reintroduce by deleting the `answered()` check: the first tick on a fresh boot calls an engine that is still
 * starting, and the `no request` assertion fails (and, with the real client, logs a warning on every desktop
 * that never downloaded its engine).
 */
test('nothing until the engine has answered once: a JVM still starting, a desktop engine never downloaded', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 });
  const { beginDownload, endDownload } = await activity();
  let answered = false;
  const { keeper, at, logged } = await counted({ answered: () => answered });
  assert.equal(await keeper.tick(), 'unanswered', 'the first tick went to an engine that had not answered');
  for (let i = 0; i < 3; i++) {
    const id = beginDownload({ folder: 'X', title: 'X', number: i, source: 'sw:1' });
    endDownload(id, { status: 'failed', reason: 'engine not running' });
    await run(keeper, 40);
  }
  assert.equal(at.length, 0, 'no request to an engine that has never answered');
  assert.deepEqual(logged, [], 'and nothing in the log about it');
  answered = true;
  await run(keeper, 1);
  assert.equal(at.length, 1, 'the first tick after it answered clears what was left');
});

/**
 * Reintroduce by deleting the settle from `due`: the idle clear at the thirty-minute mark lands twenty seconds
 * after one chapter of a job ended, just as the next one starts, and the `not in the gap` assertion fails.
 */
test('the idle clear waits out the gap between two chapters too', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 });
  const { beginDownload, startedDownload, endDownload } = await activity();
  const { keeper, at } = await counted();
  await keeper.tick();
  advance(29 * MIN);
  const id = beginDownload({ folder: 'Night Shelf', title: 'Night Shelf', number: 1, source: 'sw:5550003' });
  startedDownload(id);
  advance(50_000);
  endDownload(id, { status: 'done', pages: 3 });
  advance(20_000); // 30:10 -- the idle clear is due, and the job's next chapter is twenty seconds from starting
  assert.equal(await keeper.tick(), 'waiting', 'an idle clear in the gap between two chapters');
  assert.equal(at.length, 1, 'not in the gap');
  advance(41_000);
  assert.equal(await keeper.tick(), 'cleared', 'a minute after the chapter ended, with nothing after it');
  assert.equal(at.length, 2);
});

/**
 * The first clear on a months-old cache can run for up to the two-minute timeout, and the interval ticks every
 * minute. Reintroduce by deleting `if (running) return 'running'`: the second tick starts a second clear over
 * the first, and the `one clear at a time` assertion reads 2.
 */
test('one clear at a time, however long the first one takes', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 });
  const pending: Array<(ok: boolean) => void> = [];
  const { keeper } = await counted({ clear: () => new Promise<boolean>((r) => { pending.push(r); }) });
  const first = keeper.tick();
  advance(MIN);
  const second = keeper.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(pending.length, 1, 'one clear at a time');
  for (const r of pending) r(true);
  assert.equal(await second, 'running');
  assert.equal(await first, 'cleared');
});

/**
 * Reintroduce by dropping `a.source.startsWith(SW_PREFIX) &&` from lastExtensionDownloadEnded: every MangaDex
 * chapter that ends counts as an extension job ending, and a clear follows a minute later.
 */
test('a download from a built-in source ending is not an extension job ending', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 });
  const { beginDownload, startedDownload, endDownload } = await activity();
  const { keeper, at } = await counted();
  await keeper.tick();
  advance(5 * MIN);
  const md = beginDownload({ folder: 'Other', title: 'Other', number: 1, source: 'mangadex' });
  startedDownload(md);
  advance(MIN);
  endDownload(md, { status: 'done', pages: 3 });
  await run(keeper, 20);
  assert.equal(at.length, 1, 'a MangaDex chapter ending cleared the extension engine\'s cache');
});

/**
 * A clear is stamped with the time it STARTED. A chapter that starts and ends while a long clear runs left pages
 * the clear may not have caught, and gets a clear of its own. Reintroduce by stamping `lastClearAt = d.now()`
 * after the clear: that chapter ended "before" the last clear, and its pages wait for the thirty-minute mark.
 */
test('a chapter that ends while a clear runs gets a clear of its own', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 });
  const { beginDownload, startedDownload, endDownload } = await activity();
  let calls = 0;
  const { keeper, at } = await counted({
    clear: async () => {
      at.push(Date.now());
      if (calls++ === 0) {
        // A two-minute first clear, with a whole chapter inside it.
        advance(20_000);
        const id = beginDownload({ folder: 'Night Shelf', title: 'Night Shelf', number: 1, source: 'sw:5550003' });
        startedDownload(id);
        advance(30_000);
        endDownload(id, { status: 'done', pages: 3 });
        advance(70_000);
      }
      return true;
    },
  });
  assert.equal(await keeper.tick(), 'cleared');
  await run(keeper, 2);
  assert.equal(at.length, 2, 'the chapter that ended during the first clear got no clear of its own');
});

/**
 * The wiring: server.ts starts the keeper where the other extension schedules start, and the started keeper
 * really ticks and reaches the engine. Reintroduce by deleting `startEngineCacheKeeper(app.log)` from server.ts.
 */
test('the server starts the keeper, and a started keeper reaches the engine', async () => {
  const server = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf8');
  assert.match(server, /^\s+startEngineCacheKeeper\(app\.log\);$/m, 'server.ts no longer starts the page-cache keeper');

  fake.reset();
  // The engine has answered this process (as registration's first request does at boot).
  await (await import('../src/lib/sources/suwayomi/client')).aboutServer();
  // The interval only: the clear is a real request to the fake, on the real clock.
  mock.timers.enable({ apis: ['setInterval'] });
  const { startEngineCacheKeeper, TICK_MS } = await cache();
  const logged: string[] = [];
  startEngineCacheKeeper({ info: (m) => logged.push(m), warn: (m) => logged.push(m) });
  startEngineCacheKeeper({ info: (m) => logged.push(m), warn: (m) => logged.push(m) }); // idempotent
  assert.equal(fake.cacheClears.length, 0);
  mock.timers.tick(TICK_MS);
  for (let i = 0; i < 300 && fake.cacheClears.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(fake.cacheClears.length, 1, `the started keeper did not clear the engine's cache${logged.length ? `: ${logged.join('; ')}` : ''}`);
});
