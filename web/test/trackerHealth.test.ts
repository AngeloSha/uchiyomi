// Tracker-dependent surfaces follow the person's own connection (lib/trackerHealth.ts), and a connection that needs
// reconnecting is said to its owner, not only to admins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { trackerNeedsReconnect, trackerUsable, usableTrackers, brokenTrackers } from '../lib/trackerHealth';
import type { TrackerStatus } from '../lib/types';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const row = (o: Partial<TrackerStatus> = {}): TrackerStatus => ({
  provider: 'anilist', connected: true, accountName: 'a', expiresAt: null, expiringSoon: false, lastSyncAt: null, lastError: null, ...o,
});
const NOW = Date.parse('2026-10-13T00:00:00Z');

test('a sound connection is usable; never connected is neither usable nor broken', () => {
  assert.equal(trackerUsable(row(), NOW), true);
  const none = row({ connected: false });
  assert.equal(trackerUsable(none, NOW), false);
  assert.equal(trackerNeedsReconnect(none, NOW), false);
});

test('rejected, failing and expired connections need reconnecting and are not usable', () => {
  const rejected = row({ connected: false, lastError: 'the tracker rejected the saved token -- reconnect to resume syncing' });
  const failing = row({ lastError: 'sync failed' });
  const expired = row({ expiresAt: '2026-10-01T00:00:00Z' });
  for (const r of [rejected, failing, expired]) {
    assert.equal(trackerNeedsReconnect(r, NOW), true);
    assert.equal(trackerUsable(r, NOW), false);
  }
  assert.equal(trackerNeedsReconnect(row({ expiresAt: '2026-11-01T00:00:00Z', expiringSoon: true }), NOW), false, 'expiring soon still works');
  assert.deepEqual(usableTrackers([row(), failing], NOW).length, 1);
  assert.deepEqual(brokenTrackers([row(), failing, expired], NOW).length, 2);
  assert.deepEqual(usableTrackers(undefined), []);
});

test('the import intake offers only working connections, and says to reconnect when the one it had is broken', () => {
  const imp = read('app/admin/import/page.tsx');
  assert.match(imp, /const connected = usableTrackers\(data\)/);
  assert.match(imp, /broken\.length \? tr\('Your tracker rejected the saved login\. Reconnect it under Profile\.'\)/);
});

test('public AniList surfaces are not gated on the account', () => {
  assert.doesNotMatch(read('components/RatingsPanel.tsx'), /trackerHealth/);
  assert.doesNotMatch(read('components/RelatedRail.tsx'), /trackerHealth/);
});

test('the owner sees a reconnect notice on every page, linking to Profile → Connections', () => {
  const shell = read('components/AppShell.tsx');
  assert.match(shell, /<TrackerAlert \/>/);
  const alert = read('components/TrackerAlert.tsx');
  assert.match(alert, /brokenTrackers\(data\)/);
  assert.match(alert, /card=tracking/);
});
