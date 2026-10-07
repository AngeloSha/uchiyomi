// The recheck of the online matches stored by title before v0.55.7 checked them (#168, lib/matchCheck.ts): every
// automatic AniList link, and every cover and banner served from AniList's or MangaDex's servers, held to the title
// check (lib/onlineMatch.ts) against what AniList and MangaDex call those entries -- what it removes, what it never
// touches, how it resumes, and how it reaches Admin → Tasks.
//
// AniList and MangaDex are fakes at globalThis.fetch that answer by id, as the real ones do, and count what they were
// asked: nothing here reaches the network. Skipped automatically unless TEST_DATABASE_URL is set.
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
};

const S = {
  wrong: 's_mc_wrong', druid: 's_mc_druid', alt: 's_mc_alt', edEs: 's_mc_ed_es', edEn: 's_mc_ed_en', human: 's_mc_human',
  gone: 's_mc_gone', anime: 's_mc_anime', wrongAnime: 's_mc_wrong_anime', md: 's_mc_md', ownMd: 's_mc_own_md', src: 's_mc_src',
  later: 's_mc_later', private: 's_mc_private',
};
const TITLE: Record<string, string> = {
  wrong: 'Zzz Mc Morgan Lost', druid: 'Zzz Mc Seoul Station Druid', alt: 'Zzz Mc Scanned Name', edEs: 'Zzz Mc Edicion', edEn: 'Zzz Mc Edition',
  human: 'Zzz Mc Human', gone: 'Zzz Mc Gone Entry', anime: 'Zzz Mc Anime Banner', wrongAnime: 'Zzz Mc Wrong Anime', md: 'Zzz Mc MangaDex Cover',
  ownMd: 'Zzz Mc Own MangaDex', src: 'Zzz Mc Source Cover', later: 'Zzz Mc Later', private: 'Zzz Mc Private',
};
const USER = 'mc-reader';

let q: any, app: any, adminAuth: Record<string, string> = {}, userId = '';
const realFetch = globalThis.fetch;
/** Every id AniList was asked about, request by request; and MangaDex's. */
const alAsked: number[][] = [];
const mdAsked: string[][] = [];
let aniListDown = false;

function fakeNetwork() {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input?.url ?? input));
    if (url.host === 'graphql.anilist.co') {
      if (aniListDown) return new Response('{}', { status: 500 });
      const ids: number[] = JSON.parse(String(init?.body ?? '{}'))?.variables?.ids ?? [];
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
  ({ q } = await import('../src/lib/db'));
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
  // A cover from anywhere else is a source's: checked as it stands, nobody asked.
  const src = await artOf(S.src);
  assert.deepEqual([src?.cover, !!src?.checked_at], ['https://example.org/covers/mc.jpg', true]);

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
  const before = [alAsked.length, mdAsked.length];
  const r = await checkMatches(log);
  assert.deepEqual([alAsked.length, mdAsked.length], before, 'a checked match was asked about again');
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
