// The scout's order and its memory's lifetimes (v0.80.0, lib/sourceScout.ts scoutOrder, lib/scoutMemory.ts), as the
// pure functions they are.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import type { ScoutCandidate } from '../src/lib/sourceScout';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

let scoutOrder: typeof import('../src/lib/sourceScout').scoutOrder;
let scoutTier: typeof import('../src/lib/sourceScout').scoutTier;
let verdictHolds: typeof import('../src/lib/scoutMemory').verdictHolds;
let verdictExpires: typeof import('../src/lib/scoutMemory').verdictExpires;
let VERDICT_TTL_MS: typeof import('../src/lib/scoutMemory').VERDICT_TTL_MS;
before(async () => {
  ({ scoutOrder, scoutTier } = await import('../src/lib/sourceScout'));
  ({ verdictHolds, verdictExpires, VERDICT_TTL_MS } = await import('../src/lib/scoutMemory'));
});

const c = (id: string, o: Partial<ScoutCandidate> = {}): ScoutCandidate =>
  ({ id, lang: null, preferredOrder: null, known: false, landed: 0, failed: 0, key: id, ...o });
const own = { id: 'main', lang: 'en' };

test('known sources first, then the ones downloading well here, then the rest, and the mostly failing last', () => {
  const order = scoutOrder([
    c('failing', { landed: 1, failed: 3 }),
    c('plain'),
    c('proven', { landed: 5, failed: 1 }),
    c('known', { known: true, failed: 9 }),
  ], own);
  // Reintroduce by sorting on scan order alone: the order they were given.
  assert.deepEqual(order, ['known', 'proven', 'plain', 'failing']);
  assert.equal(scoutTier({ known: false, landed: 2, failed: 2 }), 3, 'half failing is not downloading well');
  assert.equal(scoutTier({ known: false, landed: 3, failed: 2 }), 1);
});

test('within a tier: the series\' language first, then the image server with the least waiting on it', () => {
  const order = scoutOrder([
    c('other-lang', { lang: 'es' }),
    c('busy', { lang: 'en', key: 'k-busy' }),
    c('unpinned'),
    c('quiet', { lang: 'en', key: 'k-quiet' }),
  ], own, new Map([['k-busy', 400], ['k-quiet', 3]]));
  // Reintroduce by dropping the backlog: busy (listed first) goes before quiet.
  assert.deepEqual(order, ['quiet', 'busy', 'unpinned', 'other-lang']);
});

test('a source searched within the last minute goes last, whatever its tier', () => {
  assert.deepEqual(scoutOrder([c('known', { known: true, searchedLately: true }), c('plain')], own), ['plain', 'known']);
});

test('what a source said is believed for as long as it is likely to stay true', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const at = (ms: number) => new Date(now - ms);
  const DAY = 24 * 3600_000;
  assert.equal(verdictHolds({ verdict: 'no_hit', at: at(13 * DAY), our_count: 50 }, 50, now), true);
  assert.equal(verdictHolds({ verdict: 'no_hit', at: at(15 * DAY), our_count: 50 }, 50, now), false);
  assert.equal(verdictHolds({ verdict: 'unreachable', at: at(23 * 3600_000), our_count: 50 }, 50, now), true);
  assert.equal(verdictHolds({ verdict: 'unreachable', at: at(25 * 3600_000), our_count: 50 }, 50, now), false);
  assert.equal(verdictHolds({ verdict: 'ok', at: at(6 * DAY), our_count: 50 }, 50, now), true);
  assert.equal(verdictHolds({ verdict: 'ok', at: at(8 * DAY), our_count: 50 }, 50, now), false);
  assert.equal(verdictHolds({ verdict: 'removed', at: at(400 * DAY), our_count: null }, 50, now), true, 'until an admin follows it');
  assert.equal(verdictExpires({ verdict: 'removed', at: at(0) }), null);
  assert.equal(verdictExpires({ verdict: 'title_differs', at: at(0) }), now + VERDICT_TTL_MS.title_differs);
});

test('a numbering that did not line up is asked again once the series\' own listing moved by a tenth', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const v = { verdict: 'numbering_differs' as const, at: new Date(now - 3600_000), our_count: 100 };
  assert.equal(verdictHolds(v, 105, now), true);
  // Reintroduce by keeping it 14 days whatever the listing does: the 110-number listing is still refused.
  assert.equal(verdictHolds(v, 110, now), false);
  assert.equal(verdictHolds(v, 89, now), false);
});
