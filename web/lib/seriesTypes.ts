// What kind of comic a series is (bff lib/seriesTypeSignals.ts): the types the notice-chapter switches go by, in the
// server's order, with the label each is shown under. The labels are tr() keys (web/public/locales).
import { keys } from './i18n';
import type { SeriesType } from './types';

export const SERIES_TYPES: readonly SeriesType[] = ['manga', 'manhwa', 'manhua', 'webtoon', 'comic', 'unknown'];

const LABELS = keys('Manga', 'Manhwa', 'Manhua', 'Webtoon', 'Comic', 'Unknown / other');

/** The tr() key a type is shown under. */
export function seriesTypeKey(t: SeriesType): string {
  return LABELS[SERIES_TYPES.indexOf(t)] ?? LABELS[LABELS.length - 1];
}
