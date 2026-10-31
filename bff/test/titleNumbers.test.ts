// Chapter numbers from the chapter titles (#379), the pure half: reading a title's own number, the detector, and the
// listing at the numbers its titles give.
//
// The shape is the reporter's: Tapas numbers every post by its place in the series, so "Caption Contest!" and "Q&A
// Announcement!" take numbers and "24. The Other Side" is 27. The shapes the detector must NOT fire on -- Webtoons'
// shared numbers (#116, the real titles in fixtures/webtoons-posts.json), a source whose numbers are already the
// chapters', a source that numbers its specials itself, titles with no numbers, a numbering that restarts -- are here
// beside it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { webtoonsNumbers } from './fixtures/fakeSuwayomi';
import { TITLE_NUMBERING, detectTitleNumbering, titleNumbered } from '../src/lib/titleNumbers';
import { leadingNumber } from '../src/lib/naming';
import type { SourceChapter } from '../src/lib/sources/types';

const DAY = 86_400_000;
const EPOCH = Date.UTC(2022, 5, 1);

/** Posts oldest first, each numbered by its place (Tapas's `scene`), as the Suwayomi adapter hands them over: ascending. */
function counted(titles: string[], o: { prefix?: boolean } = {}): SourceChapter[] {
  return titles.map((t, i): SourceChapter => ({
    sourceId: `p${i + 1}`, number: i + 1, title: o.prefix ? `${i + 1} - ${t}` : t, order: i + 1,
    url: `/episode/${i + 1}`, publishedAt: new Date(EPOCH + i * DAY).toISOString(),
  }));
}
/** Chapters 1..n, `N. Name`, with the specials given posted right after chapter N. */
function tapas(n: number, specials: Record<number, string[]>): string[] {
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(`${i}. Chapter name ${String.fromCharCode(64 + ((i - 1) % 26) + 1)}`);
    out.push(...(specials[i] ?? []));
  }
  return out;
}
/** The reporter's listing around chapter 24: three specials before it, then Caption Contest! and Q&A Announcement!. */
const REPORTED = () => {
  const titles = tapas(30, { 5: ['Character Sheet'], 12: ['Hiatus Announcement'], 18: ['Fan Art Corner'], 24: ['Caption Contest!'], 25: ['Q&A Announcement!'] });
  titles[26] = '24. The Other Side';
  titles[28] = '25. What\'s To Come';
  return titles;
};
const at = (list: SourceChapter[], title: string): number => {
  const c = list.find((x) => x.title === title);
  assert.ok(c, `no post titled "${title}"`);
  return Math.round(c!.number * 1000) / 1000;
};

test('a title\'s own number: in front, after a chapter word, standing alone', () => {
  const cases: Array<[string, number | null]> = [
    ['24. The Other Side', 24], ['25. What\'s To Come', 25], ['0. Prologue', 0], ['024 - Back', 24], ['24.5 Side Story', 24.5],
    ['Episode 7: Rain', 7], ['Ep. 12 - Night Market', 12], ['Chapter 3', 3], ['#9 Static', 9], ['第12話 帰り道', 12], ['15', 15],
    ['Caption Contest!', null], ['Q&A Announcement!', null], ['Character Sheet', null], ['Epilogue', null],
    // A number that is not the chapter's: an ordinal, a thing counted, a fraction.
    ['1st Anniversary Special', null], ['3D Special', null], ['10k Followers!', null], ['100% Done', null], ['1/2 Off', null],
  ];
  for (const [title, n] of cases) assert.equal(leadingNumber(title), n, title);
});

test('the reporter\'s listing: every chapter at its title\'s number, each special just after the chapter before it', () => {
  const list = counted(REPORTED());
  assert.equal(list.length, 35);
  assert.equal(at(list, '24. The Other Side'), 27, 'what the source says: the screenshot\'s Ch. 27');
  const read = titleNumbered(list);
  assert.equal(read.length, 35, 'nothing dropped');
  assert.equal(at(read, '24. The Other Side'), 24);
  assert.equal(at(read, 'Caption Contest!'), 24.01);
  assert.equal(at(read, '25. What\'s To Come'), 25);
  assert.equal(at(read, 'Q&A Announcement!'), 25.01);
  assert.equal(at(read, 'Character Sheet'), 5.01);
  assert.deepEqual(read.filter((c) => Number.isInteger(c.number)).map((c) => c.number), Array.from({ length: 30 }, (_, i) => i + 1),
    'the thirty chapters, one each, at 1 to 30');
  assert.equal(read.find((c) => c.title === '24. The Other Side')!.sourceNumber, 27, 'and the source\'s own number kept');
  assert.deepEqual(read.map((c) => c.number), [...read.map((c) => c.number)].sort((a, b) => a - b), 'ascending, as listChapters hands it over');

  const d = detectTitleNumbering(list);
  assert.equal(d.verdict, 'strong');
  assert.deepEqual([d.posts, d.specials, d.moved], [35, 5, 25], 'chapters 6 to 30 move');
  assert.deepEqual(d.example, { title: '30. Chapter name D', from: 35, to: 30 }, 'the newest moved chapter, the furthest out');
});

test('the extension\'s own number in front of every title, and a locked episode\'s mark, change nothing', () => {
  const plain = titleNumbered(counted(REPORTED())).map((c) => c.number);
  // Tapas's "Show episode number in chapter name": "27 - 24. The Other Side".
  const prefixed = counted(REPORTED(), { prefix: true });
  assert.equal(prefixed[26].title, '27 - 24. The Other Side');
  assert.deepEqual(titleNumbered(prefixed).map((c) => c.number), plain);
  assert.equal(detectTitleNumbering(prefixed).verdict, 'strong');
  // "🔒 24. The Other Side ", a paywalled episode shown anyway.
  const locked = counted(REPORTED().map((t, i) => (i >= 30 ? `🔒 ${t} ` : t)));
  assert.deepEqual(titleNumbered(locked).map((c) => c.number), plain);
});

test('a number in a special\'s title is no chapter number when it is out of step', () => {
  const titles = tapas(30, { 3: ['1 Year Anniversary!'], 10: ['2023 Recap'], 24: ['100 Subscribers!'], 25: ['24. The Other Side (redrawn)'] });
  const read = titleNumbered(counted(titles));
  assert.equal(at(read, '1 Year Anniversary!'), 3.01, 'below the chapter before it');
  assert.equal(at(read, '2023 Recap'), 10.01, 'a year');
  assert.equal(at(read, '100 Subscribers!'), 24.01, 'far past the next chapter');
  assert.equal(at(read, '24. The Other Side (redrawn)'), 25.01, 'a number already given');
  assert.equal(at(read, '25. Chapter name Y'), 25);
  assert.deepEqual(read.filter((c) => Number.isInteger(c.number)).map((c) => c.number), Array.from({ length: 30 }, (_, i) => i + 1));
});

test('a creator\'s own N.01 is a chapter, and a special takes the next free place after it', () => {
  const rest = tapas(12, {}).slice(3);
  const read = titleNumbered(counted(['1. A', '2. B', '2.01 Side Story', 'Notice', '3. C', ...rest]));
  assert.equal(at(read, '2.01 Side Story'), 2.01);
  assert.equal(at(read, 'Notice'), 2.02);
  assert.equal(at(read, '3. C'), 3);
  // Posted after a special already holds 2.01, it cannot have it: nothing earlier moves for a later post.
  const late = titleNumbered(counted(['1. A', '2. B', 'Notice', '2.01 Side Story', 'Second notice', '3. C', ...rest]));
  assert.deepEqual(['Notice', '2.01 Side Story', 'Second notice', '3. C'].map((t) => at(late, t)), [2.01, 2.02, 2.03, 3]);
});

test('a new post never moves an earlier one: the reading of a listing begins with the reading of every listing before it', () => {
  const list = counted(REPORTED());
  const whole = new Map(titleNumbered(list).map((c) => [c.sourceId, c.number]));
  for (let k = 1; k <= list.length; k++) {
    for (const c of titleNumbered(list.slice(0, k))) assert.equal(c.number, whole.get(c.sourceId), `${c.title} after ${k} posts`);
  }
});

test('the detector stays quiet on the shapes it must not rename', () => {
  // #116's Webtoons series: many posts on one number. Posting order's, not this.
  const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'webtoons-posts.json'), 'utf8')) as Record<string, { posts: Array<{ order: number; title: string }> }>;
  for (const key of ['istrevelia', 'apocalypticHorseplay']) {
    const posts = FIXTURE[key].posts;
    const numbered = webtoonsNumbers(posts.map((p) => ({ name: p.title })), false);
    const list = posts.map((p, i): SourceChapter => ({ sourceId: String(p.order), number: numbered[i].chapterNumber, title: numbered[i].name.trim(), order: p.order }));
    assert.equal(detectTitleNumbering(list).verdict, 'none', key);
  }
  const quiet = (titles: SourceChapter[], why: string) => assert.equal(detectTitleNumbering(titles).verdict, 'none', why);
  // The source's numbers are the chapters' already: nothing moves.
  quiet(counted(tapas(30, {})), 'no specials');
  // A source that numbers its specials itself, 24.5 between 24 and 25: no chapter moves.
  quiet(tapas(30, { 24: ['Caption Contest!'] }).map((t, i, all): SourceChapter => {
    const n = leadingNumber(t) ?? (leadingNumber(all[i - 1]) ?? 0) + 0.5;
    return { sourceId: `p${i}`, number: n, title: t, order: i + 1 };
  }), 'specials numbered by the source');
  // Titles that carry no numbers at all.
  quiet(counted(Array.from({ length: 30 }, (_, i) => `The ${['Red', 'Blue', 'Green'][i % 3]} Door, part ${String.fromCharCode(65 + i)}`)), 'unnumbered titles');
  // A numbering that restarts every season: a third of the chapters would be read as specials.
  quiet(counted([...tapas(15, { 5: ['Q&A'] }), 'Season 2 begins', ...tapas(15, { 5: ['Q&A'] })]), 'seasons');
  // Too short to tell.
  quiet(counted(tapas(TITLE_NUMBERING.MIN_POSTS - 3, { 2: ['Q&A'] })), 'too short');
  // Numbers that do not count posts, ten apart: whatever they are, they are not this.
  quiet(tapas(30, { 5: ['Q&A'] }).map((t, i): SourceChapter => ({ sourceId: `p${i}`, number: (i + 1) * 10, title: t, order: i + 1 })), 'not counted');
  // Two groups' copies of every chapter, a number each: versions, which the reading would split into a chapter and a special.
  const twice = tapas(30, { 5: ['Q&A'] }).flatMap((t, i): SourceChapter[] => [0, 1].map((g) => ({
    sourceId: `p${i}-${g}`, number: i + 1, title: t, order: 2 * i + g + 1, scanlator: `Group ${g}`,
  })));
  quiet(twice, 'two copies on each number');
  // A source that gives two posts one number is not counting its posts, even once.
  const again = counted(REPORTED());
  again[9] = { ...again[9], number: again[8].number };
  quiet(again, 'a number given twice');
  // Titles running AHEAD of the source's numbers: the source does not count anything the titles leave out.
  quiet(counted(tapas(40, { 5: ['Q&A'] }).map((t) => t.replace(/^(\d+)\./, (_m, n) => `${Number(n) + 5}.`))), 'numbers behind their titles');
  // Titles that count from 0 with nothing between the chapters: an offset, not specials.
  quiet(counted(Array.from({ length: 30 }, (_, i) => `${i}. Chapter name ${i}`)), 'from 0, no specials');
});
