// What the pages say about the extension engine, from facts the server already has (#72): why it is off, its
// state for Health, the address it shows, the platform its setup steps open on, and how its Cloudflare helper is
// wired. Pure functions, with their inputs as parameters; env.ts is parsed once, so this process runs as an
// ordinary Compose install with the bundled engine switched ON.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUWAYOMI_URL = 'http://uchiyomi-suwayomi:4567';
delete process.env.EXTENSION_ENGINE;
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.DATABASE_URL ||= 'postgres://unused/unused';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

test('why there is no engine: the switch, or no address at all', async () => {
  const { engineOffReason } = await import('../src/lib/sources/suwayomi/engineState');
  assert.equal(engineOffReason('http://uchiyomi-suwayomi:4567', false), 'switch');
  assert.equal(engineOffReason('http://yomi-suwayomi:4567/', false), 'switch');
  assert.equal(engineOffReason('', true), 'unset');
  assert.equal(engineOffReason('', false), 'unset', 'no address: nothing to switch, just nothing there');
  // An engine someone runs themselves is not switched off by the bundled container's switch.
  assert.equal(engineOffReason('http://nas.lan:4567', false), null);
  assert.equal(engineOffReason('http://uchiyomi-suwayomi:4567', true), null);
});

test('the engine address shown to an admin is host and port, never the credentials in it', async () => {
  const { engineHost } = await import('../src/lib/sources/suwayomi/engineState');
  assert.equal(engineHost('http://uchiyomi-suwayomi:4567'), 'uchiyomi-suwayomi:4567');
  assert.equal(engineHost('http://admin:hunter2@nas.lan:4567//'), 'nas.lan:4567');
  assert.equal(engineHost('https://engine.example.com/sub/'), 'engine.example.com');
  assert.equal(engineHost(''), '');
  assert.equal(engineHost('not a url'), '');
});

test("the engine's state follows the last registration: unreachable until one reached it", async () => {
  // frozenSeries asks why an extension series has no adapter, and one exists exactly when a registration reached
  // the engine -- so the state is read from registration, never from a probe of its own.
  const { engineState } = await import('../src/lib/sources/suwayomi/engineState');
  const reg = await import('../src/lib/sources/suwayomi/register');
  const quiet = console.warn;
  console.warn = () => {};
  try {
    assert.equal(engineState(), 'unreachable', 'configured, and nothing has registered yet');
    await reg.loadSuwayomiSources(async () => { throw new Error('fetch failed'); });
    assert.equal(engineState(), 'unreachable');
    await reg.loadSuwayomiSources(async () => []);
    assert.equal(engineState(), 'up');
  } finally {
    console.warn = quiet;
  }
});

/**
 * Most specific evidence first. Reintroduce by dropping the HOST_OS arm: an Unraid template made before the
 * UCHIYOMI_PLATFORM hint opens the setup steps on Compose, and the HOST_OS case fails.
 */
test('the platform the setup steps open on', async () => {
  const { installPlatform } = await import('../src/lib/platform');
  const cases: Array<[NodeJS.ProcessEnv, boolean, string]> = [
    [{}, true, 'desktop'],
    [{ UCHIYOMI_PLATFORM: 'unraid' }, true, 'desktop'], // the desktop app knows what it is
    [{ UCHIYOMI_PLATFORM: 'casaos' }, false, 'casaos'],
    [{ UCHIYOMI_PLATFORM: ' Umbrel ' }, false, 'umbrel'],
    [{ UCHIYOMI_PLATFORM: 'unraid', EXTENSION_ENGINE: '1' }, false, 'unraid'], // the hint beats the compose clue
    [{ UCHIYOMI_PLATFORM: 'toaster', EXTENSION_ENGINE: '1' }, false, 'compose'], // an unknown hint is ignored
    [{ HOST_OS: 'Unraid' }, false, 'unraid'],
    [{ HOST_OS: 'unraid', EXTENSION_ENGINE: '1' }, false, 'unraid'],
    [{ EXTENSION_ENGINE: '1' }, false, 'compose'],
    [{ EXTENSION_ENGINE: '' }, false, 'compose'], // present is the clue: every v0.49.0 compose file passes it
    [{}, false, 'unknown'],
  ];
  for (const [e, desktop, want] of cases) {
    assert.equal(installPlatform(e, desktop), want, `installPlatform(${JSON.stringify(e)}, desktop=${desktop})`);
  }
});

/**
 * Reintroduce by dropping the desktop exemption from solverWiring (check localhost on desktop too): the desktop
 * shell's own helper on 127.0.0.1 -- the right answer there -- reads as miswired, and the desktop case fails.
 */
test("how the engine's Cloudflare helper is wired", async () => {
  const { solverWiring } = await import('../src/lib/sources/suwayomi/engineSolver');
  const ours = 'http://uchiyomi-flaresolverr:8191';
  const on = (url: string) => ({ supported: true as const, enabled: true, url });
  assert.equal(solverWiring({ supported: false }, ours, false), 'unsupported');
  assert.equal(solverWiring({ supported: true, enabled: false, url: ours }, ours, false), 'off', 'switched off, whatever it points at');
  assert.equal(solverWiring(on(''), ours, false), 'off', 'on with no address is off');
  assert.equal(solverWiring(on(ours), ours, false), 'ok');
  assert.equal(solverWiring(on('http://UCHIYOMI-flaresolverr:8191/v1/'), ours, false), 'ok', 'the same solver spelled with /v1 and a slash');
  assert.equal(solverWiring(on('http://localhost:8191'), ours, false), 'localhost', "the engine's default: its own container, where no solver runs");
  assert.equal(solverWiring(on('http://127.0.0.1:8191'), '', false), 'localhost');
  assert.equal(solverWiring(on('http://solver.lan:8191'), ours, false), 'other');
  // Desktop: the shell points the engine at the in-app helper on 127.0.0.1 on purpose.
  const helper = 'http://127.0.0.1:41234/0123456789abcdef';
  assert.equal(solverWiring(on(helper), helper, true), 'ok');
  assert.equal(solverWiring(on('http://127.0.0.1:9/other'), helper, true), 'other', 'localhost is never a fault on desktop');
});

test("Uchiyomi's own solver is what FLARESOLVERR_URL says, never the development stack's default", async () => {
  // flaresolverr.ts falls back to http://yomi-flaresolverr:8191 so the built-in engines always have somewhere to
  // ask; offering to point an engine at that host would break it everywhere but one development machine.
  const { ourSolverUrl, solverHost } = await import('../src/lib/sources/suwayomi/engineSolver');
  assert.equal(ourSolverUrl({}), '');
  assert.equal(ourSolverUrl({ FLARESOLVERR_URL: ' http://uchiyomi-flaresolverr:8191 ' }), 'http://uchiyomi-flaresolverr:8191');
  assert.equal(solverHost('http://127.0.0.1:41234/secret-token'), '127.0.0.1:41234', 'the audit never carries the path');
});

test("the status route's helper address never goes to a desktop page", async () => {
  // On desktop the in-app helper's address carries its per-launch token in the path. Reintroduce by sending the url
  // whenever the setting is supported (drop `&& !desktop` in solverView): the desktop view carries the token.
  const { solverView } = await import('../src/lib/extensionEngine');
  const helper = 'http://127.0.0.1:41234/tok-per-launch';
  const desk = solverView({ supported: true, enabled: true, url: helper }, helper, true);
  assert.equal('url' in desk, false, 'no url key on desktop');
  assert.ok(!JSON.stringify(desk).includes('tok-per-launch'), 'and the token is nowhere in it');
  assert.equal(desk.wiring, 'ok');
  const server = solverView({ supported: true, enabled: true, url: 'http://uchiyomi-flaresolverr:8191' }, 'http://uchiyomi-flaresolverr:8191', false);
  assert.equal(server.url, 'http://uchiyomi-flaresolverr:8191', 'a server admin reads where it points');
});
