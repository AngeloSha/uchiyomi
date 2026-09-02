// The nightly update sweep, and the difference between a quiet night and a broken one.
//
// This file is the updater's first test of any kind. That mattered, because every way the sweep could fail
// returned the same bare `added: 0` -- the series being gone, the source uninstalled, the source blocked,
// `listChapters` throwing or hanging, every chapter failing to save, or `updateSeries` throwing outright.
// `added: 0` is also exactly what a healthy night with nothing new returns, and it was all the admin panel
// ever received. The whole library could stop updating and every surface would report it was fine.
//
// That is precisely the failure the source watchdog exists to catch, and the lesson had never been applied
// to the most-used background job in the product.
//
// `listChapters` was also unbounded here while the identical call is bounded at 20s on the add path, so one
// hung site held a sequential sweep for undici's 300-second default, with every series behind it waiting.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UPDATER_LIST_TIMEOUT_MS = '300'; // the real bound is 20s; nobody should wait that to prove it exists
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_upd';
const SRC_OK = 'upd-ok', SRC_THROW = 'upd-throw', SRC_HANG = 'upd-hang', SRC_EMPTY = 'upd-empty';
const SRC_BLOCK = 'upd-block';
/** Counts how many chapters the sweep actually ATTEMPTS against a source that is refusing. */
let blockAsks = 0;
const S = (k: string) => `s_upd_${k}`;
let q: any, updateSeries: any, runUpdateAll: any;

function fake(id: string, mode: 'ok' | 'throw' | 'hang' | 'empty') {
  return {
    id, name: id,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: id }; },
    async listChapters() {
      if (mode === 'throw') throw new Error('site refused');
      if (mode === 'hang') return new Promise<any[]>(() => {});   // a site behind a challenge that never answers
      if (mode === 'empty') return [];
      return [{ number: 1, title: 'Chapter 1', id: 'c1' }];
    },
    async getPageUrls() { return []; },
    async latest() { return []; },
  };
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  ({ updateSeries, runUpdateAll } = (await import('../src/lib/updater')) as any);
  await migrate();

  registerAdapter(fake(SRC_OK, 'ok') as any);
  registerAdapter(fake(SRC_THROW, 'throw') as any);
  registerAdapter(fake(SRC_HANG, 'hang') as any);
  registerAdapter(fake(SRC_EMPTY, 'empty') as any);
  registerAdapter({
    id: SRC_BLOCK, name: SRC_BLOCK,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: SRC_BLOCK, title: SRC_BLOCK }; },
    async listChapters() {
      return Array.from({ length: 5 }, (_, i) => ({ number: i + 1, title: `Chapter ${i + 1}`, id: `c${i + 1}` }));
    },
    async getPageUrls() { blockAsks++; return ['https://example.invalid/refused.png']; },
    async latest() { return []; },
  } as any);

  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Upd',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  const mk = async (key: string, sourceId: string | null) =>
    q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
       VALUES ($1,'T!upd',$1,$1,0,$2,$3,$4,true) ON CONFLICT (id) DO NOTHING`,
      [S(key), LIB, sourceId, sourceId ? `${sourceId}-1` : null]);
  await mk('throw', SRC_THROW);
  await mk('hang', SRC_HANG);
  await mk('empty', SRC_EMPTY);
  await mk('unrouted', null);
  await mk('block', SRC_BLOCK);
});

after(async () => {
  if (!DSN) return;
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC_BLOCK]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
});

test('a series says WHY it produced nothing', { skip }, async (t) => {
  await t.test('a source that throws is not a quiet night', async () => {
    const r = await updateSeries(S('throw'));
    assert.equal(r.added, 0);
    assert.equal(r.outcome, 'source_error', 'a refusing site must be distinguishable from having nothing new');
  });

  await t.test('a source that hangs is bounded, and reported', async () => {
    const started = Date.now();
    const r = await updateSeries(S('hang'));
    assert.ok(Date.now() - started < 5000, 'listChapters must be bounded here as it is on the add path');
    assert.equal(r.outcome, 'source_error');
  });

  await t.test('a source that genuinely has nothing is healthy', async () => {
    const r = await updateSeries(S('empty'));
    assert.equal(r.added, 0);
    assert.equal(r.outcome, 'ok', 'nothing new is a perfectly good night');
  });

  await t.test('a row with no source is unrouted, not broken', async () => {
    const r = await updateSeries(S('unrouted'));
    assert.equal(r.outcome, 'unrouted');
  });

  await t.test('a series that no longer exists says so', async () => {
    const r = await updateSeries('s_upd_does_not_exist');
    assert.equal(r.outcome, 'gone');
  });
});

test('a sweep where everything failed does not look like a sweep with nothing new', { skip }, async (t) => {
  await t.test('all-broken reports unhealthy', async () => {
    await q(`UPDATE lib_series SET auto_update = COALESCE(source_id = $1 OR source_id = $2, false) WHERE library_id = $3`,
      [SRC_THROW, SRC_HANG, LIB]);
    const r = await runUpdateAll({ maxNew: 1 });
    assert.equal(r.added, 0);
    assert.equal(r.healthy, false, 'a run where no source answered must not report healthy');
    assert.ok(r.failed >= 2, `expected the failures to be counted, got ${r.failed}`);
    assert.ok(r.outcomes.source_error >= 2, 'and attributed to the right cause');
  });

  await t.test('all-quiet reports healthy, with the same +0', async () => {
    await q(`UPDATE lib_series SET auto_update = COALESCE(source_id = $1, false) WHERE library_id = $2`, [SRC_EMPTY, LIB]);
    const r = await runUpdateAll({ maxNew: 1 });
    assert.equal(r.added, 0, 'same visible number as the broken run above...');
    assert.equal(r.healthy, true, '...and that is exactly why the two must differ somewhere else');
    assert.equal(r.failed, 0);
  });
});


/**
 * A source that refuses must cost ONE chapter, not five.
 *
 * The updater was the only caller of downloadChapter that did not stop on `blockStatus` -- its catch was a
 * bare `failed++`. So when mangakakalot rate-limited us, the sweep asked it for four more chapters it was
 * never going to serve, and each refusal called reportFail again. The cooldown escalates with `consecutive`
 * (15, 30, 45, 60, 75 minutes), so one burst produced five escalations in 74 seconds and locked the source
 * for 75 minutes. The person's own manual retry was then refused too, which is what "I tried again and it
 * still doesn't work" actually was.
 *
 * Reintroduce by restoring `} catch { failed++; }` in updater.ts: blockAsks becomes 5 and consecutive 5.
 */
test('a refusing source costs one chapter, not the whole run', { skip }, async () => {
  globalThis.fetch = (async () => new Response('go away', { status: 403 })) as typeof fetch;
  blockAsks = 0;
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC_BLOCK]);

  await updateSeries(S('block'), 5);

  assert.equal(blockAsks, 1, 'the sweep stopped at the first refusal instead of asking five times');
  const h = (await q(`SELECT consecutive FROM source_health WHERE source_id = $1`, [SRC_BLOCK]))[0];
  assert.ok(h, 'the refusal is still recorded once');
  assert.equal(Number(h.consecutive), 1,
    'one refusal is one strike: five strikes turned a 15-minute cooldown into 75');
});
