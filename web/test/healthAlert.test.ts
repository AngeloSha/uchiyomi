// #101: when an admin's header and banner speak up about the Health page (lib/healthAlert.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { alertTone, bannerWanted, type HealthSummary } from '../lib/healthAlert';

const summary = (o: Partial<HealthSummary> = {}): HealthSummary => ({
  at: '2026-09-26T00:00:00Z', worst: 'warn', count: 1, headline: 'Chapter failures: 3 chapters keep failing', key: 'k1', checks: [], ...o,
});

test('a clean report shows nothing at all', () => {
  const clean = summary({ worst: 'ok', count: 0, headline: null, key: '' });
  assert.equal(alertTone(clean), null);
  assert.equal(alertTone(null), null, 'no report yet (right after an upgrade) is not a problem');
  assert.equal(bannerWanted(clean, null, '/'), false);
});

test('the marker takes the worst status', () => {
  assert.equal(alertTone(summary()), 'warn');
  assert.equal(alertTone(summary({ worst: 'problem' })), 'problem');
});

test('a dismissal remembers the checks: one going quiet brings nothing back, a new or worse one does (v0.48.3)', async () => {
  const { seenValue, prunedSeen } = await import('../lib/healthAlert');
  const two = summary({ key: 'ab', checks: [
    { id: 'chapter-gaps', title: 'Gaps', status: 'warn', summary: '' },
    { id: 'sources', title: 'Sources', status: 'warn', summary: '' },
  ] });
  const seen = seenValue(two);
  // Reintroduce by comparing keys again: ignoring the last gap changes the key, and the banner comes back.
  const gapsQuiet = summary({ key: 'b', checks: [{ id: 'sources', title: 'Sources', status: 'warn', summary: '' }] });
  assert.equal(bannerWanted(gapsQuiet, seen, '/library'), false, 'a check that went quiet brought the banner back');
  const worse = summary({ key: 'b2', worst: 'problem', checks: [{ id: 'sources', title: 'Sources', status: 'problem', summary: '' }] });
  assert.equal(bannerWanted(worse, seen, '/library'), true, 'a check that got worse stayed quiet');
  const fresh = summary({ key: 'c', checks: [{ id: 'duplicates', title: 'Dups', status: 'warn', summary: '' }] });
  assert.equal(bannerWanted(fresh, seen, '/library'), true, 'a new kind of problem stayed quiet');
  // And the dismissal follows the checks down: once gaps went quiet it is gone from it, so its return is news.
  const pruned = prunedSeen(gapsQuiet, seen)!;
  assert.ok(pruned, 'the dismissal was not pruned');
  assert.equal(bannerWanted(two, pruned, '/library'), true, 'a check that went quiet and came back stayed dismissed');
  // A dismissal stored by v0.48.0-v0.48.2 (the bare key) still works the old way.
  assert.equal(bannerWanted(summary({ key: 'k1' }), 'k1', '/library'), false);
});

test('the banner shows once per finding set: dismissed for a key, it stays away until the key changes', () => {
  assert.equal(bannerWanted(summary(), null, '/library'), true, 'never dismissed');
  // Reintroduce by comparing anything but the key (a count, a timestamp): a dismissal lasts one report.
  assert.equal(bannerWanted(summary({ count: 2, at: '2026-09-27T00:00:00Z' }), 'k1', '/library'), false,
    'the same checks with a different count or a newer report are the same problem, still dismissed');
  assert.equal(bannerWanted(summary({ key: 'k2' }), 'k1', '/library'), true, 'a new kind of problem brings it back');
});

test('never on the admin console, where the Health tab is one click away', () => {
  assert.equal(bannerWanted(summary(), null, '/admin/'), false);
  assert.equal(bannerWanted(summary(), null, '/admin'), false);
});
