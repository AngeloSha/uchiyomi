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
