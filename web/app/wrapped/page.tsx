'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ART } from '@/lib/art';
import { Wordmark } from '@/components/Brand';
import { IcChevronLeft } from '@/components/icons';
import { t as tr } from '@/lib/i18n';

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
  byMonth: number[];
  busiestDow: number;
}
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

export default function WrappedPage() {
  const router = useRouter();
  const year = new Date().getFullYear();
  const { data } = useQuery({ queryKey: ['wrapped', year], queryFn: () => api<Wrapped>('/api/wrapped?year=' + year) });
  const maxM = Math.max(1, ...(data?.byMonth ?? [0]));

  return (
    <div className="min-h-screen-d">
      <header className="safe-top flex items-center gap-2 px-4 pb-2 lg:px-0">
        <button onClick={() => router.back()} className="grid h-10 w-10 place-items-center rounded-full bg-ink-800/70 text-fog-100">
          <IcChevronLeft width={22} height={22} />
        </button>
        <h1 className="font-display text-2xl font-bold">Wrapped {year}</h1>
      </header>

      <div className="relative mx-4 mt-2 overflow-hidden rounded-4xl border border-ink-700/60 p-6 shadow-lift lg:mx-auto lg:max-w-2xl">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={ART.wrapped} alt="" className="absolute inset-0 h-full w-full object-cover opacity-70" />
        <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/72 to-ink-950/30" />
        <div className="relative">
          <Wordmark className="text-xl" />
          <p className="mt-6 text-sm text-fog-300">{tr('This year you read')}</p>
          <p className="font-brand text-7xl font-bold text-accent drop-shadow-[0_2px_24px_rgba(124,92,255,0.4)]"><CountUp to={data?.chapters ?? 0} /></p>
          <p className="text-lg text-fog-100">chapters across {data?.series ?? 0} series</p>
          {data != null && data.chapters > 0 && (
            <p className="mt-4 text-sm text-fog-300">{tr('Your power day was')}<span className="text-fog-100">{DOW[data.busiestDow]}</span></p>
          )}
        </div>
      </div>

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

      {(data?.topSeries?.length ?? 0) > 0 && (
        <div className="px-5 pt-6 lg:mx-auto lg:max-w-2xl lg:px-0">
          <p className="mb-2 text-xs font-medium text-fog-400">{tr('Top series')}</p>
          <div className="card divide-y divide-ink-800/70 overflow-hidden">
            {data!.topSeries.map((s, i) => (
              <Link key={s.id} href={`/series/?id=${s.id}`} className="flex items-center gap-3 px-4 py-3">
                <span className="w-5 font-display text-lg font-bold text-accent">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-fog-100">{s.title}</span>
                <span className="text-xs text-fog-500">{s.count} ch</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {(data?.topGenres?.length ?? 0) > 0 && (
        <div className="px-5 pb-12 pt-6 lg:mx-auto lg:max-w-2xl lg:px-0">
          <p className="mb-2 text-xs font-medium text-fog-400">{tr('Your genres')}</p>
          <div className="flex flex-wrap gap-2">{data!.topGenres.map((g) => <span key={g} className="chip capitalize">{g}</span>)}</div>
        </div>
      )}
    </div>
  );
}
