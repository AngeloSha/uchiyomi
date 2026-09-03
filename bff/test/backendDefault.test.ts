// What backend runs when nobody says.
//
// `OWNED = LIBRARY_BACKEND === 'owned'` meant an unset or misspelled variable chose Komga, whose visibility
// model is "Komga enforces it" -- so viewCtxFor() returned an unrestricted context to every account, on the
// path that governs page bytes and OPDS downloads. Every compose file sets the variable, which is exactly
// why nobody noticed: the env var was the only thing between a typo and a library-wide fail-open.
//
// Reintroduce by restoring `=== 'owned'` in backend.ts and `!== 'owned'` in visibility.ts: both fail.
delete process.env.LIBRARY_BACKEND; // the case under test: nothing set at all
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
import test from 'node:test';
import assert from 'node:assert/strict';

test('with LIBRARY_BACKEND unset, the owned backend is selected', async () => {
  const { OWNED } = await import('../src/lib/backend');
  assert.equal(OWNED, true);
});

test('with LIBRARY_BACKEND unset, the visibility model is enforced rather than skipped', async () => {
  const { viewCtxFor } = await import('../src/lib/visibility');
  // The admin short-circuit needs no database and tells the two branches apart: the Komga branch discards
  // the hideAdult preference (it returns false regardless), the owned branch honours it.
  const ctx = await viewCtxFor('u1', 'admin', { hideAdult: true });
  assert.equal(ctx.hideAdultLibraries, true, 'the owned model answered, not the "Komga enforces it" branch');
});
