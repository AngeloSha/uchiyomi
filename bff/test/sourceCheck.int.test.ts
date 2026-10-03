// #115, "Source health not working", end to end: a source that fails its Test shows on Health, by name, with the
// stage and the engine's message -- and nothing a Test or the daily check does ever changes a cooldown.
//
// The reporter's screenshots, in order: Admin → Providers → Test on "Manga Ball (EN)" failed ("The extension server
// did not answer. This is the Suwayomi extension server, not the site. Check that container."), its card still said
// "ok", and Health said "All good". The engine had answered -- with the extension's own Java exception about the
// site. Driven here through the real routes and the real Suwayomi adapter against the shared fake engine
// (test/fixtures/fakeSuwayomi.ts), whose Manga Ball search answers that exception verbatim.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeSuwayomi, SOURCE_IDS, type FakeSuwayomi } from './fixtures/fakeSuwayomi';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  // A sweep over a source that never answers must end in a test's time, not in 45 s.
  process.env.SOURCE_TEST_TIMEOUT_MS = '1500';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const BALL = `sw:${SOURCE_IDS.mangaBall}`;
const ODD = 'sc-odd', SLOW = 'sc-slow', STREAK = 'sc-streak', LOOKUP = 'sc-lookup', LOOKUP_OK = 'sc-lookup-ok';
const ENGINE_WORDS = /^suwayomi: Exception while fetching data \(\/fetchSourceManga\) : java\.lang\.Exception/;
const ADMIN = 'sc-admin';

let fake: FakeSuwayomi;
let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let app: any, adminTok = '';
let sh: typeof import('../src/lib/sourceHealth');
let runHealthChecks: typeof import('../src/lib/health').runHealthChecks;
/** How sc-odd fails: at search with an error nobody has seen, or at pages. */
let oddMode: 'search' | 'pages' = 'search';

before(async () => {
  if (!DSN) return;
  fake = await startFakeSuwayomi();
  process.env.SUWAYOMI_URL = fake.url; // ⚠️ before any src module loads: env.ts parses it once
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  sh = await import('../src/lib/sourceHealth');
  ({ runHealthChecks } = await import('../src/lib/health'));
  await migrate();
  const { registerAdapter } = await import('../src/lib/sources');
  const { listRemoteSources, makeSuwayomiAdapter } = await import('../src/lib/sources/suwayomi/sources');
  const remote = (await listRemoteSources()).find((s) => s.id === SOURCE_IDS.mangaBall)!;
  registerAdapter(makeSuwayomiAdapter(remote));
  registerAdapter({
    id: ODD, name: 'Odd Source',
    async search() { if (oddMode === 'search') throw new Error('the parser met something new'); return [{ sourceId: 'o1', source: ODD, title: 'Odd' }]; },
    async getSeries(id: string) { return { sourceId: id, source: ODD, title: 'Odd' }; },
    async listChapters() { return [{ sourceId: 'oc1', number: 1 }]; },
    async getPageUrls() { throw new Error('page list gone'); },
  } as any);

  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[BALL, ODD, SLOW, STREAK, LOOKUP, LOOKUP_OK]]);
  await q('DELETE FROM users WHERE username = $1', [ADMIN]);
  const [{ id: uid }] = await q<{ id: string }>(
    `INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ($1,$1,'admin','x','password') RETURNING id`, [ADMIN]);
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  adminTok = `Bearer ${app.jwt.sign({ sub: uid, role: 'admin' })}`;
});

after(async () => {
  if (!DSN) return;
  (await import('../src/lib/healthSummary')).setSummaryRefresh();
  await app?.close();
  await q('DELETE FROM source_health WHERE source_id = ANY($1::text[])', [[BALL, ODD, SLOW, STREAK, LOOKUP, LOOKUP_OK]]).catch(() => {});
  await q('DELETE FROM users WHERE username = $1', [ADMIN]).catch(() => {});
  await fake?.close();
  // The pool's idle clients (30 s) and the header refresh a Test schedules would otherwise hold the process a
  // minute past the last test.
  await (await import('../src/lib/db')).pool.end().catch(() => {});
});

const row = async (id: string) => (await q('SELECT * FROM source_health WHERE source_id = $1', [id]))[0];
const sourcesCheck = async () => (await runHealthChecks()).checks.find((c) => c.id === 'sources')!;
const itemOf = (c: any, id: string) => c.items.find((i: any) => i.sourceId === id);
const inject = (method: string, url: string, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { authorization: adminTok, ...headers } });
const pause = (ms: number) => new Promise((res) => setTimeout(res, ms));

test('THE #115 SHAPE: a source that fails its Test is on Health, by name, with the stage and the message', { skip }, async () => {
  fake.setMode({ mode: 'extension_error', source: SOURCE_IDS.mangaBall, stage: 'search' });
  // As the reporter's row stood: 'ok', no cooldown, an old copy of the same words from a Discover search, and no
  // series on it -- the case v0.41.0 greyed as "a source NOTHING uses".
  await q(`INSERT INTO source_health (source_id, status, consecutive, last_error, last_fail_at, last_ok_at)
           VALUES ($1, 'ok', 0, $2, now() - interval '3 days', now() - interval '2 days')`,
    [BALL, 'suwayomi: Exception while fetching data (/fetchSourceManga) : java.lang.Exception']);

  // Three impatient clicks.
  let body: any;
  for (let i = 0; i < 3; i++) {
    const r = await inject('POST', `/api/admin/sources/${encodeURIComponent(BALL)}/test`);
    assert.equal(r.statusCode, 200, r.body);
    body = r.json();
  }
  assert.equal(body.ok, false);
  assert.equal(body.state, 'fail');
  assert.equal(body.stage, 'search');
  assert.equal(body.recorded, true);
  // Reintroduce the old catch-all rule and this reads upstream_down, "Check that container".
  assert.equal(body.diagnosis.code, 'extension_error', JSON.stringify(body.diagnosis));
  assert.doesNotMatch(body.diagnosis.fix, /Check that container/);
  assert.match(body.checks[0].error, ENGINE_WORDS, 'the engine message reaches the admin whole');
  assert.equal(fake.graphqlCalls('fetchSourceManga').length, 3, 'one search per click: the engine answered, so no other terms');

  const h = await row(BALL);
  // Reintroduce (2) by adding reportFail to the route: consecutive is 3 and the source is in a cooldown.
  assert.equal(h.status, 'ok', 'a Test never changes the status');
  assert.equal(h.consecutive, 0, 'three clicks, no escalation');
  assert.equal(h.blocked_until, null);
  // Reintroduce (3) by stamping checked_at from recordLive: the desktop app would postpone its daily check.
  assert.equal(h.checked_at, null, 'a Test never moves the daily check');
  assert.equal(h.live_state, 'fail');
  assert.equal(h.live_stage, 'search');
  assert.equal(h.live_by, 'test');
  assert.equal(h.stages.search.failBy, 'test');
  assert.match(h.stages.search.error, ENGINE_WORDS);

  // Reintroduce (1) by skipping recordLiveResult in the route: the item is missing.
  const c = await sourcesCheck();
  const it = itemOf(c, BALL);
  assert.ok(it, `Health lists it (${c.summary})`);
  // Reintroduce (4) with `title: r.source_id`: the title is sw:6716343437498271985.
  assert.equal(it.title, 'Manga Ball (EN)', 'by name, not sw:<id>');
  // Reintroduce (5) by keeping "unused -> info" for live findings: this reads info.
  assert.notEqual(it.info, true, 'a failed Test is a finding even with no series on the source');
  assert.equal(c.status, 'warn');
  // Reintroduce the old join (`${d.reason}${tested}; ${uses}`): the detail reads "…reported an error.; last tested".
  assert.match(it.detail,
    /^Search failing since \d{4}-\d\d-\d\d \d\d:\d\d — This source's extension reported an error\. Last tested .* by Test; no series use it$/,
    it.detail);
  assert.doesNotMatch(it.detail, /\.;/, 'a period, then a semicolon');
  // v0.49.1: the same line as its codes (lib/said.ts), which the page words in the reader's language and time zone:
  // the stage and when as data, the reason by its diagnosis code, the fix by its own. Reintroduce the English-only
  // detail: this finds no codes.
  const { englishOf } = await import('../src/lib/said');
  assert.deepEqual(it.detailSaid.map((s: any) => s.code), ['sources.failing', 'sources.reason', 'sources.tested', 'sources.uses']);
  assert.equal(englishOf(it.detailSaid), it.detail, 'the codes say something else');
  assert.deepEqual(it.detailSaid[0].params.stage, 'search');
  assert.ok(!Number.isNaN(Date.parse(it.detailSaid[0].params.since)), 'the time is sent as a moment, not as UTC words');
  assert.match(it.diagnosis.fixSaid?.code ?? '', /^fix\.extensionFailed$/);
  assert.equal(it.evidence.find((e: any) => e.stage === 'search').state, 'fail');
  assert.match(it.evidence.find((e: any) => e.stage === 'search').error, ENGINE_WORDS);
  assert.equal(it.diagnosis.code, 'extension_error');
  assert.equal(it.tested.by, 'test');
  assert.equal(it.series, 0);
  // v0.53.0: its group on the card and its one state, as data -- a failed Test on a source nothing uses, at the search
  // step -- and the extension's own logo.
  assert.deepEqual([it.group, it.state, it.stage, it.icon], ['unused', 'failing', 'search', true]);
  assert.equal(it.key, `source:${BALL}`);
  assert.deepEqual(it.actions, ['test', 'disable', 'ignore']);
  assert.doesNotMatch(c.summary, /All sources (responding normally|are working)/);
  assert.match(c.summary, /\d+ sources? nothing uses (is|are) failing/, 'the summary counts it among the failing sources nothing uses');
  assert.ok(c.testMs >= 1500, 'Health can say how long a Test may take');

  // GET /api/admin/sources carries it for the Providers card; the public status is untouched.
  const admin = (await inject('GET', '/api/admin/sources')).json();
  const mine = admin.content.find((r: any) => r.source_id === BALL);
  assert.deepEqual(mine.failing.map((f: any) => [f.stage, f.by, f.kind]), [['search', 'test', 'error']]);
  assert.equal(mine.live.state, 'fail');
  assert.equal(mine.status, 'ok');
  // The card draws its stage lines from the same reading Health's row does, and its Test clock from the same limit.
  // Reintroduce by dropping `evidence` (or `testMs`) from the route: the card has no ✗ Search line (or no clock).
  assert.ok(Array.isArray(mine.evidence), 'the Providers card has no stage lines');
  assert.deepEqual(mine.evidence.map((e: any) => [e.stage, e.state]), it.evidence.map((e: any) => [e.stage, e.state]));
  assert.equal(mine.evidence.find((e: any) => e.stage === 'search').state, 'fail', 'the Providers card has its ✗ Search line');
  assert.equal(admin.testMs, c.testMs, 'the Test button and Health agree on how long a Test may take');
});

test('stage-aware clearing: a download does not close a search failure, a search does', { skip }, async () => {
  // Reintroduce by making reportOk (or clearBlock) clear `stages` or `live_state`: the first assertion finds the
  // failure erased by a download, which is the #115 shape itself.
  await sh.reportOk(BALL);
  await sh.clearBlock(BALL);
  await sh.noteStage(BALL, 'pages', 'ok');
  await sh.noteStage(BALL, 'images', 'ok');
  let it = itemOf(await sourcesCheck(), BALL);
  assert.ok(it && !it.info, 'still failing: nothing has searched successfully since');
  assert.equal(it.evidence.find((e: any) => e.stage === 'images').state, 'ok');

  // One failed Discover search in between keeps it failing, and keeps it the Test's confirmed failure.
  await sh.noteStage(BALL, 'search', 'fail', { error: 'suwayomi: again' });
  assert.equal((await row(BALL)).stages.search.failBy, 'test', 'a traffic failure does not demote a confirmed one');

  await sh.noteStage(BALL, 'search', 'ok');
  it = itemOf(await sourcesCheck(), BALL);
  assert.ok(!it || it.info, 'a search that works closes it');
});

test('the sweep reports what the button reports, and pushes a failure once', { skip }, async () => {
  // Reintroduce by filtering needsAttention through the old ACTIONABLE code set: 'unknown' is not in it and the
  // odd source is missing. Or by dropping the previous-verdict comparison: the second sweep notifies again.
  const { runSourceCheck } = await import('../src/lib/sourceWatchdog');
  fake.setMode({ mode: 'extension_error', source: SOURCE_IDS.mangaBall, stage: 'search' });
  oddMode = 'search';
  const first = await runSourceCheck({ autoFix: false });
  const odd = first.sources.find((v) => v.id === ODD)!;
  assert.equal(odd.code, 'unknown');
  assert.equal(odd.state, 'fail');
  assert.equal(odd.stage, 'search');
  assert.ok(first.needsAttention.some((v) => v.id === ODD), 'a failure nobody has seen before still needs attention');
  assert.ok(first.notified.includes(ODD), 'and is pushed');
  const ball = first.sources.find((v) => v.id === BALL)!;
  assert.equal(ball.code, 'extension_error');
  assert.ok(first.needsAttention.some((v) => v.id === BALL));
  // The sweep writes the stamp the schedule reads, and never 'ok' for a failed test.
  const h = await row(ODD);
  assert.ok(h.checked_at);
  assert.equal(h.check_code, 'unknown');
  assert.equal(h.live_by, 'sweep');
  assert.equal(h.consecutive, 0, 'and no cooldown');

  const second = await runSourceCheck({ autoFix: false });
  assert.ok(second.needsAttention.some((v) => v.id === ODD), 'still failing, still listed');
  assert.deepEqual(second.notified, [], 'the same failure is not pushed every day');

  oddMode = 'pages';
  const third = await runSourceCheck({ autoFix: false });
  assert.equal(third.sources.find((v) => v.id === ODD)!.stage, 'pages');
  assert.deepEqual(third.notified, [ODD], 'failing somewhere new is news again');
});

test('an inconclusive test is greyed, never amber', { skip }, async () => {
  // Reintroduce by recording kind 'timeout' as a stage failure (liveStagesPatch): the row becomes a warn finding.
  const { registerAdapter, getSource } = await import('../src/lib/sources');
  const { checkSourceLive, recordLiveResult } = await import('../src/lib/sourceCheck');
  registerAdapter({
    id: SLOW, name: 'Slow Source',
    search: () => new Promise(() => {}),
    async getSeries() { return null; }, async listChapters() { return []; }, async getPageUrls() { return []; },
  } as any);
  const r = await checkSourceLive(getSource(SLOW)!, { by: 'test', timeoutMs: 200 });
  assert.equal(r.state, 'inconclusive');
  assert.equal(r.diagnosis.code, 'timeout');
  await recordLiveResult(SLOW, r, 'test');
  const h = await row(SLOW);
  assert.equal(h.live_state, 'inconclusive');
  assert.equal(h.stages.search, undefined, 'our deadline is not a failure of the search');
  const it = itemOf(await sourcesCheck(), SLOW);
  assert.ok(it, 'listed');
  assert.equal(it.info, true, 'greyed');
  assert.match(it.detail, /ran out of time while searching/);
});

test('Check all now runs in the background, and its progress and result can be read', { skip }, async () => {
  // Reintroduce by awaiting the sweep in the POST (the pre-v0.49.0 route): the first answer is not running, and a
  // proxy in front of a real install would have cut the request long before.
  const AGENT = `sc-agent/${Date.now()}`;
  const started = await inject('POST', '/api/admin/sources/check', { 'user-agent': AGENT });
  assert.equal(started.statusCode, 202, started.body);
  const p0 = started.json();
  assert.equal(p0.running, true);
  assert.equal(p0.by, 'admin');
  assert.equal((await inject('POST', '/api/admin/sources/check')).statusCode, 409, 'one at a time');
  let p = p0;
  for (let i = 0; i < 100 && p.running; i++) {
    await new Promise((res) => setTimeout(res, 100));
    p = (await inject('GET', '/api/admin/sources/check')).json();
  }
  assert.equal(p.running, false);
  assert.equal(p.done, p.total);
  assert.ok(p.total >= 3);
  assert.ok(p.result.inconclusive.some((v: any) => v.id === SLOW), 'the slow source could not finish, and says so');
  assert.ok(p.result.needsAttention.some((v: any) => v.id === ODD));
  assert.ok(!p.result.needsAttention.some((v: any) => v.id === SLOW), 'running out of time is not "needs attention"');
  // Who asked is on the audit line, although it is written when the sweep ends, long after the answer. Reintroduce
  // by dropping `req` from the onDone logAudit: the line has no IP and no user agent.
  let line: any;
  for (let i = 0; i < 50 && !line; i++) {
    [line] = await q(`SELECT ip, user_agent FROM audit_log WHERE event = 'source.check' ORDER BY at DESC LIMIT 1`);
    if (line?.user_agent !== AGENT) { line = undefined; await pause(50); }
  }
  assert.ok(line, 'the source.check audit line lost the user agent');
  assert.ok(line.ip, 'the source.check audit line lost the IP');
});

test('the header Health mark is refreshed once for a whole sweep, and never while the repair runs', { skip }, async () => {
  // Reintroduce by dropping holdSummaryWhile(checkRunning) (sourceWatchdog.ts): every source the sweep records
  // arms the refresh again, and the whole Health report runs per source instead of once. Or by dropping the
  // runtime.repairing check in healthSummary.ts's timer: a Test during the repair runs the report beside it.
  const { checkSourceLive, recordLiveResult } = await import('../src/lib/sourceCheck');
  const { setSummaryRefresh } = await import('../src/lib/healthSummary');
  const { runSourceCheck } = await import('../src/lib/sourceWatchdog');
  const { runtime } = await import('../src/lib/runtime');
  const { getSource } = await import('../src/lib/sources');
  let runs = 0;
  setSummaryRefresh(async () => { runs++; }, { everyMs: 20 });
  try {
    const r = await runSourceCheck({ autoFix: false });
    assert.ok(r.sources.length >= 3, 'a sweep of several sources, one of them a second and a half long');
    await pause(150);
    assert.equal(runs, 1, `one refresh when the sweep ended, none per source (${runs})`);

    runtime.repairing = true;
    await recordLiveResult(ODD, await checkSourceLive(getSource(ODD)!, { by: 'test' }), 'test');
    await pause(150);
    assert.equal(runs, 1, 'a Test during the repair ran the Health report beside it');
    runtime.repairing = false;
    for (let i = 0; i < 20 && runs < 2; i++) await pause(25);
    assert.equal(runs, 2, 'the refresh the repair held back runs once it is over');
  } finally {
    runtime.repairing = false;
    setSummaryRefresh();
  }
});

test("the header's mark is fresh by the time the sweep says it ended", { skip }, async () => {
  // "Check all now" refetches the stored summary the moment it reads `running: false`, and not again for a
  // minute. Reintroduce by flipping `running` before the refresh (or refreshing detached) in runSourceCheck's
  // finally: the sweep has ended and no refresh has run yet.
  const { setSummaryRefresh } = await import('../src/lib/healthSummary');
  const { runSourceCheck, checkProgress } = await import('../src/lib/sourceWatchdog');
  let runs = 0;
  let sweepRunning: boolean | null = null;
  setSummaryRefresh(async () => { await pause(50); sweepRunning = checkProgress().running; runs++; }, { everyMs: 20 });
  try {
    await runSourceCheck({ autoFix: false });
    assert.equal(runs, 1, 'the summary was refreshed before the sweep said it had ended');
    assert.equal(sweepRunning, true, 'while the sweep still read as running');
    assert.equal(checkProgress().running, false);
  } finally {
    setSummaryRefresh();
  }
});

test("an ask during the sweep's own refresh is not lost, and a report that never returns still ends the sweep", { skip }, async () => {
  // The integration-1 review: while the sweep's end refresh reads, the sweep still holds the summary, so an ask then
  // (a repair ending, a scan, an Ignore) was let go -- although the report may already have read past it. Reintroduce
  // by dropping the `missed` re-arm in refreshHealthSummaryNow: one refresh, from the state before the ask.
  const { setSummaryRefresh, scheduleHealthSummaryRefresh } = await import('../src/lib/healthSummary');
  const { runSourceCheck, checkProgress, setSweepRefreshBound } = await import('../src/lib/sourceWatchdog');
  let world = 'before';
  const stored: string[] = [];
  let first = true;
  setSummaryRefresh(async () => {
    const seen = world;
    if (first) {
      first = false;
      // Mid-read, something changes what Health would say, and asks.
      await pause(20);
      world = 'after';
      scheduleHealthSummaryRefresh();
      await pause(80);
    }
    stored.push(seen);
  }, { everyMs: 20 });
  try {
    await runSourceCheck({ autoFix: false });
    for (let i = 0; i < 40 && stored.length < 2; i++) await pause(25);
    assert.deepEqual(stored, ['before', 'after'], "an ask during the sweep's own refresh is not lost");
  } finally {
    setSummaryRefresh();
  }

  // A report that never comes back (a stalled mount under the downloads census) kept the sweep flag up until a
  // restart: the daily check refused, every summary ask let go. Reintroduce the bare await in runSourceCheck:
  // the sweep never ends, and this test times out.
  setSweepRefreshBound(200);
  let reading = false;
  setSummaryRefresh(() => { reading = true; return new Promise<void>(() => {}); }, { everyMs: 20 });
  try {
    const t0 = Date.now();
    const sweep = runSourceCheck({ autoFix: false });
    // A sweep over this file's sources takes a second or two before its end refresh; waited for, never raced.
    for (let i = 0; i < 600 && !reading; i++) await pause(50);
    assert.ok(reading, 'PREMISE: the report is being read');
    // While it reads, the sweep still runs, but it is on no source any more. Reintroduce by clearing `current` only
    // after the report: the page names the last source tested as the one being tested, for as long as it reads.
    assert.equal(checkProgress().running, true);
    assert.equal(checkProgress().current, null, 'the source being tested is over before the report is read');
    await sweep;
    assert.equal(checkProgress().running, false, 'a report that never returns still ends the sweep');
    assert.equal(checkProgress().current, null);
    assert.ok(Date.now() - t0 < 30_000);
  } finally {
    setSweepRefreshBound();
    setSummaryRefresh();
  }
});

test('a sweep that ends during a repair leaves its refresh to the end of the repair', { skip }, async () => {
  // The integration-1 review: nothing tested the repair rule for the sweep's own end refresh (only a Test's timer).
  // The report must not run beside a repair. Reintroduce by dropping the runtime.repairing line from
  // refreshHealthSummaryNow: the refresh runs while the repair does.
  const { setSummaryRefresh } = await import('../src/lib/healthSummary');
  const { runSourceCheck } = await import('../src/lib/sourceWatchdog');
  const { runtime } = await import('../src/lib/runtime');
  let runs = 0;
  let during = 0;
  setSummaryRefresh(async () => { runs++; if (runtime.repairing) during++; }, { everyMs: 20 });
  runtime.repairing = true;
  try {
    await runSourceCheck({ autoFix: false });
    await pause(100);
    assert.equal(runs, 0, 'a sweep that ends during a repair leaves its refresh to the end of the repair');
    runtime.repairing = false;
    for (let i = 0; i < 40 && runs < 1; i++) await pause(25);
    assert.equal(runs, 1, 'and it runs once the repair is over');
    assert.equal(during, 0);
  } finally {
    runtime.repairing = false;
    setSummaryRefresh();
  }
});

test('three failures in a row in ordinary use are a finding, two are not, and a success starts the count again', { skip }, async () => {
  // Only the SQL in sourceHealth.ts (STAGE_MERGE) counts the streak and keeps `since`, under the row lock; the pure
  // sourceEvidence tests run on hand-built records. So these drive the real writer. Reintroduce `'streak', 1` in
  // STAGE_MERGE: the third failure is still not a finding. Reintroduce `'since', p->>'failAt'`: `since` follows
  // the latest failure instead of the first. Drop `streak: 0` from a success's note: fail, fail, ok, fail is three.
  const { registerAdapter } = await import('../src/lib/sources');
  const none = async () => [];
  assert.ok(registerAdapter({ id: STREAK, name: 'Streak Source', search: none, getSeries: async () => null, listChapters: none, getPageUrls: none } as any));
  const note = async (outcome: 'ok' | 'fail') => {
    await sh.noteStage(STREAK, 'search', outcome, { error: 'suwayomi: java.lang.Exception: site changed' });
    await pause(5); // one note per millisecond at most: `open` compares failAt with okAt
  };
  await note('fail');
  const first = (await row(STREAK)).stages.search.failAt;
  await note('fail');
  assert.equal(itemOf(await sourcesCheck(), STREAK), undefined, 'two failures in a row are not a finding');
  await note('fail');
  const h = await row(STREAK);
  assert.equal(h.stages.search.streak, 3, 'three failures in a row were not counted as three');
  assert.equal(h.stages.search.since, first, 'failing since the first failure of the streak, not the latest');
  const it = itemOf(await sourcesCheck(), STREAK);
  assert.ok(it && !it.info, 'the third is a finding');
  assert.equal(it.evidence.find((e: any) => e.stage === 'search').by, 'traffic');

  await note('ok');
  await note('fail');
  await note('fail');
  const again = (await row(STREAK)).stages.search;
  assert.equal(again.streak, 2, 'the success reset the count');
  assert.equal(again.since > first, true, 'a failure after a success starts a new "since"');
  assert.equal(itemOf(await sourcesCheck(), STREAK), undefined, 'fail, fail, ok, fail, fail: not three in a row');
});

test('one add/detail lookup is one failure in a row, however many of its calls threw', { skip }, async () => {
  // Reintroduce a note per call (the .catch of getSeries AND of listChapters): one lookup is two in a row, and
  // two lookups of a broken extension make a confirmed failure the rule says needs three.
  const { registerAdapter, getSource } = await import('../src/lib/sources');
  const { seriesAndChapters } = await import('../src/routes/sources');
  const boom = async () => { throw new Error('suwayomi: java.lang.Exception: site changed'); };
  assert.ok(registerAdapter({ id: LOOKUP, name: 'Lookup Source', search: async () => [], getSeries: boom, listChapters: boom, getPageUrls: async () => [] } as any));
  const streakAfter = async (want: number) => {
    // The note is fire-and-forget (a reader is waiting on this lookup): wait for the streak to reach what one note
    // per lookup makes, then a little longer for a second one, if the code wrote two. Waiting only for the stage to
    // EXIST let the second lookup's check read before its note landed on a loaded host (fm review).
    for (let i = 0; i < 40 && ((await row(LOOKUP))?.stages?.chapters?.streak ?? 0) < want; i++) await pause(50);
    await pause(150);
    return (await row(LOOKUP))?.stages?.chapters?.streak;
  };
  const one = await seriesAndChapters(getSource(LOOKUP)!, 'x1');
  assert.deepEqual(one, { series: null, chapters: [] });
  assert.equal(await streakAfter(1), 1, 'one lookup, one failure in a row');
  await seriesAndChapters(getSource(LOOKUP)!, 'x1');
  assert.equal(await streakAfter(2), 2);
  assert.equal(itemOf(await sourcesCheck(), LOOKUP), undefined, 'two lookups are not three failures in a row');
  assert.match((await row(LOOKUP)).stages.chapters.error, /site changed/);

  // And the other half of the rule: a lookup that got its chapters is a chapters-stage success, whichever call
  // threw. Reintroduce by testing the error first (`if (lookupError !== undefined) fail; else if (chapters.length)
  // ok`): a lookup whose series page threw but whose chapter list answered counts toward a confirmed failure.
  assert.ok(registerAdapter({
    id: LOOKUP_OK, name: 'Lookup Ok Source', search: async () => [], getSeries: boom,
    listChapters: async () => [{ sourceId: 'lc1', number: 1 }], getPageUrls: async () => [],
  } as any));
  // A traffic success writes into an existing row only (a row per source per search fan-out is noise), so the
  // source has one, as any source that was ever tested or failed does.
  await q('INSERT INTO source_health (source_id) VALUES ($1) ON CONFLICT (source_id) DO NOTHING', [LOOKUP_OK]);
  await seriesAndChapters(getSource(LOOKUP_OK)!, 'x1');
  for (let i = 0; i < 40 && !(await row(LOOKUP_OK))?.stages?.chapters; i++) await pause(50);
  await pause(150);
  const st = (await row(LOOKUP_OK)).stages.chapters;
  assert.ok(st.okAt, 'the chapters the lookup listed are a success at that stage');
  assert.equal(st.failAt ?? null, null, 'and the series page that threw is not a chapters failure');
});
