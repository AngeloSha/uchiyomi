'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { adultShown } from '@/lib/adult';
import { readerTz } from '@/lib/readingTime';
import { hasInsights, type InsightsPayload } from '@/lib/insights';
import { t as tr } from '@/lib/i18n';
import { CARD } from './shared';
import { ReadingPace } from './ReadingPace';
import { Streaks } from './Streaks';
import { WhenYouRead } from './WhenYouRead';
import { CompletionFunnel } from './CompletionFunnel';
import { MixShare } from './MixShare';
import { BacklogHealth } from './BacklogHealth';
import { YearInReview } from './YearInReview';

/**
 * The insight cards of the You tab, laid out for the profile's `.board` (every row is a wide card plus a single one).
 * One request (GET /api/stats/insights) feeds all seven; each is its own component over lib/insights.ts. The query
 * is keyed on the 18+ switch because the series it names follow it. A new account sees one gentle card, not seven empty ones.
 */
export function YouInsights() {
  const shown = adultShown();
  const tz = readerTz();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['stats-insights', tz, shown],
    queryFn: () => api<InsightsPayload>(`/api/stats/insights?tz=${encodeURIComponent(tz)}`),
    staleTime: 60_000,
  });
  if (isLoading) return <div className="card skeleton h-40 wide" role="status" aria-label={tr('Loading…')} />;
  if (isError || !data) return null;
  if (!hasInsights(data)) {
    return (
      <div className={`${CARD} full`} data-you-insight="empty">
        <h2 className="mb-1 font-display text-base font-semibold">{tr('Insights')}</h2>
        <p className="text-xs text-fog-500">{tr('Finish a few chapters and your pace, streaks and habits will appear here.')}</p>
      </div>
    );
  }
  return (
    <>
      <ReadingPace data={data} span="wide" />
      <Streaks data={data} />
      <WhenYouRead data={data} span="wide" />
      <CompletionFunnel data={data} />
      <MixShare data={data} span="wide" />
      <BacklogHealth data={data} />
      <YearInReview data={data} span="full" />
    </>
  );
}
