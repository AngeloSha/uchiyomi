// What the CI rows say about a smoke that failed: scripts/ci/lib.mjs smokeDigest(), which every --smoke check reads,
// and the product smoke's check() lines. A failed smoke must come out as a FAIL row that says why -- never as a row
// that hides the cause, nor as the check script itself crashing on a missing field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { smokeDigest } from '../scripts/ci/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const late = 'Error [ERR_STREAM_WRITE_AFTER_END]: write after end\n    at _write (node:internal/streams/writable:489:11)';
const result = (o) => ({ exit: 1, ms: 61_000, out: '', result: { ok: false, checks: { healthz: { status: 200, pass: true } }, stop: { bff: 'exited:0', postgres: 'fast', pass: true }, uncaught: [], ...o } });

test('smokeDigest: an uncaught exception in the app is the failed smoke\'s error, so every row that prints one names it', () => {
  // Reintroduce by dropping `uncaughtLines(s.result)?.[0]` from `error`: the digest has no error, so a row says the
  // smoke failed and nothing about why.
  const d = smokeDigest(result({ uncaught: [{ kind: 'uncaughtException', stack: late }, { kind: 'unhandledRejection', stack: 'x'.repeat(5000) }] }));
  assert.equal(d.ok, false);
  assert.equal(d.error, `uncaughtException: ${late}`);
  assert.deepEqual(d.uncaught.map((l) => l.slice(0, 20)), ['uncaughtException: E', 'unhandledRejection: ']);
  assert.ok(d.uncaught.every((l) => l.length <= 1500), 'each line bounded');
  // The smoke's own error still comes first; the uncaught ones stay listed beside it.
  const own = smokeDigest(result({ error: 'Error: library folder: not writable', uncaught: [{ kind: 'uncaughtException', stack: late }] }));
  assert.equal(own.error, 'Error: library folder: not writable');
  assert.equal(own.uncaught.length, 1);
  // A clean smoke: no error, and an empty list that says so.
  const clean = smokeDigest(result({ ok: true }));
  assert.equal(clean.error, undefined);
  assert.deepEqual(clean.uncaught, []);
  // No result at all (killed at smoke()'s timeout): the output's tail, and no list to show.
  const none = smokeDigest({ exit: null, ms: 600_000, out: 'supervisor: stopping (smoke)\nbff: exited with 0', result: null });
  assert.equal(none.uncaught, undefined);
  assert.match(none.error, /bff: exited with 0$/);
});

test("product-smoke.mjs: a check whose detail is undefined still prints its line (JSON.stringify(undefined) is no string)", () => {
  // Reintroduce by dropping `?? null` from either check(): `JSON.stringify(undefined).slice` throws a TypeError and
  // product-smoke.mjs ends as "itself failed", with no row for the checks it had run -- s2-postgres.mjs's crash.
  const src = fs.readFileSync(path.join(here, '..', 'scripts', 'ci', 'product-smoke.mjs'), 'utf8');
  const helpers = src.match(/const check = \(name, ok, detail\) => \{[^]*?\n\s*\};/g) || [];
  assert.equal(helpers.length, 2, 'the product smoke and the server-mode leg each have one');
  for (const h of helpers) assert.match(h, /typeof detail === 'string' \? detail : JSON\.stringify\(detail \?\? null\)\.slice\(0, 1500\)/);
});
