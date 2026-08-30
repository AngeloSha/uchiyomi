// Adding a series from a source, driven through the real function rather than read as text.
//
// The existing guard for this path, addAsync.test.ts, is twelve regexes over the source file. It is worth
// keeping -- it stops someone re-editing those particular lines -- but it executes nothing, and an earlier
// version of it matched the COMMENT explaining a fix rather than the fix. None of the three faults below
// would have moved it.
//
//  1. A source that answered without a title fell back to the literal string 'Series', which becomes the
//     folder name. So a getSeries that timed out while listChapters succeeded filed the title under
//     `<Source>/Series` -- and the next title to do the same was told "already in library" and quietly
//     merged onto that same shelf. A network hiccup could collapse unrelated series into one, which is
//     library corruption dressed up as a successful add.
//
//  2. The shared detail cache stored the FAILURE too. A timeout produced `{ series: null, chapters: [] }`,
//     which was cached for ninety seconds and then reported as a confident 404: "No readable chapters for
//     this title on this source. Try a different source." Retrying inside the window repeated the same
//     wrong advice. Before the cache existed the identical catch was there and a retry simply worked; the
//     cache is what made a hiccup stick.
//
//  3. The download loop counted chapters it had not written. Its catch handled `blockStatus` and swallowed
//     everything else -- a full disk, a permission error, an unparseable chapter -- while `j.done++` ran
//     anyway and the job finished `done`. A disk-full add filled the bar to 100%, showed the green tick, and
//     landed nothing.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let root = '';
if (DSN) {
  root = mkdtempSync(join(tmpdir(), 'yomi-add-'));
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.DL_ROOT = root;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const MOODY = 'add-moody';   // fails once, then works: the transient case
const NAMELESS = 'add-noname';
let addSeriesFromSource: any, q: any;
let moodyCalls = 0;

const chapter = (n: number) => ({ number: n, title: `Chapter ${n}`, id: `c${n}`, pages: 1 });

function moody() {
  return {
    id: MOODY, name: 'Moody Source',
    async search() { return []; },
    async getSeries(sid: string) {
      moodyCalls++;
      if (moodyCalls === 1) throw new Error('challenge timed out');
      return { sourceId: sid, source: MOODY, title: 'A Real Title' };
    },
    async listChapters() { return moodyCalls <= 1 ? [] : [chapter(1)]; },
    async getPageUrls() { return ['https://example.invalid/p1.jpg']; },
    async latest() { return []; },
  };
}

/** Answers chapters but never a title, which is exactly the half-failure that produced `<Source>/Series`. */
function nameless() {
  return {
    id: NAMELESS, name: 'Nameless Source',
    async search() { return []; },
    async getSeries() { return null; },
    async listChapters() { return [chapter(1)]; },
    async getPageUrls() { return ['https://example.invalid/p1.jpg']; },
    async latest() { return []; },
  };
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  ({ addSeriesFromSource } = (await import('../src/routes/sources')) as any);
  await migrate();
  registerAdapter(moody() as any);
  registerAdapter(nameless() as any);
});

after(async () => {
  if (root) rmSync(root, { recursive: true, force: true });
  if (!DSN) return;
  await q(`DELETE FROM lib_series WHERE source_id = ANY($1)`, [[MOODY, NAMELESS]]).catch(() => {});
});

test('an add that cannot name the series does not invent one', { skip }, async (t) => {
  await t.test('it refuses rather than filing the title under "Series"', async () => {
    const r = await addSeriesFromSource({ source: NAMELESS, sourceId: `${NAMELESS}-1`, wait: true });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'no_title');
    assert.equal(r.status, 503, 'transient, so the client is told to try again rather than to give up');
  });

  await t.test('and nothing was created under a placeholder name', async () => {
    const rows = await q(`SELECT id, folder FROM lib_series WHERE folder LIKE '%/Series'`);
    assert.equal(rows.length, 0, 'a folder called "Series" is the shelf unrelated titles used to merge onto');
  });

  await t.test('a SECOND nameless add is refused too, not merged into the first', async () => {
    const r = await addSeriesFromSource({ source: NAMELESS, sourceId: `${NAMELESS}-2`, wait: true });
    assert.equal(r.error, 'no_title', 'the second one used to be told "already in library"');
  });
});

test('a transient source failure is not remembered as a verdict', { skip }, async (t) => {
  await t.test('the first attempt fails, as the source did', async () => {
    moodyCalls = 0;
    const r = await addSeriesFromSource({ source: MOODY, sourceId: `${MOODY}-1`, wait: true });
    assert.equal(r.ok, false, 'the source genuinely failed, so the add genuinely fails');
  });

  await t.test('an immediate retry asks again instead of replaying the failure', async () => {
    // Well inside the 90-second detail cache TTL: the whole point is that the failure was never cached.
    const before = moodyCalls;
    const r = await addSeriesFromSource({ source: MOODY, sourceId: `${MOODY}-1`, wait: true });
    assert.ok(moodyCalls > before, 'the source must actually be asked again, not answered from a cached failure');
    assert.ok(r.ok || r.error !== 'no_chapters',
      'a hiccup must not harden into "No readable chapters for this title on this source"');
  });
});
