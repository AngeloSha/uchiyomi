// LOG_LEVEL (v0.92.0, #316): how much the server log says.
//
// Asked for by an admin whose Find other sources run found nothing for six series other sources plainly list, with
// nothing in the log to say why. `debug` adds the run's searches and verdicts (findSources.int.test.ts reads them);
// this holds the variable itself: the six levels, any case and spacing, and a stray value meaning the default --
// never a refusal, which would stop the server at boot (env.ts parses process.env once, and exits on a bad value).
//
// Its own file, because env.ts parses process.env once at import: this process runs with LOG_LEVEL set to nonsense.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.LOG_LEVEL = 'chatty';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.DATABASE_URL ||= 'postgres://unused/unused';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

test('the six levels, in any case and spacing', async () => {
  const { logLevelOf } = await import('../src/env');
  for (const l of ['fatal', 'error', 'warn', 'info', 'debug', 'trace']) {
    assert.equal(logLevelOf(l, 'production'), l);
    assert.equal(logLevelOf(` ${l.toUpperCase()} `, 'production'), l);
  }
  assert.equal(logLevelOf('warning', 'production'), 'warn', 'as FlareSolverr spells it, beside it in the compose files');
});

test('unset or unknown is the default: info in production, debug elsewhere -- never a refusal', async () => {
  const { logLevelOf, logLevel } = await import('../src/env');
  assert.equal(logLevelOf(undefined, 'production'), 'info', 'what every install had before the variable');
  assert.equal(logLevelOf('', 'production'), 'info');
  assert.equal(logLevelOf('verbose', 'production'), 'info', 'a word it does not know');
  assert.equal(logLevelOf(undefined, 'development'), 'debug');
  // The process itself started with LOG_LEVEL=chatty: it is running, at the default.
  assert.equal(logLevel, 'info');
});
