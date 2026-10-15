'use client';
import Link from 'next/link';
import { Columns } from '@/components/charts/Columns';
import { t as tr } from '@/lib/i18n';
import { bookCountText } from '@/lib/format';
import { paceVsAverage, projections, weeklyCounts, dayMs, type InsightsPayload } from '@/lib/insights';
import { Card, Empty, Stat, Sub, deltaText, shortDate } from './shared';

/** Chapters a week against the reader's own average, and when the series in progress would be finished at that pace. */
export function ReadingPace({ data, span }: { data: InsightsPayload; span?: string }) {
  const now = Date.parse(data.now);
  const pace = paceVsAverage(data.daily, now, 8);
  const weekly = weeklyCounts(data.daily, now, 8);
  const proj = projections(data.series, now);
  return (
    <Card id="you-pace" title={tr('Reading pace')} span={span}>
      {weekly.every((v) => v === 0) ? <Empty>{tr('Finish a few chapters and your weekly pace shows up here.')}</Empty> : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <Stat label={tr('Last 7 days')} value={bookCountText(pace.thisWeek)} hint={deltaText(pace.deltaPct) || undefined} />
            <Stat label={tr('Your weekly average')} value={pace.weeks ? bookCountText(Math.round(pace.average * 10) / 10) : '-'}
              hint={pace.weeks ? tr('over {n} earlier weeks', { n: pace.weeks }) : tr('Needs a full earlier week')} />
          </div>
          <div>
            <Sub>{tr('Chapters per week, last 8 weeks')}</Sub>
            <div role="img" aria-label={tr('Chapters per week, last 8 weeks')}>
              <WeekColumns values={weekly} />
            </div>
          </div>
          <div data-pace-projection>
            <Sub>{tr('At this pace, finished by')}</Sub>
            {proj.length === 0 ? <p className="text-xs text-fog-500">{tr('Read a series you are part-way through to see when you would finish it.')}</p> : (
              <ul className="space-y-1.5">
                {proj.map((p) => (
                  <li key={p.id}>
                    <Link href={`/series/?id=${encodeURIComponent(p.id)}`} className="flex items-center justify-between gap-3 rounded-xl border border-ink-700/70 bg-ink-850/50 px-3 py-2">
                      <span className="min-w-0 truncate text-sm text-fog-100">{p.title}</span>
                      <span className="shrink-0 text-xs tabular-nums text-fog-400">{shortDate(dayMs(p.date))} · {tr('{n} left', { n: p.unread })}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

/** Eight bars with the count above each; the last (this week) is brightest. Divs, so it flips under dir="rtl" by itself. */
function WeekColumns({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <div className="flex h-20 items-end gap-1.5">
      {values.map((v, i) => (
        <div key={i} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-0.5">
          <span className="text-[10px] tabular-nums text-fog-500">{v}</span>
          <div className="w-full rounded-t-sm" style={{ height: `${Math.max(v > 0 ? 6 : 0, Math.round((v / max) * 100))}%`, background: `rgb(var(--accent) / ${i === values.length - 1 ? 1 : 0.5})` }} />
        </div>
      ))}
    </div>
  );
}
