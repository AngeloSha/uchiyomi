// Health's By series view (v0.72.0, @Squeaks72's idea in #254): one card per series with everything Health found wrong
// with it, beside the one card per check. What the page decides is here, pure for the tests: which view this device
// shows (and so what the report is asked for), which ticked series a Remove acts on, and what a Remove said.
//
// The grouping itself is the server's (bff lib/health.ts groupBySeries), from every card's whole list: #254 grouped the
// fifty rows each card sends, so a series past a card's fifty was missing and Select all and Remove acted on part of the
// library.
import { t as tr } from './i18n';
import { api } from './api';
import type { HealthReport, SeriesFindings } from './types';

export type HealthView = 'checks' | 'series';
const KEY = 'uchiyomi.healthView';

/** The view this device last chose: By check until it chooses By series. Per device, like the Library's layout. */
export function healthView(): HealthView {
  try { return localStorage.getItem(KEY) === 'series' ? 'series' : 'checks'; } catch { return 'checks'; }
}
export function setHealthView(v: HealthView): void {
  try { if (v === 'series') localStorage.setItem(KEY, 'series'); else localStorage.removeItem(KEY); } catch { /* a private window */ }
}

/**
 * Every reader of the report on Admin -- the hero, the overview, the version line and Health itself -- shares this one
 * query, so the report runs once however many read it. It asks for the series too while this device shows By series:
 * a reader asking without them would replace the cached report with one the view cannot draw.
 */
export const healthQuery = {
  queryKey: ['admin-health'] as const,
  queryFn: () => api<HealthReport>(healthView() === 'series' ? '/api/admin/health?view=series' : '/api/admin/health'),
};

/** The series cards drawn at first, and how many more each "Show more" draws: a page, not a library. */
export const SERIES_PAGE = 50;

/**
 * The ticked series a Remove acts on: those ticked AND on the screen now. #254's selection outlived its rows, so after a
 * re-check "Remove 3" could hide a series no longer listed, or one never drawn. A tick on a series that went away is not
 * counted, and counts again if it comes back. Reintroduce the bare selection: "a tick on a series that left the list is
 * not removed" in healthBySeries.test.ts.
 */
export function chosenOf(picked: ReadonlySet<string>, shown: readonly SeriesFindings[]): string[] {
  return shown.filter((r) => picked.has(r.seriesId)).map((r) => r.seriesId);
}

/** Every series on the screen ticked? Then Select none; else Select all ticks every one of them, and nothing else. */
export const allChosen = (picked: ReadonlySet<string>, shown: readonly SeriesFindings[]): boolean =>
  shown.length > 0 && shown.every((r) => picked.has(r.seriesId));
export const toggleAll = (picked: ReadonlySet<string>, shown: readonly SeriesFindings[]): Set<string> =>
  (allChosen(picked, shown) ? new Set() : new Set(shown.map((r) => r.seriesId)));

/** Over the view: how many series have a finding. */
export const seriesCountText = (n: number): string => (n === 1 ? tr('1 series needs a look') : tr('{n} series need a look', { n }));
/** Under a series' title: how many findings it has. */
export const findingsText = (n: number): string => (n === 1 ? tr('1 finding') : tr('{n} findings', { n }));

/**
 * What a Remove said, from POST /api/admin/series/bulk/hide's answer, in the Library's words for the same route: when
 * nothing was removed it says so as an error, never "Removed 0 series".
 */
export function removedText(r: { hidden: number; skipped: ReadonlyArray<{ reason: string }> }): { text: string; ok: boolean } {
  const skipped = r.skipped.length;
  if (r.hidden === 0) {
    return { ok: false, text: skipped === 1 ? tr('Nothing removed · 1 skipped') : tr('Nothing removed · {n} skipped', { n: skipped }) };
  }
  const parts = [r.hidden === 1 ? tr('Removed 1 series') : tr('Removed {n} series', { n: r.hidden })];
  if (skipped) parts.push(skipped === 1 ? tr('1 skipped') : tr('{n} skipped', { n: skipped }));
  return { ok: true, text: parts.join(' · ') };
}
