'use client';
import { Suspense, useEffect, useMemo, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Page, Series } from '@/lib/types';
import { SeriesTile } from '@/components/cards';
import { IcSearch, IcSparkle, IcPlus } from '@/components/icons';
import { PullToRefresh } from '@/components/PullToRefresh';
import { triggerRefresh } from '@/lib/refresh';
import { useToast } from '@/components/Toast';
import { t as tr } from '@/lib/i18n';

const SORTS = [
  { key: 'updated', label: 'Updated', sort: 'lastModified,desc' },
  { key: 'new', label: 'Newest', sort: 'createdDate,desc' },
  { key: 'az', label: 'A–Z', sort: 'metadata.titleSort,asc' },
  // per-user unread is now expressible server-side, so the label can say what it does
  { key: 'unread', label: 'Most unread', sort: 'unread,desc' },
];

const READ_STATES = [
  { key: 'UNREAD', label: 'Not started' },
  { key: 'IN_PROGRESS', label: 'Reading' },
  { key: 'READ', label: 'Finished' },
];
const STATUSES = ['ONGOING', 'COMPLETED', 'HIATUS', 'CANCELLED'];

/** Build the condition tree from the URL. Empty means no condition at all, which needs no user context. */
function conditionFrom(read: string, status: string, genres: string[]) {
  const all: any[] = [];
  if (read) all.push({ readStatus: { operator: 'is', value: read } });
  if (status) all.push({ status: { operator: 'is', value: status } });
  for (const g of genres) all.push({ genre: { operator: 'is', value: g } });
  return all.length ? { allOf: all } : undefined;
}

/**
 * The filter sheet.
 *
 * Genres come from /api/genres, which reads the same overridable column the filter queries, so an edited
 * genre appears here as soon as it is saved.
 */
function FilterSheet({ read, status, genres, onSet, onClose }: {
  read: string; status: string; genres: string[];
  onSet: (k: string, v: string) => void;
  onClose: () => void;
}) {
  const { data: all } = useQuery({
    queryKey: ['genres'],
    queryFn: () => api<{ content: string[] }>('/api/genres').then((r) => r.content ?? []),
    staleTime: 10 * 60 * 1000,
  });
  const toggleGenre = (g: string) =>
    onSet('genres', (genres.includes(g) ? genres.filter((x) => x !== g) : [...genres, g]).join(','));

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-950/70 backdrop-blur-sm sm:items-center" onClick={onClose}>
      <div
        className="glass max-h-[80vh] w-full overflow-y-auto rounded-t-2xl border border-ink-700 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:max-w-md sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-semibold leading-tight">{tr('Filters')}</h3>
          <button onClick={onClose} className="shrink-0 text-fog-500 hover:text-fog-200">✕</button>
        </div>

        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Read state')}</p>
        <div className="mb-4 flex flex-wrap gap-1.5">
          {READ_STATES.map((r) => (
            <button key={r.key} onClick={() => onSet('read', read === r.key ? '' : r.key)}
              className={`chip text-xs ${read === r.key ? 'chip-active' : ''}`}>{tr(r.label)}</button>
          ))}
        </div>

        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Status')}</p>
        <div className="mb-4 flex flex-wrap gap-1.5">
          {STATUSES.map((v) => (
            <button key={v} onClick={() => onSet('status', status === v ? '' : v)}
              className={`chip text-xs ${status === v ? 'chip-active' : ''}`}>{v.charAt(0) + v.slice(1).toLowerCase()}</button>
          ))}
        </div>

        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-fog-500">
          Genres{genres.length > 1 && <span className="ms-1 normal-case tracking-normal text-fog-500">(all of them)</span>}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {(all ?? []).map((g) => (
            <button key={g} onClick={() => toggleGenre(g)}
              className={`chip text-xs ${genres.includes(g) ? 'chip-active' : ''}`}>{g}</button>
          ))}
          {!all && <p className="text-xs text-fog-500">{tr('Loading…')}</p>}
        </div>

        <button onClick={onClose} className="btn-accent mt-5 w-full py-2 text-sm">{tr('Done')}</button>
      </div>
    </div>
  );
}

function LibraryInner() {
  const params = useSearchParams();
  const router = useRouter();
  const sortKey = params.get('sort') || 'updated';
  const active = useMemo(() => SORTS.find((s) => s.key === sortKey) || SORTS[0], [sortKey]);

  // Filters live in the URL so they survive the back button and can be shared, and they are part of the
  // query key so changing one refetches from page 0 rather than appending to a stale list.
  const read = params.get('read') || '';
  const status = params.get('status') || '';
  const genres = (params.get('genres') || '').split(',').filter(Boolean);
  const [sheet, setSheet] = useState(false);
  // Select mode. Cleared whenever the filters change, so a selection can never outlive the list it was
  // made from and act on series the user can no longer see.
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [acting, setActing] = useState(false);
  useEffect(() => { setSelecting(false); setPicked(new Set()); }, [read, status, genres.join(','), sortKey]);
  const togglePick = (id: string) =>
    setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const activeCount = (read ? 1 : 0) + (status ? 1 : 0) + genres.length;

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params.toString());
    if (v) next.set(k, v); else next.delete(k);
    router.replace(`/library?${next.toString()}`);
  };

  const condition = useMemo(() => conditionFrom(read, status, genres), [read, status, genres.join(',')]);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useInfiniteQuery({
    queryKey: ['library', active.key, read, status, genres.join(',')],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api<Page<Series>>('/api/series/search', { json: { page: pageParam, size: 40, sort: active.sort, condition } }),
    getNextPageParam: (last) => (last.last ? undefined : last.number + 1),
  });

  const qc = useQueryClient();
  const toast = useToast();
  const onRefresh = async () => {
    await triggerRefresh();
    await new Promise((r) => setTimeout(r, 1500));
    qc.invalidateQueries({ queryKey: ['library'] });
  };

  const bulk = async (path: string, extra: Record<string, unknown>) => {
    setActing(true);
    try {
      const r = await api<{ applied: number; skipped: { id: string }[] }>(path, {
        json: { seriesIds: [...picked], ...extra },
      });
      // Say what was skipped rather than silently applying to fewer than were selected.
      toast(r.skipped.length ? `${r.applied} updated, ${r.skipped.length} no longer exist` : `${r.applied} updated`, 'success');
      setSelecting(false);
      setPicked(new Set());
      qc.invalidateQueries({ queryKey: ['library'] });
      qc.invalidateQueries({ queryKey: ['home'] });
    } catch { toast('Could not apply that', 'error'); }
    setActing(false);
  };

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (e) => {
        if (e[0].isIntersecting && hasNextPage && !isFetchingNextPage) fetchNextPage();
      },
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const items = data?.pages.flatMap((p) => p.content) ?? [];
  const total = data?.pages[0]?.totalElements;

  return (
    <PullToRefresh onRefresh={onRefresh}>
    <div className="min-h-screen-d">
      <header className="safe-top sticky top-0 z-30 bg-ink-950/85 px-5 pb-3 backdrop-blur-xl lg:static lg:bg-transparent lg:px-0 lg:pt-6 lg:backdrop-blur-none">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-2xl font-bold tracking-tight lg:text-3xl">{tr('Library')}</h1>
          <div className="flex items-center gap-2 lg:hidden">
            <Link href="/browse" className="grid h-10 w-10 place-items-center rounded-full border border-ink-700 bg-ink-850/70 text-fog-300">
              <IcSparkle width={19} height={19} />
            </Link>
            <Link href="/search" className="grid h-10 w-10 place-items-center rounded-full border border-ink-700 bg-ink-850/70 text-fog-300">
              <IcSearch width={20} height={20} />
            </Link>
            <Link href="/discover" className="grid h-10 w-10 place-items-center rounded-full border border-accent/40 bg-accent-soft text-accent" title={tr('Add new series')}>
              <IcPlus width={20} height={20} />
            </Link>
          </div>
        </div>
        {total != null && (
          <p className="mt-0.5 text-xs text-fog-500">
            {total} series{activeCount > 0 && <span className="text-accent"> · filtered</span>}
          </p>
        )}
        <div className="hide-scrollbar -mx-5 mt-3 flex gap-2 overflow-x-auto px-5 lg:mx-0 lg:px-0">
          {SORTS.map((s) => (
            <button
              key={s.key}
              onClick={() => setParam('sort', s.key)}
              className={`chip whitespace-nowrap ${s.key === active.key ? 'chip-active' : ''}`}
            >
              {tr(s.label)}
            </button>
          ))}
          <button onClick={() => setSheet(true)} className={`chip whitespace-nowrap ${activeCount ? 'chip-active' : ''}`}>
            {tr('Filters')}{activeCount > 0 ? ` · ${activeCount}` : ''}
          </button>
          <button onClick={() => { setSelecting((v) => !v); setPicked(new Set()); }}
            className={`chip whitespace-nowrap ${selecting ? 'chip-active' : ''}`}>
            {selecting ? tr('Done') : tr('Select')}
          </button>
        </div>
        {/* Active filters are always visible, so a short library is never mysterious. */}
        {activeCount > 0 && (
          <div className="-mx-5 mt-2 flex flex-wrap gap-1.5 px-5 lg:mx-0 lg:px-0">
            {read && (
              <button onClick={() => setParam('read', '')} className="chip text-xs">
                {READ_STATES.find((r) => r.key === read)?.label || read} ×
              </button>
            )}
            {status && (
              <button onClick={() => setParam('status', '')} className="chip text-xs">
                {status.charAt(0) + status.slice(1).toLowerCase()} ×
              </button>
            )}
            {genres.map((g) => (
              <button key={g} onClick={() => setParam('genres', genres.filter((x) => x !== g).join(','))} className="chip text-xs">
                {g} ×
              </button>
            ))}
            <button
              onClick={() => { const n = new URLSearchParams(); if (sortKey) n.set('sort', sortKey); router.replace(`/library?${n.toString()}`); }}
              className="chip text-xs text-fog-500"
            >{tr('Clear all')}</button>
          </div>
        )}
      </header>

      <div className="grid grid-cols-3 gap-x-3 gap-y-5 px-4 pt-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 lg:gap-x-4 lg:px-0 xl:grid-cols-8 2xl:grid-cols-9 min-[1800px]:grid-cols-10">
        {isLoading
          ? Array.from({ length: 14 }).map((_, i) => <div key={i} className="skeleton aspect-[2/3] rounded-2xl" />)
          : items.map((s, i) => (
              <SeriesTile key={s.id} series={s} eager={i < 12}
                selectable={selecting} selected={picked.has(s.id)} onToggle={() => togglePick(s.id)} />
            ))}
      </div>

      <div ref={sentinel} className="h-16" />
      {isFetchingNextPage && <p className="pb-6 text-center text-xs text-fog-500">{tr('Loading more…')}</p>}
      {!isLoading && !items.length && (
        <p className="px-5 pb-10 text-center text-sm text-fog-500">
          {activeCount ? 'Nothing matches those filters.' : 'Your library is empty.'}
        </p>
      )}
      {selecting && picked.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-700 bg-ink-950/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2">
            <span className="me-auto text-sm font-medium text-fog-100">{picked.size} selected</span>
            <button disabled={acting} onClick={() => bulk('/api/library/bulk/read', { completed: true })} className="chip text-xs disabled:opacity-50">{tr('Mark read')}</button>
            <button disabled={acting} onClick={() => bulk('/api/library/bulk/read', { completed: false })} className="chip text-xs disabled:opacity-50">{tr('Mark unread')}</button>
            <button disabled={acting} onClick={() => bulk('/api/favorites/bulk', { favorite: true })} className="chip text-xs disabled:opacity-50">{tr('Favourite')}</button>
            <button onClick={() => { setSelecting(false); setPicked(new Set()); }} className="chip text-xs text-fog-500">{tr('Cancel')}</button>
          </div>
        </div>
      )}
      {sheet && (
        <FilterSheet
          read={read} status={status} genres={genres}
          onSet={setParam}
          onClose={() => setSheet(false)}
        />
      )}
    </div>
    </PullToRefresh>
  );
}

export default function LibraryPage() {
  return (
    <Suspense fallback={<div className="min-h-screen-d" />}>
      <LibraryInner />
    </Suspense>
  );
}
