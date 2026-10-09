// The S2-ii rows (scripts/ci/s2-rows.mjs). A fallback smoke that froze and was killed at its timeout is a FAIL row
// that says what was known -- not the TypeError that ended s2-postgres.mjs in the v0.55.9 and v0.55.10 release runs
// ("s2-postgres.mjs itself failed (exit 1)", and every S2 check after it never ran). The verdicts keep their meaning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { smokeDigest } from '../scripts/ci/lib.mjs';
import { fallbackRow, fallbackPrivateRow } from '../scripts/ci/s2-rows.mjs';

const where = {
  base: 'C:\\Users\\runneradmin\\AppData\\Local\\Jösé 名前\\Uchiyomi', profile: 'C:\\Users\\runneradmin\\AppData\\Local\\Jösé 名前',
  shortName: '', eightDot3: 'The volume state is: 0 (8dot3 name creation is enabled).', copyMs: 1268,
};
const privateAcl = 'C:\\ProgramData\\Uchiyomi-0e41c77a8575580c NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\n BUILTIN\\Administrators:(OI)(CI)(F)\n runnervm\\runneradmin:(OI)(CI)(F)';

// What lib.mjs smoke() returns: the app's exit, its run time, its result file (null when never written), its output.
const killedAtTimeout = { exit: null, ms: 600_088, result: null, out: '... INFO supervisor: stopping (smoke)\n... INFO bff: exited with 0\n' };
const ran = (checks = {}, ok = true) => ({
  exit: ok ? 0 : 1, ms: 32_000, out: '',
  result: {
    ok, fallback: { base: 'C:\\ProgramData\\Uchiyomi-0e41c77a8575580c', copied: true },
    checks: { bffBackup: { pass: true, files: { 'db.sql.gz': 12231 } }, engine: { pass: true, states: ['downloading', 'installing', 'starting', 'running'] }, ...checks },
  },
});

test('a fallback smoke killed at its timeout is a FAIL row with what was known, not a TypeError', () => {
  const b = smokeDigest(killedAtTimeout);
  // The premise: this is the digest the old line could not format (JSON.stringify(undefined) is not a string).
  assert.throws(() => JSON.stringify(b.engine).slice(0, 300), TypeError);
  // Reintroduce by formatting the engine with JSON.stringify(b.engine).slice(0, 300) again: this call throws.
  const row = fallbackRow({ b, served: true, acl: '', ...where });
  assert.equal(row.verdict, 'FAIL');
  assert.match(row.summary, /fallback ON: FAILS \(the smoke wrote no result \(exit none after 600 s\); its output ended: .*bff: exited with 0/s);
  assert.match(row.summary, /extension engine: FAILED \(no engine result\)/);
  assert.match(row.summary, /cluster at \(no fallback used\)/);
  // d) reads the same digest: no fallback was recorded, so there is no second start -- still a row, still a FAIL.
  const priv = fallbackPrivateRow({ named: false, reused: false, refused: true, again: null, dErr: '' });
  assert.equal(priv.verdict, 'FAIL');
  assert.match(priv.summary, /directly under %ProgramData%: false; a second start re-verified and reused it: false; a recorded folder other accounts can open was refused: true$/);
});

test('a second start that failed without an error or a fallback is still a row', () => {
  const again = smokeDigest(ran({}, false));
  delete again.fallback;
  // The premise: the old d) line read `(again.error || JSON.stringify(again.fallback)).slice(0, 300)`.
  assert.throws(() => (again.error || JSON.stringify(again.fallback)).slice(0, 300), TypeError);
  const row = fallbackPrivateRow({ named: true, reused: false, refused: true, again, dErr: '' });
  assert.equal(row.verdict, 'FAIL');
  assert.match(row.summary, /reused it: false \(null\)/);
  // A frozen second start says how it ended.
  const frozen = fallbackPrivateRow({ named: true, reused: false, refused: false, again: smokeDigest(killedAtTimeout), dErr: 'FALLBACK_NOT_PRIVATE missing' });
  assert.match(frozen.summary, /reused it: false \(the smoke wrote no result \(exit none after 600 s\)/);
  assert.match(frozen.summary, /was refused: false \(FALLBACK_NOT_PRIVATE missing\)$/);
});

test('the verdicts keep their meaning: every real failure is a FAIL, a real pass is a PASS', () => {
  const ok = smokeDigest(ran());
  const pass = fallbackRow({ b: ok, served: true, acl: privateAcl, ...where });
  assert.equal(pass.verdict, 'PASS', pass.summary);
  assert.match(pass.summary, /fallback ON: works, fallback dir private to this user: true; cluster at C:\\ProgramData\\Uchiyomi-0e41c77a8575580c \(binaries copied: true\); bff backup 12231 B .* extension engine: installed and answering \(downloading -> installing -> starting -> running\)/);
  // The engine never answered: FAIL, with what the smoke said about it.
  const noEngine = fallbackRow({ b: smokeDigest(ran({ engine: { pass: false, error: 'The extension engine did not start within 3 minutes.' } }, false)), served: true, acl: privateAcl, ...where });
  assert.equal(noEngine.verdict, 'FAIL');
  assert.match(noEngine.summary, /extension engine: FAILED \{"pass":false,"error":"The extension engine did not start/);
  // The bff's backup failed, the fallback folder is readable by other accounts, or nothing could be read from it.
  assert.equal(fallbackRow({ b: smokeDigest(ran({ bffBackup: { pass: false, error: 'pg_dump failed' } }, false)), served: true, acl: privateAcl, ...where }).verdict, 'FAIL');
  assert.equal(fallbackRow({ b: ok, served: true, acl: `${privateAcl}\n BUILTIN\\Users:(OI)(CI)(RX)`, ...where }).verdict, 'FAIL');
  assert.equal(fallbackRow({ b: ok, served: true, acl: '', ...where }).verdict, 'FAIL');
  // Without an engine pack served, the engine is not part of the verdict.
  const noFixture = fallbackRow({ b: smokeDigest(ran({ engine: undefined })), served: false, acl: privateAcl, ...where });
  assert.equal(noFixture.verdict, 'PASS');
  assert.match(noFixture.summary, /extension engine: no fixture/);
});
