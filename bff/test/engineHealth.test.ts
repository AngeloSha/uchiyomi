// Health's "Extension engine" row, decided from facts (#72, with #115's Cloudflare evidence).
//
// One row about the engine itself: off on purpose is an info line, not answering is a warning, and a helper
// that is off (or pointed at localhost on a server) is a warning only while extension sources are seen behind
// Cloudflare -- with the one-click Connect whenever Uchiyomi has a solver to share. The gathering (the memoised
// probe, the evidence query) is extensionsEngine.int.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.DATABASE_URL ||= 'postgres://unused/unused';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

const OURS = 'http://uchiyomi-flaresolverr:8191';
type Deps = import('../src/lib/engineHealth').EngineCheckDeps;
const base = (over: Partial<Deps>): Deps => ({
  state: 'up', linked: 0, desktop: false, ourSolver: OURS, version: '2.3.2243', error: null,
  solver: { supported: true, enabled: true, url: OURS }, retry: null, cloudflare: [], ...over,
});
const findings = (c: { items: Array<{ info?: boolean }> }) => c.items.filter((i) => !i.info);

test('no engine and nothing that needs one: no row at all', async () => {
  const { extensionEngine } = await import('../src/lib/engineHealth');
  assert.equal(extensionEngine(base({ state: 'off', linked: 0 })), null);
  assert.equal(extensionEngine(base({ state: 'switched_off', linked: 0 })), null);
  // A desktop whose engine was never downloaded (SUWAYOMI_URL is always set there).
  assert.equal(extensionEngine(base({ state: 'unreachable', desktop: true, linked: 0 })), null);
});

test('switched off with series that came from extensions: an info line, never a second warning', async () => {
  const { extensionEngine } = await import('../src/lib/engineHealth');
  const c = extensionEngine(base({ state: 'switched_off', linked: 12 }))!;
  assert.equal(c.id, 'extension-engine');
  assert.equal(c.title, 'Extension engine');
  assert.equal(c.status, 'ok', 'off on purpose is not a fault; the per-series rows already warn');
  assert.equal(c.summary, 'Turned off');
  assert.equal(findings(c).length, 0);
  assert.match(c.items[0].detail, /^12 series that came from extensions keep their chapters and get no new ones until it is back$/);
  const one = extensionEngine(base({ state: 'off', linked: 1 }))!;
  assert.equal(one.summary, 'Not set up');
  assert.match(one.items[0].detail, /^1 series that came from extensions keeps its chapters and gets no new ones/);
});

/**
 * Reintroduce by returning `items: []` for unreachable: the warning has nothing under it, which the page reads
 * as its own bug ("exactly one finding" fails).
 */
test('not answering is a warning with exactly one finding, and says it keeps trying', async () => {
  const { extensionEngine } = await import('../src/lib/engineHealth');
  const c = extensionEngine(base({ state: 'unreachable', error: 'suwayomi unreachable: fetch failed (ECONNREFUSED)', retry: { attempts: 4 }, linked: 3 }))!;
  assert.equal(c.status, 'warn');
  assert.equal(findings(c).length, 1, 'exactly one finding');
  assert.match(c.summary, /^Not answering \(suwayomi unreachable: fetch failed \(ECONNREFUSED\)\)$/);
  assert.match(c.items[0].detail, /asked 4 times since it stopped answering; 3 series that came from extensions/);
  assert.match(c.note ?? '', /every 5 minutes by itself/);
  assert.match(c.note ?? '', /Check again there asks at once/);
  // The desktop's Admin → Extensions is the engine's installer: no setup steps, no Check again.
  const desk = extensionEngine(base({ state: 'unreachable', desktop: true, retry: { attempts: 2 }, linked: 3 }))!;
  assert.doesNotMatch(desk.note ?? '', /Check again/, 'a desktop is sent to a button it does not have');
  assert.match(desk.note ?? '', /quit and reopen Uchiyomi/);
});

/**
 * Reintroduce by warning whenever the helper is off (drop `finding`): an engine whose extensions never meet a
 * challenge turns the page amber for nothing, and "no evidence, no warning" fails.
 */
test('a helper that is off: a warning with Connect while sources are seen behind Cloudflare, a greyed line otherwise', async () => {
  const { extensionEngine } = await import('../src/lib/engineHealth');
  const off = { supported: true as const, enabled: false, url: 'http://localhost:8191' };

  const quietOff = extensionEngine(base({ solver: off }))!;
  assert.equal(quietOff.status, 'ok', 'no evidence, no warning');
  assert.equal(quietOff.items.length, 1);
  assert.equal(quietOff.items[0].info, true);
  assert.deepEqual(quietOff.items[0].actions, ['engine_solver'], 'the fix is offered all the same');

  const failing = extensionEngine(base({ solver: off, cloudflare: [{ sourceId: 'sw:1', name: 'Manga Ball (EN)', bypass: true }] }))!;
  assert.equal(failing.status, 'warn');
  assert.equal(findings(failing).length, 1);
  assert.deepEqual(failing.items[0].actions, ['engine_solver']);
  assert.match(failing.items[0].detail, /it is switched off/);
  assert.match(failing.items[0].detail, /Manga Ball \(EN\) fails because of it\./, 'the source it breaks is named');

  const fronted = extensionEngine(base({ solver: off, cloudflare: [{ sourceId: 'sw:2', name: 'Night Shelf', bypass: false }] }))!;
  assert.equal(fronted.status, 'warn', 'a source seen behind Cloudflare is enough');
  assert.match(fronted.items[0].detail, /Night Shelf is behind Cloudflare\./);

  const local = extensionEngine(base({ solver: { supported: true, enabled: true, url: 'http://localhost:8191' }, cloudflare: [{ sourceId: 'sw:1', name: 'Manga Ball (EN)', bypass: true }] }))!;
  assert.equal(local.status, 'warn');
  assert.match(local.items[0].detail, /points at localhost, where no helper runs/);
});

/**
 * v0.49.1: connected to Uchiyomi's own solver, the engine gets past Cloudflare only while that solver answers, and the
 * row said it could beside the solver's own row saying it was not answering. Reintroduce by answering "Ready, and it
 * can get past Cloudflare" whatever the solver said (drop the `solverAnswering === false` branch): the first
 * assertion reads it.
 */
test('a solver that is not answering: the engine row says so too, never that it can get past Cloudflare', async () => {
  const { extensionEngine } = await import('../src/lib/engineHealth');
  const quiet = extensionEngine(base({ solverAnswering: false }))!;
  assert.doesNotMatch(quiet.summary, /can get past Cloudflare/, 'a solver that is not answering is a way past Cloudflare');
  assert.equal(quiet.summary, 'Ready (v2.3.2243); its Cloudflare helper is not answering');
  assert.equal(quiet.status, 'ok', 'the solver row is the warning: nothing is seen failing here');
  assert.equal(findings(quiet).length, 0);
  assert.match(quiet.items[0].detail, /the Cloudflare solver row says what to do/);
  assert.equal(quiet.items[0].actions, undefined, 'it is connected already: Connect would change nothing');
  const seen = extensionEngine(base({ solverAnswering: false, cloudflare: [{ sourceId: 'sw:2', name: 'Night Shelf', bypass: false }] }))!;
  assert.equal(seen.status, 'warn', 'a source seen behind Cloudflare makes it a finding');
  assert.equal(seen.summary, 'Its Cloudflare helper is not answering');
  assert.equal(findings(seen).length, 1);
  assert.match(seen.items[0].detail, /Night Shelf is behind Cloudflare\./);
  // Answering, or not asked (the engine points elsewhere): as before.
  assert.match(extensionEngine(base({ solverAnswering: true }))!.summary, /^Ready, and it can get past Cloudflare/);
  assert.match(extensionEngine(base({ solverAnswering: null }))!.summary, /^Ready, and it can get past Cloudflare/);
});

test('no solver of our own to share: no Connect, and the detail says what to set first', async () => {
  const { extensionEngine } = await import('../src/lib/engineHealth');
  const c = extensionEngine(base({ ourSolver: '', solver: { supported: true, enabled: false, url: '' }, cloudflare: [{ sourceId: 'sw:1', name: 'A', bypass: true }] }))!;
  assert.equal(c.status, 'warn');
  assert.equal(c.items[0].actions, undefined, 'Connect would have nothing to connect to');
  assert.match(c.items[0].detail, /set FLARESOLVERR_URL on Uchiyomi/);
});

test('desktop: the in-app helper on 127.0.0.1 is right, and its address is never printed', async () => {
  const { extensionEngine } = await import('../src/lib/engineHealth');
  const helper = 'http://127.0.0.1:41234/secret-desktop-token';
  const ok = extensionEngine(base({ desktop: true, ourSolver: helper, solver: { supported: true, enabled: true, url: helper } }))!;
  assert.equal(ok.status, 'ok');
  assert.match(ok.summary, /^Ready, and it can get past Cloudflare/);
  const other = extensionEngine(base({ desktop: true, ourSolver: helper, solver: { supported: true, enabled: true, url: 'http://127.0.0.1:9/elsewhere-token' } }))!;
  assert.equal(other.status, 'ok');
  const text = JSON.stringify([ok, other]);
  assert.ok(!text.includes('secret-desktop-token') && !text.includes('elsewhere-token'), 'a desktop helper address is on the Health page');
  assert.doesNotMatch(text, /FLARESOLVERR|docker|container/i);
});

test('another solver, an older engine, an unread setting: all fine, and said', async () => {
  const { extensionEngine } = await import('../src/lib/engineHealth');
  const other = extensionEngine(base({ solver: { supported: true, enabled: true, url: 'http://solver.lan:8191' } }))!;
  assert.equal(other.status, 'ok');
  assert.equal(other.items[0].info, true);
  assert.match(other.items[0].detail, /solver\.lan:8191/, 'on a server the other address is named');
  const old = extensionEngine(base({ solver: { supported: false } }))!;
  assert.equal(old.status, 'ok');
  assert.match(old.note ?? '', /does not report its Cloudflare setting/);
  const unread = extensionEngine(base({ solver: null }))!;
  assert.equal(unread.status, 'ok');
  assert.match(unread.summary, /^Answering \(v2\.3\.2243\)$/);
});

test("the engine's own words are proof when its setting cannot be read", async () => {
  // Reintroduce by answering these two branches as before ('Answering' and a note): a source failing because the
  // engine's helper is off reads as a healthy engine.
  const { extensionEngine } = await import('../src/lib/engineHealth');
  const refusing = [{ sourceId: 'sw:1', name: 'Manga Ball (EN)', bypass: true }];
  const unread = extensionEngine(base({ solver: null, cloudflare: refusing }))!;
  assert.equal(unread.status, 'warn');
  assert.equal(unread.summary, 'It cannot use its Cloudflare helper');
  assert.equal(findings(unread).length, 1);
  assert.deepEqual(unread.items[0].actions, ['engine_solver'], 'Connect reads the setting first, so it is offered');
  assert.match(unread.items[0].detail, /Manga Ball \(EN\) fails because of it\./);
  const old = extensionEngine(base({ solver: { supported: false }, cloudflare: refusing }))!;
  assert.equal(old.status, 'warn');
  assert.equal(old.items[0].actions, undefined, 'an engine with no setting to set gets no Connect');
  assert.match(old.note ?? '', /update the engine/);
  // With no helper of its own to share, Uchiyomi says what to set first instead of offering Connect.
  const none = extensionEngine(base({ ourSolver: '', solver: null, cloudflare: refusing }))!;
  assert.equal(none.status, 'warn');
  assert.equal(none.items[0].actions, undefined);
  assert.match(none.items[0].detail, /set FLARESOLVERR_URL on Uchiyomi/);
  assert.doesNotMatch(none.note ?? '', /Connect/);
  // A source merely behind Cloudflare says nothing about the helper: still fine.
  assert.equal(extensionEngine(base({ solver: null, cloudflare: [{ sourceId: 'sw:2', name: 'Night Shelf', bypass: false }] }))!.status, 'ok');
});

test('a failure that has since passed is not evidence: only what is failing now counts', async () => {
  // #115's rules (sourceEvidence.ts currentFailures, sourceDiagnosis.ts currentError). Reintroduce the old
  // seven-day window alone (any failAt, live_detail or last_error from the last week): the closed, the
  // unconfirmed and the answered rows below count, and the engine's row stays amber after its sources recover.
  const { cloudflareEvidenceOf } = await import('../src/lib/extensionEngine');
  const now = Date.parse('2026-09-27T12:00:00Z');
  const ago = (h: number) => new Date(now - h * 3600_000).toISOString();
  const BYPASS = 'suwayomi: java.io.IOException: Cloudflare bypass currently disabled';
  const row = (id: string, over: Record<string, unknown>) => ({
    source_id: id, name: id, last_error: null, last_fail_at: null, last_ok_at: null, last_slow_at: null,
    live_state: null, live_at: null, live_stage: null, live_detail: null, stages: null, ...over,
  }) as any;
  const ev = cloudflareEvidenceOf([
    row('sw:test', { stages: { search: { failAt: ago(2), failBy: 'test', error: BYPASS, kind: 'error' } } }),
    row('sw:closed', { stages: { search: { failAt: ago(3), failBy: 'test', error: BYPASS, kind: 'error', okAt: ago(1) } } }),
    row('sw:once', { stages: { search: { failAt: ago(2), failBy: 'traffic', error: BYPASS, kind: 'error', streak: 1 } } }),
    row('sw:thrice', { stages: { search: { failAt: ago(2), failBy: 'traffic', error: BYPASS, kind: 'error', streak: 3 } } }),
    row('sw:old', { stages: { search: { failAt: ago(24 * 9), failBy: 'test', error: BYPASS, kind: 'error' } } }),
    row('sw:live', { live_state: 'fail', live_at: ago(2), live_stage: 'pages', live_detail: BYPASS }),
    row('sw:live-passed-since', { live_state: 'fail', live_at: ago(3), live_stage: 'pages', live_detail: BYPASS, stages: { pages: { okAt: ago(1) } } }),
    row('sw:stored', { last_error: BYPASS, last_fail_at: ago(2) }),
    row('sw:stored-answered', { last_error: BYPASS, last_fail_at: ago(3), last_ok_at: ago(1) }),
    row('sw:fronted', { last_error: 'Just a moment...', last_fail_at: ago(2) }),
  ], now);
  assert.deepEqual(ev.map((e) => [e.sourceId, e.bypass]), [
    ['sw:fronted', false], ['sw:live', true], ['sw:stored', true], ['sw:test', true], ['sw:thrice', true],
  ]);
});
