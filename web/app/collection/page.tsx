'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { Series } from '@/lib/types';
import { Img } from '@/components/ui';
import { useToast } from '@/components/Toast';
import { IcChevronLeft, IcTrash } from '@/components/icons';
import { t as tr } from '@/lib/i18n';

interface CollectionDetail { id: string; name: string; accent: string | null; items: Series[] }

function CollectionInner() {
  const id = useSearchParams().get('id') || '';
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [reordering, setReordering] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['collection', id],
    queryFn: () => api<CollectionDetail>(`/api/collections/${id}`),
    enabled: !!id,
  });
  const items = data?.items ?? [];

  const inval = () => {
    qc.invalidateQueries({ queryKey: ['collection', id] });
    qc.invalidateQueries({ queryKey: ['collections'] });
  };

  const removeItem = async (s: Series) => {
    try { await api(`/api/collections/${id}/items/${s.id}`, { method: 'DELETE' }); inval(); }
    catch { toast('Failed', 'error'); }
  };

  const move = async (idx: number, dir: -1 | 1) => {
    const to = idx + dir;
    if (to < 0 || to >= items.length) return;
    const ids = items.map((s) => s.id);
    [ids[idx], ids[to]] = [ids[to], ids[idx]];
    try { await api(`/api/collections/${id}/items`, { method: 'PUT', json: { seriesIds: ids } }); inval(); }
    catch { toast('Failed to reorder', 'error'); }
  };

  return (
    <div className="min-h-screen-d">
      <header className="safe-top flex items-center gap-2 px-4 pb-2 lg:px-0 lg:pt-6">
        <button onClick={() => router.back()} className="grid h-10 w-10 place-items-center rounded-full bg-ink-800/70 text-fog-100">
          <IcChevronLeft width={22} height={22} />
        </button>
        <div className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden className="h-6 w-1.5 shrink-0 rounded-full" style={{ background: data?.accent || 'rgb(var(--accent))' }} />
          <h1 className="truncate font-display text-2xl font-bold lg:text-3xl">{data?.name || '…'}</h1>
        </div>
        {items.length > 1 && (
          <button onClick={() => setReordering((r) => !r)} className={`ml-auto chip text-xs ${reordering ? 'chip-active' : ''}`}>
            {reordering ? 'Done' : 'Reorder'}
          </button>
        )}
      </header>

      {isLoading ? (
        <div className="grid grid-cols-3 gap-3 px-4 pt-3 sm:grid-cols-4 lg:grid-cols-6 lg:px-0 2xl:grid-cols-8">
          {Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton aspect-[2/3] rounded-2xl" />)}
        </div>
      ) : items.length === 0 ? (
        <p className="px-4 pt-10 text-center text-sm text-fog-500 lg:px-0">{tr('Empty so far — open any series and use “Add to collection”.')}</p>
      ) : (
        <div className="grid grid-cols-3 gap-3 px-4 pt-3 sm:grid-cols-4 lg:grid-cols-6 lg:px-0 2xl:grid-cols-8">
          {items.map((s, i) => (
            <div key={s.id} className="group relative">
              <button onClick={() => !reordering && router.push(`/series/?id=${s.id}`)} className="block w-full text-start">
                <div className="grad-border relative aspect-[2/3] overflow-hidden rounded-2xl border border-ink-700/60">
                  <Img src={img.seriesThumb(s.id)} alt={s.metadata?.title || s.name} className="h-full w-full" />
                </div>
                <p className="mt-1.5 line-clamp-2 text-xs font-medium leading-tight text-fog-300">{s.metadata?.title || s.name}</p>
              </button>
              {reordering ? (
                <div className="absolute inset-x-1 top-1 flex justify-between">
                  <button onClick={() => move(i, -1)} disabled={i === 0}
                    className="grid h-8 w-8 place-items-center rounded-full bg-black/70 text-white backdrop-blur disabled:opacity-30">←</button>
                  <button onClick={() => move(i, 1)} disabled={i === items.length - 1}
                    className="grid h-8 w-8 place-items-center rounded-full bg-black/70 text-white backdrop-blur disabled:opacity-30">→</button>
                </div>
              ) : (
                <button onClick={() => removeItem(s)} aria-label={tr('Remove from collection')}
                  className="absolute right-1.5 top-1.5 grid h-8 w-8 place-items-center rounded-full bg-black/60 text-fog-300 opacity-0 backdrop-blur transition group-hover:opacity-100">
                  <IcTrash width={14} height={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CollectionPage() {
  return (
    <Suspense fallback={<div className="min-h-screen-d" />}>
      <CollectionInner />
    </Suspense>
  );
}
