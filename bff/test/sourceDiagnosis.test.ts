// What a broken source is actually told to do about itself.
//
// Every string below is copied VERBATIM out of a production `source_health.last_error`. That is the point of
// this file: the diagnosis layer's whole value is matching what the database really holds, and a paraphrase
// would let a rule drift away from reality while the test kept passing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, currentError, HealthFacts, DiagnosisCode, REASONS } from '../src/lib/sourceDiagnosis';

// The engine's own words, as an extension source stores them: suwayomi/client.ts prefixes every GraphQL
// error with `suwayomi: ` and the tail is the exception text verbatim from issue #54's log. A `flaresolverr:`
// prefix is impossible here -- that comes only from Uchiyomi's own solver client, which extension sources
// never call -- and a fixture wearing it would let the rules drift from what the table really holds.
const ENGINE_BYPASS_OFF = 'suwayomi: java.io.IOException: Cloudflare bypass currently disabled';

// #115, verbatim from the reporter's screenshot and the pinned engine (the fake engine answers the same text): the
// engine ANSWERED, with the extension's own Java exception about the site.
const MANGA_BALL = 'suwayomi: Exception while fetching data (/fetchSourceManga) : java.lang.Exception\r\n\r\njava.lang.Exception: java.lang.Exception\n\tat eu.kanade.tachiyomi.extension.en.mangaball.MangaBall.searchMangaParse(MangaBall.kt:120)';

// v0.49.1, verbatim as lib/sources/offline.ts words it for aqua's notice ("Aqua Manga is temporarily offline", HTTP 200).
const AQUA_OFFLINE = 'site_offline: the site says it is offline ("Aqua Manga is temporarily offline")';

const facts = (p: Partial<HealthFacts> = {}): HealthFacts => ({
  status: 'down', lastError: null, consecutive: 1, lastOkAt: null,
  emptyStreak: 0, blockedUntil: null, disabled: false, ...p,
});

// --- the three FlareSolverr faults, verbatim -------------------------------------------------------------
const CHROMEDRIVER =
  'flaresolverr: Error: Error solving the challenge. Message: Service /app/chromedriver unexpectedly exited. Status code was: 1\n';
const POOL =
  "flaresolverr: Error solving the challenge. HTTPConnectionPool(host='localhost', port=58885): Max retries exceeded with url: /session (Caused by NewConnectionError(\"HTTPConnection(host='localhost', port=58885): Fai";
const SOLVE_TIMEOUT = 'flaresolverr: Error solving the challenge. Timeout after 60.0 seconds.';

test('each FlareSolverr fault is named for what actually broke', () => {
  assert.equal(diagnose(facts({ lastError: CHROMEDRIVER })).code, 'solver_crash');
  assert.equal(diagnose(facts({ lastError: POOL })).code, 'solver_down');
  assert.equal(diagnose(facts({ lastError: SOLVE_TIMEOUT })).code, 'solver_timeout');
});

test('THE MIS-DIAGNOSIS: "challenge" in a solver error must not read as the site blocking us', () => {
  // All three strings above contain the word "challenge", because FlareSolverr prefixes every failure with
  // "Error solving the challenge". A cascade that tests /cloudflare|challenge/ before the solver rules
  // swallows all three and reports that the SITE is protected, when the site is fine and the fix is to
  // restart a container. Two of this install's six broken sources fail exactly this way.
  //
  // Reintroduce by moving the `cf_challenge` rule above the three `solver_*` rules in sourceDiagnosis.ts:
  // all three assertions below flip to 'cf_challenge' together.
  for (const err of [CHROMEDRIVER, POOL, SOLVE_TIMEOUT]) {
    const d = diagnose(facts({ lastError: err }));
    assert.ok(d.code.startsWith('solver_'), `"${err.slice(0, 48)}..." was diagnosed as ${d.code}`);
    assert.notEqual(d.code, 'cf_challenge');
  }
});

// --- trawl's own failures (v0.55.3) ----------------------------------------------------------------------------
// ⚠️ Not from a production last_error: the side-by-side benchmark on the owner's pages (2026-10-04) had trawl answer all
// fourteen, so these are trawl 1.7.0's own messages, read from its source (apps/api/src/routes/v1.ts, packages/tiers
// orchestrator.ts and tiers/3.ts), in the shape the client stores them: `flaresolverr: <message>`. Without a residential
// proxy, a wall its browser cannot pass ends as "Tier 3 failed (<reason>). Set RESIDENTIAL_PROXY_URL …".
const TRAWL_TIER4 = 'Set RESIDENTIAL_PROXY_URL (or pass a proxy per-request) to enable Tier 4 proxy escalation.';
const trawl = (reason: string) => `flaresolverr: Tier 3 failed (${reason}). ${TRAWL_TIER4}`;

test("trawl's own failures are named for what broke", () => {
  // Reintroduce by dropping each addition to its rule in sourceDiagnosis.ts: the challenge timeout reads as an unsolved
  // challenge (cf_challenge), the IP block as one too (its "cf_clearance"), the start-up as unknown, and the unknown host
  // as unknown.
  const code = (err: string) => diagnose(facts({ lastError: err })).code;
  assert.equal(code(trawl('cloudflare-challenge-timeout')), 'solver_timeout', 'its browser ran out of time on the wall');
  const blocked = diagnose(facts({ lastError: trawl('datacenter-ip-blocked (cf_clearance obtained but redirect never completed — needs residential proxy)') }));
  assert.equal(blocked.code, 'edge_403', 'past the challenge, and the site still refuses this address');
  assert.equal(blocked.fixSaid?.code, 'fix.ipBlocked');
  assert.match(blocked.fix, /RESIDENTIAL_PROXY_URL/);
  assert.equal(code('flaresolverr: Browser pool initializing, retry in a few seconds'), 'solver_down', 'the solver is still starting');
  assert.equal(code(trawl('page.goto: NS_ERROR_UNKNOWN_HOST')), 'unreachable', "Firefox's words for a host that does not resolve");
  assert.equal(code(trawl('browser network error (about:neterror)')), 'unreachable');
  assert.equal(code('flaresolverr: the solver did not answer with its JSON'), 'solver_down', 'no solver at that address');
  // What the existing rules already read right, held here so a new rule above them cannot take it.
  assert.equal(code(trawl('cloudflare-persistent')), 'cf_challenge', 'the wall held');
  assert.equal(code(trawl('http-403')), 'edge_403');
  assert.equal(code(trawl('http-429')), 'rate_limited', "the SITE's 429, in trawl's answer");
});

test("a solver still busy is the solver's capacity, never the site's rate limit", async () => {
  // v0.55.3: trawl answers its own HTTP 429 when no browser of its pool frees up; the client asks again, then the
  // backup, and then fails with SOLVER_BUSY. Reintroduce by dropping its rule: the words match nothing and read as
  // `unknown`; by putting "429" back in them, the rate-limit rule names a site that never said a word.
  const { SOLVER_BUSY } = await import('../src/lib/sources/flaresolverr');
  const d = diagnose(facts({ lastError: SOLVER_BUSY }));
  assert.equal(d.code, 'solver_timeout', 'a solver code');
  assert.equal(d.fixSaid?.code, 'fix.solverBusy');
  assert.match(d.fix, /BROWSER_POOL_SIZE/, 'the fix is the solver\'s own capacity');
  assert.equal(d.reason, REASONS.solver_timeout);
});

test('a bare timeout refuses to guess, because it covers three different faults', () => {
  // `withTimeout` throws this after discarding everything the adapter knew. On this install the same seven
  // characters were written by a moved domain, a 403 at the CDN, and a dead solver. `classify` maps it to
  // `down`, which is a confident wrong answer for four of the five sources that carry it.
  //
  // Reintroduce by mapping bare 'timeout' to any confident cause: `needsProbe` goes false and the code
  // stops being 'timeout'.
  for (const err of ['timeout', 'timeout after 8000ms']) {
    const d = diagnose(facts({ lastError: err }));
    assert.equal(d.code, 'timeout', `"${err}" should stay undecided`);
    assert.equal(d.needsProbe, true, 'a bare timeout is exactly the case a live probe exists to settle');
    assert.notEqual(d.code, 'unreachable');
  }
});

test('the downloader\'s own failure format is understood', () => {
  // downloader.ts writes this shape, and it is the ONE place an HTTP status reaches the record today.
  assert.equal(diagnose(facts({ lastError: '0/12 pages downloaded (HTTP 403)' })).code, 'edge_403');
  assert.equal(diagnose(facts({ lastError: '0/8 pages downloaded (HTTP 429)' })).code, 'rate_limited');
});

test('an extension-server failure blames the extension server, not the site', () => {
  assert.equal(diagnose(facts({ lastError: 'suwayomi 502' })).code, 'upstream_down');
  assert.equal(diagnose(facts({ lastError: 'suwayomi returned no data' })).code, 'upstream_down');
});

test('a live probe beats a stored error, however confident the stored one sounds', () => {
  // CoffeeManga: stored error says "timeout", but the site answers 200 from a different host because the
  // domain moved twice. Reintroduce by consulting stored evidence first -- the answer becomes 'timeout'.
  const d = diagnose(
    facts({ lastError: 'timeout' }),
    { httpStatus: 200, finalUrl: 'https://coffeemanga.ink/', looksHtml: true },
    'https://coffeemanga.io',
  );
  assert.equal(d.code, 'moved');
  assert.match(d.fix, /coffeemanga\.ink/, 'the admin fix must name where it moved to');
  assert.doesNotMatch(d.reason, /coffeemanga/, 'the public sentence must not name hosts');
});

test('if the site answers us directly, the solver is what is broken', () => {
  // Natomanga and MangaRead: the site returns 200 to a plain fetch from this very container, so whatever
  // the stored error blames, it is not the site.
  const d = diagnose(
    facts({ lastError: POOL }),
    { httpStatus: 200, finalUrl: 'https://www.natomanga.com/', looksHtml: true },
    'https://www.natomanga.com',
  );
  assert.ok(d.code.startsWith('solver_'), `expected a solver fault, got ${d.code}`);
});

test('silent emptiness becomes visible once, and only once, it means something', () => {
  assert.equal(diagnose(facts({ lastError: null, emptyStreak: 2 })).code, 'ok', 'two empties is not evidence');
  const d = diagnose(facts({ lastError: null, emptyStreak: 3 }));
  assert.equal(d.code, 'markup_drift');
  assert.equal(d.silent, true, 'this failure never threw, which is why it was invisible for so long');
});

test('a healthy source says nothing at all', () => {
  const d = diagnose(facts({ status: 'ok', lastError: null, consecutive: 0 }));
  assert.equal(d.code, 'ok');
  assert.equal(d.reason, '');
});

test('NO PUBLIC SENTENCE LEAKS INFRASTRUCTURE', () => {
  // `reason` goes to every signed-in reader on Discover; `fix` is admin-only. The split is a property pick
  // rather than a scrubber precisely so this test can be exhaustive.
  //
  // Reintroduce by putting `last_error` (or a hostname) into any `reason`.
  const cases: Array<[string, Parameters<typeof diagnose>]> = [
    ['solver_crash', [facts({ lastError: CHROMEDRIVER })]],
    ['solver_down', [facts({ lastError: POOL })]],
    ['solver_timeout', [facts({ lastError: SOLVE_TIMEOUT })]],
    ['cf_challenge', [facts({ lastError: 'Just a moment...' })]],
    ['edge_403', [facts({ lastError: 'HTTP 403 Forbidden' })]],
    ['rate_limited', [facts({ lastError: '429 too many requests' })]],
    ['upstream_down', [facts({ lastError: 'suwayomi 502' })]],
    // #115: the engine's own answer (its message and host must not leak), and chapters with no usable number.
    ['extension_error', [facts({ lastError: null }), { adapterOk: false, failure: { stage: 'search', kind: 'error', error: MANGA_BALL } }]],
    ['unnumbered', [facts({ lastError: null }), { adapterOk: false, failure: { stage: 'chapters', kind: 'unnumbered' } }]],
    // v0.49.1: the site's own offline notice, whose words are the site's.
    ['site_offline', [facts({ lastError: AQUA_OFFLINE })]],
    ['unreachable', [facts({ lastError: 'getaddrinfo ENOTFOUND example.invalid' })]],
    ['timeout', [facts({ lastError: 'timeout' })]],
    ['markup_drift', [facts({ lastError: null, emptyStreak: 5 })]],
    ['unknown', [facts({ lastError: 'something nobody has seen before' })]],
    ['disabled', [facts({ disabled: true })]],
    ['moved', [facts({ lastError: 'timeout' }), { httpStatus: 200, finalUrl: 'https://new.example/' }, 'https://old.example']],
    ['ok', [facts({ status: 'ok', lastError: null })]],
  ];

  const seen = new Set<DiagnosisCode>();
  for (const [expected, args] of cases) {
    const d = diagnose(...(args as Parameters<typeof diagnose>));
    assert.equal(d.code, expected, `fixture for ${expected} produced ${d.code}`);
    seen.add(d.code);
    // v0.49.1: a reason is its code's (REASONS), which is how the web words it by `code` alone; and every verdict
    // with a fix carries the fix's own code (FixCode) for the web to word. Reintroduce a rule whose reason is not
    // its code's sentence: "the reason for X is not its code's" fails; a D() with a bare string fix: "no fix code".
    assert.equal(d.reason, REASONS[d.code], `the reason for ${d.code} is not its code's`);
    if (d.code !== 'ok') assert.match(d.fixSaid?.code ?? '', /^fix\./, `${d.code}: no fix code`);
    else assert.equal(d.fixSaid, undefined, 'ok has no fix, and no fix code');
    assert.doesNotMatch(
      d.reason,
      // suwayomi / java.: since #115 an engine-answered error is a live input, and its text names the engine
      // and the extension's classes.
      /flaresolverr|chromedriver|httpconnectionpool|localhost|docker|shm_size|https?:|:\d{4,5}\b|\bHTTP \d{3}\b|suwayomi|java\./i,
      `the public sentence for ${d.code} leaks infrastructure: "${d.reason}"`,
    );
  }
  // If someone adds a code without a fixture, this fails and they have to prove it does not leak either.
  assert.equal(seen.size, cases.length, 'every fixture must produce a distinct code');
});

test('THE FALSE ALARM: a Cloudflare-fronted site is not "blocking us" for answering a bare request 403', () => {
  // Shipped and caught in production the same day. `probeBase` deliberately does NOT use the solver, so
  // every Cloudflare-protected site answers it 403 -- that is the challenge page, the normal state, and it
  // says nothing about whether the source works. Reading it as a verdict reported the healthiest source on
  // the install (190 series, working, verified parsing 19 titles) as blocked.
  //
  // Reintroduce by dropping the `!probe.needsSolver` condition on the 403 branch.
  const d = diagnose(
    facts({ status: 'ok', lastError: null, consecutive: 0 }),
    { httpStatus: 403, needsSolver: true },
    'https://aquareader.org',
  );
  assert.notEqual(d.code, 'edge_403', 'a challenge page was mistaken for a block');

  // ...and a source that does NOT go through the solver still reports a real 403.
  assert.equal(
    diagnose(facts(), { httpStatus: 403, needsSolver: false }, 'https://example.org').code,
    'edge_403',
  );
});

test('a working adapter outranks anything the homepage says', () => {
  // The adapter searched, listed chapters and served pages seconds ago. Whatever a bare GET made of the
  // homepage -- 403, a redirect, an odd content type -- the source works.
  //
  // Reintroduce by removing the `probe.adapterOk` short-circuit: the redirect below becomes a "moved"
  // verdict and the watchdog would rewrite a working source's address.
  const d = diagnose(
    facts({ lastError: 'timeout' }),
    { httpStatus: 200, finalUrl: 'https://cdn.example.net/', adapterOk: true },
    'https://aquareader.org',
  );
  assert.equal(d.code, 'ok');
  assert.equal(d.reason, '');
});

test('THE BASELESS ADAPTER: a working extension source outranks its own stale error, even with no homepage to probe', () => {
  // Suwayomi/extension sources never set `base` -- the engine talks to the site, not this server -- so
  // `probeBase` is never called for them and their Probe carries no `httpStatus` at all. `reportOk` never
  // clears `last_error`, so the stored string can be weeks old. The adapter's own live pass must still win
  // over it, status or no status (Mangaball via Suwayomi, issue #54: all four checks green, verdict
  // "protected by a check we could not get past" on every click).
  //
  // This pins diagnose()'s half. The callers' half -- that both actually hand this evidence over through
  // buildProbe rather than dropping it when no bare probe ran, which is what PR #56 fixed and what its own
  // test could not see -- is guarded in sourceWatchdog.test.ts ('THE DROPPED VERDICT').
  //
  // Reintroduce by gating the `adapterOk` short-circuit on a present `httpStatus` (moving it inside the
  // `probe.httpStatus != null` block): this reads `cf_challenge`.
  const d = diagnose(facts({ lastError: ENGINE_BYPASS_OFF }), { adapterOk: true, needsSolver: false });
  assert.equal(d.code, 'ok');
  assert.equal(d.reason, '');
  // ...and one that is genuinely failing right now still gets the stored verdict, not a shrug.
  assert.equal(diagnose(facts({ lastError: ENGINE_BYPASS_OFF }), { adapterOk: false, needsSolver: false }).code, 'cf_challenge');
});

test('an absent homepage status is not evidence of anything', () => {
  // A Probe without `httpStatus` means no request was made, which is a different fact from "a request was
  // made and got no answer" (0). PR #56 first encoded both as 0. No rule happened to fire on 0 that day,
  // but "no answer" is one `if (!probe.httpStatus)` away from "unreachable", and every extension source
  // would then be reported as a dead host for a request nobody made. The status-derived rules live behind
  // a presence guard, and an absent status must leave the verdict to the stored evidence alone.
  //
  // Reintroduce by treating a missing status as a failed request -- e.g. `if (!probe.httpStatus)` returning
  // `unreachable` ahead of the guard: the stored `timeout` below stops being 'timeout' (undecided,
  // needsProbe) and becomes 'unreachable'.
  const none = { adapterOk: false, needsSolver: false };
  const t = diagnose(facts({ lastError: 'timeout' }), none, undefined);
  assert.equal(t.code, 'timeout', 'nothing was asked, so nothing was learned; the stored shrug stands');
  assert.equal(t.needsProbe, true);
  // The stored solver rule still decides, and the fix must not claim a homepage that was never fetched
  // "answers fine from this server" (that inference keys on a real 200).
  const d = diagnose(facts({ lastError: POOL }), none, undefined);
  assert.equal(d.code, 'solver_down');
  assert.doesNotMatch(d.fix, /answers fine from this server/, 'no homepage was asked, so it cannot have answered');
  // And the transport-failure encoding still means what it always did.
  const u = diagnose(facts({ lastError: 'timeout' }), { httpStatus: 0, transport: 'ENOTFOUND', adapterOk: false }, 'https://gone.example');
  assert.equal(u.code, 'unreachable');
});

test('THE WRONG KNOB: the engine saying its own bypass is off names the engine\'s setting, not our solver', () => {
  // Issue #54, verbatim: Suwayomi's CloudflareInterceptor throws "Cloudflare bypass currently disabled"
  // because the ENGINE's FlareSolverr integration is off by default. The generic cf_challenge rule matches
  // the word "cloudflare" in the same string and tells the admin to "confirm the solver is healthy" -- and
  // Uchiyomi's solver was perfectly healthy; it is simply not involved. The reporter spent a day on that.
  //
  // Reintroduce by moving this rule below the generic cf_challenge one (or deleting it): the code stays
  // cf_challenge but the fix stops naming FLARESOLVERR_ENABLED and the Suwayomi container. Or by writing the
  // development stack's `yomi-suwayomi` / `yomi-flaresolverr` back into the sentence: the last assertion
  // fails, because that name exists on one install and the shipped compose files all say `uchiyomi-*`.
  const d = diagnose(facts({ lastError: ENGINE_BYPASS_OFF }));
  assert.equal(d.code, 'cf_challenge', 'to readers it is still a check we could not get past');
  assert.match(d.fix, /FLARESOLVERR_ENABLED=true/, 'the admin fix must name the engine\'s own switch');
  assert.match(d.fix, /FLARESOLVERR_URL/, 'and the address knob that points the engine at a solver');
  assert.match(d.fix, /uchiyomi-suwayomi/, 'on the engine container as the shipped compose files name it, not ours');
  assert.doesNotMatch(d.fix, /(^|[^a-z-])yomi-suwayomi|(^|[^a-z-])yomi-flaresolverr/i,
    'the development stack\'s container names must not leak into a sentence every public install reads');
  assert.doesNotMatch(d.reason, /suwayomi|flaresolverr|FLARESOLVERR/i, 'the public sentence names no component');
  // The upstream_down rule (`^suwayomi`) sits below cf_challenge and must not have swallowed it either.
  assert.notEqual(d.code, 'upstream_down');
});

test('THE DESIGN FLAW: being slower than our budget is not the same as being refused', () => {
  // The bug this exists for, in full. Aqua Manga answered correctly in ~11.5s through the Cloudflare
  // solver; the wall allowed 8s. `withTimeout` threw "timeout", `classify` read that as `down`, and
  // `reportFail` handed it an escalating 5-to-30 minute cooldown -- during which the route short-circuits
  // and never asks again. A working source holding 190 of 215 series disappeared from Discover for a day
  // while the watchdog, which allows 45s, kept truthfully reporting it healthy.
  //
  // Reintroduce by deleting the slowStreak branch in diagnose(): the verdict falls through to the generic
  // `timeout` rule, which shrugs and says it does not know -- exactly the state that hid this for a day.
  const d = diagnose(facts({ lastError: 'timeout after 8000ms', slowStreak: 4, budgetMs: 8000 }));
  assert.equal(d.code, 'too_slow');
  assert.match(d.fix, /SOURCE_LATEST_TIMEOUT_MS/, 'the fix must name the setting to change');
  assert.match(d.fix, /8s/, 'and the budget it is currently running out of');
  assert.doesNotMatch(d.reason, /block/i, 'a slow source must not be described as blocked');
});

test('one slow afternoon is not a pattern', () => {
  // The distinction only means something once it repeats; a single slow response is noise.
  assert.notEqual(diagnose(facts({ lastError: 'timeout after 8000ms', slowStreak: 1 })).code, 'too_slow');
  assert.notEqual(diagnose(facts({ lastError: 'timeout after 8000ms', slowStreak: 2 })).code, 'too_slow');
});

test('a genuine failure still earns a real verdict, not the slow one', () => {
  // The fix must not swallow real faults: a site refusing us is still a site refusing us.
  assert.equal(diagnose(facts({ lastError: 'HTTP 403 Forbidden', slowStreak: 0 })).code, 'edge_403');
  assert.equal(diagnose(facts({ lastError: 'getaddrinfo ENOTFOUND x', slowStreak: 0 })).code, 'unreachable');
});

// ---- #115: who failed -------------------------------------------------------------------------------------

test('THE BLAMED CONTAINER (#115): the engine answering with the extension\'s error is not the engine being down', () => {
  // Reintroduce by putting the old catch-all /^suwayomi\b/ upstream_down rule back above the /^suwayomi: / rule:
  // the code is upstream_down and the fix sends the admin to a container that is working.
  const clean = facts({ status: 'ok', consecutive: 0, lastError: null });
  const d = diagnose(clean, { adapterOk: false, failure: { stage: 'search', kind: 'error', error: MANGA_BALL } });
  assert.equal(d.code, 'extension_error');
  assert.doesNotMatch(d.fix, /Check that container/);
  assert.doesNotMatch(d.reason, /did not answer/);
  assert.match(d.fix, /while searching/, 'the fix names the stage');
  assert.match(d.fix, /Admin → Sources/);
  // The same words stored by traffic diagnose the same way.
  assert.equal(diagnose(facts({ lastError: MANGA_BALL })).code, 'extension_error');
});

test('the engine not answering still blames the engine, and its 403 is not the site\'s CDN', () => {
  // Reintroduce by moving the engine-status rule below the /\b403\b/ edge_403 rule: 'suwayomi 403' (the engine
  // refusing our Basic auth) becomes edge_403, "the site's CDN is refusing this server".
  for (const e of ['suwayomi unreachable: fetch failed (ECONNREFUSED)', 'suwayomi 502', 'suwayomi returned no data']) {
    assert.equal(diagnose(facts({ lastError: e })).code, 'upstream_down', e);
  }
  const auth = diagnose(facts({ lastError: 'suwayomi 403' }));
  assert.equal(auth.code, 'upstream_down');
  assert.match(auth.fix, /SUWAYOMI_USERNAME/);
  // Through the engine, the SITE's 403 is still the site's.
  assert.equal(diagnose(facts({ lastError: 'suwayomi: HTTP error 403' })).code, 'edge_403');
  assert.equal(diagnose(facts({ lastError: ENGINE_BYPASS_OFF })).code, 'cf_challenge');
  assert.equal(diagnose(facts({ lastError: 'suwayomi: java.net.UnknownHostException: mangaball.example' })).code, 'unreachable');
  assert.equal(diagnose(facts({ lastError: 'suwayomi: java.net.SocketTimeoutException: timeout' })).code, 'timeout');
  const slow = diagnose(facts({ lastError: 'suwayomi timeout after 30000ms' }));
  assert.equal(slow.code, 'timeout');
  assert.match(slow.fix, /extension engine did not answer in time/);
});

test('a failed live test is never ok', () => {
  // Reintroduce by dropping the failure branch and the final adapterOk === false guard: this reads D('ok') and the
  // Providers card prints "Working normally." under a ✗ (#115).
  const clean = facts({ status: 'ok', consecutive: 0, lastError: null });
  const d = diagnose(clean, { adapterOk: false, failure: { stage: 'pages', kind: 'error', error: 'something new' } });
  assert.equal(d.code, 'unknown');
  assert.match(d.fix, /listing pages/);
  assert.equal(diagnose(clean, { adapterOk: false }).code, 'unknown', 'a failed probe with no detail is not ok either');
  assert.equal(diagnose(clean, { adapterOk: true }).code, 'ok');
});

test('the live error outranks a stale stored one', () => {
  // Reintroduce by running the RULES over f.lastError before probe.failure: this reads cf_challenge from a
  // months-old #54 string while the engine just said 404.
  const d = diagnose(facts({ lastError: ENGINE_BYPASS_OFF }), { adapterOk: false, failure: { stage: 'search', kind: 'error', error: 'suwayomi: HTTP error 404' } });
  assert.notEqual(d.code, 'cf_challenge');
  assert.equal(d.code, 'extension_error');
});

test('our own deadline is not a verdict', () => {
  // Reintroduce by treating kind 'timeout' like 'error': the code becomes 'unknown'.
  const clean = facts({ status: 'ok', consecutive: 0, lastError: null });
  const t = diagnose(clean, { adapterOk: false, failure: { stage: 'chapters', kind: 'timeout' } });
  assert.equal(t.code, 'timeout');
  assert.equal(t.needsProbe, true);
  assert.match(t.fix, /not proof/);
  // With a current stored cause, that cause speaks.
  assert.equal(diagnose(facts({ lastError: 'Just a moment...' }), { adapterOk: false, failure: { stage: 'search', kind: 'timeout' } }).code, 'cf_challenge');
  const empty = diagnose(clean, { adapterOk: false, failure: { stage: 'chapters', kind: 'empty' } });
  assert.equal(empty.code, 'markup_drift');
  assert.match(empty.fix, /no chapters/);
  // Up to three are tried, and often fewer (one search hit; a one-chapter series): never a count it cannot know.
  // Reintroduce "for three of them": both fail.
  assert.match(empty.fix, /lists no chapters for the titles it tried/);
  const noPages = diagnose(clean, { adapterOk: false, failure: { stage: 'pages', kind: 'empty' } });
  assert.match(noPages.fix, /no pages for the chapters it tried/);
  assert.doesNotMatch(empty.fix + noPages.fix, /three of them/);
  // An empty answer under a CURRENT Cloudflare error is the challenge page, not the markup.
  assert.equal(diagnose(facts({ lastError: 'Just a moment...' }), { adapterOk: false, failure: { stage: 'search', kind: 'empty' } }).code, 'cf_challenge');
});

test('an engine timeout names the engine, not a wall it never reaches', () => {
  // The smoke test carries the engine client's words on a timeout (sourceProbe.ts outOfTime). Reintroduce by not
  // running the rules over them in diagnose(): the fix tells an admin to raise SOURCE_TEST_TIMEOUT_MS, which the
  // engine's fixed 30 s never reaches.
  const clean = facts({ status: 'ok', consecutive: 0, lastError: null });
  const d = diagnose(clean, { adapterOk: false, failure: { stage: 'pages', kind: 'timeout', error: 'suwayomi timeout after 30000ms' } });
  assert.equal(d.code, 'timeout');
  assert.match(d.fix, /extension engine did not answer in time while/);
  assert.doesNotMatch(d.fix, /SOURCE_TEST_TIMEOUT_MS/);
  // Our own wall, with nothing said, keeps its sentence.
  assert.match(diagnose(clean, { adapterOk: false, failure: { stage: 'pages', kind: 'timeout' } }).fix, /SOURCE_TEST_TIMEOUT_MS/);
  // With a current stored cause, that cause speaks: the engine's 30 s ran out behind the wall the stored error
  // names, and "the engine did not answer" would send an admin to a healthy container (integration-1 review).
  const late = { adapterOk: false, failure: { stage: 'search' as const, kind: 'timeout' as const, error: 'suwayomi timeout after 30000ms' } };
  assert.equal(diagnose(facts({ lastError: 'Just a moment...' }), late).code, 'cf_challenge', 'an engine timeout outranked a current stored cause');
  assert.equal(diagnose(facts({ lastError: ENGINE_BYPASS_OFF }), late).code, 'cf_challenge', "and the engine's own bypass switched off");
});

test('a stored error is current until a success comes after it', () => {
  const base = { last_error: 'Just a moment...', last_fail_at: '2026-09-20T00:00:00Z', last_slow_at: null };
  assert.equal(currentError({ ...base, last_ok_at: '2026-09-21T00:00:00Z' }), null, 'a success since: history');
  assert.equal(currentError({ ...base, last_ok_at: '2026-09-19T00:00:00Z' }), 'Just a moment...');
  assert.equal(currentError({ ...base, last_ok_at: null }), 'Just a moment...');
  assert.equal(currentError({ ...base, last_ok_at: '2026-09-21T00:00:00Z', last_slow_at: '2026-09-22T00:00:00Z' }), 'Just a moment...',
    'a slow answer after the success keeps it current');
  assert.equal(currentError(null), null);
});

test('an offline notice is not markup drift: the site said what is wrong, and the diagnosis says it too', () => {
  // aqua, 2026-09-23 on: every page its own "temporarily offline" notice with a 200, a stale empty streak from before
  // the notice was recognised, and a homepage that answers 200 HTML -- which read as markup drift ("no results --
  // markup may not match this engine"). Reintroduce by moving the site_offline branch below the homepage rules in
  // diagnose(): the live case reads markup_drift.
  const live = diagnose(facts({ lastError: null, emptyStreak: 7 }),
    { httpStatus: 200, looksHtml: true, adapterOk: false, needsSolver: true, failure: { stage: 'search', kind: 'site_offline', error: AQUA_OFFLINE } });
  assert.equal(live.code, 'site_offline');
  assert.equal(live.reason, 'The site says it is offline (its own page)');
  assert.equal(live.fix, 'Wait for the site to come back, or find other sources for its series.');
  // Stored alone (the Discover listing's failure, the sweep's traffic note): the same verdict, ahead of the rules a
  // notice's own words could trip ("maintenance", a Cloudflare page title).
  // Reintroduce by moving the site_offline rule below the cf_challenge rule: the second case reads cf_challenge.
  assert.equal(diagnose(facts({ lastError: AQUA_OFFLINE, emptyStreak: 7 })).code, 'site_offline');
  assert.equal(diagnose(facts({ lastError: 'site_offline: the site says it is offline ("Cloudflare maintenance")' })).code, 'site_offline');
  // Health's failing row hands the stage's kind in with the error; a kind of its own is enough.
  assert.equal(diagnose(facts({ lastError: null }), { adapterOk: false, failure: { stage: 'chapters', kind: 'site_offline' } }).code, 'site_offline');
});
