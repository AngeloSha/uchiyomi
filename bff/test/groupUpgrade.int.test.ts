// Group upgrades (lib/repair.ts stepGroups, #81 and the second half of #93): the nightly repair swaps a chapter
// for the copy a higher-ranked scanlation group released, and every rule it promises is pinned here against
// real files and the real downloader:
//
//   - off by default: nothing is asked, nothing is touched;
//   - on: a chapter held from another group is replaced by the preferred group's copy, over the same row,
//     restamped and audited;
//   - never a shorter copy, never a file Uchiyomi did not download, never a hand-picked chapter, never a
//     file whose group is unknown;
//   - a failed swap waits a week; at most REPAIR_GROUPS_MAX a run.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
let ROOT = '';
let OTHER_ROOT = '';
if (DSN) {
  ROOT = mkdtempSync(join(tmpdir(), 'yomi-groupup-'));
  OTHER_ROOT = mkdtempSync(join(tmpdir(), 'yomi-groupup-read-'));
  process.env.DL_ROOT = ROOT;
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.MIN_FREE_GB = '0';
  process.env.REPAIR_PACE_MS = '0';
  // Read at module load: three, so the budget test below can see it bite with five candidates.
  process.env.REPAIR_GROUPS_MAX = '3';
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_groupup';
/** The source the series was added from; its copies are by OTHER. */
const PRIMARY = 'gu-primary';
/** A followed source; its copies are by GOOD, the group the preferences rank first. */
const FOLLOWER = 'gu-follower';
const OTHER = 'Zzgu Other Scans';
const GOOD = 'Zzgu Good Scans';
const S = (k: string) => `s_gu_${k}`;
const HELD = Buffer.from('the copy already on disk');
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);

/** Page-list asks, as `<source>:<number>`. */
const asked: string[] = [];
/** Pages the FOLLOWER lists for a number, when not the default five. */
const followerPages = new Map<number, number>();
/** FOLLOWER numbers whose page images answer 404: the download fails. */
const brokenImages = new Set<number>();

function source(id: string, group: string) {
  return {
    id, name: `Zzz ${id}`,
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: sid }; },
    // The listing says what the page list will serve. A listing that claimed five pages for a one-page
    // chapter was refused by the downloader as incomplete, and the "never a shorter copy" test then passed
    // with the rule it is about deleted.
    async listChapters() {
      return [1, 2, 3, 4, 5].map((n) => ({
        number: n, title: `Chapter ${n}`, sourceId: `${id}-c${n}`, scanlator: group,
        pages: id === FOLLOWER ? (followerPages.get(n) ?? 5) : 5,
      }));
    },
    async getPageUrls(chId: string) {
      const n = Number(chId.split('-c').pop());
      asked.push(`${id}:${n}`);
      const count = id === FOLLOWER ? (followerPages.get(n) ?? 5) : 5;
      return Array.from({ length: count }, (_, i) => `https://example.invalid/${id}/${n}/${i}.png`);
    },
    async latest() { return []; },
  };
}

let q: any, repairLibrary: any, updateSeries: any;
let savedPrefs: unknown = null;

const fileOf = (key: string, n: number) => join(ROOT, S(key), `Chapter ${n}.cbz`);
const bookId = (key: string, n: number) => `${S(key)}_b${n}`;
const row = async (key: string, n: number) =>
  (await q('SELECT id, source_id, scanlator, pages, picked_at, upgrade_tried_at FROM lib_books WHERE id = $1', [bookId(key, n)]))[0];

/**
 * A series added from PRIMARY and following FOLLOWER, holding chapters 1-5 as five-page files from OTHER,
 * each a file the downloader wrote (the download root, its own file name), and with its listing written.
 */
async function series(key: string) {
  await q('DELETE FROM lib_series WHERE id = $1', [S(key)]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
           VALUES ($1,'T!gu',$1,$1,5,$2,$3,$4,true)`, [S(key), LIB, PRIMARY, `${PRIMARY}-1`]);
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1,$2,$3)`, [S(key), FOLLOWER, `${FOLLOWER}-1`]);
  rmSync(join(ROOT, S(key)), { recursive: true, force: true });
  mkdirSync(join(ROOT, S(key)), { recursive: true });
  for (let n = 1; n <= 5; n++) {
    writeFileSync(fileOf(key, n), HELD);
    await q(`INSERT INTO lib_books (id, series_id, source, root, file, number, title, pages, source_id, scanlator)
             VALUES ($1,$2,'T!gu',$3,$4,$5,$6,5,$7,$8)`,
    [bookId(key, n), S(key), ROOT, `${S(key)}/Chapter ${n}.cbz`, n, `Chapter ${n}`, PRIMARY, OTHER]);
  }
  await updateSeries(S(key), 0); // the listing the step starts from
  asked.length = 0;
}

async function switchOn(on: boolean) {
  await q('UPDATE server_settings SET group_upgrade = $1 WHERE id = 1', [on]);
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  ({ repairLibrary } = (await import('../src/lib/repair')) as any);
  ({ updateSeries } = (await import('../src/lib/updater')) as any);
  await migrate();
  registerAdapter(source(PRIMARY, OTHER) as any);
  registerAdapter(source(FOLLOWER, GOOD) as any);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'GroupUp',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
  savedPrefs = (await q('SELECT scanlator_prefs FROM server_settings WHERE id = 1'))[0]?.scanlator_prefs ?? null;
  await q('UPDATE server_settings SET scanlator_prefs = $1::jsonb WHERE id = 1',
    [JSON.stringify({ priority: [GOOD], blocked: [], patienceDays: 0 })]);
  globalThis.fetch = (async (u: any) => {
    const m = /\/gu-follower\/(\d+)\//.exec(String(u));
    if (m && brokenImages.has(Number(m[1]))) return new Response('gone', { status: 404 });
    return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
});

beforeEach(async () => {
  if (!DSN) return;
  asked.length = 0;
  followerPages.clear();
  brokenImages.clear();
  await switchOn(false);
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[PRIMARY, FOLLOWER]]);
  // The step looks at the whole library, so an earlier test's series would be the one it swaps.
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]);
});

after(async () => {
  for (const r of [ROOT, OTHER_ROOT]) if (r) rmSync(r, { recursive: true, force: true });
  if (!DSN) return;
  // Shared database: the switch and the ranking must not outlive this file.
  await switchOn(false).catch(() => {});
  await q('UPDATE server_settings SET scanlator_prefs = $1::jsonb WHERE id = 1', [JSON.stringify(savedPrefs)]).catch(() => {});
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[PRIMARY, FOLLOWER]]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
});

const run = () => repairLibrary(undefined, { only: ['groups'], userId: null });

test('off by default: nothing is asked and nothing is touched', { skip }, async () => {
  await series('off');
  const r = await run();
  // Reintroduce by dropping the switch check at the top of stepGroups: five chapters are swapped.
  assert.equal(r.groups.off, true);
  assert.deepEqual(asked, [], `pages were asked with the switch off: ${asked}`);
  for (let n = 1; n <= 5; n++) assert.deepEqual(readFileSync(fileOf('off', n)), HELD);
});

test("on: a chapter from another group is replaced by the preferred group's copy, over the same row", { skip }, async () => {
  await switchOn(true);
  await series('on');
  const r = await run();
  // Three: REPAIR_GROUPS_MAX, set at the top of this file. The other two wait for the next night.
  assert.equal(r.groups.replaced, 3, JSON.stringify(r.groups));
  let swapped = 0;
  for (let n = 1; n <= 5; n++) {
    const b = await row('on', n);
    assert.ok(b, `chapter ${n}'s row is gone; everyone's progress would go with it`);
    if (b.scanlator === GOOD) {
      swapped++;
      assert.equal(b.source_id, FOLLOWER, 'the provenance still names the old source');
      assert.notDeepEqual(readFileSync(fileOf('on', n)), HELD, `chapter ${n} was restamped but not rewritten`);
    } else {
      assert.deepEqual(readFileSync(fileOf('on', n)), HELD, `chapter ${n} was rewritten without being restamped`);
    }
  }
  // Reintroduce by dropping `candidates.length >= REPAIR_GROUPS_MAX` and the swaps are five.
  assert.equal(swapped, 3, 'at most REPAIR_GROUPS_MAX a run');
  const audit = await q(`SELECT count(*)::int AS n FROM audit_log WHERE event = 'book.group_upgraded' AND detail->>'seriesId' = $1`, [S('on')]);
  assert.equal(audit[0].n, 3, 'a swap was not audited');
  // And the next night takes the rest, and then nothing is left to do.
  await run();
  for (let n = 1; n <= 5; n++) assert.equal((await row('on', n)).scanlator, GOOD);
  asked.length = 0;
  const again = await run();
  assert.equal(again.groups.replaced, 0);
  assert.ok(!asked.some((a) => a.startsWith(FOLLOWER)), 'an upgraded chapter was looked at again');
});

test('never a shorter copy: a one-page notice from the right group does not replace a chapter', { skip }, async () => {
  await switchOn(true);
  followerPages.set(1, 1);
  await series('short');
  // Only chapter 1 is a candidate: the rest are already the preferred group's.
  await q('UPDATE lib_books SET scanlator = $2 WHERE series_id = $1 AND number <> 1', [S('short'), GOOD]);
  const r = await run();
  // Reintroduce by dropping `count < book.pages` in stepGroups: the notice is written over the chapter.
  assert.deepEqual(readFileSync(fileOf('short', 1)), HELD, 'a shorter copy replaced the chapter');
  assert.equal((await row('short', 1)).scanlator, OTHER);
  assert.equal(r.groups.replaced, 0);
  assert.ok(asked.includes(`${FOLLOWER}:1`), 'the copy was never asked, so the check above proves nothing');
});

test('only files Uchiyomi downloaded, never a hand-picked chapter, never a file of unknown group', { skip }, async () => {
  await switchOn(true);
  await series('rules');
  // 1: another root (somebody's read library). 2: not the downloader's file name. 3: picked by hand. 4: no group.
  mkdirSync(join(OTHER_ROOT, S('rules')), { recursive: true });
  writeFileSync(join(OTHER_ROOT, S('rules'), 'Chapter 1.cbz'), HELD);
  await q('UPDATE lib_books SET root = $2 WHERE id = $1', [bookId('rules', 1), OTHER_ROOT]);
  await q(`UPDATE lib_books SET file = $2 WHERE id = $1`, [bookId('rules', 2), `${S('rules')}/My copy of 2.cbz`]);
  await q('UPDATE lib_books SET picked_at = now() WHERE id = $1', [bookId('rules', 3)]);
  await q('UPDATE lib_books SET scanlator = NULL WHERE id = $1', [bookId('rules', 4)]);
  const r = await run();
  // Reintroduce each by dropping its clause from stepGroups' query or the chapterFileRel test: that chapter swaps.
  assert.equal((await row('rules', 1)).scanlator, OTHER, 'a file outside the download root was replaced');
  assert.equal((await row('rules', 2)).scanlator, OTHER, "a file not named by the downloader was replaced");
  assert.equal((await row('rules', 3)).scanlator, OTHER, 'a hand-picked chapter was replaced');
  assert.equal((await row('rules', 4)).scanlator, null, 'a chapter of unknown group was replaced');
  // Nothing written into the series folder for any of them either -- for 1 and 2 that would be a second
  // copy beside somebody's own file, which the row checks above cannot see.
  for (const n of [1, 2, 3, 4]) assert.deepEqual(readFileSync(fileOf('rules', n)), HELD, `chapter ${n}'s file in the download folder was written`);
  // Chapter 5 is ordinary, and is swapped: the rules above are not simply "nothing happens".
  assert.equal((await row('rules', 5)).scanlator, GOOD, 'the control chapter was not swapped');
  assert.equal(r.groups.replaced, 1);
});

test('a failed swap keeps the file and waits a week', { skip }, async () => {
  await switchOn(true);
  await series('fail');
  // Only chapter 1 is a candidate -- by a rule other than the one this test is about. Excluding the others with
  // the retry stamp let them take the whole budget once the stamp was ignored, and the test passed anyway.
  await q('UPDATE lib_books SET scanlator = $2 WHERE series_id = $1 AND number <> 1', [S('fail'), GOOD]);
  brokenImages.add(1);
  const r = await run();
  assert.equal(r.groups.replaced, 0);
  assert.deepEqual(readFileSync(fileOf('fail', 1)), HELD, 'a failed download touched the held file');
  assert.equal((await row('fail', 1)).scanlator, OTHER);
  assert.ok((await row('fail', 1)).upgrade_tried_at, 'the attempt was not stamped');
  // The next night: still broken or not, it is not asked again for a week. The failed download may have put
  // the source in a cooldown, which would stop the ask for a reason of its own -- so it is cleared.
  asked.length = 0;
  brokenImages.clear();
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[PRIMARY, FOLLOWER]]);
  await run();
  // Reintroduce by dropping the upgrade_tried_at clause: FOLLOWER:1 is asked, and the chapter swaps.
  assert.ok(!asked.includes(`${FOLLOWER}:1`), `a failed swap was tried again the next night: ${asked}`);
  assert.equal((await row('fail', 1)).scanlator, OTHER);
});
