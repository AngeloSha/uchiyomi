// The disposable browser suite shares the production sign-in policy. Respect it rather than exempting tests.
import assert from 'node:assert/strict';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function loginCooldownMs(header) {
  const seconds = Number(header);
  assert.ok(Number.isFinite(seconds) && seconds > 0 && seconds <= 300, 'login cooldown must expose a bounded positive Retry-After');
  return Math.ceil(seconds * 1000) + 1000;
}
export async function waitForLoginCooldown(header, pause = sleep) {
  const delay = loginCooldownMs(header);
  console.log(`  waiting ${Number(header)}s for the server's sign-in allowance`);
  await pause(delay);
}
export async function fixtureLogin(base, credentials, { fetcher = fetch, pause = sleep } = {}) {
  const target = new URL(base);
  assert.ok(target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname), 'disposable loopback fixture required');
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetcher(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credentials), signal: AbortSignal.timeout(30000) });
    if (response.status === 429 && attempt === 0) {
      await waitForLoginCooldown(response.headers.get('retry-after'), pause);
      continue;
    }
    assert.equal(response.status, 200, 'the browser fixture must sign in successfully');
    return response;
  }
  throw new Error('The browser fixture did not complete sign-in.');
}
