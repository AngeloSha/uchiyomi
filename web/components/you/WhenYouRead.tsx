'use client';
import { Bars } from '@/components/charts/Bars';
import { t as tr, keys } from '@/lib/i18n';
import { bookCountText } from '@/lib/format';
import { peakIndex, type InsightsPayload } from '@/lib/insights';
import { Card, Empty, Sub } from './shared';

const DOW = keys('Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat');

/** Chapters finished by hour of the day and by weekday over the last year, in the reader's own time zone. */
export function WhenYouRead({ data, span }: { data: InsightsPayload; span?: string }) {
  const total = data.byHour.reduce((a, b) => a + b, 0);
  const hour = peakIndex(data.byHour);
  const day = peakIndex(data.byWeekday);
  return (
    <Card id="you-when" title={tr('When you read')} span={span}>
      {total === 0 ? <Empty>{tr('Nothing finished in the last year yet.')}</Empty> : (
        <div className="space-y-4">
          <p className="text-xs text-fog-300">
            {tr('Most chapters finished around {hour}, most often on {day}.', { hour: `${hour}:00`, day: tr(DOW[day]) })}
            {' '}<span className="text-fog-500">{tr('Last 365 days, {n}.', { n: bookCountText(total) })}</span>
          </p>
          <div>
            <Sub>{tr('By hour')}</Sub>
            <HourColumns values={data.byHour} />
          </div>
          <div>
            <Sub>{tr('By weekday')}</Sub>
            <Bars items={data.byWeekday.map((v, i) => ({ label: tr(DOW[i]), value: v }))} />
          </div>
        </div>
      )}
    </Card>
  );
}

/** Columns reads values as reading TIME; a count is the same shape, so this draws the hours without an amount of time in its tooltip. */
function HourColumns({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <div role="img" aria-label={tr('Chapters finished by hour of the day')}>
      <div className="flex h-16 items-end gap-0.5">
        {values.map((v, h) => (
          <div key={h} title={`${h}:00 · ${bookCountText(v)}`} className="flex h-full min-w-0 flex-1 items-end">
            <div className="w-full rounded-t-sm" style={{ height: `${Math.max(v > 0 ? 4 : 0, Math.round((v / max) * 100))}%`, background: `rgb(var(--accent) / ${(0.35 + 0.65 * (v / max)).toFixed(3)})` }} />
          </div>
        ))}
      </div>
      <div aria-hidden className="mt-1 flex text-[9px] tabular-nums text-fog-600">
        {values.map((_, h) => <span key={h} className="min-w-0 flex-1 text-start">{h % 6 === 0 ? h : ''}</span>)}
      </div>
    </div>
  );
}
