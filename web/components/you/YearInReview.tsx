'use client';
import Link from 'next/link';
import { t as tr } from '@/lib/i18n';
import { bookCountText } from '@/lib/format';
import { yearReview, type InsightsPayload } from '@/lib/insights';
import { IcChevronRight } from '@/components/icons';
import { Card, Empty, Stat, deltaText } from './shared';

/** This year against last, month by month, and the way into the full Wrapped. */
export function YearInReview({ data, span }: { data: InsightsPayload; span?: string }) {
  const y = yearReview(data.daily, Date.parse(data.now));
  const max = Math.max(1, ...y.thisYear, ...y.lastYear);
  const month = (i: number) => new Date(Date.UTC(2000, i, 1)).toLocaleDateString([], { month: 'short', timeZone: 'UTC' });
  return (
    <Card id="you-year" title={tr('Year in review')} span={span}>
      {y.thisTotal === 0 && y.lastTotal === 0 ? <Empty>{tr('Your year in chapters will build up here.')}</Empty> : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label={String(y.year)} value={bookCountText(y.thisTotal)} hint={deltaText(y.deltaPct) ? `${deltaText(y.deltaPct)} · ${tr('vs this time last year')}` : undefined} />
            <Stat label={String(y.year - 1)} value={bookCountText(y.lastTotal)} hint={tr('{n} by this date', { n: y.lastSamePeriod })} />
          </div>
          <div role="img" aria-label={tr('Chapters per month, this year against last year')}>
            <div className="flex h-24 items-end gap-1">
              {y.thisYear.map((v, i) => (
                <div key={i} title={`${month(i)} · ${y.year}: ${v} · ${y.year - 1}: ${y.lastYear[i]}`} className="flex h-full min-w-0 flex-1 items-end gap-px">
                  <div className="w-1/2 rounded-t-sm bg-fog-600/50" style={{ height: `${Math.max(y.lastYear[i] > 0 ? 4 : 0, Math.round((y.lastYear[i] / max) * 100))}%` }} />
                  <div className="w-1/2 rounded-t-sm" style={{ height: `${Math.max(v > 0 ? 4 : 0, Math.round((v / max) * 100))}%`, background: 'rgb(var(--accent))' }} />
                </div>
              ))}
            </div>
            <div aria-hidden className="mt-1 flex text-[9px] text-fog-600">
              {y.thisYear.map((_, i) => <span key={i} className="min-w-0 flex-1 truncate text-start">{month(i)}</span>)}
            </div>
          </div>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fog-500">
            <span><span aria-hidden className="me-1 inline-block h-2 w-2 rounded-sm" style={{ background: 'rgb(var(--accent))' }} />{y.year}</span>
            <span><span aria-hidden className="me-1 inline-block h-2 w-2 rounded-sm bg-fog-600/50" />{y.year - 1}</span>
          </p>
        </div>
      )}
      <Link href="/wrapped/" className="chip mt-3 text-xs">{tr('Open your Wrapped')}<IcChevronRight width={14} height={14} aria-hidden className="rtl:-scale-x-100" /></Link>
    </Card>
  );
}
