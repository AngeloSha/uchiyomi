// Forgetting what this process remembers about the Cloudflare solver, and nothing more.
//
// A `cf_clearance` cookie that Cloudflare has rotated is re-sent with every image request until the process
// restarts, and an origin stamped unsolvable is not re-solved for five minutes however healthy it has
// become; live, "restart the solver" fixed both by accident. The nightly repair and the Health page's
// "Reset solver sessions" call resetSolverSessions() instead. The app has no container access and must
// never get any, so this is the whole of what a "solver reset" is.
import test from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../src/lib/sources/flaresolverr');
const solved = (url: string) => new Response(
  JSON.stringify({ status: 'ok', solution: { url, status: 200, response: '<html>ok</html>', cookies: [{ name: 'cf_clearance', value: 'x' }], userAgent: 'UA' } }),
  { status: 200, headers: { 'content-type': 'application/json' } });
const refused = () => new Response(JSON.stringify({ status: 'error', message: 'Cloudflare said no' }), { status: 200, headers: { 'content-type': 'application/json' } });

test('the reset clears every remembered session and unsolvable origin, says how many, and the next request solves afresh', async () => {
  // Reintroduce by returning the counts without the two `clear()` calls: the second reset still counts one
  // of each, and the session is served from memory without a solve.
  const { cfSession, resetSolverSessions } = await load();
  let solves = 0;
  globalThis.fetch = (async (_url: any, init: any) => {
    solves++;
    const asked = JSON.parse(init.body).url as string;
    return asked.startsWith('https://dead.test') ? refused() : solved(asked);
  }) as typeof fetch;

  const first = await cfSession('https://live.test/img/1.png');
  assert.equal(first.cookie, 'cf_clearance=x', 'the solved session is what image fetches get');
  await cfSession('https://dead.test/img/1.png').catch(() => {});
  const solvesBefore = solves;
  await cfSession('https://live.test/img/2.png');
  await cfSession('https://dead.test/img/2.png').catch(() => {});
  assert.equal(solves, solvesBefore, 'both origins are served from memory: one solved, one written off');

  assert.deepEqual(resetSolverSessions(), { sessions: 1, unsolvable: 1 });
  assert.deepEqual(resetSolverSessions(), { sessions: 0, unsolvable: 0 }, 'a second reset finds nothing to clear');

  const again = await cfSession('https://live.test/img/3.png');
  assert.equal(again.cookie, 'cf_clearance=x');
  assert.ok(solves > solvesBefore, 'after the reset the origin is solved again rather than served from memory');
  const solvedAfterLive = solves;
  await cfSession('https://dead.test/img/3.png').catch(() => {});
  assert.ok(solves > solvedAfterLive, 'and a written-off origin is given another try at once');
});
