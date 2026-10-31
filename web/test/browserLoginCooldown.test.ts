import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureLogin, loginCooldownMs } from './e2e/loginCooldown.mjs';

test('browser login respects one bounded server cooldown and still requires HTTP 200', async () => {
  const requests: unknown[] = [], pauses: number[] = [];
  const responses = [new Response('{}', { status: 429, headers: { 'retry-after': '1' } }), new Response('{"accessToken":"fixture"}', { status: 200 })];
  const result = await fixtureLogin('http://127.0.0.1:18140', { username: 'fixture', password: 'fixture-pass' }, {
    fetcher: async (_url, options) => { requests.push(options); return responses.shift()!; },
    pause: async (ms) => { pauses.push(ms); },
  });
  assert.equal(result.status, 200); assert.equal(requests.length, 2); assert.deepEqual(pauses, [2000]);
  assert.deepEqual(await result.json(), { accessToken: 'fixture' });
});

test('browser login never retries wrong credentials, server errors, or a second refusal', async () => {
  for (const statuses of [[401], [403], [500], [429, 429]]) {
    let count = 0; const pauses: number[] = [];
    await assert.rejects(() => fixtureLogin('http://127.0.0.1:18140', {}, {
      fetcher: async () => new Response('{}', { status: statuses[count++], headers: { 'retry-after': '1' } }),
      pause: async (ms) => { pauses.push(ms); },
    }));
    assert.equal(count, statuses.length); assert.equal(pauses.length, statuses.length - 1);
  }
});

test('a missing, malformed or overlong cooldown fails closed without another request', async () => {
  for (const header of [undefined, null, '', 'nonsense', '-1', '0', 'Infinity', '301']) assert.throws(() => loginCooldownMs(header));
  assert.equal(loginCooldownMs('300'), 301000);
  let count = 0;
  await assert.rejects(() => fixtureLogin('http://127.0.0.1:18140', {}, { fetcher: async () => { count++; return new Response('{}', { status: 429 }); } }));
  assert.equal(count, 1);
});

test('the API login helper refuses non-fixture origins before sending credentials', async () => {
  let requested = false;
  await assert.rejects(() => fixtureLogin('https://example.invalid', {}, { fetcher: async () => { requested = true; return new Response('{}'); } }));
  assert.equal(requested, false);
});
