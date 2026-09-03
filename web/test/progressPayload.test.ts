// The live progress write must carry `at`.
//
// The server's stale-write guard (progress.ts) only fires when a timestamp arrives; the offline outbox always
// sent one, the live path never did, so a stale desktop tab could rewind a phone. The payload is built inside
// a React callback with no seam a unit test can reach, so this pins the source line itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('the live progress payload sends at: Date.now()', () => {
  const src = readFileSync(join(__dirname, '..', 'app', 'reader', 'page.tsx'), 'utf8');
  const line = src.split('\n').find((l) => l.includes('const payload = {') && l.includes('deviceId: deviceId()'));
  assert.ok(line, 'the payload line exists');
  assert.match(line!, /at: Date\.now\(\)/, 'and it carries the clock the server guard needs');
});
