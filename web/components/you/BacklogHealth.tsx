'use client';
import Link from 'next/link';
import { t as tr } from '@/lib/i18n';
import { backlogRows, neglectedRows, type InsightsPayload } from '@/lib/insights';
import { Card, Empty, Stat, Sub } from './shared';

/** Unread chapters per series you have started, and the ones that have waited longest. */
export function BacklogHealth({ data, span }: { data: InsightsPayload; span?: string }) {
  const now = Date.parse(data.now);
  const b = backlogRows(data.series, now);
  const old = neglectedRows(data.series, now);
  const idle = (d: number | null) => (d == null ? '' : d === 0 ? tr('today') : d === 1 ? tr('1 day ago') : tr('{n} days ago', { n: d }));
  const row = (r: { id: string; title: string; unread: number; idleDays: number | null }, hint: string) => (
    <li key={r.id}>
      <Link href={`/series/?id=${encodeURIComponent(r.id)}`} className="flex items-center justify-between gap-3 rounded-xl border border-ink-700/70 bg-ink-850/50 px-3 py-2">
        <span className="min-w-0 truncate text-sm text-fog-100">{r.title}</span>
        <span className="shrink-0 text-xs tabular-nums text-fog-400">{hint}</span>
      </Link>
    </li>
  );
  return (
    <Card id="you-backlog" title={tr('Backlog health')} span={span}>
      {b.seriesCount === 0 ? <Empty>{tr('No unread chapters in the series you have started.')}</Empty> : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <Stat label={tr('Unread chapters')} value={b.totalUnread} />
            <Stat label={tr('Series with some left')} value={b.seriesCount} />
          </div>
          <div>
            <Sub>{tr('Most unread')}</Sub>
            <ul className="space-y-1.5">{b.rows.map((r) => row(r, tr('{n} unread', { n: r.unread })))}</ul>
          </div>
          <div>
            <Sub>{tr('Waiting the longest')}</Sub>
            <ul className="space-y-1.5">{old.map((r) => row(r, `${idle(r.idleDays)} · ${tr('{n} unread', { n: r.unread })}`))}</ul>
          </div>
        </div>
      )}
    </Card>
  );
}
