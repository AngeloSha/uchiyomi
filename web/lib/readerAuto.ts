// Webtoon or paged, picked for each series (v0.61.0, Reader → Pick the mode for each series).
//
// A library mixes long-strip webtoons and paged manga, and one default is wrong for half of it. The per-source default
// (v0.45) fixes that a source at a time, by hand; this answers it from what the reader already knows about the title it
// is opening: the shape of the chapter's pages, the kind of comic the server says it is (`seriesType`, sent to every
// viewer since v0.61.0) and its reading direction. Off by default. When it cannot tell, it says nothing and the
// default stands. It never overrides a mode someone chose: lib/readerPrefs.ts titleLook applies a guess only to a title
// whose series memory and source default hold no mode at all.
import type { SeriesType } from './types';

/** Why a mode was picked, for the sheet's "Picked for this series" line. */
export type AutoReason = 'strips' | 'webtoon' | 'manhwa' | 'manga' | 'comic' | 'rtl';
export interface AutoGuess { mode: 'vertical' | 'paged'; reason: AutoReason }

/** A median page this many times taller than wide is a strip, not a page. */
export const TALL = 2.0;
/** A chapter of three pages or fewer is strips when they stand this many widths tall together (bff lib/longStrip.ts). */
export const STRIP_HEIGHT = 10;
/** The shape of a printed page, height over width: from a wide-ish comic page to a tall manga tankōbon. */
export const PAGE_LIKE: readonly [number, number] = [1.2, 1.9];

interface Page { width: number | null; height: number | null; junk?: boolean; missing?: boolean }

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * The mode a title should open in, and why -- or null when nothing here can tell, and the default stands.
 *
 * In order: pages that are strips (the median story page at least twice as tall as wide over four pages or more, or a
 * chapter of up to three pages that stand ten widths tall together: one stitched into strips) read as a webtoon, whatever
 * the series says it is. A manhwa or a webtoon reads as one too, unless its pages are shaped like printed pages -- a
 * print edition. A manga, a comic, or anything that reads right to left, reads page by page. Only story pages count: a
 * repeated credit page or a placeholder is no evidence of shape, and a page whose size is not known is none either.
 */
export function guessMode(t: { pages: readonly Page[]; type?: SeriesType | null; rtl?: boolean }): AutoGuess | null {
  const ratios = t.pages
    .filter((p) => !p.junk && !p.missing && (p.width ?? 0) > 0 && (p.height ?? 0) > 0)
    .map((p) => p.height! / p.width!);
  const mid = ratios.length ? median(ratios) : null;
  const tall = (ratios.length >= 4 && mid! >= TALL)
    || (ratios.length >= 1 && ratios.length <= 3 && ratios.reduce((a, b) => a + b, 0) >= STRIP_HEIGHT);
  if (tall) return { mode: 'vertical', reason: 'strips' };
  const pageLike = mid != null && mid >= PAGE_LIKE[0] && mid <= PAGE_LIKE[1];
  if ((t.type === 'manhwa' || t.type === 'webtoon') && !pageLike) return { mode: 'vertical', reason: t.type };
  if (t.type === 'manga' || t.type === 'comic') return { mode: 'paged', reason: t.type };
  if (t.rtl) return { mode: 'paged', reason: 'rtl' };
  return null;
}
