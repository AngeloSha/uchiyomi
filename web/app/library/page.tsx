'use client';
import { Suspense, useCallback, useEffect, useMemo, useRef } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useSearchParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { Page, Series } from '@/lib/types';
import { SeriesTile } from '@/components/cards';
import { IcSearch, IcSparkle, IcPlus, IcImport } from '@/components/icons';
import { PullToRefresh } from '@/components/PullToRefresh';
import { triggerRefresh } from '@/lib/refresh';
import { useToast } from '@/components/Toast';
import { Modal, ConfirmDialog, msgOf } from '@/components/ConfirmDialog';
import { LibraryFolders } from '@/components/LibraryFolders';
import { foldersOf } from '@/lib/libraryFolders';
import { useAuth, canDownload } from '@/lib/auth';
import { AdultToggle, useAdultFilterConfigured, useAdultShown, useLibraries } from '@/components/AdultToggle';
import { LibraryFilters, NO_SOURCE, SORTS, READ_STATES, STATUSES, useLibrarySources } from '@/components/LibraryFilters';
import { Sheet } from '@/components/ui';
import { useArchiveEnqueue } from '@/components/ArchiveQueue';
import { t as tr } from '@/lib/i18n';
import { selectedText } from '@/lib/counted';
import { followBulkNewest, BULK_NEWEST_POLL_MS, type BulkNewestStatus } from '@/lib/bulkNewest';
import { useLayer } from '@/lib/layers';
import { useReduceEffects } from '@/lib/effects';
import { readView, type LibraryView } from '@/lib/libraryView';
import { kickDownloads, useDownloadsRing } from '@/lib/useServerDownloads';
import { findRefusal } from '@/lib/useFindRun';
import { FindStartDialog } from '@/components/FindSources';
import { ProgressRing } from '@/components/ProgressRing';
import { ServerDownloadsView } from '@/components/ServerDownloadsView';
import { EmptyState } from '@/components/EmptyState';
import { LibraryStart } from '@/components/LibraryStart';
import { ART } from '@/lib/art';
import { BulkChapterDeleteRunDialog } from '@/components/BulkChapterDeleteRun';
import {
  BULK_CHAPTER_DELETE_POLL_MS,
  bulkChapterDeleteFinished,
  forgetBulkChapterDeleteRun,
  rememberBulkChapterDeleteRun,
  rememberedBulkChapterDeleteRun,
  startedBulkChapterDeleteRun,
  type BulkChapterDeleteRun,
} from '@/lib/bulkChapterDelete';

/** Build the condition tree from the URL. Empty means no condition at all, which needs no user context. */
function conditionFrom(read: string, status: string, genres: string[], lib: string, src = '', anysrc = '') {
  const all: any[] = [];
  if (lib) all.push({ libraryId: { operator: 'is', value: lib } });
  // The two source filters (bff ownedCatalog condSql): the source a series was added from, and any source
  // it reads from -- added from it, or following it as a fallback. Main source's "No source" (#149) is a condition of its
  // own, never `mainSource` with the sentinel: an older server would answer that with an empty grid, not a 400.
  if (src === NO_SOURCE) all.push({ hasMainSource: { operator: 'isFalse' } });
  else if (src) all.push({ mainSource: { operator: 'is', value: src } });
  if (anysrc) all.push({ anySource: { operator: 'is', value: anysrc } });
  if (read) all.push({ readStatus: { operator: 'is', value: read } });
  if (status) all.push({ status: { operator: 'is', value: status } });
  for (const g of genres) all.push({ genre: { operator: 'is', value: g } });
  return all.length ? { allOf: all } : undefined;
}

function LibraryInner() {
  const params = useSearchParams();
  const router = useRouter();
  const { isAdmin, user, status: authStatus, setSettings } = useAuth();
  const validSort = (v: unknown): v is string => typeof v === 'string' && SORTS.some((s) => s.key === v);
  const urlSort = params.get('sort');
  // A sort in a shared URL controls this visit only.  With none (or old/junk input), the account's explicit
  // default wins; clicking a sort below is the only thing that changes that default.
  const sortKey = validSort(urlSort) ? urlSort : validSort(user?.settings?.librarySort) ? user!.settings.librarySort : 'updated';
  const active = useMemo(() => SORTS.find((s) => s.key === sortKey) || SORTS[0], [sortKey]);

  // Filters live in the URL so they survive the back button and can be shared, and they are part of the
  // query key so changing one refetches from page 0 rather than appending to a stale list.
  const read = params.get('read') || '';
  const status = params.get('status') || '';
  const genres = (params.get('genres') || '').split(',').filter(Boolean);
  // Which library, or '' for all of them. This lists only what the viewer may open -- the endpoint filters
  // by their grants -- so the tab row doubles as an honest answer to "what do I actually have access to".
  const lib = params.get('lib') || '';
  const src = params.get('src') || '';
  const anysrc = params.get('anysrc') || '';
  const { data: libSources } = useLibrarySources();
  const sourceName = (id: string) => (id === NO_SOURCE ? tr('No source') : libSources?.sources.find((x) => x.id === id)?.name || id);
  const { data: allLibs } = useLibraries();
  // The 18+ filter can hide series by genre on an install with no 18+ library; the reveal must still render.
  const adultFilter = useAdultFilterConfigured();
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
  const [removing, setRemoving] = useState(false);
  // Delete chapters (the admin's, a row of More): its confirm, and whether the selection is also unmonitored.
  const [deletingChapters, setDeletingChapters] = useState(false);
  const [alsoPause, setAlsoPause] = useState(true);
  // The server owns this destructive run once POST answers 202. Keep following it independently of the
  // confirmation/select state: closing the progress window or reloading must never make an active deletion
  // look safe to submit again.
  const [deleteRun, setDeleteRun] = useState<BulkChapterDeleteRun | null>(null);
  const [deleteRunOpen, setDeleteRunOpen] = useState(false);
  const [deleteCancelling, setDeleteCancelling] = useState(false);
  // The phone's overflow for the two admin actions (see the bar below).
  const [more, setMore] = useState(false);
  // v0.51.0: Find other sources asks first whether to follow automatically or review first.
  const [finding, setFinding] = useState(false);
  // The Fetch newest job as last polled, while it runs: what the bar's label counts up with.
  const [fetching, setFetching] = useState<{ done: number; total: number } | null>(null);
  // Set while a Fetch newest run is being followed: calling it stops the polling (the bar's Cancel chip).
  const stopFollowing = useRef<(() => void) | null>(null);
  // The select bar on the notices' layer stack (lib/layers.ts), measured: its chips wrap to two rows on a
  // phone, and a notice has to rise above whichever height it has.
  const toolbarRef = useRef<HTMLDivElement>(null);
  useLayer('toolbar', selecting && picked.size > 0, { ref: toolbarRef });
  // Series | Downloads (v0.49.0): which of the page's two views, from the URL on every render -- a link to
  // `?view=downloads` while already on /library (the desktop's header button, the palette) does not remount
  // the page, so a value read once would not follow it. Downloads only for a viewer who may download.
  const mayDownload = authStatus === 'authed' && canDownload(user);
  const view: LibraryView = readView(params.get('view'), mayDownload);
  useEffect(() => { setSelecting(false); setPicked(new Set()); }, [read, status, genres.join(','), sortKey, lib, src, anysrc, view]);
  const togglePick = (id: string) =>
    setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // ⚠️ `lib` counts. It used to be left out because it lived in its own tab rail rather than in the sheet,
  // so selecting a library filtered the grid while the badge said nothing was filtered and the "· filtered"
  // hint stayed dark. Now that every way to narrow the shelf is in one panel, every one of them counts.
  const activeCount = (read ? 1 : 0) + (status ? 1 : 0) + genres.length + (lib ? 1 : 0) + (src ? 1 : 0) + (anysrc ? 1 : 0);

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params.toString());
    if (v) next.set(k, v); else next.delete(k);
    // `folder` points one arrival at a tile in Downloads ("Open in library" on an add still downloading its
    // first chapter). Any change made on the page has moved on from it.
    next.delete('folder');
    router.replace(`/library?${next.toString()}`);
    if (k === 'sort' && validSort(v)) {
      const previous = user?.settings?.librarySort;
      setSettings({ librarySort: v });
      void api('/api/settings', { method: 'PUT', json: { librarySort: v } }).catch(() => {
        setSettings({ librarySort: previous });
        toast(tr('Could not save'), 'error');
      });
    }
  };

  // Everything `activeCount` counts, cleared. Sort survives because it is not a filter -- clearing it would
  // reorder the shelf as a side effect of a button that says it removes restrictions.
  const clearAll = () => {
    const n = new URLSearchParams();
    if (sortKey) n.set('sort', sortKey);
    router.replace(`/library?${n.toString()}`);
  };

  const condition = useMemo(() => conditionFrom(read, status, genres, lib, src, anysrc), [read, status, genres.join(','), lib, src, anysrc]);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useInfiniteQuery({
    queryKey: ['library', active.key, read, status, genres.join(','), lib, src, anysrc],
    // The Downloads view shows no grid: forty covers fetched to sit unseen behind it would be the wrong work.
    enabled: view === 'series',
    initialPageParam: 0,
    // One card per work (v0.52.0, #72): the language editions of a title are one card -- the edition this reader read
    // last, else the original -- whose caption names the work's languages (SeriesTile). Reintroduce by dropping the
    // flag: "the Library asks for one card per work" in library.test.ts fails, and Blue Lock sits on the shelf twice.
    queryFn: ({ pageParam }) =>
      api<Page<Series>>('/api/series/search', { json: { page: pageParam, size: 40, sort: active.sort, condition, collapseEditions: true } }),
    getNextPageParam: (last) => (last.last ? undefined : last.number + 1),
  });

  const qc = useQueryClient();
  const toast = useToast();

  const attachDeleteRun = useCallback((run: BulkChapterDeleteRun, open = true) => {
    rememberBulkChapterDeleteRun(run.id);
    setDeleteRun(run);
    if (open) setDeleteRunOpen(true);
  }, []);

  // Rejoin the exact run this browser started. If the POST response itself was lost before its id could be
  // stored, the no-id GET is also useful: only an ACTIVE latest run is adopted here, never yesterday's result.
  useEffect(() => {
    if (!isAdmin || authStatus !== 'authed') return;
    let alive = true;
    const remembered = rememberedBulkChapterDeleteRun();
    const path = remembered
      ? `/api/admin/series/bulk/chapters/delete?runId=${encodeURIComponent(remembered)}`
      : '/api/admin/series/bulk/chapters/delete';
    void api<{ run: BulkChapterDeleteRun | null }>(path).then(({ run }) => {
      if (!alive || !run || (!remembered && run.status !== 'running')) return;
      attachDeleteRun(run);
    }).catch((e) => {
      if (remembered && e instanceof ApiError && (e.status === 400 || e.status === 404)) {
        forgetBulkChapterDeleteRun(remembered);
      }
    });
    return () => { alive = false; };
  }, [attachDeleteRun, authStatus, isAdmin]);

  // A missed status read is not a failed deletion. The persisted server run stays authoritative and this
  // poll keeps retrying, including while its dialog is closed. Completion refreshes both Library and Home.
  useEffect(() => {
    if (!deleteRun || deleteRun.status !== 'running') return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let again = true;
      try {
        const response = await api<{ run: BulkChapterDeleteRun | null }>(
          `/api/admin/series/bulk/chapters/delete?runId=${encodeURIComponent(deleteRun.id)}`,
        );
        if (!alive || !response.run) return;
        setDeleteRun(response.run);
        again = response.run.status === 'running';
        if (!again) {
          qc.invalidateQueries({ queryKey: ['library'] });
          qc.invalidateQueries({ queryKey: ['home'] });
        }
      } catch {
        // Network/proxy failures leave the durable job running; retry instead of offering a duplicate POST.
      }
      if (alive && again) timer = setTimeout(poll, BULK_CHAPTER_DELETE_POLL_MS);
    };
    timer = setTimeout(poll, 50);
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [deleteRun?.id, deleteRun?.status, qc]);

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
      else toast(tr('Nothing to pick from yet'), 'error');
    } catch { toast(tr('Could not pick a series'), 'error'); }
  };

  const onRefresh = async () => {
    await triggerRefresh();
    await new Promise((r) => setTimeout(r, 1500));
    qc.invalidateQueries({ queryKey: ['library'] });
  };

  /** Leave select mode and show the shelf as it now is. */
  const settle = () => {
    setSelecting(false);
    setPicked(new Set());
    qc.invalidateQueries({ queryKey: ['library'] });
    qc.invalidateQueries({ queryKey: ['home'] });
  };

  const bulk = async (path: string, extra: Record<string, unknown>) => {
    setActing(true);
    try {
      const r = await api<{ applied: number; skipped: { id: string }[] }>(path, {
        json: { seriesIds: [...picked], ...extra },
      });
      // Say what was skipped rather than silently applying to fewer than were selected. Each count its own pair of
      // keys, and its own words: "1 series is no longer…" names what disappeared in every language, and the
      // Tasks line's "{n} updated" counts extensions.
      const updated = r.applied === 1 ? tr('1 series updated') : tr('{n} series updated', { n: r.applied });
      const gone = r.skipped.length === 1 ? tr('1 series is no longer in the library')
        : tr('{n} series are no longer in the library', { n: r.skipped.length });
      toast(r.skipped.length ? `${updated} · ${gone}` : updated, 'success');
      settle();
    } catch { toast(tr('Could not apply that'), 'error'); }
    setActing(false);
  };

  /**
   * Fetch the newest listed release for every chosen series that does not have it yet.
   *
   * A detached job on the server (POST starts it, GET reports it), not one request per series: the loop
   * downloads and can run for minutes over a big selection, and a request held open that long dies at the
   * proxy while the server keeps going. So this starts it, then reads the status every 2 s until `running`
   * drops, the way the series page waits on a source job. The server answers 409 while one is already
   * running, from this tab or another; its sentence is the toast. `acting` holds for the whole run, so the
   * chip cannot be tapped into a 409 of its own, and the bar's label counts the job up meanwhile. Cancel
   * alone stays live: it stops the polling and leaves select mode, and the run completes server-side.
   *
   * The loop itself is lib/bulkNewest.ts. Only a `finished` run is summarised: a `lost` one (three polls
   * unanswered) may hold a partial status that still said running, and summarising that reports a run
   * still going as done. A cancelled one says nothing at all.
   */
  const fetchNewest = async () => {
    setActing(true);
    try {
      const start = await api<{ ok: true; total: number }>('/api/library/bulk/newest', { method: 'POST', json: { ids: [...picked] } });
      setFetching({ done: 0, total: start.total });
      let cancelled = false;
      let wake: (() => void) | null = null;
      // Cancel flips the flag AND ends the current wait, so `acting` clears at once rather than up to 2 s
      // later, when the bar might already be showing a new selection with every chip greyed out.
      stopFollowing.current = () => { cancelled = true; wake?.(); };
      const end = await followBulkNewest({
        poll: () => api<BulkNewestStatus>('/api/library/bulk/newest'),
        onProgress: (st) => setFetching({ done: st.done, total: st.total }),
        wait: () => new Promise<void>((r) => { wake = r; setTimeout(r, BULK_NEWEST_POLL_MS); }),
        cancelled: () => cancelled,
      });
      stopFollowing.current = null;
      if (end.outcome === 'lost') { toast(tr('Lost track of the fetch. Check the library in a moment.'), 'error'); }
      else if (end.outcome === 'finished') {
        const last = end.status!;
        const n = (o: BulkNewestStatus['results'][number]['outcome']) => last.results.filter((r) => r.outcome === o).length;
        const [got, same, skipped, failed] = [n('downloaded'), n('up_to_date'), n('skipped'), n('failed')];
        const parts: string[] = [];
        if (got) parts.push(got === 1 ? tr('Fetched 1 chapter') : tr('Fetched {n} chapters', { n: got }));
        if (same) parts.push(same === 1 ? tr('1 up to date') : tr('{n} up to date', { n: same }));
        if (skipped) parts.push(skipped === 1 ? tr('1 skipped') : tr('{n} skipped', { n: skipped }));
        if (failed) parts.push(failed === 1 ? tr('1 failed') : tr('{n} failed', { n: failed }));
        toast(parts.length ? parts.join(' · ') : tr('Nothing to fetch'), failed && !got ? 'error' : 'success');
      }
      // Cancel already left select mode; settling here would wipe a selection made since.
      if (end.outcome !== 'cancelled') settle();
    } catch (e) { toast(msgOf(e, tr('Could not start the fetch')), 'error'); }
    stopFollowing.current = null;
    setFetching(null);
    setActing(false);
  };

  /**
   * Remove the selection from the library: the series page's "Remove from library", once per series,
   * and nothing more. Hide only -- the server route never touches a file, and the dialog says so in the
   * series page's words. A series the server would not hide (merged away, already hidden, gone) is
   * counted as skipped rather than failing the batch. When NOTHING was hidden the toast says so in error
   * tone and the selection stays: "Removed 0 series · 1 skipped" in success tone, with the bar gone as if
   * something had happened, is what a selection of merged-away rows used to get.
   */
  const removeSelected = async () => {
    setActing(true);
    try {
      const r = await api<{ ok: true; hidden: number; skipped: { id: string; reason: string }[] }>('/api/admin/series/bulk/hide', { json: { ids: [...picked] } });
      setRemoving(false);
      if (r.hidden === 0) {
        toast(r.skipped.length === 1 ? tr('Nothing removed · 1 skipped') : tr('Nothing removed · {n} skipped', { n: r.skipped.length }), 'error');
      } else {
        const parts = [r.hidden === 1 ? tr('Removed 1 series') : tr('Removed {n} series', { n: r.hidden })];
        if (r.skipped.length) parts.push(r.skipped.length === 1 ? tr('1 skipped') : tr('{n} skipped', { n: r.skipped.length }));
        toast(parts.join(' · '), 'success');
        settle();
      }
    } catch (e) { toast(msgOf(e, tr('Could not remove those')), 'error'); }
    setActing(false);
  };

  /**
   * Monitor / Unmonitor the selection: each series' "Auto-update new chapters" (bff POST
   * /api/admin/series/bulk/auto-update). Unmonitored, nothing unattended searches for or downloads its new chapters --
   * the sweep, the nightly repair, Fix everything, the slow archive -- while Check now and Fetch on its page still work.
   */
  const monitorSelected = async (on: boolean) => {
    setActing(true);
    try {
      const r = await api<{ ok: true; applied: number; skipped: { id: string; reason: string }[] }>('/api/admin/series/bulk/auto-update', {
        json: { seriesIds: [...picked], autoUpdate: on },
      });
      const parts = [on
        ? (r.applied === 1 ? tr('Monitored 1 series') : tr('Monitored {n} series', { n: r.applied }))
        : (r.applied === 1 ? tr('Unmonitored 1 series') : tr('Unmonitored {n} series', { n: r.applied }))];
      if (r.skipped.length) parts.push(r.skipped.length === 1 ? tr('1 skipped') : tr('{n} skipped', { n: r.skipped.length }));
      toast(parts.join(' · '), r.applied ? 'success' : 'error');
      if (r.applied) settle();
    } catch (e) { toast(msgOf(e, tr('Could not change monitoring')), 'error'); }
    setActing(false);
  };

  /**
   * Start the durable chapter cleanup. POST only CLAIMS a persisted server run; GET follows it. That split matters for
   * a large selection: a reverse proxy can time out, the browser can reload, or this progress window can be closed
   * without turning an unknown destructive request into a tempting second attempt. If even the 202 response is lost,
   * the latest run is adopted only when its time and total match this submission.
   */
  const deleteChaptersSelected = async () => {
    setActing(true);
    const began = Date.now();
    const total = new Set(picked).size;
    try {
      const r = await api<{ ok: true; runId: string; total: number }>(
        '/api/admin/series/bulk/chapters/delete', {
          method: 'POST',
          json: { seriesIds: [...picked], pause: alsoPause },
        });
      attachDeleteRun(startedBulkChapterDeleteRun(r.runId, r.total, alsoPause));
      setDeletingChapters(false);
      settle();
    } catch (e) {
      // A 502/504 can hide a successful 202. Read the just-created row before saying the start failed; matching both
      // its total and its start window keeps an older cleanup from being mistaken for this one.
      const recovered = await api<{ run: BulkChapterDeleteRun | null }>(
        '/api/admin/series/bulk/chapters/delete',
      ).then((r) => r.run, () => null);
      const startedAt = recovered ? Date.parse(recovered.startedAt) : 0;
      if (recovered && recovered.total === total && startedAt >= began - 15_000) {
        attachDeleteRun(recovered);
        setDeletingChapters(false);
        settle();
      } else {
        toast(msgOf(e, tr('Could not start the cleanup')), 'error');
      }
    }
    setActing(false);
  };

  const cancelDeleteRun = async () => {
    if (!deleteRun || deleteRun.status !== 'running' || deleteRun.cancelRequested) return;
    setDeleteCancelling(true);
    try {
      await api('/api/admin/series/bulk/chapters/delete/cancel', {
        method: 'POST', json: { runId: deleteRun.id },
      });
      setDeleteRun((run) => run?.id === deleteRun.id ? { ...run, cancelRequested: true } : run);
    } catch (e) {
      toast(msgOf(e, tr('Could not stop the cleanup')), 'error');
    }
    setDeleteCancelling(false);
  };

  const closeDeleteRun = () => {
    setDeleteRunOpen(false);
    if (deleteRun && bulkChapterDeleteFinished(deleteRun)) {
      forgetBulkChapterDeleteRun(deleteRun.id);
      setDeleteRun(null);
    }
  };

  /**
   * Queue the selection for the slow archive (#117): each series' rest fetched a chapter at a time over days,
   * never in a burst. The server works out what is missing and says it per series; the notice sums it up
   * ("12 series queued for the slow archive · 3 series had nothing older to fetch"). Library -> Downloads shows them.
   */
  const archiveEnqueue = useArchiveEnqueue();
  const archiveSelected = async () => {
    setActing(true);
    const r = await archiveEnqueue([...picked]);
    if (r) settle();
    setActing(false);
  };

  /**
   * Look for other sources for the selection (v0.49.1): ONE background run on the server -- 1.5 s between series,
   * pausing for a chapter sweep, a repair or the daily check -- that follows a source only where the title and the
   * chapter numbers match. Minutes or hours for a big selection, so nothing here follows it: the notice says where it
   * shows (Library -> Downloads, Server tasks, with its results), and select mode ends as for any bulk action. Another
   * run going (409, one at a time server-wide), nothing the server may search for (400 `empty_scope`) or more than 500
   * series (400 `bad_request`) is said, and the selection stays. The idea is @TIGamingTV's (PR #119). `review`: review
   * first (v0.51.0) -- the same run, which follows nothing and keeps its matches for the admin to confirm.
   */
  const findSelected = async (review: boolean) => {
    setActing(true);
    try {
      const r = await api<{ runId: string; total: number }>('/api/admin/sources/find', { method: 'POST', json: { seriesIds: [...picked], ...(review ? { review } : {}) } });
      const n = r?.total ?? picked.size;
      toast(n === 1 ? tr('Looking for other sources for 1 series… Library → Downloads shows how it goes.')
        : tr('Looking for other sources for {n} series… Library → Downloads shows how it goes.', { n }), 'info', { busy: true });
      void kickDownloads(qc);
      settle();
    } catch (e) { toast(findRefusal(e), 'error'); }
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
    // `view`: the sentinel is only in the DOM in the series view, so coming back to it must observe it again.
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, view]);

  const items = data?.pages.flatMap((p) => p.content) ?? [];
  const total = data?.pages[0]?.totalElements;

  const series = view === 'series';
  return (
    <PullToRefresh onRefresh={series ? onRefresh : () => kickDownloads(qc)}>
    <div className={`min-h-screen-d ${selecting && picked.size > 0 ? 'pb-40 lg:pb-0' : ''}`}>
      {/* Sidebar beside the grid from lg: up. `min-w-0` on the grid column is load-bearing -- a flex child
          defaults to `min-width:auto`, so without it the grid refuses to shrink and pushes the page
          sideways instead, which is the horizontal-overflow failure layout.mjs exists to catch. The
          Downloads view has no filters to show, so it takes the whole width. */}
      <div className="lg:flex lg:gap-8 xl:gap-10">
        {series && <aside className="hidden shrink-0 lg:block lg:w-56 xl:w-64" aria-label={tr('Filters')}>
          {/* Its own scroller: this holds five sections and up to a hundred genres, which is taller than the
              window. `data-lenis-prevent` because Lenis drives the page and would otherwise eat the wheel. */}
          <div className="sticky top-6 max-h-[calc(100dvh-3rem)] overflow-y-auto pb-8 pt-6" data-lenis-prevent>
            <LibraryFilters
              sort={sortKey} read={read} status={status} genres={genres} lib={lib} libs={libs} mainSrc={src} anySrc={anysrc}
              onSet={setParam}
            />
            {activeCount > 0 && (
              <button onClick={clearAll} className="mt-5 w-full rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-fog-400 hover:text-fog-200">
                {tr('Clear all')}
              </button>
            )}
          </div>
        </aside>}

        <div className="min-w-0 flex-1">
      <header className="safe-top sticky top-0 z-30 bg-ink-950/85 px-5 pb-3 backdrop-blur-xl lg:static lg:bg-transparent lg:px-0 lg:pt-6 lg:backdrop-blur-none">
        {/* The title gives way before the keys do: with the admin's import a fourth round key, "Bibliothèque" and
            "Библиотека" pushed the row 25-29 px past a 320 px screen. */}
        <div className="flex items-center justify-between gap-3">
          <h1 className="min-w-0 truncate font-display text-2xl font-bold tracking-tight lg:text-3xl">{tr('Library')}</h1>
          <div className="flex shrink-0 items-center gap-2">
            {/* v0.55.4 (#158): the import, for an admin, where "+" and the top bar's Discover add series -- it was four
                taps deep in Admin → Sources. A labelled key on a wide screen; on a phone a round key among the others. */}
            {isAdmin && (
              <Link href="/admin/import/" data-library-import className="btn-key hidden lg:inline-flex">
                <IcImport width={15} height={15} aria-hidden />{tr('Import a list')}
              </Link>
            )}
            {/* The one thing the browse page had that has nowhere else to live. */}
            <button onClick={surprise} title={tr('Surprise me')} aria-label={tr('Surprise me')}
              className="grid h-10 w-10 place-items-center rounded-full border border-ink-700 bg-ink-850/70 text-fog-300 hover:text-fog-100">
              <IcSparkle width={19} height={19} />
            </button>
            {/* Search and Add live in the top bar on a wide screen, so they are phone-only here. */}
            <Link href="/search" className="grid h-10 w-10 place-items-center rounded-full border border-ink-700 bg-ink-850/70 text-fog-300 lg:hidden">
              <IcSearch width={20} height={20} />
            </Link>
            {isAdmin && (
              <Link href="/admin/import/" data-library-import title={tr('Import a list')} aria-label={tr('Import a list')}
                className="grid h-10 w-10 place-items-center rounded-full border border-ink-700 bg-ink-850/70 text-fog-300 lg:hidden">
                <IcImport width={19} height={19} />
              </Link>
            )}
            {canDownload(user) && (
              <Link href="/discover" className="grid h-10 w-10 place-items-center rounded-full border border-accent/40 bg-accent-soft text-accent lg:hidden" title={tr('Add new series')}>
                <IcPlus width={20} height={20} />
              </Link>
            )}
          </div>
        </div>
        {mayDownload && <ViewSwitch view={view} onView={(v) => setParam('view', v === 'series' ? '' : v)} />}
        {series && <>
        <p className={`${mayDownload ? 'mt-2' : 'mt-0.5'} text-xs text-fog-500`}>
          {total != null && <>{total === 1 ? tr('1 series') : tr('{n} series', { n: total })}<span className="text-fog-600"> · </span></>}
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
          <AdultToggle alsoWhen={adultFilter} />
          {/* A mode, not a filter, for the same reason. */}
          <button onClick={() => { setSelecting((v) => !v); setPicked(new Set()); }}
            className={`chip whitespace-nowrap ${selecting ? 'chip-active' : ''}`}>
            {selecting ? tr('Done') : tr('Select')}
          </button>
          {/* Selects what is LOADED, not the whole filtered library: the grid is an infinite scroll over a
              paged search, and silently sweeping two thousand series into a pick would surprise more than
              the loaded-pages boundary the count beside it makes visible. Scroll further, tap again. */}
          {selecting && (
            <button onClick={() => setPicked(new Set(items.map((s) => s.id)))} className="chip whitespace-nowrap">
              {tr('Select all')}
            </button>
          )}
        </div>
        {/* Active filters are always visible, so a short library is never mysterious. */}
        {activeCount > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {lib && (
              <button onClick={() => setParam('lib', '')} className="chip text-xs">
                {libs.find((l) => l.id === lib)?.name || lib} ×
              </button>
            )}
            {src && (
              <button onClick={() => setParam('src', '')} className="chip text-xs">
                {tr('Main: {name}', { name: sourceName(src) })} ×
              </button>
            )}
            {anysrc && (
              <button onClick={() => setParam('anysrc', '')} className="chip text-xs">
                {tr('Any: {name}', { name: sourceName(anysrc) })} ×
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
        </>}
      </header>

      {/* Closing the detail window never loses the server-owned job. This small, persistent row is its way back; the
          id also survives a full reload in localStorage and is checked against the persisted admin run. */}
      {deleteRun && !deleteRunOpen && (
        <div className="px-4 pt-3 lg:px-0">
          <button type="button" onClick={() => setDeleteRunOpen(true)} data-open-bulk-delete-run
            className="flex w-full items-center gap-3 rounded-xl border border-ink-700 bg-ink-900/45 px-3 py-2 text-start hover:border-ink-600">
            <ProgressRing progress={deleteRun.total ? deleteRun.done / deleteRun.total : 0} size="row"
              label={tr('Delete chapters')} valueText={tr('{done} of {total}', { done: deleteRun.done, total: deleteRun.total })} />
            <span className="min-w-0 flex-1 text-sm text-fog-200">
              {tr('Delete chapters')} <span className="text-fog-500">·</span>{' '}
              {deleteRun.status === 'running'
                ? (deleteRun.cancelRequested ? tr('Stopping…') : tr('Running'))
                : deleteRun.status === 'done' ? tr('Done')
                  : deleteRun.status === 'cancelled' ? tr('Cancelled')
                    : deleteRun.status === 'interrupted' ? tr('Interrupted') : tr('Failed')}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-fog-400" dir="ltr">
              {tr('{done} of {total}', { done: deleteRun.done, total: deleteRun.total })}
            </span>
          </button>
        </div>
      )}

      {!series && <ServerDownloadsView focusFolder={params.get('folder')} />}

      {/* `data-library-grid` is a test hook, not a style. layout.mjs measures fill as the span between the
          leftmost and rightmost painted things, so a sidebar cannot lower it -- and a grid squeezed to a
          third of the window would still score 95%. This attribute is what lets that be measured. */}
      {series && <>
      <div data-library-grid className="grid grid-cols-3 gap-x-3 gap-y-5 px-4 pt-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-5 lg:gap-x-4 lg:px-0 xl:grid-cols-6 2xl:grid-cols-7 3xl:grid-cols-8 4xl:grid-cols-10">
        {isLoading
          ? Array.from({ length: 14 }).map((_, i) => <div key={i} className="skeleton aspect-[2/3] rounded-2xl" />)
          : items.map((s, i) => (
              <SeriesTile key={s.id} series={s} eager={i < 12}
                selectable={selecting} selected={picked.has(s.id)} onToggle={() => togglePick(s.id)} />
            ))}
      </div>

      {!isLoading && !items.length && activeCount > 0 && (
        <p className="px-5 pb-10 pt-6 text-center text-sm text-fog-500">{tr('Nothing matches those filters.')}</p>
      )}
      {/* v0.55.4 (#158): an empty library says how to fill it -- import one (admins) or find series in Discover (whoever
          may add them) -- where it said "Your library is empty." and nothing else. Empty for THIS viewer, with nothing
          filtered: their 18+ reveal, their library access and a folder not scanned yet all count, and an answer that
          has not come (or failed) is not "empty". */}
      {!isLoading && total === 0 && !activeCount && (
        <EmptyState art={ART.emptyLibrary} title={tr('Your library is empty.')}>
          <LibraryStart />
        </EmptyState>
      )}

      <div ref={sentinel} className="h-16" />
      {isFetchingNextPage && <p className="pb-6 text-center text-xs text-fog-500">{tr('Loading more…')}</p>}
      </>}
        </div>
      </div>
      {/* ⚠️ Above the phone nav, not under it. This div renders inside AppShell's `<main class="relative
          z-[1]">` -- its own stacking context -- while <BottomNav> is main's sibling at z-40 in the root
          context, so a `bottom-0` bar here is painted over by the nav whatever z-index it carries, and once
          the chips wrap to a second row the lower ones cannot be tapped. 5.75rem plus the safe-area inset
          is the nav's height (92 px measured at 390 px); from lg up the nav is hidden and the bar
          returns to the bottom. Reintroduce with `bottom-0`: on a 390 px phone the Cancel chip is under
          the nav. */}
      {series && selecting && picked.size > 0 && (
        <div ref={toolbarRef} className="fixed inset-x-0 bottom-[calc(5.75rem+env(safe-area-inset-bottom))] z-40 border-t border-ink-700 bg-ink-950/95 px-4 pb-3 pt-3 backdrop-blur-xl lg:bottom-0 lg:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {/* ⚠️ Two rows at 390 px, no more: a third row covers a third of the grid. Seven chips plus the
              count do not fit in two, so on a phone the admin actions live behind `More` (a Sheet). (The bar's
              bottom padding was `pb-8` until v0.49.0, clearance for the floating downloads pill, which is gone.)
              "Archive slowly" (#117) is a key from lg up and a row of More on a phone -- which is why More is
              there for anyone who may download, not only admins.
              ⚠️ v0.49.1: the admin actions -- Move to library, Remove from library and Find other sources -- are
              behind More at EVERY width, so More stays for admins from lg up. Measured with the app's CSS and
              fonts (240 selected): Find other sources as a ninth key needed 1081 px, two rows in English at 1024
              AND 1280 px (the row is capped at 1024), where eight took 940 of 992; with the three behind More it
              is one row, 735 px in English and 822 in German, where German took two rows before. */}
          <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2 lg:max-w-5xl">
            <span className="me-auto text-sm font-medium text-fog-100">
              {fetching ? tr('Fetching {done} of {total}…', { done: fetching.done, total: fetching.total }) : selectedText(picked.size)}
            </span>
            <button disabled={acting} onClick={() => bulk('/api/library/bulk/read', { completed: true })} className="chip text-xs disabled:opacity-50">{tr('Mark read')}</button>
            <button disabled={acting} onClick={() => bulk('/api/library/bulk/read', { completed: false })} className="chip text-xs disabled:opacity-50">{tr('Mark unread')}</button>
            <button disabled={acting} onClick={() => bulk('/api/favorites/bulk', { favorite: true })} className="chip text-xs disabled:opacity-50">{tr('Favourite')}</button>
            {/* Server-side fetch, so it follows the same permission as the Add button and the series
                page's Fetch: a member who may not download does not see it. */}
            {canDownload(user) && <button disabled={acting} onClick={fetchNewest} className="chip text-xs disabled:opacity-50">{tr('Fetch newest')}</button>}
            {canDownload(user) && <button disabled={acting} onClick={archiveSelected} className="btn-key hidden lg:inline-flex">{tr('Archive slowly')}</button>}
            {(isAdmin || canDownload(user)) && <button disabled={acting} onClick={() => setMore(true)} className={`chip text-xs disabled:opacity-50 ${isAdmin ? '' : 'lg:hidden'}`} aria-haspopup="dialog">{tr('More')}</button>}
            {/* Live during a Fetch newest run, unlike the other chips: a 500-series run is minutes of pacing plus
                downloads, and a bar frozen for all of it left navigating away as the only way out. Cancel stops
                the polling and leaves select mode; the run completes server-side. Reintroduce with a plain
                `disabled={acting}`: "Cancel stays live while a Fetch newest run is followed" in library.test.ts. */}
            <button disabled={acting && !fetching} onClick={() => { stopFollowing.current?.(); setSelecting(false); setPicked(new Set()); }} className="chip text-xs text-fog-500 disabled:opacity-50">{tr('Cancel')}</button>
          </div>
        </div>
      )}
      {/* ⚠️ The Sheet (z-60) paints over a Modal (z-50), so each row closes the sheet BEFORE it opens its
          dialog; opened the other way round the dialog is underneath and cannot be tapped. */}
      {more && (
        <Sheet title={selectedText(picked.size)} onClose={() => setMore(false)} overBottomNav>
          {/* `pb-2`: the sheet's nav clearance is 4 px short of the nav's measured height (see the series
              page), and the last row here would otherwise end 3 px under it. */}
          <div className="space-y-1 pb-2">
            {/* From lg up Archive slowly is a key in the bar, and More is only there for the admin rows below. */}
            {canDownload(user) && (
              <button onClick={() => { setMore(false); void archiveSelected(); }}
                className="block w-full rounded-lg px-2.5 py-2.5 text-start text-sm text-fog-100 hover:bg-ink-800/60 lg:hidden">
                {tr('Archive slowly')}
              </button>
            )}
            {isAdmin && (
              <>
                <button onClick={() => { setMore(false); setMoving(true); }}
                  className="block w-full rounded-lg px-2.5 py-2.5 text-start text-sm text-fog-100 hover:bg-ink-800/60">
                  {tr('Move to library')}
                </button>
                <button onClick={() => { setMore(false); setFinding(true); }} data-find-selected
                  className="block w-full rounded-lg px-2.5 py-2.5 text-start text-sm text-fog-100 hover:bg-ink-800/60">
                  {tr('Find other sources')}
                </button>
                {/* Monitoring is "Auto-update new chapters" (Edit details → New chapters) for the whole selection. */}
                <button onClick={() => { setMore(false); void monitorSelected(true); }} data-monitor-selected
                  className="block w-full rounded-lg px-2.5 py-2.5 text-start text-sm text-fog-100 hover:bg-ink-800/60">
                  {tr('Monitor')}
                </button>
                <button onClick={() => { setMore(false); void monitorSelected(false); }} data-unmonitor-selected
                  className="block w-full rounded-lg px-2.5 py-2.5 text-start text-sm text-fog-100 hover:bg-ink-800/60">
                  {tr('Unmonitor')}
                </button>
                <button onClick={() => { setMore(false); setAlsoPause(true); setDeletingChapters(true); }} data-delete-chapters-selected
                  className="block w-full rounded-lg px-2.5 py-2.5 text-start text-sm text-rose-300 hover:bg-ink-800/60">
                  {tr('Delete chapters')}
                </button>
                <button onClick={() => { setMore(false); setRemoving(true); }}
                  className="block w-full rounded-lg px-2.5 py-2.5 text-start text-sm text-rose-300 hover:bg-ink-800/60">
                  {tr('Remove from library')}
                </button>
              </>
            )}
          </div>
        </Sheet>
      )}
      {finding && <FindStartDialog onClose={() => setFinding(false)} onStart={(review) => { setFinding(false); void findSelected(review); }} />}
      {removing && (
        <ConfirmDialog
          title={picked.size === 1 ? tr('Remove 1 series from the library?') : tr('Remove {n} series from the library?', { n: picked.size })}
          danger
          busy={acting}
          confirmLabel={tr('Remove')}
          body={
            <>
              <p><strong className="text-fog-100">{tr('No files are deleted.')}</strong> {tr('The chapters stay exactly where they are on disk, and nothing in your library folder is touched.')}</p>
              <p className="mt-2">{tr("Everyone's reading progress, history, favourites and ratings are kept, so you can put them back at any time from Admin → Library.")}</p>
            </>
          }
          onConfirm={removeSelected}
          onClose={() => setRemoving(false)}
        />
      )}
      {deletingChapters && (
        <ConfirmDialog
          title={picked.size === 1 ? tr('Delete the downloaded chapters of 1 series?') : tr('Delete the downloaded chapters of {n} series?', { n: picked.size })}
          danger
          busy={acting}
          confirmLabel={tr('Delete chapters')}
          body={
            <>
              <p>{tr('Every chapter Uchiyomi downloaded is deleted from the server, except each series’ cover chapter, so the covers stay. Files in a library you built by hand, and bookmarked chapters, are left alone.')}</p>
              <p className="mt-2">{tr('The chapters stay listed and everyone keeps their reading history. Fetch again on the series page brings a chapter back.')}</p>
              <p className="mt-2 font-medium text-amber-300">{tr('Deleting a chapter being read can lose its reading position.')}</p>
              <label className="mt-3 flex items-start gap-2 text-sm text-fog-200">
                <input type="checkbox" className="mt-0.5" checked={alsoPause} onChange={(e) => setAlsoPause(e.target.checked)} data-also-pause />
                <span>
                  {tr('Also stop updates for these series')}
                  <span className="block text-xs text-fog-500">{tr('Otherwise the next check downloads their newest chapters again.')}</span>
                </span>
              </label>
            </>
          }
          onConfirm={deleteChaptersSelected}
          onClose={() => setDeletingChapters(false)}
        />
      )}
      {deleteRun && deleteRunOpen && (
        <BulkChapterDeleteRunDialog
          run={deleteRun}
          cancelling={deleteCancelling}
          onCancel={() => { void cancelDeleteRun(); }}
          onClose={closeDeleteRun}
        />
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
            sort={sortKey} read={read} status={status} genres={genres} lib={lib} libs={libs} mainSrc={src} anySrc={anysrc}
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
 * Series | Downloads (v0.49.0): two text tabs under the Library title, an accent underline sliding between
 * them. Its own row rather than the title itself: "Téléchargements" in the display font beside three 40 px
 * buttons does not fit a 390 px phone, and the same place in both views means nothing jumps on a switch. No
 * capsule: the owner's "no more pills" -- the settings' Segmented control is one. Downloads wears the Library
 * ring's state in small: a 16 px ring and the count of series coming in.
 *
 * A switch, not a navigation: it replaces the URL (the page's one `setParam`), so Back leaves the Library
 * rather than walking back through the tabs. The underline slides only when motion is welcome.
 */
function ViewSwitch({ view, onView }: { view: LibraryView; onView: (v: LibraryView) => void }) {
  const ring = useDownloadsRing();
  const plain = useReduceEffects();
  const still = useReducedMotion();
  const tabs: [LibraryView, string][] = [['series', tr('Series')], ['downloads', tr('Downloads')]];
  return (
    <div role="tablist" aria-label={tr('Library')} className="mt-2 flex items-end gap-6 border-b border-ink-800/80">
      {tabs.map(([v, label]) => {
        const on = v === view;
        return (
          <button key={v} type="button" role="tab" aria-selected={on} data-view-tab={v} onClick={() => { if (!on) onView(v); }}
            className={`relative -mb-px flex items-center gap-1.5 pb-2 pt-1 text-sm font-semibold transition-colors ${on ? 'text-fog-50' : 'text-fog-500 hover:text-fog-200'}`}>
            {label}
            {v === 'downloads' && ring.show && ring.progress !== 'idle' && (
              <ProgressRing progress={ring.progress} size={16} tone={ring.slow ? 'amber' : 'accent'} static={ring.slow} />
            )}
            {v === 'downloads' && ring.count > 0 && (
              <span className="rounded-[4px] bg-ink-800 px-[3px] text-[10px] font-bold leading-[14px] tabular-nums text-accent">{ring.count}</span>
            )}
            {v === 'downloads' && ring.attention && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-400" />}
            {on && (
              <motion.span layoutId="libview" aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 rounded-sm bg-accent"
                transition={plain || still ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 40 }} />
            )}
          </button>
        );
      })}
    </div>
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
    queryFn: () => api<{ content: { id: string; name: string; path: string; paths?: string[]; age_rating: number | null }[] }>('/api/admin/libraries'),
  });
  return (
    <Modal title={tr('File {n} series', { n })} onClose={onClose}>
      <div className="space-y-1">
        {(data?.content ?? []).map((l) => (
          <button key={l.id} disabled={busy} onClick={() => onPick(l.id)}
            className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-start hover:bg-ink-800/60 disabled:opacity-50">
            <span className="min-w-0">
              <span className="block truncate text-sm text-fog-100">{l.name}</span>
              <LibraryFolders paths={foldersOf(l)} className="text-[11px] text-fog-500" />
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
