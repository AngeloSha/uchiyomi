// EXTENSION_ENGINE, the bundled extension engine's switch (#72), as the app reads it.
//
// Compose scales the engine to zero replicas on EXTENSION_ENGINE=0 and passes the same value to the app, which
// must then treat extensions as off -- not report a container it was told to drop as "unreachable" for ever. But
// only the BUNDLED container goes: someone who points SUWAYOMI_URL at a Suwayomi of their own keeps extensions
// whatever the line says.
//
// Its own file, because env.ts parses process.env once at import: this process runs with the switch off and the
// bundled address, as a Compose install with EXTENSION_ENGINE=0 and an older .env that still names the engine.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUWAYOMI_URL = 'http://uchiyomi-suwayomi:4567';
process.env.EXTENSION_ENGINE = '0';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.DATABASE_URL ||= 'postgres://unused/unused';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

/**
 * Only an unmistakable "off" turns it off. The engine ran for every install before this variable existed, so
 * unset, empty and anything unrecognised mean on; and the value is read as a word, never through an enum, since a
 * value zod refuses exits the server at boot.
 *
 * Reintroduce by reading it with envFlag (`/^(1|true|yes|on)$/`): a typo such as `EXTENSION_ENGINE=yse` then
 * silently takes extensions away, and the `'yse'` case fails.
 */
test('EXTENSION_ENGINE is on unless it clearly says off', async () => {
  const { engineSwitchOn } = await import('../src/env');
  for (const v of [undefined, '', '  ', '1', 'true', 'yes', 'on', 'ON', 'yse', '2']) {
    assert.equal(engineSwitchOn(v), true, `${JSON.stringify(v)} must leave the engine on`);
  }
  for (const v of ['0', 'off', 'OFF', 'false', 'False', 'no', ' 0 ', 'no\n']) {
    assert.equal(engineSwitchOn(v), false, `${JSON.stringify(v)} must switch the engine off`);
  }
});

test('the parsed environment carries the switch', async () => {
  const { env } = await import('../src/env');
  assert.equal(env.EXTENSION_ENGINE, false, 'EXTENSION_ENGINE=0 did not reach env');
});

/**
 * Reintroduce by dropping the host check from engineSwitchedOff (return `!on`): an engine the operator runs
 * elsewhere is switched off along with the bundled container, and the nas.lan case fails.
 */
test('only an address naming the bundled container is switched off', async () => {
  const { engineSwitchedOff } = await import('../src/lib/sources/suwayomi/client');
  const cases: Array<[string, boolean, boolean]> = [
    ['http://uchiyomi-suwayomi:4567', false, true],
    ['http://yomi-suwayomi:4567/', false, true], // the development stack's name, trailing slash and all
    ['http://UCHIYOMI-SUWAYOMI:4567//', false, true],
    ['http://user:pw@uchiyomi-suwayomi:4567', false, true],
    ['http://nas.lan:4567', false, false], // your own engine: the switch does not speak for it
    ['http://192.168.1.10:4567', false, false],
    ['http://uchiyomi-suwayomi.example.com:4567', false, false],
    ['http://uchiyomi-suwayomi:4567', true, false], // the switch on
    ['', false, false], // nothing configured: nothing to switch off
    ['uchiyomi-suwayomi:4567', false, false], // not a URL; suwayomiConfigured has its own view of such a value
  ];
  for (const [url, on, off] of cases) {
    assert.equal(engineSwitchedOff(url, on), off, `engineSwitchedOff(${JSON.stringify(url)}, ${on})`);
  }
});

/**
 * The switch reaches everything through suwayomiConfigured: registration, the routes, Health, the scheduled
 * checks, gql itself and the page-cache keeper. Reintroduce by returning `!!env.SUWAYOMI_URL` from it again:
 * every assertion below fails, starting with the first.
 */
test('switched off: nothing talks to the engine', async () => {
  const { suwayomiConfigured, gql } = await import('../src/lib/sources/suwayomi/client');
  assert.equal(suwayomiConfigured(), false, 'EXTENSION_ENGINE=0 with the bundled address still counts as configured');
  await assert.rejects(() => gql('{ __typename }'), /not configured/i);

  const { loadSuwayomiSources } = await import('../src/lib/sources/suwayomi/register');
  let listed = false;
  const r = await loadSuwayomiSources(async () => { listed = true; return []; });
  assert.equal(listed, false, 'it tried to list sources from an engine that was switched off');
  // The unconfigured shape, byte for byte: suwayomiOff.test.ts pins the same object for an unset URL.
  assert.deepEqual(r, { configured: false, reachable: false, available: 0, registered: 0, skipped: 0 });

  const { engineCacheKeeper } = await import('../src/lib/sources/suwayomi/cache');
  let cleared = 0;
  const logged: string[] = [];
  const keeper = engineCacheKeeper({ clear: async () => { cleared++; return true; }, log: { info: (m) => logged.push(m), warn: (m) => logged.push(m) } });
  assert.equal(await keeper.tick(), 'off');
  assert.equal(cleared, 0, 'the page-cache keeper called a switched-off engine');
  assert.deepEqual(logged, [], 'the page-cache keeper logged about an engine that is off on purpose');
});
