'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { adultShown } from '@/lib/adult';
import { t as tr, keys } from '@/lib/i18n';
import { bookCountText, dayText, numberText } from '@/lib/format';
import { Bars } from '@/components/charts/Bars';
import { CARD } from '@/components/ProfileYou';
import {
  backlogRows, dayMs, funnel, hasInsights, mixRows, projections, waitingRows,
  type InsightsPayload, type MixField,
} from '@/lib/insights';

/**
 * Profile → Insights: what the Reading studio and Wrapped do not already show, worked out from the reader's own finished
 * chapters (each once, #264). From @Squeaks72's #249, reduced: the pace and the hours are the Studio's, the year is
 * Wrapped's, so what is left is when the series in progress would be finished, the best day and week, this month's mix
 * against last month's, how the series begun have gone, and the backlog. One request feeds every card, keyed on the
 * Show 18+ switch because the series it names follow it (the server lists through browsable()).
 *
 * Its own tab rather than more cards under the Studio, which made You twice as long.
 */
export function ProfileInsights() {
  const shown = adultShown();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['stats-insights', shown],
    queryFn: () => api<InsightsPayload>('/api/stats/insights'),
    staleTime: 60_000,
  });
  if (isLoading) return <div className="board"><div className="card skeleton wide h-48" /><div className="card skeleton h-48" /></div>;
  if (isError || !data) return null;
  if (!hasInsights(data)) {
    return (
      <div className="board">
        <div className={`${CARD} full`} data-insight="empty">
          <p className="py-6 text-center text-sm text-fog-500">{tr('Finish a few chapters and your insights show up here.')}</p>
        </div>
      </div>
    );
  }
  return <InsightCards data={data} />;
}

/** The cards, drawn from one answer (exported for web/test/insights.test.ts, which renders them without a server). */
export function InsightCards({ data }: { data: InsightsPayload }) {
  const now = Date.parse(data.now);
  return (
    <div className="board">
      <AtThisPace data={data} now={now} />
      <Bests data={data} />
      <Mix data={data} />
      <Funnel data={data} now={now} />
      <Backlog data={data} />
    </div>
  );
}

function Card({ id, title, span = '', children }: { id: string; title: string; span?: string; children: React.ReactNode }) {
  return (
    <section data-insight={id} className={`${CARD} ${span}`}>
      <h2 className="mb-3 font-display text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

const Sub = ({ children }: { children: React.ReactNode }) => (
  <p className="mb-1.5 text-[11px] uppercase tracking-widest text-fog-500">{children}</p>
);

/** The Studio's squared tile: a figure, what it is, and a line under it. */
function Tile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-ink-700/70 bg-ink-850/50 px-2.5 py-2">
      <p className="truncate text-[10px] text-fog-500">{label}</p>
      <p className="truncate font-display text-base font-semibold tabular-nums text-fog-100">{value}</p>
      {hint && <p className="truncate text-[10px] text-fog-500">{hint}</p>}
    </div>
  );
}

/** A series and a line about it, linking to its page: the Lists card's rows. */
function Row({ id, title, hint }: { id: string; title: string; hint: string }) {
  return (
    <li>
      <Link href={`/series/?id=${encodeURIComponent(id)}`}
        className="flex items-center justify-between gap-3 rounded-xl border border-ink-700/70 bg-ink-850/50 px-3 py-2 transition hover:border-ink-600">
        <span className="min-w-0 truncate text-sm text-fog-100">{title}</span>
        <span className="shrink-0 text-xs tabular-nums text-fog-400">{hint}</span>
      </Link>
    </li>
  );
}

const leftText = (n: number) => (n === 1 ? tr('1 chapter left') : tr('{n} chapters left', { n }));

/** When each series in progress would be finished, at the reader's pace through it over the last four weeks. */
function AtThisPace({ data, now }: { data: InsightsPayload; now: number }) {
  const rows = projections(data.series, now);
  return (
    <Card id="pace" title={tr('At this pace')} span="wide">
      <p className="-mt-2 mb-3 text-xs text-fog-500">{tr('When you would finish the series you are reading, at your pace through each over the last four weeks.')}</p>
      {rows.length === 0
        ? <p className="py-3 text-xs text-fog-500">{tr('Read a series you are part-way through and its finish date shows up here.')}</p>
        : <ul className="space-y-1.5">{rows.map((p) => <Row key={p.id} id={p.id} title={p.title} hint={`${dayText(dayMs(p.date), new Date(dayMs(p.date)).getUTCFullYear() !== new Date(now).getUTCFullYear())} · ${leftText(p.unread)}`} />)}</ul>}
    </Card>
  );
}

/** The busiest day and week ever, each chapter once. */
function Bests({ data }: { data: InsightsPayload }) {
  return (
    <Card id="bests" title={tr('Your best')}>
      <div className="grid grid-cols-2 gap-2">
        <Tile label={tr('Best day')} value={data.bestDay ? bookCountText(data.bestDay.chapters) : '–'}
          hint={data.bestDay ? dayText(dayMs(data.bestDay.day), true) : undefined} />
        <Tile label={tr('Best week')} value={data.bestWeek ? bookCountText(data.bestWeek.chapters) : '–'}
          hint={data.bestWeek ? tr('week of {date}', { date: dayText(dayMs(data.bestWeek.start), true) }) : undefined} />
      </div>
    </Card>
  );
}

// Rendered as `tr(k)`, so the labels are declared. See lib/i18n.ts.
const MIX_BY = keys('Genre', 'Source');

/** A change in points, signed, isolated so a "+" stays before its number in Arabic. */
const pts = (d: number | null) => (d == null ? tr('new') : d === 0 ? '=' : `⁦${d > 0 ? '+' : '−'}${Math.abs(d)}⁩`);

/** This month's finished chapters by genre or by source, with the change since last month. */
function Mix({ data }: { data: InsightsPayload }) {
  const [by, setBy] = useState<MixField>('genre');
  const { rows } = mixRows(data.series, by);
  return (
    <Card id="mix" title={tr('Genre and source mix')} span="wide">
      {/* Filter chips: they choose what the bars below count (web/test/noPills.test.ts keeps chips for filters). */}
      <div role="group" aria-label={tr('Genre and source mix')} className="-mt-1 mb-3 flex gap-1.5">
        {(['genre', 'source'] as const).map((k, i) => (
          <button key={k} type="button" onClick={() => setBy(k)} aria-pressed={by === k}
            className={`chip text-[11px] ${by === k ? 'border-accent/50 text-accent' : 'text-fog-400'}`}>
            {tr(MIX_BY[i])}
          </button>
        ))}
      </div>
      {rows.length === 0 ? <p className="py-3 text-xs text-fog-500">{tr('Nothing finished this month yet.')}</p> : (
        <>
          <Bars wideHint max={100} items={rows.map((r) => ({ label: r.label, value: r.share, hint: `${r.share}% · ${pts(r.deltaPts)}` }))} />
          <p className="mt-2 text-[11px] text-fog-500">
            {tr('Each one’s share of this month’s chapters, and the change in points since last month.')}
            {by === 'genre' ? ` ${tr('A chapter counts toward every genre of its series.')}` : ''}
          </p>
        </>
      )}
    </Card>
  );
}

/** Of the series begun: finished, still being read, dropped -- and where the dropped ones usually stopped. */
function Funnel({ data, now }: { data: InsightsPayload; now: number }) {
  const f = funnel(data.series, now);
  return (
    <Card id="funnel" title={tr('Series you started')}>
      {/* How many, then what became of them: each bar is a share of the series begun. */}
      <p className="-mt-1 mb-3 font-display text-2xl font-semibold tabular-nums text-fog-100">
        {f.started === 1 ? tr('1 series') : tr('{n} series', { n: numberText(f.started) })}
      </p>
      <Bars max={f.started} items={[
        { label: tr('Finished'), value: f.finished },
        { label: tr('Still reading'), value: f.active },
        { label: tr('Dropped'), value: f.dropped },
      ]} />
      <p className="mt-3 text-xs text-fog-300">
        {f.dropMedian == null ? tr('Nothing dropped yet.')
          : f.dropPct != null ? tr('You usually stop around chapter {n}, about {pct}% of the way in.', { n: f.dropMedian, pct: f.dropPct })
            : tr('You usually stop around chapter {n}.', { n: f.dropMedian })}
      </p>
      <p className="mt-1 text-[11px] text-fog-500">{tr('Dropped: chapters left, and nothing read in two months.')}</p>
    </Card>
  );
}

/** The unread chapters of the series begun: how many, where most of them are, and which have waited longest. */
function Backlog({ data }: { data: InsightsPayload }) {
  const b = backlogRows(data.series);
  const waiting = waitingRows(data.series);
  const unread = (n: number) => tr('{n} unread', { n });
  return (
    <Card id="backlog" title={tr('Backlog')} span="full">
      {b.seriesCount === 0 ? <p className="py-3 text-xs text-fog-500">{tr('Nothing unread in the series you have started.')}</p> : (
        <div className="grid gap-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="grid grid-cols-2 content-start gap-2 md:grid-cols-1">
            <Tile label={tr('Unread chapters')} value={numberText(b.totalUnread)} />
            <Tile label={tr('Series with chapters left')} value={numberText(b.seriesCount)} />
          </div>
          <div className="min-w-0">
            <Sub>{tr('Most unread')}</Sub>
            <ul className="space-y-1.5">{b.rows.map((r) => <Row key={r.id} id={r.id} title={r.title} hint={unread(r.unread)} />)}</ul>
          </div>
          <div className="min-w-0">
            <Sub>{tr('Waiting the longest')}</Sub>
            <ul className="space-y-1.5">
              {waiting.map((r) => <Row key={r.id} id={r.id} title={r.title} hint={tr('Last read {when}', { when: dayText(Date.parse(r.lastReadAt!), true) })} />)}
            </ul>
          </div>
        </div>
      )}
    </Card>
  );
}
