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
//  4. "First N" was the only partial add, and adapters list ascending, so it always meant the OLDEST N while
//     docs/api.md said "most recent". "Latest N" is the other end -- and it needs a floor on the row, or the
//     updater's oldest-missing-first loop backfills everything below the selection five per night with each
//     new release queued behind it.
//
//  5. A source that lists a chapter once per group (MangaDex, or any site with two active teams) handed the
//     add every row, so "2 chapters" downloaded three times and the first row for a number -- as often the
//     group nobody wanted as the one they did -- was the copy that landed. The updater never replaces a file
//     that is on disk, so a blocked group's copy taken at add time was locked in for the life of the series.
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
  // Pacing is production politeness, not the subject here; downloadPacing.int.test.ts pins the delay itself.
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.MIN_FREE_GB = '0'; // the disk floor belongs to diskGuard.test.ts
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const MOODY = 'add-moody';   // fails once, then works: the transient case
const NAMELESS = 'add-noname';
const LATEST = 'add-latest'; // five chapters that really download, for the "latest N" add
const GROUPS = 'add-groups'; // chapter 1 from two groups, the blocked one listed first
const USER = 'add-route-user';
let addSeriesFromSource: any, q: any;
let moodyCalls = 0;
/** Which chapter ids the groups source was asked for pages: who the add actually downloaded from. */
let asked: string[] = [];

const chapter = (n: number) => ({ number: n, title: `Chapter ${n}`, id: `c${n}`, pages: 1 });
/** A one-pixel PNG, comfortably over the 256-byte floor the downloader uses to skip blocked responses. */
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const realFetch = globalThis.fetch;

/** Five chapters, one page each. `sourceId` is what the downloader hands back to getPageUrls. */
function latest() {
  return {
    id: LATEST, name: 'Latest Source',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: LATEST, title: 'Caught Up' }; },
    async listChapters() { return [1, 2, 3, 4, 5].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `c${n}`, pages: 1 })); },
    async getPageUrls(chId: string) { return [`https://example.invalid/${chId}/p1.png`]; },
    async latest() { return []; },
  };
}

/**
 * Chapter 1 released by two groups, Bad Group's row first, and chapter 2 by Good Group alone. Three rows,
 * two chapter numbers: exactly what a MangaDex listing looks like. Each copy has its own chapter id, which is
 * how `asked` can tell whose copy was fetched.
 */
function groups() {
  return {
    id: GROUPS, name: 'Groups Source',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: GROUPS, title: 'Two Groups' }; },
    async listChapters() {
      return [
        { number: 1, title: 'Chapter 1', sourceId: 'bad-c1', pages: 1, scanlator: 'Bad Group' },
        { number: 1, title: 'Chapter 1', sourceId: 'good-c1', pages: 1, scanlator: 'Good Group' },
        { number: 2, title: 'Chapter 2', sourceId: 'good-c2', pages: 1, scanlator: 'Good Group' },
      ];
    },
    async getPageUrls(chId: string) { asked.push(chId); return [`https://example.invalid/${chId}/p1.png`]; },
    async latest() { return []; },
  };
}

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
  registerAdapter(latest() as any);
  registerAdapter(groups() as any);
});

after(async () => {
  globalThis.fetch = realFetch;
  if (root) rmSync(root, { recursive: true, force: true });
  if (!DSN) return;
  await q(`DELETE FROM lib_series WHERE source_id = ANY($1)`, [[MOODY, NAMELESS, LATEST, GROUPS]]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [USER]).catch(() => {});
  await q(`UPDATE server_settings SET scanlator_prefs = DEFAULT WHERE id = 1`).catch(() => {});
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

/**
 * "Latest N" takes the tail of the list and puts a floor under the series.
 *
 * Reintroduce by dropping the `chapter_floor` UPDATE in addSeriesFromSource: the floor assertion reads null.
 * (Without it the sweep would treat chapters 1..3 as missing and fetch them, oldest first, before anything
 * new -- updater.int.test.ts pins that half.)
 */
test('a "latest 2 of 5" add lands 4 and 5, and floors the series at 4', { skip }, async (t) => {
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  const folder = 'Latest Source/Caught Up';
  const books = async (): Promise<number[]> =>
    (await q(`SELECT b.number FROM lib_books b JOIN lib_series s ON s.id = b.series_id WHERE s.folder = $1 ORDER BY b.number`, [folder]))
      .map((r: any) => Number(r.number));

  await t.test('the add reports two chapters, the newest two', async () => {
    const r = await addSeriesFromSource({ source: LATEST, sourceId: `${LATEST}-1`, chapterCount: 2, chapterFrom: 'newest', wait: true });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.chapters, 2);
  });

  await t.test('once the background loop settles, the library holds exactly [4, 5]', async () => {
    // The first selected chapter is awaited; the second lands in a detached loop that ends with a scan.
    const until = Date.now() + 15_000;
    let have: number[] = [];
    while (Date.now() < until) {
      have = await books();
      if (have.length >= 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(have, [4, 5], 'the OLDEST two -- [1, 2] -- is what "first" gives and what "latest" used to be');
  });

  await t.test('and the listing is written from the chapters the add fetched, without a second source call', async () => {
    // "Who scanlates this" and the ghost rows read series_listing; before this a title opened straight from
    // Discover showed only what was on disk until the sweep reached it. Reintroduce by dropping the
    // replaceListing call after the lib_series UPDATE in addSeriesFromSource: zero rows.
    const rows = await q<{ number: number; source_id: string }>(
      `SELECT l.number, l.source_id FROM series_listing l JOIN lib_series s ON s.id = l.series_id WHERE s.folder = $1 ORDER BY l.number`, [folder]);
    assert.deepEqual(rows.map((r) => Number(r.number)), [1, 2, 3, 4, 5], 'every chapter the source lists, not only the two that landed');
    assert.ok(rows.every((r) => r.source_id === LATEST));
  });

  await t.test('and the row carries the floor the updater will honour', async () => {
    const row = (await q(`SELECT chapter_floor FROM lib_series WHERE folder = $1`, [folder]))[0];
    assert.ok(row, 'the series row exists');
    assert.equal(row.chapter_floor == null ? null : Number(row.chapter_floor), 4,
      'no floor means the next sweep backfills 1..3 before it fetches chapter 6');
  });

  await t.test('deleted and added again as "All", the old floor is gone', async () => {
    // deleteSeries only stamps deleted_at; a re-add undeletes the same row and continues. The floor is
    // written on EVERY add, NULL included, so a series that came back as "everything" is not silently
    // capped at 4 by its earlier life -- with the floor left standing, a download that stopped part-way
    // would leave 1..3 for a sweep that will never fetch below 4.
    //
    // Reintroduce by writing chapter_floor only when chapterFrom is 'newest' (the earlier conditional
    // UPDATE): the row keeps 4 and the `floor cleared` assertion fails.
    const { deleteSeries } = await import('../src/lib/libraryAdmin');
    const id = (await q(`SELECT id FROM lib_series WHERE folder = $1`, [folder]))[0].id;
    await deleteSeries(id);
    const r = await addSeriesFromSource({ source: LATEST, sourceId: `${LATEST}-1`, wait: true });
    assert.equal(r.ok, true, r.message);
    const row = (await q(`SELECT chapter_floor, deleted_at FROM lib_series WHERE folder = $1`, [folder]))[0];
    assert.equal(row.deleted_at, null, 'the row came back');
    assert.equal(row.chapter_floor, null, 'floor cleared');
  });

  globalThis.fetch = realFetch;
});

/**
 * A source that lists chapter 1 twice hands the add ONE copy, and not the blocked group's.
 *
 * Reintroduce by replacing `chooseReleases(chapters, prefs)` in addSeriesFromSource with the raw list
 * (`const chosen = chapters`): `two chapter numbers, not three listed rows` reads 3, and behind it the
 * archive names Bad Group, because the raw list's first row for chapter 1 is Bad Group's.
 *
 * Reintroduce the stamp by removing the `setBookMeta(folder, landed)` call at BOTH download sites in
 * addSeriesFromSource (after the first chapter and after the background loop): the `stamped with the
 * group that released it` assertion reads null for both books. Removing only the background one loses
 * chapter 2's stamp; removing only the first one is covered by the background call, which stamps everything
 * the run landed.
 */
test('an add from a two-group listing takes the unblocked copy, and stamps who released it', { skip }, async (t) => {
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  const folder = 'Groups Source/Two Groups';
  await q(`UPDATE server_settings SET scanlator_prefs = $1 WHERE id = 1`,
    [JSON.stringify({ priority: [], blocked: ['Bad Group'], patienceDays: 2 })]);
  try {
    await t.test('the add counts two chapters and fetches Good Group\'s chapter 1', async () => {
      asked = [];
      const r = await addSeriesFromSource({ source: GROUPS, sourceId: `${GROUPS}-1`, wait: true });
      assert.equal(r.ok, true, r.message);
      assert.equal(r.chapters, 2, 'two chapter numbers, not three listed rows');
      assert.ok(asked.includes('good-c1'), `Good Group's copy was fetched; asked for ${JSON.stringify(asked)}`);
      assert.ok(!asked.includes('bad-c1'), `Bad Group's copy was never fetched; asked for ${JSON.stringify(asked)}`);
    });

    await t.test('the archive names the group in ComicInfo', async () => {
      const AdmZip = (await import('adm-zip')).default;
      const xml = new AdmZip(join(root, folder, 'Chapter 1.cbz')).readAsText('ComicInfo.xml');
      assert.match(xml, /<Translator>Good Group<\/Translator>/, 'the file carries its provenance into any reader');
    });

    await t.test('once the background loop settles, both books are stamped with the group and the adapter', async () => {
      // Chapter 1 is stamped before the add returns; chapter 2 lands in the detached loop that ends with
      // its own scan and stamp. Poll for the second rather than guess a duration.
      const rows = async () => (await q(
        `SELECT b.number, b.scanlator, b.source_id FROM lib_books b JOIN lib_series s ON s.id = b.series_id
          WHERE s.folder = $1 ORDER BY b.number`, [folder]))
        .map((r: any) => ({ number: Number(r.number), scanlator: r.scanlator, source_id: r.source_id }));
      const until = Date.now() + 15_000;
      let have: any[] = [];
      while (Date.now() < until) {
        have = await rows();
        if (have.length >= 2 && have.every((b) => b.scanlator)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.deepEqual(have, [
        { number: 1, scanlator: 'Good Group', source_id: GROUPS },
        { number: 2, scanlator: 'Good Group', source_id: GROUPS },
      ], 'stamped with the group that released it');
    });
  } finally {
    await q(`UPDATE server_settings SET scanlator_prefs = DEFAULT WHERE id = 1`);
    globalThis.fetch = realFetch;
  }
});

/**
 * The route validates its body rather than casting it.
 *
 * Reintroduce by restoring the plain `as { ... }` cast in POST /api/sources/add: 'sideways' is accepted, read
 * as "oldest", and the first assertion below sees 200 instead of 400.
 */
test('POST /api/sources/add refuses a chapterFrom it does not know', { skip }, async (t) => {
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const sourceRoutes = (await import('../src/routes/sources')).default;
  await q('DELETE FROM users WHERE username = $1', [USER]);
  const uid = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms, max_age_rating)
     VALUES ($1,$1,'x','admin','password','{}',NULL) RETURNING id`, [USER]))[0].id;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(sourceRoutes);
  await app.ready();
  const headers = { authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'admin' })}` };
  try {
    await t.test('an unknown direction is a 400, not silently "oldest"', async () => {
      const r = await app.inject({ method: 'POST', url: '/api/sources/add', headers,
        payload: { source: LATEST, sourceId: `${LATEST}-1`, chapterCount: 2, chapterFrom: 'sideways' } });
      assert.equal(r.statusCode, 400, `answered ${r.statusCode}: ${r.body}`);
      assert.equal(r.json().error, 'bad_request');
    });
    await t.test('a known one goes through to the same series, which is already here', async () => {
      const r = await app.inject({ method: 'POST', url: '/api/sources/add', headers,
        payload: { source: LATEST, sourceId: `${LATEST}-1`, chapterCount: 2, chapterFrom: 'newest' } });
      assert.equal(r.statusCode, 200, `answered ${r.statusCode}: ${r.body}`);
      assert.equal(r.json().chapters, 0, 'already in library, so nothing was downloaded twice');
    });
    await t.test('a missing source or sourceId is still the same 400', async () => {
      const r = await app.inject({ method: 'POST', url: '/api/sources/add', headers, payload: { source: LATEST } });
      assert.equal(r.statusCode, 400);
    });
    await t.test('GET /api/sources/detail counts chapter numbers, not listed rows', async () => {
      // The dialog's count has to be what the add will land. Reintroduce by counting `chapters` instead of
      // `chosen` in the detail route: `count` reads 3.
      const r = await app.inject({ method: 'GET', url: `/api/sources/detail?source=${GROUPS}&sourceId=${GROUPS}-1`, headers });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().count, 2, 'three rows list two chapter numbers');
      assert.equal(r.json().last, 2);
    });
  } finally { await app.close(); }
});
