// Guards the phantom-chapter fix: manga sites embed "hot chapters" widgets linking to OTHER titles, which
// once polluted libraries with entries like "Chapter 3862" on a 200-chapter series.
import test from 'node:test';
import assert from 'node:assert/strict';
import { seriesSlug, isOwnChapterUrl } from '../src/lib/sources/slug';

test('seriesSlug takes the last path segment, ignoring query/hash/trailing slashes', () => {
  assert.equal(seriesSlug('https://site.org/manga/solo-leveling/'), 'solo-leveling');
  assert.equal(seriesSlug('https://site.org/manga/solo-leveling'), 'solo-leveling');
  assert.equal(seriesSlug('https://site.org/manga/Solo-Leveling/?x=1#y'), 'solo-leveling');
  assert.equal(seriesSlug('https://site.org/manga/evolution-begins-with-a-big-tree//'), 'evolution-begins-with-a-big-tree');
});

test('keeps chapters belonging to this series', () => {
  const slug = 'solo-leveling';
  assert.ok(isOwnChapterUrl('https://site.org/manga/solo-leveling/chapter-1', slug));
  assert.ok(isOwnChapterUrl('https://site.org/manga/solo-leveling/chapter-202', slug));
  assert.ok(isOwnChapterUrl('https://SITE.org/manga/Solo-Leveling/Chapter-77', slug), 'case-insensitive');
  assert.ok(isOwnChapterUrl('https://site.org/manga/solo-leveling/chapter_5', slug), 'underscore separator');
});

test('rejects chapters of other manga (the widget bug)', () => {
  const slug = 'necromancer-the-ultimate-scourge';
  // the exact shape that produced phantom "Chapter 3862" entries
  assert.equal(isOwnChapterUrl('https://manhuaplus.org/manga/martial-peak01/chapter-3862', slug), false);
  assert.equal(isOwnChapterUrl('https://site.org/manga/one-piece/chapter-1045', slug), false);
});

test('allows slug aliases via prefix match (sites append or truncate suffixes)', () => {
  assert.ok(isOwnChapterUrl('https://site.org/manga/berserk-vol2/chapter-3', 'berserk'));
  assert.ok(isOwnChapterUrl('https://site.org/manga/berserk/chapter-3', 'berserk-deluxe'));
});

test('is lenient when the chapter URL carries no identifiable manga slug', () => {
  // dropping a real chapter is worse than admitting a rare stray
  assert.ok(isOwnChapterUrl('https://site.org/read/12345', 'solo-leveling'));
  assert.ok(isOwnChapterUrl('/chapter-5', 'solo-leveling'));
});

test('is lenient when the series slug is unknown', () => {
  assert.ok(isOwnChapterUrl('https://site.org/manga/anything/chapter-1', ''));
});
