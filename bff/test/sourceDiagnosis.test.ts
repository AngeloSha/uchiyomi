// What a broken source is actually told to do about itself.
//
// Every string below is copied VERBATIM out of a production `source_health.last_error`. That is the point of
// this file: the diagnosis layer's whole value is matching what the database really holds, and a paraphrase
// would let a rule drift away from reality while the test kept passing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, HealthFacts, DiagnosisCode } from '../src/lib/sourceDiagnosis';

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
    assert.doesNotMatch(
      d.reason,
      /flaresolverr|chromedriver|httpconnectionpool|localhost|docker|shm_size|https?:|:\d{4,5}\b|\bHTTP \d{3}\b/i,
      `the public sentence for ${d.code} leaks infrastructure: "${d.reason}"`,
    );
  }
  // If someone adds a code without a fixture, this fails and they have to prove it does not leak either.
  assert.equal(seen.size, cases.length, 'every fixture must produce a distinct code');
});
