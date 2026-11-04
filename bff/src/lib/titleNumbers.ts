// Chapter numbers from the chapter titles (#379): for a source that counts every post as a chapter, its specials too.
//
// The Tapas extension numbers an episode by its place in the series (`chapter_number = scene`), so a "Caption Contest!"
// or a "Q&A Announcement!" posted between two chapters takes a number of its own, and every chapter after it carries one
// more than the number its creator wrote in front of its title: "24. The Other Side" is Tapas's 27. Uchiyomi identifies
// a chapter by its number, so the drift reached every file name, read mark and tracker number after the first special,
// and no other site's chapter 27 was the same chapter.
//
// A series whose source does this is numbered by its chapter titles instead: each chapter at the number its title
// starts with, and each special just after the chapter before it -- N.01, N.02 ... -- in the place it was posted. Two
// pieces, both pure (no database, no clock, no adapter); lib/numbering.ts applies them wherever a listing enters the
// app, as it applies posting order (#116), and a series already in a library is renamed only once an admin has
// reviewed the plan.
//   * detectTitleNumbering: does this ONE source's listing count its specials as chapters?
//   * titleNumbered:        the listing at the numbers its titles give.
//
// The reading walks the posts oldest first and decides each one from the posts before it alone, never from the ones
// after: a new post never moves an earlier one's number, which is what lets the numbers go unstored. Posting order keeps
// a table (series_post_numbers) because a post's PLACE moves whenever another is deleted; a title's number does not.
// What can still move one: a creator rewriting the number in a title, or deleting a special that had another special
// after it on the same chapter (that one's N.02 becomes N.01).
import type { SourceChapter } from './sources/types';
import { numKey, postingSequence, displayTitle } from './postingOrder';
import { leadingNumber } from './naming';

/**
 * The detector's thresholds and the reading's two constants. The detector proposes renaming files, so it only fires
 * on the whole shape: a listing that counts its posts one by one, whose titles mostly carry their own numbers, where
 * the specials between them push the chapters' numbers ahead of their titles'.
 */
export const TITLE_NUMBERING = Object.freeze({
  /** Below this many posts nothing is judged: a short listing cannot tell a pattern from a coincidence. */
  MIN_POSTS: 12,
  /** At least this share of the posts are chapters whose titles carry their own number... */
  NUMBERED: 0.7,
  /** ...the source's numbers count the posts: at least this share of the steps between them, oldest first, is one... */
  COUNTED: 0.8,
  /** ...and the chapters the reading moves move DOWN, to their titles' numbers, at least this share of them. */
  DOWN: 0.9,
  /**
   * How far a title's number may run ahead of the chapter before it and still be the next chapter. Further than that it
   * says something else: "100 Subscribers!" after chapter 24 is no chapter 100, and a year is no chapter at all.
   */
  MAX_STEP: 10,
  /** The step between the specials after one chapter: 24.01, 24.02 ... */
  EXTRA: 0.01,
});

export interface TitleNumbering {
  /** strong: number this series by its titles. none: nothing to say. */
  verdict: 'strong' | 'none';
  posts: number;
  /** Posts read as specials: no number of their own in the title, or one out of step with the chapters around it. */
  specials: number;
  /** Chapters the reading gives another number than the source's. */
  moved: number;
  /** The newest of them -- the furthest out -- for the notice's "“24. The Other Side” is its number 27". */
  example: { title: string; from: number; to: number } | null;
}

// A locked episode's mark in front of its title (Tapas: "🔒 24. The Other Side ").
const MARK = /^[\p{Extended_Pictographic}️\s]+/u;
const clean = (title: string | undefined | null): string => displayTitle(title).replace(MARK, '').trim();
// The extension's own number in front of a title, when it is told to write it there: Tapas's "Show episode number in
// chapter name" makes every title "27 - 24. The Other Side".
const ownPrefix = (n: number): RegExp => new RegExp(`^0*${String(numKey(n)).replace('.', '\\.')}\\s+[-–—]\\s+`, 'u');

interface Read<T> {
  post: T;
  /** The number the reading gives it. */
  number: number;
  /** A chapter at its title's number, or a special after one. */
  chapter: boolean;
}

/**
 * The walk, oldest first. A post is a chapter when its title starts with a number above the chapter before it (and at
 * most MAX_STEP above it), that no earlier post holds; every other post is a special, numbered just after the chapter
 * before it. Nothing after a post is read to decide it.
 */
function walk<T extends SourceChapter>(seq: readonly T[]): Read<T>[] {
  const T = TITLE_NUMBERING;
  // The extension's prefix is the extension's setting, so it is on every post or on none; a creator who writes
  // "24 - " in front of chapter 24 has it on the posts up to the first special at most. Reintroduce by reading the
  // titles whole, or with their lock mark: "the extension's own number in front of every title, and a locked
  // episode's mark, change nothing" in titleNumbers.test.ts reads other numbers.
  const prefixed = seq.length > 0 && seq.filter((c) => ownPrefix(c.number).test(clean(c.title))).length >= 0.9 * seq.length;
  const taken = new Set<number>();
  const out: Read<T>[] = [];
  let last: number | null = null;
  let after = 0;
  for (const c of seq) {
    const t = clean(c.title);
    const own = leadingNumber(prefixed ? t.replace(ownPrefix(c.number), '') : t);
    const n = own == null ? null : numKey(own);
    // Reintroduce without the step's bound (`n > last` alone): "a number in a special's title is no chapter number when
    // it is out of step" in titleNumbers.test.ts takes "2023 Recap" for chapter 2023, and every chapter after it for a
    // special. Without `taken`: "a creator's own N.01 is a chapter" puts two posts on 2.01.
    const chapter = n != null && (last == null ? n >= 0 && n <= T.MAX_STEP : n > last && n <= last + T.MAX_STEP) && !taken.has(n);
    let number: number;
    if (chapter) {
      number = n!;
      last = n!;
      after = 0;
    } else {
      // Past anything the creator numbered there already (a "24.01" of its own).
      do { after++; number = numKey((last ?? 0) + after * T.EXTRA); } while (taken.has(number));
    }
    taken.add(number);
    out.push({ post: c, number, chapter });
  }
  return out;
}

/** Judge ONE source's listing: does it count its specials as chapters, so its numbers run ahead of its titles'? */
export function detectTitleNumbering(list: readonly SourceChapter[]): TitleNumbering {
  const T = TITLE_NUMBERING;
  const seq = postingSequence(list.filter((c) => Number.isFinite(c.number)));
  const read = walk(seq);
  const specials = read.filter((r) => !r.chapter).length;
  const moved = read.filter((r) => r.chapter && r.number !== numKey(r.post.number));
  const down = moved.filter((r) => r.number < numKey(r.post.number)).length;
  // Counting the posts: one number per post, each one more than the post before it.
  const distinct = new Set(seq.map((c) => numKey(c.number))).size === seq.length;
  const steps = seq.slice(1).filter((c, i) => numKey(c.number - seq[i].number) === 1).length;
  // Each condition turns away a shape no other one does, in "the detector stays quiet on the shapes it must not rename"
  // (titleNumbers.test.ts): reintroduce the detector without MIN_POSTS and 'too short' fires; without `distinct`, 'a
  // number given twice'; COUNTED, 'not counted'; NUMBERED, 'seasons'; the specials, 'from 0, no specials'; DOWN,
  // 'numbers behind their titles'. `moved` is what there would be to do.
  const strong = seq.length >= T.MIN_POSTS && distinct && steps >= T.COUNTED * (seq.length - 1)
    && read.length - specials >= T.NUMBERED * read.length
    && specials > 0 && moved.length > 0 && down >= T.DOWN * moved.length;
  const newest = moved[moved.length - 1];
  return {
    verdict: strong ? 'strong' : 'none', posts: seq.length, specials, moved: moved.length,
    example: newest ? { title: clean(newest.post.title) || newest.post.title || '', from: numKey(newest.post.number), to: newest.number } : null,
  };
}

/**
 * The listing at the numbers its titles give: `number` the reading's, `sourceNumber` the source's own, the title as the
 * source wrote it. Ascending by the new number, as listChapters hands a listing over.
 */
export function titleNumbered<T extends SourceChapter>(list: readonly T[]): T[] {
  return walk(postingSequence(list.filter((c) => Number.isFinite(c.number))))
    .map((r, i) => ({ c: { ...r.post, number: r.number, sourceNumber: r.post.number } as T, i }))
    .sort((a, b) => a.c.number - b.c.number || a.i - b.i)
    .map((x) => x.c);
}
