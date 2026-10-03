// Where a Health finding's Open goes.
//
// It went to the home screen: `/series/<id>` is a path the static export never generated, so the server served
// the app's shell and it landed on Home (fixed in v0.48.2). And a series was never the point -- the finding is
// about ONE chapter: the short one, or where the gap is. So Open takes the admin to that chapter: a short
// chapter opens in the reader, and a gap or an impossible number opens the series with the list turned to that
// chapter's page and the row lit up (`?ch=`, read by app/series/page.tsx).
import { t as tr } from './i18n';
import { extensionSettingsHref, extSourceIdOf } from './sourcePrefs';
import { isDesktop } from './desktop';
import type { HealthItem } from './types';

/** A series page, optionally turned to one chapter. `ch` is a chapter NUMBER, never an id. */
export function seriesHref(id: string, ch?: number | null): string {
  const base = `/series/?id=${encodeURIComponent(id)}`;
  return ch != null && Number.isFinite(ch) ? `${base}&ch=${ch}` : base;
}

/**
 * A series page with its renumbering plan open (#116): the page reads `?numbering=review` once, for an admin, and
 * opens the plan of whatever waits for review (app/series/page.tsx).
 */
export function numberingHref(id: string): string {
  return `${seriesHref(id)}&numbering=review`;
}

/** The reader, on one chapter. */
export function readerHref(bookId: string): string {
  return `/reader/?book=${encodeURIComponent(bookId)}`;
}

export interface HealthLink { href: string; label?: string }

/** The install guide's Volumes section (v0.52.0): the library and the downloads folder, mounted side by side. */
export const INSTALL_VOLUMES = 'https://github.com/AngeloSha/uchiyomi/blob/main/docs/INSTALL.md#volumes';

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
    // v0.52.0 (#134): the finding is about how two folders are mounted, not a series, and the install guide's Volumes
    // section shows the fix. The desktop app chooses its folders itself and has no compose file to point at.
    // Reintroduce by dropping this case: "a folder scanned twice links to the install guide" in healthLinks.test.ts.
    case 'folders-twice':
      return isDesktop() ? [] : [{ href: INSTALL_VOLUMES, label: tr('Volumes, in the install guide') }];
    // Impossible numbers are chapters the library holds: the first one named.
    case 'outliers':
      if (it.seriesId && it.numbers?.length) return [{ href: seriesHref(it.seriesId, it.numbers[0]) }];
      break;
    // Both copies, since the finding is about the pair and either may be the one to keep.
    case 'duplicates':
      if (it.seriesIds?.length) return it.seriesIds.map((id, i) => ({ href: seriesHref(id), label: it.titles?.[i] }));
      break;
    // #72: the engine's row is about no series; its setup steps, Check again and Connect are on Admin → Sources.
    case 'extension-engine':
      return [{ href: '/admin/?tab=Sources' }];
    // #116: a finding that waits for a renumbering review is about a plan, so Open is the plan -- which file becomes
    // which chapter -- on the series page. Any other numbering row opens the series itself: the page's plan is the
    // route's `next`, so "numbered by posting order lately" (info, keep_numbers) opened "Use the source's numbers"
    // with a Rename key nobody asked for, and an interrupted renumber (no key; the next check finishes it) invited a
    // Confirm over its journal (web2 review). An extension source adds its own settings either way, where a
    // numbering switch of its own may be the better fix (Webtoons' "sequential chapter numbering", #116's).
    // Reintroduce the plan for every row: "a series numbered by posting order lately opens a rename plan" in
    // healthLinks.test.ts fails.
    case 'numbering':
      if (it.seriesId) {
        const ext = extSourceIdOf(it.sourceId);
        const review = !it.info && !!it.actions?.includes('renumber');
        return [
          { href: review ? numberingHref(it.seriesId) : seriesHref(it.seriesId) },
          ...(ext ? [{ href: extensionSettingsHref(ext), label: tr('Source settings') }] : []),
        ];
      }
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
