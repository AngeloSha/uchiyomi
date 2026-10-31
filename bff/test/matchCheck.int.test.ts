// The recheck of the online matches stored by title before v0.55.7 checked them (#168, lib/matchCheck.ts): every
// automatic AniList link, and every cover and banner served from AniList's or MangaDex's servers, held to the title
// check (lib/onlineMatch.ts) against what AniList and MangaDex call those entries -- what it removes, what it never
// touches, how it resumes, and how it reaches Admin → Tasks.
//
// AniList and MangaDex are fakes at globalThis.fetch that answer by id, as the real ones do, and count what they were
// asked -- and AniList a title search, for a link named only by a synonym (v0.103.1): nothing here reaches the network.
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const cover = (id: number) => `https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/bx${id}-mc.jpg`;
const banner = (id: number, type = 'manga') => `https://s4.anilist.co/file/anilistcdn/media/${type}/banner/${id}-mc.jpg`;
const UUID_OTHER = '33333333-3333-4333-8333-333333333333';
const UUID_OWN = '44444444-4444-4444-8444-444444444444';
const mdCover = (uuid: string) => `https://uploads.mangadex.org/covers/${uuid}/c.jpg`;

/** AniList's entries, by id: what each is called, and what it is related to. 599 is an entry AniList no longer has. */
const ENTRIES: Record<number, { type: 'MANGA' | 'ANIME'; title: Record<string, string | null>; synonyms?: string[]; related?: Array<{ id: number; type: string }> }> = {
  501: { type: 'MANGA', title: { romaji: 'Sasaki to Miyano', english: 'Sasaki and Miyano' } },
  502: { type: 'MANGA', title: { romaji: 'Seoul-yeok Druid', english: 'The Druid of Seoul Station' }, synonyms: ['Zzz Mc Seoul Station Druid'] },
  503: { type: 'MANGA', title: { romaji: 'Zzz Mc Alt Name', english: null } },
  504: { type: 'MANGA', title: { romaji: null, english: 'Zzz Mc Edition' } },
  505: { type: 'MANGA', title: { romaji: 'Somebody Else Entirely' } },
  506: { type: 'MANGA', title: { romaji: 'Yet Another Work' } },
  507: { type: 'MANGA', title: { romaji: 'Zzz Mc Private' } },
  701: { type: 'ANIME', title: { romaji: 'Zzz Mc Anime Banner: The Movie' }, related: [{ id: 702, type: 'MANGA' }] },
  702: { type: 'MANGA', title: { english: 'Zzz Mc Anime Banner' } },
  703: { type: 'ANIME', title: { romaji: 'Other Anime' }, related: [{ id: 704, type: 'MANGA' }] },
  704: { type: 'MANGA', title: { romaji: 'Other Manga' } },
  // v0.103.1, the live case: an anthology one of whose stories bears the series' name, with an anime of its own; and the
  // manhwa whose own title the name is.
  591: { type: 'MANGA', title: { romaji: 'Zzz Mc Gekka Bijin', native: 'ゲッカビジン' }, synonyms: ['Zzz Mc Yaei', 'Zzz Mc Pick Me Up', 'Zzz Mc A Queen'],
    related: [{ id: 791, type: 'ANIME' }] },
  592: { type: 'MANGA', title: { romaji: 'Zzz Mc Pick Me Up!', english: 'Zzz Mc Pick Me Up' } },
};
/** AniList's answers to a title search (lib/anilist.ts OWN_TITLE), by the title asked: the anthology first, as AniList answers. */
const SEARCH: Record<string, Array<{ id: number; country: string }>> = {
  'Zzz Mc Pick Me Up': [{ id: 591, country: 'JP' }, { id: 592, country: 'KR' }],
};

const S = {
  wrong: 's_mc_wrong', druid: 's_mc_druid', alt: 's_mc_alt', edEs: 's_mc_ed_es', edEn: 's_mc_ed_en', human: 's_mc_human',
  gone: 's_mc_gone', anime: 's_mc_anime', wrongAnime: 's_mc_wrong_anime', md: 's_mc_md', ownMd: 's_mc_own_md', src: 's_mc_src',
  later: 's_mc_later', private: 's_mc_private', pick: 's_mc_pick', pickSrc: 's_mc_pick_src', pickHuman: 's_mc_pick_human', pickLate: 's_mc_pick_late', pickRace: 's_mc_pick_race',
};
const TITLE: Record<string, string> = {
  wrong: 'Zzz Mc Morgan Lost', druid: 'Zzz Mc Seoul Station Druid', alt: 'Zzz Mc Scanned Name', edEs: 'Zzz Mc Edicion', edEn: 'Zzz Mc Edition',
  human: 'Zzz Mc Human', gone: 'Zzz Mc Gone Entry', anime: 'Zzz Mc Anime Banner', wrongAnime: 'Zzz Mc Wrong Anime', md: 'Zzz Mc MangaDex Cover',
  ownMd: 'Zzz Mc Own MangaDex', src: 'Zzz Mc Source Cover', later: 'Zzz Mc Later', private: 'Zzz Mc Private',
  pick: 'Zzz Mc Pick Me Up', pickSrc: 'Zzz Mc Pick Me Up', pickHuman: 'Zzz Mc Pick Me Up', pickLate: 'Zzz Mc Pick Me Up', pickRace: 'Zzz Mc Pick Me Up',
};
const USER = 'mc-reader';

let q: any, pool: any, app: any, adminAuth: Record<string, string> = {}, userId = '';
const realFetch = globalThis.fetch;
/** Every id AniList was asked about, request by request; and MangaDex's. */
const alAsked: number[][] = [];
const mdAsked: string[][] = [];
/** Every title AniList was searched by (v0.103.1). */
const alSearched: string[] = [];
let aniListDown = false;
let searchDown = false;

function fakeNetwork() {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input?.url ?? input));
    if (url.host === 'graphql.anilist.co') {
      if (aniListDown) return new Response('{}', { status: 500 });
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (typeof body?.variables?.s === 'string') {
        if (searchDown) return new Response('{}', { status: 500 });
        alSearched.push(body.variables.s);
        const media = (SEARCH[body.variables.s] ?? []).map(({ id, country }) => ({
          id, title: { romaji: null, english: null, native: null, ...ENTRIES[id].title }, synonyms: ENTRIES[id].synonyms ?? [],
          countryOfOrigin: country, coverImage: { extraLarge: cover(id) }, bannerImage: banner(id), relations: { edges: [] } }));
        return Response.json({ data: { Page: { media } } });
      }
      const ids: number[] = body?.variables?.ids ?? [];
      alAsked.push(ids);
      const media = ids.filter((id) => ENTRIES[id]).map((id) => {
        const e = ENTRIES[id];
        return { id, type: e.type, title: { romaji: null, english: null, native: null, ...e.title }, synonyms: e.synonyms ?? [],
          relations: { edges: (e.related ?? []).map((r) => ({ node: r })) } };
      });
      return Response.json({ data: { Page: { media } } });
    }
    if (url.host === 'api.mangadex.org') {
      const ids = url.searchParams.getAll('ids[]');
      mdAsked.push(ids);
      return Response.json({ data: ids.filter((i) => i === UUID_OTHER).map((id) => ({ id, attributes: { title: { en: 'Something Else' }, altTitles: [{ ja: 'ほかの何か' }] } })) });
    }
    throw new Error(`unexpected request in a test: ${url}`);
  }) as typeof fetch;
}

const log = { info() {}, warn() {} };

before(async () => {
  if (!DSN) return;
  ({ q, pool } = await import('../src/lib/db'));
  await (await import('../src/lib/migrate')).migrate();
  const ids = Object.values(S);
  for (const t of ['series_trackers', 'series_art', 'series_alt_titles', 'tracker_progress', 'series_sources']) await q(`DELETE FROM ${t} WHERE series_id = ANY($1)`, [ids]);
  await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [ids]);
  await q(`DELETE FROM users WHERE username IN ($1, 'mc-admin')`, [USER]);
  await q(`DELETE FROM libraries WHERE id = 'mc-private'`).catch(() => {});
  userId = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x','user','password') RETURNING id`, [USER]))[0].id;
  const adminId = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ('mc-admin','mc-admin','x','admin','password') RETURNING id`))[0].id;
  for (const [k, id] of Object.entries(S)) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1, 'T!mc', $2, $3, 1)`, [id, TITLE[k], `T!mc/${id}`]);
  }
  // Two editions of one work: the Spanish one carries the link its English sibling's name answers to.
  await q(`UPDATE lib_series SET work_id = '55555555-5555-4555-8555-555555555555' WHERE id = ANY($1)`, [[S.edEs, S.edEn]]);
  await q(`UPDATE lib_series SET source_id = 'mangadex', source_series_id = $2 WHERE id = $1`, [S.ownMd, UUID_OWN]);
  await q(`INSERT INTO series_alt_titles (series_id, norm, title, origin) VALUES ($1, 'zzzmcaltname', 'Zzz Mc Alt Name', 'description')`, [S.alt]);
  // Links as every release before v0.55.7 wrote them: automatic, never checked.
  for (const [s, ext] of [[S.wrong, 501], [S.druid, 502], [S.alt, 503], [S.edEs, 504], [S.gone, 599]] as const) {
    await q(`INSERT INTO series_trackers (series_id, provider, external_id, title) VALUES ($1, 'anilist', $2, 'x')`, [s, String(ext)]);
  }
  await q(`INSERT INTO series_trackers (series_id, provider, external_id, title, linked_by) VALUES ($1, 'anilist', '505', 'x', $2)`, [S.human, userId]);
  // What progress pushes recorded against the wrong entry: about another work.
  await q(`INSERT INTO tracker_progress (user_id, series_id, provider, chapters, pushed_at) VALUES ($1, $2, 'anilist', 40, now())`, [userId, S.wrong]);
  await q(`INSERT INTO tracker_progress (user_id, series_id, provider, chapters, pushed_at) VALUES ($1, $2, 'anilist', 12, now())`, [userId, S.druid]);
  // Art as every release before wrote it: from a title search, unchecked.
  const art = (s: string, b: string | null, c: string | null) => q(`INSERT INTO series_art (series_id, banner, cover) VALUES ($1, $2, $3)`, [s, b, c]);
  await art(S.wrong, banner(501), cover(501));
  await art(S.anime, banner(701, 'anime'), null);
  await art(S.wrongAnime, banner(703, 'anime'), null);
  await art(S.md, null, mdCover(UUID_OTHER));
  await art(S.ownMd, null, mdCover(UUID_OWN));
  await art(S.src, null, 'https://example.org/covers/mc.jpg');

  const { _setMangadexPacing } = await import('../src/lib/sources/mangadex');
  _setMangadexPacing({ apiGapMs: 0 });
  const Fastify = (await import('fastify')).default;
  app = Fastify();
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  adminAuth = { authorization: `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}` };
  fakeNetwork();
});

after(async () => {
  globalThis.fetch = realFetch;
  if (!DSN) return;
  await app?.close();
  const ids = Object.values(S);
  for (const t of ['series_trackers', 'series_art', 'series_alt_titles', 'tracker_progress', 'series_sources']) await q(`DELETE FROM ${t} WHERE series_id = ANY($1)`, [ids]);
  await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [ids]);
  await q(`DELETE FROM users WHERE username IN ($1, 'mc-admin')`, [USER]);
  await q(`DELETE FROM libraries WHERE id = 'mc-private'`).catch(() => {});
  await q(`DELETE FROM audit_log WHERE event = 'library.match_check'`);
  await (await import('../src/lib/db')).pool.end();
});

const linkOf = async (id: string) => (await q(`SELECT external_id, linked_by, checked_at FROM series_trackers WHERE series_id = $1 AND provider = 'anilist'`, [id]))[0] ?? null;
const artOf = async (id: string) => (await q(`SELECT banner, cover, checked_at FROM series_art WHERE series_id = $1`, [id]))[0] ?? null;
const askedAniList = () => alAsked.flat();

test('every unchecked match is held to the title check: another work goes, the series stays, a person\'s link is never asked about', { skip }, async () => {
  const { checkMatches } = await import('../src/lib/matchCheck');
  const r = await checkMatches(log);

  // Another work's link goes, and with it the floors pushes recorded against that entry.
  // Reintroduce by keeping a link that fails (no DELETE in checkMatches): "another work's link was kept" fails.
  assert.equal(await linkOf(S.wrong), null, "another work's link was kept");
  assert.deepEqual(await q(`SELECT 1 FROM tracker_progress WHERE series_id = $1`, [S.wrong]), [], "the floor another work's pushes left was kept");
  // The series' own entries stay, matched by a synonym, by an other name, and by the name of another edition of the work.
  for (const [s, why] of [[S.druid, 'a synonym'], [S.alt, 'an other name'], [S.edEs, "its work's other edition"]] as const) {
    const l = await linkOf(s);
    assert.ok(l, `a link named as the series by ${why} was removed`);
    assert.ok(l.checked_at, `a link kept by ${why} was not marked checked`);
  }
  assert.equal((await q(`SELECT chapters FROM tracker_progress WHERE series_id = $1`, [S.druid]))[0]?.chapters, 12, "a kept link's floor went");
  // A person's link is not the check's to judge: never asked about, never touched.
  assert.ok(!askedAniList().includes(505), "AniList was asked about a link a person made");
  assert.deepEqual([(await linkOf(S.human))?.external_id, (await linkOf(S.human))?.checked_at], ['505', null]);
  // An entry AniList no longer answers for is kept, as it is: no evidence against it.
  assert.ok(await linkOf(S.gone), 'a link AniList no longer answers for was removed');

  // The art: another work's cover and banner are cleared to a miss (the row stays, so nothing asks again).
  const w = await artOf(S.wrong);
  assert.deepEqual([w?.banner, w?.cover], [null, null], "another work's cover and banner were kept");
  assert.ok(w.checked_at);
  // An adaptation's banner stands when the anime is related to a manga named as the series; otherwise it goes.
  // Reintroduce by judging the anime by its own names only (no `related` in checkMatches): "an adaptation of the series"
  // reads null.
  assert.equal((await artOf(S.anime))?.banner, banner(701, 'anime'), "an adaptation of the series lost its banner");
  assert.equal((await artOf(S.wrongAnime))?.banner, null, "another work's anime banner was kept");
  // A MangaDex cover the backfill took for another work goes; the cover of the series' own MangaDex title is its
  // source's, and MangaDex is never asked about it.
  assert.equal((await artOf(S.md))?.cover, null, "another work's MangaDex cover was kept");
  assert.equal((await artOf(S.ownMd))?.cover, mdCover(UUID_OWN), "the source's own cover was cleared");
  assert.ok(!mdAsked.flat().includes(UUID_OWN), 'MangaDex was asked about the series\' own source');
  // A cover from anywhere else is a source's. Its NULL mark is also the title-enrichment retry state, so a job that
  // did not search by title must not consume it; enabling later lets the lazy/add lookup fill what is missing.
  const src = await artOf(S.src);
  assert.deepEqual([src?.cover, src?.checked_at], ['https://example.org/covers/mc.jpg', null]);

  assert.deepEqual({ links: r.links, art: r.art, unanswered: r.unanswered, stopped: r.stopped },
    { links: { checked: 4, removed: 1 }, art: { checked: 5, cleared: 4 }, unanswered: 1, stopped: undefined });
  assert.deepEqual([r.matches, r.removed], [9, 5]);
  // Said in the audit log, naming what went.
  const audit = (await q(`SELECT detail FROM audit_log WHERE event = 'library.match_check' ORDER BY at DESC LIMIT 1`))[0]?.detail;
  assert.deepEqual(audit?.links, { checked: 4, removed: 1 }, 'the audit log does not say how many links were removed');
  assert.ok(audit.removed.some((x: any) => x.id === S.wrong && x.anilist === 501 && x.was === 'Sasaki to Miyano'), 'the audit log does not name the removed link');
});

test('a second pass asks nothing: every verdict was written as it was reached', { skip }, async () => {
  const { checkMatches } = await import('../src/lib/matchCheck');
  const before = [alAsked.length, mdAsked.length, alSearched.length];
  const r = await checkMatches(log);
  assert.deepEqual([alAsked.length, mdAsked.length, alSearched.length], before, 'a checked match was asked about again');
  assert.equal(r.matches, 0);
});

test('background matching sends nothing for an opted-out library, while explicit Run now remains available', { skip }, async () => {
  const { checkMatches } = await import('../src/lib/matchCheck');
  await q(`INSERT INTO libraries (id, name, path, anilist_lookup) VALUES ('mc-private','Private metadata','T!mc/private',false)`);
  await q(`UPDATE lib_series SET library_id = 'mc-private' WHERE id = $1`, [S.private]);
  await q(`INSERT INTO series_trackers (series_id, provider, external_id, title) VALUES ($1,'anilist','507','Zzz Mc Private')`, [S.private]);
  await q(`INSERT INTO series_art (series_id, banner, cover) VALUES ($1,$2,$3)`, [S.private, banner(507), cover(507)]);

  const before = alAsked.length;
  const automatic = await checkMatches(log);
  assert.equal(alAsked.length, before, 'the scheduled pass sent a stored id from an opted-out library');
  assert.deepEqual(automatic.links, { checked: 0, removed: 0 });
  assert.deepEqual(automatic.art, { checked: 0, cleared: 0 });
  assert.equal((await linkOf(S.private))?.checked_at, null, 'the skipped link was stamped and cannot run after enabling');
  assert.equal((await artOf(S.private))?.checked_at, null, 'the skipped art was stamped and cannot run after enabling');

  const manual = await checkMatches(log, { all: true });
  assert.ok(alAsked.slice(before).flat().includes(507), 'the explicit Admin action was blocked by the automatic switch');
  assert.ok(manual.links.checked >= 1, 'the manual pass did not check the opted-out link');
  assert.ok(manual.art.checked >= 2, 'the manual pass did not check both opted-out art fields');
  assert.ok((await linkOf(S.private))?.checked_at);
  assert.ok((await artOf(S.private))?.checked_at);
});

test('a move to an opted-out library while a background check is assembling names sends no stored ids', { skip }, async () => {
  const { checkMatches } = await import('../src/lib/matchCheck');
  // Start eligible, with both providers represented.  Holding series_alt_titles stops namesOfMany after the initial
  // candidate snapshot, giving the move a deterministic window before either outbound id set is formed.
  await q(`UPDATE libraries SET anilist_lookup = true WHERE id = 'mc-private'`);
  await q(`UPDATE lib_series SET library_id = 'mc-private' WHERE id = $1`, [S.private]);
  await q(`DELETE FROM series_trackers WHERE series_id = $1 AND provider = 'anilist'`, [S.private]);
  await q(`INSERT INTO series_trackers (series_id, provider, external_id, title) VALUES ($1,'anilist','507','Zzz Mc Private')`, [S.private]);
  await q(`INSERT INTO series_art (series_id, banner, cover, checked_at) VALUES ($1,$2,$3,NULL)
           ON CONFLICT (series_id) DO UPDATE SET banner = EXCLUDED.banner, cover = EXCLUDED.cover, checked_at = NULL`,
    [S.private, banner(507), mdCover(UUID_OTHER)]);

  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('LOCK TABLE series_alt_titles IN ACCESS EXCLUSIVE MODE');
  const before = { al: alAsked.length, md: mdAsked.length };
  const running = checkMatches(log);
  try {
    let waiting = false;
    for (let i = 0; i < 200 && !waiting; i++) {
      const rows = await q(`SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'
          AND query ILIKE '%series_alt_titles%' AND pid <> pg_backend_pid()`);
      waiting = rows.length > 0;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, 'the match check did not reach the controlled policy-race boundary');
    await q(`UPDATE libraries SET anilist_lookup = false WHERE id = 'mc-private'`);
  } finally {
    await blocker.query('COMMIT');
    blocker.release();
  }
  const result = await running;
  assert.equal(alAsked.length, before.al, 'the stale snapshot sent an AniList id after the series opted out');
  assert.equal(mdAsked.length, before.md, 'the stale snapshot sent a MangaDex id after the series opted out');
  assert.deepEqual(result.links, { checked: 0, removed: 0 });
  assert.deepEqual(result.art, { checked: 0, cleared: 0 });
  assert.equal((await linkOf(S.private))?.checked_at, null, 'the skipped link was stamped');
  assert.equal((await artOf(S.private))?.checked_at, null, 'the skipped art was stamped');
});

test('a policy toggle after the online answer but immediately before its writes refuses every verdict', { skip }, async () => {
  const { checkMatches } = await import('../src/lib/matchCheck');
  const { setAniListMutationHooks } = await import('../src/lib/anilistPolicy');
  await q(`UPDATE libraries SET anilist_lookup = true WHERE id = 'mc-private'`);
  await q(`UPDATE lib_series SET library_id = 'mc-private' WHERE id = $1`, [S.private]);
  await q(`INSERT INTO series_trackers (series_id, provider, external_id, title, checked_at)
           VALUES ($1,'anilist','507','Zzz Mc Private',NULL)
           ON CONFLICT (series_id, provider) DO UPDATE SET external_id = EXCLUDED.external_id,
             title = EXCLUDED.title, linked_by = NULL, checked_at = NULL`, [S.private]);
  await q(`INSERT INTO series_art (series_id, banner, cover, checked_at) VALUES ($1,$2,$3,NULL)
           ON CONFLICT (series_id) DO UPDATE SET banner = EXCLUDED.banner, cover = EXCLUDED.cover, checked_at = NULL`,
    [S.private, banner(507), cover(507)]);

  let toggled = false;
  setAniListMutationHooks({
    async beforeLock(where) {
      if (!('id' in where) || where.id !== S.private || toggled) return;
      toggled = true;
      await q(`UPDATE libraries SET anilist_lookup = false WHERE id = 'mc-private'`);
    },
  });
  let result: Awaited<ReturnType<typeof checkMatches>>;
  try {
    result = await checkMatches(log);
  } finally {
    setAniListMutationHooks();
  }

  assert.equal(toggled, true, 'the check did not reach the controlled post-answer write boundary');
  assert.deepEqual(result!.links, { checked: 0, removed: 0 }, 'a link verdict crossed the atomic policy boundary');
  assert.deepEqual(result!.art, { checked: 0, cleared: 0 }, 'an art verdict crossed the atomic policy boundary');
  assert.equal((await linkOf(S.private))?.checked_at, null, 'the answered link was stamped after opt-out');
  assert.equal((await artOf(S.private))?.checked_at, null, 'the answered art was stamped after opt-out');
});

test('a service that does not answer decides nothing; the next run takes up what is left', { skip }, async () => {
  const { checkMatches } = await import('../src/lib/matchCheck');
  await q(`INSERT INTO series_trackers (series_id, provider, external_id, title) VALUES ($1, 'anilist', '506', 'x')`, [S.later]);
  aniListDown = true;
  try {
    const r = await checkMatches(log);
    assert.equal(r.stopped, 'unavailable');
    // Reintroduce by treating a failed lookup as "no answers" (catch → empty Map): the link is stamped, or removed.
    const l = await linkOf(S.later);
    assert.ok(l, 'a link was removed while AniList did not answer');
    assert.equal(l.checked_at, null, 'a link was marked checked while AniList did not answer');
  } finally {
    aniListDown = false;
  }
  const r = await checkMatches(log);
  assert.equal(r.links.removed, 1);
  assert.equal(await linkOf(S.later), null, 'the next run did not take up what was left');
});

test('Admin → Tasks: listed, Run now checks every automatic match again, and its line is the run\'s', { skip }, async () => {
  const { matchCheckState } = await import('../src/lib/matchCheck');
  const from = alAsked.length;
  const run = await app.inject({ method: 'POST', url: '/api/admin/tasks/matches/run', headers: adminAuth });
  assert.deepEqual(run.json(), { ok: true, started: true });
  for (let i = 0; i < 200 && matchCheckState.running; i++) await new Promise((res) => setTimeout(res, 25));
  assert.equal(matchCheckState.running, false, 'the run did not end');
  // Every automatic link again, checked or not -- the druid's was checked by the first test -- and never a person's.
  // Reintroduce by running the background pass on Run now (no `all`): nothing is unchecked, and AniList is not asked.
  assert.ok(alAsked.slice(from).flat().includes(502), 'Run now did not check a checked link again');
  assert.ok(!askedAniList().includes(505));
  const tasks = (await app.inject({ method: 'GET', url: '/api/admin/tasks', headers: adminAuth })).json().content;
  const row = tasks.find((t: any) => t.id === 'matches');
  assert.ok(row, 'the recheck is not listed under Tasks');
  assert.equal(row.name, 'Check online matches');
  assert.equal(row.scheduleKey, 'in the background, rechecked every 6h');
  assert.ok(row.lastRun, 'the Tasks line has no last run');
  assert.equal(typeof row.lastResult?.matches, 'number', 'the Tasks line has no result');
  assert.equal(row.running, false);
  // Persisted, for a restart.
  const s = (await q(`SELECT match_check_last_run, match_check_last_result FROM server_settings WHERE id = 1`))[0];
  assert.ok(s.match_check_last_run);
  assert.equal(s.match_check_last_result?.matches, row.lastResult.matches);
});

/** A link, its art, a floor and a direction as v0.55.7 to v0.103.0 left them for a series named by a synonym: all checked. */
async function seedPick(s: string, opts: { linkedBy?: string | null; banner?: string | null; cover?: string | null; direction?: [string, string] } = {}) {
  await q(`INSERT INTO series_trackers (series_id, provider, external_id, title, linked_by, checked_at)
           VALUES ($1, 'anilist', '591', 'Zzz Mc Gekka Bijin', $2, now() - interval '1 day')`, [s, opts.linkedBy ?? null]);
  await q(`INSERT INTO series_art (series_id, banner, cover, checked_at) VALUES ($1, $2, $3, now() - interval '1 day')`,
    [s, opts.banner === undefined ? banner(791, 'anime') : opts.banner, opts.cover === undefined ? cover(591) : opts.cover]);
  await q(`INSERT INTO tracker_progress (user_id, series_id, provider, chapters) VALUES ($1, $2, 'anilist', 30)`, [userId, s]);
  const [direction, from] = opts.direction ?? ['RIGHT_TO_LEFT', 'anilist'];
  await q(`UPDATE lib_series SET reading_direction = $2, reading_direction_from = $3, series_type = 'manga', series_type_from = 'anilist' WHERE id = $1`,
    [s, direction, from]);
}
const metaOf = async (id: string) => (await q(`SELECT reading_direction AS d, reading_direction_from AS df, series_type AS t, series_type_from AS tf FROM lib_series WHERE id = $1`, [id]))[0];
const ruleNow = async () => (await q(`SELECT match_check_rule AS rule FROM server_settings WHERE id = 1`))[0]?.rule;

test('an upgrade moves a link checked when a synonym was enough, with what the old entry gave; a person\'s link stays', { skip }, async () => {
  const { checkMatches, MATCH_RULE } = await import('../src/lib/matchCheck');
  // Pick Me Up as the live server holds it: linked to the anthology, its cover, the banner of the anthology's anime, a
  // floor, and the anthology's Japan read right to left. A copy whose cover is its source's, with no banner and the
  // source's word on the direction. And a person's link to the same entry under the same name.
  await seedPick(S.pick);
  await seedPick(S.pickSrc, { banner: null, cover: 'https://example.org/covers/pick.jpg', direction: ['LEFT_TO_RIGHT', 'source'] });
  await seedPick(S.pickHuman, { linkedBy: userId });
  const was = await linkOf(S.pick);
  // An install upgraded from the rule before: every one of those links was checked under it.
  await q(`UPDATE server_settings SET match_check_rule = 1 WHERE id = 1`);
  const searched = alSearched.length;
  const r = await checkMatches(log);

  // Reintroduce by leaving the checked links alone (no `behind` in checkMatches): the anthology is still linked.
  const l = await linkOf(S.pick);
  assert.equal(l?.external_id, '592', 'the anthology is still linked: the upgrade did not look at a link checked under the old rule');
  assert.equal(l.linked_by, null, 'still an automatic link');
  assert.ok(l.checked_at > was.checked_at, 'the moved link was not marked checked');
  assert.ok(alSearched.slice(searched).includes(TITLE.pick), 'AniList was not searched by the series\' title');
  // Reintroduce by moving the link alone (moveLink without its DELETE): the floor about the anthology holds back the manhwa.
  assert.deepEqual(await q(`SELECT 1 FROM tracker_progress WHERE series_id = $1`, [S.pick]), [], "the floor pushed against the anthology was kept");
  // Reintroduce by moving the link alone (moveLink without the art): the anthology's anime banner and its cover stay.
  const a = (await q(`SELECT banner, cover, rev, checked_at FROM series_art WHERE series_id = $1`, [S.pick]))[0];
  assert.deepEqual([a.banner, a.cover], [banner(592), cover(592)], "the old entry's pictures stayed on the series");
  assert.equal(a.rev, 1, 'the pictures made from the old art would be served under the same key');
  // Reintroduce by moving the link alone (no learnDirectionWith in moveLink): the manhwa reads right to left.
  assert.deepEqual(await metaOf(S.pick), { d: 'WEBTOON', df: 'anilist', t: 'manhwa', tf: 'anilist' }, "the anthology's country still sets the direction and type");
  // The copy: its source's cover and its source's direction stay; the banner it had none of is the manhwa's.
  const src = (await q(`SELECT banner, cover, rev FROM series_art WHERE series_id = $1`, [S.pickSrc]))[0];
  assert.equal((await linkOf(S.pickSrc))?.external_id, '592');
  assert.deepEqual([src.banner, src.cover, src.rev], [banner(592), 'https://example.org/covers/pick.jpg', 1], "a source's cover was replaced, or an empty banner left empty");
  assert.deepEqual(await metaOf(S.pickSrc), { d: 'LEFT_TO_RIGHT', df: 'source', t: 'manhwa', tf: 'anilist' }, "AniList overrode the source's direction");
  // A person's link is not the check's: the same name, the same entry, and nothing moves.
  const h = await linkOf(S.pickHuman);
  assert.deepEqual([h?.external_id, h?.linked_by], ['591', userId], "a person's link was moved");
  assert.equal((await q(`SELECT chapters FROM tracker_progress WHERE series_id = $1`, [S.pickHuman]))[0]?.chapters, 30, "a person's link lost its floor");
  assert.equal((await q(`SELECT cover FROM series_art WHERE series_id = $1`, [S.pickHuman]))[0]?.cover, cover(591), "a person's link lost its art");
  // A link named only by a synonym with no entry named so by its own title stays: the druid (502) has only its synonym.
  assert.equal((await linkOf(S.druid))?.external_id, '502', 'a synonym with nothing better was moved or removed');

  assert.equal(r.moved, 2);
  assert.equal(r.stopped, undefined);
  const audit = (await q(`SELECT detail FROM audit_log WHERE event = 'library.match_check' ORDER BY at DESC LIMIT 1`))[0]?.detail;
  assert.ok(audit?.moves?.some((x: any) => x.id === S.pick && x.from === 591 && x.to === 592 && x.was === 'Zzz Mc Gekka Bijin'), 'the audit log does not name the move');
  // The rule is held: the next background pass is back to what is unchecked, and asks nothing.
  assert.equal(await ruleNow(), MATCH_RULE);
  const before = [alAsked.length, alSearched.length];
  assert.equal((await checkMatches(log)).matches, 0);
  assert.deepEqual([alAsked.length, alSearched.length], before, 'a pass after the upgrade asked AniList again');
});

test("a search that does not answer moves nothing, and the upgrade's pass is taken up by the next run", { skip }, async () => {
  const { checkMatches, MATCH_RULE } = await import('../src/lib/matchCheck');
  await seedPick(S.pickLate);
  const was = await linkOf(S.pickLate);
  await q(`UPDATE server_settings SET match_check_rule = 1 WHERE id = 1`);
  searchDown = true;
  try {
    const r = await checkMatches(log);
    assert.equal(r.stopped, 'unavailable');
    // Reintroduce by reading a failed search as "nothing better" (return null from the catch): the link is stamped and the
    // rule held, and the anthology stays linked for good.
    const l = await linkOf(S.pickLate);
    assert.deepEqual([l?.external_id, l?.checked_at?.getTime()], ['591', was.checked_at.getTime()],
      'a link named only by a synonym was decided while the search did not answer');
    assert.equal(await ruleNow(), 1, 'the rule was held although a link was never searched for');
  } finally {
    searchDown = false;
  }
  await checkMatches(log);
  assert.equal((await linkOf(S.pickLate))?.external_id, '592', 'the next run did not take up the move');
  assert.equal(await ruleNow(), MATCH_RULE);
});

test('a person who links the series while AniList is answering keeps their link: nothing moves', { skip }, async () => {
  const { checkMatches } = await import('../src/lib/matchCheck');
  const { setAniListMutationHooks } = await import('../src/lib/anilistPolicy');
  await seedPick(S.pickRace);
  await q(`UPDATE server_settings SET match_check_rule = 1 WHERE id = 1`);
  let linked = false;
  setAniListMutationHooks({
    async beforeLock(where) {
      if (!('id' in where) || where.id !== S.pickRace || linked) return;
      linked = true;
      await q(`UPDATE series_trackers SET linked_by = $2 WHERE series_id = $1 AND provider = 'anilist'`, [S.pickRace, userId]);
    },
  });
  let r: Awaited<ReturnType<typeof checkMatches>>;
  try {
    r = await checkMatches(log);
  } finally {
    setAniListMutationHooks();
  }
  assert.equal(linked, true, 'the check did not reach the move');
  // Reintroduce by moving whatever link the series has (no `linked_by IS NULL` in moveLink's UPDATE): the person's link
  // to the anthology is the manhwa's, and their floor is gone.
  const l = await linkOf(S.pickRace);
  assert.deepEqual([l?.external_id, l?.linked_by], ['591', userId], 'a link a person made while the check was answering was moved');
  assert.equal((await q(`SELECT chapters FROM tracker_progress WHERE series_id = $1`, [S.pickRace]))[0]?.chapters, 30, "the person's floor went");
  assert.equal((await q(`SELECT cover FROM series_art WHERE series_id = $1`, [S.pickRace]))[0]?.cover, cover(591), "the person's series lost its art");
  const audit = (await q(`SELECT detail FROM audit_log WHERE event = 'library.match_check' ORDER BY at DESC LIMIT 1`))[0]?.detail;
  assert.ok(!(audit?.moves ?? []).some((x: any) => x.id === S.pickRace), 'a move that did not happen is in the audit log');
  assert.equal(typeof r!.moved, 'number');
});
