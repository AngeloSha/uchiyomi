// Which tracker connections only a new token mends (#246, lib/trackers.ts needsReconnect): the line above every page and
// the import's tracker box read this, so a rate limit or an outage must never ask a person to reconnect.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
let t: typeof import('../src/lib/trackers');
before(async () => { t = await import('../src/lib/trackers'); });

const NOW = Date.parse('2026-10-16T00:00:00Z');
const row = (o: Partial<{ enabled: boolean; expires_at: string | null; last_error: string | null }> = {}) =>
  ({ enabled: true, expires_at: null, last_error: null, ...o });

test('a rejected, lapsed or unreadable token asks for a reconnect', () => {
  assert.equal(t.needsReconnect(row({ enabled: false, last_error: t.TOKEN_REJECTED }), NOW), true, 'a rejected token');
  assert.equal(t.needsReconnect(row({ last_error: t.TOKEN_EXPIRED }), NOW), true, 'the lapsed-token line');
  assert.equal(t.needsReconnect(row({ last_error: t.TOKEN_UNREADABLE }), NOW), true, 'an unreadable token');
  assert.equal(t.needsReconnect(row({ expires_at: '2026-10-01T00:00:00Z' }), NOW), true, 'past its expiry, whatever the last push said');
  assert.equal(t.needsReconnect(row({ enabled: false }), NOW), true, 'switched off with no line: only a rejection does that');
});

test('a rate limit, an outage or the floor refusal never asks for a reconnect', () => {
  // syncFailed writes the service's own message for these (429, 5xx, a Cloudflare 403), and the push writes the floor
  // refusal, which tells the person to import their list again -- reconnecting would mend none of them.
  for (const line of [
    'AniList returned 429',
    'MyAnimeList returned 503',
    'sync failed',
    'not syncing: this series now works out to chapter 4, below the 9 already sent. Import your list again under Admin → Import (From your tracker) to take the tracker\'s current number, or ask an admin to.',
  ]) assert.equal(t.needsReconnect(row({ last_error: line }), NOW), false, line);
  assert.equal(t.needsReconnect(row(), NOW), false, 'a sound connection');
  assert.equal(t.needsReconnect(row({ expires_at: '2026-11-01T00:00:00Z' }), NOW), false, 'expiring soon still works');
});
