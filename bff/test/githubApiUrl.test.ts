// GITHUB_API_URL (v0.55.1, lib/githubRelease.ts): where the update check and Fix everything's download counts ask
// GitHub, for a mirror or a test rig. The browser walk points it at its fake engine, which answers the releases list
// there, so the popular-first order is driven end to end (web/test/e2e/autofixWalk.mjs). Unset, it is GitHub's API.
// Reintroduce the hard-coded address in releaseAssets: "the releases list is asked where GITHUB_API_URL says" fails.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
// Read once, when the module loads: set before the import below.
process.env.GITHUB_API_URL = 'http://mirror.example/github/';

test('both reads go where GITHUB_API_URL says, with its trailing slash dropped', async () => {
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: any) => {
    asked.push(String(u));
    return new Response(JSON.stringify(String(u).endsWith('/latest') ? { tag_name: 'v3.5.0' } : []), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const gh = await import('../src/lib/githubRelease');
    gh.resetReleaseCache();
    assert.equal(await gh.latestRelease('FlareSolverr/FlareSolverr'), 'v3.5.0');
    await gh.releaseAssets('keiyoushi/extensions');
    assert.deepEqual(asked, [
      'http://mirror.example/github/repos/FlareSolverr/FlareSolverr/releases/latest',
      'http://mirror.example/github/repos/keiyoushi/extensions/releases?per_page=100',
    ], 'the releases list is asked where GITHUB_API_URL says');
  } finally {
    globalThis.fetch = realFetch;
  }
});
