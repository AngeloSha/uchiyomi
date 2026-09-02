// How many Cloudflare solves we ask for at once.
//
// FlareSolverr drives real Chrome. The fill scan searches every configured source in parallel, which put a
// dozen challenges on it simultaneously; live it logged "Task queue depth is 4" and then
// "Error starting Chrome: Service /app/chromedriver unexpectedly exited". A crashed solve surfaces to the
// caller as the SITE refusing us, so our own fan-out was manufacturing source failures.
process.env.SOLVER_CONCURRENCY = '3';
import test from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../src/lib/sources/flaresolverr');

test('never more than SOLVER_CONCURRENCY solves are in flight', async () => {
  const { cfGet } = await load();
  let now = 0, peak = 0;
  globalThis.fetch = (async () => {
    now++; peak = Math.max(peak, now);
    await new Promise((r) => setTimeout(r, 20));
    now--;
    return new Response(
      JSON.stringify({ status: 'ok', solution: { url: 'https://e.test/', status: 200, response: '<html>ok</html>', cookies: [], userAgent: 'UA' } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  await Promise.all(Array.from({ length: 12 }, (_, i) => cfGet(`https://e.test/${i}`)));

  assert.equal(peak <= 3, true, `peak concurrent solves was ${peak}, cap is 3`);
  assert.ok(peak > 1, 'and it is a cap, not accidental serialisation');
});

/** A solve that throws must still free its slot, or the queue deadlocks after SOLVER_CONCURRENCY failures. */
test('a failed solve releases its slot', async () => {
  const { cfGet } = await load();
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('solver down'); }) as typeof fetch;

  for (let i = 0; i < 5; i++) await cfGet(`https://e.test/fail${i}`).catch(() => {});
  assert.equal(calls, 5, 'every attempt got a slot; a leaked slot would hang here instead');

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ status: 'ok', solution: { url: 'https://e.test/', status: 200, response: '<html>ok</html>', cookies: [], userAgent: 'UA' } }),
      { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  assert.match(await cfGet('https://e.test/after'), /ok/, 'and the pool still works afterwards');
});
