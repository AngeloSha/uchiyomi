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
