// What the series page's one reading button does, and what it says (v0.60.0).
//
// It used to open the lowest unfinished chapter and say "Start reading" over it -- after chapters 1 to 10 were read,
// and "Start reading · Ch. 1" once every chapter was. The owner's ask: the button says what it will do. So the choice
// is one of five, decided here, pure, from the chapter list (test/continueLabel.test.ts holds every case):
//
//   none      nothing on the list can be opened             "Nothing to read yet" (disabled)
//   continue  a chapter is part-read (page 1 or later)      "Continue · Ch. 12"   the most recently read one when
//                                                                                 the progress carries dates, else
//                                                                                 the lowest
//   next      chapters are finished and none is part-read   "Next · Ch. 11"       the first chapter after the
//                                                                                 highest finished one that is not
//                                                                                 finished and can be opened; the
//                                                                                 lowest such one when none is after
//   start     nothing is read                               "Start reading"       the first chapter
//   again     everything that can be opened is finished     "Read again"          the first chapter
//
// "Can be opened" is the page's own rule, passed in: a chapter the server deleted has no pages to open -- unless this
// device saved a copy, which is then the last copy left and opens perfectly.
import { t as tr } from './i18n';
import { chapterLabel, chapterName } from './format';
import type { ReadProgress } from './types';

export type ContinueKind = 'none' | 'continue' | 'next' | 'start' | 'again';

/** What the decision reads of a chapter: its place, its progress, and what the labels say of it. */
export interface ContinueBook {
  id: string;
  number: number;
  numberEnd?: number | null;
  name?: string;
  chapterName?: string | null;
  metadata?: { numberSort?: number; number?: string; title?: string };
  media?: { pagesCount?: number };
  readProgress?: Partial<ReadProgress> | null;
  pruned?: boolean;
}

export interface ContinueChoice<B extends ContinueBook = ContinueBook> {
  kind: ContinueKind;
  /** The chapter the button opens; null only for `none`. */
  book: B | null;
}

const finished = (b: ContinueBook): boolean => b.readProgress?.completed === true;

/**
 * Started and not finished: progress on page 1 or later. "Mark unread" writes page 0, which is not reading -- that
 * chapter is unread, as its row says.
 */
const partRead = (b: ContinueBook): boolean => !!b.readProgress && !finished(b) && (b.readProgress.page ?? 0) >= 1;

/** When the reader was last in it, from the progress' own dates; null when it carries none. */
const readAt = (b: ContinueBook): number | null => {
  const t = Date.parse(b.readProgress?.readDate ?? b.readProgress?.lastModified ?? '');
  return Number.isFinite(t) ? t : null;
};

/** The list's order: by `metadata.numberSort` (the server's), the chapter number where there is none. Stable. */
const placeOf = (b: ContinueBook): number => b.metadata?.numberSort ?? b.number;

/** The one choice, from the chapter list in any order and the page's `openable` rule. */
export function continueChoice<B extends ContinueBook>(books: readonly B[], openable: (b: B) => boolean): ContinueChoice<B> {
  const list = [...books].sort((a, b) => placeOf(a) - placeOf(b));
  const open = list.filter(openable);
  if (!open.length) return { kind: 'none', book: null };

  const reading = open.filter(partRead);
  if (reading.length) {
    // The one the reader was in last: on a long series several chapters can be half read, and the lowest of them is
    // usually one abandoned long ago. Without dates, the lowest.
    let book = reading[0];
    let at = readAt(book);
    for (const b of reading.slice(1)) {
      const t = readAt(b);
      if (t !== null && (at === null || t > at)) { book = b; at = t; }
    }
    return { kind: 'continue', book };
  }

  // The highest finished chapter on the whole list, its tombstones included: a deleted chapter that was read still
  // says how far the reader is.
  let lastDone = -1;
  list.forEach((b, i) => { if (finished(b)) lastDone = i; });
  if (lastDone < 0) return { kind: 'start', book: open[0] };

  const unread = (b: B) => !finished(b) && openable(b);
  const next = list.slice(lastDone + 1).find(unread) ?? list.find(unread);
  return next ? { kind: 'next', book: next } : { kind: 'again', book: open[0] };
}

/** "Ch. 12 · The Return": the chapter's label, and its own name when the source gave one. */
const fullName = (b: ContinueBook): string => [chapterLabel(b), chapterName(b)].filter(Boolean).join(' · ');

/**
 * What the button says, and the line under it -- which chapter it opens, when the label does not name it, and how far
 * into it the reader is ("The Return · page 3 of 23"). The page only once there is one: "Mark unread" writes page 0.
 */
export function continueText(choice: ContinueChoice): { label: string; caption: string } {
  const b = choice.book;
  if (choice.kind === 'none' || !b) return { label: tr('Nothing to read yet'), caption: '' };
  switch (choice.kind) {
    case 'continue': {
      const pages = b.media?.pagesCount ?? 0;
      const page = b.readProgress?.page ?? 0;
      return {
        label: tr('Continue · {chapter}', { chapter: chapterLabel(b) }),
        caption: [chapterName(b), pages > 0 && page >= 1 ? tr('page {page} of {pages}', { page, pages }) : ''].filter(Boolean).join(' · '),
      };
    }
    case 'next':
      return { label: tr('Next · {chapter}', { chapter: chapterLabel(b) }), caption: chapterName(b) };
    case 'again':
      return { label: tr('Read again'), caption: fullName(b) };
    default:
      return { label: tr('Start reading'), caption: fullName(b) };
  }
}

/** "10 of 50 read", under the button; null when the series has no chapters to count. */
export function readCountText(read: number, total: number): string | null {
  if (!(total > 0)) return null;
  return tr('{read} of {total} read', { read: Math.min(Math.max(0, read), total), total });
}
