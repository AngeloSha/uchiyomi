'use client';
import { t as tr } from '@/lib/i18n';
import { funnel, DROP_AFTER_DAYS, type InsightsPayload } from '@/lib/insights';
import { Bars } from '@/components/charts/Bars';
import { Card, Empty } from './shared';

/** Series started, finished and dropped, and where in a series readers like you tend to stop. */
export function CompletionFunnel({ data, span }: { data: InsightsPayload; span?: string }) {
  const f = funnel(data.series, Date.parse(data.now));
  return (
    <Card id="you-funnel" title={tr('Completion funnel')} span={span}>
      {f.started === 0 ? <Empty>{tr('Start a series and it will be counted here.')}</Empty> : (
        <div className="space-y-3">
          <Bars items={[
            { label: tr('Started'), value: f.started },
            { label: tr('Finished'), value: f.finished },
            { label: tr('Still reading'), value: f.active },
            { label: tr('Dropped'), value: f.dropped },
          ]} max={f.started} />
          <p className="text-xs text-fog-300">
            {f.dropMedian == null
              ? tr('Nothing dropped yet.')
              : f.dropPct != null
                ? tr('You usually stop around chapter {n}, about {pct}% of the way through.', { n: f.dropMedian, pct: f.dropPct })
                : tr('You usually stop around chapter {n}.', { n: f.dropMedian })}
          </p>
          <p className="text-[11px] text-fog-500">{tr('Dropped means chapters left and no reading for {n}+ days.', { n: DROP_AFTER_DAYS })}</p>
        </div>
      )}
    </Card>
  );
}
