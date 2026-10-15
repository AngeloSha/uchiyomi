'use client';
import { useState } from 'react';
import { Bars } from '@/components/charts/Bars';
import { t as tr } from '@/lib/i18n';
import { mixRows, type InsightsPayload, type MixField } from '@/lib/insights';
import { Card, Empty } from './shared';

/** Share of this month's finished chapters by genre or by source, with the change against last month. Names are the browsable series' own. */
export function MixShare({ data, span }: { data: InsightsPayload; span?: string }) {
  const [by, setBy] = useState<MixField>('genre');
  const { rows } = mixRows(data.series, by);
  const change = (d: number | null) => (d == null ? tr('new') : d === 0 ? '=' : d > 0 ? `+${d}` : `${d}`);
  return (
    <Card id="you-mix" title={tr('Genre and source mix')} span={span}>
      <div role="group" aria-label={tr('Group by')} className="mb-3 flex gap-1.5">
        {(['genre', 'source'] as const).map((k) => (
          <button key={k} onClick={() => setBy(k)} aria-pressed={by === k} className={`chip text-[11px] ${by === k ? 'border-accent/50 text-accent' : 'text-fog-400'}`}>
            {k === 'genre' ? tr('Genre') : tr('Source')}
          </button>
        ))}
      </div>
      {rows.length === 0 ? <Empty>{tr('Nothing finished this month yet.')}</Empty> : (
        <>
          <Bars wideHint items={rows.map((r) => ({ label: r.label, value: r.share, hint: `${r.share}% ${change(r.deltaPts)}` }))} max={100} />
          <p className="mt-2 text-[11px] text-fog-500">
            {tr('Share of this month’s chapters; the number after it is the change in points since last month.')}
            {by === 'genre' ? ` ${tr('A chapter counts toward each genre of its series.')}` : ''}
          </p>
        </>
      )}
    </Card>
  );
}
