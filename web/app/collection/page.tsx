'use client';
import { Suspense, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Series } from '@/lib/types';
import { useAuth } from '@/lib/auth';
import { LIST_SORTS, listSortOf, sortList, withListSort, type ListSort } from '@/lib/listSort';
import { SeriesTile } from '@/components/cards';
import { Sheet, useRtl } from '@/components/ui';
import { useToast } from '@/components/Toast';
import { IcChevronLeft, IcChevronRight, IcTrash } from '@/components/icons';
import { t as tr } from '@/lib/i18n';

interface CollectionDetail { id: string; name: string; accent: string | null; items: Series[] }

/**
 * A list's orders (#164) as the Library's sort chips: one definition, in a row on a wide screen and in a sheet on a
 * phone, the way the Library places its own (components/LibraryFilters.tsx).
 */
function SortChips({ value, onPick }: { value: ListSort; onPick: (s: ListSort) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {LIST_SORTS.map((s) => (
        <button key={s.key} type="button" onClick={() => onPick(s.key)} aria-pressed={value === s.key}
          className={`chip text-xs ${value === s.key ? 'chip-active' : ''}`}>{tr(s.label)}</button>
      ))}
    </div>
  );
}

function CollectionInner() {
  const id = useSearchParams().get('id') || '';
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const rtl = useRtl();
  const { user, setSettings } = useAuth();
  // Edit: remove series and move them in the list's own order. It replaced the old hover-only bin on each cover, which
  // a touchscreen could not see and which now sat on the unread badge.
  const [editing, setEditing] = useState(false);
  const [sorting, setSorting] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['collection', id],
    queryFn: () => api<CollectionDetail>(`/api/collections/${id}`),
    enabled: !!id,
  });
  // The list's own order, as the server keeps it.
  const items = useMemo(() => data?.items ?? [], [data]);
  const chosen = listSortOf(user?.settings, id);
  // While editing, the list's own order whatever the chosen sort: it is the order the arrows move.
  const sort: ListSort = editing ? 'manual' : chosen;
  const shown = useMemo(() => sortList(items, sort), [items, sort]);
  const active = LIST_SORTS.find((s) => s.key === chosen) ?? LIST_SORTS[0];

  const inval = () => {
    qc.invalidateQueries({ queryKey: ['collection', id] });
    qc.invalidateQueries({ queryKey: ['collections'] });
  };

  // Kept on the account (lib/listSort.ts says why), applied at once and put back if the server refuses it.
  const pickSort = async (next: ListSort) => {
    setSorting(false);
    if (next === chosen) return;
    const prev = user?.settings?.listSorts;
    const map = withListSort(prev, id, next);
    setSettings({ listSorts: map });
    try { await api('/api/settings', { method: 'PUT', json: { listSorts: map } }); }
    catch { setSettings({ listSorts: prev }); toast(tr('Could not save'), 'error'); }
  };

  const removeItem = async (s: Series) => {
    try { await api(`/api/collections/${id}/items/${s.id}`, { method: 'DELETE' }); inval(); }
    catch { toast('Failed', 'error'); }
  };

  const move = async (s: Series, dir: -1 | 1) => {
    const ids = items.map((x) => x.id);
    const idx = ids.indexOf(s.id);
    const to = idx + dir;
    if (idx < 0 || to < 0 || to >= ids.length) return;
    [ids[idx], ids[to]] = [ids[to], ids[idx]];
    try { await api(`/api/collections/${id}/items`, { method: 'PUT', json: { seriesIds: ids } }); inval(); }
    catch { toast('Failed to reorder', 'error'); }
  };

  return (
    <div className="min-h-screen-d">
      <header className="safe-top px-4 pb-2 lg:px-0 lg:pt-6">
        <div className="flex items-center gap-2">
          <button onClick={() => router.back()} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ink-800/70 text-fog-100">
            <IcChevronLeft width={22} height={22} />
          </button>
          <div className="flex min-w-0 items-center gap-2.5">
            <span aria-hidden className="h-6 w-1.5 shrink-0 rounded-full" style={{ background: data?.accent || 'rgb(var(--accent))' }} />
            <h1 className="truncate font-display text-2xl font-bold lg:text-3xl">{data?.name || '…'}</h1>
          </div>
        </div>
        {(items.length > 0 || editing) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {!editing && (
              <>
                {/* On a phone the chip names the order and opens the sheet; from lg up the chips are simply there. */}
                <button type="button" onClick={() => setSorting(true)} aria-haspopup="dialog"
                  className={`chip text-xs lg:hidden ${chosen !== 'manual' ? 'chip-active' : ''}`}>
                  {tr('Sort by')} · {tr(active.label)}
                </button>
                <div className="hidden items-center gap-3 lg:flex">
                  <span className="text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Sort by')}</span>
                  <SortChips value={chosen} onPick={pickSort} />
                </div>
              </>
            )}
            <button type="button" onClick={() => setEditing((v) => !v)} aria-pressed={editing}
              className={`chip ms-auto text-xs ${editing ? 'chip-active' : ''}`}>
              {editing ? tr('Done') : tr('Edit')}
            </button>
          </div>
        )}
      </header>

      {isLoading ? (
        <div className="grid grid-cols-3 gap-3 px-4 pt-3 sm:grid-cols-4 lg:grid-cols-6 lg:px-0 2xl:grid-cols-8">
          {Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton aspect-[2/3] rounded-2xl" />)}
        </div>
      ) : items.length === 0 ? (
        <p className="px-4 pt-10 text-center text-sm text-fog-500 lg:px-0">{tr('Empty so far — open any series and use “Add to collection”.')}</p>
      ) : (
        // The Library's own tile (#164): the same unread count, NEW mark, favourite and offline marks, from the same
        // per-reader numbers, and the same right-click menu.
        <div className="grid grid-cols-3 gap-x-3 gap-y-5 px-4 pt-3 sm:grid-cols-4 lg:grid-cols-6 lg:px-0 2xl:grid-cols-8">
          {shown.map((s, i) => editing ? (
            <div key={s.id} className="relative">
              {/* The tile as it reads everywhere, held still: in Edit a press is for the keys over it. */}
              <div inert className="pointer-events-none"><SeriesTile series={s} /></div>
              {/* Over the cover alone (its 2:3 box), not the title under it, and above the tile's own marks (z-10): the
                  keys sit in the corners the count and the heart use, and a key under a mark is a key half hidden. */}
              <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex aspect-[2/3] flex-col justify-between p-1.5">
                <div className="flex justify-end">
                  <button type="button" onClick={() => removeItem(s)} aria-label={tr('Remove from collection')}
                    className="pointer-events-auto grid h-8 w-8 place-items-center rounded-full bg-black/70 text-fog-100 backdrop-blur hover:text-white">
                    <IcTrash width={14} height={14} />
                  </button>
                </div>
                {shown.length > 1 && (
                  <div className="flex justify-between">
                    {/* Earlier is toward the start of the line, so in Arabic the pair mirrors. */}
                    <button type="button" onClick={() => move(s, -1)} disabled={i === 0} aria-label={tr('Move earlier')}
                      className="pointer-events-auto grid h-8 w-8 place-items-center rounded-full bg-black/70 text-white backdrop-blur disabled:invisible">
                      {rtl ? <IcChevronRight width={16} height={16} /> : <IcChevronLeft width={16} height={16} />}
                    </button>
                    <button type="button" onClick={() => move(s, 1)} disabled={i === shown.length - 1} aria-label={tr('Move later')}
                      className="pointer-events-auto grid h-8 w-8 place-items-center rounded-full bg-black/70 text-white backdrop-blur disabled:invisible">
                      {rtl ? <IcChevronLeft width={16} height={16} /> : <IcChevronRight width={16} height={16} />}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <SeriesTile key={s.id} series={s} />
          ))}
        </div>
      )}

      {sorting && (
        <Sheet title={tr('Sort by')} onClose={() => setSorting(false)} overBottomNav>
          <div className="pb-2"><SortChips value={chosen} onPick={pickSort} /></div>
        </Sheet>
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
