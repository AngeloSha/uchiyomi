// Being slower than our own budget is not the same as being refused, and must not be punished as if it were.
//
// The bug in full: Aqua Manga answered correctly in about 11.5 seconds through the Cloudflare solver, while
// the Discover wall allowed 8. `withTimeout` threw "timeout", `classify` read that as `down`, and
// `reportFail` handed it an escalating five-to-thirty-minute cooldown. `/api/sources/latest` short-circuits
// during a cooldown, so the source was never asked again -- and every re-ask was the only thing that could
// have shown it working. A source holding 190 of 215 series vanished from Discover for a day while the
// watchdog, which allows 45 seconds, kept truthfully reporting it healthy.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const ID = 't-slow-source';
let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let health: typeof import('../src/lib/sourceHealth');

before(async () => {
  if (!DSN) return;
  ({ q } = await import('../src/lib/db'));
  await (await import('../src/lib/migrate')).migrate();
  health = await import('../src/lib/sourceHealth');
});

beforeEach(async () => { if (DSN) await q('DELETE FROM source_health WHERE source_id = $1', [ID]); });

const row = async () => (await q(
  `SELECT status, consecutive, slow_streak, blocked_until, last_error FROM source_health WHERE source_id = $1`,
  [ID],
))[0];

test('one slow answer costs the source nothing at all', { skip }, async () => {
  await health.reportSlow(ID, 8000);
  const r = await row();
  assert.equal(r.slow_streak, 1);
  assert.equal(r.consecutive, 0, 'a self-timeout must never touch the failure counter');
  assert.equal(r.blocked_until, null, 'and must not block a source on its first slow response');
  assert.equal(r.status, 'ok');
});

test('THE FLAW: repeated slowness never escalates the way a refusal does', { skip }, async () => {
  // reportFail would take this to 5, 10, 15... up to 30 minutes, and each cooldown removes the requests that
  // would prove the source works. Reintroduce by routing self-timeouts back through reportFail: the
  // consecutive assertion fails first.
  for (let i = 0; i < 10; i++) await health.reportSlow(ID, 8000);
  const r = await row();
  assert.equal(r.slow_streak, 10);
  assert.equal(r.consecutive, 0, 'ten slow answers must not look like ten failures');
  assert.equal(r.status, 'ok', 'a slow source is not a down source');

  const waitMins = (new Date(r.blocked_until).getTime() - Date.now()) / 60000;
  assert.ok(waitMins > 0 && waitMins <= 6, `the breather must stay short and fixed, got ${waitMins} min`);
});

test('a real failure still escalates, because asking a refusing site again is pure cost', { skip }, async () => {
  for (let i = 0; i < 4; i++) await health.reportFail(ID, 'blocked', 'HTTP 403');
  const r = await row();
  assert.equal(r.consecutive, 4);
  assert.equal(r.status, 'blocked');
  const waitMins = (new Date(r.blocked_until).getTime() - Date.now()) / 60000;
  assert.ok(waitMins > 30, `a blocked source should back off hard, got ${waitMins} min`);
});

test('a page that arrives in time wipes the slow streak', { skip }, async () => {
  await health.reportSlow(ID, 8000);
  await health.reportSlow(ID, 8000);
  await health.reportLatest(ID, 12, 1);
  const r = await row();
  assert.equal(r.slow_streak, 0, 'proof of speed should clear the record of slowness');
  assert.equal(r.blocked_until, null);
});

test('THE ROUTING: latestPage must tell the two apart', () => {
  // The distinction is worthless if the call site still sends everything to reportFail. Static, because the
  // branch is inside a closure around a live fetch. Reintroduce by removing the selfTimeout check.
  const src = readFileSync(join(__dirname, '..', 'src', 'routes', 'sources.ts'), 'utf8');
  // withTimeout moved to lib/sources so the updater could share the same bound; the tag it sets is what this
  // whole distinction rests on, so it is still asserted, just where the function now lives.
  const lib = readFileSync(join(__dirname, '..', 'src', 'lib', 'sources', 'index.ts'), 'utf8');
  assert.match(lib, /selfTimeout: true/, 'withTimeout no longer tags the error it throws');
  const at = src.indexOf('} catch (e) {', src.indexOf('const run = async'));
  const block = src.slice(at, at + 900);
  assert.match(block, /selfTimeout/, 'the catch does not distinguish our own timeout from a real failure');
  assert.match(block, /reportSlow/, 'a self-timeout is not routed to reportSlow');
});
