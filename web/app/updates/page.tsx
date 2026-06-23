'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { Series } from '@/lib/types';
import { Img } from '@/components/ui';
import { useToast } from '@/components/Toast';
import { EmptyState } from '@/components/EmptyState';
import { ART } from '@/lib/art';
import { IcChevronLeft, IcBell, IcCheck } from '@/components/icons';

interface UpdateItem { series: Series; newCount: number }

export default function UpdatesPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, refetch } = useQuery({ queryKey: ['updates'], queryFn: () => api<{ content: UpdateItem[] }>('/api/updates') });
  const items = data?.content ?? [];

  const markAll = async () => {
    await api('/api/updates/seen', { method: 'POST' });
    toast('All caught up', 'success');
    qc.invalidateQueries({ queryKey: ['home'] });
    refetch();
  };

  return (
    <div className="min-h-screen-d">
      <header className="safe-top flex items-center gap-2 px-4 pb-2 lg:px-0">
        <button onClick={() => router.back()} className="grid h-10 w-10 place-items-center rounded-full bg-ink-800/70 text-fog-100 lg:hidden">
          <IcChevronLeft width={22} height={22} />
        </button>
        <h1 className="font-display text-2xl font-bold lg:text-3xl">Updates</h1>
        {items.length > 0 && (
          <button onClick={markAll} className="ml-auto chip text-xs">
            <IcCheck width={14} height={14} /> Mark all read
          </button>
        )}
      </header>

      {isLoading ? (
        <div className="space-y-3 px-4 pt-3 lg:px-0">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-24 rounded-2xl" />)}
        </div>
      ) : items.length === 0 ? (
        <EmptyState art={ART.emptyUpdates} title="You're all caught up"
          sub="Favorite some series and new chapters will appear here as Koryomi downloads them."
          cta={{ href: '/library', label: 'Browse library' }} />
      ) : (
        <div className="space-y-3 px-4 pt-3 lg:mx-auto lg:max-w-2xl lg:px-0">
          {items.map(({ series, newCount }) => (
            <Link key={series.id} href={`/series/?id=${series.id}`} className="card flex items-center gap-3 p-3">
              <div className="h-20 w-14 shrink-0 overflow-hidden rounded-xl border border-ink-700">
                <Img src={img.seriesThumb(series.id)} alt={series.name} className="h-full w-full" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-fog-100">{series.metadata?.title || series.name}</p>
                <p className="mt-0.5 text-xs text-accent">+{newCount} new chapter{newCount > 1 ? 's' : ''}</p>
              </div>
              <span className="grid h-7 min-w-7 place-items-center rounded-full bg-accent px-2 text-xs font-bold text-black">{newCount}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
