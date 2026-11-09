import test from 'node:test';
import assert from 'node:assert/strict';
import { errorDetailsOf, errorNoticeOf, redactDiagnostic } from '../lib/errorDetails';
import { pushNotice, type Notice } from '../lib/notices';

test('extension failures keep the complete diagnostic behind a localized summary', () => {
  const trace = `java.lang.IllegalStateException: install failed\n${Array.from({ length: 160 }, (_, i) => `\tat Extension.install(Extension.kt:${i})`).join('\n')}\nCaused by: missing package`;
  const [message, tone, options] = errorNoticeOf({ status: 502, body: JSON.stringify({ error: 'engine_refused', message: trace, reason: 'APK signature mismatch', password: 'not-for-diagnostics', config: { token: 'also-secret' } }) }, 'Die Erweiterung konnte nicht installiert werden');
  assert.equal(message, 'Die Erweiterung konnte nicht installiert werden');
  assert.equal(tone, 'error');
  assert.ok(options.details?.includes(trace), 'the final frames or nested failure were lost');
  assert.ok(options.details?.includes('APK signature mismatch'));
  assert.ok(options.details?.startsWith('HTTP 502'));
  assert.doesNotMatch(options.details!, /not-for-diagnostics|also-secret|"config"|"password"/);
});

test('known diagnostic fields include nested causes and every failed extension, with cycles bounded', () => {
  const cycle: { message: string; cause?: unknown } = { message: 'third cause' }; cycle.cause = cycle;
  assert.equal(errorDetailsOf({ message: 'first failure', cause: { reason: 'second failure', cause: cycle } }), 'first failure\n\nsecond failure\n\nthird cause');
  const details = errorDetailsOf({ errors: [{ message: 'Extension A', reason: 'failed A' }, { message: 'Extension B', reason: 'failed B' }] });
  assert.equal(details, 'Extension A\n\nfailed A\n\nExtension B\n\nfailed B');
});

test('diagnostics redact credential headers, assignments, signed URLs and embedded credentials without losing strokes of a trace', () => {
  const raw = 'HTTP 502\nAuthorization: Bearer abc.def.secret\nCookie: refresh=private; session=private\nhttps://user:private@host.test/install?token=private&name=volume\n{"password":"private","api_key":"private","authorization":"Bearer private"}\naccess_token=private\nBearer private\n\tat install:42';
  const clean = redactDiagnostic(raw);
  assert.doesNotMatch(clean, /private|abc\.def\.secret/);
  assert.match(clean, /name=volume/);
  assert.match(clean, /install:42/);
  assert.equal(redactDiagnostic(clean), clean, 'passing a helper diagnostic into Toast changes the redaction');
});

test('malformed responses and missing details stay usable, never dumping a raw response object', () => {
  assert.deepEqual(errorNoticeOf(null, 'Could not install'), ['Could not install', 'error', {}]);
  assert.deepEqual(errorNoticeOf({ body: '<html>password=secret</html>', status: 502 }, 'Could not install'), ['Could not install', 'error', { details: 'HTTP 502' }]);
  assert.deepEqual(errorNoticeOf({ body: '{broken JSON', request: { secret: 'private' } }, 'Could not install'), ['Could not install', 'error', {}]);
  assert.equal(errorNoticeOf({ body: JSON.stringify({ messageSaid: { code: 'unknown' } }) }, 'Could not install')[0], 'Could not install');
  assert.equal(errorNoticeOf({ body: JSON.stringify({ messageSaid: { invalid: true } }) }, 'Could not install')[0], 'Could not install');
  assert.equal(errorNoticeOf({ body: JSON.stringify({ messageSaid: { code: '__proto__' } }) }, 'Could not install')[0], 'Could not install');
});

test('different failures with the same summary retain their own details; a keyed success removes old diagnostics', () => {
  const next = (id: number, details?: string, key?: string) => ({ id, msg: 'Could not install', type: 'error' as const, busy: false, duration: 6000, details, key });
  let list: Notice[] = pushNotice([], next(1, 'trace A'));
  list = pushNotice(list, next(2, 'trace B'));
  assert.equal(list.length, 2);
  list = pushNotice(list, next(3, 'trace B'));
  assert.equal(list.length, 2); assert.equal(list[1].count, 2);
  list = pushNotice(list, next(4, 'trace C', 'extension'));
  list = pushNotice(list, { ...next(5, undefined, 'extension'), msg: 'Installed', type: 'success' });
  assert.equal(list.at(-1)?.details, undefined);
  assert.equal(list.at(-1)?.msg, 'Installed');
});
