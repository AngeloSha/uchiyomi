// How far the reader is through a series (v0.60.0): the 3 px bar along the bottom edge of a cover, and a Library list
// row's bar with its "41 / 201".
//
// Every card was already handed `booksReadCount` and `booksCount` -- per reader, corrected by the server (bff
// lib/enrich.ts) -- and showed neither: a shelf of covers said what was unread and nothing about how far in you were.
// Pure, so the edges (nothing read, finished, a count the server got wrong) are unit-tested.
import type { Series } from './types';

export interface SeriesProgress {
  read: number;
  total: number;
  /** 0..1, clamped: a read count past the total (a chapter deleted after it was read) is finished, not 110 %. */
  fraction: number;
  /** Every chapter read: the bar runs the whole width, in the accent. */
  finished: boolean;
}

const whole = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

/** The reader's progress through `s`, or null for a series with no chapters (or counts that are not numbers). */
export function seriesProgress(s: Pick<Series, 'booksCount' | 'booksReadCount'>): SeriesProgress | null {
  const total = whole(s.booksCount);
  if (!total) return null;
  const read = Math.min(whole(s.booksReadCount) ?? 0, total);
  return { read, total, fraction: read / total, finished: read >= total };
}

/** The cover's bar: only once something is read -- an untouched series draws nothing, not an empty track. */
export function coverProgress(s: Pick<Series, 'booksCount' | 'booksReadCount'>): SeriesProgress | null {
  const p = seriesProgress(s);
  return p && p.read > 0 ? p : null;
}
