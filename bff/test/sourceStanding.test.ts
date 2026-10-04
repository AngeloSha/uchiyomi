// A source's standing in one word (lib/sourceStanding.ts, v0.54.0), pure: what the Replace run, Health, the Sources
// sheet and the sources overview all read before they move a series off a source, or count one as still carried.
//
// The rules it pins: switched off is `off` whether or not the adapter is loaded (an extension source switched off is
// unregistered too, and "off" is where it comes back on); a failure counts only at a step an update needs -- the
// chapter list, the page list, the images -- or as the site's own offline notice at any step; a cooldown is
// `cooling`, never a failure, and so is a site asking us to slow down (v0.55.1); and a failure nobody has confirmed, or
// that went stale, is no failure.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const ahead = (min: number) => new Date(NOW + min * 60_000).toISOString();
const failed = (kind = 'error') => ({ failAt: ago(30), failBy: 'test' as const, error: 'x', kind: kind as any });

test('a standing in one word, by the rules an update lives by', async () => {
  const { standingOf, carries } = await import('../src/lib/sourceStanding');
  const { registerAdapter } = await import('../src/lib/sources');
  const stub = { search: async () => [], getSeries: async () => null, listChapters: async () => [], getPageUrls: async () => [] };
  registerAdapter({ id: 'st-here', name: 'Here', ...stub } as any);
  const row = (o: Record<string, unknown> = {}) => ({ source_id: 'st-here', disabled: false, blocked_until: null, stages: null, ...o });

  assert.equal(standingOf('st-here', undefined, NOW), 'usable', 'no row: nothing has gone wrong');
  assert.equal(standingOf('st-gone', undefined, NOW), 'not_loaded');
  // Reintroduce by testing the registry first: "switched off is off, loaded or not" reads not_loaded.
  assert.equal(standingOf('st-gone', row({ source_id: 'st-gone', disabled: true }), NOW), 'off', 'switched off is off, loaded or not');
  assert.equal(standingOf('st-here', row({ disabled: true, stages: { chapters: failed() } }), NOW), 'off');

  // Reintroduce by counting a search failure (dropping the stage test): this reads failing.
  assert.equal(standingOf('st-here', row({ stages: { search: failed() } }), NOW), 'usable', 'a search failure stops nothing an update needs');
  for (const stage of ['chapters', 'pages', 'images']) {
    assert.equal(standingOf('st-here', row({ stages: { [stage]: failed() } }), NOW), 'failing', `a failure at ${stage}`);
  }
  assert.equal(standingOf('st-here', row({ stages: { search: failed('site_offline') } }), NOW), 'failing', "the site's own offline notice, at any step");
  // Not a finding yet: one traffic failure, or one nobody has looked at for a week (lib/sourceEvidence.ts).
  assert.equal(standingOf('st-here', row({ stages: { chapters: { ...failed(), failBy: 'traffic', streak: 1 } } }), NOW), 'usable');
  assert.equal(standingOf('st-here', row({ stages: { chapters: { ...failed(), failAt: ago(8 * 24 * 60) } } }), NOW), 'usable');

  assert.equal(standingOf('st-here', row({ blocked_until: ahead(20) }), NOW), 'cooling');
  assert.equal(standingOf('st-here', row({ blocked_until: ago(5) }), NOW), 'usable', 'a cooldown that has ended');
  assert.equal(standingOf('st-here', row({ blocked_until: ahead(20), stages: { pages: failed() } }), NOW), 'failing', 'failing outranks cooling');

  assert.deepEqual(['usable', 'cooling', 'failing', 'off', 'not_loaded'].map((s) => carries(s as any)), [true, true, false, false, false]);
});

test('images failing with 429 are a cooldown, never a failure; with a 500 they are failing (v0.55.1)', async () => {
  // The owner's first Fix everything run: Mangakakalot's image server answered 429 (its record below, as it was stored),
  // the source read `failing`, and the run moved 14 series off a source whose searches and chapter lists answer fine.
  // Reintroduce by counting rate limits among currentFailures (lib/sourceEvidence.ts): the first case reads failing. By
  // dropping the rate-limit line from standingOf: it reads usable once its cooldown is over, and a follower that is
  // being rate-limited ranks with the healthy ones.
  const { standingOf, carries } = await import('../src/lib/sourceStanding');
  const { registerAdapter } = await import('../src/lib/sources');
  const stub = { search: async () => [], getSeries: async () => null, listChapters: async () => [], getPageUrls: async () => [] };
  registerAdapter({ id: 'st-limit', name: 'Limit', ...stub } as any);
  const row = (o: Record<string, unknown> = {}) => ({ source_id: 'st-limit', disabled: false, blocked_until: null, stages: null, ...o });
  const images = (error: string, kind = 'error') => ({ images: { failAt: ago(30), failBy: 'traffic' as const, streak: 5, kind: kind as any, error } });

  const owners = row({ stages: images('0/32 pages downloaded (HTTP 429)') });
  assert.equal(standingOf('st-limit', owners, NOW), 'cooling', 'images failing with 429, its cooldown over or cleared by a Test');
  assert.equal(carries(standingOf('st-limit', owners, NOW)), true, 'and it still carries its series');
  assert.equal(standingOf('st-limit', row({ blocked_until: ahead(20), stages: images('0/32 pages downloaded (HTTP 429)') }), NOW), 'cooling');
  assert.equal(standingOf('st-limit', row({ stages: images('suwayomi: HTTP error 429', 'rate_limited') }), NOW), 'cooling', 'recorded as one since v0.55.1');
  assert.equal(standingOf('st-limit', row({ stages: images('0/32 pages downloaded (HTTP 500)') }), NOW), 'failing', 'images failing with a 500 are failing');
  assert.equal(standingOf('st-limit', row({ stages: { ...images('0/32 pages downloaded (HTTP 429)'), pages: failed() } }), NOW), 'failing',
    'a rate limit beside a real failure: the failure speaks');
  assert.equal(standingOf('st-limit', row({ stages: { search: { ...failed(), error: 'HTTP 429' } } }), NOW), 'usable', 'a search rate limit stops no update');
  assert.equal(standingOf('st-limit', row({ stages: { images: { ...images('HTTP 429').images, streak: 1 } } }), NOW), 'usable', 'one 429 is noise');
});
