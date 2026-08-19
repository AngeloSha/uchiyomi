// The guarantee that protects every existing install: with no extension server configured, the bridge does
// nothing at all -- no network call, no database work, no throw -- and the server boots exactly as before.
//
// Deliberately its own file, because the env is read when the module loads, so this has to run in a process
// where SUWAYOMI_URL was never set. If this test ever fails, an unconfigured install is doing something it
// should not, and boot is the worst possible place to find that out.
import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUWAYOMI_URL;
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.DATABASE_URL ||= 'postgres://unused/unused';

test('unconfigured: reports off and does not throw', async () => {
  const { loadSuwayomiSources } = await import('../src/lib/sources/suwayomi/register');
  // the injected lister must never be called — reaching the network when unconfigured would be the bug
  let called = false;
  const r = await loadSuwayomiSources(async () => {
    called = true;
    return [];
  });
  assert.equal(called, false, 'it tried to contact an extension server that was never configured');
  assert.deepEqual(r, { configured: false, reachable: false, available: 0, registered: 0, skipped: 0 });
});

test('unconfigured: the client refuses rather than fetching a bad URL', async () => {
  const { suwayomiConfigured, gql } = await import('../src/lib/sources/suwayomi/client');
  assert.equal(suwayomiConfigured(), false);
  await assert.rejects(() => gql('{ __typename }'), /not configured/i);
});
