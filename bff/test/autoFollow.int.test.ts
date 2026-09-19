// Following the other sources at add time (#49), driven through the real add route and the lib.
//
// The manual follow keeps a person between the plan and the INSERT. This path has none, so every gate the
// person stood in for has to be a test: the candidate's OWN title must match (a dense sequel covers any
// series -- the wrong-book hazard lib/fill.ts exists for), the numbering must line up at 90 % -- BOTH ways
// unless the title is exactly ours and the primary lists enough to be sure of, because a sequel's title
// contains its parent's and lists every number the parent does -- a source that did not answer is never
// mistaken for one that lists nothing, the primary's listing stands in for a disk that holds nothing, no
// add may end with more than two followers however many candidates it names or how many adds race, and
// only an admin's add follows at all, since only an admin can unfollow. The sweep test closes the loop the
// feature was filed for: after an automatic follow, the next sweep takes the chapter only the follower
// lists.
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
  root = mkdtempSync(join(tmpdir(), 'yomi-af-'));
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UCHIYOMI_PING_URL = '';
  process.env.DL_ROOT = root;
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.MIN_FREE_GB = '0';
  process.env.SCAN_SEARCH_MS = '2000';
  process.env.SOLVER_BUDGET_MS = '800';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const TITLE = 'Followed Tale';
const PRIMARY = 'af-primary';  // 1..20, the series' own source
const SHORT = 'af-short';      // 1..2: a primary listing too short to measure against
const RICH = 'af-rich';        // 1..19 and 21: coverage 0.95, and one number nobody else has
const WRONG = 'af-wrong';      // 1..12: the same title, coverage 0.6
const SEQUEL = 'af-sequel';    // 1..20 under a different title: THE wrong-book fixture
const THROW = 'af-throw';      // listChapters throws
const HANG = 'af-hang';        // never answers
const THIRD = 'af-third';      // 1..20, good
const FOURTH = 'af-fourth';    // 1..20, good
const OFF = 'af-off';          // disabled by the admin
const ADULT = 'af-adult';      // 1..20, good, but an 18+ source
const SLOW = 'af-slow';        // 1..20, good, answers after a second: a judgement one can watch running
// The sequel guard's fixtures: each pair passes the title gate by containment and lists every number the
// other does, and each is the wrong book.
const TG = 'af-tg';            // "Tokyo Ghoul" 1..20, a primary
const TGRE = 'af-tgre';        // "Tokyo Ghoul:re" 1..60: the sequel, its title CONTAINS the primary's
const VIG = 'af-vig';          // "My Hero Academia: Vigilantes" 1..15, a spin-off primary
const MHA = 'af-mha';          // "My Hero Academia" 1..400: the main series, its title is INSIDE the primary's
const TINY = 'af-tiny';        // "Followed Tale" 1..3, a primary listing exactly MIN_HAVE numbers
const FIVE = 'af-five';        // "Followed Tale" 1..5, a primary listing under ONE_WAY_MIN_LISTED
const LONG = 'af-long';        // "Followed Tale" 1..300: the same name, 300 chapters
const OFFICIAL = 'af-official'; // "Followed Tale (Official)" 1..22: a decorated title two chapters ahead, the same book
const ADMIN = 'af-admin', MEMBER = 'af-member';
let q: any, app: any, auth: Record<string, string>, memberAuth: Record<string, string>;
let autoFollow: any, judgeCandidate: any, titleMatches: any, titleMatch: any, followable: any, norm: any, setDisabled: any;
/** How many times each fake was asked for its chapter list: whether a source was ASKED at all. */
const asks: Record<string, number> = {};
/** Which chapter ids the sweep fetched pages for, per source. */
const pages: Record<string, string[]> = {};

const PIXEL = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(400, 7)]);
const realFetch = globalThis.fetch;

const range = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
function fake(id: string, name: string, nums: number[], title = TITLE, extra: Record<string, unknown> = {}) {
  return {
    id, name,
    async search() { return [{ sourceId: `${id}-s`, source: id, title, coverUrl: undefined }]; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title }; },
    async listChapters() {
      asks[id] = (asks[id] ?? 0) + 1;
      return nums.map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `${id}-c${n}`, pages: 1 }));
    },
    async getPageUrls(chId: string) { (pages[id] ??= []).push(chId); return [`https://example.invalid/${chId}/p1.png`]; },
    async latest() { return []; },
    ...extra,
  };
}

before(async () => {
  if (!DSN) return;
  globalThis.fetch = (async (u: any, init?: any) => {
    if (String(u).includes('example.invalid')) return new Response(PIXEL, { status: 200, headers: { 'content-type': 'image/png' } });
    // The add's AniList art lookup is best effort and off-subject; answered here so a container with no
    // route out does not hold the process on a connect timeout after the last test.
    if (String(u).includes('anilist.co')) return new Response('{}', { status: 503 });
    return realFetch(u, init);
  }) as typeof fetch;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  ({ autoFollow, judgeCandidate, titleMatches, titleMatch } = (await import('../src/lib/autoFollow')) as any);
  ({ followable } = (await import('../src/lib/fill')) as any);
  ({ setDisabled } = (await import('../src/lib/sourceHealth')) as any);
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const sourcesMod = await import('../src/routes/sources');
  norm = sourcesMod.norm;
  const adminRoutes = (await import('../src/routes/admin')).default;
  const catalogRoutes = (await import('../src/routes/catalog')).default;
  await migrate();

  registerAdapter(fake(PRIMARY, 'Primary Source', range(1, 20)) as any);
  registerAdapter(fake(SHORT, 'Short Source', [1, 2]) as any);
  registerAdapter(fake(RICH, 'Rich Source', [...range(1, 19), 21]) as any);
  registerAdapter(fake(WRONG, 'Wrong Numbering', range(1, 12)) as any);
  registerAdapter(fake(SEQUEL, 'Sequel Source', range(1, 20), 'Another Story Entirely') as any);
  registerAdapter(fake(THROW, 'Throwing Source', [], TITLE, { async listChapters() { asks[THROW] = (asks[THROW] ?? 0) + 1; throw new Error('site refused'); } }) as any);
  registerAdapter(fake(HANG, 'Hanging Source', [], TITLE, {
    async getSeries() { return new Promise(() => {}); },
    async listChapters() { asks[HANG] = (asks[HANG] ?? 0) + 1; return new Promise(() => {}); },
  }) as any);
  registerAdapter(fake(THIRD, 'Third Source', range(1, 20)) as any);
  registerAdapter(fake(FOURTH, 'Fourth Source', range(1, 20)) as any);
  registerAdapter(fake(OFF, 'Off Source', range(1, 20)) as any);
  registerAdapter(fake(ADULT, 'Adult Source', range(1, 20), TITLE, { isNsfw: true }) as any);
  registerAdapter(fake(SLOW, 'Slow Source', range(1, 20), TITLE, {
    async listChapters() {
      asks[SLOW] = (asks[SLOW] ?? 0) + 1;
      await new Promise((r) => setTimeout(r, 1200));
      return range(1, 20).map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `${SLOW}-c${n}`, pages: 1 }));
    },
  }) as any);
  registerAdapter(fake(TG, 'TG Source', range(1, 20), 'Tokyo Ghoul') as any);
  registerAdapter(fake(TGRE, 'TGRE Source', range(1, 60), 'Tokyo Ghoul:re') as any);
  registerAdapter(fake(VIG, 'Vigilantes Source', range(1, 15), 'My Hero Academia: Vigilantes') as any);
  registerAdapter(fake(MHA, 'MHA Source', range(1, 400), 'My Hero Academia') as any);
  registerAdapter(fake(TINY, 'Tiny Source', range(1, 3)) as any);
  registerAdapter(fake(FIVE, 'Five Source', range(1, 5)) as any);
  registerAdapter(fake(LONG, 'Long Source', range(1, 300)) as any);
  registerAdapter(fake(OFFICIAL, 'Official Source', range(1, 22), 'Followed Tale (Official)') as any);
  await q('DELETE FROM source_health WHERE source_id LIKE $1', ['af-%']);
  await setDisabled(OFF, true);

  for (const u of [ADMIN, MEMBER]) await q('DELETE FROM users WHERE username = $1', [u]);
  const uid = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms, max_age_rating)
                        VALUES ($1,$1,'x','admin','password','{}',NULL) RETURNING id`, [ADMIN]))[0].id;
  const mid = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms, max_age_rating)
                        VALUES ($1,$1,'x','user','password','{}',12) RETURNING id`, [MEMBER]))[0].id;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(sourcesMod.default);
  await app.register(adminRoutes);
  await app.register(catalogRoutes);
  await app.ready();
  auth = { authorization: `Bearer ${app.jwt.sign({ sub: uid, role: 'admin' })}` };
  memberAuth = { authorization: `Bearer ${app.jwt.sign({ sub: mid, role: 'user' })}` };
});

after(async () => {
  globalThis.fetch = realFetch;
  if (root) rmSync(root, { recursive: true, force: true });
  if (!DSN) return;
  await app?.close();
  await q(`DELETE FROM lib_series WHERE source_id LIKE 'af-%' OR folder LIKE '%Source/Followed Tale%'`).catch(() => {});
  await q(`DELETE FROM users WHERE username = ANY($1)`, [[ADMIN, MEMBER]]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id LIKE $1', ['af-%']).catch(() => {});
  await q(`DELETE FROM audit_log WHERE event = 'series.follow_source' AND detail->>'title' = $1`, [TITLE]).catch(() => {});
});

/** A nothing-yet add of the title from a primary, with whatever `alsoFollow` the test wants; answers the id. */
async function addNothing(primary: string, alsoFollow?: any[], headers = auth): Promise<{ id: string; folder: string; res: any }> {
  const res = await app.inject({ method: 'POST', url: '/api/sources/add', headers,
    payload: { source: primary, sourceId: `${primary}-1`, chapterFrom: 'none', force: true, ...(alsoFollow ? { alsoFollow } : {}) } });
  assert.equal(res.statusCode, 200, `add answered ${res.statusCode}: ${res.body}`);
  assert.equal(res.json().nothing, true, `PREMISE: a fresh nothing-yet add, not "already in library": ${res.body}`);
  const folder = res.json().folder;
  const row = (await q('SELECT id FROM lib_series WHERE folder = $1', [folder]))[0];
  assert.ok(row, `no row for ${folder}`);
  return { id: row.id, folder, res: res.json() };
}
/** Poll the job strip until the folder's card says the judgement is done. */
async function judgementOf(folder: string, headers = auth): Promise<any> {
  const until = Date.now() + 15_000;
  let card: any;
  while (Date.now() < until) {
    const jobs = (await app.inject({ method: 'GET', url: '/api/sources/jobs', headers })).json().content;
    card = jobs.find((j: any) => j.folder === folder);
    if (card?.autoFollow?.done) return card;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`the card never finished judging: ${JSON.stringify(card)}`);
}
const followers = async (id: string) =>
  (await q('SELECT source_id, added_by, coverage, title FROM series_sources WHERE series_id = $1 ORDER BY created_at, source_id', [id]));
/** Drop the series and its job card: cards are keyed by folder and live five minutes, so the next test on
 *  the same title would otherwise poll the previous test's card. */
async function dropSeries(id: string, folder?: string): Promise<void> {
  await q('DELETE FROM lib_series WHERE id = $1', [id]);
  if (folder) await app.inject({ method: 'DELETE', url: `/api/sources/jobs/${encodeURIComponent(folder)}`, headers: auth });
}

// ---- the pure rule, no database ------------------------------------------------------------------------

test('followable() is coverage AND a verdict that the numbering lines up', async () => {
  // Reintroduce by testing coverage alone (`c.coverage >= MIN_COVERAGE`): the unreachable case reads true.
  const { followable: f } = await import('../src/lib/fill');
  assert.equal(f({ coverage: 0.89, why: 'ok' }), false, 'under the bar, whatever the verdict');
  assert.equal(f({ coverage: 0.9, why: 'nothing_to_fill' }), true, 'a fresh series has no gaps and is still followable');
  assert.equal(f({ coverage: 0.9, why: 'ok' }), true);
  assert.equal(f({ coverage: 1, why: 'unreachable' }), false, 'a source that never answered cannot be followed at any coverage');
  assert.equal(f({ coverage: 1, why: 'numbering_mismatch' }), false);
});

test('the title rule is the fill scan\'s: exact or contains after the same normalisation, never fuzzy', { skip }, async () => {
  const { titleMatches: tm } = await import('../src/lib/autoFollow');
  assert.equal(tm('followed tale', { title: 'Followed Tale' }), true, 'exact after normalisation');
  assert.equal(tm('Followed Tale (Official)', { title: 'Followed Tale' }), true, 'contains');
  assert.equal(tm('Tale', { title: 'Followed Tale' }), true, 'contained');
  assert.equal(tm('Another Story Entirely', { title: 'Followed Tale' }), false);
  // Reintroduce by accepting pickBestScored's token-overlap tier: 'Followed Tale Next Generation Story' shares
  // two of two meaningful words with 'Followed Tale Story' and would pass.
  assert.equal(tm('Followed Next Tale', { title: 'Followed Tale Story' }), false, 'token overlap is the tier a sequel passes');
  assert.equal(tm('Shingeki no Kyojin', { title: 'Attack on Titan', altTitles: ['Shingeki no Kyojin'] }), true, 'an alt title counts');
  assert.equal(tm('', { title: 'Followed Tale' }), false);
  assert.equal(tm('x-men', { title: 'X' }), false, 'a one-letter primary matches nothing by containment');
});

test('the title rule says WHICH tier matched, because a sequel passes the contains tier and only that one', { skip }, () => {
  // judgeCandidate trusts `exact` on the primary's numbers alone and makes `contains` prove itself both
  // ways. Reintroduce by answering 'exact' for a containment (return 'exact' where `contains = true` is
  // set): every sequel below reads exact, and the route test "a sequel whose title contains the primary's"
  // follows it at coverage 1.
  assert.equal(titleMatch('followed tale', { title: 'Followed Tale' }), 'exact');
  for (const sequel of ['Tokyo Ghoul:re', 'Tokyo Ghoul 2', 'Tokyo Ghoul Season 2', 'Ghoul']) {
    assert.equal(titleMatch(sequel, { title: 'Tokyo Ghoul' }), 'contains', sequel);
  }
  assert.equal(titleMatch('My Hero Academia', { title: 'My Hero Academia: Vigilantes' }), 'contains', 'the parent is inside the spin-off');
  assert.equal(titleMatch('Another Story Entirely', { title: 'Tokyo Ghoul' }), null);
  // A tracker's synonyms often carry the bare parent title beside the real one; a candidate EQUAL to any
  // of ours is exact, however many of the others it merely sits inside.
  assert.equal(titleMatch('Tokyo Ghoul', { title: 'Tokyo Ghoul:re', altTitles: ['Tokyo Ghoul'] }), 'exact', 'exact on an alt beats contains on the title');
  assert.equal(titleMatch('Tokyo Ghoul', { title: 'Tokyo Ghoul:re', altTitles: ['東京喰種:re'] }), 'contains');
});

test('the lib normalises titles exactly as routes/sources.ts norm() does', { skip }, () => {
  // The lib cannot import the route, so the rule is repeated; this pins the two. Reintroduce by changing
  // either regex.
  for (const [a, b] of [['Followed-Tale!!', 'followed tale'], ['Naru to', 'NARUTO'], ["It's Here", 'its here'], ['Ø Zero', 'zero']]) {
    assert.equal(titleMatches(a, { title: b }), norm(a) === norm(b), `${a} vs ${b}`);
  }
});

// ---- the add route ---------------------------------------------------------------------------------------

test('a nothing-yet add with alsoFollow judges every candidate after its listing and reports each on the job card', { skip }, async (t) => {
  for (const k of Object.keys(asks)) delete asks[k];
  const { id, folder, res } = await addNothing(PRIMARY, [
    { source: RICH, sourceId: 'r-1' }, { source: WRONG, sourceId: 'w-1' }, { source: SEQUEL, sourceId: 'q-1' },
    { source: THROW, sourceId: 't-1' }, { source: OFF, sourceId: 'o-1' }, { source: PRIMARY, sourceId: `${PRIMARY}-1` },
  ]);
  assert.deepEqual([res.chapters, res.nothing], [0, true], 'the add itself is the ordinary nothing-yet add');
  const card = await judgementOf(folder);
  const by = Object.fromEntries(card.autoFollow.results.map((r: any) => [r.source, r]));

  await t.test('the card exists only to carry the results, and finishes', async () => {
    assert.deepEqual([card.title, card.total, card.done, card.status], [TITLE, 0, 0, 'done'], JSON.stringify(card));
    assert.equal(card.autoFollow.results.length, 6, 'one line per candidate, in the order given');
    assert.deepEqual(card.autoFollow.results.map((r: any) => r.source), [RICH, WRONG, SEQUEL, THROW, OFF, PRIMARY]);
  });

  await t.test('a source listing 95 % of the numbers under the same title is followed, as automatic', async () => {
    // Reintroduce by reading `numbers` from lib_books instead of series_listing in autoFollow: a nothing-yet
    // series holds no book, so every candidate reads too_few_listed and nothing is followed.
    assert.deepEqual([by[RICH].followed, by[RICH].why, by[RICH].coverage, by[RICH].theirTitle, by[RICH].name],
      [true, 'followed', 0.95, TITLE, 'Rich Source'], JSON.stringify(by[RICH]));
    const rows = await followers(id);
    assert.deepEqual(rows.map((r: any) => [r.source_id, r.added_by, Number(r.coverage), r.title]), [[RICH, null, 0.95, TITLE]],
      'one follower, with no author: the automatic path\'s signature');
    const audit = (await q(`SELECT detail FROM audit_log WHERE event = 'series.follow_source' AND detail->>'id' = $1`, [id]))[0];
    assert.ok(audit, 'the follow is audited like a manual one');
    assert.equal(audit.detail.auto, true, `and says it was automatic: ${JSON.stringify(audit.detail)}`);
    assert.equal(audit.detail.source, RICH);
  });

  await t.test('and the series page shows it as followed for you, the primary as not', async () => {
    // Reintroduce by hardcoding `auto: false` in seriesSourcesFor: the follower reads false.
    const r = await app.inject({ method: 'GET', url: `/api/series/${id}`, headers: auth });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().sources.map((s: any) => [s.sourceId, s.primary, s.auto]), [[PRIMARY, true, false], [RICH, false, true]]);
  });

  await t.test('a source listing 60 % of the numbers reads numbering_differs and is not followed', async () => {
    // Reintroduce by dropping the `followable()` check in judgeCandidate (answer `ok` after the title
    // check): WRONG is followed at 0.6.
    assert.deepEqual([by[WRONG].followed, by[WRONG].why, by[WRONG].coverage], [false, 'numbering_differs', 0.6], JSON.stringify(by[WRONG]));
  });

  await t.test('a source with matching numbers under a DIFFERENT title reads title_differs and is not followed', async () => {
    // THE wrong-book guard. Reintroduce by dropping the `titleMatches` check in judgeCandidate: SEQUEL covers
    // every number and is followed at 1.0, and the next sweep would fetch its chapters under this title.
    assert.deepEqual([by[SEQUEL].followed, by[SEQUEL].why, by[SEQUEL].theirTitle, by[SEQUEL].coverage],
      [false, 'title_differs', 'Another Story Entirely', null], JSON.stringify(by[SEQUEL]));
    assert.ok(!(await followers(id)).some((r: any) => r.source_id === SEQUEL));
  });

  await t.test('a source that throws reads unreachable, never "lists nothing"', async () => {
    // Reintroduce by routing the lookups through seriesAndChapters (which swallows a throw into []): THROW
    // reads numbering_differs at coverage 0.
    assert.deepEqual([by[THROW].followed, by[THROW].why, by[THROW].coverage], [false, 'unreachable', null], JSON.stringify(by[THROW]));
  });

  await t.test('a disabled source and the primary itself are never asked', async () => {
    // Reintroduce by dropping the `disabled` check in judgeCandidate: OFF is asked once and followed; drop
    // the `c.source === row.source_id` check in autoFollow and the primary is followed as its own follower.
    assert.deepEqual([by[OFF].why, asks[OFF] ?? 0], ['unavailable', 0], JSON.stringify(by[OFF]));
    assert.deepEqual([by[PRIMARY].why, by[PRIMARY].followed], ['unavailable', false], JSON.stringify(by[PRIMARY]));
    assert.equal(asks[PRIMARY] ?? 0, 1, 'the primary was asked by the add itself, and not again by the judgement');
  });

  await t.test('the next sweep takes the chapter only the follower lists', async () => {
    // The loop the feature was filed for: RICH lists 21 and the primary does not. The nothing-yet add
    // floored the series just above 20, so the sweep wants exactly 21 -- from RICH, through the follower
    // row this add wrote. Reintroduce by dropping the INSERT from followUnderCap (answer 'inserted'
    // without writing): the sweep sees the primary's 1..20 alone, and `added` reads 0.
    const { updateSeries } = await import('../src/lib/updater');
    const { persistScan } = await import('../src/lib/library');
    pages[RICH] = [];
    const r = await updateSeries(id, 10);
    assert.equal(r.outcome, 'ok', JSON.stringify(r));
    assert.deepEqual(r.landed.map((l: any) => [l.number, l.source]), [[21, RICH]], `exactly the follower-only number, from the follower: ${JSON.stringify(r.landed)}`);
    assert.deepEqual(pages[RICH], [`${RICH}-c21`], 'fetched from the follower');
    await persistScan();
    const books = await q('SELECT number FROM lib_books WHERE series_id = $1 ORDER BY number', [id]);
    assert.deepEqual(books.map((b: any) => Number(b.number)), [21], 'the older 1..20 stay below the floor; 21 is on disk');
  });

  await t.test('a person confirming the automatic follower makes it theirs; the automatic path cannot take that back', async () => {
    // The sheet reads `auto` from added_by. Reintroduce the manual half by dropping `added_by = COALESCE(…)`
    // from the follow route's DO UPDATE in routes/admin.ts: the row keeps NULL and `auto` stays true after
    // a person chose it. Reintroduce the automatic half by dropping the COALESCE from followUnderCap: the
    // re-follow writes NULL over the admin's id and `auto` flips back to true.
    for (const n of [1, 2, 3]) {
      await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root) VALUES ($1,$2,'T!af',$3,$4,$5,'/library') ON CONFLICT (id) DO NOTHING`,
        [`b_af_${n}`, id, `${folder}/Chapter ${n}.cbz`, n, `Chapter ${n}`]);
    }
    const plan = (await app.inject({ method: 'POST', url: '/api/sources/fill/scan', headers: auth, payload: { seriesId: id } })).json();
    const rich = plan.candidates.find((c: any) => c.source === RICH);
    assert.ok(rich && rich.why !== 'unreachable', `PREMISE: the scan found RICH: ${JSON.stringify(plan.candidates?.map((c: any) => [c.source, c.why]))}`);
    const manual = await app.inject({ method: 'POST', url: `/api/admin/series/${id}/sources`, headers: auth,
      payload: { planId: plan.planId, source: RICH, sourceSeriesId: rich.sourceSeriesId } });
    assert.equal(manual.statusCode, 200, manual.body);
    assert.equal(manual.json().sources.find((s: any) => s.sourceId === RICH).auto, false, 'a human choice now');
    const who = (await followers(id)).find((r: any) => r.source_id === RICH).added_by;
    assert.ok(who, 'the admin is recorded');
    const again = await autoFollow(id, [{ source: RICH, sourceId: 'r-1' }]);
    assert.equal(again[0].why, 'followed', JSON.stringify(again));
    assert.equal((await followers(id)).find((r: any) => r.source_id === RICH).added_by, who, 'the automatic re-follow keeps the human\'s name');
    await q('DELETE FROM lib_books WHERE series_id = $1', [id]);
  });
  // The sweep left Chapter 21 on disk under this folder; a later test's persistScan would mint the folder
  // back as a series, and the next nothing-yet add of the title would read "already in library".
  rmSync(join(root, folder), { recursive: true, force: true });
  await dropSeries(id, folder);
});

test('a primary listing two chapters refuses everything as too_few_listed without asking a source', { skip }, async () => {
  // Reintroduce by dropping the MIN_HAVE check from autoFollow (and judgeCandidate): RICH is asked and
  // followed, since 1..2 is inside anything.
  const before = asks[RICH] ?? 0;
  const { id, folder } = await addNothing(SHORT, [{ source: RICH, sourceId: 'r-1' }, { source: THIRD, sourceId: '3-1' }]);
  const card = await judgementOf(folder);
  assert.deepEqual(card.autoFollow.results.map((r: any) => [r.source, r.why, r.coverage]), [[RICH, 'too_few_listed', null], [THIRD, 'too_few_listed', null]]);
  assert.equal(asks[RICH] ?? 0, before, 'never asked');
  assert.equal((await followers(id)).length, 0);
  await dropSeries(id, folder);
});

// ---- the sequel guard: numbering both ways unless the title is exactly ours on a long enough listing -----

test('a sequel whose title contains the primary\'s ("Tokyo Ghoul:re" for "Tokyo Ghoul") is not followed even though it lists every number', { skip }, async () => {
  // THE case the two-way rule was added for: ":re" 1..60 contains "Tokyo Ghoul" and lists all of its
  // 1..20, so the title gate and the one-way coverage both pass -- and the next sweep would then file
  // :re's 21..30 under Tokyo Ghoul. We list a third of what :re does, which is the number that decides.
  // Reintroduce by dropping the reverse coverage in judgeCandidate (`back` always 1): TGRE is followed at 1.
  const { id, folder } = await addNothing(TG, [{ source: TGRE, sourceId: 're-1' }]);
  const card = await judgementOf(folder);
  assert.deepEqual(card.autoFollow.results.map((r: any) => [r.source, r.followed, r.why, r.coverage, r.theirTitle]),
    [[TGRE, false, 'numbering_differs', 0.33, 'Tokyo Ghoul:re']], JSON.stringify(card.autoFollow));
  assert.equal((await followers(id)).length, 0, 'nothing for the sweep to take :re from');
  await dropSeries(id, folder);
});

test('the main series is not followed for a spin-off primary ("My Hero Academia" for "My Hero Academia: Vigilantes")', { skip }, async () => {
  // The other direction of containment: the parent's title sits INSIDE the spin-off's, and 1..400 covers
  // 1..15 entirely. Reintroduce as above: MHA is followed at 1, and the spin-off's next sweep takes 16..
  // from the main series.
  const { id, folder } = await addNothing(VIG, [{ source: MHA, sourceId: 'mha-1' }]);
  const card = await judgementOf(folder);
  assert.deepEqual(card.autoFollow.results.map((r: any) => [r.source, r.followed, r.why, r.coverage]),
    [[MHA, false, 'numbering_differs', 0.04]], JSON.stringify(card.autoFollow));
  assert.equal((await followers(id)).length, 0);
  await dropSeries(id, folder);
});

test('a same-titled 300-chapter work is not followed for a primary listing three or five numbers -- numbering_differs, not too_few_listed', { skip }, async (t) => {
  // An exact title on a short listing is not enough either: 1..3 sits inside every long work of the same
  // name, so under ONE_WAY_MIN_LISTED the candidate's numbers are measured too. MIN_HAVE stays 3: the
  // source IS asked, and the refusal names the numbering, not the listing. Reintroduce by dropping the
  // ONE_WAY_MIN_LISTED clause from judgeCandidate (`oneWay = match === 'exact'`): LONG follows both at 1.
  for (const [primary, listed, coverage] of [[TINY, 3, 0.01], [FIVE, 5, 0.02]] as const) {
    await t.test(`a primary listing ${listed}`, async () => {
      const before = asks[LONG] ?? 0;
      const { id, folder } = await addNothing(primary, [{ source: LONG, sourceId: 'l-1' }]);
      const card = await judgementOf(folder);
      assert.deepEqual(card.autoFollow.results.map((r: any) => [r.source, r.followed, r.why, r.coverage]),
        [[LONG, false, 'numbering_differs', coverage]], JSON.stringify(card.autoFollow));
      assert.equal(asks[LONG], before + 1, 'asked: the floor is MIN_HAVE, and this listing is over it');
      assert.equal((await followers(id)).length, 0);
      await dropSeries(id, folder);
    });
  }
});

test('a decorated title two chapters ahead ("Followed Tale (Official)" 1..22 for 1..20) still follows: 20 of 22 is 0.91', { skip }, async () => {
  // The rule must not throw out the sources it exists for: a `contains` match whose listing coincides
  // with ours both ways is the same book under a decorated name. The reported coverage is the lower
  // share, and the follower row carries it. Reintroduce by refusing every `contains` match in
  // judgeCandidate (exact-only), or by demanding 1.0 the other way: OFFICIAL is refused.
  const { id, folder } = await addNothing(PRIMARY, [{ source: OFFICIAL, sourceId: 'of-1' }]);
  const card = await judgementOf(folder);
  assert.deepEqual(card.autoFollow.results.map((r: any) => [r.source, r.followed, r.why, r.coverage, r.theirTitle]),
    [[OFFICIAL, true, 'followed', 0.91, 'Followed Tale (Official)']], JSON.stringify(card.autoFollow));
  assert.deepEqual((await followers(id)).map((r: any) => [r.source_id, Number(r.coverage)]), [[OFFICIAL, 0.91]]);
  await dropSeries(id, folder);
});

test('an exact title on a long enough listing is judged on the primary\'s numbers alone: "Followed Tale" 1..300 follows "Followed Tale" 1..20', { skip }, async () => {
  // The one-way half, kept on purpose: the same book further along is exactly what following is for, and
  // an exact title on twenty agreeing numbers is no coincidence. Reintroduce by measuring both ways for
  // every match (`oneWay = false`): LONG reads numbering_differs at 0.07 and nothing long ever follows.
  const { id, folder } = await addNothing(PRIMARY, [{ source: LONG, sourceId: 'l-1' }]);
  const card = await judgementOf(folder);
  assert.deepEqual(card.autoFollow.results.map((r: any) => [r.source, r.followed, r.why, r.coverage]),
    [[LONG, true, 'followed', 1]], JSON.stringify(card.autoFollow));
  assert.deepEqual((await followers(id)).map((r: any) => r.source_id), [LONG]);
  await dropSeries(id, folder);
});

// ---- the card while the judgement runs -------------------------------------------------------------------

test('a carrier card cannot be dismissed while its judgement runs: DELETE answers 409 running, then 200 once done', { skip }, async () => {
  // Dropping the card mid-judgement would let the follow land with its report gone, and the dialog polls
  // the card until it reads done. Reintroduce by dropping the `j.autoFollow && !j.autoFollow.done` clause
  // from the DELETE route: the first DELETE answers 200.
  const { id, folder } = await addNothing(PRIMARY, [{ source: SLOW, sourceId: 'sl-1' }]);
  const during = await app.inject({ method: 'DELETE', url: `/api/sources/jobs/${encodeURIComponent(folder)}`, headers: auth });
  assert.deepEqual([during.statusCode, during.json().error], [409, 'running'], during.body);
  const card = await judgementOf(folder);
  assert.deepEqual(card.autoFollow.results.map((r: any) => [r.source, r.why]), [[SLOW, 'followed']], 'PREMISE: the judgement finished and followed');
  const after_ = await app.inject({ method: 'DELETE', url: `/api/sources/jobs/${encodeURIComponent(folder)}`, headers: auth });
  assert.equal(after_.statusCode, 200, after_.body);
  await dropSeries(id);
});

test('when the judgement itself throws, every candidate reads not_tried rather than the card reading done with nothing', { skip }, async () => {
  // lib/autoFollow.ts answers every failure of a candidate's own as a value; a rejection of the whole
  // judgement is the one path that would leave `done: true, results: []`, which the dialog prints as
  // nothing at all. Faked the way visibilityFailsClosed does: the column the judgement reads for the
  // series' preferences is taken away for a moment, which is a genuine query failure on the genuine
  // path -- the add itself never reads it. Reintroduce by dropping the `refusals(...)` line from
  // judgeAlsoFollow's catch: the card finishes with no results.
  const before = { rich: asks[RICH] ?? 0, third: asks[THIRD] ?? 0 };
  await q('ALTER TABLE lib_series RENAME COLUMN scanlator_prefs TO scanlator_prefs__hidden');
  let id = '', folder = '';
  try {
    ({ id, folder } = await addNothing(PRIMARY, [{ source: RICH, sourceId: 'r-1' }, { source: THIRD, sourceId: '3-1' }]));
    const card = await judgementOf(folder);
    assert.deepEqual(card.autoFollow.results.map((r: any) => [r.source, r.name, r.followed, r.why, r.coverage]),
      [[RICH, 'Rich Source', false, 'not_tried', null], [THIRD, 'Third Source', false, 'not_tried', null]], JSON.stringify(card.autoFollow));
  } finally {
    await q('ALTER TABLE lib_series RENAME COLUMN scanlator_prefs__hidden TO scanlator_prefs');
  }
  assert.deepEqual([asks[RICH] ?? 0, asks[THIRD] ?? 0], [before.rich, before.third], 'no source was asked, which is what not_tried says');
  assert.equal((await followers(id)).length, 0);
  await dropSeries(id, folder);
});

// ---- who may follow -------------------------------------------------------------------------------------

test('a member\'s alsoFollow is ignored: no judgement, no follower, the add succeeds', { skip }, async () => {
  // Following is an admin act -- the manual route and the sheet's unfollow are admin-only, so a member
  // whose add followed a source could never undo it. The body is dropped before the add, so a member's
  // nothing-yet add mints no card at all. Reintroduce by passing `b.data.alsoFollow` whatever the role in
  // the add route: a card appears and RICH is followed for the member.
  const before = asks[RICH] ?? 0;
  const { id, folder } = await addNothing(PRIMARY, [{ source: RICH, sourceId: 'r-1' }, { source: THIRD, sourceId: '3-1' }], memberAuth);
  // Read as the admin: the strip hides a capped member's own card behind the library's age rating (the
  // jobs route's browsable() filter), and this test is about whether a card exists at all.
  const jobs = (await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: auth })).json().content;
  assert.ok(!jobs.some((j: any) => j.folder === folder), `a member's add minted a carrier card: ${JSON.stringify(jobs)}`);
  assert.equal(asks[RICH] ?? 0, before, 'never asked');
  assert.equal((await followers(id)).length, 0);
  await dropSeries(id, folder);
});

test('a plain nothing-yet add still mints no card, and the body cannot name more candidates than are ever asked', { skip }, async (t) => {
  await t.test('no alsoFollow, no card', async () => {
    const { id, folder } = await addNothing(PRIMARY);
    const jobs = (await app.inject({ method: 'GET', url: '/api/sources/jobs', headers: auth })).json().content;
    assert.ok(!jobs.some((j: any) => j.folder === folder), `a card with nothing to carry: ${JSON.stringify(jobs)}`);
    await dropSeries(id, folder);
  });
  await t.test('seven candidates is a 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/sources/add', headers: auth,
      payload: { source: PRIMARY, sourceId: `${PRIMARY}-1`, chapterFrom: 'none', alsoFollow: Array.from({ length: 7 }, (_, i) => ({ source: `s${i}`, sourceId: 'x' })) } });
    assert.equal(r.statusCode, 400, r.body);
  });
  await t.test('a candidate with an empty source is a 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/sources/add', headers: auth,
      payload: { source: PRIMARY, sourceId: `${PRIMARY}-1`, chapterFrom: 'none', alsoFollow: [{ source: '', sourceId: 'x' }] } });
    assert.equal(r.statusCode, 400, r.body);
  });
});

test('at most two followers: three good candidates follow two, and two adds racing each other cannot exceed two', { skip }, async (t) => {
  await t.test('the third good candidate reads cap, in the order the candidates were given', async () => {
    // Reintroduce by dropping the `WHERE (SELECT count(*) …)` clause from followUnderCap: three rows.
    const { id } = await addNothing(PRIMARY);
    const results = await autoFollow(id, [{ source: RICH, sourceId: 'r-1' }, { source: THIRD, sourceId: '3-1' }, { source: FOURTH, sourceId: '4-1' }]);
    assert.deepEqual(results.map((r: any) => [r.source, r.followed, r.why]), [[RICH, true, 'followed'], [THIRD, true, 'followed'], [FOURTH, false, 'cap']], JSON.stringify(results));
    assert.deepEqual((await followers(id)).map((r: any) => r.source_id), [RICH, THIRD]);
    await dropSeries(id);
  });
  await t.test('two concurrent judgements of the same series end at two followers, not four', async () => {
    // Reintroduce by dropping the count clause from followUnderCap's INSERT: six follows land and the
    // series ends with three. (The `FOR UPDATE` beside it closes a window this test cannot open -- two
    // INSERTs evaluating the count in the same instant -- and is not what this assertion measures.)
    const { id } = await addNothing(PRIMARY);
    const cands = [{ source: RICH, sourceId: 'r-1' }, { source: THIRD, sourceId: '3-1' }, { source: FOURTH, sourceId: '4-1' }];
    const [a, b] = await Promise.all([autoFollow(id, cands), autoFollow(id, [...cands].reverse())]);
    const rows = await followers(id);
    assert.equal(rows.length, 2, `followers: ${rows.map((r: any) => r.source_id)}; a=${JSON.stringify(a.map((r: any) => r.why))} b=${JSON.stringify(b.map((r: any) => r.why))}`);
    assert.equal([...a, ...b].filter((r: any) => r.followed).length >= 2, true, 'every follow that landed is reported as one');
    await dropSeries(id);
  });
});

test('a source that outruns the wall is not_tried; one that outruns its own budget is unreachable', { skip }, async (t) => {
  const { id } = await addNothing(PRIMARY);
  await t.test('the wall: the hanging source and the one queued behind it are both "not checked"', async () => {
    // Reintroduce by dropping the `remaining < MIN_TRY_MS` check and the outer withTimeout in autoFollow:
    // the add waits the hanging source's whole 20 s budget out, and THIRD is then judged and followed.
    // The wall is MIN_TRY_MS plus a little, not 300 ms: HANG must be started (the wall is measured
    // mid-flight, at the cut), and THIRD must then find less than MIN_TRY_MS left whatever the clocks say
    // -- at 300 ms the two clocks' 1-2 ms disagreement let THIRD through on CI, and this test went red on
    // the release push while passing locally every time.
    const beforeThird = asks[THIRD] ?? 0;
    const t0 = Date.now();
    const results = await autoFollow(id, [{ source: HANG, sourceId: 'h-1' }, { source: THIRD, sourceId: '3-1' }], { wallMs: 2_500, concurrency: 1 });
    const took = Date.now() - t0;
    assert.ok(took >= 2_000 && took < 10_000, `HANG was started and cut at the wall, not refused up front or waited out: ${took} ms`);
    assert.deepEqual(results.map((r: any) => [r.source, r.why, r.followed]), [[HANG, 'not_tried', false], [THIRD, 'not_tried', false]], JSON.stringify(results));
    assert.equal(asks[THIRD] ?? 0, beforeThird, 'THIRD never got its turn');
    assert.equal((await followers(id)).length, 0);
  });
  await t.test('the per-source budget: a hanging source alone reads unreachable', async () => {
    const results = await autoFollow(id, [{ source: HANG, sourceId: 'h-1' }], { lookupMs: 200, wallMs: 5_000 });
    assert.deepEqual(results.map((r: any) => [r.source, r.why]), [[HANG, 'unreachable']], JSON.stringify(results));
  });
  await t.test('a deleted series refuses everything without asking', async () => {
    const before = asks[THIRD] ?? 0;
    await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [id]);
    const results = await autoFollow(id, [{ source: THIRD, sourceId: '3-1' }]);
    assert.deepEqual(results.map((r: any) => r.why), ['unavailable']);
    assert.equal(asks[THIRD] ?? 0, before);
  });
  await dropSeries(id);
});

test('a download add carries the results on its job card, judged against the listing rather than the one chapter on disk', { skip }, async () => {
  // The listing holds 1..20 the moment chapter 1 lands; lib_books holds one. Reintroduce by reading
  // `numbers` from lib_books in autoFollow: RICH reads too_few_listed.
  const res = await app.inject({ method: 'POST', url: '/api/sources/add', headers: auth,
    payload: { source: THIRD, sourceId: `${THIRD}-1`, chapterCount: 1, force: true, alsoFollow: [{ source: RICH, sourceId: 'r-1' }, { source: SEQUEL, sourceId: 'q-1' }] } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual([res.json().started, res.json().chapters], [true, 1]);
  const card = await judgementOf(res.json().folder);
  assert.equal(card.title, TITLE);
  assert.deepEqual(card.autoFollow.results.map((r: any) => [r.source, r.why, r.coverage]), [[RICH, 'followed', 0.95], [SEQUEL, 'title_differs', null]], JSON.stringify(card));
  const id = (await q('SELECT id FROM lib_series WHERE folder = $1', [res.json().folder]))[0].id;
  assert.deepEqual((await followers(id)).map((r: any) => [r.source_id, r.added_by]), [[RICH, null]]);
  // The download's own card kept its shape: the judgement rode along.
  assert.ok(['downloading', 'done'].includes(card.status), card.status);
  assert.equal(card.total, 1);
  await dropSeries(id, res.json().folder);
});

test('a source the caller may not reach is unavailable and never asked, whatever it lists', { skip }, async () => {
  // The lib's half of the age cap: `allowed` is asked before any network. Through the route the cap can
  // no longer bite -- `alsoFollow` is admin-only and an admin is exempt from the cap (lib/visibility.ts)
  // -- but the route still wires it, so this is what a capped caller would get the day the switch is
  // offered to one again. Reintroduce by dropping the `opts.allowed` check from autoFollow: ADULT is
  // asked and followed.
  const before = asks[ADULT] ?? 0;
  const { id } = await addNothing(PRIMARY);
  const results = await autoFollow(id, [{ source: ADULT, sourceId: 'a-1' }, { source: THIRD, sourceId: '3-1' }], { allowed: (s: string) => s !== ADULT });
  assert.deepEqual(results.map((r: any) => [r.source, r.why]), [[ADULT, 'unavailable'], [THIRD, 'followed']], JSON.stringify(results));
  assert.equal(asks[ADULT] ?? 0, before, 'never asked');
  assert.deepEqual((await followers(id)).map((r: any) => r.source_id), [THIRD]);
  await dropSeries(id);
});

test('judgeCandidate on its own reads the source\'s health and refuses a source in a cooldown', { skip }, async () => {
  // Reintroduce by dropping the `blocked_until` check in judgeCandidate: FOURTH is asked and reads ok.
  await q(`INSERT INTO source_health (source_id, status, blocked_until, updated_at) VALUES ($1, 'blocked', now() + interval '1 hour', now())
           ON CONFLICT (source_id) DO UPDATE SET blocked_until = now() + interval '1 hour'`, [FOURTH]);
  try {
    const before = asks[FOURTH] ?? 0;
    const primary = { title: TITLE, altTitles: [], numbers: range(1, 20) };
    const j = await judgeCandidate(primary, { source: FOURTH, sourceId: '4-1' });
    assert.equal(j.why, 'unavailable', JSON.stringify(j));
    assert.equal(asks[FOURTH] ?? 0, before);
    const ok = await judgeCandidate(primary, { source: THIRD, sourceId: '3-1' });
    assert.deepEqual([ok.why, ok.coverage, ok.theirTitle, ok.name], ['ok', 1, TITLE, 'Third Source'], JSON.stringify(ok));
    const gone = await judgeCandidate(primary, { source: 'af-nowhere', sourceId: 'x' });
    assert.deepEqual([gone.why, gone.name], ['unavailable', 'af-nowhere'], 'an unregistered source is named by its id');
    // Its own floor, for a caller that is not autoFollow. Reintroduce by dropping the MIN_HAVE check in
    // judgeCandidate: THIRD is asked and reads ok at coverage 1.
    const asked = asks[THIRD] ?? 0;
    const few = await judgeCandidate({ ...primary, numbers: [1, 2] }, { source: THIRD, sourceId: '3-1' });
    assert.deepEqual([few.why, asks[THIRD] ?? 0], ['too_few_listed', asked], JSON.stringify(few));
  } finally {
    await q('DELETE FROM source_health WHERE source_id = $1', [FOURTH]);
  }
});
