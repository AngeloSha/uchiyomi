// Knowing the Cloudflare solver is behind — without letting that knowledge break anything.
//
// The version was already in hand: the solver announces it, and the health page printed it and threw the
// rest away. Comparing it to the latest release is the small part. The part worth testing is that this is
// the backend's ONLY outbound call to GitHub, and that nothing about it can matter: no network, a
// rate-limited reply, a tag nobody predicted — every one has to mean "no opinion", never an error and never
// a working solver reported as broken.
import test, { before, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';

let mod: typeof import('../src/lib/solverVersion');
before(async () => { mod = await import('../src/lib/solverVersion'); });

test('a version is behind only when it is genuinely older', () => {
  const { isBehind } = mod;
  assert.equal(isBehind('3.4.0', 'v3.5.0'), true);
  assert.equal(isBehind('v3.5.0', 'v3.5.0'), false, 'current is not behind');
  assert.equal(isBehind('3.6.0', 'v3.5.0'), false, 'a newer build than the last release is not behind');
  assert.equal(isBehind('2.9.9', 'v3.0.0'), true, 'a major behind counts');
  assert.equal(isBehind('3.5.0', 'v3.5.1'), true, 'so does a patch');
});

test('versions are compared as numbers, not as text', () => {
  // ⚠️ Reintroduce by comparing the strings directly: '3.10.0' < '3.5.0' lexically, so a solver that is
  // FIVE minor versions ahead would be reported as out of date, and the operator would be told to update to
  // something older than what they are running.
  assert.equal(mod.isBehind('3.10.0', 'v3.5.0'), false, '3.10.0 is newer than 3.5.0');
  assert.equal(mod.isBehind('3.5.0', 'v3.10.0'), true);
  assert.deepEqual(mod.parseVersion('v3.10.2'), [3, 10, 2]);
});

test('anything unparseable means no opinion, never "out of date"', () => {
  // The safe direction: an unrecognised version string must read as "nothing to say". A fork, a nightly, a
  // `dev` tag or an empty greeting must never produce a scary banner.
  for (const [a, b] of [
    [null, 'v3.5.0'], ['3.4.0', null], ['', 'v3.5.0'], ['dev', 'v3.5.0'],
    ['3.4', 'v3.5.0'], ['3.4.0', 'nightly'], [undefined, undefined],
  ] as Array<[string | null | undefined, string | null | undefined]>) {
    assert.equal(mod.isBehind(a, b), false, `isBehind(${a}, ${b}) must be false`);
  }
});

test('an unreachable GitHub is not an error — it is silence', async (t) => {
  // ⚠️ THE PROPERTY THAT MATTERS. This is the only place the backend calls GitHub, and the health page it
  // feeds must not be able to fail because github.com is having an afternoon.
  // Reintroduce by letting the fetch rejection propagate instead of catching it: the health route 500s
  // whenever GitHub is unreachable, rate-limited, or slow.
  mod.resetSolverVersionCache();
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('getaddrinfo ENOTFOUND'); });
  assert.equal(await mod.latestSolverVersion(), null);
});

test('a rate-limited or malformed reply is silence too', async (t) => {
  mod.resetSolverVersionCache();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 403, json: async () => ({}) }) as never);
  assert.equal(await mod.latestSolverVersion(), null, 'a 403 is a normal Tuesday, not a fault');

  mod.resetSolverVersionCache();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ tag_name: 'not-a-version' }) }) as never);
  assert.equal(await mod.latestSolverVersion(), null, 'a tag we cannot parse is no answer at all');
});

test('the answer is cached, including a failure', async (t) => {
  // ⚠️ Caching the NULL is the point. Without it an unreachable GitHub is retried on every single health
  // page load, which is the rate-limit problem this cache exists to prevent, only worse.
  // Reintroduce by only caching a successful lookup: `calls` below climbs with every check.
  mod.resetSolverVersionCache();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('down'); });
  await mod.latestSolverVersion();
  await mod.latestSolverVersion();
  await mod.latestSolverVersion();
  assert.equal(calls, 1, 'a failed lookup must not be retried on every health check');
});

test('a good answer is returned and then reused', async (t) => {
  mod.resetSolverVersionCache();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { ok: true, json: async () => ({ tag_name: 'v3.5.0' }) } as never;
  });
  assert.equal(await mod.latestSolverVersion(), 'v3.5.0');
  assert.equal(await mod.latestSolverVersion(), 'v3.5.0');
  assert.equal(calls, 1);
});

test("trawl's releases are asked of trawl's own repository, and cached apart from FlareSolverr's", async (t) => {
  // v0.55.3: trawl (#144) is held against its own releases, never FlareSolverr's 3.x. Reintroduce one repository for
  // every kind (SOLVER_REPOS): trawl's question goes to FlareSolverr/FlareSolverr and answers v3.6.0.
  mod.resetSolverVersionCache();
  const asked: string[] = [];
  t.mock.method(globalThis, 'fetch', async (u: unknown) => {
    asked.push(String(u));
    return { ok: true, json: async () => ({ tag_name: String(u).includes('/repos/germondai/trawl/') ? 'v1.7.0' : 'v3.6.0' }) } as never;
  });
  assert.equal(await mod.latestSolverVersion(), 'v3.6.0', 'FlareSolverr, by default, as before');
  assert.equal(await mod.latestSolverVersion(Date.now(), 'trawl'), 'v1.7.0', "trawl's own latest release");
  assert.deepEqual(asked.map((u) => new URL(u).pathname), ['/repos/FlareSolverr/FlareSolverr/releases/latest', '/repos/germondai/trawl/releases/latest']);
  assert.equal(await mod.latestSolverVersion(Date.now(), 'trawl'), 'v1.7.0');
  assert.equal(asked.length, 2, 'each answer is cached for its own repository');
});
