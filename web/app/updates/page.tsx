'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { Series } from '@/lib/types';
import { relativeTime } from '@/lib/format';
import { Img } from '@/components/ui';
import { useToast } from '@/components/Toast';
import { EmptyState } from '@/components/EmptyState';
import { ART } from '@/lib/art';
import { IcChevronLeft, IcBell, IcCheck } from '@/components/icons';
import { t as tr } from '@/lib/i18n';
import { byExpected, radarText } from '@/lib/radar';

interface UpdateItem { series: Series; newCount: number; latestAt?: string | null }

/**
 * Expected this week (v0.61.0): the series this reader follows -- favourites, and what they read in the last 90 days --
 * whose next chapter the release radar puts within seven days (GET /api/updates/expected, bff lib/releaseRadar.ts),
 * soonest first. Under the new chapters, and under the empty state too: "nothing new yet, but three are due" is the
 * useful sentence on a quiet day. The same cards as the list above; the line under each title is the radar's own
 * ("Next chapter ~Friday · usually Fridays"), and the note under the heading says these are estimates. Hidden when
 * nothing is expected.
 */
function ExpectedThisWeek() {
  const { data } = useQuery({ queryKey: ['updates-expected'], queryFn: () => api<{ content: Series[] }>('/api/updates/expected') });
  const list = [...(data?.content ?? [])].sort(byExpected);
  if (!list.length) return null;
  return (
    <section data-expected className="px-4 pb-10 pt-6 lg:mx-auto lg:max-w-2xl lg:px-0">
      <h2 className="font-display text-lg font-semibold">{tr('Expected this week')}</h2>
      <p className="mb-3 mt-0.5 text-xs text-fog-500">{tr('Estimated from when chapters usually arrive, not promised.')}</p>
      <div className="space-y-3">
        {list.map((series) => (
          <Link key={series.id} href={`/series/?id=${series.id}`} className="card flex items-center gap-3 p-3">
            <div className="h-20 w-14 shrink-0 overflow-hidden rounded-xl border border-ink-700">
              <Img src={img.seriesThumb(series.id)} alt={series.name} className="h-full w-full" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-fog-100">{series.metadata?.title || series.name}</p>
              <p className="mt-0.5 text-xs text-fog-400">{radarText(series.yomi?.radar, { autoUpdate: series.autoUpdate !== false })}</p>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

export default function UpdatesPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, refetch } = useQuery({ queryKey: ['updates'], queryFn: () => api<{ content: UpdateItem[] }>('/api/updates') });
  const items = data?.content ?? [];

  const markAll = async () => {
    await api('/api/updates/seen', { method: 'POST' });
    toast(tr('All caught up'), 'success');
    qc.invalidateQueries({ queryKey: ['home'] });
    refetch();
  };

  return (
    <div className="min-h-screen-d">
      <header className="safe-top flex items-center gap-2 px-4 pb-2 lg:px-0">
        <button onClick={() => router.back()} className="grid h-10 w-10 place-items-center rounded-full bg-ink-800/70 text-fog-100 lg:hidden">
          <IcChevronLeft width={22} height={22} />
        </button>
        <h1 className="font-display text-2xl font-bold lg:text-3xl">{tr('Updates')}</h1>
        {items.length > 0 && (
          <button onClick={markAll} className="ms-auto chip text-xs">
            <IcCheck width={14} height={14} />{tr('Mark all read')}</button>
        )}
      </header>

      {isLoading ? (
        <div className="space-y-3 px-4 pt-3 lg:px-0">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-24 rounded-2xl" />)}
        </div>
      ) : items.length === 0 ? (
        <EmptyState art={ART.emptyUpdates} title={tr('You’re all caught up')}
          sub={tr('Favorite some series and new chapters will appear here as Uchiyomi downloads them.')}
          cta={{ href: '/library', label: tr('Browse library') }} />
      ) : (
        <div className="space-y-3 px-4 pt-3 lg:mx-auto lg:max-w-2xl lg:px-0">
          {items.map(({ series, newCount, latestAt }) => (
            <Link key={series.id} href={`/series/?id=${series.id}`} className="card flex items-center gap-3 p-3">
              <div className="h-20 w-14 shrink-0 overflow-hidden rounded-xl border border-ink-700">
                <Img src={img.seriesThumb(series.id)} alt={series.name} className="h-full w-full" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-fog-100">{series.metadata?.title || series.name}</p>
                <p className="mt-0.5 text-xs text-accent">
                  {newCount === 1 ? tr('+1 new chapter') : tr('+{n} new chapters', { n: newCount })}
                  {latestAt && <span className="text-fog-500"> · {relativeTime(latestAt)}</span>}
                </p>
              </div>
              <span className="grid h-7 min-w-7 place-items-center rounded-full bg-accent px-2 text-xs font-bold text-black">{newCount}</span>
            </Link>
          ))}
        </div>
      )}
      <ExpectedThisWeek />
    </div>
  );
}
