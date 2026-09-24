// Source priority, and the upgrade it can make over a chapter already held.
//
// An order on its own only ranks the copies of a chapter the server does not have yet. Replacing a held
// file is a separate switch, off by default, because it re-downloads chapters an admin may consider done --
// so each way it could overreach is pinned here against the real updater, with files on disk:
//
//   - the switch off: nothing held is touched, whatever the order says;
//   - the switch on: a chapter held from a lower-ranked source is re-fetched from the higher-ranked one, over
//     the same file, and the row (its id, so everyone's progress) survives with its provenance updated;
//   - never over a tombstone, never over a copy of unknown origin;
//   - upgrade or nothing: a short copy is discarded, no lower-ranked copy is asked instead, and the held file
//     and row stay exactly as they were;
//   - a failed upgrade is left alone for a week;
//   - one budget across series, as the sweep hands it out.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-srcprio-'));
  process.env.DL_ROOT = ROOT;
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.MIN_FREE_GB = '0';
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_srcprio';
/** The source the series was added from, and ranked LOWER. */
const WORSE = 'sp-worse';
/** A followed source, ranked HIGHER. */
const BETTER = 'sp-better';
const S = (k: string) => `s_sp_${k}`;
const HELD = Buffer.from('the copy already on disk');
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);

/** Page asks per source, as `<source>:<chapter number>`. */
const asked: string[] = [];
/** Chapter numbers whose pages the better source cannot serve: `short` misses one of five, `dead` all. */
const broken = new Map<number, 'short' | 'dead'>();

function source(id: string) {
  return {
    id, name: id,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: sid }; },
    async listChapters() {
      return [1, 2, 3, 4, 5].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `${id}-c${n}`, pages: 5 }));
    },
    async getPageUrls(chId: string) {
      const n = Number(chId.split('-c').pop());
      asked.push(`${id}:${n}`);
      return Array.from({ length: 5 }, (_, i) => `https://example.invalid/${id}/${n}/${i}.png`);
    },
    async latest() { return []; },
  };
}

let q: any, updateSeries: any, invalidateSourcePrefs: any, UPGRADE_BACKOFF_DAYS: number;

const file = (key: string, n: number) => join(ROOT, S(key), `Chapter ${n}.cbz`);
const bookId = (key: string, n: number) => `${S(key)}_b${n}`;
const row = async (key: string, n: number) =>
  (await q('SELECT id, source_id, pruned_at FROM lib_books WHERE id = $1', [bookId(key, n)]))[0];

/**
 * A series added from WORSE and following BETTER, holding chapters 1-5 as files and rows. `from` says
 * which source each held copy came from (null: unknown, as for a file the scanner found on disk).
 */
async function series(key: string, from: (n: number) => string | null = () => WORSE) {
  await q('DELETE FROM lib_series WHERE id = $1', [S(key)]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
           VALUES ($1,'T!sp',$1,$1,5,$2,$3,$4,true)`, [S(key), LIB, WORSE, `${WORSE}-1`]);
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,$2,$3)`, [S(key), BETTER, `${BETTER}-1`]);
  mkdirSync(join(ROOT, S(key)), { recursive: true });
  for (let n = 1; n <= 5; n++) {
    writeFileSync(file(key, n), HELD);
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, source_id) VALUES ($1,$2,'T!sp',$3,$4,$5,5,$6)`,
      [bookId(key, n), S(key), `${S(key)}/Chapter ${n}.cbz`, n, `Chapter ${n}`, from(n)]);
  }
}

async function settings(order: string[], upgrade: boolean) {
  await q(`UPDATE server_settings SET source_prefs = $1::jsonb, source_upgrade = $2 WHERE id = 1`,
    [JSON.stringify({ priority: order }), upgrade]);
  invalidateSourcePrefs();
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  ({ updateSeries } = (await import('../src/lib/updater')) as any);
  ({ invalidateSourcePrefs, UPGRADE_BACKOFF_DAYS } = (await import('../src/lib/sourcePrefs')) as any);
  await migrate();
  registerAdapter(source(WORSE) as any);
  registerAdapter(source(BETTER) as any);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'SrcPrio',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  globalThis.fetch = (async (u: any) => {
    const m = /\/(sp-[a-z]+)\/(\d+)\/(\d+)\.png$/.exec(String(u));
    const how = m && m[1] === BETTER ? broken.get(Number(m[2])) : undefined;
    if (how === 'dead' || (how === 'short' && m![3] === '4')) return new Response('gone', { status: 404 });
    return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
});

beforeEach(async () => {
  if (!DSN) return;
  asked.length = 0;
  broken.clear();
  // A failed page reports the source's health; a cooldown would then skip its listing next run and make a
  // "was not asked" assertion pass for the wrong reason.
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[WORSE, BETTER]]);
});

after(async () => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
  if (!DSN) return;
  await settings([], false).catch(() => {});
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[WORSE, BETTER]]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
});

test('the sourcePrefs rule itself', { skip }, async () => {
  const { effectiveSourcePriority } = await import('../src/lib/sourcePrefs');
  // A series' own order needs no database: it replaces the server's.
  const p = await effectiveSourcePriority({ priority: ['a', 'b'] });
  assert.equal(p.outranks('a', 'b'), true);
  assert.equal(p.outranks('b', 'a'), false);
  assert.equal(p.outranks('b', 'z'), true, 'a listed source outranks an unlisted one');
  assert.equal(p.outranks('y', 'z'), false, 'two unlisted sources never outrank each other');
  // Reintroduce by dropping `if (!held) return false`: a file the scanner found would lose to every source.
  assert.equal(p.outranks('a', null), false, 'a copy of unknown origin was treated as replaceable');
});

test('upgrades are off by default: an order alone re-fetches nothing held', { skip }, async () => {
  await settings([BETTER, WORSE], false);
  await series('off');
  const r = await updateSeries(S('off'), 10);
  assert.equal(r.added, 0);
  assert.deepEqual(asked, [], `pages were asked for chapters already held: ${asked}`);
  for (let n = 1; n <= 5; n++) assert.deepEqual(readFileSync(file('off', n)), HELD);
});

test('with the switch on, a held chapter is replaced from the better source over the same row', { skip }, async () => {
  await settings([BETTER, WORSE], true);
  // 1-3 from the worse source; 4 a tombstone (deleted on purpose); 5 of unknown origin.
  await series('on', (n) => (n === 5 ? null : WORSE));
  await q(`UPDATE lib_books SET pruned_at = now(), pruned_reason = 'deleted' WHERE id = $1`, [bookId('on', 4)]);
  const r = await updateSeries(S('on'), 10);
  assert.equal(r.upgraded, 3, `upgraded ${r.upgraded}; asked ${asked}`);
  assert.deepEqual(asked.sort(), [`${BETTER}:1`, `${BETTER}:2`, `${BETTER}:3`]);
  for (const n of [1, 2, 3]) {
    assert.notDeepEqual(readFileSync(file('on', n)), HELD, `chapter ${n} was not replaced`);
    const b = await row('on', n);
    assert.ok(b, `chapter ${n}'s row is gone; progress would go with it`);
    assert.equal(b.source_id, BETTER, 'the provenance still names the old source, so the next sweep would upgrade it again');
  }
  // Reintroduce by selecting upgrades from every held row rather than the live ones: chapter 4 is fetched.
  assert.deepEqual(readFileSync(file('on', 4)), HELD, 'a tombstone was re-fetched as an upgrade');
  assert.deepEqual(readFileSync(file('on', 5)), HELD, 'a copy of unknown origin was replaced');

  // And the next run has nothing left to do.
  asked.length = 0;
  await updateSeries(S('on'), 10);
  assert.deepEqual(asked, [], 'an upgraded chapter was upgraded again');
});

test('upgrade or nothing: a short or failed copy leaves the held file and row alone, and no worse copy is asked', { skip }, async () => {
  await settings([BETTER, WORSE], true);
  await series('fail');
  broken.set(1, 'short'); // 4 of 5 pages: above the partial floor, so the downloader offers a hold
  // Last, because a chapter with no page at all blames the source and takes it out of the rest of the run.
  broken.set(5, 'dead');
  const before1 = await row('fail', 1);
  const r = await updateSeries(S('fail'), 10);
  // Reintroduce by letting upgrades fall back like missing chapters (alternates / acceptPartial): the worse
  // source is asked for 1 and 2 and chapter 1 is written with a placeholder page.
  assert.equal(asked.filter((a) => a.startsWith(`${WORSE}:`)).length, 0, `a lower-ranked copy was asked: ${asked}`);
  for (const n of [1, 5]) assert.deepEqual(readFileSync(file('fail', n)), HELD, `chapter ${n}'s held file was touched`);
  assert.deepEqual(await row('fail', 1), before1, 'the held row changed');
  assert.equal(r.failed, 0, 'a failed upgrade was counted as a failed chapter');
  const ledger = await q('SELECT count(*)::int AS n FROM chapter_failures WHERE series_id = $1', [S('fail')]);
  assert.equal(ledger[0].n, 0, 'a failed upgrade was written to the missing-chapter ledger');
  const back = await q('SELECT number FROM source_upgrade_failures WHERE series_id = $1 ORDER BY number', [S('fail')]);
  assert.deepEqual(back.map((x: any) => Number(x.number)), [1, 5]);
  // 2-4 were fine and landed.
  for (const n of [2, 3, 4]) assert.notDeepEqual(readFileSync(file('fail', n)), HELD);
});

test('a failed upgrade is not asked again for a week', { skip }, async () => {
  await settings([BETTER, WORSE], true);
  await series('backoff');
  broken.set(1, 'dead');
  await updateSeries(S('backoff'), 10);
  assert.ok(asked.includes(`${BETTER}:1`));

  // The next night: the source still lists it, and it is left alone.
  asked.length = 0;
  broken.clear();
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[WORSE, BETTER]]);
  await updateSeries(S('backoff'), 10);
  // Reintroduce by dropping the source_upgrade_failures read in updateSeries: BETTER:1 is asked again.
  assert.ok(!asked.includes(`${BETTER}:1`), `a backed-off upgrade was asked again: ${asked}`);
  assert.ok(asked.includes(`${BETTER}:2`), `the rest of the series was not upgraded, so the check above proves nothing: ${asked}`);

  // A week on, it is.
  asked.length = 0;
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[WORSE, BETTER]]);
  await q(`UPDATE source_upgrade_failures SET at = now() - make_interval(days => $2 + 1) WHERE series_id = $1`,
    [S('backoff'), UPGRADE_BACKOFF_DAYS]);
  await updateSeries(S('backoff'), 10);
  assert.deepEqual(asked, [`${BETTER}:1`]);
  assert.notDeepEqual(readFileSync(file('backoff', 1)), HELD);
  const left = await q('SELECT count(*)::int AS n FROM source_upgrade_failures WHERE series_id = $1', [S('backoff')]);
  assert.equal(left[0].n, 0, 'a landed upgrade kept its backoff row');
});

test('one upgrade budget across series, as the sweep hands it out', { skip }, async () => {
  await settings([BETTER, WORSE], true);
  await series('capA');
  await series('capB');
  // runUpdateAll passes ONE { left: UPGRADE_MAX_PER_SWEEP } to every series it visits; three stands in for it.
  const budget = { left: 3 };
  const a = await updateSeries(S('capA'), 10, { upgrades: budget });
  const b = await updateSeries(S('capB'), 10, { upgrades: budget });
  // Reintroduce by giving each updateSeries a budget of its own: 5 + 5 land.
  assert.equal(a.upgraded + b.upgraded, 3, `A upgraded ${a.upgraded}, B ${b.upgraded}`);
  assert.equal(budget.left, 0);
  assert.equal(asked.length, 3);
});

test('new chapters come from the higher-ranked source, and go first', { skip }, async () => {
  await settings([BETTER, WORSE], false);
  await series('new');
  await q('DELETE FROM lib_books WHERE id = $1', [bookId('new', 5)]);
  rmSync(file('new', 5));
  const r = await updateSeries(S('new'), 10);
  // Reintroduce by leaving the order out of `chooseOpts.sourceRank`: the primary (worse) source wins the tie.
  assert.deepEqual(asked, [`${BETTER}:5`]);
  assert.equal(r.added, 1);
});
