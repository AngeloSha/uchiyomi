// What the opt-in install count is allowed to say about you.
//
// This file exists because the feature is only defensible if its limits are enforced rather than described.
// An install count that quietly grew a `seriesCount` field would still pass every other test in this repo,
// still look identical in the settings page, and would be a straightforward breach of what the operator
// agreed to. So the key list is pinned, the id is checked for the property it claims, and the off switch is
// checked for actually being off.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  monthlyId, currentMonth, newSecret, installFacts, buildPayload, sendPing, sendForget, DEFAULT_PING_URL,
} from '../src/lib/installPing';

const FACTS = { version: '0.27.0', arch: 'x64', layout: 'aio' as const, db: 'embedded' as const };

test('THE PAYLOAD: exactly these fields, and no others, ever', () => {
  // ⚠️ THE CONSENT GUARD. The settings page shows an admin the output of `buildPayload` and asks them to
  // agree to it. Anything added here is something they were never shown, so adding a field must break a
  // test and force the question rather than ship quietly.
  // Reintroduce by adding any field -- `seriesCount`, `hostname`, `locale`, `users` -- to buildPayload.
  const p = buildPayload('s3cret', FACTS, new Date('2026-09-10T12:00:00Z'));
  assert.deepEqual(Object.keys(p).sort(), ['arch', 'db', 'id', 'layout', 'month', 'version']);

  // And nothing in it is derived from the library, the users, or the machine's identity.
  assert.equal(p.version, '0.27.0');
  assert.equal(p.arch, 'x64');
  assert.equal(p.layout, 'aio');
  assert.equal(p.db, 'embedded');
  assert.equal(p.month, '2026-09');
  assert.match(p.id, /^[0-9a-f]{32}$/);
});

test('THE ID ROTATES: same month is one install, different months cannot be linked', () => {
  // ⚠️ THE WHOLE PRIVACY CLAIM. Reintroduce by hashing the secret alone (or sending it raw): both rows
  // below become equal, the id is permanent, and an install can be followed for as long as it exists --
  // with a payload that looks exactly the same from the outside.
  const s = newSecret();
  const sep1 = monthlyId(s, new Date('2026-09-01T00:00:00Z'));
  const sep2 = monthlyId(s, new Date('2026-09-30T23:59:59Z'));
  const oct = monthlyId(s, new Date('2026-10-01T00:00:00Z'));

  assert.equal(sep1, sep2, 'two pings in one month must count as one install');
  assert.notEqual(sep1, oct, 'a september id must not be linkable to an october one');
});

test('the secret is never in the payload, and two installs never collide', () => {
  const a = newSecret();
  const b = newSecret();
  assert.notEqual(a, b);
  assert.equal(a.length, 64, '32 random bytes, hex');

  const p = buildPayload(a, FACTS);
  assert.ok(!JSON.stringify(p).includes(a), 'the secret leaked into the payload');
  assert.notEqual(monthlyId(a), monthlyId(b), 'two installs must not report the same id');
});

test('an id cannot be recomputed without the secret', () => {
  // The collector holds `id` and `month`. Being able to derive one from the other would make the rotation
  // decorative. This is really a statement about sha256, asserted so the intent is written down.
  const s = newSecret();
  const id = monthlyId(s, new Date('2026-09-10T00:00:00Z'));
  const fromMonthAlone = monthlyId('', new Date('2026-09-10T00:00:00Z'));
  assert.notEqual(id, fromMonthAlone);
});

test('the month is UTC, so an install does not report two months on one day', () => {
  assert.equal(currentMonth(new Date('2026-09-30T23:30:00Z')), '2026-09');
  assert.equal(currentMonth(new Date('2026-10-01T00:30:00Z')), '2026-10');
});

test('the deployment shape is coarse, and unknowable input is the boring answer', () => {
  // A unix-socket url has no hostname, which is how the entrypoint starts its own Postgres.
  assert.equal(installFacts(null, { DATABASE_URL: 'postgres://yomi@/yomi?host=/run/pg' } as any).db, 'embedded');
  assert.equal(installFacts(null, { DATABASE_URL: 'postgres://u:p@db:5432/yomi' } as any).db, 'external');
  // ⚠️ Unset or unparseable must not throw and must not guess something interesting.
  assert.equal(installFacts(null, {} as any).db, 'external');
  assert.equal(installFacts(null, { DATABASE_URL: 'not a url' } as any).db, 'external');

  assert.equal(installFacts(null, { WEB_ROOT: '/app/web' } as any).layout, 'aio');
  assert.equal(installFacts(null, {} as any).layout, 'split');
  assert.equal(installFacts(null, {} as any, 'arm64').arch, 'arm64');
});

test('an unknown version is null rather than a guess', () => {
  const p = buildPayload('s', installFacts(null, {} as any));
  assert.equal(p.version, null, 'a made-up version would poison the only number this exists to produce');
});

test('sending never throws, and an empty url sends nothing at all', async (t) => {
  // ⚠️ A collector that is down, slow or gone must be a non-event: this runs inside a background tick on
  // somebody else's server. Reintroduce by letting the fetch rejection propagate -- the tick's own catch
  // would swallow it, but the ping would then be able to take its scheduling with it.
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('ENOTFOUND'); });
  // ⚠️ An explicit url, not the default: CI sets UCHIYOMI_PING_URL empty so nothing can ping the real
  // collector, and a test that leant on the ambient default would silently stop exercising the fetch.
  const URL_ = 'https://example.invalid/api/hello';
  assert.equal(await sendPing(buildPayload('s', FACTS), URL_), false);
  assert.equal(await sendForget('abc', URL_), false);
  assert.equal(calls, 2);

  // The env knob is an off switch as well as a redirect: no url, no request.
  calls = 0;
  assert.equal(await sendPing(buildPayload('s', FACTS), ''), false);
  assert.equal(await sendForget('abc', ''), false);
  assert.equal(calls, 0, 'an empty ping url must not reach the network at all');
});

test('the default collector is not the update-check host', () => {
  // ⚠️ THE SEPARATION, ASSERTED. If the update check and the count shared a destination, that server could
  // count installs from its access log with nobody consenting, and the off switch would be theatre.
  // Reintroduce by pointing PING_URL at api.github.com, or the update check at uchiyomi.com.
  assert.ok(!DEFAULT_PING_URL.includes('api.github.com'), 'the count must not be sent to the update-check host');
  assert.match(DEFAULT_PING_URL, /^https:\/\//, 'the count must go over https');
});
