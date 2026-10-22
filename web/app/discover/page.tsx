'use client';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { ART } from '@/lib/art';
import { relativeTime } from '@/lib/format';
import { useAuth, canDownload } from '@/lib/auth';
import { keys, t as tr } from '@/lib/i18n';
import { reasonText } from '@/lib/said';
import { isDesktop } from '@/lib/desktop';
import { EmptyState } from '@/components/EmptyState';
import { ProgressBar, Reveal } from '@/components/ui';
import { SourceCard, SourceItem, StillLoadingCard } from '@/components/cards';
import { ScrollRail } from '@/components/ScrollRail';
import { DiscoverHero, heroPoll, TrendingCard, Trending } from '@/components/DiscoverHero';
import { pollAfter, type Recommendations } from '@/lib/recommendations';
import { mergePicks, type Pick, type ReadPick } from '@/lib/forYou';
import { placeRows, useGridCols, weave } from '@/lib/shelves';
import { SourcePicker, SourceLatest, Src, SrcState } from '@/components/SourcePicker';
import { aloneEmpty, answeredPage, budgetForMode, discoverSources, WALL_IN_FLIGHT, type ListMode, type SrcExtension, type StackSource } from '@/lib/sourceGroups';
import { normTitle } from '@/lib/normTitle';
import { applyWorks, foldByWork, followWorks, mergeGroups, unknownWorks, workKey, type WallProvider } from '@/lib/wall';
import { useLiveWorks } from '@/lib/useLiveWorks';
import { AddSeriesDialog, AddSeed } from '@/components/AddSeriesDialog';
import { AdultToggle, useAdultShown } from '@/components/AdultToggle';
import { IcChevronLeft, IcSearch, IcSparkle, IcX } from '@/components/icons';
import { forStrip } from '@/lib/jobs';
import { downloadsHref, stripHref } from '@/lib/libraryView';
import { useServerDownloads } from '@/lib/useServerDownloads';
import { canSearchMore, freshCards, noMore, soloSource, type SearchMore } from '@/lib/searchMore';
/**
 * One search card. Since v0.52.0 (#72) `inLibrary` means held in every provider's language, `libraryLangs` the
 * languages the library holds the title in, and each provider carries its own `lang` and `inLibrary`. Since v0.55.4
 * (#158) `rating` says what the card is known to be -- 18+ when any provider's result is -- and is absent when nothing
 * says (most extensions name no genres in a search). Since v0.56.0 `work` is which work the group is -- the server
 * merges its groups by it, so their providers' titles may differ -- and `owned` whether the library holds it in any
 * language; both absent from an older server.
 */
interface SearchGroup {
  title: string; coverUrl?: string; inLibrary?: boolean; librarySeriesId?: string; libraryLangs?: string[]; updatedAt?: string;
  rating?: 'adult' | 'safe';
  work?: string; owned?: boolean;
  providers: { source: string; name: string; sourceId: string; title: string; coverUrl?: string; lang?: string | null; inLibrary?: boolean; rating?: 'adult' | 'safe' }[];
}
/** What a search shows (v0.55.4): everything, everything not known to be 18+, or only what is. */
type RatingFilter = 'all' | 'safe' | 'adult';
/** One source's line in a search answer (v0.40.0): what it did with the term, or that it is still being asked. */
interface SearchSourceLine { id: string; name: string; state: 'ok' | 'empty' | 'timeout' | 'failed' | 'skipped' | 'pending'; ms?: number; why?: 'disabled' | 'cooldown' }
/**
 * `/api/sources/search-all`. `content` is the grouped hits, shaped exactly as before v0.40.0; the rest is the
 * progress the server has reported since, and is optional so an older server's answer still renders. `rating` (v0.55.4)
 * is the 18+ filter the server applied: the one asked for, or `safe` for an account whose age limit shows no 18+.
 */
interface SearchAnswer { content: SearchGroup[]; sources?: SearchSourceLine[]; pending?: number; asked?: number; rating?: RatingFilter }

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
/** How many pending sources the progress line names before "and N more", and the wall's last card before "+N". */
const SEARCH_NAMES_SHOWN = 3;
/**
 * How many sources the hero's add looks a title up on, best-ranked first. GET /api/sources/find asks every source it is
 * given at once -- it has no gate like the wall's four-at-a-time -- so when the wall began asking every source
 * (v0.58.0) this stayed the most the wall had asked before: ten.
 */
const HERO_FIND_SOURCES = 10;

/**
 * How many titles the hero rotates through.
 *
 * At 5s a slide this is a 50-second loop. Going much higher means the last few slides are seen by nobody,
 * and every slide is one more proxied cover fetch.
 */
const HERO_SLIDES = 10;

/**
 * The trending rows (v0.61.0), by AniList's country of origin: Korea's (manhwa -- the hero shows ten of them, as it always
 * has), then Japan's (manga) and China's (manhua). Each row holds its whole list since v0.98.0, the first ten wearing their
 * rank. What each is called, in the same order, declared for the translators: the rows render it through a variable.
 */
const TREND_RAILS = ['KR', 'JP', 'CN'] as const;
const TREND_LABELS = keys('Trending manhwa', 'Trending manga', 'Trending manhua');
/**
 * Discover's rows inside the wall (v0.98.0, lib/shelves.ts), in the order they come: the picks for you, then the trending
 * rows. Each only with something on it.
 */
const ROWS = ['foryou', ...TREND_RAILS] as const;
type RowKey = (typeof ROWS)[number];
/** How many of a trending row's first cards wear their rank, as Home's Top 10 does. */
const RANKED = 10;
/** The wall's grid: every run of it between two rows is one of these, so a row never shifts the columns. */
const WALL_GRID = 'grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 lg:gap-x-4 xl:grid-cols-8 2xl:grid-cols-9 3xl:grid-cols-10';
/** An AniList row's card, as the page remembers what this visit added from it: by its entry, else its title. */
const railKey = (t: { id?: number | null; title: string }): string => (t.id != null ? `al:${t.id}` : `t:${normTitle(t.title)}`);

/**
 * One of Discover's rows (v0.61.0; inside the wall since v0.98.0): the picks for you, and the trending rows. Every one goes
 * through this one ScrollRail -- a strip a mouse can move (rails.test.ts) -- edge to edge, and a card opens the add dialog,
 * which looks the title up on the best-ranked sources.
 */
function AniListRail({ kind, title, children, className = 'pb-3 pt-9' }: {
  kind: string; title: string; children: ReactNode; className?: string;
}) {
  return (
    <section className={className} data-anilist-rail={kind}>
      <h2 className="mb-1 font-display text-lg font-semibold tracking-tight text-fog-50 lg:text-xl">{title}</h2>
      {/* pb-3 rather than pb-1: the global scrollbar is 8px and used to be hidden, so the rail had no
          room for it and it would have sat on the card captions. pt-2: room for a card's hover lift. */}
      <ScrollRail label={title}
        className="bleed bleed-pad flex gap-3 pb-3 pt-2 [scroll-snap-type:x_mandatory]">
        {children}
      </ScrollRail>
    </section>
  );
}

/**
 * Discover, rebuilt around what people actually do here.
 *
 * This is the only page that adds new series from the internet, and it was a bare search box on black with a
 * ragged grid hanging off it. Production said something the design did not: in 48 hours there were 32 calls
 * to "newest from a source" and ZERO searches. The thing buried behind a label, a 45-option dropdown and a
 * separate button was the entire point of the page, and the search box that dominated it was unused.
 *
 * So: a wall of what your sources published, led by a full-bleed hero built from AniList key art that
 * `/api/discover/trending` has been returning all along and this page rendered as a 144px thumbnail. The
 * sources are ranked and every one of them is asked, the best first, four at a time (v0.58.0: it was the best
 * six to ten, and the owner's 29 sources were mostly never on the wall). Search survives as a field, with a
 * way back out that it never had.
 *
 * `/api/sources/latest` takes up to fifteen seconds, so the sources are fetched independently and the
 * wall fills in as each lands, in arrival order, with a card at its end naming who is still loading. Nothing
 * already on screen ever moves: only mangadex populates `updatedAt`, so "newest across every source" is not a
 * sortable quantity and pretending otherwise would reflow tiles under a reading thumb.
 */
function DiscoverInner() {
  const qc = useQueryClient();
  const { user, isAdmin } = useAuth();

  // Not fired at all for an account that may not add series: every route behind this page answers 403 for
  // them, and a query whose only possible outcome is a refusal is noise in the console and in the log.
  const mayAdd = canDownload(user);

  // v0.61.0: `/discover/?q=<title>` -- where the series page's Related and the reader's Next in the story send a work the
  // library does not hold -- opens on a search for it. Read once, here, as Library and Admin → Sources read their
  // `?view=`; afterwards the page writes the address itself (writeQ below), so a reload stays on what is on screen.
  const params = useSearchParams();
  const [arrivedQ] = useState(() => (params.get('q') ?? '').trim().slice(0, 200));

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
  // Never a backup extension's (v0.82.0, lib/sourceGroups.ts discoverSources): only the sources a person added.
  const sources = useMemo(() => discoverSources(sourcesData?.content ?? []), [sourcesData]);
  /**
   * Whether to offer the reveal chip here at all.
   *
   * ⚠️ The `adultOn ||` is load-bearing, not defensive. With the reveal ON the server hides nothing, so
   * `hiddenAdult` is 0 — and a chip that vanishes the moment it is pressed strands the session with no way
   * back. `AdultToggle` still renders on its own wherever an 18+ library exists.
   */
  const adultOn = useAdultShown();
  const showAdultChip = adultOn || (sourcesData?.hiddenAdult ?? 0) > 0;

  const trendQ = useQuery({
    // NOT ['trending'] -- that key belongs to /api/trending, which is what the household is reading and is a
    // Series[]. This is /api/discover/trending, which is AniList and carries genres, banner and score. They
    // shared a key, so arriving here from the home page handed this the wrong shape out of the cache and the
    // hero threw on `genres.slice`. A direct page load was fine, which is why it looked intermittent.
    // v0.61.0: one key per country of origin; this one is Korea's, the hero's and the first rail's.
    queryKey: ['discover-trending', 'KR'],
    queryFn: () => api<{ content: Trending[]; pending?: boolean }>('/api/discover/trending?country=KR'),
    enabled: mayAdd,
    staleTime: 0,
    refetchOnMount: 'always',
    // v0.98.0: asked again while a server that has never stored a copy is still pulling one (bff lib/trending.ts).
    refetchInterval: (qy) => heroPoll(qy.state.data, qy.state.dataUpdateCount),
  });
  const trending = trendQ.data;
  /**
   * Korea's answer is in (v0.98.0): the hero's request goes first, and everything below the fold waits for it -- the picks
   * and the other trending rows sit inside the wall now, a screen down, and a phone on a slow line has the hero first.
   */
  const heroSettled = !trendQ.isPending;

  // ---------------------------------------------------------------- the wall
  const [mode, setMode] = useState<'newest' | 'search'>(arrivedQ ? 'search' : 'newest');
  // v0.61.0: the manga and manhua rows -- while browsing, each country its own answer and its own key; once Korea's is in.
  const moreTrending = useQueries({
    queries: TREND_RAILS.slice(1).map((country) => ({
      queryKey: ['discover-trending', country],
      queryFn: () => api<{ content: Trending[]; pending?: boolean }>(`/api/discover/trending?country=${country}`),
      enabled: mayAdd && mode === 'newest' && heroSettled,
      staleTime: 0,
      refetchOnMount: 'always' as const,
      refetchInterval: (qy: { state: { data?: { pending?: boolean }; dataUpdateCount: number } }) => heroPoll(qy.state.data, qy.state.dataUpdateCount),
    })),
  });
  // v0.61.0: "Because you read {title}" -- what AniList's readers recommend after the series this account read lately, less
  // what the server holds; since v0.98.0 from every recent read, each pick naming its own. The server answers from its
  // stored copy; nothing asks AniList here.
  const becauseQ = useQuery({
    queryKey: ['discover-because'],
    queryFn: () => api<{ seed: { id: string; title: string } | null; content: ReadPick[] }>('/api/discover/because'),
    enabled: mayAdd && mode === 'newest' && heroSettled,
    staleTime: 5 * 60_000,
  });
  const because = becauseQ.data;
  // #248's "Recommended for you": what the trackers this person connected suggest. The server does the caching (a day's old
  // answer is normal), so this asks once per visit and only polls while a first-time refresh is still running there.
  const recsQ = useQuery({
    queryKey: ['discover-recommendations'],
    queryFn: () => api<Recommendations>('/api/discover/recommendations'),
    enabled: mayAdd && mode === 'newest' && heroSettled,
    staleTime: 10 * 60_000,
    refetchInterval: (qy) => pollAfter(qy.state.data, qy.state.dataUpdateCount),
  });
  /**
   * Which listing the wall shows, and which single source (if any) is shown alone.
   *
   * `listMode` is NOT the same axis as `mode` above: that one is browse-versus-search, this one is the
   * sort within browsing.
   */
  const [listMode, setListMode] = useState<ListMode>('newest');
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState(arrivedQ);
  // What was SUBMITTED, as opposed to `q`, which is whatever is in the field. The search is keyed on this, so
  // typing never fires a request and a term is searched exactly once per five minutes however it is reached.
  // An arrival's `?q=` is submitted as it lands (v0.61.0).
  const [term, setTerm] = useState(arrivedQ);
  const [page, setPage] = useState(1);
  const [byId, setById] = useState<Record<string, SourceItem[]>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [states, setStates] = useState<Record<string, SrcState>>({});
  // The furthest page each source has answered, by the same `${listMode}:${id}` keys (v0.58.0): the gate and the paging
  // go by the page being fetched, so page 2 asks four at a time as page 1 does.
  const [upTo, setUpTo] = useState<Record<string, number>>({});
  const [seed, setSeed] = useState<AddSeed | null>(null);
  /**
   * What this visit added, by work (v0.56.0; by title before): off the wall at once, and "In library" in a search, with
   * no refetch. `fromKey` is the work of the card the open dialog came from -- null from the hero, which has none.
   */
  const [added, setAdded] = useState<Set<string>>(new Set());
  const fromKey = useRef<string | null>(null);
  /**
   * The AniList rails' cards this visit added (v0.61.0): off their rail at once, as an added card leaves the wall.
   * `fromRail` is the rail card the open dialog came from -- null from the wall or the hero -- and forgotten when the
   * dialog closes, so a later add from the hero never takes a rail card with it.
   */
  const [railAdded, setRailAdded] = useState<Set<string>>(new Set());
  const fromRail = useRef<string | null>(null);
  useEffect(() => { if (!seed) fromRail.current = null; }, [seed]);
  const pickRail = (t: { id?: number | null; title: string }) => { fromKey.current = null; fromRail.current = railKey(t); setSeed({ kind: 'trending', title: t.title }); };

  // Every source that can answer this listing, best first. A source that cannot answer the chosen listing is
  // not in the pool at all, the same way one without `latest` has never been. Popular is universal among
  // extensions but absent from a few site engines.
  //
  // The pool is what the chip COUNTS, and since v0.58.0 it is also what the wall asks (`budget` below). The chip
  // once counted a ranked list capped at twelve, so a 14-source install read "All sources · 12 sources" over a
  // sheet listing nine -- three numbers for one pool.
  const pool = useMemo(() => budgetForMode(sources, listMode, Infinity), [sources, listMode]);

  // Nothing resets the wall any more. That reset -- and specifically resetting it WITHOUT remounting the
  // children, which kept their React keys and their cached queries -- is what left the page counting sources
  // it had just forgotten, with skeletons that never resolved. See the warning on SourceLatest.

  // Everything the wall accumulates is keyed `${listMode}:${sourceId}`, never bare. That is what lets the
  // Newest/Popular toggle work WITHOUT clearing anything: switching simply reads a different set of keys,
  // and switching back shows what was already loaded, instantly. Clearing is the one thing that has ever
  // broken this page -- see the warning on SourceLatest -- so the toggle is built so it never has to.
  const kOf = useCallback((id: string) => `${listMode}:${id}`, [listMode]);
  const mine = useCallback(
    <T,>(rec: Record<string, T>) => Object.entries(rec).filter(([k]) => k.startsWith(`${listMode}:`)),
    [listMode],
  );

  // What the server has placed since it answered (v0.56.0). The names it had not (`n:…`) are asked about again while
  // the wall is on screen (lib/useLiveWorks.ts), and every source's rows are read through the answers: a card joins
  // the one its work already has, and one the library turns out to hold leaves the wall. An add follows its work.
  const wallKeys = useMemo(() => unknownWorks(mine(byId).flatMap(([, list]) => list)), [byId, mine]);
  const wallWorks = useLiveWorks(wallKeys, mayAdd && mode === 'newest');
  const rows = useMemo(() => Object.fromEntries(mine(byId).map(([k, list]) => [k, applyWorks(list, wallWorks)])), [byId, mine, wallWorks]);
  const wallAdded = useMemo(() => followWorks(added, wallWorks), [added, wallWorks]);

  /**
   * Which sources the wall asks: every one in the pool, best-ranked first (v0.58.0).
   *
   * It was six, plus one more for every one that came back with nothing, ten at most: on a real install four of a
   * reader's own top six answered "newest" with an empty page (their Cloudflare challenge failed and the adapter
   * returned [] rather than throwing), so a fixed six spent the wall on sources that could not fill it. The owner then
   * asked for all 29 of his on the wall. The burst is the same either way: the gate below lets four ask at a time and
   * each answer releases the next, so more sources only means the wall keeps filling for longer -- and its last card
   * says who it is still waiting on.
   */
  const budget = pool;

  // Where the hero's add looks a title up: the best-ranked HERO_FIND_SOURCES (v0.58.0 kept it there when the wall
  // began asking every source -- /api/sources/find asks all it is given at once, with no gate like the wall's).
  // AddSeriesDialog's effect depends on this list. Built inline it was a fresh array every render, so with
  // the hero's add dialog open every settling source refired /api/sources/find -- a fan-out with a
  // 25-second per-source timeout, repeatedly, while the wall filled in behind it.
  const budgetIds = useMemo(() => budget.slice(0, HERO_FIND_SOURCES).map((s) => s.id), [budget]);

  const onSettled = useCallback((id: string, items: SourceItem[], ok: boolean, at = 1) => {
    setById((prev) => (prev[id]?.length && !items.length ? prev : { ...prev, [id]: [...(prev[id] ?? []), ...items] }));
    setOrder((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setStates((prev) => ({ ...prev, [id]: !ok ? 'blocked' : items.length ? 'ok' : 'empty' }));
    setUpTo((prev) => ((prev[id] ?? 0) >= at ? prev : { ...prev, [id]: at }));
  }, []);

  // How many sources have answered at all: the heading's "{done} of {total} sources", the picker's hairline and the
  // skeletons. Counted within the current listing only, or switching modes would look already-finished -- and among the
  // sources asked NOW: one that has left the list (Show 18+ turned off hides every adult one) answered once and stays in
  // `order`, and counting it read "done" while sources still on the list had not answered.
  const settled = budget.filter((s) => order.includes(kOf(s.id))).length;
  // The concurrency gate. Four at a time; each settle releases the next -- on every page. Counted by the page being
  // fetched (v0.58.0): `settled` counts a source once, so from page 2 on it opened the gate to every source at once,
  // and with every source asked that would have been a burst of all of them.
  const answered = answeredPage(budget.map((s) => kOf(s.id)), upTo, page);
  const gate = WALL_IN_FLIGHT + answered;

  const nameOf = useCallback((id: string) => sources.find((s) => s.id === id)?.name, [sources]);
  // The page's own ranking, so a folded card's "preferred" provider is the one the page would have asked
  // first, not whichever answered first. Unranked sources sort last.
  const rankOf = useCallback((id: string) => { const i = pool.findIndex((s) => s.id === id); return i < 0 ? pool.length : i; }, [pool]);

  // ---------------------------------------------------------------- search
  /**
   * The 18+ filter on the results (v0.55.4, #158): All, Hide 18+, 18+ only. Offered only while Show 18+ is on -- with it
   * off the server hides every 18+ result anyway, and three chips that answer the same would be a control that does
   * nothing -- and not to an account whose age limit shows no 18+: the server holds that one to Hide 18+ whatever it
   * asks, and its answer says so (`rating: 'safe'` for a filter asked as anything else), which is how the page learns
   * it. Kept for the visit, so every search after the first is filtered the same way.
   */
  const [rating, setRating] = useState<RatingFilter>('all');
  const [capped, setCapped] = useState(false);
  const offerRating = adultOn && !capped;
  const ratingAsked: RatingFilter = offerRating ? rating : 'all';
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
    // answered from the unfiltered search's cache. So is the 18+ filter, and whether Show 18+ is on: an answer from
    // before the switch was flipped says nothing about the account's age limit after it.
    queryKey: ['search-all', term, selected, ratingAsked, adultOn],
    queryFn: ({ signal, queryKey, client }) => {
      // ⚠️ Only the first request may wait the long wait. A poll that also waited six seconds would hold
      // its answer until the server's grace expired, so the wall would fill in six seconds late every time.
      const first = (client.getQueryState(queryKey)?.dataUpdateCount ?? 0) === 0;
      const only = selected ? `&source=${encodeURIComponent(selected)}` : '';
      const rated = ratingAsked === 'all' ? '' : `&rating=${ratingAsked}`;
      return api<SearchAnswer>(`/api/sources/search-all?q=${encodeURIComponent(term)}&wait=${first ? SEARCH_FIRST_WAIT_MS : SEARCH_POLL_WAIT_MS}${only}${rated}`, { signal });
    },
    // `mayAdd` (v0.61.0): an arrival's `?q=` starts in search mode, and an account the server refuses is not asked.
    enabled: mode === 'search' && !!term && mayAdd,
    // A failed search is shown as one; retrying it would be another fan-out to every source.
    retry: false,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchInterval: (qy) => (qy.state.data?.pending ? SEARCH_POLL_MS : false),
  });
  // An answer to a search made with Show 18+ on, filtered to Hide 18+ although it asked for something else: the
  // account's age limit shows no 18+, and the chips go for the rest of the visit.
  useEffect(() => {
    if (adultOn && ratingAsked !== 'safe' && searchQ.data?.rating === 'safe') setCapped(true);
  }, [adultOn, ratingAsked, searchQ.data]);
  // The search's own unplaced names, asked about while its results are on screen, as the wall's are (v0.56.0).
  const searchKeys = useMemo(() => unknownWorks(searchQ.data?.content ?? []), [searchQ.data]);
  const searchWorks = useLiveWorks(searchKeys, mayAdd && mode === 'search');
  const searchAdded = useMemo(() => followWorks(added, searchWorks), [added, searchWorks]);
  // The answer's groups read through what the server has placed since, one per work: two it could not tell apart when
  // it answered are one card once it can (lib/wall.ts mergeGroups). Owned ones stay -- search shows what you have, with
  // its ribbon. Derived, so a poll's answer replaces them without anything being cleared.
  const searchGroups = useMemo(() => mergeGroups(applyWorks(searchQ.data?.content ?? [], searchWorks)), [searchQ.data, searchWorks]);
  // The grouped hits as wall rows, under today's mapping: the first provider's ids are the card's.
  const searchHits = useMemo<SourceItem[]>(() => searchGroups.flatMap((g) => {
    // With a source chosen the server has already asked only that one, so this is belt-and-braces: keep
    // the card only if that source is among its providers, and let that provider be the card's own, so
    // tapping it opens the source being browsed rather than whichever the fold happened to rank first.
    const pick = selected ? g.providers.find((p) => p.source === selected) : g.providers[0];
    if (!pick) return [];
    return [{
      source: pick.source ?? '', sourceId: pick.sourceId ?? g.title,
      title: g.title, coverUrl: g.coverUrl, updatedAt: g.updatedAt,
      inLibrary: g.inLibrary, librarySeriesId: g.librarySeriesId,
      ...(g.work ? { work: g.work } : {}),
      ...(g.libraryLangs ? { libraryLangs: g.libraryLangs } : {}), ...(pick.lang !== undefined ? { lang: pick.lang } : {}),
      ...(g.rating === 'adult' ? { rating: 'adult' as const } : {}),
    }];
  }), [searchGroups, selected]);
  // Each hit's providers, keyed by work the way the wall's fold keys its own (by title until v0.56.0): what a card's
  // icons draw and what open() offers. A memo of the answer, where open() alone once read a ref an effect filled: the
  // icons read it while rendering, and there a ref is one answer behind.
  const searchProviders = useMemo(() => {
    const by: Record<string, WallProvider[]> = {};
    for (const g of searchGroups) { const k = workKey(g); if (k) by[k] = g.providers; }
    return by;
  }, [searchGroups]);
  // How many sources the search is still waiting on, from the latest answer; zero in every other mode and
  // on an older server that does not report it.
  const stillAsking = mode === 'search' ? (searchQ.data?.pending ?? 0) : 0;
  // More of a search on one source (v0.96.0, #331, lib/searchMore.ts): a site pages its search -- BatCave answers ten
  // at a time -- so a search on the chosen source, or on the only one there is, loads its next page as the wall is
  // scrolled (below, under "more"). Keyed on the search, so another term, source or filter starts over.
  const solo = mode === 'search' ? soloSource(selected, searchQ.data?.sources) : null;
  const moreKey = solo ? [term, solo, ratingAsked, adultOn ? 'adult' : 'safe'].join('\u0000') : '';
  const [moreState, setMore] = useState<SearchMore>(noMore());
  const more = moreState.key === moreKey ? moreState : noMore(moreKey);
  const [moreBusy, setMoreBusy] = useState(false);
  const moreCards = useMemo(() => freshCards(searchHits, more.items), [searchHits, more.items]);
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
  /**
   * Who the page is still waiting on, by name: the wall's last card, "Still loading" (v0.58.0). Asking every source
   * fills the wall for longer, and someone scrolling down reached its end with nothing to say more was coming. In
   * browsing, the sources asked for the page being fetched that have not answered it (only the one browsed alone,
   * when one is); in a search, the ones its latest answer says are still being asked. Empty once all have answered.
   */
  const waitingOn = useMemo(() => {
    if (mode === 'search') return (searchQ.data?.sources ?? []).filter((s) => s.state === 'pending').map((s) => s.name);
    return budget.filter((s) => (!selected || s.id === selected) && (upTo[kOf(s.id)] ?? 0) < page).map((s) => s.name);
  }, [mode, searchQ.data, budget, selected, upTo, kOf, page]);

  const wall = useMemo(() => {
    // Search arrives already folded: the server grouped it, and searchGroups merges what it has placed since.
    if (mode === 'search') return { items: moreCards.length ? [...searchHits, ...moreCards] : searchHits, groups: searchProviders };
    const seen = new Set<string>();
    const out: SourceItem[] = [];
    // Only the sources asked now. Everything loaded stays loaded (nothing is cleared, as above), but a source that has
    // left the list -- Show 18+ turned off hides every adult one -- kept its covers on the wall under a chip counting
    // fewer sources than it showed. Turning it back on shows them again from what is already loaded.
    const asked = new Set(budget.map((s) => kOf(s.id)));
    // Strict arrival order. Interleaving by rank would push already-read tiles down as a slow source lands.
    for (const key of order) {
      if (!asked.has(key)) continue;
      // Filtering is display-only: everything stays loaded, this just decides what is shown. That is why
      // tapping a chip is instant and why it cannot strand the wall the way restarting it used to.
      if (selected && key !== `${listMode}:${selected}`) continue;
      for (const it of rows[key] ?? []) {
        const k = `${it.source}:${it.sourceId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(it);
      }
    }
    // Then one card per work, the way search already is, without what the library holds or this visit added.
    // Folding AFTER the flatten keeps the arrival order: the first source to land a work keeps the card, later
    // ones only join its provider list, so its icons grow and the add dialog offers a choice without anything
    // on screen moving.
    return foldByWork(out, nameOf, rankOf, wallAdded);
  }, [mode, listMode, selected, searchHits, moreCards, searchProviders, order, rows, nameOf, rankOf, wallAdded, budget, kOf]);
  // What this visit added, in the keys of the view on screen: each view follows the works through its own answers.
  const shownAdded = mode === 'search' ? searchAdded : wallAdded;
  // Each card's icons: every provider behind it, with the extension it came out of, so MangaDex's languages are one
  // icon (lib/sourceGroups.ts iconStack). A row the fold passed through untouched is its one source.
  const extOf = useMemo(() => new Map<string, SrcExtension | null>(sources.map((s) => [s.id, s.extension ?? null])), [sources]);
  const stackOf = (it: SourceItem): StackSource[] =>
    (wall.groups[workKey(it)] ?? [{ source: it.source, name: nameOf(it.source) ?? it.source }])
      .map((p) => ({ source: p.source, name: p.name, extension: extOf.get(p.source) ?? null }));

  // Skeleton tiles: only until the FIRST cards land -- in search mode until the first answer (or a failure).
  // After that the wall shows what has landed and its last card (and in a search the progress line) says what has
  // not, so a skeleton would sit beside real tiles and read as a stuck load. Since v0.58.0 browsing too: with every
  // source asked, eighteen skeletons sat under the covers for as long as the slowest source took.
  const pending = mode === 'newest' ? Math.max(0, budget.length - settled) : (!searchQ.data && !searchQ.isError ? 3 : 0);

  // The empty card for ONE source browsed alone says that source's own reason and wait, the way its sheet
  // row does -- "Rate-limited … · back in ~12 min", not the wall's "nothing new". `selected` names a
  // budgeted source (a mode change keeps it only where the new listing has it, and one that leaves the list is let
  // go), but the row is looked up defensively for the same reason the picker's × is: a missing row must degrade to a
  // sentence, not a crash.
  const alone = mode === 'newest' && selected
    ? aloneEmpty(budget.find((s) => s.id === selected) ?? { id: selected, name: selected, lang: null }, states[kOf(selected)] ?? 'idle')
    : null;

  /**
   * The address says what is on screen (v0.61.0): `?q=` while a search is, nothing while browsing -- replaced, never
   * pushed, so Back leaves Discover instead of stepping through its searches.
   */
  const writeQ = (value: string) => {
    try {
      const u = new URL(window.location.href);
      if (value) u.searchParams.set('q', value); else u.searchParams.delete('q');
      window.history.replaceState(window.history.state, '', `${u.pathname}${u.search}${u.hash}`);
    } catch { /* the page works the same without it */ }
  };

  const search = (e?: React.FormEvent) => {
    e?.preventDefault();
    const next = q.trim();
    if (!next) return;
    setMode('search');
    writeQ(next);
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
  const backToNewest = () => { setQ(''); setMode('newest'); writeQ(''); };
  // A chosen source that has left the list -- Show 18+ turned off hides every adult one -- is let go. It stayed
  // chosen: the chip read its raw id, the wall stayed empty, and a search asked only it and said "No results across
  // your sources". Only once the list has answered, so nothing is let go before there is a list to look in.
  useEffect(() => {
    if (!sourcesData || !selected || budget.some((s) => s.id === selected)) return;
    setSelected(null);
  }, [sourcesData, budget, selected]);

  const open = (it: SourceItem) => {
    const key = workKey(it);
    // Only a card held in every provider's language is done with (v0.52.0): one held in another language opens the
    // dialog, which offers the new language as an edition and says which the library has.
    if (it.inLibrary || shownAdded.has(key)) return;
    // What the library holds of this title, for the dialog's "In your library in English" and its edition block.
    const library = it.librarySeriesId && it.libraryLangs?.length ? { seriesId: it.librarySeriesId, langs: it.libraryLangs } : undefined;
    // Every provider behind the card: the wall's fold, or the search's groups -- both keyed by work.
    const providers = wall.groups[key];
    fromKey.current = key || null;
    if (providers?.length) setSeed({ kind: 'group', title: it.title, providers, ...(library ? { library } : {}) });
    else {
      setSeed({
        kind: 'result',
        provider: { source: it.source, name: nameOf(it.source) ?? it.source, sourceId: it.sourceId, title: it.title, coverUrl: it.coverUrl, lang: it.lang, inLibrary: it.inLibrary },
        ...(library ? { library } : {}),
      });
    }
  };

  // ---------------------------------------------------------------- the rows inside the wall
  // How many covers the wall lays across, read off the wall's own grid (v0.98.0, lib/shelves.ts): where its rows go.
  const [wallEl, setWallEl] = useState<HTMLDivElement | null>(null);
  const cols = useGridCols(wallEl);
  /**
   * Which place each row holds, kept from one answer to the next (lib/shelves.ts placeRows), and how many covers the wall
   * had on screen at its last commit: a row that comes late takes a place below them, never among them. Both start again
   * with the wall itself -- another listing, another source, or back from a search.
   */
  const placedRef = useRef<{ key: string; placed: Map<RowKey, number> }>({ key: '', placed: new Map() });
  const shownRef = useRef(0);
  useEffect(() => { if (cols >= 1) shownRef.current = wall.items.length; });

  // ---------------------------------------------------------------- more
  const sentinel = useRef<HTMLDivElement>(null);
  // The next page once every source has answered this one (v0.58.0: once each had answered at all, so a page could
  // start while the last one was still being asked -- and with the gate counting by page, the sources it had not
  // reached yet would have been skipped).
  const canPage = mode === 'newest' && answered >= budget.length && budget.length > 0 && page < 5;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !canPage) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) setPage((p) => Math.min(5, p + 1)); }, { rootMargin: '800px' });
    io.observe(el);
    return () => io.disconnect();
  }, [canPage]);
  // A search on one source, its next page (#331): asked when the end of the wall comes near, one page at a time, until a
  // page brings nothing new. A failure ends it too: a search typed again starts over.
  const canMore = canSearchMore({
    solo, pages: !!sources.find((s) => s.id === solo)?.searchPages, rating: ratingAsked,
    pending: stillAsking, firstPage: searchHits.length, more, busy: moreBusy,
  });
  const loadMore = useCallback(async () => {
    if (!solo) return;
    const key = moreKey, next = more.page + 1, shown = [...searchHits, ...more.items];
    setMoreBusy(true);
    let fresh: SourceItem[] = [];
    try {
      const r = await api<{ content: SourceItem[] }>(`/api/sources/search?source=${encodeURIComponent(solo)}&q=${encodeURIComponent(term)}&page=${next}`);
      fresh = freshCards(shown, r.content ?? []);
    } catch { /* the end, as an empty page is */ }
    setMore((m) => {
      const base = m.key === key ? m : noMore(key);
      return { key, items: [...base.items, ...fresh], page: next, done: fresh.length === 0 };
    });
    setMoreBusy(false);
  }, [solo, moreKey, more, searchHits, term]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !canMore) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) void loadMore(); }, { rootMargin: '800px' });
    io.observe(el);
    return () => io.disconnect();
  }, [canMore, loadMore]);

  // ---------------------------------------------------------------- jobs
  // The shared jobs answer, read from the cache AppShell's one poller keeps fresh (lib/useServerDownloads.ts):
  // a poll of this page's own would double the requests while an add downloads.
  const { data: jobsData } = useServerDownloads();
  // A finished job stays on the server for a day now (Library -> Downloads lists them, #82); this strip keeps
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
  /**
   * The hero's stand-in (v0.98.0): while Korea's answer is on its way, or the server is still pulling a copy it has never
   * had, the hero's own box holds its place -- the page used to render without it and shove everything down when it came.
   */
  const heroWaiting = trendQ.isPending
    || heroPoll(trending, qc.getQueryState(['discover-trending', 'KR'])?.dataUpdateCount ?? 0) !== false;
  // Each trending row's cards, with the rank each holds in its country's list, less what this visit added from it (v0.61.0):
  // Korea's, Japan's, China's, in TREND_RAILS' order. Korea's is its whole list since v0.98.0, not what the hero did not take.
  const jpTrending = moreTrending[0]?.data;
  const cnTrending = moreTrending[1]?.data;
  const trendRails = useMemo(() => [trending?.content ?? [], jpTrending?.content ?? [], cnTrending?.content ?? []]
    .map((list) => list.map((t, k) => ({ t, rank: k + 1 })).filter(({ t }) => !railAdded.has(railKey(t)))),
  [trending, jpTrending, cnTrending, railAdded]);
  // The one picks row (v0.98.0, lib/forYou.ts): the trackers' suggestions and the reads' picks in turn, one card a title,
  // less what this visit added from it.
  const picks = useMemo(() => mergePicks(recsQ.data?.content ?? [], because?.content ?? [], because?.seed ?? null)
    .filter((pk) => !railAdded.has(railKey(pk))), [recsQ.data, because, railAdded]);
  /**
   * Which rows the wall carries (v0.98.0): each with something on it, and only once every row's first answer is in -- the
   * rows take their places in order, and a row arriving late would take one another already stood in.
   */
  const rowsReady = heroSettled && !recsQ.isPending && !becauseQ.isPending && moreTrending.every((m) => !m.isPending);
  const rowKeys: RowKey[] = mode === 'newest' && rowsReady
    ? ROWS.filter((k) => (k === 'foryou' ? picks.length : trendRails[TREND_RAILS.indexOf(k)].length) > 0)
    : [];

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
              ? tr('Add a site, or turn on an extension source, in Admin → Sources.')
              : tr('Add a site or an extension in Admin → Sources, or mount a source pack at SOURCES_DIR.')} />
        ) : (
          <EmptyState art={ART.emptyLibrary} title={tr('No sources available')}
            sub={tr('There is nothing set up for your account to browse yet. Ask whoever runs this server.')} />
        )}
      </div>
    );
  }

  // The wall cut where its rows go (v0.98.0): the runs of covers, the rows between them, and the rows still waiting.
  const wallKey = `${mode}|${listMode}|${selected ?? ''}`;
  if (placedRef.current.key !== wallKey) { placedRef.current = { key: wallKey, placed: new Map() }; shownRef.current = 0; }
  placedRef.current.placed = placeRows(placedRef.current.placed, rowKeys, shownRef.current, cols);
  const { parts: wallParts, after: rowsAfter } = weave(wall.items.length, cols, placedRef.current.placed);
  const lastPart = wallParts[wallParts.length - 1] as { kind: 'cards'; from: number; to: number };
  // Every card names its sources, one of them or five, in Newest, Popular and search alike (v0.56.0).
  const cardsOf = (from: number, to: number) => wall.items.slice(from, to).map((it, k) => (
    <SourceCard key={`${it.source}:${it.sourceId}`} item={{ ...it, inLibrary: it.inLibrary || shownAdded.has(workKey(it)) }}
      providers={stackOf(it)}
      onAdd={() => open(it)} eager={from + k < 12} />
  ));
  // One of the rows: the picks, each saying why it is there, or a trending row, its first ten ranked. The read a pick came
  // from is isolated in its sentence, as Home's "Because you read" is: a Latin title inside an Arabic one keeps its order.
  const whyOf = (pk: Pick) => {
    const reason = pk.from.because ? tr('Because you read {title}', { title: `\u2068${pk.from.because}\u2069` }) : undefined;
    return pk.from.kind === 'tracker'
      ? { badge: pk.from.badge, reason, tip: pk.from.tip }
      : { reason, art: img.seriesThumb(pk.from.seriesId), tip: reason };
  };
  const rowOf = (key: RowKey) => (key === 'foryou' ? (
    <AniListRail key={key} kind={key} title={tr('Recommended for you')}>
      {picks.map((pk, i) => (
        <Reveal key={railKey(pk)} delay={Math.min(i, 12) * 28}>
          <TrendingCard t={pk} onPick={pickRail} why={whyOf(pk)} />
        </Reveal>
      ))}
    </AniListRail>
  ) : (
    <AniListRail key={key} kind={key} title={tr(TREND_LABELS[TREND_RAILS.indexOf(key)])}>
      {trendRails[TREND_RAILS.indexOf(key)].map(({ t, rank }, i) => (
        <Reveal key={railKey(t)} delay={Math.min(i, 12) * 28}>
          <TrendingCard t={t} onPick={pickRail} rank={rank <= RANKED ? rank : undefined} />
        </Reveal>
      ))}
    </AniListRail>
  ));

  return (
    <div className="min-h-screen-d px-4 lg:px-0">
      {/* The hero, or while Korea's answer is on its way its own box holding its place (v0.98.0). */}
      {mode === 'newest' && (heroSlides.length > 0 || heroWaiting) && (
        <DiscoverHero slides={heroSlides} waiting={heroWaiting} onPick={(t) => setSeed({ kind: 'trending', title: t.title })} />
      )}

      <header className="pt-5 lg:pt-7">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            {/* The listing's name is the wall's own heading, a few lines down (v0.98.0: it was said here as well). */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <h1 className="font-display text-2xl font-bold tracking-tight lg:text-3xl">{tr('Discover')}</h1>
              {/* In the HEADER and not on the chip row below, deliberately: a chip anchored there would sit among the
                  wall's own controls -- and search is one of the surfaces the reveal changes. */}
              <AdultToggle alsoWhen={showAdultChip} className="shrink-0 text-xs" />
            </div>
            <p className="mt-1 max-w-prose text-[11px] text-fog-500">
              {tr('Manual AniList actions can contact AniList even when automatic lookups are off.')}
            </p>
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
        // The chip's number is the whole pool: every source that can answer this listing. Since v0.58.0 that is
        // also every source asked; it was a budget of six widening to ten, and a ranked list capped at twelve,
        // and "12 sources" on a 14-source install was simply false.
        count={pool.length}
        selected={selected} onSelect={setSelected}
        mode={listMode}
        // The source shown alone stays chosen when the other listing has it: flipping dropped it, so one source's Newest
        // flipped to every source's Popular.
        onMode={(m) => {
          setListMode(m); setSelected(selected && budgetForMode(sources, m, Infinity).some((s) => s.id === selected) ? selected : null);
          setPage(1); if (mode === 'search') backToNewest();
        }}
      />

      {/* One mounted child per source asked -- every one in the pool -- and `enabled` only while the gate lets it
          (four at a time). Renders nothing; owns one request.
          The key carries the listing mode, so switching Newest/Popular REMOUNTS these and they fetch the
          other listing. That pairing is not optional: a child that keeps its key keeps its cached query,
          never re-reports, and the wall waits forever on a source it thinks it has not heard from. */}
      {mode === 'newest' && budget.map((s, i) => (
        <SourceLatest key={`${listMode}:${s.id}:${page}`} source={s} listMode={listMode}
          page={page} enabled={i < gate} onSettled={onSettled} />
      ))}

      {jobs.length > 0 && (
        <div className="board mt-5">
          {/* Each card opens its series once it has one, else its tile in Library -> Downloads, where it can be
              followed, cancelled or retried -- and nothing when that view does not list it (`stripHref`). */}
          {jobs.map((j) => {
            const href = stripHref(j);
            const face = (
              <>
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
                  <p dir="auto" className="mt-1 text-[11px] text-amber-300">{reasonText(j) || tr('Fetch stopped. Try another source or wait.')}</p>
                ) : j.cancelled ? (
                  // Stopped by its Cancel (#82): `done`, but "Fetched" in emerald would claim the whole run landed.
                  <p dir="auto" className="mt-1 text-[11px] text-fog-400">{reasonText(j) || tr('Cancelled; what landed is kept.')}</p>
                ) : j.total === 0 && j.autoFollow ? (
                  // A "Nothing yet" add that asked for the other sources leaves a card with no chapters on it,
                  // only the judgement: it is not a fetch and must not read as one. "Fetched" in emerald sat
                  // under the series a person had just declined to fetch, for five minutes.
                  <p className="mt-1 text-[11px] text-fog-500">{j.autoFollow.done ? tr('Checked other sources') : tr('Checking other sources…')}</p>
                ) : (
                  <p className="mt-1 text-[11px] text-emerald-400">{tr('Fetched')}</p>
                )}
              </>
            );
            const cls = `card block p-3 ${j.status === 'error' ? 'border-amber-500/40' : ''}`;
            return href
              ? <Link key={j.folder} href={href} data-job-card className={`${cls} transition hover:border-accent/40`}>{face}</Link>
              : <div key={j.folder} data-job-card className={cls}>{face}</div>;
          })}
        </div>
      )}
      {jobs.length > 0 && (
        <p className="mt-2 text-end">
          <Link href={downloadsHref()} className="text-xs font-medium text-accent hover:underline">{tr('See all')}</Link>
        </p>
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
        {/* The 18+ filter (v0.55.4, #158), on its own row under the heading: three chips do not fit beside it at 390 px.
            Search mode only, and only while it can change something (`offerRating`). */}
        {mode === 'search' && offerRating && (
          <div role="group" aria-label={tr('18+ filter')} className="flex basis-full flex-wrap items-center gap-1.5" data-rating-chips>
            {([['all', tr('All')], ['safe', tr('Hide 18+')], ['adult', tr('18+ only')]] as const).map(([key, label]) => (
              <button key={key} type="button" onClick={() => setRating(key)} aria-pressed={rating === key}
                className={`chip text-xs ${rating === key ? 'chip-active' : ''}`}>{label}</button>
            ))}
          </div>
        )}
        {/* Search's own progress, on its own row: with three source names it does not fit beside the
            heading at 390 px, and it is gone the moment the last source answers. Announced, since the wall
            it describes changes under a screen reader without a focus change. */}
        {mode === 'search' && progress && (
          <p className="basis-full text-xs tabular-nums text-fog-500" aria-live="polite" data-search-progress>
            {progress}
          </p>
        )}
      </div>

      {/* Discover's rows inside the wall while browsing (v0.98.0, lib/shelves.ts): the picks after its first two rows of
          covers, each trending row four rows further on. Each run of covers between two rows is a grid of its own with the
          wall's classes; the last run, below, holds what is still loading and is the one measured. */}
      {wallParts.slice(0, -1).map((part, n) => (part.kind === 'row' ? rowOf(part.key) : (
        <div key={`wall${n}`} className={WALL_GRID} data-wall-part>{cardsOf(part.from, part.to)}</div>
      )))}
      <div ref={setWallEl} className={WALL_GRID} data-wall-part>
        {cardsOf(lastPart.from, lastPart.to)}
        {/* The next page of a search on one source on its way (#331), after the cards: it is asked only once every source
            has answered, so the still-loading card below is never beside it. */}
        {mode === 'search' && moreBusy && Array.from({ length: 3 }).map((_, i) => (
          <div key={`mk${i}`} className="skeleton aspect-[2/3] rounded-2xl" data-search-more />
        ))}
        {!wall.items.length && Array.from({ length: Math.min(18, pending * 6) }).map((_, i) => (
          <div key={`sk${i}`} className="skeleton aspect-[2/3] rounded-2xl" />
        ))}
        {/* The last tile while any source asked has not answered (v0.58.0): who, so the end of the wall says more is
            coming. Gone once every one has. */}
        {waitingOn.length > 0 && <StillLoadingCard names={waitingOn} shown={SEARCH_NAMES_SHOWN} />}
      </div>

      {/* No "no results" while sources are still being asked: the first answer often has nothing yet and the
          sentence would be a verdict on a search that is still running. The progress line covers that gap. */}
      {!wall.items.length && !pending && !stillAsking && (
        <div className="card col-span-full mt-2 p-8 text-center">
          <p className={`text-sm ${alone?.warn ? 'text-amber-300' : 'text-fog-400'}`}>
            {mode === 'search' ? (searchQ.isError ? tr('Search failed') : tr('No results across your sources — try another title.'))
              // Only an admin can act on the first sentence; a member told to open Admin has nowhere to go.
              : budget.length === 0 ? (isAdmin ? tr('No sources are set up yet. Add one in Admin \u2192 Sources.') : tr('No sources are set up yet. Ask whoever runs this server.'))
              // One source alone: its reason, amber, before any sentence about the wall as a whole.
              : alone ? alone.text
              // The sources asked now, as the wall and its count read them (#319): a source hidden since, or the other
              // listing's, says nothing about whether these could be reached.
              : budget.every((s) => states[kOf(s.id)] === 'blocked')
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

      {/* The rows the wall has not reached yet, in order, where they would come anyway (v0.98.0). */}
      {rowsAfter.map(rowOf)}

      {seed && (
        <AddSeriesDialog
          seed={seed}
          sources={budgetIds}
          // Following a source is an admin act, like the manual follow route and the sheet's ×: a member
          // who may add must not be able to follow two sources they could never unfollow.
          mayFollow={isAdmin}
          onClose={() => { fromKey.current = null; setSeed(null); }}
          onAdded={(r) => {
            // The card the dialog came from, by its work: off the wall, "In library" in a search. From the hero there is
            // no card, and every card under the added title goes, as the title flipped them before v0.56.0.
            const title = normTitle(r.title);
            const keys = fromKey.current ? [fromKey.current] : title ? wall.items.filter((c) => normTitle(c.title) === title).map(workKey) : [];
            setAdded((prev) => new Set([...prev, ...keys.filter(Boolean)]));
            // From an AniList rail (v0.61.0): that card leaves its rail.
            const railCard = fromRail.current;
            if (railCard) setRailAdded((prev) => new Set(prev).add(railCard));
            qc.invalidateQueries({ queryKey: ['source-jobs'] });
          }}
        />
      )}
    </div>
  );
}

/**
 * The page, inside the Suspense boundary `useSearchParams` needs in a static export (v0.61.0: `?q=`), as the Library's
 * and a List's pages are: the build refuses a page that reads the address outside one.
 */
export default function DiscoverPage() {
  return (
    <Suspense fallback={<div className="min-h-screen-d" />}>
      <DiscoverInner />
    </Suspense>
  );
}
