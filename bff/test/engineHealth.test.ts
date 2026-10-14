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
// The sentences below are written against v2.3.2243 as both the tested and the oldest engine, given here rather than
// read from enginePin.ts: moving the pin (scripts/engine/bump.mjs) must not rewrite every expectation in this file. The
// shipped pins have a test of their own, the last one.
const base = (over: Partial<Deps>): Deps => ({
  state: 'up', linked: 0, desktop: false, ourSolver: OURS, version: '2.3.2243', error: null, tested: 'v2.3.2243', oldest: 'v2.3.2243',
  solver: { supported: true, enabled: true, url: OURS }, retry: null, cloudflare: [], ...over,
});
const findings = (c: { items: Array<{ info?: boolean }> }) => c.items.filter((i) => !i.info);
/** What a v2.4-or-later engine without `contentWarning` would refuse (client.ts engineRefusals). */
const REFUSED = [{ op: 'sources', message: "Validation error (FieldUndefined@[sources/nodes/contentWarning]) : Field 'contentWarning' in type 'SourceType' is undefined", at: '2026-10-14T00:00:00.000Z' }];

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
  // v0.49.1: the engine's own words, no longer a source card's "Turned off" (gendered for a source in fr, es, pt-BR).
  assert.equal(c.summary, 'Switched off');
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

test('a source is named as it names itself, even where its name opens a sentence', async () => {
  // v0.49.1's codes joined the names to the sentence before them as a new sentence, whose first letter is raised:
  // "…fail until it is. Mangapill fails because of it." -- the English changed, and the name was no longer the
  // source's. Reintroduce `joined('sentence', seen)` in engineHealth.ts: "a lower-case source name is capitalised".
  const { extensionEngine } = await import('../src/lib/engineHealth');
  const off = { supported: true as const, enabled: false, url: OURS };
  const failing = extensionEngine(base({ solver: off, cloudflare: [{ sourceId: 'sw:1', name: 'mangapill', bypass: true }] }))!;
  assert.equal(failing.items[0].detail,
    'The engine’s own Cloudflare helper is not in use: it is switched off. Extension sources on Cloudflare-protected sites fail until it is. mangapill fails because of it.',
    'a lower-case source name is capitalised');
  const fronted = extensionEngine(base({ solver: off, cloudflare: [{ sourceId: 'sw:2', name: 'comick.io', bypass: false }] }))!;
  assert.match(fronted.items[0].detail, /fail until it is\. comick\.io is behind Cloudflare\.$/, 'a lower-case source name is capitalised');
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
  assert.match(seen.items[0].detail, /fail until it answers again\. Night Shelf is behind Cloudflare\.$/);
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

test('every sentence of the row carries its codes, and they say exactly its English', async () => {
  // v0.49.1 (lib/said.ts): the page words the row in the reader's language from its codes, so the codes must say
  // what the English says, in every state -- read back from the registry alone. Reintroduce a bare `summary:`
  // string in any branch: "<state> sends its summary without codes" fails; point a note at the wrong code: "the
  // codes say something else" fails.
  const { extensionEngine } = await import('../src/lib/engineHealth');
  const { englishOf } = await import('../src/lib/said');
  const cf = (name: string, bypass: boolean) => ({ sourceId: `sw:${name}`, name, bypass });
  const many = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((n) => cf(n, true));
  const states: Array<[string, Partial<Deps>]> = [
    ['off', { state: 'off', linked: 1 }],
    ['switched off', { state: 'switched_off', linked: 3 }],
    ['unreachable', { state: 'unreachable', linked: 2, error: 'ECONNREFUSED', retry: { attempts: 1 } }],
    ['unreachable on desktop', { state: 'unreachable', desktop: true, linked: 2 }],
    ['unread, refusing', { solver: null, cloudflare: [cf('Ball', true)] }],
    ['unread, refusing, no solver', { solver: null, ourSolver: '', cloudflare: many }],
    ['unread', { solver: null, registering: true }],
    ['unsupported, refusing', { solver: { supported: false, enabled: false, url: '' }, cloudflare: [cf('Ball', true)] }],
    ['unsupported, refusing, desktop', { desktop: true, solver: { supported: false, enabled: false, url: '' }, cloudflare: [cf('Ball', true)] }],
    ['unsupported', { solver: { supported: false, enabled: false, url: '' } }],
    ['ok', { registering: true }],
    ['other', { solver: { supported: true, enabled: true, url: 'http://elsewhere:8191' } }],
    ['other, desktop', { desktop: true, solver: { supported: true, enabled: true, url: 'http://elsewhere:8191' } }],
    ['off, failing', { solver: { supported: true, enabled: false, url: OURS }, cloudflare: [cf('Ball', true), cf('Dex', true)] }],
    ['off, failing, a lower-case name', { solver: { supported: true, enabled: false, url: OURS }, cloudflare: [cf('mangapill', true)] }],
    ['localhost, fronted', { solver: { supported: true, enabled: true, url: 'http://localhost:8191' }, cloudflare: [cf('Ball', false)] }],
    ['off, nothing seen, no solver', { solver: { supported: true, enabled: false, url: OURS }, ourSolver: '', version: null }],
    // Lane P2's sentences, given codes at the integration: our own solver not answering.
    ['solver not answering', { solverAnswering: false }],
    ['solver not answering, registering, no version', { solverAnswering: false, registering: true, version: null }],
    ['solver not answering, seen', { solverAnswering: false, cloudflare: [cf('Ball', false), cf('mangapill', true)] }],
    // The engine upgrade: an engine that refuses, by how its version stands and where it runs, and the version row.
    ...(['compose', 'unraid', 'casaos', 'desktop', 'unknown'] as const).flatMap((platform): Array<[string, Partial<Deps>]> => [
      [`incompatible, newer, ${platform}`, { state: 'incompatible', version: 'v2.9.0', refused: REFUSED, platform }],
      [`incompatible, too old, ${platform}`, { state: 'incompatible', version: 'v2.2.2100', refused: REFUSED, platform }],
      [`incompatible, unknown, ${platform}`, { state: 'incompatible', version: null, error: 'suwayomi: Validation error (x)', refused: [], platform }],
      [`up, newer, ${platform}`, { version: 'v2.4.2366', platform }],
      [`up, older, ${platform}`, { version: 'v2.3.2000', oldest: 'v2.3.0', platform }],
      [`up, too old, ${platform}`, { version: 'v2.2.2100', platform }],
    ]),
  ];
  for (const [what, over] of states) {
    const c = extensionEngine(base(over));
    assert.ok(c, what);
    assert.ok(c!.summarySaid?.length, `${what} sends its summary without codes`);
    assert.equal(englishOf(c!.summarySaid), c!.summary, `${what}: the summary's codes say something else`);
    assert.equal(c!.note ? englishOf(c!.noteSaid) : c!.noteSaid, c!.note ?? undefined, `${what}: the note's codes say something else`);
    for (const it of c!.items) {
      assert.equal(englishOf(it.titleSaid), it.title, `${what}: the title's code says something else`);
      assert.equal(englishOf(it.detailSaid), it.detail, `${what}: "${it.detail}" -- the codes say something else`);
    }
  }
});

// ---- the engine upgrade: an engine that refuses, and how its version stands --------------------------------------

test('a refusal is Not compatible, never Not answering: one finding quotes the engine and says what to do', async () => {
  // Reintroduce by reading an engine that refuses as not answering (extensionEngineCheck: state 'unreachable' for a
  // probe whose aboutServer was refused): the summary reads "Not answering", whose fix -- a restart -- does nothing.
  // Drop the 'incompatible' branch in extensionEngine(): it reads "Ready".
  const { extensionEngine } = await import('../src/lib/engineHealth');
  const c = extensionEngine(base({ state: 'incompatible', version: 'v2.9.0', refused: REFUSED, platform: 'compose', linked: 4 }))!;
  assert.equal(c.status, 'warn');
  assert.equal(c.summary, 'Not compatible (v2.9.0)');
  assert.doesNotMatch(`${c.summary} ${c.note} ${c.items.map((i) => i.detail).join(' ')}`, /not answering/i);
  assert.equal(findings(c).length, 1, 'exactly one finding');
  const [f] = findings(c);
  assert.equal(f.title, 'Not compatible with this Uchiyomi');
  assert.match(f.detail, /^It refused what Uchiyomi asked: Validation error \(FieldUndefined@\[sources\/nodes\/contentWarning\]\)/, 'the engine\'s own words');
  // Newer than tested: update Uchiyomi, or go back -- and only ever with a backup.
  assert.match(f.detail, /The engine is newer than this Uchiyomi\. Update Uchiyomi; until a release supports this engine, v2\.3\.2243 is the version that works\./);
  assert.match(f.detail, /Back up the engine’s data first/);
  assert.match(f.detail, /In docker-compose\.yml, set the engine’s image to ghcr\.io\/suwayomi\/suwayomi-server:v2\.3\.2243, then run docker compose up -d uchiyomi-suwayomi\./);
  assert.match(c.note ?? '', /Restarting it does not help/);
  // The version row comes along for a newer engine, as a greyed line that says going back needs a backup.
  const v = c.items.find((i) => i.title === 'Engine version');
  assert.ok(v?.info, 'a newer engine\'s version row is a greyed line');
  assert.match(v!.detail, /^v2\.9\.0 is newer than the version this Uchiyomi was tested with \(v2\.3\.2243\)\. To go back to v2\.3\.2243, restore a backup/);

  // Older: update the engine; no backup sentence (an update is the engine's own one-way step, never a step back).
  const old = extensionEngine(base({ state: 'incompatible', version: 'v2.2.2100', refused: REFUSED, platform: 'compose' }))!;
  assert.match(findings(old)[0].detail, /Update the engine to v2\.3\.2243, the version this Uchiyomi was tested with\./);
  assert.doesNotMatch(findings(old)[0].detail, /Back up/);
  assert.equal(old.items.length, 1, 'the version row repeats the same versions, so it is left out');
  // No version at all (aboutServer itself refused): the tested version, with a backup first.
  const unknown = extensionEngine(base({ state: 'incompatible', version: null, error: 'suwayomi: Validation error (FieldUndefined@[aboutServer/buildType]) : x', refused: [] }))!;
  assert.equal(unknown.summary, 'Not compatible');
  assert.match(findings(unknown)[0].detail, /^It refused what Uchiyomi asked: Validation error \(FieldUndefined@\[aboutServer\/buildType\]\) : x/);
  assert.match(findings(unknown)[0].detail, /Run the version this Uchiyomi was tested with, v2\.3\.2243\. Back up the engine’s data first/);
});

test('each platform gets its own step, with the image, service and path as parameters never translated', async () => {
  // Reintroduce one step for all (stepOther everywhere): Unraid's names no Repository field and no appdata folder.
  const { extensionEngine } = await import('../src/lib/engineHealth');
  const step = (platform: Deps['platform']) => findings(extensionEngine(base({ state: 'incompatible', version: 'v2.2.2100', refused: REFUSED, platform }))!)[0];
  const image = 'ghcr.io/suwayomi/suwayomi-server:v2.3.2243';
  const compose = step('compose');
  assert.match(compose.detail, /docker compose up -d uchiyomi-suwayomi/);
  assert.match(step('unraid').detail, /On the Docker tab, edit uchiyomi-suwayomi, set its Repository to ghcr\.io\/suwayomi\/suwayomi-server:v2\.3\.2243 and apply\. Its data stays in \/mnt\/user\/appdata\/uchiyomi-suwayomi\./);
  assert.match(step('casaos').detail, /In CasaOS, edit the uchiyomi-suwayomi app, set its image to ghcr\.io\/suwayomi\/suwayomi-server:v2\.3\.2243 and save\. Its data stays in \/DATA\/AppData\/uchiyomi-suwayomi\./);
  assert.match(step('unknown').detail, /Run ghcr\.io\/suwayomi\/suwayomi-server:v2\.3\.2243 in place of the engine you have, on the same data\./);
  const desk = step('desktop');
  assert.match(desk.detail, /Quit and reopen Uchiyomi\. If Admin → Sources then offers to download the extension engine, download it/);
  assert.doesNotMatch(desk.detail, /docker|compose|container|ghcr/i, 'a desktop is sent to Docker');
  // What someone copies is a parameter of the sentence, so a translation cannot touch it.
  const parts = compose.detailSaid!.filter((p) => p.code === 'engine.stepCompose');
  assert.deepEqual(parts.map((p) => p.params), [{ image, file: 'docker-compose.yml', command: 'docker compose up -d uchiyomi-suwayomi' }]);
});

test('the version row: only when it is not the tested one; too old is a finding, older and newer are greyed lines', async () => {
  // Reintroduce by showing the row for the tested version too: "the tested engine has no version row" fails. Make too
  // old a greyed line (info: true): the check stays "ok" over an engine that is about to stop working.
  const { extensionEngine } = await import('../src/lib/engineHealth');
  const same = extensionEngine(base({ version: 'v2.3.2243' }))!;
  assert.ok(!same.items.some((i) => i.title === 'Engine version'), 'the tested engine has no version row');
  const newer = extensionEngine(base({ version: 'v2.4.2366', platform: 'compose' }))!;
  assert.equal(newer.status, 'ok');
  assert.equal(newer.summary, 'Ready, and it can get past Cloudflare (v2.4.2366)');
  const nv = newer.items.find((i) => i.title === 'Engine version')!;
  assert.equal(nv.info, true);
  assert.match(nv.detail, /^v2\.4\.2366 is newer than the version this Uchiyomi was tested with \(v2\.3\.2243\)\. To go back to v2\.3\.2243, restore a backup of the engine’s data from before the update/);
  assert.doesNotMatch(nv.detail, /docker compose|set the engine’s image/, 'never a step back without a backup in front of it');
  const older = extensionEngine(base({ version: 'v2.3.2000', oldest: 'v2.3.0', platform: 'unraid' }))!;
  const ov = older.items.find((i) => i.title === 'Engine version')!;
  assert.equal(ov.info, true);
  assert.match(ov.detail, /^v2\.3\.2000 is older than the version this Uchiyomi was tested with \(v2\.3\.2243\)\. It works; updating it is recommended\. Back up the engine’s data first: the engine upgrades its database when it starts, and an older engine cannot read it again\. On the Docker tab/,
    'the step to a one-way update starts with a backup');
  const tooOld = extensionEngine(base({ version: 'v2.2.2100', platform: 'compose' }))!;
  assert.equal(tooOld.status, 'warn', 'too old is a finding');
  const tv = findings(tooOld).find((i) => i.title === 'Engine version')!;
  assert.match(tv.detail, /^v2\.2\.2100 is older than the oldest version this Uchiyomi works with \(v2\.3\.2243\)\. Back up the engine’s data first: [^.]+\. In docker-compose\.yml/);
  // The desktop app keeps a copy of the engine's database itself before a new engine first starts: no backup to make.
  const desktopOld = extensionEngine(base({ version: 'v2.3.2000', oldest: 'v2.3.0', platform: 'desktop', desktop: true }))!;
  assert.doesNotMatch(desktopOld.items.find((i) => i.title === 'Engine version')!.detail, /Back up/, 'a desktop is told to back up what the app keeps itself');
  // A version that is not vX.Y.Z says nothing.
  assert.ok(!extensionEngine(base({ version: 'preview-build' }))!.items.some((i) => i.title === 'Engine version'));
});

/**
 * The pin moved from v2.3.2243 to v2.4.2366 with v2.3.2243 still supported. An install whose engine has not moved yet --
 * an Unraid or CasaOS container keeps the image it was created with, and so does a compose file edited by hand -- is
 * told quietly that an update is recommended: never "too old", never Not compatible. Reintroduce by moving OLDEST_ENGINE
 * to v2.4.2366: "an engine on the previous pin turns Health amber" fails, as it would on every such install.
 */
test('with the shipped pins, the pinned engine has no version row and the previous pin a greyed "updating is recommended"', async () => {
  const { extensionEngine } = await import('../src/lib/engineHealth');
  const { TESTED_ENGINE } = await import('../src/lib/sources/suwayomi/enginePin');
  const shipped = (version: string) => extensionEngine({ ...base({ version, platform: 'compose' }), tested: undefined, oldest: undefined })!;
  assert.ok(!shipped(TESTED_ENGINE).items.some((i) => i.title === 'Engine version'), 'the pinned engine has a version row');
  const previous = shipped('v2.3.2243');
  assert.equal(previous.status, 'ok', 'an engine on the previous pin turns Health amber');
  const row = previous.items.find((i) => i.title === 'Engine version')!;
  assert.equal(row.info, true);
  assert.match(row.detail, new RegExp(`^v2\\.3\\.2243 is older than the version this Uchiyomi was tested with \\(${TESTED_ENGINE.replace(/\./g, '\\.')}\\)\\. It works; updating it is recommended\\. Back up the engine’s data first: [^.]+\\. In docker-compose\\.yml`));
});
