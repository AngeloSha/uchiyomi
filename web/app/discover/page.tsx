'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ART } from '@/lib/art';
import { relativeTime } from '@/lib/format';
import { useAuth, canDownload } from '@/lib/auth';
import { t as tr } from '@/lib/i18n';
import { isDesktop } from '@/lib/desktop';
import { EmptyState } from '@/components/EmptyState';
import { ProgressBar, Reveal } from '@/components/ui';
import { SourceCard, SourceItem } from '@/components/cards';
import { ScrollRail } from '@/components/ScrollRail';
import { DiscoverHero, TrendingCard, Trending } from '@/components/DiscoverHero';
import { SourcePicker, SourceLatest, Src, SrcState } from '@/components/SourcePicker';
import { aloneEmpty, budgetForMode, type ListMode } from '@/lib/sourceGroups';
import { normTitle } from '@/lib/normTitle';
import { foldByTitle, type WallProvider } from '@/lib/wall';
import { AddSeriesDialog, AddSeed } from '@/components/AddSeriesDialog';
import { AdultToggle, useAdultShown } from '@/components/AdultToggle';
import { IcChevronLeft, IcSearch, IcSparkle, IcX } from '@/components/icons';
import type { AutoFollow } from '@/lib/types';
import { forStrip } from '@/lib/jobs';

interface Job {
  folder: string; title: string; total: number; done: number; status: string; reason?: string;
  /** When it ended, and whether a Cancel ended it (#82): such a job is `done` but did not fetch everything. */
  finishedAt?: number; cancelled?: boolean;
  /** The add-time auto-follow (v0.36.0) riding on the card; the only job a nothing-yet add leaves behind. */
  autoFollow?: AutoFollow;
}
interface SearchGroup { title: string; coverUrl?: string; inLibrary?: boolean; updatedAt?: string; providers: { source: string; name: string; sourceId: string; title: string; coverUrl?: string }[] }
/** One source's line in a search answer (v0.40.0): what it did with the term, or that it is still being asked. */
interface SearchSourceLine { id: string; name: string; state: 'ok' | 'empty' | 'timeout' | 'failed' | 'skipped' | 'pending'; ms?: number; why?: 'disabled' | 'cooldown' }
/**
 * `/api/sources/search-all`. `content` is the grouped hits, shaped exactly as before v0.40.0; the rest is the
 * progress the server has reported since, and is optional so an older server's answer still renders.
 */
interface SearchAnswer { content: SearchGroup[]; sources?: SearchSourceLine[]; pending?: number; asked?: number }

/**
 * How long the server may hold the FIRST answer to a search while the sources are still being asked. The
 * server clamps it to its own ceiling; six seconds is the owner's "a few seconds", and a Cloudflare source
 * that needs longer fills in afterwards. Every later poll asks for a short wait only: by then the server
 * answers from the entry it is still filling, so the poll is a cheap join, not a second search.
 */
const SEARCH_FIRST_WAIT_MS = 6000;
const SEARCH_POLL_WAIT_MS = 1500;
/** How often to poll while the answer says some sources are still pending. */
const SEARCH_POLL_MS = 1500;
/** How many pending sources the progress line names before "and N more". */
const SEARCH_NAMES_SHOWN = 3;

/**
 * How many titles the hero rotates through.
 *
 * At 5s a slide this is a 50-second loop. Going much higher means the last few slides are seen by nobody,
 * and every slide is one more proxied cover fetch.
 */
const HERO_SLIDES = 10;

/**
 * Discover, rebuilt around what people actually do here.
 *
 * This is the only page that adds new series from the internet, and it was a bare search box on black with a
 * ragged grid hanging off it. Production said something the design did not: in 48 hours there were 32 calls
 * to "newest from a source" and ZERO searches. The thing buried behind a label, a 45-option dropdown and a
 * separate button was the entire point of the page, and the search box that dominated it was unused.
 *
 * So: a wall of what your sources published, led by a full-bleed hero built from AniList key art that
 * `/api/discover/trending` has been returning all along and this page rendered as a 144px thumbnail. The 45
 * sources are ranked and the best few are fetched at once. Search survives as a field, with a
 * way back out that it never had.
 *
 * `/api/sources/latest` takes up to fifteen seconds, so the six sources are fetched independently and the
 * wall fills in as each lands, in arrival order. Nothing already on screen ever moves: only mangadex
 * populates `updatedAt`, so "newest across six sources" is not a sortable quantity and pretending otherwise
 * would reflow tiles under a reading thumb.
 */
export default function DiscoverPage() {
  const qc = useQueryClient();
  const { user, isAdmin } = useAuth();

  // Not fired at all for an account that may not add series: every route behind this page answers 403 for
  // them, and a query whose only possible outcome is a refusal is noise in the console and in the log.
  const mayAdd = canDownload(user);

  const { data: sourcesData } = useQuery({
    queryKey: ['sources'],
    // `hiddenAdult` is how many adult providers the "Show 18+" reveal is keeping out of `content` right now
    // (v0.42.0). Optional, so an older server's answer still renders; 0 for an age-capped account, which
    // never had those sources to hide. It is the only reason the reveal chip appears on this page.
    queryFn: () => api<{ content: Src[]; hiddenAdult?: number }>('/api/sources'),
    enabled: mayAdd,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const sources = useMemo(() => sourcesData?.content ?? [], [sourcesData]);
  /**
   * Whether to offer the reveal chip here at all.
   *
   * ⚠️ The `adultOn ||` is load-bearing, not defensive. With the reveal ON the server hides nothing, so
   * `hiddenAdult` is 0 — and a chip that vanishes the moment it is pressed strands the session with no way
   * back. `AdultToggle` still renders on its own wherever an 18+ library exists.
   */
  const adultOn = useAdultShown();
  const showAdultChip = adultOn || (sourcesData?.hiddenAdult ?? 0) > 0;

  const { data: trending } = useQuery({
    // NOT ['trending'] -- that key belongs to /api/trending, which is what the household is reading and is a
    // Series[]. This is /api/discover/trending, which is AniList and carries genres, banner and score. They
    // shared a key, so arriving here from the home page handed this the wrong shape out of the cache and the
    // hero threw on `genres.slice`. A direct page load was fine, which is why it looked intermittent.
    queryKey: ['discover-trending'],
    queryFn: () => api<{ content: Trending[] }>('/api/discover/trending'),
    enabled: mayAdd,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  // ---------------------------------------------------------------- the wall
  const [mode, setMode] = useState<'newest' | 'search'>('newest');
  /**
   * Which listing the wall shows, and which single source (if any) is shown alone.
   *
   * `listMode` is NOT the same axis as `mode` above: that one is browse-versus-search, this one is the
   * sort within browsing.
   */
  const [listMode, setListMode] = useState<ListMode>('newest');
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState('');
  // What was SUBMITTED, as opposed to `q`, which is whatever is in the field. The search is keyed on this, so
  // typing never fires a request and a term is searched exactly once per five minutes however it is reached.
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(1);
  const [byId, setById] = useState<Record<string, SourceItem[]>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [states, setStates] = useState<Record<string, SrcState>>({});
  const [seed, setSeed] = useState<AddSeed | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  // Every source that can answer this listing, best first. A source that cannot answer the chosen listing is
  // not in the pool at all, the same way one without `latest` has never been. Popular is universal among
  // extensions but absent from a few site engines.
  //
  // The pool is what the chip COUNTS. It used to count the ranked list below, and that list is capped at
  // twelve, so a 14-source install read "All sources · 12 sources" over a sheet listing nine -- three numbers
  // for one pool. The cap is a fetch budget, not a fact about the install.
  const pool = useMemo(() => budgetForMode(sources, listMode, Infinity), [sources, listMode]);
  // Ranked once; how many of them are actually asked grows as answers come back.
  const ranked = useMemo(() => pool.slice(0, 12), [pool]);

  // Nothing resets the wall any more. That reset -- and specifically resetting it WITHOUT remounting the
  // children, which kept their React keys and their cached queries -- is what left the page counting sources
  // it had just forgotten, with skeletons that never resolved. See the warning on SourceLatest.

  /**
   * Six sources, plus one more for every one that came back with nothing.
   *
   * Ranking by what the library actually came from is right, and on a real install it turned out that four
   * of that reader's own six top sources answer "newest" with an empty page: their Cloudflare challenge
   * fails and the adapter returns [] rather than throwing, so nothing marks them unhealthy and nothing
   * moves them down. A fixed six then spends most of the wall on sources that cannot fill it.
   *
   * Each replacement is only requested after an earlier source has settled, so this widens the wall without
   * widening the burst. Bounded twice over: by the ranked list and by the cap.
   */
  // Everything the wall accumulates is keyed `${listMode}:${sourceId}`, never bare. That is what lets the
  // Newest/Popular toggle work WITHOUT clearing anything: switching simply reads a different set of keys,
  // and switching back shows what was already loaded, instantly. Clearing is the one thing that has ever
  // broken this page -- see the warning on SourceLatest -- so the toggle is built so it never has to.
  const kOf = useCallback((id: string) => `${listMode}:${id}`, [listMode]);
  const mine = useCallback(
    <T,>(rec: Record<string, T>) => Object.entries(rec).filter(([k]) => k.startsWith(`${listMode}:`)),
    [listMode],
  );

  const emptied = mine(states).filter(([, v]) => v === 'empty' || v === 'blocked').length;
  const budget = useMemo(
    () => ranked.slice(0, Math.min(ranked.length, 10, 6 + emptied)),
    [ranked, emptied],
  );

  // AddSeriesDialog's effect depends on this list. Built inline it was a fresh array every render, so with
  // the hero's add dialog open every settling source refired /api/sources/find -- a fan-out with a
  // 25-second per-source timeout, repeatedly, while the wall filled in behind it.
  const budgetIds = useMemo(() => budget.map((s) => s.id), [budget]);

  const onSettled = useCallback((id: string, items: SourceItem[], ok: boolean) => {
    setById((prev) => (prev[id]?.length && !items.length ? prev : { ...prev, [id]: [...(prev[id] ?? []), ...items] }));
    setOrder((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setStates((prev) => ({ ...prev, [id]: !ok ? 'blocked' : items.length ? 'ok' : 'empty' }));
  }, []);

  // The concurrency gate. Four at a time; each settle releases the next. Counted within the current
  // listing only, or switching modes would look already-finished and never fetch.
  const settled = order.filter((k) => k.startsWith(`${listMode}:`)).length;
  const gate = 4 + settled;

  const nameOf = useCallback((id: string) => sources.find((s) => s.id === id)?.name, [sources]);
  // The page's own ranking, so a folded card's "preferred" provider is the one the page would have asked
  // first, not whichever answered first. Unranked sources sort last.
  const rankOf = useCallback((id: string) => { const i = ranked.findIndex((s) => s.id === id); return i < 0 ? ranked.length : i; }, [ranked]);

  // ---------------------------------------------------------------- search
  /**
   * The search, as a query rather than an imperative fetch.
   *
   * It was one `await api(...)` that showed eighteen skeletons until EVERY source had answered, and a
   * Cloudflare source has a ninety-second budget, so "takes forever" was the accurate description. The
   * server now answers within `wait` with whatever has landed and says who is still being asked; this polls
   * while `pending` is non-zero and the wall fills in. Keyed on the submitted term, so the answer to an old
   * term can never land on a new one (the key changed; the old request is aborted through `signal`), the
   * same term again inside five minutes is instant, and leaving search mode stops the polling by itself.
   */
  const searchQ = useQuery({
    // `selected` is part of the key: narrowing to a source is a different question, and must not be
    // answered from the unfiltered search's cache.
    queryKey: ['search-all', term, selected],
    queryFn: ({ signal, queryKey, client }) => {
      // ⚠️ Only the first request may wait the long wait. A poll that also waited six seconds would hold
      // its answer until the server's grace expired, so the wall would fill in six seconds late every time.
      const first = (client.getQueryState(queryKey)?.dataUpdateCount ?? 0) === 0;
      const only = selected ? `&source=${encodeURIComponent(selected)}` : '';
      return api<SearchAnswer>(`/api/sources/search-all?q=${encodeURIComponent(term)}&wait=${first ? SEARCH_FIRST_WAIT_MS : SEARCH_POLL_WAIT_MS}${only}`, { signal });
    },
    enabled: mode === 'search' && !!term,
    // A failed search is shown as one; retrying it would be another fan-out to every source.
    retry: false,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchInterval: (qy) => (qy.state.data?.pending ? SEARCH_POLL_MS : false),
  });
  // The grouped hits as wall rows, under today's mapping: the first provider's ids are the card's, the badge
  // counts every provider. Derived, so a poll's answer replaces the rows without anything being cleared.
  const searchHits = useMemo<SourceItem[]>(() => (searchQ.data?.content ?? []).flatMap((g) => {
    // With a source chosen the server has already asked only that one, so this is belt-and-braces: keep
    // the card only if that source is among its providers, and let that provider be the card's own, so
    // tapping it opens the source being browsed rather than whichever the fold happened to rank first.
    const pick = selected ? g.providers.find((p) => p.source === selected) : g.providers[0];
    if (!pick) return [];
    return [{
      source: pick.source ?? '', sourceId: pick.sourceId ?? g.title,
      title: g.title, coverUrl: g.coverUrl, updatedAt: g.updatedAt,
      inLibrary: g.inLibrary, providerCount: g.providers.length,
    }];
  }), [searchQ.data, selected]);
  const groupsRef = useRef<Record<string, SearchGroup['providers']>>({});
  // What each search stored, keyed the way the wall's own fold is, so open() offers the providers of a hit
  // the same way it offers the providers of a folded card. Written from the answer, never from state.
  useEffect(() => {
    // Replace the submitted term's provider map rather than accumulating past searches. Two different
    // searches can fold to the same normalised title; retaining the old entry would let a freshly painted
    // card briefly open the previous search's providers before this answer added its own.
    groupsRef.current = {};
    (searchQ.data?.content ?? []).forEach((g) => { groupsRef.current[normTitle(g.title)] = g.providers; });
  }, [searchQ.data]);
  // How many sources the search is still waiting on, from the latest answer; zero in every other mode and
  // on an older server that does not report it.
  const stillAsking = mode === 'search' ? (searchQ.data?.pending ?? 0) : 0;
  /**
   * "3 of 8 sources answered · still asking MangaDex, Aqua Manga, Bato and 2 more": the wall is usable
   * from the first answer, and this is what says the rest is coming and who is slow. Three names, then a
   * count, so the line stays one line on a phone; one name gets the singular sentence.
   */
  const progress = useMemo(() => {
    const d = searchQ.data;
    if (mode !== 'search' || !d?.pending || !d.sources) return null;
    const m = d.asked ?? d.sources.filter((s) => s.state !== 'skipped').length;
    const n = Math.max(0, m - d.pending);
    const waiting = d.sources.filter((s) => s.state === 'pending').map((s) => s.name);
    if (waiting.length === 1) return tr('{n} of {m} sources answered · still asking {name}', { n, m, name: waiting[0] });
    const shown = waiting.slice(0, SEARCH_NAMES_SHOWN).join(', ');
    const more = waiting.length - SEARCH_NAMES_SHOWN;
    // A singular key for one: "et 1 autres" is not French, and a plural key cannot know.
    const names = more > 1 ? `${shown} ${tr('and {n} more', { n: more })}` : more === 1 ? `${shown} ${tr('and 1 more')}` : shown;
    return tr('{n} of {m} sources answered · still asking {names}', { n, m, names });
  }, [mode, searchQ.data]);

  const wall = useMemo(() => {
    // Search arrives already folded: the server grouped it and the effect above stored the groups in groupsRef.
    if (mode === 'search') return { items: searchHits, groups: {} as Record<string, WallProvider[]> };
    const seen = new Set<string>();
    const out: SourceItem[] = [];
    // Strict arrival order. Interleaving by rank would push already-read tiles down as a slow source lands.
    for (const key of order) {
      if (!key.startsWith(`${listMode}:`)) continue;
      // Filtering is display-only: everything stays loaded, this just decides what is shown. That is why
      // tapping a chip is instant and why it cannot strand the wall the way restarting it used to.
      if (selected && key !== `${listMode}:${selected}`) continue;
      for (const it of byId[key] ?? []) {
        const k = `${it.source}:${it.sourceId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(it);
      }
    }
    // Then one card per title, the way search already is. Folding AFTER the flatten keeps the arrival order:
    // the first source to land a title keeps the card, later ones only join its provider list, so the
    // badge lights and the add dialog offers a choice without anything on screen moving.
    return foldByTitle(out, nameOf, rankOf);
  }, [mode, listMode, selected, searchHits, order, byId, nameOf, rankOf]);

  // Skeleton tiles: in search mode only until the FIRST answer (or a failure) -- after that the wall shows
  // what has landed and the progress line says what has not, so a skeleton would sit beside real tiles and
  // read as a stuck load.
  const pending = mode === 'newest' ? Math.max(0, budget.length - settled) : (!searchQ.data && !searchQ.isError ? 3 : 0);

  // The empty card for ONE source browsed alone says that source's own reason and wait, the way its sheet
  // row does -- "Rate-limited … · back in ~12 min", not the wall's "nothing new". `selected` names a
  // budgeted source (the picker clears it on a mode change), but the row is looked up defensively for the
  // same reason the picker's × is: a missing row must degrade to a sentence, not a crash.
  const alone = mode === 'newest' && selected
    ? aloneEmpty(budget.find((s) => s.id === selected) ?? { id: selected, name: selected, lang: null }, states[kOf(selected)] ?? 'idle')
    : null;

  const search = (e?: React.FormEvent) => {
    e?.preventDefault();
    const next = q.trim();
    if (!next) return;
    setMode('search');
    // The same term submitted again while its answer is on screen is a refetch -- a failed search has no
    // other way back, and a finished one costs the server nothing (it answers from its entry). Not while
    // one is in flight: `refetch()` cancels the running request by default, so a second tap of Search during
    // the six-second wait would throw away the answer it was about to get. A new term is a new key; the old
    // answer is never shown under it.
    if (next === term && mode === 'search') { if (!searchQ.isFetching) searchQ.refetch(); }
    else setTerm(next);
  };
  // `term` is kept: the query is disabled by the mode, and keeping its observer keeps the answer cached, so
  // searching the same title again after browsing is instant.
  const backToNewest = () => { setQ(''); setMode('newest'); };

  const open = (it: SourceItem) => {
    const key = normTitle(it.title);
    if (it.inLibrary || added.has(key)) return;
    // The wall's own fold first, then what the last search stored: both are keyed the same way.
    const providers = wall.groups[key] ?? groupsRef.current[key];
    if (providers?.length) setSeed({ kind: 'group', title: it.title, providers });
    else setSeed({ kind: 'result', provider: { source: it.source, name: nameOf(it.source) ?? it.source, sourceId: it.sourceId, title: it.title, coverUrl: it.coverUrl } });
  };

  // ---------------------------------------------------------------- more
  const sentinel = useRef<HTMLDivElement>(null);
  const canPage = mode === 'newest' && settled >= budget.length && budget.length > 0 && page < 5;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !canPage) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) setPage((p) => Math.min(5, p + 1)); }, { rootMargin: '800px' });
    io.observe(el);
    return () => io.disconnect();
  }, [canPage]);

  // ---------------------------------------------------------------- jobs
  const { data: jobsData } = useQuery({
    queryKey: ['source-jobs'],
    queryFn: () => api<{ content: Job[] }>('/api/sources/jobs'),
    enabled: mayAdd,
    // Polled hard only while something is actually downloading. It used to poll every four seconds forever.
    refetchInterval: (qy) => ((qy.state.data?.content ?? []).some((j) => j.status === 'downloading') ? 2500 : 30_000),
  });
  // A finished job stays on the server for a day now (the download pill lists them, #82); this strip keeps
  // showing the last few minutes of them, as it always did (lib/jobs.ts `forStrip`).
  const jobs = forStrip(jobsData?.content ?? []);

  /**
   * The hero's slides: everything with wide key art first, then topped up from the rest.
   *
   * This was `withArt.length ? withArt : all` -- all-or-nothing, falling back only when NOTHING had a
   * banner -- and it quietly capped the hero far below its own limit. Measured on a real library: AniList
   * returns 40 trending manhwa, 16 carry banner art, and after removing the 215 series that library already
   * owned, 7 banner-bearing titles were left. Raising the slice alone would have changed nothing, and the
   * pool shrinks further with every series added.
   *
   * Topping up costs nothing, because the hero already handles a missing banner: it falls back to the 2:3
   * cover and letterboxes it on wide viewports.
   */
  const heroSlides = useMemo(() => {
    const all = trending?.content ?? [];
    const withArt = all.filter((t) => t.banner);
    const rest = all.filter((t) => !t.banner);
    return [...withArt, ...rest].slice(0, HERO_SLIDES);
  }, [trending]);
  const rail = useMemo(() => {
    const lead = new Set(heroSlides.map((s) => s.title));
    return (trending?.content ?? []).filter((t) => !lead.has(t.title));
  }, [trending, heroSlides]);

  // ---------------------------------------------------------------- may they be here at all
  // The tab is hidden for this account and every route this page calls now refuses it, so a typed URL would
  // otherwise render a wall of empty skeletons and a "try again" button that never works. Say it plainly.
  if (!mayAdd) {
    return (
      <div className="min-h-screen-d px-4 lg:px-0">
        <EmptyState art={ART.emptyLibrary} title={tr('Adding series is turned off for your account')}
          sub={tr('Ask whoever runs this server if you need it. Everything already in the library is still yours to read.')} />
      </div>
    );
  }

  // ---------------------------------------------------------------- zero sources
  if (sourcesData && sources.length === 0) {
    return (
      <div className="min-h-screen-d px-4 lg:px-0">
        {/* An age-limited account is served a filtered list, so "none" here can mean "none you may use"
            rather than "none installed" — and telling a reader to mount SOURCES_DIR would be nonsense. */}
        {(sourcesData.hiddenAdult ?? 0) > 0 ? (
          // Every provider on this server is marked 18+ and the reveal is off, so the page is empty for a
          // reason the reader can undo. Without this branch the one screen that could offer the chip is the
          // one screen the chip never reaches, and the sources would look uninstalled. `hiddenAdult`, not
          // `showAdultChip`: with the reveal already on nothing is hidden and this sentence would be false.
          <>
            <EmptyState art={ART.emptyLibrary} title={tr('Nothing to browse with 18+ hidden')}
              sub={tr('Every provider set up for your account is marked 18+. Turn on Show 18+ to browse them.')} />
            <div className="-mt-10 flex justify-center pb-10"><AdultToggle alsoWhen /></div>
          </>
        ) : isAdmin ? (
          <EmptyState art={ART.emptyLibrary} title={tr('No sources installed')}
            sub={isDesktop()
              ? tr('Add a site, or turn on an extension source, in Admin → Providers.')
              : tr('Mount a source pack at SOURCES_DIR, or switch on an extension source, then reload from the Providers tab.')} />
        ) : (
          <EmptyState art={ART.emptyLibrary} title={tr('No sources available')}
            sub={tr('There is nothing set up for your account to browse yet. Ask whoever runs this server.')} />
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen-d px-4 lg:px-0">
      {heroSlides.length > 0 && mode === 'newest' && (
        <DiscoverHero slides={heroSlides} onPick={(t) => setSeed({ kind: 'trending', title: t.title })} />
      )}

      <header className="pt-5 lg:pt-7">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <h1 className="font-display text-2xl font-bold tracking-tight lg:text-3xl">{tr('Discover')}</h1>
            {/* Follows the listing, or the toggle below says Popular while the page says Newest. */}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <p className="text-sm text-fog-400">{listMode === 'popular' ? tr('Popular on your sources') : tr('Newest from your sources')}</p>
              {/* In the HEADER and not on the chip row below, deliberately: SourcePicker is mounted only
                  while `mode === 'newest'`, so a chip anchored there would disappear the moment someone
                  searched — and search is one of the surfaces the reveal now changes. */}
              <AdultToggle alsoWhen={showAdultChip} className="shrink-0 text-xs" />
            </div>
          </div>
          <form onSubmit={search} className="flex w-full items-center gap-2 sm:w-auto">
            <div className="field flex min-w-0 flex-1 items-center gap-2 py-0 sm:w-72 lg:w-80">
              <IcSearch width={17} height={17} className="shrink-0 text-fog-500" />
              <input value={q} onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') backToNewest(); }}
                placeholder={tr('Search all sources…')} aria-label={tr('Search all sources…')}
                className="w-full bg-transparent py-2.5 text-sm text-fog-50 outline-hidden placeholder:text-fog-500" />
              {q && (
                <button type="button" onClick={backToNewest} aria-label={tr('Close')} className="shrink-0 text-fog-500 hover:text-fog-200">
                  <IcX width={15} height={15} />
                </button>
              )}
            </div>
            <button className="btn-accent shrink-0 px-5 py-2.5 text-sm">{tr('Search')}</button>
          </form>
        </div>
      </header>

      {/*
        In both modes, not just while browsing. The picker is the only place the chosen source is visible or
        clearable, so hiding it during a search -- while the search itself is narrowed to that source --
        would leave the results silently filtered with nothing on screen to say why. Choosing a list tab is
        a browse action, so from a search it returns to browsing that list.
      */}
      <SourcePicker
        sources={budget} states={states} settled={settled} total={budget.length}
        // The chip's number is the whole pool, not the budget and not the ranked list: the budget widens
        // as sources answer empty, and a count that ticks upward on its own reads as a bug; the ranked
        // list is capped at twelve, and "12 sources" on a 14-source install is simply false.
        count={pool.length}
        selected={selected} onSelect={setSelected}
        mode={listMode}
        onMode={(m) => { setListMode(m); setSelected(null); setPage(1); if (mode === 'search') backToNewest(); }}
      />

      {/* One mounted child per budgeted source. Renders nothing; owns one request.
          The key carries the listing mode, so switching Newest/Popular REMOUNTS these and they fetch the
          other listing. That pairing is not optional: a child that keeps its key keeps its cached query,
          never re-reports, and the wall waits forever on a source it thinks it has not heard from. */}
      {mode === 'newest' && budget.map((s, i) => (
        <SourceLatest key={`${listMode}:${s.id}:${page}`} source={s} listMode={listMode}
          page={page} enabled={i < gate} onSettled={onSettled} />
      ))}

      {jobs.length > 0 && (
        <div className="board mt-5">
          {jobs.map((j) => (
            <div key={j.folder} className={`card p-3 ${j.status === 'error' ? 'border-amber-500/40' : ''}`}>
              <p className="truncate text-xs font-medium text-fog-100">{j.title}</p>
              {j.status === 'downloading' ? (
                <>
                  <div className="mt-2"><ProgressBar value={j.total ? j.done / j.total : 0.02} /></div>
                  <p className="mt-1 text-[11px] tabular-nums text-fog-500">{j.done}/{j.total}</p>
                </>
              ) : j.status === 'error' ? (
                // `reason` is now written when a job fails and names the source and how far it got. This
                // line used to show the same sentence whatever had actually happened.
                // A download killed by a rate-limit used to vanish from this strip entirely, taking its
                // reason with it: the row was filtered to `downloading` and `reason` was never declared.
                <p className="mt-1 text-[11px] text-amber-300">{j.reason || tr('Fetch stopped. Try another source or wait.')}</p>
              ) : j.cancelled ? (
                // Stopped by its Cancel (#82): `done`, but "Fetched" in emerald would claim the whole run landed.
                <p className="mt-1 text-[11px] text-fog-400">{j.reason || tr('Cancelled; what landed is kept.')}</p>
              ) : j.total === 0 && j.autoFollow ? (
                // A "Nothing yet" add that asked for the other sources leaves a card with no chapters on it,
                // only the judgement: it is not a fetch and must not read as one. "Fetched" in emerald sat
                // under the series a person had just declined to fetch, for five minutes.
                <p className="mt-1 text-[11px] text-fog-500">{j.autoFollow.done ? tr('Checked other sources') : tr('Checking other sources…')}</p>
              ) : (
                <p className="mt-1 text-[11px] text-emerald-400">{tr('Fetched')}</p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mb-3 mt-6 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="font-display text-lg font-semibold tracking-tight text-fog-50 lg:text-xl">
          {mode === 'search' ? tr('Results across your sources') : listMode === 'popular' ? tr('Popular on your sources') : tr('Newest from your sources')}
        </h2>
        {mode === 'search' ? (
          <button onClick={backToNewest} className="chip shrink-0 text-xs">
            <IcChevronLeft width={13} height={13} />{tr('Newest')}
          </button>
        ) : budget.length > 0 && settled < budget.length ? (
          <span className="shrink-0 text-xs tabular-nums text-fog-500">
            {tr('{done} of {total} sources', { done: settled, total: budget.length })}
          </span>
        ) : null}
        {/* Search's own progress, on its own row: with three source names it does not fit beside the
            heading at 390 px, and it is gone the moment the last source answers. Announced, since the wall
            it describes changes under a screen reader without a focus change. */}
        {mode === 'search' && progress && (
          <p className="basis-full text-xs tabular-nums text-fog-500" aria-live="polite" data-search-progress>
            {progress}
          </p>
        )}
      </div>

      <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 lg:gap-x-4 xl:grid-cols-8 2xl:grid-cols-9 3xl:grid-cols-10">
        {wall.items.map((it, i) => (
          <SourceCard key={`${it.source}:${it.sourceId}`} item={{ ...it, inLibrary: it.inLibrary || added.has(normTitle(it.title)) }}
            sourceName={mode === 'newest' && order.length > 1 ? nameOf(it.source) : undefined}
            onAdd={() => open(it)} eager={i < 12} />
        ))}
        {Array.from({ length: Math.min(18, pending * 6) }).map((_, i) => (
          <div key={`sk${i}`} className="skeleton aspect-[2/3] rounded-2xl" />
        ))}
      </div>

      {/* No "no results" while sources are still being asked: the first answer often has nothing yet and the
          sentence would be a verdict on a search that is still running. The progress line covers that gap. */}
      {!wall.items.length && !pending && !stillAsking && (
        <div className="card col-span-full mt-2 p-8 text-center">
          <p className={`text-sm ${alone?.warn ? 'text-amber-300' : 'text-fog-400'}`}>
            {mode === 'search' ? (searchQ.isError ? tr('Search failed') : tr('No results across your sources — try another title.'))
              // Only an admin can act on the first sentence; a member told to open Admin has nowhere to go.
              : budget.length === 0 ? (isAdmin ? tr('No sources are set up yet. Add one in Admin \u2192 Providers.') : tr('No sources are set up yet. Ask whoever runs this server.'))
              // One source alone: its reason, amber, before any sentence about the wall as a whole.
              : alone ? alone.text
              : Object.values(states).every((s) => s === 'blocked')
                ? tr('No source could be reached right now.')
                : tr('Nothing new from these sources right now.')}
          </p>
          {/* A failed search gets the same button: with `retry: false` nothing else re-asks it. */}
          {(mode === 'newest' || searchQ.isError) && (
            <button onClick={() => (mode === 'search' ? searchQ.refetch() : qc.invalidateQueries({ queryKey: ['src-latest'] }))} className="btn-ghost mt-4 px-5 py-2 text-sm">
              {tr('Try again')}
            </button>
          )}
        </div>
      )}

      <div ref={sentinel} className="h-16" />

      {mode === 'newest' && rail.length > 0 && (
        <section className="pb-6">
          <h2 className="mb-3 font-display text-lg font-semibold tracking-tight text-fog-50 lg:text-xl">{tr('Trending manhwa')}</h2>
          {/* pb-3 rather than pb-1: the global scrollbar is 8px and used to be hidden, so the rail had no
              room for it and it would have sat on the card captions. */}
          <ScrollRail label={tr('Trending manhwa')}
            className="bleed flex gap-3 px-4 pb-3 lg:px-8 [scroll-snap-type:x_mandatory]">
            {rail.map((t, i) => (
              <Reveal key={t.title} delay={Math.min(i, 12) * 28}>
                <TrendingCard t={t} onPick={(x) => setSeed({ kind: 'trending', title: x.title })} />
              </Reveal>
            ))}
          </ScrollRail>
        </section>
      )}

      {seed && (
        <AddSeriesDialog
          seed={seed}
          sources={budgetIds}
          // Following a source is an admin act, like the manual follow route and the sheet's ×: a member
          // who may add must not be able to follow two sources they could never unfollow.
          mayFollow={isAdmin}
          onClose={() => setSeed(null)}
          onAdded={(r) => {
            setAdded((prev) => new Set(prev).add(normTitle(r.title)));
            qc.invalidateQueries({ queryKey: ['source-jobs'] });
          }}
        />
      )}
    </div>
  );
}
