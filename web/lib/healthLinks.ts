// Where a Health finding's Open goes.
//
// It went to the home screen: `/series/<id>` is a path the static export never generated, so the server served
// the app's shell and it landed on Home (fixed in v0.48.2). And a series was never the point -- the finding is
// about ONE chapter: the short one, or where the gap is. So Open takes the admin to that chapter: a short
// chapter opens in the reader, and a gap or an impossible number opens the series with the list turned to that
// chapter's page and the row lit up (`?ch=`, read by app/series/page.tsx).
import type { HealthItem } from './types';

/** A series page, optionally turned to one chapter. `ch` is a chapter NUMBER, never an id. */
export function seriesHref(id: string, ch?: number | null): string {
  const base = `/series/?id=${encodeURIComponent(id)}`;
  return ch != null && Number.isFinite(ch) ? `${base}&ch=${ch}` : base;
}

/** The reader, on one chapter. */
export function readerHref(bookId: string): string {
  return `/reader/?book=${encodeURIComponent(bookId)}`;
}

export interface HealthLink { href: string; label?: string }

/**
 * Every link an item gets, first one is "Open". Empty when the finding is not about a series (a failing source,
 * the solver, an update).
 */
export function healthLinks(check: string, it: HealthItem): HealthLink[] {
  switch (check) {
    // The chapter itself: reading it is how anyone sees what is short about it.
    case 'short-chapters':
      if (it.bookId) return [{ href: readerHref(it.bookId) }];
      break;
    // The first missing number. The series page lands on the chapter just before it when (as for a gap) the
    // number itself has no row, which is where the gap begins.
    case 'chapter-gaps':
      if (it.seriesId && it.numbers?.length) return [{ href: seriesHref(it.seriesId, Math.min(...it.numbers)) }];
      break;
    // Impossible numbers are chapters the library holds: the first one named.
    case 'outliers':
      if (it.seriesId && it.numbers?.length) return [{ href: seriesHref(it.seriesId, it.numbers[0]) }];
      break;
    // Both copies, since the finding is about the pair and either may be the one to keep.
    case 'duplicates':
      if (it.seriesIds?.length) return it.seriesIds.map((id, i) => ({ href: seriesHref(id), label: it.titles?.[i] }));
      break;
  }
  return it.seriesId ? [{ href: seriesHref(it.seriesId) }] : [];
}

/**
 * The row a `?ch=` link lands on: the held chapter with that number, or else the nearest one BELOW it (a gap
 * starts right after it), or else the first one above. Numbers are compared with a tolerance -- chapter numbers
 * are stored as floats, and an override can put a number on a row that the listing spells differently.
 */
export function landingNumber(held: readonly number[], ch: number): number | null {
  if (!held.length || !Number.isFinite(ch)) return null;
  const exact = held.find((n) => Math.abs(n - ch) < 0.005);
  if (exact !== undefined) return exact;
  let below: number | null = null;
  let above: number | null = null;
  for (const n of held) {
    if (n < ch && (below === null || n > below)) below = n;
    if (n > ch && (above === null || n < above)) above = n;
  }
  return below ?? above;
}

/** `?ch=` as a number, or null. `Number(null)` is 0 -- a real chapter -- so absent must stay absent. */
export function chParam(raw: string | null): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
