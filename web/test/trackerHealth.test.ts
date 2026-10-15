// Tracker-dependent surfaces follow the person's own connection (lib/trackerHealth.ts, #246), and a connection that
// needs a new token is said to its owner -- only that: a rate limit or an outage is not a reason to reconnect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { trackerNeedsReconnect, trackerUsable, usableTrackers, brokenTrackers, reconnectSignature } from '../lib/trackerHealth';
import type { TrackerStatus } from '../lib/types';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const row = (o: Partial<TrackerStatus> = {}): TrackerStatus => ({
  provider: 'anilist', connected: true, accountName: 'a', expiresAt: null, expiringSoon: false, lastSyncAt: null, lastError: null, needsReconnect: false, ...o,
});
const NOW = Date.parse('2026-10-13T00:00:00Z');

test('a sound connection is usable; never connected is neither usable nor broken', () => {
  assert.equal(trackerUsable(row(), NOW), true);
  const none = row({ connected: false });
  assert.equal(trackerUsable(none, NOW), false);
  assert.equal(trackerNeedsReconnect(none, NOW), false);
});

test('a rejected or lapsed token needs reconnecting and is not usable', () => {
  const rejected = row({ connected: false, lastError: 'the tracker rejected the saved token -- reconnect to resume syncing', needsReconnect: true });
  const lapsed = row({ lastError: 'the access token has expired -- reconnect to resume syncing', needsReconnect: true });
  // Cached since before its expiry: the server said it was fine then, and it has lapsed since.
  const expiredSince = row({ expiresAt: '2026-10-01T00:00:00Z' });
  for (const r of [rejected, lapsed, expiredSince]) {
    assert.equal(trackerNeedsReconnect(r, NOW), true);
    assert.equal(trackerUsable(r, NOW), false);
  }
  assert.equal(trackerNeedsReconnect(row({ expiresAt: '2026-11-01T00:00:00Z', expiringSoon: true }), NOW), false, 'expiring soon still works');
  assert.equal(brokenTrackers([row(), rejected, expiredSince], NOW).length, 2);
  assert.deepEqual(usableTrackers(undefined), []);
});

test('a rate limit is not a broken connection: it stays usable and asks for nothing', () => {
  // syncFailed writes the service's message for a 429, a 5xx or a Cloudflare 403, and the push writes the floor refusal
  // (import your list again): the server leaves `needsReconnect` false for all of them. #246 as opened read any lastError
  // as broken, so "Reconnect" sat above every page until the next good sync, and the import box hid the connection the
  // floor line sends the person to. Reintroduce by testing lastError: both assertions fail.
  for (const lastError of ['AniList returned 429', 'sync failed', 'not syncing: this series now works out to chapter 4, below the 9 already sent.']) {
    const r = row({ lastError });
    assert.equal(trackerNeedsReconnect(r, NOW), false, lastError);
    assert.equal(trackerUsable(r, NOW), true, lastError);
  }
});

test('Not now holds for the same problem, and a new one brings the line back', () => {
  const a = row({ connected: false, lastError: 'x', needsReconnect: true });
  const b = row({ provider: 'myanimelist', expiresAt: '2026-10-01T00:00:00Z' });
  assert.equal(reconnectSignature([a]), reconnectSignature([{ ...a }]));
  assert.notEqual(reconnectSignature([a]), reconnectSignature([a, b]), 'a second broken connection reads as the one dismissed');
  assert.equal(reconnectSignature([a, b]), reconnectSignature([b, a]), 'the order of the rows changes what was dismissed');
});

test('the import intake offers only working connections, and says to reconnect when the one it had is broken', () => {
  const imp = read('app/admin/import/page.tsx');
  assert.match(imp, /const connected = usableTrackers\(data\)/);
  assert.match(imp, /broken\.length \? tr\('Your tracker token no longer works\. Reconnect it under Profile\.'\)/);
});

test('public AniList surfaces are not gated on the account', () => {
  assert.doesNotMatch(read('components/RatingsPanel.tsx'), /trackerHealth/);
  assert.doesNotMatch(read('components/RelatedRail.tsx'), /trackerHealth/);
});

test('the owner sees Health\'s line, in Health\'s slot: safe-top, the rail offset, Reconnect and Not now', () => {
  const shell = read('components/AppShell.tsx');
  // One stack above the top bar, the tracker's line last: only the stack's first line meets the status bar.
  const stack = shell.slice(shell.indexOf('<div className="banner-stack"'), shell.indexOf('<TopNav '));
  assert.ok(stack.indexOf('<HealthBanner />') > 0 && stack.indexOf('<TrackerAlert />') > stack.indexOf('<HealthBanner />'), 'the tracker line is not in the stack, after Health\'s');
  assert.match(read('app/globals.css'), /\.banner-stack > \.safe-top:not\(:first-child\) \{ padding-top: 0\.5rem; \}/, 'a second safe-top line gets a second notch');
  const alert = read('components/TrackerAlert.tsx');
  assert.match(alert, /brokenTrackers\(data\)/);
  assert.match(alert, /card=tracking/);
  const cls = /data-tracker-alert\s+className="([^"]*)"/.exec(alert)?.[1] ?? '';
  for (const c of ['safe-top', 'relative', 'z-[1]', 'lg:ps-[calc(var(--rail-w)+1rem)]', 'lg:pt-2']) assert.ok(cls.split(/\s+/).includes(c), `the line lacks ${c}`);
  assert.match(alert, /onClick=\{dismiss\}[^>]*data-tracker-not-now>\{tr\('Not now'\)\}/, 'no Not now');
});
