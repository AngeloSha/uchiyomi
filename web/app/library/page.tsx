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
import { Modal } from '@/components/ConfirmDialog';
import { useAuth, canDownload } from '@/lib/auth';
import { AdultToggle, useAdultShown, useLibraries } from '@/components/AdultToggle';
import { LibraryFilters, SORTS, READ_STATES, STATUSES } from '@/components/LibraryFilters';
import { Sheet } from '@/components/ui';
import { t as tr } from '@/lib/i18n';

/** Build the condition tree from the URL. Empty means no condition at all, which needs no user context. */
function conditionFrom(read: string, status: string, genres: string[], lib: string) {
  const all: any[] = [];
  if (lib) all.push({ libraryId: { operator: 'is', value: lib } });
  if (read) all.push({ readStatus: { operator: 'is', value: read } });
  if (status) all.push({ status: { operator: 'is', value: status } });
  for (const g of genres) all.push({ genre: { operator: 'is', value: g } });
  return all.length ? { allOf: all } : undefined;
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
  // Which library, or '' for all of them. This lists only what the viewer may open -- the endpoint filters
  // by their grants -- so the tab row doubles as an honest answer to "what do I actually have access to".
  const lib = params.get('lib') || '';
  const { data: allLibs } = useLibraries();
  const adultOn = useAdultShown();
  // An 18+ library's own tab goes with its contents: leaving it there while the grid it opens is empty is
  // worse than not offering it, and the toggle beside the sorts is what brings both back.
  const libs = useMemo(
    () => (allLibs ?? []).filter((l) => adultOn || !l.adult),
    [allLibs, adultOn],
  );
  const [sheet, setSheet] = useState(false);
  // Select mode. Cleared whenever the filters change, so a selection can never outlive the list it was
  // made from and act on series the user can no longer see.
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [acting, setActing] = useState(false);
  const [moving, setMoving] = useState(false);
  const { isAdmin, user } = useAuth();
  useEffect(() => { setSelecting(false); setPicked(new Set()); }, [read, status, genres.join(','), sortKey, lib]);
  const togglePick = (id: string) =>
    setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // ⚠️ `lib` counts. It used to be left out because it lived in its own tab rail rather than in the sheet,
  // so selecting a library filtered the grid while the badge said nothing was filtered and the "· filtered"
  // hint stayed dark. Now that every way to narrow the shelf is in one panel, every one of them counts.
  const activeCount = (read ? 1 : 0) + (status ? 1 : 0) + genres.length + (lib ? 1 : 0);

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params.toString());
    if (v) next.set(k, v); else next.delete(k);
    router.replace(`/library?${next.toString()}`);
  };

  // Everything `activeCount` counts, cleared. Sort survives because it is not a filter -- clearing it would
  // reorder the shelf as a side effect of a button that says it removes restrictions.
  const clearAll = () => {
    const n = new URLSearchParams();
    if (sortKey) n.set('sort', sortKey);
    router.replace(`/library?${n.toString()}`);
  };

  const condition = useMemo(() => conditionFrom(read, status, genres, lib), [read, status, genres.join(','), lib]);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useInfiniteQuery({
    queryKey: ['library', active.key, read, status, genres.join(','), lib],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api<Page<Series>>('/api/series/search', { json: { page: pageParam, size: 40, sort: active.sort, condition } }),
    getNextPageParam: (last) => (last.last ? undefined : last.number + 1),
  });

  const qc = useQueryClient();
  const toast = useToast();

  /**
   * One series, at random.
   *
   * Inherited from the browse page, which is the only place it lived outside the command palette. Note it
   * asks the server for ONE series rather than sorting the grid randomly: `sortSql` does support a random
   * order, but the grid pages through it and re-shuffles per page. See the note in LibraryFilters.
   */
  const surprise = async () => {
    try {
      const r = await api<{ seriesId: string | null }>('/api/random');
      if (r.seriesId) router.push(`/series/?id=${r.seriesId}`);
      else toast('Nothing to pick from yet', 'error');
    } catch { toast('Could not pick a series', 'error'); }
  };

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
    <div className={`min-h-screen-d ${selecting && picked.size > 0 ? 'pb-40 lg:pb-0' : ''}`}>
      {/* Sidebar beside the grid from lg: up. `min-w-0` on the grid column is load-bearing -- a flex child
          defaults to `min-width:auto`, so without it the grid refuses to shrink and pushes the page
          sideways instead, which is the horizontal-overflow failure layout.mjs exists to catch. */}
      <div className="lg:flex lg:gap-8 xl:gap-10">
        <aside className="hidden shrink-0 lg:block lg:w-56 xl:w-64" aria-label={tr('Filters')}>
          {/* Its own scroller: this holds five sections and up to a hundred genres, which is taller than the
              window. `data-lenis-prevent` because Lenis drives the page and would otherwise eat the wheel. */}
          <div className="sticky top-6 max-h-[calc(100dvh-3rem)] overflow-y-auto pb-8 pt-6" data-lenis-prevent>
            <LibraryFilters
              sort={sortKey} read={read} status={status} genres={genres} lib={lib} libs={libs}
              onSet={setParam}
            />
            {activeCount > 0 && (
              <button onClick={clearAll} className="mt-5 w-full rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-fog-400 hover:text-fog-200">
                {tr('Clear all')}
              </button>
            )}
          </div>
        </aside>

        <div className="min-w-0 flex-1">
      <header className="safe-top sticky top-0 z-30 bg-ink-950/85 px-5 pb-3 backdrop-blur-xl lg:static lg:bg-transparent lg:px-0 lg:pt-6 lg:backdrop-blur-none">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-2xl font-bold tracking-tight lg:text-3xl">{tr('Library')}</h1>
          <div className="flex items-center gap-2">
            {/* The one thing the browse page had that has nowhere else to live. */}
            <button onClick={surprise} title={tr('Surprise me')} aria-label={tr('Surprise me')}
              className="grid h-10 w-10 place-items-center rounded-full border border-ink-700 bg-ink-850/70 text-fog-300 hover:text-fog-100">
              <IcSparkle width={19} height={19} />
            </button>
            {/* Search and Add live in the top bar on a wide screen, so they are phone-only here. */}
            <Link href="/search" className="grid h-10 w-10 place-items-center rounded-full border border-ink-700 bg-ink-850/70 text-fog-300 lg:hidden">
              <IcSearch width={20} height={20} />
            </Link>
            {canDownload(user) && (
              <Link href="/discover" className="grid h-10 w-10 place-items-center rounded-full border border-accent/40 bg-accent-soft text-accent lg:hidden" title={tr('Add new series')}>
                <IcPlus width={20} height={20} />
              </Link>
            )}
          </div>
        </div>
        <p className="mt-0.5 text-xs text-fog-500">
          {total != null && <>{total} series<span className="text-fog-600"> · </span></>}
          {/* Sorting moved into the panel, so the header has to keep saying what it is -- otherwise the
              order of two thousand covers is decided by something with no representation on screen. */}
          {tr('Sorted by {name}', { name: tr(active.label).toLowerCase() })}
          {activeCount > 0 && <span className="text-accent"> · {tr('filtered')}</span>}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* On a wide screen the panel is already open beside the grid, so this button would open a sheet
              duplicating what is visible two inches to the left. */}
          <button onClick={() => setSheet(true)} className={`chip lg:hidden ${activeCount ? 'chip-active' : ''}`} aria-haspopup="dialog">
            {tr('Filters')}{activeCount > 0 ? ` · ${activeCount}` : ''}
          </button>
          {/* A session reveal, not a filter: it is not in the panel because `Clear all` cannot clear it. */}
          <AdultToggle />
          {/* A mode, not a filter, for the same reason. */}
          <button onClick={() => { setSelecting((v) => !v); setPicked(new Set()); }}
            className={`chip whitespace-nowrap ${selecting ? 'chip-active' : ''}`}>
            {selecting ? tr('Done') : tr('Select')}
          </button>
        </div>
        {/* Active filters are always visible, so a short library is never mysterious. */}
        {activeCount > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {lib && (
              <button onClick={() => setParam('lib', '')} className="chip text-xs">
                {libs.find((l) => l.id === lib)?.name || lib} ×
              </button>
            )}
            {read && (
              <button onClick={() => setParam('read', '')} className="chip text-xs">
                {tr(READ_STATES.find((r) => r.key === read)?.label || read)} ×
              </button>
            )}
            {status && (
              <button onClick={() => setParam('status', '')} className="chip text-xs">
                {tr(STATUSES.find((v) => v.key === status)?.label || status)} ×
              </button>
            )}
            {genres.map((g) => (
              <button key={g} onClick={() => setParam('genres', genres.filter((x) => x !== g).join(','))} className="chip text-xs">
                {g} ×
              </button>
            ))}
            <button onClick={clearAll} className="chip text-xs text-fog-500">{tr('Clear all')}</button>
          </div>
        )}
      </header>

      {/* `data-library-grid` is a test hook, not a style. layout.mjs measures fill as the span between the
          leftmost and rightmost painted things, so a sidebar cannot lower it -- and a grid squeezed to a
          third of the window would still score 95%. This attribute is what lets that be measured. */}
      <div data-library-grid className="grid grid-cols-3 gap-x-3 gap-y-5 px-4 pt-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-5 lg:gap-x-4 lg:px-0 xl:grid-cols-6 2xl:grid-cols-7 3xl:grid-cols-8 4xl:grid-cols-10">
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
          {activeCount ? tr('Nothing matches those filters.') : tr('Your library is empty.')}
        </p>
      )}
        </div>
      </div>
      {/* ⚠️ Above the phone nav, not under it. This div renders inside AppShell's `<main class="relative
          z-[1]">` -- its own stacking context -- while <BottomNav> is main's sibling at z-40 in the root
          context, so a `bottom-0` bar here is painted over by the nav whatever z-index it carries, and once
          the chips wrap to a second row the lower ones cannot be tapped. 5.75rem plus the safe-area inset
          is the nav's height (92 px measured at 390 px); from lg up the nav is hidden and the bar
          returns to the bottom. Reintroduce with `bottom-0`: on a 390 px phone the Cancel chip is under
          the nav. */}
      {selecting && picked.size > 0 && (
        <div className="fixed inset-x-0 bottom-[calc(5.75rem+env(safe-area-inset-bottom))] z-40 border-t border-ink-700 bg-ink-950/95 px-4 pb-3 pt-3 backdrop-blur-xl lg:bottom-0 lg:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2">
            <span className="me-auto text-sm font-medium text-fog-100">{picked.size} selected</span>
            <button disabled={acting} onClick={() => bulk('/api/library/bulk/read', { completed: true })} className="chip text-xs disabled:opacity-50">{tr('Mark read')}</button>
            <button disabled={acting} onClick={() => bulk('/api/library/bulk/read', { completed: false })} className="chip text-xs disabled:opacity-50">{tr('Mark unread')}</button>
            <button disabled={acting} onClick={() => bulk('/api/favorites/bulk', { favorite: true })} className="chip text-xs disabled:opacity-50">{tr('Favourite')}</button>
            {isAdmin && <button disabled={acting} onClick={() => setMoving(true)} className="chip text-xs disabled:opacity-50">{tr('Move to library')}</button>}
            <button onClick={() => { setSelecting(false); setPicked(new Set()); }} className="chip text-xs text-fog-500">{tr('Cancel')}</button>
          </div>
        </div>
      )}
      {moving && (
        <MoveToLibrary
          n={picked.size}
          busy={acting}
          onClose={() => setMoving(false)}
          onPick={async (libraryId) => {
            setMoving(false);
            await bulk('/api/admin/series/library', { libraryId });
          }}
        />
      )}
      {/* The same panel, in the app's real Sheet -- not the hand-rolled copy that used to live in this
          file without `role="dialog"`, without Escape-to-close, and without `data-lenis-prevent`, so a
          flick inside it scrolled the grid behind it. `overBottomNav` clears the nav bar, or the last
          genre in the list sits underneath it and cannot be tapped. */}
      {sheet && (
        <Sheet title={tr('Filters')} onClose={() => setSheet(false)} overBottomNav>
          <LibraryFilters
            sort={sortKey} read={read} status={status} genres={genres} lib={lib} libs={libs}
            onSet={setParam}
          />
          <div className="mt-5 flex gap-2">
            {activeCount > 0 && (
              <button onClick={clearAll} className="rounded-lg border border-ink-700 px-3 py-2 text-sm text-fog-400">
                {tr('Clear all')}
              </button>
            )}
            <button onClick={() => setSheet(false)} className="btn-accent flex-1 py-2 text-sm">{tr('Done')}</button>
          </div>
        </Sheet>
      )}
    </div>
    </PullToRefresh>
  );
}

/**
 * Move a selection into a library, or hand it back to the folder rule.
 *
 * Admin-only, and deliberately phrased as filing rather than moving: nothing on disk changes, and the series
 * stays where the scanner found it. Picking a library pins the choice, so a rescan or a newly created library
 * whose path contains these folders will not quietly undo it.
 */
function MoveToLibrary({ n, busy, onClose, onPick }: {
  n: number; busy: boolean; onClose: () => void; onPick: (libraryId: string | null) => void;
}) {
  const { data } = useQuery({
    queryKey: ['admin-libraries'],
    queryFn: () => api<{ content: { id: string; name: string; path: string; age_rating: number | null }[] }>('/api/admin/libraries'),
  });
  return (
    <Modal title={tr('File {n} series', { n })} onClose={onClose}>
      <div className="space-y-1">
        {(data?.content ?? []).map((l) => (
          <button key={l.id} disabled={busy} onClick={() => onPick(l.id)}
            className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-start hover:bg-ink-800/60 disabled:opacity-50">
            <span className="min-w-0">
              <span className="block truncate text-sm text-fog-100">{l.name}</span>
              <span className="block truncate font-mono text-[11px] text-fog-500">{l.path || tr('everything not in another library')}</span>
            </span>
            {l.age_rating != null && <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">{l.age_rating}+</span>}
          </button>
        ))}
        <button disabled={busy} onClick={() => onPick(null)}
          className="mt-2 w-full rounded-lg border border-ink-700 px-2.5 py-2 text-sm text-fog-400 hover:text-fog-200 disabled:opacity-50">
          {tr('Automatic — follow the folder')}
        </button>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-fog-600">{tr('No files move. This only changes which library these series appear in, and it survives the next scan.')}</p>
    </Modal>
  );
}

export default function LibraryPage() {
  return (
    <Suspense fallback={<div className="min-h-screen-d" />}>
      <LibraryInner />
    </Suspense>
  );
}
