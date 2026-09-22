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
//  6. (v0.34.0) MangaDex describes in Markdown and nothing stripped it, so the dialog, the ComicInfo and
//     the series page all showed `**Year:** 1997 ---` with the asterisks in. Three places clean it now --
//     the detail answer, the add's meta, and the series DTO at read time for rows written before this --
//     and each has its own assertion below, because removing any one of them leaves one surface raw.
//
//  7. (v0.34.0) "Nothing yet": an add that fetches no chapter has no folder for the scanner to find, so
//     the add writes the row itself, with a floor just above the newest listed number so the sweep takes
//     only what is released after it.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
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
const NOTHING = 'add-nothing'; // three chapters, then a fourth appears: the "nothing yet" add
const IDS = 'add-ids';       // three titles on one adapter: what the add answers with (#67)
const HELD = 'add-held';     // three chapters the library already holds under the read-only root (#65)
const USER = 'add-route-user';
const MEMBER = 'add-route-member';
let addSeriesFromSource: any, q: any;
let moodyCalls = 0;
/** What the nothing-yet source lists; the second test appends to it to stand for a new release. */
const nothingList: number[] = [1, 2, 3];
/** Which chapter ids the groups source was asked for pages: who the add actually downloaded from. */
let asked: string[] = [];
/** The same call log for the held source: what an add actually went and fetched, rather than what it counted. */
let heldAsked: string[] = [];

const chapter = (n: number) => ({ number: n, title: `Chapter ${n}`, id: `c${n}`, pages: 1 });
/** A one-pixel PNG, comfortably over the 256-byte floor the downloader uses to skip blocked responses. */
const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const realFetch = globalThis.fetch;

/** The description a MangaDex-shaped source hands over: Markdown, which no surface should show raw. */
const MARKDOWN = '**Bold** and [a link](https://x)\n\n---';

/** Five chapters, one page each. `sourceId` is what the downloader hands back to getPageUrls. */
function latest() {
  return {
    id: LATEST, name: 'Latest Source',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: LATEST, title: 'Caught Up', summary: MARKDOWN }; },
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

/** Lists whatever `nothingList` holds, and can download every one of them. */
function nothing() {
  return {
    id: NOTHING, name: 'Nothing Source',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: NOTHING, title: 'Announced', summary: MARKDOWN, coverUrl: 'https://example.invalid/cover.jpg' }; },
    async listChapters() { return nothingList.map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `n${n}`, pages: 1 })); },
    async getPageUrls(chId: string) { return [`https://example.invalid/${chId}/p1.png`]; },
    async latest() { return []; },
  };
}

/**
 * Three titles on one adapter, for #67: one added with no chapters, one downloaded synchronously, one
 * downloaded in the background (the only branch whose id the add cannot answer with).
 */
const IDS_TITLES: Record<string, string> = { '1': 'Announced Title', '2': 'Fetched Title', '3': 'Carded Title' };
function ids() {
  return {
    id: IDS, name: 'Ids Source',
    async search() { return []; },
    async getSeries(sid: string) { return { sourceId: sid, source: IDS, title: IDS_TITLES[sid.slice(-1)] ?? 'Ids Title' }; },
    async listChapters() { return [1, 2].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `i${n}`, pages: 1 })); },
    async getPageUrls(chId: string) { return [`https://example.invalid/${chId}/p1.png`]; },
    async latest() { return []; },
  };
}

/** The folder of the first case's title; the other cases each have their own (see HELD_TITLES). */
const HELD_FOLDER = 'Held Source/Already Here';
/**
 * A second, READ-ONLY root, as an install that mounts a library it did not download. It is the root the
 * owner's 33,854 invisible chapters live under, and the reason the add's have-set cannot be a path check:
 * nothing under it is below DL_ROOT, and its file names are not `Chapter <n>.cbz`.
 */
const RO_ROOT = '/library-readonly';

/**
 * Three dated chapters, and a call log of which copies were actually asked for pages (#65).
 *
 * One title per case, deliberately. A case that really downloads leaves both a file and a scan behind --
 * and that scan is DETACHED, so it can land on the next case's freshly seeded row and file a chapter
 * nobody asked for there. Separate folders make each case independent of the order they run in.
 */
const HELD_TITLES: Record<string, string> = { '1': 'Already Here', '2': 'Half Here', '3': 'Deleted Files', '4': 'Floored' };
function held() {
  return {
    id: HELD, name: 'Held Source',
    async search() { return []; },
    async getSeries(sid: string) {
      return { sourceId: sid, source: HELD, title: HELD_TITLES[sid.slice(-1)] ?? 'Already Here', coverUrl: 'https://example.invalid/held.jpg' };
    },
    async listChapters() {
      return [1, 2, 3].map((n) => ({
        number: n, title: `Chapter ${n}`, sourceId: `h${n}`, pages: 1,
        publishedAt: new Date(Date.UTC(2024, 0, n)).toISOString(),
      }));
    },
    async getPageUrls(chId: string) { heldAsked.push(chId); return [`https://example.invalid/${chId}/p1.png`]; },
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
  registerAdapter(nothing() as any);
  registerAdapter(ids() as any);
  registerAdapter(held() as any);
});

after(async () => {
  globalThis.fetch = realFetch;
  if (root) rmSync(root, { recursive: true, force: true });
  if (!DSN) return;
  await q(`DELETE FROM lib_series WHERE source_id = ANY($1)`, [[MOODY, NAMELESS, LATEST, GROUPS, NOTHING, IDS, HELD]]).catch(() => {});
  // The held fixture is seeded by hand, so its row can still be unrouted (no source_id) if an add failed.
  await q(`DELETE FROM lib_series WHERE folder LIKE 'Held Source/%'`).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [[USER, MEMBER]]).catch(() => {});
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

  await t.test('and the stored summary is plain text, not the source\'s Markdown', async () => {
    // The row's summary is what the scanner read back from the first chapter's ComicInfo, which the
    // downloader wrote from the add's meta. Reintroduce by passing `series?.summary` raw into `meta` in
    // addSeriesFromSource: the column holds `**Bold** and [a link](https://x)`.
    const row = (await q(`SELECT summary FROM lib_series WHERE folder = $1`, [folder]))[0];
    assert.equal(row.summary, 'Bold and a link', 'the asterisks, the link address and the rule are gone before the file is written');
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
  const catalogRoutes = (await import('../src/routes/catalog')).default;
  await q('DELETE FROM users WHERE username = $1', [USER]);
  const uid = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms, max_age_rating)
     VALUES ($1,$1,'x','admin','password','{}',NULL) RETURNING id`, [USER]))[0].id;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(sourceRoutes);
  await app.register(catalogRoutes);
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
    await t.test('GET /api/sources/detail answers the description as plain text', async () => {
      // Reintroduce by answering `series?.summary || ''` in the detail route: the asterisks are back.
      const r = await app.inject({ method: 'GET', url: `/api/sources/detail?source=${LATEST}&sourceId=${LATEST}-1`, headers });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().summary, 'Bold and a link');
    });
    await t.test('a summary stored with Markdown is answered as plain text', async () => {
      // A row written BEFORE v0.34.0 -- seeded here by SQL, as the scanner used to write it from a raw
      // ComicInfo -- is cleaned on the way out, since no migration rewrites free text. Reintroduce by
      // reading `r.summary ?? ''` in seriesDto (ownedCatalog.ts): `metadata.summary` reads `**x** ---`.
      const id = (await q(`SELECT id FROM lib_series WHERE source_id = $1`, [LATEST]))[0].id;
      await q(`UPDATE lib_series SET summary = '**x** ---' WHERE id = $1`, [id]);
      const r = await app.inject({ method: 'GET', url: `/api/series/${id}`, headers });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().metadata.summary, 'x', 'read-time strip, whatever wrote the column');
      assert.equal(r.json().booksMetadata.summary, 'x');
    });
    await t.test('an overridden summary is stripped like a stored one', async () => {
      // The admin override is copied onto the DTO AFTER seriesDto built it (catalog.ts), so it used to reach
      // the page raw while the stored summary beside it was clean. The editor's own seed (`overrides`) keeps
      // the text as typed. Reintroduce by assigning `ov.summary` straight onto `out.metadata.summary` in
      // catalog.ts: `metadata.summary` reads `**y** ---`.
      const id = (await q(`SELECT id FROM lib_series WHERE source_id = $1`, [LATEST]))[0].id;
      await q(`INSERT INTO series_overrides (series_id, summary) VALUES ($1, '**y** ---') ON CONFLICT (series_id) DO UPDATE SET summary = EXCLUDED.summary`, [id]);
      try {
        const r = await app.inject({ method: 'GET', url: `/api/series/${id}`, headers });
        assert.equal(r.statusCode, 200, r.body);
        assert.equal(r.json().metadata.summary, 'y', 'the override goes through the same strip');
        assert.equal(r.json().booksMetadata.summary, 'y');
        assert.equal(r.json().overrides.summary, '**y** ---', 'the editor still seeds from the text as typed');
      } finally { await q(`DELETE FROM series_overrides WHERE series_id = $1`, [id]); }
    });
  } finally { await app.close(); }
});

/**
 * "Nothing yet" (#40 b): the series is added, followed and floored, and no chapter is fetched.
 *
 * Reintroduce by routing `'none'` through the normal path (delete the `if (chapterFrom === 'none')` block
 * in addSeriesFromSource): there is no chapter to download, so the answer is a 422 and "no lib_series row
 * exists" fails -- findSeriesDirs only registers a folder that directly holds chapters, so persistScan would
 * never have created the row. Reintroduce the floor by writing `Math.max(...)` without the `+ 0.001`: the
 * newest listed number is at the floor, not below it, and the listing reads it as `missing` rather than
 * `floor` -- and the next sweep would fetch it. Reintroduce the check stamp by dropping
 * `source_checked_at, source_chapters, source_missing` (and their values) from the INSERT: "is stamped as
 * checked" sees `checkedAt` null and the series page reads `not checked yet` above the run row that lists
 * the chapters this very add found.
 */
test('a nothing-yet add creates the series with no chapters, a listing and a floor above the newest listed number', { skip }, async (t) => {
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const sourceRoutes = (await import('../src/routes/sources')).default;
  const catalogRoutes = (await import('../src/routes/catalog')).default;
  const adminRoutes = (await import('../src/routes/admin')).default;
  const { libraryIdFor } = await import('../src/lib/library');
  const folder = 'Nothing Source/Announced';
  await q('DELETE FROM users WHERE username = $1', [USER]);
  const uid = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms, max_age_rating)
     VALUES ($1,$1,'x','admin','password','{}',NULL) RETURNING id`, [USER]))[0].id;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(sourceRoutes);
  await app.register(catalogRoutes);
  await app.register(adminRoutes);
  await app.ready();
  const headers = { authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'admin' })}` };
  const row = async () => (await q(`SELECT id, books_count, chapter_floor, library_id, summary, source_id, source_series_id, auto_update, source, source_checked_at, source_chapters, source_missing FROM lib_series WHERE folder = $1`, [folder]))[0];
  let id = '';
  try {
    await t.test('answers 200 with chapters 0, started false and nothing true', async () => {
      const r = await app.inject({ method: 'POST', url: '/api/sources/add', headers,
        payload: { source: NOTHING, sourceId: `${NOTHING}-1`, chapterFrom: 'none', chapterCount: 2 } });
      assert.equal(r.statusCode, 200, `answered ${r.statusCode}: ${r.body}`);
      assert.deepEqual([r.json().chapters, r.json().started, r.json().nothing], [0, false, true], r.body);
      assert.equal(r.json().folder, folder);
    });

    await t.test('the lib_series row exists, with no books and a floor just above the newest listed number', async () => {
      const s = await row();
      assert.ok(s, 'no lib_series row exists: the scanner cannot create one for a folder with no chapters');
      id = s.id;
      assert.equal(Number(s.books_count), 0);
      assert.equal(Number(s.chapter_floor), 3.001, 'above 3 so 3 is below the floor, and below 3.5 so the next release is not');
      assert.deepEqual([s.source_id, s.source_series_id, s.auto_update, s.source], [NOTHING, `${NOTHING}-1`, true, 'Nothing Source'], 'routed for the sweep, as a normal add stamps it');
      assert.equal(s.summary, 'Bold and a link', 'the description is stored clean');
      const libs = await q('SELECT id, path FROM libraries ORDER BY length(path) DESC');
      assert.equal(s.library_id, libraryIdFor(folder, libs), 'the library persistScan would pick, so its ON CONFLICT lands on this row');
    });

    await t.test('nothing was fetched, queued or created on disk', async () => {
      assert.equal(existsSync(join(root, folder)), false, 'the downloader\'s mkdir creates the folder with the first chapter, not the add');
      const jobs = (await app.inject({ method: 'GET', url: '/api/sources/jobs', headers })).json().content;
      assert.ok(!jobs.some((j: any) => j.folder === folder), `no job: ${JSON.stringify(jobs)}`);
      assert.equal((await q('SELECT count(*)::int AS n FROM lib_books WHERE series_id = $1', [id]))[0].n, 0);
    });

    await t.test('the listing holds every listed number, and every one is below the floor', async () => {
      const stored = await q('SELECT number FROM series_listing WHERE series_id = $1 ORDER BY number', [id]);
      assert.deepEqual(stored.map((r: any) => Number(r.number)), [1, 2, 3], 'written from the chapters the add already had in hand');
      const r = await app.inject({ method: 'GET', url: `/api/series/${id}/listing`, headers });
      assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual(r.json().content.map((g: any) => [g.number, g.why]), [[1, 'floor'], [2, 'floor'], [3, 'floor']],
        'the run the series page folds into one row, with Fetch all; none is "missing"');
      assert.ok(r.json().checkedAt, `the listing is as of a check that happened: ${r.body}`);
    });

    await t.test('the row is stamped as checked, since the add just asked the source', async () => {
      const s = await row();
      assert.ok(s.source_checked_at, 'source_checked_at is set: the sweep\'s stamp, written by the add');
      assert.equal(Number(s.source_chapters), 3, 'one per listed number, as stampChecked counts them');
      assert.equal(Number(s.source_missing), 0, 'every listed number is below the floor, so none is wanted');
    });

    await t.test('the series reads as a normal series with zero chapters and its source', async () => {
      const r = await app.inject({ method: 'GET', url: `/api/series/${id}`, headers });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().booksCount, 0);
      assert.equal(r.json().metadata.summary, 'Bold and a link');
      assert.equal(r.json().sources?.[0]?.sourceId, NOTHING, JSON.stringify(r.json().sources));
      assert.equal(r.json().sources[0].primary, true);
      // What the supply line reads: with `checkedAt` null it says `not checked yet`, which contradicts the
      // run row beneath it; with it set and 0 books it says `3 chapters listed · none fetched yet`.
      assert.ok(r.json().sources[0].checkedAt && Date.now() - Date.parse(r.json().sources[0].checkedAt) < 60_000,
        `checkedAt is the add's own stamp: ${JSON.stringify(r.json().sources[0])}`);
      assert.equal(r.json().sources[0].chapters, 3, 'and the count the sheet\'s source row shows');
      const art = (await q('SELECT cover FROM series_art WHERE series_id = $1', [id]))[0];
      assert.equal(art?.cover, 'https://example.invalid/cover.jpg', 'the source cover is kept, as on every add');
    });

    await t.test('adding it again is "already in library", as for any series', async () => {
      const r = await app.inject({ method: 'POST', url: '/api/sources/add', headers,
        payload: { source: NOTHING, sourceId: `${NOTHING}-1`, chapterFrom: 'none' } });
      assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual([r.json().chapters, r.json().nothing], [0, false]);
      assert.equal((await q('SELECT count(*)::int AS n FROM lib_series WHERE folder = $1', [folder]))[0].n, 1, 'one row');
    });

    await t.test('a nothing-yet add of a series removed from the library revives the row', async () => {
      // The `existing` check un-deletes the row BEFORE the branch runs, so the folder already has a live
      // row when the INSERT fires. Reintroduce by dropping the `ON CONFLICT (library_id, folder) DO UPDATE
      // …` clause from the `none` INSERT (keep `RETURNING id`): the add answers 500 with Postgres's 23505
      // on `lib_series_library_folder_idx`, AFTER the un-delete has already put the series back -- the
      // dialog read "Add failed. Try another source." for a series that was in the library again, and the
      // next tap read "already in library". (`deleted_at = NULL` in the DO UPDATE list is NOT what this
      // test measures: the check above has already cleared it by the time the upsert runs, so dropping it
      // from the list fails nothing here -- it is in the list so the branch stays right on its own should
      // that check ever stop un-deleting first.)
      await q(`UPDATE lib_series SET chapter_floor = NULL, source_checked_at = NULL WHERE id = $1`, [id]);
      const del = await app.inject({ method: 'DELETE', url: `/api/admin/series/${id}`, headers });
      assert.equal(del.statusCode, 200, `PREMISE: the series is hidden: ${del.body}`);
      assert.ok((await q('SELECT deleted_at FROM lib_series WHERE id = $1', [id]))[0].deleted_at, 'PREMISE: deleted_at is stamped');
      const r = await app.inject({ method: 'POST', url: '/api/sources/add', headers,
        payload: { source: NOTHING, sourceId: `${NOTHING}-1`, chapterFrom: 'none' } });
      assert.equal(r.statusCode, 200, `answered ${r.statusCode}: ${r.body}`);
      assert.deepEqual([r.json().chapters, r.json().started, r.json().nothing], [0, false, true], 'a fresh nothing-yet add, not "already in library"');
      const rows = await q('SELECT id, deleted_at, chapter_floor, source_checked_at FROM lib_series WHERE folder = $1', [folder]);
      assert.equal(rows.length, 1, 'one row: the conflict landed on the old one rather than minting a second');
      assert.equal(rows[0].id, id, 'the same id, so every favourite, note and read mark hung on it survives');
      assert.equal(rows[0].deleted_at, null, 'deleted_at is null');
      assert.equal(Number(rows[0].chapter_floor), 3.001, 'and its routing is refreshed in place: the floor is written again');
      assert.ok(rows[0].source_checked_at, 'as is the check stamp');
    });

    /**
     * Reintroduce by dropping `chapter_floor` from the INSERT (pass null): the sweep's oldest-missing-first
     * loop takes chapter 1, 2 and 3 as well, and "exactly the newer release" reads [1, 2, 3, 4]. "The row
     * keeps its id" pins the other half: the first chapter's folder is scanned in onto THIS row through
     * persistScan's `ON CONFLICT (library_id, folder)`, not minted as a second series.
     */
    await t.test('the next sweep takes only a newer release', async () => {
      const { updateSeries } = await import('../src/lib/updater');
      const { persistScan } = await import('../src/lib/library');
      nothingList.push(4);
      const r = await updateSeries(id, 10);
      assert.equal(r.outcome, 'ok', JSON.stringify(r));
      assert.equal(r.added, 1, `exactly the newer release: ${JSON.stringify(r.landed)}`);
      assert.deepEqual(r.landed.map((l: any) => l.number), [4]);
      await persistScan();
      const books = (await q('SELECT number FROM lib_books WHERE series_id = $1 ORDER BY number', [id])).map((b: any) => Number(b.number));
      assert.deepEqual(books, [4], 'exactly the newer release');
      const s = await row();
      assert.equal(s.id, id, 'the row keeps its id: the scan found it by folder and updated it in place');
      assert.equal(Number(s.books_count), 1);
      assert.equal((await q('SELECT count(*)::int AS n FROM lib_series WHERE folder = $1', [folder]))[0].n, 1, 'and no second row was minted');
      const l = await app.inject({ method: 'GET', url: `/api/series/${id}/listing`, headers });
      assert.deepEqual(l.json().content.map((g: any) => [g.number, g.why]), [[1, 'floor'], [2, 'floor'], [3, 'floor']], '4 is here now; the older three stay below the floor');
    });
  } finally {
    await app.close();
    globalThis.fetch = realFetch;
  }
});

/**
 * Seed the series as the SCANNER would have written it from a read-only library root, and then remove it
 * from the library the way the Remove button does.
 *
 * Two details carry the whole of #65. The book rows sit under a second root, under names the
 * `<DL_ROOT>/<folder>/Chapter <n>.cbz` check in lib/downloader.ts could never match on either root -- 53%
 * of the owner's read-library chapters are named like this. And `deleteSeries` stamps `deleted_at` on the
 * series alone: every `lib_books` row stays exactly where it was, which is what makes "remove it and add
 * it again" -- the app's own advice when a series looks wrong -- a full re-download.
 *
 * The download root is cleared too, so each case starts from "the files are only on the read-only root"
 * rather than inheriting a copy the previous case downloaded (which the path check would then skip, and
 * the case would pass for the wrong reason).
 */
/** The library id of a folder, which is what every assertion about #67 compares the answer against. */
const idOfFolder = async (folder: string): Promise<string> =>
  (await q('SELECT id FROM lib_series WHERE folder = $1', [folder]))[0]?.id;

async function seedHeldLibrary(which: string, numbers: number[]): Promise<string> {
  const { libraryIdFor } = await import('../src/lib/library');
  const title = HELD_TITLES[which];
  const folder = `Held Source/${title}`;
  await q('DELETE FROM lib_series WHERE folder = $1', [folder]);
  rmSync(join(root, folder), { recursive: true, force: true });
  const libs = await q('SELECT id, path FROM libraries ORDER BY length(path) DESC');
  const id = `s_held_${which}`;
  await q(
    `INSERT INTO lib_series (id, source, title, folder, books_count, library_id)
     VALUES ($1, 'Held Source', $2, $3, $4, $5)`,
    [id, title, folder, numbers.length, libraryIdFor(folder, libs)],
  );
  for (const n of numbers) {
    await q(
      `INSERT INTO lib_books (id, series_id, source, root, file, number, pages)
       VALUES ($1, $2, 'Held Source', $3, $4, $5, 1)`,
      [`b_held_${which}_${n}`, id, RO_ROOT, `${folder}/Official_Chapter ${n}.cbz`, n],
    );
  }
  await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [id]);
  return id;
}

/**
 * #65: an add never fetches a chapter the library already holds -- on EITHER root, under ANY file name.
 *
 * The have-set is read from `lib_books` by folder in addSeriesFromSource. Reintroduce by deleting the
 * `toFetch` filter there (`const toFetch = selected;`): "the source was never asked for a single page"
 * reads three chapter ids, and "the answer says every chapter was already here" reads 3 fetched.
 * Reintroduce the `pruned_at IS NULL` half by swapping it for `heldBooks()`: "a Delete-files tombstone is
 * fetched again" asks for nothing. Reintroduce the empty branch by deleting it: the add answers 422
 * `undownloadable` for a series we hold in full, and every stamp assertion below fails with it.
 *
 * Every assertion about what was FETCHED reads the adapter's own call log, never the job counter: a
 * counter is what the bug reported correctly while downloading everything anyway.
 */
test('an add never re-downloads what the library already holds', { skip }, async (t) => {
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  const numbers = async (id: string): Promise<number[]> =>
    (await q('SELECT number FROM lib_books WHERE series_id = $1 ORDER BY number', [id])).map((r: any) => Number(r.number));
  try {
    let id = '';
    await t.test('a series held only under the read-only root is not fetched again', async () => {
      id = await seedHeldLibrary('1', [1, 2, 3]);
      heldAsked = [];
      const r = await addSeriesFromSource({ source: HELD, sourceId: `${HELD}-1`, wait: true });
      assert.equal(r.ok, true, r.message);
      assert.deepEqual(heldAsked, [], 'the source was never asked for a single page');
      assert.equal(r.chapters, 0, 'nothing is being fetched');
      assert.equal(r.alreadyHere, 3, 'the answer says every chapter was already here');
      assert.equal(r.started, false, 'and no download was started to say otherwise');
      assert.equal(r.seriesId, id, 'the answer names the row it revived (#67)');
    });

    await t.test('and the revived row still gets its routing, floor, listing, dates and art', async () => {
      // Everything an add owes the series is written inside the download run, AFTER chapter one lands.
      // With nothing to fetch there is no chapter one, so the branch has to write them itself -- or a
      // re-added series is left unrouted (the sweep would never check it again), with no listing and no
      // cover, which is worse than the double download it replaced.
      const s = (await q(
        'SELECT deleted_at, source_id, source_series_id, auto_update, chapter_floor FROM lib_series WHERE id = $1', [id]))[0];
      assert.equal(s.deleted_at, null, 'the row came back');
      assert.deepEqual([s.source_id, s.source_series_id, s.auto_update], [HELD, `${HELD}-1`, true], 'routed for the sweep');
      assert.equal(s.chapter_floor, null, 'an "all" add floors nothing');
      const listing = await q('SELECT number FROM series_listing WHERE series_id = $1 ORDER BY number', [id]);
      assert.deepEqual(listing.map((r: any) => Number(r.number)), [1, 2, 3], 'the listing the series page reads');
      const dates = await q('SELECT number, published_at FROM lib_books WHERE series_id = $1 ORDER BY number', [id]);
      assert.ok(dates.every((b: any) => b.published_at), `release dates stamped on the chapters we hold: ${JSON.stringify(dates)}`);
      const art = (await q('SELECT cover FROM series_art WHERE series_id = $1', [id]))[0];
      assert.equal(art?.cover, 'https://example.invalid/held.jpg', 'the source cover, as on every other add');
    });

    await t.test('and nothing was written under the download root', async () => {
      assert.equal(existsSync(join(root, HELD_FOLDER)), false, 'the downloader never ran, so it never made the folder');
      assert.deepEqual(await numbers(id), [1, 2, 3], 'three chapters, not six: no second copy was filed beside the first');
    });

    await t.test('a partial re-add fetches exactly the complement', async () => {
      id = await seedHeldLibrary('2', [1, 3]);
      heldAsked = [];
      const r = await addSeriesFromSource({ source: HELD, sourceId: `${HELD}-2`, wait: true });
      assert.equal(r.ok, true, r.message);
      assert.deepEqual(heldAsked, ['h2'], 'only the missing number was asked for');
      assert.equal(r.chapters, 1, 'the count is what will be fetched, so the bar can reach it');
      assert.equal(r.alreadyHere, undefined, 'a partial re-add is an ordinary download, not the "all here" answer');
      // Wait for the run's own scan to file what it fetched. Two reasons: "one row per number, not two"
      // is the other half of #65 (the duplicate listing is what needed hand repair), and the scan is
      // detached -- left running, it lands in the middle of the next case's seed and files a chapter 2
      // there that nothing asked for.
      const until = Date.now() + 15_000;
      let rows: any[] = [];
      while (Date.now() < until) {
        rows = await q('SELECT root, number FROM lib_books WHERE series_id = $1 ORDER BY number', [id]);
        if (rows.length >= 3) break;
        await new Promise((res) => setTimeout(res, 100));
      }
      assert.deepEqual(rows.map((b: any) => Number(b.number)), [1, 2, 3], 'the fetched chapter is filed once, beside the two already held');
      assert.equal(rows.filter((b: any) => b.root !== RO_ROOT).length, 1, 'and only the new one is under the download root');
    });

    await t.test('a Delete-files tombstone is fetched again', async () => {
      // ⚠️ The one place the add deliberately disagrees with the sweep. heldBooks() counts a Delete-files
      // tombstone as HELD so the nightly sweep does not undo a deliberate deletion; an add is a person
      // asking for that chapter NOW. Reintroduce by using heldBooks() for the have-set: nothing is asked
      // for, and "Delete files" becomes a decision that can never be taken back from the add dialog.
      id = await seedHeldLibrary('3', [1, 2, 3]);
      const { tombstoneBooks } = await import('../src/lib/chapterCleanup');
      await tombstoneBooks(['b_held_3_2'], 'deleted');
      heldAsked = [];
      const r = await addSeriesFromSource({ source: HELD, sourceId: `${HELD}-3`, wait: true });
      assert.equal(r.ok, true, r.message);
      assert.deepEqual(heldAsked, ['h2'], 'the chapter whose file was deleted on purpose is fetched again');
      assert.equal(r.chapters, 1);
    });

    await t.test('the chapter floor still records what was asked for, not what was fetched', async () => {
      // Reintroduce by computing the floor from `toFetch`: it is empty here, `Math.min()` of nothing is
      // Infinity, and the series is floored above every chapter that will ever be released.
      id = await seedHeldLibrary('4', [2, 3]);
      heldAsked = [];
      const r = await addSeriesFromSource({ source: HELD, sourceId: `${HELD}-4`, chapterCount: 2, chapterFrom: 'newest', wait: true });
      assert.equal(r.alreadyHere, 2, 'both of the newest two are already here');
      assert.deepEqual(heldAsked, []);
      const s = (await q('SELECT chapter_floor FROM lib_series WHERE id = $1', [id]))[0];
      assert.equal(Number(s.chapter_floor), 2, 'the lowest chapter ASKED for; chapter 1 stays below the floor');
    });

    await t.test('a refetch still replaces a chapter the library holds', async () => {
      // The have-set belongs to the add path alone. The downloader keeps its own cheap DL_ROOT path check,
      // and `replace` bypasses it -- which is what the admin refetch and the completion pass in
      // lib/partial.ts rely on (chapterActions.int.test.ts, "refetch replaces the file with the copy the
      // rules choose now, on the same row", pins the route half). Reintroduce by moving the have-set into
      // downloadChapter, or by dropping the `!opts.replace` guard: the second call here asks for nothing.
      const { downloadChapter } = await import('../src/lib/downloader');
      const chapter = { number: 2, title: 'Chapter 2', sourceId: 'h2', pages: 1 };
      const input = { sourceId: HELD, seriesFolder: HELD_FOLDER, chapter, meta: { series: 'Already Here' } };
      await downloadChapter(input as any);
      assert.ok(existsSync(join(root, HELD_FOLDER, 'Chapter 2.cbz')), 'PREMISE: the file is on the download root');
      heldAsked = [];
      assert.equal(await downloadChapter(input as any), null, 'PREMISE: a plain download skips a file already there');
      assert.deepEqual(heldAsked, [], 'PREMISE: and does not ask the source');
      const out = await downloadChapter(input as any, { replace: true });
      assert.ok(out, 'a refetch writes the file again');
      assert.deepEqual(heldAsked, ['h2'], 'and asks the source for it, have-set or no have-set');
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

/**
 * #67: every add answers with the id of the series it landed on, and the one branch that cannot know it
 * puts it on the job card instead.
 *
 * Before this the dialog's "Open in library" re-found the series by title search and fell back to
 * `p.content[0]` -- a confident wrong navigation, and two series on the owner's install normalise to the
 * same title. Reintroduce by dropping `seriesId` from any one of the returns in addSeriesFromSource: the
 * matching assertion below reads undefined.
 */
test('every add answers with the series id it created or revived', { skip }, async (t) => {
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  const idOf = idOfFolder;
  const ANNOUNCED = 'Ids Source/Announced Title';
  const FETCHED = 'Ids Source/Fetched Title';
  try {
    let announced = '';
    await t.test('a nothing-yet add answers with the id it minted', async () => {
      const r = await addSeriesFromSource({ source: IDS, sourceId: `${IDS}-1`, chapterFrom: 'none', wait: true });
      assert.equal(r.ok, true, r.message);
      announced = await idOf(ANNOUNCED);
      assert.equal(r.seriesId, announced, 'the id the INSERT returned, not something the client has to guess');
    });

    await t.test('adding it again answers with the same id', async () => {
      const r = await addSeriesFromSource({ source: IDS, sourceId: `${IDS}-1`, chapterFrom: 'none', wait: true });
      assert.equal(r.message, 'already in library', 'PREMISE: this is the already-present branch');
      assert.equal(r.seriesId, announced);
    });

    await t.test('a series removed and added again answers with the id it revived', async () => {
      const { deleteSeries } = await import('../src/lib/libraryAdmin');
      await deleteSeries(announced);
      const r = await addSeriesFromSource({ source: IDS, sourceId: `${IDS}-1`, chapterFrom: 'none', wait: true });
      assert.equal(r.ok, true, r.message);
      assert.equal(r.seriesId, announced, 'the same row, so every favourite and read mark hung on it is still there');
      assert.equal(await idOf(ANNOUNCED), announced, 'and no second row was minted');
    });

    await t.test('an awaited download add answers with the id its scan created', async () => {
      const r = await addSeriesFromSource({ source: IDS, sourceId: `${IDS}-2`, wait: true });
      assert.equal(r.ok, true, r.message);
      assert.equal(r.seriesId, await idOf(FETCHED), 'persistScan has run by the time an awaited add returns');
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

/**
 * The route's half of #67: it forwards the id, and it withholds one the caller may not use.
 *
 * Reintroduce the gate by forwarding `r.seriesId` unconditionally: "a member who cannot see the series is
 * not given its id" reads the id. Reintroduce the 409's half by dropping `existing.id` from the duplicate
 * body: "the duplicate answer carries the id of the copy it found" reads undefined and the dialog's
 * "Open it" button can never appear.
 */
test('POST /api/sources/add forwards the series id, and only to someone who may see it', { skip }, async (t) => {
  globalThis.fetch = (async () => new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const sourceRoutes = (await import('../src/routes/sources')).default;
  const CARDED = 'Ids Source/Carded Title';
  const ANNOUNCED = 'Ids Source/Announced Title';
  const OTHER_LIB = 'add-lib-other';
  await q('DELETE FROM users WHERE username = ANY($1)', [[USER, MEMBER]]);
  const uid = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms, max_age_rating)
     VALUES ($1,$1,'x','admin','password','{}',NULL) RETURNING id`, [USER]))[0].id;
  const mid = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms, max_age_rating)
     VALUES ($1,$1,'x','member','password','{}',NULL) RETURNING id`, [MEMBER]))[0].id;
  // The member is granted ONE library, and it is not the one the series is in: `visible()` then answers
  // no for it, which is what the route asks `seriesVisible` for.
  await q('DELETE FROM libraries WHERE id = $1', [OTHER_LIB]);
  await q(`INSERT INTO libraries (id, name, path, age_rating) VALUES ($1,'Elsewhere','/elsewhere',NULL)`, [OTHER_LIB]);
  await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1,$2)', [mid, OTHER_LIB]);
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(sourceRoutes);
  await app.ready();
  const headers = { authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'admin' })}` };
  const asMember = { authorization: `Bearer ${app.jwt.sign({ sub: mid, role: 'member' })}` };
  try {
    await t.test('an already-in-library add answers with the id', async () => {
      const r = await app.inject({ method: 'POST', url: '/api/sources/add', headers,
        payload: { source: IDS, sourceId: `${IDS}-1`, chapterFrom: 'none' } });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().seriesId, await idOfFolder(ANNOUNCED), r.body);
    });

    await t.test('a member who cannot see the series is not given its id', async () => {
      // The id is a capability: every by-id route checks the viewer, and this route is where the viewer
      // lives. The rest of the answer is unchanged -- the add itself is theirs to make.
      const r = await app.inject({ method: 'POST', url: '/api/sources/add', headers: asMember,
        payload: { source: IDS, sourceId: `${IDS}-1`, chapterFrom: 'none' } });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().seriesId, undefined, `the id of a series in a library they were not granted: ${r.body}`);
      assert.equal(r.json().chapters, 0, 'and the rest of the answer is what it always was');
    });

    await t.test('the duplicate answer carries the id of the copy it found', async () => {
      // A second source offering a title that normalises onto one already here. The lookup behind it is
      // deliberately server-wide, so the id -- and only the id -- is gated the same way as above.
      const { registerAdapter } = await import('../src/lib/sources');
      registerAdapter({
        id: 'add-dup', name: 'Dup Source',
        async search() { return []; },
        async getSeries(sid: string) { return { sourceId: sid, source: 'add-dup', title: 'Announced Title' }; },
        async listChapters() { return [{ number: 1, title: 'Chapter 1', sourceId: 'd1', pages: 1 }]; },
        async getPageUrls() { return ['https://example.invalid/d1/p1.png']; },
        async latest() { return []; },
      } as any);
      const r = await app.inject({ method: 'POST', url: '/api/sources/add', headers,
        payload: { source: 'add-dup', sourceId: 'add-dup-1' } });
      assert.equal(r.statusCode, 409, r.body);
      assert.equal(r.json().error, 'duplicate');
      assert.equal(r.json().existing?.id, await idOfFolder(ANNOUNCED), r.body);
      assert.equal(r.json().existing?.title, 'Announced Title', 'the wording the prompt is built from is unchanged');
      const m = await app.inject({ method: 'POST', url: '/api/sources/add', headers: asMember,
        payload: { source: 'add-dup', sourceId: 'add-dup-1' } });
      assert.equal(m.statusCode, 409, m.body);
      assert.equal(m.json().existing?.id, undefined, `a member is told it is a duplicate, not where it is: ${m.body}`);
      assert.equal(m.json().existing?.title, 'Announced Title');
    });

    await t.test('a download add puts the series id on its job card once chapter one is scanned', async () => {
      // The only branch that cannot answer with the id: the reply goes out before persistScan has minted
      // the row. Reintroduce by dropping the `card.seriesId = seriesId` line after the scan in
      // addSeriesFromSource: the card never carries an id and the dialog is back to guessing by title.
      const r = await app.inject({ method: 'POST', url: '/api/sources/add', headers,
        payload: { source: IDS, sourceId: `${IDS}-3` } });
      assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual([r.json().started, r.json().seriesId], [true, undefined], `no row exists yet: ${r.body}`);
      const until = Date.now() + 15_000;
      let card: any;
      while (Date.now() < until) {
        const jobs = (await app.inject({ method: 'GET', url: '/api/sources/jobs', headers })).json().content;
        card = jobs.find((j: any) => j.folder === CARDED);
        if (card?.seriesId) break;
        await new Promise((res) => setTimeout(res, 100));
      }
      assert.equal(card?.seriesId, await idOfFolder(CARDED), `the card the dialog is already polling: ${JSON.stringify(card)}`);
    });
  } finally {
    await app.close();
    await q('DELETE FROM user_libraries WHERE library_id = $1', [OTHER_LIB]).catch(() => {});
    await q('DELETE FROM libraries WHERE id = $1', [OTHER_LIB]).catch(() => {});
    globalThis.fetch = realFetch;
  }
});
