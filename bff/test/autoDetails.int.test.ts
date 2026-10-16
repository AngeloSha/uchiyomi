// Fill in missing details (v0.73.0, lib/autoDetails.ts; #257 and #245 from @Squeaks72, rebuilt), driven as it runs: the
// nightly repair's `details` step, the series route that shows the result, the 18+ filter, the setting, and the manual
// follow. Behaviour, not the source text: every claim below is something a person would see.
//
// The sources are fakes that count how often they are asked. AniList answers through a scripted fetch.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_ad_on';
const LIB_OFF = 'lib_ad_off';
/** The series' own source: describes nothing, as a site that never filled its description in. */
const MAIN = 'ad-main';
/** A follower that has it all, in Markdown and with a doubled, blank genre, as sites send it. */
const FOLLOW = 'ad-follow';
/** Cooling down: never asked while its cooldown runs. */
const COOL = 'ad-cool';
/** Throws: skipped for the next one. */
const DOWN = 'ad-down';
/** In Spanish: never asked about an English series. */
const FOREIGN = 'ad-foreign';
/** Gives an adult genre. */
const SPICY = 'ad-spicy';
/** Knows no author either. */
const BARE = 'ad-bare';

const EMPTY = 's_ad_empty', SCANNED = 's_ad_scanned', CLEARED = 's_ad_cleared', ORDER = 's_ad_order', PAUSED = 's_ad_paused';
const ADULT = 's_ad_adult', NOAUTHOR = 's_ad_noauthor', FOLLOWME = 's_ad_followme';
const AL_EN = 's_ad_al_en', AL_OFF = 's_ad_al_off', AL_ES = 's_ad_al_es', AL_UNCHECKED = 's_ad_al_unchecked';
const SERIES = [EMPTY, SCANNED, CLEARED, ORDER, PAUSED, ADULT, NOAUTHOR, FOLLOWME, AL_EN, AL_OFF, AL_ES, AL_UNCHECKED];

const calls: Record<string, number> = {};
const FULL = {
  summary: '**A boy** meets a [ghost](https://x.invalid).', genres: [' Action ', '', 'Drama', 'action'], author: '  Some   Author ',
  coverUrl: 'https://img.invalid/follow-cover.jpg',
};
function fake(id: string, opts: { lang?: string; info?: Record<string, unknown>; throws?: boolean } = {}) {
  calls[id] = 0;
  return {
    id, name: `Zzz ${id}`, ...(opts.lang ? { lang: opts.lang } : {}),
    async search() { return []; },
    async getSeries(sid: string) {
      calls[id]++;
      if (opts.throws) throw new Error('down');
      return { sourceId: sid, source: id, title: 'Zzz Ad', ...(opts.info ?? {}) };
    },
    async listChapters() { return []; },
    async getPageUrls() { return []; },
    async latest() { return []; },
    async popular() { return []; },
  };
}

/** AniList's answers by id; what it was asked, request by request. */
const MEDIA: Record<number, { description: string; genres: string[] }> = {
  9001: { description: 'First line.<br><br>Second <i>line</i>.', genres: ['Drama', 'Drama', 'Slice of Life'] },
  9002: { description: 'Off library.', genres: ['Action'] },
  9003: { description: 'Spanish one.', genres: ['Action'] },
  9004: { description: 'Unchecked.', genres: ['Action'] },
};
const anilistAsked: number[][] = [];
const realFetch = globalThis.fetch;

test('fill in missing details: below the scan, only when switched on, and only from sources that may be asked', { skip }, async (t) => {
  globalThis.fetch = (async (u: any, init?: any) => {
    if (String(u?.url ?? u).includes('graphql.anilist.co')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (!String(body.query).includes('description')) return new Response('{}', { status: 503 });
      const ids: number[] = body.variables?.ids ?? [];
      anilistAsked.push(ids);
      return Response.json({ data: { Page: { media: ids.filter((id) => MEDIA[id]).map((id) => ({ id, ...MEDIA[id] })) } } });
    }
    return realFetch(u, init);
  }) as typeof fetch;
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const { registerAdapter } = await import('../src/lib/sources');
  const { repairLibrary } = await import('../src/lib/repair');
  const D = await import('../src/lib/autoDetails');
  const V = await import('../src/lib/visibility');
  const { putPlan } = await import('../src/lib/fill');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();
  registerAdapter(fake(MAIN) as any);
  registerAdapter(fake(FOLLOW, { info: FULL }) as any);
  registerAdapter(fake(COOL, { info: FULL }) as any);
  registerAdapter(fake(DOWN, { throws: true }) as any);
  registerAdapter(fake(FOREIGN, { lang: 'es', info: { summary: 'Un chico.', genres: ['Drama'], author: 'Autor' } }) as any);
  registerAdapter(fake(SPICY, { info: { genres: ['Ecchi'] } }) as any);
  registerAdapter(fake(BARE, { info: { summary: 'Bare has a description.' } }) as any);

  const cleanup = async () => {
    for (const tb of ['series_auto_details', 'series_overrides', 'series_art', 'series_sources', 'series_trackers']) {
      await q(`DELETE FROM ${tb} WHERE series_id = ANY($1)`, [SERIES]).catch(() => {});
    }
    await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [SERIES]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [SERIES]).catch(() => {});
    await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[COOL]]).catch(() => {});
    await q(`DELETE FROM users WHERE username = 'ad-admin'`).catch(() => {});
    await q(`UPDATE server_settings SET fill_details = false, adult_genres = '[]'::jsonb WHERE id = 1`).catch(() => {});
    V.invalidateAdultFilter();
  };
  await cleanup();
  await q(`INSERT INTO libraries (id, name, path, anilist_lookup) VALUES ($1, 'Ad on', '/ad-on', true), ($2, 'Ad off', '/ad-off', false)
           ON CONFLICT (id) DO UPDATE SET anilist_lookup = EXCLUDED.anilist_lookup`, [LIB, LIB_OFF]);
  const mk = async (id: string, o: { main?: string | null; summary?: string | null; author?: string | null; genres?: string[];
    auto?: boolean; chapters?: number; lib?: string; lang?: string | null } = {}) => {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, summary, author, genres,
               auto_update, lang, latest_mtime, created_at)
             VALUES ($1, 'T!ad', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, now())`,
    [id, `Zzz Ad ${id}`, `T!ad/${id}`, o.chapters ?? 0, o.lib ?? LIB, o.main === undefined ? MAIN : o.main, o.main === null ? null : 'm-1',
      o.summary ?? null, o.author ?? null, o.genres ?? [], o.auto ?? true, o.lang ?? null]);
    for (let n = 1; n <= (o.chapters ?? 0); n++) {
      await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root) VALUES ($1, $2, 'T!ad', $3, $4, $5, '/library')`,
        [`b_${id}_${n}`, id, `T!ad/${id}/ch${n}.cbz`, n, `Chapter ${n}`]);
    }
  };
  const follow = (id: string, src: string) => q(`INSERT INTO series_sources (series_id, source_id, source_series_id) VALUES ($1, $2, 'f-1')`, [id, src]);
  const link = (id: string, al: number, checked = true) =>
    q(`INSERT INTO series_trackers (series_id, provider, external_id, checked_at) VALUES ($1, 'anilist', $2, $3)`, [id, String(al), checked ? new Date() : null]);

  await mk(EMPTY);
  await follow(EMPTY, FOLLOW);
  await mk(SCANNED, { summary: 'Scanned description.', author: 'Scanned Author', genres: ['Romance'], chapters: 1 });
  await follow(SCANNED, FOLLOW);
  await mk(CLEARED, { summary: 'Has one.', author: 'Has one', chapters: 1 });
  await q(`INSERT INTO series_overrides (series_id, genres) VALUES ($1, '{}')`, [CLEARED]);
  await follow(CLEARED, FOLLOW);
  await mk(ORDER, { main: COOL, author: 'Has one', genres: ['Has'], chapters: 1 });
  for (const f of [DOWN, FOREIGN, FOLLOW]) await follow(ORDER, f);
  await q(`INSERT INTO source_health (source_id, blocked_until) VALUES ($1, now() + interval '1 hour')
           ON CONFLICT (source_id) DO UPDATE SET blocked_until = EXCLUDED.blocked_until`, [COOL]);
  await mk(PAUSED, { auto: false });
  await follow(PAUSED, FOLLOW);
  await mk(ADULT, { summary: 'Has one.', author: 'Has one', chapters: 1 });
  await follow(ADULT, SPICY);
  await mk(NOAUTHOR, { summary: 'Has one.', genres: ['Has'], chapters: 1 });
  await follow(NOAUTHOR, BARE);
  await mk(FOLLOWME, { genres: ['Has'], author: 'Has one', chapters: 1 });
  // AniList only: no source at all, so the sources part never picks them, and not kept updated -- AniList asks anyway.
  await mk(AL_EN, { main: null, auto: false, author: 'Has one', chapters: 1 });
  await link(AL_EN, 9001);
  await mk(AL_OFF, { main: null, auto: false, lib: LIB_OFF });
  await link(AL_OFF, 9002);
  await mk(AL_ES, { main: null, auto: false, lang: 'es' });
  await link(AL_ES, 9003);
  await mk(AL_UNCHECKED, { main: null, auto: false });
  await link(AL_UNCHECKED, 9004, false);

  const admin = (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ('ad-admin','ad-admin','x','admin','password') RETURNING id`))[0].id;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  const H = { authorization: `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}` };
  const meta = async (id: string) => (await app.inject({ method: 'GET', url: `/api/series/${id}`, headers: H })).json().metadata as
    { summary: string; genres: string[]; author: string };
  const auto = (id: string) => one<{ summary: string | null; summary_from: string | null; genres: string[] | null; genres_from: string | null;
    author: string | null; cover: string | null; sources_at: Date | null; anilist_at: Date | null }>('SELECT * FROM series_auto_details WHERE series_id = $1', [id]);
  const run = () => repairLibrary(undefined, { only: ['details'], userId: admin });
  const setting = (on: boolean) => app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: H, payload: { fillDetails: on } });

  try {
    await t.test('PREMISE: off by default -- the step asks nothing and writes nothing', async () => {
      const r = await run();
      assert.deepEqual(r.details, { off: true, asked: 0, filled: 0 });
      assert.equal(calls[FOLLOW] + calls[MAIN], 0, 'a source was asked with the switch off');
      assert.equal(anilistAsked.length, 0, 'AniList was asked with the switch off');
      assert.equal(await one('SELECT 1 FROM series_auto_details WHERE series_id = ANY($1)', [SERIES]), null);
      assert.equal((await meta(EMPTY)).summary, '');
    });

    await t.test('switched on, a series missing everything gets it from the source it follows, cleaned, in its own layer', async () => {
      assert.equal((await setting(true)).statusCode, 200);
      const r = await run();
      assert.equal(r.details.off, undefined);
      const a = await auto(EMPTY);
      assert.equal(a?.summary, 'A boy meets a ghost.', 'the description was not cleaned as an add cleans it');
      assert.deepEqual(a?.genres, ['Action', 'Drama'], 'the genres were not cleaned');
      assert.equal(a?.author, 'Some Author');
      assert.equal(a?.summary_from, FOLLOW);
      assert.ok(calls[MAIN] >= 1, "the series' own source was not asked first");
      // Never the admin's layer: an edit there means "a person chose this", and NULL there means inherit.
      assert.equal(await one('SELECT 1 FROM series_overrides WHERE series_id = $1', [EMPTY]), null, 'the fill wrote into series_overrides');
      const m = await meta(EMPTY);
      assert.equal(m.summary, 'A boy meets a ghost.');
      assert.deepEqual(m.genres, ['Action', 'Drama']);
      assert.equal(m.author, 'Some Author');
    });

    await t.test('a series with no chapters gets a cover, recorded so it can be taken back; one with chapters does not', async () => {
      assert.equal((await one<{ cover: string }>('SELECT cover FROM series_art WHERE series_id = $1', [EMPTY]))?.cover, FULL.coverUrl);
      assert.equal((await auto(EMPTY))?.cover, FULL.coverUrl);
      assert.equal(await one('SELECT 1 FROM series_art WHERE series_id = $1', [ORDER]), null);
    });

    await t.test('nothing a scan or an admin set is touched: a series that lacks nothing is never asked, `{}` genres stay cleared', async () => {
      assert.equal(await auto(SCANNED), null, 'a series that lacks nothing was asked');
      assert.equal(await auto(CLEARED), null, 'genres cleared on purpose were treated as missing');
      assert.deepEqual((await meta(CLEARED)).genres, []);
      assert.equal((await meta(SCANNED)).summary, 'Scanned description.');
    });

    await t.test('BELOW THE SCAN: a scan that brings a description later wins at once, and the filled one waits under it', async () => {
      // Reintroduce a layer above the scan, as writing into series_overrides was (`COALESCE(o.summary, m.summary, s.summary)`
      // in lib/autoDetailsSql.ts summaryOf): this reads the filled text over the scanned one.
      await q(`UPDATE lib_series SET summary = 'Scanned later.' WHERE id = $1`, [EMPTY]);
      assert.equal((await meta(EMPTY)).summary, 'Scanned later.');
      assert.equal((await auto(EMPTY))?.summary, 'A boy meets a ghost.', 'the filled description was thrown away');
      await q(`UPDATE lib_series SET summary = NULL WHERE id = $1`, [EMPTY]);
      // An admin's edit is above both.
      await q(`INSERT INTO series_overrides (series_id, author) VALUES ($1, 'Admin Author')`, [EMPTY]);
      assert.equal((await meta(EMPTY)).author, 'Admin Author');
      await q('DELETE FROM series_overrides WHERE series_id = $1', [EMPTY]);
    });

    await t.test('asked in order, only while a source may be asked: a cooling one and one in another language never, a failing one skipped', async () => {
      assert.equal(calls[COOL], 0, 'a source in a cooldown was asked');
      assert.equal(calls[FOREIGN], 0, 'a source in another language was asked about an English series');
      assert.equal(calls[DOWN], 1, 'the failing source was not tried once');
      assert.equal((await auto(ORDER))?.summary_from, FOLLOW, 'the next source was not asked after the failing one');
    });

    await t.test('only series that are kept updated', async () => {
      assert.equal((await auto(PAUSED))?.summary ?? null, null, 'a paused series was filled');
    });

    await t.test('filled-in genres are judged by the 18+ filter', async () => {
      // Reintroduce by reading the override and the scan alone in visibility.ts browsable(): ADULT stays listed.
      assert.deepEqual((await auto(ADULT))?.genres, ['Ecchi'], 'PREMISE: the genres were filled in');
      await q(`UPDATE server_settings SET adult_genres = '["ecchi"]'::jsonb WHERE id = 1`);
      V.invalidateAdultFilter();
      const hiding = { ...V.SYSTEM_CTX, hideAdultLibraries: true, adultGenres: ['ecchi'] };
      assert.equal((await V.browsableIds([ADULT], hiding)).has(ADULT), false, 'listed while Show 18+ is off');
      assert.equal((await V.browsableIds([ADULT], V.SYSTEM_CTX)).has(ADULT), true, 'the reveal does not bring it back');
      assert.equal((await V.browsableIds([SCANNED], hiding)).has(SCANNED), true, 'the filter took a series with other genres');
      await q(`UPDATE server_settings SET adult_genres = '[]'::jsonb WHERE id = 1`);
      V.invalidateAdultFilter();
    });

    await t.test('AniList: one batched request, linked and checked, in a library that looks it up, in English only', async () => {
      // Reintroduce by dropping the library's switch (`AND l.anilist_lookup` in fillDetailsFromAniList): 9002 is asked.
      assert.deepEqual(anilistAsked, [[9001]], `AniList was asked ${JSON.stringify(anilistAsked)}`);
      const a = await auto(AL_EN);
      assert.equal(a?.summary, 'First line. Second line.', 'the description was not cleaned');
      assert.deepEqual(a?.genres, ['Drama', 'Slice of Life']);
      assert.equal(a?.genres_from, 'anilist');
      assert.ok((await auto(AL_ES))?.anilist_at, 'a series in another language was not stamped, so it would be looked at every night');
      assert.equal((await auto(AL_ES))?.summary ?? null, null);
      assert.equal(await auto(AL_OFF), null, "a library whose AniList lookups are off was looked at");
      assert.equal(await auto(AL_UNCHECKED), null, 'an unchecked link was trusted');
    });

    await t.test('a series nobody can describe waits a month before it is asked again', async () => {
      assert.equal((await auto(NOAUTHOR))?.author ?? null, null, 'PREMISE: no source knew the author');
      assert.ok((await auto(NOAUTHOR))?.sources_at, 'it was not stamped');
      const before = { ...calls };
      const r = await run();
      assert.equal(calls[BARE], before[BARE], 'asked again the next night');
      assert.equal(calls[FOLLOW], before[FOLLOW], 'a filled series was asked again');
      assert.equal(anilistAsked.length, 1, 'AniList was asked again the next night');
      assert.equal(r.details.filled, 0);
      await q(`UPDATE series_auto_details SET sources_at = now() - interval '31 days' WHERE series_id = $1`, [NOAUTHOR]);
      await run();
      assert.equal(calls[BARE], before[BARE] + 1, 'not asked again after a month');
    });

    await t.test('a manual follow asks at once, past the stamp', async () => {
      await q(`INSERT INTO series_auto_details (series_id, sources_at) VALUES ($1, now()) ON CONFLICT (series_id) DO UPDATE SET sources_at = now()`, [FOLLOWME]);
      const plan = putPlan({
        seriesId: FOLLOWME, folder: `T!ad/${FOLLOWME}`, chapters: new Map(),
        candidates: [{ source: FOLLOW, name: 'Zzz', sourceSeriesId: 'f-9', title: 'Zzz Ad', count: 1, first: 1, last: 1, coverage: 1,
          matched: 1, fillable: [], newer: [], older: [], why: 'ok', pinned: false } as any],
      });
      const r = await app.inject({ method: 'POST', url: `/api/admin/series/${FOLLOWME}/sources`, headers: H,
        payload: { planId: plan.id, source: FOLLOW, sourceSeriesId: 'f-9' } });
      assert.equal(r.statusCode, 200, r.body);
      let a = null as Awaited<ReturnType<typeof auto>>;
      for (let i = 0; i < 50 && !a?.summary; i++) { await new Promise((res) => setTimeout(res, 100)); a = await auto(FOLLOWME); }
      assert.equal(a?.summary_from, FOLLOW, 'the follow did not fill the description in');
    });

    await t.test('switched off, everything it filled is taken back, the cover too', async () => {
      assert.equal((await setting(false)).statusCode, 200);
      assert.equal(await one('SELECT 1 FROM series_auto_details WHERE series_id = ANY($1)', [SERIES]), null);
      assert.equal((await one<{ cover: string | null }>('SELECT cover FROM series_art WHERE series_id = $1', [EMPTY]))?.cover ?? null, null);
      const m = await meta(EMPTY);
      assert.deepEqual([m.summary, m.genres, m.author], ['', [], ''], 'the series still shows what was filled in');
    });
  } finally {
    globalThis.fetch = realFetch;
    await app.close();
    await cleanup();
  }
});
