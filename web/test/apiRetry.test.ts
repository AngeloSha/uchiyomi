// A 401 that is an answer must not be mistaken for an expired session.
//
// `/auth/password` and `/auth/totp/disable` say 401 `{ error: 'wrong_password' }` when the current password
// is wrong; the api client used to read every 401 as "the access token died", rotate the refresh cookie and
// re-POST the same wrong password a second time -- two attempts against the lockout counter for one press
// of Enter, and a refresh round trip for nothing. Driven against the real client with a stubbed fetch.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXT_PUBLIC_API_BASE = '';

// `api.ts` seeds itself from localStorage at load, so the stub goes in before the import.
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
};

const calls: string[] = [];
let firstBody = '{"error":"wrong_password"}';
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = url.replace(/\?.*$/, '');
  calls.push(`${init?.method ?? 'GET'} ${path}`);
  if (path === '/auth/refresh') {
    return new Response(JSON.stringify({ accessToken: 'fresh', user: { id: 'u1' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // The first answer is the refusal under test; a retry, if one happens, gets a 200 so it is visible as a
  // SECOND call rather than as the same error twice.
  const first = calls.filter((c) => c.endsWith(path)).length === 1;
  return first
    ? new Response(firstBody, { status: 401, headers: { 'content-type': 'application/json' } })
    : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
}) as any;

let apiMod: typeof import('../lib/api');
before(async () => {
  apiMod = await import('../lib/api');
});

test('a wrong current password is sent once and refused once', async () => {
  // Reintroduce by dropping `&& !(await isRefusal(res))` from the 401 branch in raw(): the client refreshes,
  // re-POSTs the same body, and the second answer (200 here) is returned as a success.
  calls.length = 0;
  firstBody = '{"error":"wrong_password"}';
  await assert.rejects(
    () => apiMod.api('/auth/password', { json: { current: 'wrong', next: 'new-password' } }),
    (e: any) => e instanceof apiMod.ApiError && e.status === 401 && /wrong_password/.test(e.body),
    'the refusal did not reach the caller as a 401 with its body',
  );
  assert.equal(calls.filter((c) => c === 'POST /auth/password').length, 1, 'a wrong current password is sent once and refused once');
  assert.equal(calls.filter((c) => c === 'POST /auth/refresh').length, 0, 'a spelled-out refusal rotated the refresh cookie');
});

test('a bad authentication code is not retried either', async () => {
  calls.length = 0;
  firstBody = '{"error":"totp_invalid","message":"Incorrect authentication code."}';
  await assert.rejects(() => apiMod.api('/auth/login', { json: { username: 'a', password: 'b', code: '000000' } }));
  assert.equal(calls.filter((c) => c === 'POST /auth/login').length, 1, 'a bad code was re-sent');
  assert.equal(calls.filter((c) => c === 'POST /auth/refresh').length, 0);
});

test('a bare 401 still earns the refresh and the retry', async () => {
  // The control: an expired access token has no `error` the client recognises, and that path is the whole
  // reason the retry exists -- it must keep working, or every long-open tab signs itself out.
  calls.length = 0;
  firstBody = '{"error":"unauthorized"}';
  const out = await apiMod.api('/api/settings', { method: 'PUT', json: { accent: '#7c5cff' } });
  assert.deepEqual(out, {}, 'the retried request did not return the second answer');
  assert.equal(calls.filter((c) => c === 'PUT /api/settings').length, 2, 'the request was not retried after the refresh');
  assert.equal(calls.filter((c) => c === 'POST /auth/refresh').length, 1, 'the session was not refreshed');
});
