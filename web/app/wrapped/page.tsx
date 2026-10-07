'use client';
import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ART } from '@/lib/art';
import { Wordmark } from '@/components/Brand';
import { IcChevronLeft } from '@/components/icons';
import { Heatmap } from '@/components/charts/Heatmap';
import { Bars } from '@/components/charts/Bars';
import { keys, t as tr } from '@/lib/i18n';

function CountUp({ to }: { to: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / 900);
      setN(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return <>{n}</>;
}

interface Wrapped {
  year: number;
  chapters: number;
  series: number;
  topSeries: { id: string; title: string; count: number }[];
  topGenres: string[];
  topGenreCounts?: { name: string; count: number }[];
  byMonth: number[];
  byDay?: number[];
  byDow?: number[];
  busiestDow: number;
}
// Through keys(): both places that show a day say `tr(DOW[i])`, which a scan for inline tr() cannot see, so the
// days were English in every language.
const DOW = keys('Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday');
const MON = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

/**
 * The line under the year's big number, which counts chapters: its noun agrees with that number ("1 chapter"), and
 * the series it names are counted in pairs. It was "chapters across 1 series" in English in every language.
 */
const acrossText = (chapters: number, series: number): string =>
  chapters === 1 ? tr('chapter')
  : series === 1 ? tr('chapters across 1 series')
  : tr('chapters across {n} series', { n: series });

export default function WrappedPage() {
  // Static export: any page reading search params needs a Suspense boundary or `next build` fails.
  return (
    <Suspense fallback={<div className="px-4 pt-16"><div className="skeleton h-40 rounded-3xl" /></div>}>
      <Wrapped />
    </Suspense>
  );
}

function Wrapped() {
  const router = useRouter();
  const sp = useSearchParams();
  const thisYear = new Date().getUTCFullYear();
  // `/api/wrapped` has always accepted ?year=, and both callers hardcoded the current one -- so every past
  // year was computed on request and unreachable. UTC, to agree with how the endpoint buckets.
  const asked = Math.floor(Number(sp.get('year')));
  const year = Number.isFinite(asked) && asked >= 1970 && asked <= thisYear ? asked : thisYear;

  const { data } = useQuery({ queryKey: ['wrapped', year], queryFn: () => api<Wrapped>('/api/wrapped?year=' + year) });
  // Only for `first_read_at`, so the picker offers the years that exist rather than a made-up range. The
  // narrowest window keeps it cheap; nothing on this page uses the daily series from it.
  const { data: stats } = useQuery({
    queryKey: ['stats', 7],
    queryFn: () => api<{ first_read_at: string | null }>('/api/stats?days=7'),
  });
  const firstYear = stats?.first_read_at ? new Date(stats.first_read_at).getUTCFullYear() : thisYear;
  const years: number[] = [];
  for (let y = thisYear; y >= Math.max(1970, Math.min(firstYear, thisYear)); y--) years.push(y);

  const maxM = Math.max(1, ...(data?.byMonth ?? [0]));
  // One sentence split around the day, which is set brighter: `tr('Your power day was')` glued to it read
  // "Your power day wasTuesday", and a language that puts the day first could not.
  const [dayBefore, dayAfter] = tr('Your power day was {day}').split('{day}');

  return (
    <div className="min-h-screen-d">
      <header className="safe-top flex items-center gap-2 px-4 pb-2 lg:px-0">
        <button onClick={() => router.back()} className="grid h-10 w-10 place-items-center rounded-full bg-ink-800/70 text-fog-100">
          <IcChevronLeft width={22} height={22} />
        </button>
        <h1 className="font-display text-2xl font-bold">{tr('Wrapped {year}', { year: String(year) })}</h1>
      </header>

      {years.length > 1 && (
        <div className="hide-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-5 pb-1 lg:mx-auto lg:max-w-2xl lg:px-0">
          {years.map((y) => (
            <Link key={y} href={y === thisYear ? '/wrapped/' : `/wrapped/?year=${y}`} scroll={false}
              aria-current={y === year ? 'true' : undefined}
              className={`chip shrink-0 text-xs tabular-nums ${y === year ? 'border-accent/50 text-accent' : 'text-fog-400'}`}>
              {y}
            </Link>
          ))}
        </div>
      )}

      <div className="relative mx-4 mt-2 overflow-hidden rounded-4xl border border-ink-700/60 p-6 shadow-lift lg:mx-auto lg:max-w-2xl">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={ART.wrapped} alt="" className="absolute inset-0 h-full w-full object-cover opacity-70" />
        {/* the `via` stop at 72% was here and never rendered -- v3's opacity scale is multiples of 5, so it matched
              nothing. v4 would honour it and darken this scrim; keeping the two stops that always applied
              keeps the page looking the way it has shipped. */}
        <div className="absolute inset-0 bg-linear-to-t from-ink-950 to-ink-950/30" />
        <div className="relative">
          <Wordmark className="text-xl" />
          <p className="mt-6 text-sm text-fog-300">{year === thisYear ? tr('This year you read') : tr('In {y} you read', { y: String(year) })}</p>
          <p className="font-brand text-7xl font-bold text-accent drop-shadow-[0_2px_24px_rgba(124,92,255,0.4)]"><CountUp to={data?.chapters ?? 0} /></p>
          <p className="text-lg text-fog-100">{acrossText(data?.chapters ?? 0, data?.series ?? 0)}</p>
          {data != null && data.chapters > 0 && (
            <p className="mt-4 text-sm text-fog-300">{dayBefore}<span className="text-fog-100">{tr(DOW[data.busiestDow])}</span>{dayAfter}</p>
          )}
        </div>
      </div>

      {!!data?.byDay?.length && data.chapters > 0 && (
        <div className="px-5 pt-6 lg:mx-auto lg:max-w-2xl lg:px-0">
          <p className="mb-2 text-xs font-medium text-fog-400">{tr('Every day of {y}', { y: String(year) })}</p>
          <Heatmap values={data.byDay} start={`${year}-01-01`} />
        </div>
      )}

      <div className="px-5 pt-6 lg:mx-auto lg:max-w-2xl lg:px-0">
        <p className="mb-2 text-xs font-medium text-fog-400">{tr('By month')}</p>
        <div className="flex h-24 items-end gap-1.5">
          {(data?.byMonth ?? Array(12).fill(0)).map((v, i) => (
            <div key={i} className="flex flex-1 flex-col items-center gap-1">
              <div className="w-full rounded-t bg-accent/70" style={{ height: `${(v / maxM) * 100}%`, minHeight: 2 }} />
              <span className="text-[9px] text-fog-600">{MON[i]}</span>
            </div>
          ))}
        </div>
      </div>

      {/* `byDow` was computed by /api/wrapped, asserted four times in wrappedYear.int.test.ts, typed on the
          interface above -- and rendered by nothing. The page showed only `busiestDow` ("your power day
          was Tuesday"), which is the argmax of this array: the headline without the distribution behind
          it, so a week that was almost flat and a week that was all one day read identically.
          The profile's Reading Studio draws a weekday chart too, but it buckets /api/stats on the client
          over a rolling window; this is the whole year, from the server, and they are different numbers on
          purpose. */}
      {!!data?.byDow?.some((v) => v > 0) && (
        <div className="px-5 pt-6 lg:mx-auto lg:max-w-2xl lg:px-0">
          <p className="mb-2 text-xs font-medium text-fog-400">{tr('By weekday')}</p>
          <Bars items={data!.byDow!.map((v, i) => ({ label: tr(DOW[i]), value: v, hint: `${v}` }))} />
        </div>
      )}

      {(data?.topSeries?.length ?? 0) > 0 && (
        <div className="px-5 pt-6 lg:mx-auto lg:max-w-2xl lg:px-0">
          <p className="mb-2 text-xs font-medium text-fog-400">{tr('Top series')}</p>
          <div className="card divide-y divide-ink-800/70 overflow-hidden">
            {data!.topSeries.map((s, i) => (
              <Link key={s.id} href={`/series/?id=${s.id}`} className="flex items-center gap-3 px-4 py-3">
                <span className="w-5 font-display text-lg font-bold text-accent">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-fog-100">{s.title}</span>
                <span className="text-xs text-fog-500">{tr('{n} ch', { n: s.count })}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {(data?.topGenres?.length ?? 0) > 0 && (
        <div className="px-5 pb-12 pt-6 lg:mx-auto lg:max-w-2xl lg:px-0">
          <p className="mb-2 text-xs font-medium text-fog-400">{tr('Your genres')}</p>
          {data!.topGenreCounts?.length
            ? <Bars items={data!.topGenreCounts.map((g) => ({ label: g.name, value: g.count, hint: `${g.count}` }))} />
            : <div className="flex flex-wrap gap-2">{data!.topGenres.map((g) => <span key={g} className="chip capitalize">{g}</span>)}</div>}
        </div>
      )}
    </div>
  );
}
