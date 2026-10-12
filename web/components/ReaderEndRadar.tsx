'use client';
// The reader's end card, when the reader has run out of chapters (v0.61.0): is that the end, or is more on the way?
//
// "You finished" said the same thing about a finished series and about one whose next chapter is due on Friday. With a
// release radar (bff lib/releaseRadar.ts) the card can tell them apart: a series the radar dates and that has not ended
// is one the reader has caught up with, and the line under its title says what is coming -- chapters the sources list
// that are not here yet, else the radar's estimate ("Next chapter ~Friday · usually Fridays"). A finished series, or one
// nothing dates, reads as it always did.
//
// Its own file because the reader page belongs to its own work: the end card mounts these two in one place each. The
// series is read under the series page's own key (['series', id], GET /api/series/:id -- web/test/queryKeys.test.ts),
// so a reader who came from the series page has it already.
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { radarText } from '@/lib/radar';
import type { Series } from '@/lib/types';

/** The series behind the end card, or undefined while it loads (and offline, where the card does not ask). */
function useEndSeries(seriesId: string | null | undefined): Series | undefined {
  const { data } = useQuery({
    queryKey: ['series', seriesId],
    queryFn: () => api<Series>(`/api/series/${seriesId}`),
    enabled: !!seriesId,
    staleTime: 60_000,
  });
  return data;
}

/**
 * The card's label: "You're all caught up" for a series the radar dates and that has not ended, else "You finished".
 * Not while the sources list chapters that are not here yet: the line under the title says "3 not here yet", and
 * "caught up" above it would contradict it. Reintroduce by dropping the `missing` test: "the end card: caught up while
 * more is on the way, finished otherwise" in radar.test.ts reads "caught up" over chapters not here yet.
 */
export function endLabel(series: Pick<Series, 'yomi' | 'source'> | undefined): string {
  const radar = series?.yomi?.radar;
  const missing = series?.source?.missing ?? 0;
  return radar && !radar.ended && missing === 0 ? tr('You’re all caught up') : tr('You finished');
}

/** The line under the title: what the sources list that is not here yet, else what the radar expects; '' for nothing. */
export function endLine(series: Pick<Series, 'yomi' | 'source' | 'autoUpdate'> | undefined): string {
  if (!series) return '';
  const missing = series.source?.missing ?? 0;
  if (missing > 0) return missing === 1 ? tr('1 not here yet') : tr('{n} not here yet', { n: missing });
  return radarText(series.yomi?.radar, { autoUpdate: series.autoUpdate !== false });
}

/** The label, in the end card's own small capitals (its <p>). */
export function ReaderEndLabel({ seriesId }: { seriesId: string | null | undefined }) {
  return <>{endLabel(useEndSeries(seriesId))}</>;
}

/** The line under the series' title, or nothing. */
export function ReaderEndRadar({ seriesId }: { seriesId: string | null | undefined }) {
  const line = endLine(useEndSeries(seriesId));
  if (!line) return null;
  return <p data-end-radar className="mx-auto mt-2 max-w-sm text-sm text-fog-400">{line}</p>;
}
