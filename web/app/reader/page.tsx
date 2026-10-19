'use client';
import { ScrollRail, CARD_RAIL } from '@/components/ScrollRail';
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isWide, joinedOrder, pageHeight, pairSlides, type WidePages } from '@/lib/readerSpread';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { api, apiWithHeaders, img } from '@/lib/api';
import { fetchAllBooks } from '@/lib/seriesBooks';
import { chapterOutcome } from '@/lib/readerState';
import { openableChapters } from '@/lib/chapterRows';
import { buildFlow, startIndex, renderWindow } from '@/lib/readerFlow';
import { drawnWidth, fitWidth, neverSofter } from '@/lib/readerFit';
import { AHEAD_SCREENS, APPEND_SCREENS, BEHIND_SCREENS, KEEP_SCREENS, MAX_WINDOW_PAGES, anchorAt, nearEnd, prefetchList, screenRange, scrollTopFor, windowSet, type IndexRange } from '@/lib/readerWindow';
import { readTap, undoLeft, undoWindow, type TapZone } from '@/lib/readerGesture';
import { PAGE_ACTIONS, READER_ACTIONS, actionForKey, keyMapFor, type ReaderAction } from '@/lib/readerKeys';
import { padMapFor } from '@/lib/readerPad';
import { useGamepad } from '@/lib/useGamepad';
import { ARM_MS, gapsBetween, pagesAfter, skipNeedsConfirm, stillArmed, type GapRun } from '@/lib/readerNav';
import { Book, EditionRow, Page, PageInfo, Series } from '@/lib/types';
import { useAuth, canDownload } from '@/lib/auth';
import { activeLocale, chapterLabel, languageName } from '@/lib/format';
import { editionChipLabels, readerTarget } from '@/lib/editions';
import { numLabel } from '@/lib/numbering';
import { useToast } from '@/components/Toast';
import { deviceId } from '@/lib/device';
import { ReaderEndLabel, ReaderEndRadar } from '@/components/ReaderEndRadar';
import { getOfflineChapter, getPageBlob, queueProgress, noteOfflineProgress, listSeriesDownloads, setOfflinePageJunk, setOfflineSpreadMarks } from '@/lib/downloads';
import { applyMarks, markOf, saveMark, spreadOptions, withMark, type SpreadMark, type SpreadOption } from '@/lib/spreadMarks';
import { applyCover, clearCover } from '@/lib/theme';
import { COLOR_FILTER, glide, loadDevicePrefs, saveDevicePrefs, type DevicePrefs } from '@/lib/readerDevice';
import { ReaderPrefs, loadPrefs, savePrefs, loadSeriesPrefs, saveSeriesPrefs, syncPrefsFromServer, THEME_FILTER, loadSourcePrefs, saveSourcePrefs, clearSourcePrefs, globalPrefsChange, seriesPinChange, titleLook, mergePulled, rememberSeriesSource, seriesSourceOf, rememberSeriesType, seriesTypeOf, rememberLibraryLook, libraryLookOf, type LibraryLook } from '@/lib/readerPrefs';
import { guessMode, type AutoGuess } from '@/lib/readerAuto';
import { translatedSrc, translating, type TranslateStatus } from '@/lib/readerTranslate';
import { ReaderSettings } from '@/components/ReaderSettings';
import { SectionTitle, useImgRetry, useRtl } from '@/components/ui';
import { PageGrid } from '@/components/PageGrid';
import { ChapterSheet } from '@/components/ChapterSheet';
import { SeriesCard } from '@/components/cards';
import { NextInStory } from '@/components/RelatedRail';
import { IcChevronLeft, IcChevronRight, IcSliders, IcGrid, IcComment } from '@/components/icons';
import { SEAM_H, useChapterTalk, useTalkOn } from '@/lib/comments';
import { ChapterTalkSheet, TalkKey, TalkStrip } from '@/components/ChapterTalk';
import { ReaderImg, MissingCaption, ReaderPageRow, SlidePending, SlideRegion, SlideTurned, SlideTurnedPair, DIVIDER_H, measurePage } from '@/components/ReaderPage';
import { CHAPTER_SAMPLE, LEFT_HALF, RIGHT_HALF, WHOLE, chapterSideCrop, halfCrop, pairCrop, type Region } from '@/lib/readerCrop';
import { t as tr } from '@/lib/i18n';
import { serverReachableHint } from '@/lib/desktop';
import { IncognitoTag, incognitoRef } from '@/components/IncognitoBanner';
import { useContextMenu, type MenuItem } from '@/components/ContextMenu';
import { ReaderShortcuts, useHasKeyboard } from '@/components/ReaderShortcuts';
import { capLabel } from '@/components/ReaderKeys';

interface PageDim { number: number; width: number | null; height: number | null; junk?: boolean; missing?: boolean; join?: 'rtl' | 'ltr'; mark?: SpreadMark }
/**
 * `sourceId`: the adapter the copy came from, for naming it on a missing page's caption. Unknown for a downloaded copy.
 * `spreads` (#229, Join split double pages): what the server said of the chapter's spreads when asked (`x-spreads`):
 * found (`done`, the joins on its pages), still being measured (`pending`, asked again shortly), or `none` to find; unset
 * when it was not asked -- joining off, or a downloaded copy, which carries what was found when it was saved.
 */
interface Chapter { id: string; seriesId: string; seriesTitle: string; title: string; pages: PageDim[]; offline: boolean; readingDirection?: string | null; pruned?: boolean; sourceId?: string | null; spreads?: 'done' | 'pending' | 'none' }
interface ChapterRef { id: string; label: string }
interface FlatItem { ci: number; number: number; width: number | null; height: number | null; key: string; firstOfChapter: boolean; junk?: boolean; join?: 'rtl' | 'ltr'; mark?: SpreadMark; forced?: boolean; missing?: boolean; collapsed?: boolean }

/**
 * #229: when to ask again for a chapter whose spreads the server is still measuring, after each `pending`: then the
 * chapter is left as it is until it is next opened. The measure takes a second or two a chapter when nothing waits.
 */
const SPREAD_ASKS = [1500, 4000, 10000];

/** Paged mode's render window, in pages: a slide is one screen, so pages and screens are the same thing there. */
const WINDOW_BEHIND = 2;
const WINDOW_AHEAD = 6;
/** How far down the screen the page being read is taken from -- in the webtoon column, the page under this line. */
const PROBE = 0.4;
/** What the webtoon column fetches ahead of its window, as bytes only (lib/readerWindow.ts prefetchList). */
const PREFETCH = { pages: 6, pixels: 48e6 };
/**
 * How tall a collapsed page is. Enough to read as a band OF SOMETHING -- you can see it is a credit page --
 * without being tall enough to interrupt a scroll. A sibling of DIVIDER_H, and reserved the same way.
 */
const STRIP_H = 48;

/** How long a track must have been still before slides are added to it (see untilStill). */
const STILL_MS = 250;

/**
 * Resolve once a right-to-left paged track has stopped moving -- at once for any other track.
 *
 * ⚠️ Chrome keeps an in-flight smooth scroll's destination in physical pixels from the LEFT edge, and a
 * right-to-left track grows leftwards. The reader appends the next chapter four pages before the end, which
 * is while a page turn (or a swipe's snap) is still animating, so the destination moved by the whole width
 * added and the reader landed deep inside the next chapter: fourteen pages on, measured on a twelve-page
 * chapter, and one page on when only the Up Next card was added. A still track keeps its place when content
 * is added, so a right-to-left track is appended to only once it has been still for a moment. Left-to-right
 * tracks grow away from their origin and never moved, so they do not wait. Bounded, so a track that never
 * settles still gets its next chapter, as it always did.
 * This was reachable since v0.46.0 by choosing Right to left; #102 made it the default for every Japanese
 * series, which is why it was found. It is a browser behaviour, so no unit test can hold it; the guard is
 * test/e2e/walk48.mjs step 3, "every press moves exactly one page" -- the same fourteen presses, traced before
 * this existed, moved one page thirteen times and fourteen pages once.
 */
async function untilStill(lastMoved: { current: number }, rtl: boolean): Promise<void> {
  if (!rtl) return;
  for (let i = 0; i < 40 && Date.now() - lastMoved.current < STILL_MS; i++) await new Promise((r) => setTimeout(r, 100));
}

/**
 * Whether the screen is held upright (v0.61.0): what Reader → Wide pages waits for. A double-page spread on a phone held
 * upright is a strip across the middle of the screen; held sideways, or on a computer's screen, it fits as it is.
 */
function usePortrait(): boolean {
  const [portrait, setPortrait] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.('(orientation: portrait)');
    if (!mq) return;
    const read = () => setPortrait(mq.matches);
    read();
    mq.addEventListener?.('change', read);
    return () => mq.removeEventListener?.('change', read);
  }, []);
  return portrait;
}

/**
 * A chapter's page list as the reader keeps it. `spreads` (#229): asked with ?spreads=1 by a reader who turned Join split
 * double pages on -- the pages a source cut from one spread then carry `join` -- and the server's word on them with it.
 */
async function pageList(bookId: string, spreads: boolean): Promise<{ pages: PageDim[]; spreads?: Chapter['spreads'] }> {
  const { data, headers } = await apiWithHeaders<PageInfo[]>(`/api/books/${bookId}/pages${spreads ? '?spreads=1' : ''}`);
  const said = headers.get('x-spreads');
  return {
    pages: data.map((p) => ({ number: p.number, width: p.width ?? null, height: p.height ?? null, junk: p.junk, missing: p.missing, join: p.join, mark: p.mark })),
    spreads: spreads ? (said === 'done' || said === 'pending' ? said : 'none') : undefined,
  };
}

async function loadChapter(bookId: string, spreads = false): Promise<Chapter | null> {
  const off = await getOfflineChapter(bookId);
  if (off) {
    return { id: bookId, seriesId: off.seriesId, seriesTitle: off.seriesTitle, title: off.title, pages: off.pages, offline: true, readingDirection: off.readingDirection };
  }
  try {
    const b = await api<Book>(`/api/books/${bookId}`);
    const list = await pageList(bookId, spreads);
    return {
      id: bookId,
      seriesId: b.seriesId,
      seriesTitle: b.seriesTitle,
      title: b.metadata?.title || b.name,
      pages: list.pages,
      offline: false,
      // The server deleted this chapter's file after everyone finished it. Carried so the empty page list
      // below can be explained rather than blamed on the reader's library mount.
      pruned: b.pruned === true,
      sourceId: b.sourceId ?? null,
      spreads: list.spreads,
    };
  } catch {
    return null;
  }
}

function ReaderInner() {
  const sp = useSearchParams();
  const bookId = sp.get('book') || '';
  /**
   * A deep link to one page -- what a saved Moment resolves to.
   *
   * An explicit `?page=` ALWAYS beats resume-from-progress, and skips the resume read entirely. A deep link is
   * a request; resume is an inference about where you would rather be. Skipping the read is also what makes a
   * Moment openable with no network, since the resume call is the thing that throws offline.
   */
  const wantPage = Math.max(0, Math.floor(Number(sp.get('page')) || 0));
  /** `?page=last`: opened by stepping BACK a chapter, so land where that chapter ends. Same authority as `?page=`. */
  const wantLast = sp.get('page') === 'last';
  const router = useRouter();

  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [chapterRefs, setChapterRefs] = useState<ChapterRef[]>([]);
  /** Whether the chapter list came from the server, from what is downloaded, or nowhere yet. */
  const [refsFrom, setRefsFrom] = useState<'live' | 'offline' | 'none'>('none');
  const [startPage, setStartPage] = useState(1);
  const [ready, setReady] = useState(false);
  const [ended, setEnded] = useState(false); // reached the last chapter of the series → show Up Next
  /**
   * The chapter could not be read. There was no such state at all, and three different upstream causes all
   * arrived as one: a corrupt CBZ or an unmounted library answers `200 []` from the pages endpoint, while a
   * book this account may not see throws 404. On first load both set `ready` with nothing behind it, which
   * cleared the loading overlay and left a full-screen black rectangle. Mid-series both took the SAME branch
   * as a genuine end of series, so a transient error told the reader "You finished".
   */
  const [failed, setFailed] = useState<null | 'unreadable' | 'unavailable' | 'pruned'>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [prefs, setPrefs] = useState<ReaderPrefs>(loadPrefs());
  /** Whether the open title's look is in `prefs` yet: a pull of the account's settings then leaves the look alone (mergePulled). */
  const titleOpen = useRef(false);
  /**
   * The mode the automatic pick chose for the open title (v0.61.0, lib/readerAuto.ts), or null when the mode is a
   * default's or a memory's -- the sheet says which. `autoGuess` is the pick itself, kept to apply again when the
   * switch is turned on in the sheet.
   */
  const [autoApplied, setAutoApplied] = useState<AutoGuess | null>(null);
  const autoGuess = useRef<AutoGuess | null>(null);
  /** This device's own reader settings (v0.61.0, lib/readerDevice.ts): kept in this browser, never synced. */
  const [device, setDeviceState] = useState<DevicePrefs>(loadDevicePrefs);
  const setDevice = (p: Partial<DevicePrefs>) => setDeviceState((cur) => { const n = { ...cur, ...p }; saveDevicePrefs(n); return n; });
  /** The colour filter over every page IMAGE (never the column, the track or a card), and how a move moves under it. */
  const imgFilter = COLOR_FILTER[device.colorFilter];
  const behavior = glide(device.colorFilter);
  const [zoom, setZoom] = useState(1);
  // Shift pairs by one page, the title's memory like the zoom (lib/readerSpread.ts pairSlides `shift`).
  const [spreadShift, setSpreadShift] = useState(false);
  // Translated pages (v0.85.0, lib/readerTranslate.ts): the title's memory like the shift, offered only while the server
  // has the engine and the switch on. Each chapter's translated pages and their stamps, as the server last said.
  const [translate, setTranslate] = useState(false);
  const { data: trOffer } = useQuery({
    queryKey: ['translate-available'],
    queryFn: () => api<{ available: boolean }>('/api/translate'),
    staleTime: 5 * 60_000,
  });
  const trOn = translate && !!trOffer?.available;
  const trLang = activeLocale();
  const [trStatus, setTrStatus] = useState<Record<string, TranslateStatus>>({});
  /**
   * One page of the pair on screen brought into frame (#232 by a tap, #261 by the `focus` key): the slide then shows that
   * page alone. Only ever a view of a slide that holds two pages, so nothing that counts pages -- progress, the counter,
   * bookmarks -- sees it; it goes when the track leaves the slide or the slides are laid out again.
   */
  const [focus, setFocus] = useState<{ slide: number; page: number } | null>(null);
  const [rtl, setRtl] = useState(false); // series reads right-to-left → double-spread pair order flips
  // Paged mode's track direction: the reader setting (lib/readerPrefs.ts `pagedDirection`), or the series'
  // own direction above when it says `series`. `trackSign` turns a slide index into a scrollLeft: an RTL
  // track scrolls negative.
  // ⚠️ The track states its `dir` either way rather than inheriting it. Under the Arabic UI <html> is
  // dir="rtl", so the track used to inherit a right-to-left layout that the positive-scrollLeft maths below
  // never expected: the page counter sat on 1 and a jump or a resume clamped to the first page.
  const pagedRtl = prefs.mode === 'paged' && (prefs.pagedDirection === 'rtl' || (prefs.pagedDirection === 'series' && rtl));
  const trackSign = pagedRtl ? -1 : 1;
  // The direction the track was last laid out for, so the flip effect below acts only on a REAL flip.
  const laidOutSign = useRef<number | null>(null);
  /** The mode the scroller was last laid out for (F3, the mode-change effect below). */
  const laidOutMode = useRef<ReaderPrefs['mode'] | null>(null);
  /** Whether the paged track was last laid out with wide pages split in two (the split effect below). */
  const laidOutSplit = useRef<boolean | null>(null);
  /** the pairing the paged track was laid out for: spreads on or off, shifted or not. */
  const laidOutPairs = useRef<string | null>(null);
  /** The joined spreads the paged track was last laid out with (#229, the joins effect below), as the slides' first pages. */
  const laidOutJoins = useRef<string | null>(null);
  /** When the track last moved -- a scroll event, or a smooth scroll this code started. See untilStill. */
  const lastMoved = useRef(0);
  // The interface's own direction, for the text that sits INSIDE the track and would otherwise take the
  // track's: an Arabic caption in an LTR paragraph, or an English one in RTL on a right-to-left read.
  const uiDir = useRtl() ? 'rtl' : 'ltr';
  const [scrubbing, setScrubbing] = useState(false); // slider drag in progress → show the page preview

  const [chrome, setChrome] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showPages, setShowPages] = useState(false);
  const [showChapters, setShowChapters] = useState(false);
  /** Whether the right-click menu is open (it is made further down): the keys are its while it is, Escape included. */
  const menuOpen = useRef(false);
  const [showKeys, setShowKeys] = useState(false);
  /** The chapter whose talk is open in its sheet (v0.87.0, components/ChapterTalk.tsx), by id; null while none is. */
  const [talkFor, setTalkFor] = useState<string | null>(null);
  const openTalk = useCallback((id: string) => setTalkFor(id), []);
  const hasKeyboard = useHasKeyboard();
  const [current, setCurrent] = useState(0);
  const { user } = useAuth();
  /** Source id -> display name from the series' own followed sources (set with the reading direction). */
  const [seriesSourceNames, setSeriesSourceNames] = useState<Record<string, string>>({});
  // The series' PRIMARY source, which keys the per-source reader default (lib/readerPrefs.ts seriesSourceOf).
  const [seriesSource, setSeriesSource] = useState<{ id: string; name: string } | null>(null);
  // The library the series is in (admins only) and the reading defaults it carries (everyone): they sit under the source's own.
  const [seriesLibrary, setSeriesLibrary] = useState<{ id: string; name: string } | null>(null);
  const [libraryLook, setLibraryLook] = useState<LibraryLook | null>(null);
  // The work's language editions (v0.52.0, #72), for the chapter sheet's chips, and each chapter's number, which a
  // switch to another edition opens there. Both from requests the page makes anyway.
  const [editions, setEditions] = useState<EditionRow[] | null>(null);
  const [numberOf, setNumberOf] = useState<Map<string, number>>(new Map());
  const toast = useToast();

  const scrollRef = useRef<HTMLDivElement>(null);
  const [colW, setColW] = useState(0);
  const didInitScroll = useRef(false);
  /** The last `chapterId:page` a progress ping was sent for. Declared here rather than beside sendProgress
   *  because the initial-scroll effect seeds it, and that effect is defined above sendProgress. */
  const lastSent = useRef('');
  const blobUrls = useRef<Map<string, string>>(new Map());
  const appending = useRef(false);
  /** Where the paged track stood just before the next chapter or a closing card was added to it, and when (#180). */
  const appendAnchor = useRef<{ left: number; at: number } | null>(null);
  /** #229: how many times each chapter's spreads were asked for again, and the asks still out (the spreads effect). */
  const spreadTries = useRef<Map<string, number>>(new Map());
  const spreadAsking = useRef<Set<string>>(new Set());
  const noMore = useRef(false);
  const tap = useRef<{ x: number; y: number; t: number } | null>(null);
  const lastTapAt = useRef(0);
  const tapTimer = useRef<any>(null);
  /**
   * What a tap did, and when -- so a `dblclick` that arrives after it can take it back. Only a mouse gets
   * that far: the OS decides how long a double-click may take (Windows defaults to 500 ms), so the single
   * click of a slow double-click has already acted by the time the browser says the two were one gesture.
   */
  const acted = useRef<{ kind: 'turn'; slide: number; at: number } | { kind: 'scroll'; top: number; at: number } | { kind: 'chrome'; at: number }
    | { kind: 'focus'; prev: { slide: number; page: number } | null; at: number } | null>(null);
  /** When the pointer path handled a double-tap itself. A touch double-tap also raises `dblclick`, and
   *  zooming for both halves of the same gesture would put the zoom straight back where it started. */
  const handledDouble = useRef(0);
  /** When any double (touch or mouse) was last recognised, so the press right behind it is not a fresh tap. */
  const lastDoubleAt = useRef(0);
  /** When "next chapter" was last pressed without being confirmed (null = not armed). See readerNav.ts. */
  const [armedNext, setArmedNext] = useState<number | null>(null);
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  /** What the last press on the page was made with, for the right-click menu below: a touch long-press is not a right click. */
  const lastPointer = useRef('mouse');
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);

  const seriesId0 = chapters[0]?.seriesId || '';
  const setPref = (p: Partial<ReaderPrefs>) => {
    // v0.61.0: switching the automatic pick on or off decides the open title's MODE again -- by the same rules it opened
    // by (titleLook), so a title with a mode of its own keeps it -- and nothing else about it.
    if (p.autoMode !== undefined) {
      savePrefs({ ...loadPrefs(), autoMode: p.autoMode });
      if (seriesId0) {
        const look = titleLook(loadPrefs(), { ...(libraryLook ?? {}), ...(seriesSource ? loadSourcePrefs(seriesSource.id) : {}) }, loadSeriesPrefs(seriesId0), autoGuess.current);
        setAutoApplied(look.autoApplied);
        setPrefs((cur) => ({ ...cur, autoMode: p.autoMode!, mode: look.prefs.mode }));
      } else {
        setPrefs((cur) => ({ ...cur, autoMode: p.autoMode! }));
      }
      return;
    }
    // Tapping Mode makes it the title's own, automatic or not (seriesPinChange pins it).
    if (p.mode) setAutoApplied(null);
    setPrefs((cur) => {
      const n = { ...cur, ...p };
      // The global default takes only what this change touched, and never a title's look while a title is
      // open (globalPrefsChange says why): merged into what is STORED, not into `cur`, which carries the
      // source's and the series' settings laid over the default.
      const g = globalPrefsChange(p, !!seriesId0);
      if (Object.keys(g).length) savePrefs({ ...loadPrefs(), ...g });
      // The title's own memory takes the look, and the direction only when it was the direction that changed
      // (seriesPinChange says why: pinning it on every change kept the profile's direction out, #102).
      // A mode the automatic pick chose is left out of a pin that a theme or a spread caused (v0.61.0).
      const pin = seriesId0 ? seriesPinChange(p, n, { autoApplied: p.mode ? null : autoApplied }) : null;
      if (pin) saveSeriesPrefs(seriesId0, pin);
      return n;
    });
  };
  const applyShift = (v: boolean) => {
    setSpreadShift(v);
    if (seriesId0) saveSeriesPrefs(seriesId0, { spreadShift: v });
  };
  const applyTranslate = (v: boolean) => {
    setTranslate(v);
    if (seriesId0) saveSeriesPrefs(seriesId0, { translate: v });
  };
  const applyZoom = (z: number) => {
    const clamped = Math.max(1, Math.min(3, z));
    setZoom(clamped);
    if (seriesId0) saveSeriesPrefs(seriesId0, { zoom: clamped });
  };

  /** The chapter the address was last moved to by reading on, so the load below does not run for it (#263). */
  const urlSynced = useRef<string | null>(null);
  /**
   * The chapter the address names as far as the reader knows: the one the load below was made for, or the one reading on
   * moved the address to (`readingChapterId`). While the address names any other chapter, a jump to it is loading.
   */
  const addressed = useRef('');
  // ---- (re)load on bookId change ----
  useEffect(() => {
    // The address followed the reader into the next chapter (readingChapterId below): the chapters are all loaded already.
    if (urlSynced.current === bookId) { urlSynced.current = null; return; }
    urlSynced.current = null;
    addressed.current = bookId;
    let alive = true;
    setReady(false);
    setEnded(false);
    titleOpen.current = false;
    didInitScroll.current = false;
    appending.current = false;
    noMore.current = false;
    setRefsFrom('none');
    completedSent.current.clear();
    warnedGaps.current.clear();
    fitAsked.current.clear();
    spreadTries.current.clear();
    prevPos.current = null;
    setExpanded(new Set());   // a page opened by hand belongs to the chapter it was opened in
    setWin({ from: 0, to: -1 });
    anchorRef.current = null;
    blobUrls.current.forEach((u) => URL.revokeObjectURL(u));
    blobUrls.current.clear();
    (async () => {
      const first = await loadChapter(bookId, loadPrefs().joinSplit);
      if (!alive) return;
      setFailed(null);
      // Empty and absent are different sentences, and neither of them is silence.
      const outcome = chapterOutcome(first);
      // `|| !first` is for the type narrower's benefit; chapterOutcome already answers 'unavailable' for null.
      if (outcome !== 'ok' || !first) { setFailed(outcome === 'ok' ? 'unavailable' : outcome); setReady(true); return; }
      // Where to open, in order of authority: an explicit deep link, then the server, then this device.
      const clamp = (n: number) => Math.max(1, Math.min(n, first.pages.length || 1));
      if (wantLast) {
        setStartPage(clamp(first.pages.length || 1));
      } else if (wantPage > 0) {
        // Deep link. Deliberately does NOT read progress -- see wantPage above.
        setStartPage(clamp(wantPage));
      } else {
        // The server wins when it answers: progress is cross-device, and the outbox pushes this device's
        // offline position up to it. The downloaded copy is a fallback, not a peer.
        const canAsk = !(first.offline && !serverReachableHint());
        let resolved = 0;
        if (canAsk) {
          try {
            const b = await api<Book>(`/api/books/${bookId}`);
            if (b.readProgress && !b.readProgress.completed) resolved = b.readProgress.page;
            else resolved = 1;
          } catch { /* fall through to the offline copy */ }
        }
        if (!resolved && first.offline) {
          const off = await getOfflineChapter(bookId);
          if (off && !off.lastCompleted && off.lastPage) resolved = off.lastPage;
        }
        setStartPage(clamp(resolved || 1));
      }
      if (!alive) return;
      setChapters([first]);
      // The downloaded record has carried `readingDirection` since the store's v2 schema, and this used to
      // throw it away -- the comment here said the hint "is not available", when it was one field along the
      // object already in hand. The consequence was not subtle: right-to-left manga read offline paired its
      // double-page spreads in the wrong order, on exactly the titles most likely to be read on a plane.
      // Applied before the network attempt below so it holds even when that attempt never returns.
      if (first.offline && first.readingDirection) {
        setRtl(first.readingDirection === 'RIGHT_TO_LEFT');
      }
      // chapter list for prev/next/jump
      try {
        const list = await fetchAllBooks(first.seriesId);
        // ⚠️ A chapter the server's cleanup deleted is still a row in that list -- it has to be, it carries
        // everyone's progress -- and the first cut of "Chapter deleted" only handled the failure screen, so
        // next/prev walked straight onto the tombstone and showed it in the middle of a series that was
        // otherwise all there. Stepped over here, EXCEPT when this device holds a copy: then the offline
        // record is the last one anywhere, and the reader consults it before the server, so it opens fine.
        const saved = new Set((await listSeriesDownloads(first.seriesId).catch(() => [])).map((c) => c.bookId));
        if (alive) {
          setChapterRefs(openableChapters(list.content, saved).map((b) => ({ id: b.id, label: chapterLabel(b) })));
          setRefsFrom('live');
          setNumberOf(new Map(list.content.map((b) => [b.id, b.number])));
        }
      } catch {
        // Offline, this is the only list there is. Without it every downloaded chapter reported the end of the
        // series and prev/next were both dead, because an empty list reads as "there is no next chapter".
        try {
          const local = await listSeriesDownloads(first.seriesId);
          if (alive && local.length) {
            setChapterRefs(local.map((c) => ({ id: c.bookId, label: c.title || tr('Chapter {n}', { n: c.number }) })));
            setRefsFrom('offline');
          }
        } catch {}
      }
      // reading direction (drives double-spread pair order for RTL manga)
      let src: { id: string; name: string } | null = null;
      // What the automatic pick reads (v0.61.0): the series' type and direction, from the server -- or, offline, the type
      // this device last saw and the downloaded record's direction. The pages' shape is the chapter's own, either way.
      let seriesType = first.offline ? seriesTypeOf(first.seriesId) : null;
      let readsRtl = first.readingDirection === 'RIGHT_TO_LEFT';
      let libLook: LibraryLook | null = null;
      try {
        const s = await api<Series>(`/api/series/${first.seriesId}`);
        if (alive) {
          setRtl(s?.metadata?.readingDirection === 'RIGHT_TO_LEFT');
          libLook = s?.libraryReader ?? null;
          rememberLibraryLook(first.seriesId, libLook);
          setLibraryLook(libLook);
          setSeriesLibrary(s?.library ?? null);
          readsRtl = s?.metadata?.readingDirection === 'RIGHT_TO_LEFT';
          seriesType = s?.seriesType ?? null;
          rememberSeriesType(first.seriesId, seriesType);
          setEditions((s?.edition?.editions?.length ?? 0) > 1 ? s.edition!.editions! : null);
          // The followed sources' display names, for the caption on a page the source never served. Free:
          // this request is made anyway, and `sources` is sent to every viewer, unlike /api/sources.
          setSeriesSourceNames(Object.fromEntries((s?.sources ?? []).map((x) => [x.sourceId, x.name])));
          const primary = (s?.sources ?? []).find((x) => x.primary) ?? s?.sources?.[0];
          if (primary) {
            src = { id: primary.sourceId, name: primary.name };
            rememberSeriesSource(first.seriesId, src);
          }
          // Set either way (v0.61.0): a series with no source used to keep the previous series' (an edition switch),
          // and with it that source's default and its row in the sheet.
          setSeriesSource(src);
        }
      } catch {
        // offline: the downloaded record's direction, set above, stands, and the series' source is the one
        // this device saw the last time it opened the series online.
        src = seriesSourceOf(first.seriesId);
        seriesType = seriesTypeOf(first.seriesId);
        // And the library's reading defaults this device last saw (#235), so a downloaded chapter opens as it does online.
        libLook = libraryLookOf(first.seriesId);
        if (alive) { setSeriesSource(src); setLibraryLook(libLook); setSeriesLibrary(null); }
      }
      if (!alive) return;
      // F1 (v0.61.0): the title's look -- the stored default < its source's < its own (lib/readerPrefs.ts titleLook) --
      // in the SAME render as `ready`, so the initial scroll below lays out the mode the title opens in. It used to
      // arrive a render later, from an effect declared after the initial scroll: that scroll ran on the global mode,
      // the source's mode then swapped the scroller under it, and a resume at page 9 opened on page 1 with a counter
      // saying 9. The zoom is the series' memory too, and comes with it.
      // v0.61.0: and, when Pick the mode for each series is on, the mode the title's pages and type call for -- only where
      // neither its memory nor its source holds one (titleLook).
      const memory = loadSeriesPrefs(first.seriesId);
      autoGuess.current = guessMode({ pages: first.pages, type: seriesType, rtl: readsRtl });
      // The library's own reading defaults sit between the global default and the source's.
      const look = titleLook(loadPrefs(), { ...(libLook ?? {}), ...(src ? loadSourcePrefs(src.id) : {}) }, memory, autoGuess.current);
      setPrefs(look.prefs);
      setAutoApplied(look.autoApplied);
      setZoom(memory.zoom && memory.zoom >= 1 ? memory.zoom : 1);
      setSpreadShift(memory.spreadShift === true);
      setTranslate(memory.translate === true);
      titleOpen.current = true;
      setReady(true);
    })();
    return () => {
      alive = false;
      blobUrls.current.forEach((u) => URL.revokeObjectURL(u));
      blobUrls.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, reloadKey]);

  /**
   * Repeated pages the reader has asked to see, keyed per PAGE (`chapterId:number`).
   *
   * ⚠️ ONE axis, not two. There used to be a separate per-chapter `revealed` set beside this, whose comment
   * claimed it "resets when you move on" -- it did not: moving between chapters uses `router.replace`, so the
   * component never unmounts and the set outlived the chapter it belonged to. Keying per page removes the
   * question entirely, and this one IS cleared when the book changes, below.
   */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** A repeated page opened, or folded again, by hand. Stable, so a memoised row (ReaderPageRow) is not drawn again for them. */
  const expandPage = useCallback((key: string) => setExpanded((prev) => new Set(prev).add(key)), []);
  const collapsePage = useCallback((key: string) => setExpanded((prev) => { const n = new Set(prev); n.delete(key); return n; }), []);

  // ---- every page of every loaded chapter, including the ones the flow skips ----
  /**
   * The reading flow: every page of every loaded chapter, in order.
   *
   * ⚠️ THERE IS NO SECOND LIST, and that is the point. This used to be a full `flatAll` plus a filtered
   * `flat` that the reader indexed into, and the gap between them caused three bugs at once: resume and
   * `?page=` deep links landed a page late for every page removed before them, `firstOfChapter` was computed
   * on one list and read on the other so the chapter divider vanished when page 1 was furniture (re-phasing
   * every spread in that chapter), and the page grid handed `jumpTo` a -1 that clamped to the top of the
   * library. A repeated page is now a page that RENDERS differently, not one that is missing, so an index
   * here and a page number mean the same thing again.
   *
   * `hide` still removes, for readers who want the page gone outright — but it goes through the same builder,
   * so it gets the corrected `firstOfChapter` and the per-chapter empty guard too.
   */
  // Paged mode has no thin slide to collapse a page INTO -- every slide is one viewport wide -- so there a
  // repeated page under Collapse is shown like any other and costs one swipe. It used to get a slide that never
  // rendered (the render window skips collapsed pages): a blank screen with a faint page number. Shown, not
  // removed: removing would give the two modes different flows, and switching mode mid-chapter would then land
  // on a different page, because nothing re-anchors `current` when the flow is rebuilt.
  const flowJunk = prefs.mode === 'paged' && prefs.junkPages === 'collapse' ? 'show' : prefs.junkPages;
  // v0.89.0 (#262): the reader's own merges and splits (`mark` on a page, lib/spreadMarks.ts) applied over the detector's
  // joins, so what pairs is decided in one place. A merge is drawn the way a spread reads: from the right on a
  // right-to-left track, or for a right-to-left series read either way, as Wide pages -> Split orders a spread's halves.
  const markDir = rtl || pagedRtl ? 'rtl' : 'ltr';
  const flat: FlatItem[] = useMemo(
    () => applyMarks(buildFlow(chapters, flowJunk, expanded) as FlatItem[], markDir),
    [chapters, flowJunk, expanded, markDir],
  );
  /** Vertical + `collapse`: a repeated page is drawn as a band of itself instead of being removed. */
  const collapsing = prefs.junkPages === 'collapse';
  /** `hide` is the only mode that takes a page out of the flow, so it is the only one that needs the chip. */
  const removing = prefs.junkPages === 'hide';

  /**
   * Who to name on the caption of a page the source never served (v0.40.0).
   *
   * The series' own followed sources come with the series (set above, sent to every viewer), and nearly every
   * chapter saved short came from one of those. The full list is asked for ONLY when a placeholder's source
   * is not among them -- a copy a fill took from an unfollowed source -- and only for a viewer the route
   * answers: /api/sources is 403 to a member without download rights, which would be one failed request per
   * chapter opened. The caption without a name is the fallback, never an id: an extension's id is nineteen
   * digits nobody can read.
   */
  const unnamedMissingSource = chapters.some((c) => !!c.sourceId && !seriesSourceNames[c.sourceId] && c.pages.some((p) => p.missing));
  const { data: allSources } = useQuery({
    queryKey: ['sources'],
    queryFn: () => api<{ content: { id: string; name: string }[] }>('/api/sources'),
    staleTime: 60_000,
    enabled: unnamedMissingSource && canDownload(user),
  });
  const sourceNameOf = (id: string | null | undefined): string | null =>
    (id && (seriesSourceNames[id] ?? allSources?.content.find((x) => x.id === id)?.name)) || null;

  /**
   * How many pages the chapter being read is hiding right now, for the chip.
   *
   * ⚠️ Only in `hide`, where pages are genuinely absent. Where they collapse, the strip sits exactly where
   * the page is and says so itself; a floating chip on top of that tells you something already on screen,
   * which is the definition of noise. The chip is the notice of last resort, for the one mode with nowhere
   * else to put one.
   */
  const hiddenHere = useMemo(() => {
    const ch = chapters[flat[current]?.ci ?? 0];
    if (!removing || !ch) return 0;
    return ch.pages.filter((p) => p.junk && !p.missing && !expanded.has(`${ch.id}:${p.number}`)).length;
  }, [chapters, flat, current, removing, expanded]);

  // ---- paged slides: 1 page per slide, or double spreads ----
  // The rules, and why each exists, live in lib/readerSpread.ts, where they can be tested without mounting
  // this component. This used to pair a landscape double-page spread with the portrait page before it,
  // which halved the spread and left every later pair in the chapter off by one.
  // v0.61.0, Reader → Wide pages: what a wide page becomes here and now. Only on a screen held upright, and never in
  // spread mode, where a wide page already has a slide to itself (lib/readerSpread.ts rule 4). Split, a wide page is
  // two slides of the paged track, its halves in reading order -- the right half first on a right-to-left read, or for
  // a right-to-left series read either way -- and two halves one above the other in the webtoon column.
  const portrait = usePortrait();
  const wideMode: WidePages = portrait && !(prefs.mode === 'paged' && prefs.spread) ? prefs.widePages : 'whole';
  const rightFirst = rtl || pagedRtl;
  const splitTrack = prefs.mode === 'paged' && wideMode === 'split';
  // #229, Join split double pages (account, off until chosen): two pages a source served as the halves of one spread are
  // one slide (lib/readerSpread.ts rule 4b). On a screen held upright Wide pages decides, as for a spread in one file:
  // Whole shows the spread, Split shows its two pages one by one (not joined), Rotate turns it on its side.
  // and Shift pairs by one page (`shift`), in the dependencies too -- without it the Shift checkbox changed
  // nothing until the pages did.
  const { slides, slideOf, half, joined } = useMemo(
    () => pairSlides(flat, prefs.mode === 'paged' && !!prefs.spread, { split: splitTrack, rightFirst, shift: spreadShift, joinSplit: prefs.joinSplit }),
    [flat, prefs.mode, prefs.spread, splitTrack, rightFirst, spreadShift, prefs.joinSplit],
  );
  // A page brought into frame belongs to the slides it was brought out of: laid out again, they give the pair back.
  useEffect(() => { setFocus(null); }, [slides]);
  /** Which pages start a joined slide, by key: what the track was laid out for, for the joins effect further down. */
  const joinedAt = useMemo(() => slides.filter((_, s) => joined[s]).map((idxs) => flat[idxs[0]]?.key).join(','), [slides, joined, flat]);
  /** The paged track's slide, measured: what a split half or a page turned on its side is fitted into. */
  const [area, setArea] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const m = () => {
      const el = scrollRef.current;
      const w = el?.clientWidth || window.innerWidth;
      const h = el?.clientHeight || window.innerHeight;
      setArea((a) => (a.w === w && a.h === h ? a : { w, h }));
    };
    m();
    window.addEventListener('resize', m);
    return () => window.removeEventListener('resize', m);
  }, [prefs.mode, ready]);

  // ---- Crop page borders (v0.61.0, lib/readerCrop.ts) ----
  // Each page's margins, measured from its pixels once it has loaded (null: it could not be read back), and each
  // chapter's one trim of both sides for the webtoon column, decided from its first measured story pages and then
  // kept for the session, so the column never changes scale twice. Refs, with a version each to draw again: a page's
  // margins redraw the paged track, a chapter's trim the column's height model.
  const pageBoxes = useRef<Map<string, ReturnType<typeof measurePage>>>(new Map());
  const sideCrops = useRef<Map<string, { l: number; r: number }>>(new Map());
  const measuring = useRef<Set<string>>(new Set());
  const [, setBoxVersion] = useState(0);
  const [sideVersion, setSideVersion] = useState(0);
  const chaptersRef = useRef(chapters);
  chaptersRef.current = chapters;
  const onPageLoad = useCallback((key: string, imgEl: HTMLImageElement) => {
    if (pageBoxes.current.has(key) || measuring.current.has(key)) return;
    measuring.current.add(key);
    const run = () => {
      measuring.current.delete(key);
      pageBoxes.current.set(key, measurePage(imgEl));
      setBoxVersion((v) => v + 1);
      // The chapter's trim, once enough of its story pages are measured: not a repeated page, not a placeholder, not a
      // spread (whose margins are not a page's).
      const chId = key.slice(0, key.lastIndexOf(':'));
      if (sideCrops.current.has(chId)) return;
      const ch = chaptersRef.current.find((c) => c.id === chId);
      if (!ch) return;
      const story = ch.pages.filter((pg) => !pg.junk && !pg.missing && !isWide(pg));
      const boxes = story.map((pg) => pageBoxes.current.get(`${chId}:${pg.number}`)?.sides).filter((b): b is Region => !!b);
      const decided = chapterSideCrop(boxes, Math.min(CHAPTER_SAMPLE, story.length));
      if (decided) { sideCrops.current.set(chId, decided); setSideVersion((v) => v + 1); }
    };
    // At idle: the read-back is a few milliseconds, and never in the way of a scroll. Safari has no idle callback.
    const idle = (window as unknown as { requestIdleCallback?: (f: () => void, o: { timeout: number }) => number }).requestIdleCallback;
    if (idle) idle(run, { timeout: 150 }); else setTimeout(run, 0);
  }, []);
  /** The chapter's trim of a row of the webtoon column: on whole pages only -- a split or turned page, a band, a
   *  placeholder are drawn as they are -- and once decided. */
  const rowCrop = (p: FlatItem, wide: WidePages): { l: number; r: number } | null =>
    (prefs.cropBorders && wide === 'whole' && !p.collapsed && !p.missing ? sideCrops.current.get(chapters[p.ci]?.id ?? '') ?? null : null);

  // ⚠️ #180: Safari (WebKit, on iOS and macOS alike) keeps a snapped track's place as the index of its snap point
  // counted from the LEFT edge, and a right-to-left track grows leftwards. So every slide added at its end -- the next
  // chapter, the Up Next card -- moved the reader that many pages on, to the same distance from the new end: four
  // pages before the end of a volume it landed four pages before the end of the next one, which added the one after,
  // and so on to the last volume, each volume it crossed marked read. Chrome keeps the place (untilStill covers its
  // in-flight scroll). So the track is put back exactly where it stood before the append, in the same task as the DOM
  // change, before anything paints or scrolls. Measured in Playwright's WebKit: a still track on slide 9 of 12, twelve
  // slides added, stood on slide 21; with this it stays on 9, and the next page turn moves one. A browser behaviour,
  // so no unit test can hold it: the guard is test/e2e/walk180.mjs, which runs the reader in WebKit.
  // Only the render the append caused: an anchor that render never came for (the chapter was there already) is dropped
  // rather than applied to some later change of the slides.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const held = appendAnchor.current;
    appendAnchor.current = null;
    if (!el || !held || prefs.mode !== 'paged' || Date.now() - held.at > 1000) return;
    if (Math.abs(el.scrollLeft - held.left) >= 1) el.scrollLeft = held.left;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slides, ended, failed]);

  // ---- measure column width (× zoom) ----
  useEffect(() => {
    const measure = () => {
      const w = scrollRef.current?.clientWidth || window.innerWidth;
      // #233: this device's column width, a share of what Fit gives (lib/readerDevice.ts); 100 is the column as it was.
      const base = (prefs.fitWidth ? Math.min(w, 860) : w) * (device.columnWidth / 100);
      setColW(base * zoom);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [prefs.fitWidth, ready, zoom, device.columnWidth]);

  // keep the page roughly centered when zooming
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !didInitScroll.current) return;
    // Centre a zoomed webtoon column. In paged mode scrollLeft is the PAGE: centring it jumped a double-tap
    // to the middle of the chapter (and to page 1 on a right-to-left track).
    // ⚠️ Across only (v0.61.0, F5). This also put the column back at the TOP of the page being read, which on a
    // 689 x 54,000 strip is a double-tap zoom thrown fifty screens back up the strip. The place down the column is
    // kept by the anchor below, which holds the point being read through any change of layout.
    if (zoom > 1 && prefs.mode === 'vertical') el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, colW]);

  // ---- reserved heights + cumulative tops (incl. chapter dividers) ----
  // ⚠️ `expanded` and `collapsing` belong in the dependency list below, not just in the body. This memo is
  // the reader's ENTIRE model of the layout -- `onScroll` binary-searches `tops` to decide what page you are
  // on, and nothing ever measures the DOM to check. Leave them out and opening a page silently reports the
  // wrong page from then on, with no symptom until the page counter disagrees with the screen.
  // Reintroduce by dropping `expanded` from the deps: expand a strip, then scroll -- the counter is off by
  // however much the page grew.
  // v0.87.0: whether the household has talk to show (lib/comments.ts useTalkOn), asked with the chapter on screen. While it
  // does, the line between two chapters is the strip where they meet, SEAM_H tall instead of DIVIDER_H -- in the model
  // below as in the row that draws it (components/ReaderPage.tsx). Reintroduce by reserving DIVIDER_H whatever talkOn
  // says: "the reader reserves the strip it draws" in comments.test.ts fails, and every page below a strip reads as
  // another one.
  const talkOn = useTalkOn(chapters[flat[current]?.ci ?? 0]?.id);
  const dividerH = talkOn ? SEAM_H : DIVIDER_H;
  const { heights, tops } = useMemo(() => {
    // `buildFlow` owns the collapse decision. In particular, `missing` outranks a stale/manual `junk` flag:
    // a placeholder must keep its full page box so its explanation is never squeezed into a strip.
    // v0.61.0: a wide page split or turned on its side is as tall as lib/readerSpread.ts pageHeight says; a missing
    // placeholder is always drawn whole, with its caption.
    // Crop page borders: a trimmed row is drawn wider than the column by what is trimmed, so it stands taller by as much.
    const rowHeight = (p: FlatItem) => {
      const wide = p.missing ? 'whole' : wideMode;
      const crop = rowCrop(p, isWide(p) ? wide : 'whole');
      return pageHeight(p, crop ? colW / (1 - crop.l - crop.r) : colW, wide);
    };
    const hs = flat.map((p) => p.collapsed
      ? STRIP_H
      : rowHeight(p));
    const ts: number[] = [];
    let acc = 0;
    flat.forEach((p, i) => {
      if (p.firstOfChapter && p.ci > 0) acc += dividerH;
      ts.push(acc);
      acc += hs[i] + prefs.gap;
    });
    return { heights: hs, tops: ts };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat, colW, prefs.gap, collapsing, expanded, wideMode, prefs.cropBorders, sideVersion, dividerH]);

  /** Each page's place in the flow, by key (v0.61.0): the anchor, the downloaded pages' images and the page grid look
   *  a page up here. They used to scan the flow for it, once per page -- per blob, per grid tile, per page turn. */
  const indexOfKey = useMemo(() => new Map(flat.map((p, i): [string, number] => [p.key, i])), [flat]);

  // ---- the webtoon column's window (v0.61.0, lib/readerWindow.ts) ----
  // Which pages hold a full-size image is decided by SCREENS, from where the column is scrolled to: a window of pages
  // put nine long strips (about 1.3 GB decoded) in memory, and two screens of thin slices. `win` is the span of the
  // flow the screen in view touches, widened behind and ahead; `tail` is whether the end of what is loaded is near.
  const [win, setWin] = useState<IndexRange>({ from: 0, to: -1 });
  const [tail, setTail] = useState(false);
  /**
   * The point being read, kept through any change of layout: the page under the probe line and how far down it, with
   * that page's top and height when it was taken. A zoom, a page above it opening or closing, a crop measured -- the
   * layout effect below puts the same point of the same page back under the line. Keyed by the page, not its index,
   * because Hide puts pages back into the flow ahead of it.
   */
  const anchorRef = useRef<{ key: string; frac: number; top: number; height: number } | null>(null);
  /** Read the webtoon column: the page being read (the one under the probe, as always), the anchor, the window, the tail. */
  const readColumn = (el: HTMLElement): number => {
    const view = { top: el.scrollTop, height: el.clientHeight };
    const a = anchorAt(tops, heights, view.top + view.height * PROBE);
    const it = flat[a.index];
    anchorRef.current = it ? { key: it.key, frac: a.frac, top: tops[a.index], height: heights[a.index] } : null;
    const next = screenRange(tops, heights, view, BEHIND_SCREENS, AHEAD_SCREENS);
    setWin((w) => (w.from === next.from && w.to === next.to ? w : next));
    const total = tops.length ? tops[tops.length - 1] + heights[heights.length - 1] : 0;
    const t = nearEnd(total, view, APPEND_SCREENS);
    setTail((x) => (x === t ? x : t));
    return a.index;
  };
  // ⚠️ Replaces `el.scrollTop = tops[current]` in the zoom effect above (F5), and absorbs every other height change: a
  // repeated page opened above, a crop or a split measured. Skipped when the anchored page did not move -- an append at
  // the end of the column moves nothing above it, and setting scrollTop mid-fling stops an iPhone's momentum dead.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || prefs.mode !== 'vertical' || !didInitScroll.current) return;
    const a = anchorRef.current;
    const i = a ? indexOfKey.get(a.key) : undefined;
    if (a && i != null && (tops[i] !== a.top || heights[i] !== a.height)) {
      const target = scrollTopFor({ index: i, frac: a.frac }, tops, heights, el.clientHeight * PROBE);
      if (Math.abs(el.scrollTop - target) >= 1) el.scrollTop = target;
    }
    readColumn(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tops, heights]);

  // ---- active render window ----
  // ⚠️ Memoised on `flat` itself, not `flat.length`. Expanding a page changes what is in the window without
  // changing how many items there are, and the blob prefetch below keys off this set's identity -- on
  // `flat.length` the set never changes, so an expanded page of a DOWNLOADED chapter would sit on its number
  // placeholder forever. Invisible online, where the image URL always works.
  // Paged keeps its window of pages; the webtoon column's is by screens (above).
  const activeSet = useMemo(
    () => (prefs.mode === 'vertical'
      ? windowSet(flat, win, current, MAX_WINDOW_PAGES)
      : renderWindow(flat, current, WINDOW_BEHIND, WINDOW_AHEAD)),
    [flat, current, win, prefs.mode],
  );

  // ---- offline blob URLs within window ----
  const [, force] = useState(0);
  useEffect(() => {
    let alive = true;
    (async () => {
      const map = blobUrls.current;
      for (const i of activeSet) {
        const it = flat[i];
        const ch = chapters[it.ci];
        if (ch?.offline && !map.has(it.key)) {
          const blob = await getPageBlob(ch.id, it.number);
          if (blob && alive) map.set(it.key, URL.createObjectURL(blob));
        }
      }
      // Released by distance (v0.61.0): in the webtoon column, further than KEEP_SCREENS screens from the one in view
      // -- twelve pages behind was a dozen screens of slices or a whole volume of strips -- and paged, twelve pages
      // behind or eighteen ahead, as before. Looked up by key; a page no longer in the flow is released too.
      const el = scrollRef.current;
      const keep = prefs.mode === 'vertical' && el
        ? screenRange(tops, heights, { top: el.scrollTop, height: el.clientHeight }, KEEP_SCREENS, KEEP_SCREENS)
        : { from: current - 12, to: current + 18 };
      for (const [k, u] of map) {
        const idx = indexOfKey.get(k);
        if (idx == null || idx < keep.from || idx > keep.to) {
          URL.revokeObjectURL(u);
          map.delete(k);
        }
      }
      if (alive) force((n) => n + 1);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSet]);

  // ---- Fit pages to my screen (#234, this device, off until chosen; lib/readerFit.ts) ----
  /** The width each page was last asked for at, by key: a page is never asked for again at less (neverSofter). */
  const fitAsked = useRef<Map<string, number>>(new Map());
  /**
   * The CSS width page `i`'s whole width is drawn at, as this layout draws it: the column (zoom and column width in it),
   * twice it for a wide page split in two, down it for one turned; on a slide, fitted into the slide, half of it for one
   * of a pair, both halves of a split page, turned on its side; by the zoom; stretched as far as Crop page borders may.
   * Before anything is measured, the window: never less than what is drawn.
   */
  const drawnAt = (i: number): number => {
    const p = flat[i];
    if (prefs.mode === 'vertical') {
      const wide = !p.missing && isWide(p) ? wideMode : 'whole';
      return drawnWidth(p, { mode: 'column', colW: colW || window.innerWidth, wide, crop: prefs.cropBorders && wide === 'whole' && !p.collapsed && !p.missing });
    }
    const s = slideOf[i] ?? i;
    const shown = slides[s] ?? [i];
    // One page of the pair brought into frame (#232/#261) is drawn alone; a joined spread turned on its side (#229, Wide
    // pages -> Rotate) is one picture twice a page wide, turned, of which this page is half.
    const pair = shown.length === 2 && focus?.slide !== s;
    const slide = { mode: 'slide' as const, w: area.w || window.innerWidth, h: area.h || window.innerHeight, zoom, half: !!half[s], crop: prefs.cropBorders };
    if (pair && joined[s] && wideMode === 'rotate' && p.width && p.height) {
      return drawnWidth({ width: 2 * p.width, height: p.height }, { ...slide, pair: false, rotate: true }) / 2;
    }
    return drawnWidth(p, { ...slide, pair, rotate: wideMode === 'rotate' && shown.length === 1 && isWide(p) });
  };
  /** The width to ask page `i` for, in device pixels: rounded up to a width the server keeps (0: as scanned), never less than before. */
  const fitFor = (i: number): number => {
    const key = flat[i].key;
    const w = neverSofter(fitAsked.current.get(key), fitWidth(drawnAt(i), window.devicePixelRatio || 1));
    fitAsked.current.set(key, w);
    return w;
  };
  /**
   * An online page's address: as scanned -- the reader as it always was -- or under Fit pages to my screen, as wide as it
   * is drawn; translated once the server has the page in the reader's language (v0.85.0), the original until then.
   */
  const onlineSrc = (ch: Chapter, i: number): string => {
    const src = (device.fitPages ? img.pageFit(ch.id, flat[i].number, fitFor(i)) : img.page(ch.id, flat[i].number));
    return translatedSrc(src, trLang, trOn ? trStatus[ch.id]?.pages[flat[i].number] : undefined);
  };

  // ---- the webtoon column fetches ahead of its window, as bytes (v0.61.0) ----
  // The pages after the window are fetched and dropped: the server serves a page `private, max-age=31536000,
  // immutable`, so the <img> that the window brings later is answered from the browser's cache, and the decode -- the
  // memory -- is spent only once the page is near. Online pages only: a downloaded page is already on this device.
  const prefetched = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (prefs.mode !== 'vertical' || !activeSet.size) return;
    for (const i of prefetchList(flat, Math.max(...activeSet), PREFETCH)) {
      const it = flat[i];
      const ch = chapters[it.ci];
      if (!ch || ch.offline || prefetched.current.has(it.key)) continue;
      prefetched.current.add(it.key);
      // The address the page's <img> will ask for (onlineSrc), so what is warmed is what is then shown.
      void fetch(onlineSrc(ch, i), { credentials: 'same-origin', priority: 'low' } as RequestInit)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .catch(() => { prefetched.current.delete(it.key); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSet]);

  const srcFor = (i: number): string | null => {
    const it = flat[i];
    const ch = chapters[it.ci];
    if (!ch) return null;
    if (ch.offline) return blobUrls.current.get(it.key) || null;
    return onlineSrc(ch, i);
  };

  /**
   * The image behind a COLLAPSED page: the same picture, at thumbnail size.
   *
   * ⚠️ Deliberately not `srcFor`. A collapsed page is 48px tall and nobody is reading it, so pulling the
   * full-size scan for it would spend a webtoon-sized download on a band of a credit page -- once per
   * chapter, forever. 200px is the width the page grid and the scrubber preview already ask for, so this
   * usually costs nothing at all beyond what those already cached.
   */
  const stripSrc = (i: number): string | null => {
    const it = flat[i];
    const ch = chapters[it.ci];
    if (!ch) return null;
    if (ch.offline) return blobUrls.current.get(it.key) || null;   // already decoded in memory; no network
    return img.page(ch.id, it.number, 200);
  };

  /**
   * The paged track's width and the slide it stands on, as last read or placed (#263): what a change of width puts it
   * back to. Every deliberate placing records them (placeTrack) as well as every scroll, so a width change that lands
   * after a placing -- turning a phone, where Wide pages: Split moves the slides in the same turn -- puts the track back
   * on the slide that placing chose, not on the one read before the slides moved.
   */
  const pagedWidth = useRef(0);
  const pagedSlide = useRef(0);
  /** Put the paged track on `slide` before it paints, and remember that as its place. */
  const placeTrack = (el: HTMLElement, slide: number) => {
    const w = el.clientWidth;
    const left = trackSign * slide * w;
    if (Math.abs(el.scrollLeft - left) >= 1) el.scrollLeft = left;
    pagedWidth.current = w;
    pagedSlide.current = slide;
  };

  // ---- initial scroll to resume page ----
  useEffect(() => {
    if (!ready || didInitScroll.current || !colW || !tops.length) return;
    // ⚠️ A page NUMBER, resolved -- never `startPage - 1`. Subtracting one is an index into a list that holds
    // every page, which stopped being true the moment `hide` could remove one, and the drift is silent: you
    // resume a little past where you left off, by exactly the number of pages removed before you.
    const idx = Math.max(0, Math.min(flat.length - 1, startIndex(flat, 0, startPage)));
    if (prefs.mode === 'vertical' && scrollRef.current && idx > 0) scrollRef.current.scrollTop = tops[idx];
    // Page 1 too: the track is the same element from chapter to chapter, still where the last one left it.
    if (prefs.mode === 'paged' && scrollRef.current) placeTrack(scrollRef.current, slideOf[idx] ?? idx);
    setCurrent(idx);
    // Seed the dedupe key so landing here does not immediately ping progress. Opening a saved Moment is
    // looking something up, not reading it, and it should not move where you were or add a reading event.
    const at = flat[idx];
    if (at) lastSent.current = `${chapters[at.ci]?.id}:${at.number}`;
    laidOutSign.current = trackSign;
    laidOutMode.current = prefs.mode;
    laidOutSplit.current = splitTrack;
    laidOutPairs.current = `${!!prefs.spread}:${spreadShift}`;
    laidOutJoins.current = joinedAt;
    didInitScroll.current = true;
    // The column's window and anchor from where it now stands: a resume on page 1 scrolls nowhere, so no scroll event
    // would ever bring them.
    if (prefs.mode === 'vertical' && scrollRef.current) readColumn(scrollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, colW, tops]);

  // F3 (v0.61.0): switching mode mid-chapter swaps the scroller -- the webtoon column scrolls down, the paged track
  // across -- and the new one starts at its origin: Webtoon -> Paged landed on page 1 of the chapter. Put the new
  // scroller on the page that was being read, before it paints. The direction is laid out with it, so the flip effect
  // below does not act on the same change twice.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !didInitScroll.current || laidOutMode.current === prefs.mode) return;
    laidOutMode.current = prefs.mode;
    if (prefs.mode === 'paged') {
      laidOutSign.current = trackSign;
      laidOutSplit.current = splitTrack;
      laidOutJoins.current = joinedAt;
      // The column's anchor belongs to the column: on the way back it would be a place read before the pages turned.
      anchorRef.current = null;
      placeTrack(el, slideOf[current] ?? current);
    } else {
      pagedWidth.current = 0; // the track is gone: the next one's width is its own
      el.scrollTop = tops[current] ?? 0;
      readColumn(el);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.mode]);

  // Flipping the direction mid-chapter mirrors the track, and the old scrollLeft now points at another page
  // (or clamps to page 1). Put the reader back on the page they were looking at.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !didInitScroll.current || prefs.mode !== 'paged') return;
    // ⚠️ Not in the commit that did the initial scroll. A streamed right-to-left series learns its direction in
    // the same tick it becomes ready, so this ran straight after the resume scroll -- with `current` still 0
    // in its closure -- and put every resume and every `?page=` link on a right-to-left series back on page 1.
    if (laidOutSign.current === trackSign) return;
    laidOutSign.current = trackSign;
    placeTrack(el, slideOf[current] ?? current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackSign]);

  // The same for wide pages split in two (v0.61.0): turning the phone, or the setting, adds or removes a slide for every
  // wide page before the one being read, so the track's place now points at another page. Put it back on the page
  // being read -- its first half -- before it paints.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !didInitScroll.current || prefs.mode !== 'paged' || laidOutSplit.current === splitTrack) return;
    laidOutSplit.current = splitTrack;
    // Recorded as the track's place (placeTrack): turning the phone changes the width in the same turn, and the resize
    // guard below would otherwise put back the slide read BEFORE the halves came or went -- another page.
    placeTrack(el, slideOf[current] ?? current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitTrack]);

  // the same for turning spreads on or off and for Shift pairs by one page: every slide after the first
  // changes which pages it holds, so the track's place pointed at another page and the counter followed it there.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const pairs = `${!!prefs.spread}:${spreadShift}`;
    if (!el || !didInitScroll.current || prefs.mode !== 'paged' || laidOutPairs.current === pairs) return;
    laidOutPairs.current = pairs;
    // Through placeTrack (v0.74.0's resize guard), so a resize after the pairs change keeps this slide, not the old one.
    placeTrack(el, slideOf[current] ?? current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.spread, spreadShift]);
  // #229: the same for joined spreads. A join the server finds while the chapter is open (the measure runs in the
  // background, and the reader asks again), or Join split double pages switched on or off, makes two slides one or one
  // two before the page being read, and the track's place then points at another page. Put it back on the page being
  // read before it paints. Keyed on which pages start a joined slide (`joinedAt`), so nothing else that changes the slides
  // moves it.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !didInitScroll.current || prefs.mode !== 'paged' || laidOutJoins.current === joinedAt) return;
    laidOutJoins.current = joinedAt;
    // v0.89.0 (#262): a joined pair on screen taken apart -- Undo the merge, Show as two pages, or joining switched off on
    // it -- shows the page it began with, the one being read: `current` is a slide's LAST page (completion fires on it),
    // and the pair's second page was a page on. Anything else keeps the page being read, as before. Reintroduce by
    // anchoring on `current` alone: "a pair taken apart shows its first page" in spreadMarks.test.ts fails.
    // The slide on screen is read from the same render's slides (`shownAt`), never `pagedSlide`, which the Wide pages and
    // pairs effects above may already have moved onto the new slides in this commit. And `current` follows the placing:
    // the first page keeps the pair's slide index, so no scroll event comes to say so.
    const was = shownSlides.current[shownAt.current];
    const apart = !!was && was.length === 2 && !!shownJoined.current[shownAt.current] && slideOf[was[0]] !== slideOf[was[1]];
    const anchor = apart ? was[0] : current;
    const s = slideOf[anchor] ?? anchor;
    placeTrack(el, s);
    if (apart) { const on = slides[s]; setCurrent(on ? on[on.length - 1] : anchor); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinedAt]);
  // The slides on screen until this render's layout is done, and which of them was on screen: what the joins effect above
  // compares with. A passive effect, so the layout effect still reads the previous render's.
  const shownSlides = useRef<number[][]>([]);
  const shownJoined = useRef<boolean[]>([]);
  const shownAt = useRef(0);
  useEffect(() => { shownSlides.current = slides; shownJoined.current = joined; shownAt.current = pagedSlide.current; });

  // ---- track current page on scroll ----
  // A resize that raises no scroll event (the offset still fits) leaves the track between two pages: snap it back too.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || prefs.mode !== 'paged' || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (!w || !pagedWidth.current || pagedWidth.current === w) return;
      pagedWidth.current = w;
      el.scrollTo({ left: trackSign * pagedSlide.current * w, behavior: 'instant' as ScrollBehavior });
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.mode, ready, trackSign]);
  const onScroll = useCallback(() => {
    lastMoved.current = Date.now();
    const el = scrollRef.current;
    if (!el) return;
    if (prefs.mode === 'paged') {
      // Math.abs: an RTL track scrolls from 0 into NEGATIVE scrollLeft (the spec'd behaviour every current
      // engine follows), so page n sits at -n × width.
      // ⚠️ A track whose width just changed (the window dragged to a screen of another size, a sidebar, a rotation) keeps its
      // scrollLeft in PIXELS, so the same offset now divides into another slide: the reader was moved to a different page, and
      // a few chapters on once the append and progress paths believed it. The width, not the offset, is what changed, so this
      // scroll event is no reading: put the track back on the slide it was on and read nothing from it.
      const w = el.clientWidth;
      if (pagedWidth.current && pagedWidth.current !== w) {
        pagedWidth.current = w;
        el.scrollTo({ left: trackSign * pagedSlide.current * w, behavior: 'instant' as ScrollBehavior });
        return;
      }
      pagedWidth.current = w;
      const s = Math.round(Math.abs(el.scrollLeft) / Math.max(1, w));
      pagedSlide.current = s;
      // Away from the slide a page was brought into frame on: it shows its pair again when it is next seen.
      setFocus((f) => (f && f.slide !== s ? null : f));
      const idxs = slides[Math.max(0, Math.min(slides.length - 1, s))];
      const i = idxs ? idxs[idxs.length - 1] : 0; // last page of a spread → completion fires on the final spread
      setCurrent((c) => (c === i ? c : i));
      return;
    }
    // The page under the probe line, 40 % down the screen, as it always was; reading the column also keeps the anchor,
    // the window and the tail up to date (readColumn).
    const ans = readColumn(el);
    setCurrent((c) => (c === ans ? c : ans));
    // trackSign for the width guard's put-back: a stale sign after a flip put a resized right-to-left track on page 1.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tops, heights, flat, prefs.mode, slides, trackSign]);

  // ---- the numbers a move to the next chapter skips (#236) ----
  /**
   * The runs of numbers the series is missing, by the server's rule (GET /api/series/:id/gaps: the Health card's, less
   * what an admin ignored there). Asked once per series while the chapter list is the live one: offline the reader cannot
   * tell a chapter missing from one not downloaded, so it says nothing.
   */
  const { data: gapData } = useQuery({
    queryKey: ['series-gaps', chapters[0]?.seriesId],
    queryFn: () => api<{ gaps: GapRun[] }>(`/api/series/${chapters[0]!.seriesId}/gaps`),
    enabled: !!chapters[0]?.seriesId && refsFrom === 'live',
    staleTime: 5 * 60_000,
  });
  /** Said as the reader reaches the next chapter, or is sent to it: the numbers between the two that the series is missing. */
  const warnGap = (fromId?: string, toId?: string) => {
    const to = toId ? numberOf.get(toId) : undefined;
    const runs = gapsBetween(gapData?.gaps ?? [], fromId ? numberOf.get(fromId) : undefined, to);
    if (!runs.length || to == null) return;
    const next = numLabel(to);
    if (runs.length === 1) {
      const [{ lo, hi }] = runs;
      toast(lo === hi
        ? tr('Chapter {a} is missing here. This continues at chapter {next}.', { a: numLabel(lo), next })
        : tr('Chapters {a}–{b} are missing here. This continues at chapter {next}.', { a: numLabel(lo), b: numLabel(hi), next }), 'info');
      return;
    }
    // Two runs or more: a chapter deleted on purpose (held, so not missing) between them, say. Joined the reader's way.
    const parts = runs.map(({ lo, hi }) => (lo === hi ? numLabel(lo) : `${numLabel(lo)}–${numLabel(hi)}`));
    let list = parts.join(', ');
    try { list = new Intl.ListFormat(activeLocale(), { type: 'conjunction' }).format(parts); } catch { /* an old WebView: commas */ }
    toast(tr('Chapters {list} are missing here. This continues at chapter {next}.', { list, next }), 'info');
  };
  /**
   * Said as the next chapter is REACHED in the column or the track, once a chapter: not as it is appended, four pages
   * before the end of this one, where the toast came and went before the reader got there.
   */
  const warnedGaps = useRef(new Set<string>());
  const activeCi = flat[current]?.ci;
  useEffect(() => {
    if (!ready || !didInitScroll.current || activeCi == null || activeCi < 1) return;
    const to = chapters[activeCi];
    if (!to || warnedGaps.current.has(to.id)) return;
    warnedGaps.current.add(to.id);
    warnGap(chapters[activeCi - 1]?.id, to.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCi, ready]);
  // ---- continuous reading: append next chapter near the end ----
  useEffect(() => {
    if (!ready || !flat.length || appending.current || noMore.current) return;
    // Four pages from the end, as always -- or, in the webtoon column, within APPEND_SCREENS screens of it (v0.61.0):
    // four thin slices before the end is less than a screen, and the next chapter arrived after the reader did.
    if (current < flat.length - 4 && !(prefs.mode === 'vertical' && tail)) return;
    appending.current = true;
    // Every slide added below lands on a still track when the track runs right to left (untilStill).
    const rtlTrack = pagedRtl;
    (async () => {
      const last = chapters[chapters.length - 1];
      // We do not know the shape of this series -- the list never arrived. Stop appending, but do NOT claim
      // the series is finished: an unknown is not a conclusion. This is the same distinction chapterOutcome
      // draws between "empty" and "absent", and it is why every offline chapter used to end with a trophy.
      if (!chapterRefs.length) { noMore.current = true; appending.current = false; return; }
      const idx = chapterRefs.findIndex((c) => c.id === last?.id);
      const next = idx >= 0 ? chapterRefs[idx + 1] : null;
      // #180: where the track stands now, for the layout effect after `slides` to put it back.
      const hold = () => { appendAnchor.current = scrollRef.current ? { left: scrollRef.current.scrollLeft, at: Date.now() } : null; };
      if (!next) { noMore.current = true; await untilStill(lastMoved, rtlTrack); hold(); setEnded(true); appending.current = false; return; }
      const ch = await loadChapter(next.id, prefs.joinSplit);
      const outcome = chapterOutcome(ch);
      await untilStill(lastMoved, rtlTrack);
      hold();
      if (outcome === 'ok') setChapters((cs) => (cs.some((c) => c.id === ch!.id) ? cs : [...cs, ch!]));
      // There IS a next chapter -- chapterRefs says so -- and it would not load. Claiming the series is
      // finished here is how a corrupt file or a dropped connection came to read as an ending.
      else { noMore.current = true; setFailed(outcome); }
      appending.current = false;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, ready, flat.length, chapterRefs, tail]);

  // ---- #229: spreads the server is still measuring ----
  // Join split double pages: a chapter's spreads are found in the background (bff lib/spreadMeasure.ts), so a chapter
  // opened before its measure ran comes back with none, `pending`. Ask again (SPREAD_ASKS), and put the joins on its pages
  // as they come: the joins effect above keeps the page being read where it is. Switched on mid-chapter, the chapters
  // already loaded are asked for at once. Online chapters only: a downloaded copy carries what was found when it was saved.
  useEffect(() => {
    if (!prefs.joinSplit) return;
    const tries = (id: string) => spreadTries.current.get(id) ?? 0;
    const due = chapters.filter((c) => !c.offline && !spreadAsking.current.has(c.id)
      && (c.spreads === undefined || (c.spreads === 'pending' && tries(c.id) < SPREAD_ASKS.length)));
    if (!due.length) return;
    const wait = Math.min(...due.map((c) => (c.spreads === undefined ? 0 : SPREAD_ASKS[tries(c.id)])));
    const t = setTimeout(() => {
      for (const c of due) {
        if (c.spreads === 'pending') spreadTries.current.set(c.id, tries(c.id) + 1);
        spreadAsking.current.add(c.id);
        void pageList(c.id, true).then((list) => {
          // Out of the asks before the answer goes in: the render it causes runs this effect again, and asks what is due.
          spreadAsking.current.delete(c.id);
          setChapters((cs) => cs.map((x) => (x.id === c.id && x.pages.length === list.pages.length
            ? { ...x, spreads: list.spreads, pages: x.pages.map((p, i) => (p.join === list.pages[i].join ? p : { ...p, join: list.pages[i].join })) }
            : x)));
        }, () => { spreadAsking.current.delete(c.id); });
      }
    }, wait);
    return () => clearTimeout(t);
  }, [prefs.joinSplit, chapters]);

  // ---- submit progress for the active chapter ----
  // Two paths: (a) regular page progress, debounced 600ms; (b) chapter COMPLETION, sent immediately —
  // the debounce used to swallow completions when readers scrolled through a chapter's last page without
  // lingering (webtoon fast-scroll can even skip it entirely), so finished chapters never counted as read.
  const completedSent = useRef(new Set<string>());
  const prevPos = useRef<{ ci: number } | null>(null);
  /** Bumped when a tap's page turn can no longer be taken back, so the progress below is read again. */
  const [turnSettled, setTurnSettled] = useState(0);
  const sendProgress = useCallback((chId: string, sId: string, page: number, completed: boolean) => {
    // `at` is what lets the server refuse a stale write. The offline outbox always sent it; the live path
    // never did, so every live ping took the "no timestamp" leg of the guard and applied unconditionally --
    // a desktop tab left open on chapter 3 could still rewind the phone that had read to chapter 9.
    const payload = { page, completed, seriesId: sId, deviceId: deviceId(), at: Date.now(), ...(incognitoRef.current ? { incognito: true } : {}) };
    // Alongside the write, not instead of it: this is what a downloaded chapter resumes from with no network.
    void noteOfflineProgress(chId, page, completed);
    api(`/api/books/${chId}/progress`, { method: 'PUT', json: payload }).catch(() => queueProgress({ bookId: chId, ...payload }));
  }, []);
  useEffect(() => {
    if (!ready || !flat.length) return;
    // A tap's page turn is not reading until a double-click can no longer take it back (lib/readerGesture.ts).
    // ⚠️ Completion goes out the moment a chapter's last page shows, so a slow mouse double-click whose first
    // click turned onto that page marked the chapter read -- and the undo put the page back but not the
    // progress, which is what moves Continue and lets read-chapter cleanup take the file. Held, not dropped:
    // `prevPos` is left alone while held, so a chapter crossed during the hold still counts as finished.
    const a = acted.current;
    // v0.61.0: a tapped step down the column (Tap zones → Edges, L shape, Kindle-style) is held the same way.
    const hold = a?.kind === 'turn' || a?.kind === 'scroll' ? undoLeft(a.at, Date.now()) : 0;
    if (hold > 0) {
      const t = setTimeout(() => setTurnSettled((n) => n + 1), hold + 20);
      return () => clearTimeout(t);
    }
    const it = flat[current];
    if (!it) return;
    const ch = chapters[it.ci];
    if (!ch) return;
    // crossed forward into a new chapter → the departed chapter is finished, even if its last page was skipped
    const prev = prevPos.current;
    prevPos.current = { ci: it.ci };
    if (prev && it.ci > prev.ci) {
      const dep = chapters[prev.ci];
      if (dep && !completedSent.current.has(dep.id)) {
        completedSent.current.add(dep.id);
        sendProgress(dep.id, dep.seriesId, dep.pages[dep.pages.length - 1]?.number ?? dep.pages.length, true);
      }
    }
    const isLastOfChapter = current === flat.length - 1 || flat[current + 1]?.ci !== it.ci;
    const tag = `${ch.id}:${it.number}`;
    if (lastSent.current === tag) return;
    if (isLastOfChapter && !completedSent.current.has(ch.id)) {
      // completion fires immediately — a debounce here loses the event when the reader moves on quickly.
      // It carries the chapter's REAL last page, not the last one shown: with junk pages hidden the flow
      // ends a page or two early (the credit page is the common case), and the server's read-chapter
      // cleanup takes "completed at page 38 of 40" for somebody re-reading and keeps the file forever.
      // The cross-forward ping above already says the same thing for the same reason.
      completedSent.current.add(ch.id);
      lastSent.current = tag;
      sendProgress(ch.id, ch.seriesId, ch.pages[ch.pages.length - 1]?.number ?? it.number, true);
      return;
    }
    const t = setTimeout(() => {
      lastSent.current = tag;
      sendProgress(ch.id, ch.seriesId, it.number, false);
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, ready, flat.length, turnSettled]);

  // ---- auto-scroll ----
  useEffect(() => {
    if (prefs.mode !== 'vertical' || prefs.autoScroll <= 0) return;
    let raf = 0;
    const step = () => { if (scrollRef.current) scrollRef.current.scrollTop += prefs.autoScroll; raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [prefs.autoScroll, prefs.mode]);

  // ---- wake lock ----
  useEffect(() => {
    let lock: any = null;
    const req = async () => { try { lock = await (navigator as any).wakeLock?.request('screen'); } catch {} };
    req();
    const onVis = () => { if (document.visibilityState === 'visible') req(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { try { lock?.release(); } catch {}; document.removeEventListener('visibilitychange', onVis); };
  }, []);

  // ---- navigation helpers ----
  const seriesId = chapters[0]?.seriesId || '';
  // "Up Next" recommendations, fetched once the reader hits the end of the series
  const { data: upNext } = useQuery({
    queryKey: ['reader-upnext', seriesId],
    queryFn: () => api<{ content: Series[] }>(`/api/series/${seriesId}/similar`),
    enabled: !!seriesId && ended,
    staleTime: 5 * 60 * 1000,
  });
  const activeChapter = chapters[flat[current]?.ci ?? 0];
  const { data: activeTalk } = useChapterTalk(talkOn ? activeChapter?.id : null);
  /** On a chapter's last page (the last page of a slide, paged): where a paged track shows the chapter's talk. */
  const atChapterEnd = !!flat[current] && (current === flat.length - 1 || flat[current + 1]?.ci !== flat[current].ci);

  // ---- v0.89.0 (#262): merge two pages into one spread, or take one apart, for this account (lib/spreadMarks.ts) ----
  // What the page being read allows, from what is on screen: a joined pair offers its way apart, a page on its own the
  // neighbours it may join, on the sides of the screen they are on. Paged mode only -- the webtoon column has no pairs --
  // and never under Wide pages -> Split, which shows a spread's halves one by one. The reader settings sheet and the
  // right-click menu both offer these.
  const spreadChoices = useMemo((): SpreadOption[] => {
    if (prefs.mode !== 'paged' || splitTrack || !flat[current]) return [];
    const s = slideOf[current] ?? -1;
    return spreadOptions(flat, current, { slide: slides[s] ?? [], joined: !!joined[s], nextIsLeft: pagedRtl, detector: prefs.joinSplit });
  }, [prefs.mode, prefs.joinSplit, splitTrack, flat, current, slides, slideOf, joined, pagedRtl]);
  const spreadLabel = (o: SpreadOption): string =>
    o.kind === 'merge' ? (o.side === 'left' ? tr('Merge with the page on the left') : tr('Merge with the page on the right'))
    : o.kind === 'split' ? tr('Show as two pages')
    : o.kind === 'unmerge' ? tr('Undo the merge')
    : o.kind === 'pair' ? tr('Merge these two pages')
    : tr('Join these two pages again');
  /**
   * Shown at once, saved on the account, and put back if the server refuses. The chapter's pages carry the marks, so the
   * flow is built again and the joins effect above keeps the page being read in place; a downloaded copy is given the
   * server's answer too (setOfflineSpreadMarks), as it reads its own pages first.
   */
  const applySpread = (o: SpreadOption) => {
    const ch = chapters[flat[current]?.ci ?? -1];
    if (!ch) return;
    const mark = markOf(o);
    const before = new Map(ch.pages.flatMap((p): Array<[number, SpreadMark]> => (p.mark ? [[p.number, p.mark]] : [])));
    const put = (marks: ReadonlyMap<number, SpreadMark>) => setChapters((cs) => cs.map((c) => (c.id === ch.id
      ? { ...c, pages: c.pages.map((p) => (p.mark === marks.get(p.number) ? p : { ...p, mark: marks.get(p.number) })) }
      : c)));
    put(withMark(before, o.first, mark));
    saveMark(ch.id, o.first, mark, ch.pages.length)
      .then((marks) => { put(marks); void setOfflineSpreadMarks(ch.id, marks); })
      .catch(() => { put(before); toast(tr('Could not save'), 'error'); });
  };

  // One place that knows how to move to a page, shared by the scrubber and the page grid. The initial-scroll
  // effect above deliberately does not use it: that one must also seed `lastSent` and run exactly once.
  const jumpTo = useCallback((idx: number) => {
    const el = scrollRef.current;
    const i = Math.max(0, Math.min(flat.length - 1, idx));
    setCurrent(i);
    if (!el) return;
    if (prefs.mode === 'vertical') el.scrollTo({ top: tops[i] || 0 });
    else el.scrollTo({ left: trackSign * (slideOf[i] ?? i) * (el.clientWidth || 0) });
  }, [flat.length, prefs.mode, tops, slideOf, trackSign]);

  /**
   * Mark or un-mark one page by hand, from the page grid.
   *
   * ⚠️ This is the half that makes skipping safe to leave on by default. The automatic rule is arithmetic
   * over repeated images and it will occasionally be wrong in both directions -- a one-off advert repeats
   * nowhere and so can never be detected, and a series really can open every chapter on the same legitimate
   * splash. Without a way to correct it by hand, either mistake would be permanent and the honest default
   * would be off.
   *
   * Optimistic, and it puts the flag back if the server refuses: the grid is a direct-manipulation surface,
   * so waiting on a round-trip before the tile changes reads as a dead control. The decision is stored per
   * page on the server and outranks the heuristic from then on.
   */
  const toggleJunk = useCallback((pageNumber: number, junk: boolean) => {
    const ch = chapters[flat[current]?.ci ?? 0];
    if (!ch) return;
    const apply = (v: boolean) => setChapters((prev) => prev.map((c) => (c.id !== ch.id ? c : {
      ...c, pages: c.pages.map((p) => (p.number === pageNumber ? { ...p, junk: v } : p)),
    })));
    apply(junk);
    // Nothing to reveal: the flow is rebuilt from the flag, so clearing it draws the page at full height on
    // the next render. In `hide` the page is put back the same way, by asking for it explicitly.
    if (!junk) setExpanded((prev) => new Set(prev).add(`${ch.id}:${pageNumber}`));
    api(`/api/books/${ch.id}/pages/${pageNumber}/junk`, { method: 'PUT', json: { junk } })
      .then(() => setOfflinePageJunk(ch.id, pageNumber, junk))
      .catch(() => apply(!junk));
  }, [chapters, flat, current]);

  /**
   * Thumbnails for the chapter being read, and nothing else -- see PageGrid for why.
   *
   * ⚠️ Built from the CHAPTER, so every tile exists whatever the mode, and its jump target is resolved by
   * page number. It used to look each page up in the reading flow, which returned -1 for anything removed --
   * and `jumpTo` clamps -1 to 0, so tapping a dimmed tile scrolled to the top of the whole library. The
   * comment here used to claim it revealed the chapter instead; nothing ever did that.
   */
  // ⚠️ Built only while the grid is open, and each tile's place looked up by key (v0.61.0, F6): this ran on every page
  // turn with a scan of the whole flow per tile -- every page of every loaded chapter, times the pages of this one.
  // `startIndex` still answers for a page Hide took out of the flow.
  const gridPages = useMemo(() => {
    if (!showPages) return [];
    const ci = flat[current]?.ci;
    if (ci == null) return [];
    const ch = chapters[ci];
    if (!ch) return [];
    return ch.pages.map((p) => ({
      idx: indexOfKey.get(`${ch.id}:${p.number}`) ?? startIndex(flat, ci, p.number),
      // A missing placeholder may carry an old junk flag, but it is not furniture and cannot be skipped.
      junk: !!p.junk && !p.missing,
      missing: !!p.missing,
      number: p.number,
      // An offline chapter has no URL to request: its pages are blobs already decoded into memory, and
      // the same blob is the thumbnail.
      src: ch.offline ? blobUrls.current.get(`${ch.id}:${p.number}`) || null : img.page(ch.id, p.number, 200),
    }));
  }, [showPages, flat, current, chapters, indexOfKey]);
  const activeIdx = chapterRefs.findIndex((c) => c.id === activeChapter?.id);
  const prevId = activeIdx > 0 ? chapterRefs[activeIdx - 1]?.id : undefined;
  const nextId = activeIdx >= 0 && activeIdx < chapterRefs.length - 1 ? chapterRefs[activeIdx + 1]?.id : undefined;

  // The chapter you are reading always belongs to a series, but nothing in the reader linked to it. The title
  // was plain text, and the chevron beside it is a history back, which from the home Continue rail lands on
  // home. So while reading there was no way to reach the series short of searching for it by name.
  // Prefer the ACTIVE chapter's series over chapters[0]'s: continuous reading appends chapters as you go.
  const activeSeriesId = activeChapter?.seriesId || seriesId;
  const seriesHref = activeSeriesId ? `/series/?id=${activeSeriesId}` : null;

  const back = () => (typeof window !== 'undefined' && window.history.length > 1 ? router.back() : router.push(seriesId ? `/series/?id=${seriesId}` : '/'));
  // ⚠️ Refresh went back to where the reader was OPENED. Continuous reading appends the next chapters to one track, but the
  // address kept naming the first, so a reload reopened that chapter (and its saved page) however far on the reader had got.
  // The address now follows the chapter on screen; progress for it is saved by the same path, so a reload resumes there.
  // Only while the address is the one the reader knows (`addressed`): a jump changes it first, and until that load has run
  // the chapter on screen is the old one. And only once the open chapter is laid out, read live: the load clears
  // `didInitScroll` in the very commit whose address it was asked for.
  // ⚠️ The first cut held off while `chapters[0]` was not the addressed chapter, and after the first crossing it never was
  // again (the first chapter stays chapters[0]): the address moved on once, and a refresh two chapters on reopened the
  // second. Reintroduce that test: walk263 "the address follows into the third chapter" fails.
  // ⚠️ In place, never through the router. `router.replace` asked the server for the route again, and when that answer
  // could not be used -- a deploy since the page was loaded, or a dropped connection -- Next loaded the whole page
  // instead: crossing into the next chapter reloaded the reader on it, and the chapter before was gone from the track.
  // Next keeps useSearchParams in step with history.replaceState. Reintroduce that test: walk263 "crossing into the next
  // chapter never reloads the page" fails.
  const readingChapterId = ready && didInitScroll.current ? chapters[flat[current]?.ci ?? -1]?.id : undefined;
  useEffect(() => {
    if (!readingChapterId || readingChapterId === bookId || bookId !== addressed.current || !didInitScroll.current) return;
    addressed.current = readingChapterId;
    urlSynced.current = readingChapterId;
    window.history.replaceState(null, '', `/reader/?book=${readingChapterId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readingChapterId, bookId]);
  const goChapter = (cid?: string, atEnd = false) => { urlSynced.current = null; if (cid) router.replace(`/reader/?book=${cid}${atEnd ? '&page=last' : ''}`); };
  /**
   * Read this chapter in another language edition (v0.52.0): the same number there when the server holds it, else
   * that edition's page at the number, where its ghost row has Fetch -- said first, so the jump is not a surprise.
   * A chapter whose number is unknown (offline, the list not in yet) opens the edition's page.
   */
  const switchEdition = async (e: EditionRow) => {
    setShowChapters(false);
    const n = activeChapter ? numberOf.get(activeChapter.id) : undefined;
    if (n == null) { router.push(`/series/?id=${encodeURIComponent(e.seriesId)}`); return; }
    try {
      const target = readerTarget(n, (await fetchAllBooks(e.seriesId)).content, e.seriesId);
      if (target.kind === 'book') { router.replace(`/reader/?book=${target.id}`); return; }
      // `{number}`, not `{n}`: a chapter's number, not a count to agree with.
      toast(tr('Chapter {number} is not on the server in {language} yet.', { number: numLabel(n), language: languageName(e.lang) }), 'info');
      router.push(target.href);
    } catch {
      router.push(`/series/?id=${encodeURIComponent(e.seriesId)}`);
    }
  };
  /** To the next chapter, from the footer, a key, a controller or the menu: said first when it skips numbers (#236). */
  const goNextChapter = () => { if (!nextId) return; warnGap(activeChapter?.id, nextId); goChapter(nextId); };
  /**
   * Leave for the next chapter. From anywhere but the end of this one it takes two presses: the button sits
   * at the edge of the footer beside the slider and the page counter, where a thumb aiming for either lands on
   * it, and one press used to drop the chapter with no way to tell it had happened until the new one drew.
   */
  const goNext = () => {
    if (!nextId) return;
    const remaining = pagesAfter(flat, current);
    if (!skipNeedsConfirm(remaining) || stillArmed(armedNext, Date.now())) { setArmedNext(null); goNextChapter(); return; }
    setArmedNext(Date.now());
  };
  useEffect(() => {
    if (armedNext == null) return;
    const t = setTimeout(() => setArmedNext(null), ARM_MS + 20);
    return () => clearTimeout(t);
  }, [armedNext]);
  // Turning the page or changing chapter is a change of mind: the arm belongs to the page it was pressed on.
  useEffect(() => { setArmedNext(null); }, [current, bookId]);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen?.().catch(() => {});
  };

  // ---- ambient cover-art theming ----
  useEffect(() => {
    if (!seriesId) return;
    let alive = true;
    api<{ color: string | null }>(`/api/series/${seriesId}/color`).then((r) => { if (alive) applyCover(r.color); }).catch(() => {});
    return () => { alive = false; clearCover(); };
  }, [seriesId]);

  // ---- adopt this account's reader settings (they follow the user, not the browser) ----
  const pulledPrefs = useRef(false);
  useEffect(() => {
    if (pulledPrefs.current) return;
    pulledPrefs.current = true;
    // localStorage already painted; this catches up a device that hasn't seen your settings yet. F2 (v0.61.0): with a
    // title open, a late answer changes what is not a look -- the title's own look stays (lib/readerPrefs.ts mergePulled).
    syncPrefsFromServer().then((p) => setPrefs((cur) => mergePulled(cur, p, titleOpen.current))).catch(() => {});
  }, []);

  // ---- per-source, then per-series, memory (mode/theme/spread/direction/zoom) ----
  //
  // Applied in the load effect above, with `ready` (titleLook, F1): global default < source default < this series, a
  // source default fixing everything from it in one go and a title someone has adjusted by hand still winning. Keyed
  // by the SERIES' source, so it holds for downloaded chapters and never changes mid-series.

  // ---- auto-hide chrome ----
  useEffect(() => {
    if (!chrome || showSettings) return;
    const t = setTimeout(() => setChrome(false), 3800);
    return () => clearTimeout(t);
  }, [chrome, showSettings]);

  // ---- one place that does what a key, a controller button or a tap asks (v0.61.0) ----
  /**
   * Do `action` (lib/readerKeys.ts). The keyboard, a controller and the tap zones all come here, so a page turn is the
   * same turn whatever asked for it. `tap` marks one that a double-click may still take back (onTrackDoubleClick).
   */
  const perform = (action: ReaderAction, o: { tap?: boolean } = {}) => {
    const el = scrollRef.current;
    if (PAGE_ACTIONS.has(action)) {
      if (!el) return;
      // One page of a pair in frame (#261): a turn toward the pair's other page goes there first.
      if (prefs.mode === 'paged' && stepFocus(action, o)) return;
      // Next and back are reading order, whichever way the pages run. The page to the left or the right is PHYSICAL,
      // like the arrow keys and the thirds: on a right-to-left read the next page is to the left.
      const d = action === 'next' ? 1 : action === 'prev' ? -1 : (action === 'pageRight' ? 1 : -1) * trackSign;
      if (prefs.mode === 'paged') {
        // Paged mode turns its own pages instead of leaving keys to the browser: the track is a snap-x container,
        // and a native arrow keypress only nudges it a few pixels before the snap pulls it back.
        // ONE SLIDE FROM THE ONE ON SCREEN, never "one width from wherever the scroll is": a relative scrollBy
        // stacked on a smooth scroll still in flight, so two quick presses (or a held key) landed one or two
        // pages on. And from the slide ON SCREEN (v0.61.0, F4), as a tap always did: `slideOf[current]` is a split
        // page's FIRST half, so from its second half the next press went back to the half already on screen.
        const last = Math.max(0, el.children.length - 1); // page slides, then Up Next / the failure card
        const from = slideNow();
        const to = Math.max(0, Math.min(last, from + d));
        if (o.tap) acted.current = { kind: 'turn', slide: from, at: Date.now() };
        lastMoved.current = Date.now(); // before the first scroll event arrives
        el.scrollTo({ left: trackSign * to * (el.clientWidth || window.innerWidth), behavior });
      } else {
        // The column scrolls most of a screen, so a line of the page before stays in view.
        if (o.tap) acted.current = { kind: 'scroll', top: el.scrollTop, at: Date.now() };
        el.scrollBy({ top: d * el.clientHeight * 0.88, behavior });
      }
      return;
    }
    if (action === 'nextChapter') goNextChapter();
    else if (action === 'prevChapter') goChapter(prevId, true);
    else if (action === 'fullscreen') toggleFullscreen();
    else if (action === 'menu') setChrome((c) => !c);
    else if (action === 'focus') toggleFocus();
    else if (action === 'exit') back();
  };
  const performRef = useRef(perform);
  performRef.current = perform;

  // ---- keyboard (desktop) ----
  // The keys in force: this mode's defaults with this device's own bindings (lib/readerKeys.ts reproduces v0.60's).
  const keyMap = useMemo(() => keyMapFor(prefs.mode, device.keys), [prefs.mode, device.keys]);
  /**
   * Whether the Escape being handled found a dialog open when it was pressed (v0.87.0). ⚠️ A sheet closes itself on
   * Escape (components/ui.tsx Sheet listens on the document), and React renders that close between the document's
   * listeners and the window's -- so the handler below, on the window, read every sheet as already shut and left the
   * reader: Escape on the chapter list or a chapter's comments sent the reader back to the series. Noted in the capture
   * phase, before anything has closed. Reintroduce by dropping the check in the Escape line: walkComments "Escape closes
   * the comments, not the reader" ends on the series page.
   */
  const escFoundDialog = useRef(false);
  useEffect(() => {
    const note = (e: KeyboardEvent) => { if (e.key === 'Escape') escFoundDialog.current = !!document.querySelector('[role="dialog"]'); };
    window.addEventListener('keydown', note, true);
    return () => window.removeEventListener('keydown', note, true);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Alt+← is the browser's Back and Ctrl/Cmd+F its Find: a key with a modifier is never the reader's.
      // (Shift is not a modifier here -- Shift+Space means "back a page", as in any scrolling view.)
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      // The right-click menu has the keys while it is open (arrows, Enter, and Escape closes it, not the reader).
      if (menuOpen.current) return;
      // An open sheet (settings, page grid, chapter list, the key list) is what the keys are for: turning pages
      // underneath it, or leaving the reader on Escape, acted on the thing the reader was not looking at. None of
      // them listens for Escape itself, so it is handled here, and it closes the sheet.
      if (showSettings || showPages || showChapters || showKeys || talkFor) {
        if (e.key === 'Escape') { setShowSettings(false); setShowPages(false); setShowChapters(false); setShowKeys(false); setTalkFor(null); }
        else if (e.key === '?' && showKeys && !e.repeat) setShowKeys(false);
        return;
      }
      const t = e.target as HTMLElement | null;
      // ? lists the shortcuts, once a press: held, its repeats opened and closed the list until the key came up. Not
      // in a text field or anything editable, and not when the reader has bound ? to something.
      if (e.key === '?' && !e.repeat && !/^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? '') && !t?.isContentEditable
        && !READER_ACTIONS.some((a) => keyMap[a].includes('?'))) { e.preventDefault(); setShowKeys(true); return; }
      // Escape is reserved, never bound: it leaves the reader. ⚠️ Once a press -- Escape repeating called
      // history.back() until it left the reader for wherever came before. And never the press that closed a sheet.
      if (e.key === 'Escape') { if (!e.repeat && !escFoundDialog.current) back(); return; }
      // A focused control owns its keys: the page slider its arrows, a button or link its Space and Enter
      // (turning the page instead swallowed the click), a text field everything.
      const owned = !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable
        || !!t.closest('button, a, [role="button"], [role="dialog"]'));
      const action = actionForKey(e, keyMap, { owned });
      if (!action) return;
      // A bound key is the reader's: the browser's own handling of it (Space scrolling the page) is stopped.
      e.preventDefault();
      performRef.current(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyMap, seriesId, showSettings, showPages, showChapters, showKeys, talkFor]);

  // ---- a game controller (v0.61.0, lib/readerPad.ts) ----
  // Polled only while one is connected and the tab is visible; still while a sheet is open over the pages.
  const padMap = useMemo(() => padMapFor(device.pad), [device.pad]);
  const padConnected = useGamepad((a) => performRef.current(a), padMap, showSettings || showPages || showChapters || showKeys || !!talkFor);

  // ---- tap / double-tap / pinch (no overlay -> native scroll works) ----
  const onPointerDown = (e: React.PointerEvent) => {
    lastPointer.current = e.pointerType;
    // Only the primary button is a tap. A right or middle click is the browser's own (the context menu, auto-scroll), and
    // it used to count as a tap here too: a right click on the edge of a page turned it, and one in the middle toggled the controls.
    if (e.pointerType === 'mouse' && e.button !== 0) { tap.current = null; return; }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const p = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), zoom };
      tap.current = null;
      if (tapTimer.current) { clearTimeout(tapTimer.current); tapTimer.current = null; }
    } else {
      tap.current = { x: e.clientX, y: e.clientY, t: Date.now() };
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size === 2) {
      const p = [...pointers.current.values()];
      const dist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      setZoom(Math.max(1, Math.min(3, pinch.current.zoom * (dist / pinch.current.dist))));
    }
  };
  const onPointerEnd = (e: React.PointerEvent) => {
    const wasPinch = !!pinch.current;
    pointers.current.delete(e.pointerId);
    if (wasPinch && pointers.current.size < 2) {
      pinch.current = null;
      if (seriesId0) saveSeriesPrefs(seriesId0, { zoom });
      tap.current = null;
      return;
    }
    if (wasPinch) return;
    const s = tap.current; tap.current = null;
    if (!s) return;
    const now = Date.now();
    // A mouse is NOT double-detected here: `onTrackDoubleClick` below takes it, because the interval that
    // defines a double-click is an OS setting this page cannot read. Two detectors for one gesture zoom in
    // and then straight back out.
    const act = readTap({
      from: s,
      to: { x: e.clientX, y: e.clientY, t: now },
      width: scrollRef.current?.clientWidth || window.innerWidth,
      height: scrollRef.current?.clientHeight || window.innerHeight,
      layout: device.tapLayout,
      mode: prefs.mode,
      lastTapAt: lastTapAt.current,
      doubleDetect: e.pointerType !== 'mouse',
      lastDoubleAt: lastDoubleAt.current,
    });
    if (act.kind === 'none') return; // a scroll, or a press held long enough to be something else
    if (act.kind === 'double') {
      cancelPendingTap();
      lastTapAt.current = 0;
      handledDouble.current = now;
      lastDoubleAt.current = now;
      applyZoom(zoom > 1 ? 1 : 2);
      return;
    }
    // ⚠️ Cancel first. A mouse's second click also lands here (it is not double-detected), and leaving the
    // first one's timer running would turn the page from a gesture that only ever meant zoom.
    cancelPendingTap();
    lastTapAt.current = now;
    const zone = act.zone;
    // #232, Tap a page of a pair to see it alone (this device, off until chosen): a tap ON a page of a pair brings that
    // page into frame instead of what its zone does. Off, this is never asked, and every tap is the tap layout's.
    const target = device.tapFocus ? pageOfPairAt(e.clientX, e.clientY) : null;
    if (target) {
      const prev = focus;
      tapTimer.current = setTimeout(() => { tapTimer.current = null; acted.current = { kind: 'focus', prev, at: Date.now() }; setFocus(target); }, act.after);
      return;
    }
    tapTimer.current = setTimeout(() => { tapTimer.current = null; runTap(zone); }, act.after);
  };

  const cancelPendingTap = () => {
    if (tapTimer.current) { clearTimeout(tapTimer.current); tapTimer.current = null; }
  };

  /** The slide the paged track is on, the way `onScroll` reads it -- an RTL track counts in negative px. */
  const slideNow = () => {
    const el = scrollRef.current;
    return el ? Math.round(Math.abs(el.scrollLeft) / Math.max(1, el.clientWidth)) : 0;
  };

  // ---- one page of a pair in frame (#232 a tap, #261 the `focus` key) ----
  /**
   * The pages of slide `s` in the order the slide draws them (the DOM's). A joined spread (#229) as it sits in the
   * spread, left to right, by the side the server found: the slide is laid out left to right whatever the track's
   * direction. Any other pair as the track lays it out -- RTL manga reads its right page first, and on a right-to-left
   * track `dir` already lays the slide out from the right, so flipping here as well would put it back the wrong way
   * round; a right-to-left series forced to read left to right still swaps, since a double-page spread is ONE drawing
   * and only reassembles with its first page on the right.
   */
  const shownOf = (s: number): number[] => {
    const idxs = slides[s] ?? [];
    if (idxs.length !== 2) return idxs;
    if (joined[s]) return joinedOrder(idxs[0], idxs[1], flat[idxs[0]]?.join);
    return rtl && !pagedRtl ? [idxs[1], idxs[0]] : idxs;
  };
  /** Slide `s`'s two pages as they sit on screen, left then right; null when it holds no pair (paged mode only). */
  const pairOnScreen = (s: number): number[] | null => {
    const shown = shownOf(s);
    if (prefs.mode !== 'paged' || shown.length !== 2) return null;
    return pagedRtl && !joined[s] ? [shown[1], shown[0]] : shown;
  };
  /** The `focus` action: the pair's first page in reading order into frame, or the pair back. False when there is no pair. */
  const toggleFocus = (): boolean => {
    const s = slideNow();
    if (focus?.slide === s) { setFocus(null); return true; }
    if (!pairOnScreen(s)) return false;
    setFocus({ slide: s, page: slides[s][0] });
    return true;
  };
  /**
   * A turn while one page of the pair is in frame: to the pair's other page when the turn points at it -- ← and → by
   * the side it sits on, next and back by reading order -- so a spread is read a page at a time. False at the pair's edge,
   * where the turn moves on as it always does, and the slide after shows its pages whole.
   */
  const stepFocus = (action: ReaderAction, o: { tap?: boolean }): boolean => {
    const s = slideNow();
    if (!focus || focus.slide !== s) return false;
    const on = pairOnScreen(s);
    const idxs = slides[s];
    if (!on || !idxs) return false;
    const to = action === 'pageLeft' || action === 'pageRight'
      ? on[on.indexOf(focus.page) + (action === 'pageLeft' ? -1 : 1)]
      : idxs[idxs.indexOf(focus.page) + (action === 'next' ? 1 : -1)];
    if (to === undefined) return false;
    if (o.tap) acted.current = { kind: 'focus', prev: focus, at: Date.now() };
    setFocus({ slide: s, page: to });
    return true;
  };
  /**
   * Under Tap a page of a pair to see it alone (#232, this device): the page of the pair on screen that a tap at (x, y)
   * landed on, to bring into frame. Null when the slide is no pair, a page of it is in frame already (a single page's
   * taps are the tap zones'), or the tap fell on the black round the pages. Hit-tested on what is drawn: a page of a
   * slide is one element of it, in shownOf's order, and a cropped page's image is clipped to its box.
   */
  const pageOfPairAt = (x: number, y: number): { slide: number; page: number } | null => {
    const el = scrollRef.current;
    const s = slideNow();
    if (!el || focus?.slide === s || !pairOnScreen(s)) return null;
    const hit = document.elementFromPoint(x, y);
    const box = el.children[s] as HTMLElement | undefined;
    if (!box || !(hit instanceof HTMLImageElement) || !box.contains(hit)) return null;
    // A joined spread turned on its side (Rotate) is one element holding both pages, left then right as drawn.
    const imgs = Array.from(box.querySelectorAll('img'));
    const shown = shownOf(s);
    const k = box.children.length === 1 ? imgs.indexOf(hit) : Array.from(box.children).findIndex((c) => c.contains(hit));
    return k >= 0 && shown[k] !== undefined ? { slide: s, page: shown[k] } : null;
  };

  /**
   * What a tap does once the double window has closed, remembered well enough to be taken back. The zone is the tap
   * layout's (lib/readerGesture.ts tapZone, Reader → Tap zones): the physical edges turn through the track's direction
   * as the arrow keys do -- the left edge of the screen is still the left edge on a right-to-left read -- and the L's
   * and the Kindle map's zones are reading order. Through `perform`, so a tap turns exactly as a key does: an absolute
   * target, one slide from the one on screen.
   */
  const runTap = (zone: TapZone) => {
    if (zone === 'chrome') {
      acted.current = { kind: 'chrome', at: Date.now() };
      setChrome((c) => !c);
      return;
    }
    perform(zone === 'back' ? 'pageLeft' : zone === 'forward' ? 'pageRight' : zone, { tap: true });
  };

  /**
   * A mouse's double-click: zoom, and only zoom.
   *
   * The browser knows the reader's actual double-click setting and this page does not, so the pairing is
   * left to it -- but that means the first click may already have turned a page by the time this arrives.
   * Undo that: a double-click is one gesture, and this one means zoom. See lib/readerGesture.ts.
   */
  const onTrackDoubleClick = (e: React.MouseEvent) => {
    // A touch double-tap raises this too, and the pointer path has already zoomed for it.
    if (Date.now() - handledDouble.current < 700) return;
    // A repeated-page strip owns its own clicks (it stops the pointer gesture for the same reason).
    if ((e.target as HTMLElement).closest?.('button, a')) return;
    cancelPendingTap();
    lastTapAt.current = 0;
    lastDoubleAt.current = Date.now();
    const a = acted.current;
    acted.current = null;
    if (a && undoWindow(a.at, Date.now())) {
      const el = scrollRef.current;
      if (a.kind === 'turn' && el) el.scrollTo({ left: trackSign * a.slide * (el.clientWidth || window.innerWidth) });
      else if (a.kind === 'scroll' && el) el.scrollTo({ top: a.top });
      else if (a.kind === 'chrome') setChrome((c) => !c);
      else if (a.kind === 'focus') setFocus(a.prev);
    }
    applyZoom(zoom > 1 ? 1 : 2);
  };

  const total = flat.length;
  const pageInChapter = activeChapter ? (flat[current]?.number ?? 0) : 0;

  // ---- translated pages (v0.85.0) ----
  // The chapter being read is asked for from the page it is on, and the next one once it is done: the server does one
  // page at a time, the latest ask first. While it still has pages of a chapter to do, the reader asks again every 5 s
  // (only while the tab is in view) for the pages done since, and a done page's address changes to the translated one.
  const trAsked = useRef<Set<string>>(new Set());
  const askTranslation = (id: string, from: number) => {
    if (trAsked.current.has(id)) return;
    trAsked.current.add(id);
    api<TranslateStatus>(`/api/books/${encodeURIComponent(id)}/translations`, { method: 'POST', json: { lang: trLang, from } })
      .then((st) => setTrStatus((cur) => ({ ...cur, [id]: st })))
      .catch(() => { trAsked.current.delete(id); });
  };
  useEffect(() => {
    if (!trOn || !activeChapter || activeChapter.offline) return;
    askTranslation(activeChapter.id, Math.max(1, pageInChapter));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trOn, activeChapter?.id]);
  const trHere = activeChapter ? trStatus[activeChapter.id] : undefined;
  useEffect(() => {
    if (!trOn || !nextId || !trHere || trHere.pending > 0) return;
    askTranslation(nextId, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trOn, nextId, trHere?.pending]);
  const trPendingIds = trOn ? Object.keys(trStatus).filter((id) => trStatus[id].pending > 0).join(' ') : '';
  useEffect(() => {
    if (!trPendingIds) return;
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      for (const id of trPendingIds.split(' ')) {
        api<TranslateStatus>(`/api/books/${encodeURIComponent(id)}/translations?lang=${encodeURIComponent(trLang)}`)
          .then((st) => setTrStatus((cur) => ({ ...cur, [id]: st })))
          .catch(() => {});
      }
    }, 5000);
    return () => clearInterval(t);
  }, [trPendingIds, trLang]);
  const trLine = trOn && activeChapter ? translating(trHere, activeChapter.pages.length) : null;

  // ---- bookmarks ----
  // A bookmark is a note about a page, not a pointer to bytes, so it is keyed on (book, page) and survives
  // anything that happens to the file -- the same reasoning that keeps reading progress when a series' files
  // are deleted. Loaded per chapter so the star reflects the page you are actually on.
  const [marks, setMarks] = useState<Set<string>>(new Set());
  const markKey = (bookId: string, page: number) => `${bookId}:${page}`;
  const bookmarked = activeChapter ? marks.has(markKey(activeChapter.id, pageInChapter)) : false;
  useEffect(() => {
    if (!seriesId) return;
    api<{ content: Array<{ book_id: string; page: number }> }>(`/api/bookmarks?seriesId=${encodeURIComponent(seriesId)}`)
      .then((r) => setMarks(new Set(r.content.map((b) => markKey(b.book_id, b.page)))))
      .catch(() => {});
  }, [seriesId]);

  const toggleBookmark = async () => {
    if (!activeChapter || !pageInChapter) return;
    const k = markKey(activeChapter.id, pageInChapter);
    const on = marks.has(k);
    // Optimistic: the star is a one-tap control in a reader, and waiting on a round-trip to redraw it makes
    // it feel broken. Reverted if the write fails.
    setMarks((prev) => { const n = new Set(prev); on ? n.delete(k) : n.add(k); return n; });
    try {
      await api(`/api/bookmarks/${encodeURIComponent(activeChapter.id)}/${pageInChapter}`,
        { method: on ? 'DELETE' : 'PUT', json: on ? undefined : {} });
    } catch {
      setMarks((prev) => { const n = new Set(prev); on ? n.add(k) : n.delete(k); return n; });
    }
  };
  const chapterPageCount = activeChapter?.pages.length ?? 0;

  // ---- the right-click menu (the menu the Library and the series page use, components/ContextMenu.tsx) ----
  // What one wants under a hand while reading: the page (zoom, bookmark, jump), the chapter (next, previous, the list), how it is
  // laid out, and the way out. Shift+right-click is still the browser's own menu (lib/contextMenus.ts wantsOwnMenu), which is where
  // "Save image as" lives. Only the mouse's right button opens it: a touch screen keeps its taps and holds, so the reader's
  // gestures are untouched.
  const readerMenu = useContextMenu((): MenuItem[] => {
    const items: MenuItem[] = [
      { label: zoom > 1 ? tr('Reset zoom') : tr('Zoom in'), onSelect: () => applyZoom(zoom > 1 ? 1 : 2) },
      { label: bookmarked ? tr('Remove bookmark') : tr('Bookmark this page'), onSelect: () => { void toggleBookmark(); }, disabled: !activeChapter || !pageInChapter },
      { label: tr('Jump to a page'), onSelect: () => setShowPages(true) },
      { label: tr('Next chapter'), onSelect: () => goNextChapter(), disabled: !nextId, divider: true },
      { label: tr('Previous chapter'), onSelect: () => goChapter(prevId, true), disabled: !prevId },
    ];
    if (chapterRefs.length > 0) items.push({ label: tr('Chapters'), onSelect: () => setShowChapters(true) });
    if (talkOn && activeChapter) items.push({ label: tr('Comments'), onSelect: () => setTalkFor(activeChapter.id) });
    if (prefs.mode === 'paged') {
      items.push({ label: prefs.spread ? tr('Read in single pages') : tr('Read in double spreads'), onSelect: () => setPref({ spread: !prefs.spread }), divider: true });
      // v0.89.0 (#262): this page's merge or split, as the reader settings sheet offers it.
      for (const o of spreadChoices) items.push({ label: spreadLabel(o), onSelect: () => applySpread(o) });
    }
    items.push(
      { label: tr('Full screen'), onSelect: () => toggleFullscreen(), divider: prefs.mode !== 'paged' },
      { label: chrome ? tr('Hide controls') : tr('Show controls'), onSelect: () => setChrome((c) => !c) },
      { label: tr('Reader settings'), onSelect: () => setShowSettings(true) },
    );
    if (seriesHref) items.push({ label: tr('Open the series'), onSelect: () => router.push(seriesHref), divider: true });
    items.push({ label: tr('Leave the reader'), onSelect: () => back(), divider: !seriesHref });
    return items;
  }, { label: tr('Reader') });
  menuOpen.current = readerMenu.open;
  /**
   * Only the mouse's right button: the hook's touch long-press is left out, so the reader's own gestures stay as they were.
   * And a long-press is not a right click: Android Chrome and Windows touch send `contextmenu` for one, and there the
   * browser's own menu (save or share the image) is what holding a page is for. Chromium and Firefox name the pointer on
   * the event; Safari's is a plain MouseEvent, so the page's last press names it there.
   */
  const menuBind = {
    onContextMenu: (e: React.MouseEvent<HTMLElement>) => {
      if (((e.nativeEvent as Partial<PointerEvent>).pointerType || lastPointer.current) === 'touch') return;
      readerMenu.bind.onContextMenu(e);
    },
  };

  // the header's two-line "what you are reading" block, wrapped in a link to the series when we know its id
  const titleBlock = (
    <>
      <p className="flex items-center gap-1 text-sm font-medium text-white transition group-hover:text-accent">
        <span className="truncate">{activeChapter?.seriesTitle || tr('Reading')}</span>
        {seriesHref && <IcChevronRight width={14} height={14} className="shrink-0 text-fog-500 transition group-hover:text-accent" />}
      </p>
      <p className="truncate text-[11px] text-fog-400">
        {activeChapter?.title}
        {trLine && <span data-translating>{` · ${tr('Translating… {done}/{total}', trLine)}`}</span>}
      </p>
    </>
  );

  // end-of-series "Up Next" card (rendered at the tail of both reading modes)
  /**
   * What the reader sees when a chapter will not open. Previously nothing: a black screen on first load, or
   * the "You finished" card mid-series. Both told them to stop looking.
   */
  const retry = () => { setFailed(null); setReady(false); setReloadKey((k) => k + 1); };
  const failureCard = (
    <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}
      className="mx-auto w-full max-w-3xl px-6 py-16 text-center">
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-fog-500">
        {failed === 'pruned' ? tr('Chapter deleted') : failed === 'unreadable' ? tr('Chapter unreadable') : tr('Chapter unavailable')}
      </p>
      <h2 className="mt-1.5 font-display text-2xl font-bold text-white">
        {activeChapter?.seriesTitle || tr('This chapter')}
      </h2>
      <p className="mx-auto mt-3 max-w-md text-sm text-fog-400">
        {/* Neutral about WHO deleted it: the same tombstone is left by an admin's Delete from server and
            by the scheduled cleanup, and the reader cannot tell which. The old sentence described the
            cleanup's policy on installs where that job is off -- which is the default. */}
        {failed === 'pruned'
          ? tr('The file for this chapter was deleted from the server \u2014 by an admin, or by the read-chapter cleanup. The rest of the series is not affected; an admin can fetch it again.')
          : failed === 'unreadable'
            ? tr('This chapter has no readable pages. The file may be damaged, or its library may not be mounted right now.')
            : tr('This chapter could not be loaded. It may have been removed, or the connection dropped.')}
      </p>
      <div className="mt-6 flex justify-center gap-2">
        {/* No Try again for a pruned chapter: there is nothing to retry, and a button that cannot work is
            worse than no button. */}
        {failed !== 'pruned' && <button onClick={retry} className="btn-accent text-sm">{tr('Try again')}</button>}
        <button onClick={() => (seriesHref ? router.push(seriesHref) : back())} className={`text-sm ${failed === 'pruned' ? 'btn-accent' : 'btn-ghost'}`}>{tr('Back to series')}</button>
      </div>
    </motion.div>
  );

  /**
   * The end of the road -- but WHICH road depends on where the chapter list came from.
   *
   * With the live list, reaching the last entry means you finished the series, and the recommendations below
   * are earned. With only the downloaded list, it means you ran out of what is on this device, which is a
   * completely different sentence: there may be fifty more chapters waiting online. Saying "you finished" to
   * someone on a plane is both wrong and deflating, and it is what this reader did after every offline
   * chapter before the empty-list guard above existed.
   */
  const offlineEnd = refsFrom === 'offline';
  const upNextCard = (
    <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
      className="mx-auto w-full max-w-3xl px-6 py-16 text-center">
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-fog-500">
        {offlineEnd ? tr('End of your downloads') : <ReaderEndLabel seriesId={activeSeriesId} />}
      </p>
      <h2 className="mt-1.5 font-display text-2xl font-bold text-white">{activeChapter?.seriesTitle || tr('This series')}</h2>
      {!offlineEnd && <ReaderEndRadar seriesId={activeSeriesId} />}
      {/* v0.87.0: no strip follows the last chapter, so its talk is here. */}
      {talkOn && !offlineEnd && chapters.length > 0 && (
        <div className="mt-5 flex flex-col items-center gap-2.5" data-talk-last>
          <TalkStrip bookId={chapters[chapters.length - 1].id} seriesId={chapters[chapters.length - 1].seriesId} onOpen={openTalk} />
        </div>
      )}
      {offlineEnd && (
        <p className="mx-auto mt-2 max-w-sm text-sm text-fog-400">
          {tr('This is the last chapter you have offline. Reconnect to keep reading.')}
        </p>
      )}
      <div className="mt-6 flex justify-center gap-2">
        {/* labelled "Back to series", so go to the series -- `back` is history-first and from the home
            Continue rail would land on home instead */}
        <button onClick={() => (seriesHref ? router.push(seriesHref) : back())} className="btn-ghost text-sm">{tr('Back to series')}</button>
        {/* 'Offline', the name of the tab it opens: since v0.49.0 "Downloads" names only the server's view
            (Library -> Downloads), and this is the chapters kept on this device. */}
        {offlineEnd
          ? <button onClick={() => router.push('/downloads/')} className="btn-accent text-sm">{tr('Offline')}</button>
          : <button onClick={() => router.push('/')} className="btn-accent text-sm">{tr('Home')}</button>}
      </div>
      {ended && !offlineEnd && <NextInStory seriesId={seriesId} />}
      {!offlineEnd && !!upNext?.content?.length && (
        <div className="mt-12 text-start">
          <SectionTitle>{tr('Because you finished this')}</SectionTitle>
          <ScrollRail label={tr('Because you finished this')} className={CARD_RAIL}>{upNext.content.map((s) => <SeriesCard key={s.id} series={s} />)}</ScrollRail>
        </div>
      )}
    </motion.div>
  );

  return (
    // `data-page` / `data-chapter`: what is being read, for the browser walks (test/e2e/v610Walk-reader.mjs) -- the counter
    // that says it lives in the auto-hiding footer. Nothing reads them in the app.
    <div className="fixed inset-0 z-40 bg-ink-950" data-page={pageInChapter || undefined} data-chapter={activeChapter?.id}>
      {readerMenu.element}
      <div className="pointer-events-none absolute inset-0 z-30 bg-black" style={{ opacity: 1 - prefs.brightness }} />
      {/* Ambient cover wash framing the reader: the look, by default. Its switch (Cover colour at the edges, #170)
          removes the two bands outright rather than their colour, because with no colour they are still a 16 %
          black band over the page. */}
      {prefs.coverEdges && (
        <>
          <div data-cover-edge="top" className="pointer-events-none absolute inset-x-0 top-0 z-20 h-36" style={{ background: 'linear-gradient(to bottom, rgb(var(--cover, 0 0 0) / 0.16), transparent)' }} />
          <div data-cover-edge="bottom" className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-36" style={{ background: 'linear-gradient(to top, rgb(var(--cover, 0 0 0) / 0.16), transparent)' }} />
        </>
      )}

      {/* PAGES */}
      {/* ⚠️ overflow-anchor is off below because `tops` -- computed in JS and never measured back from the
          DOM -- is the only model of the layout there is. A browser that quietly adjusts scrollTop to keep
          content in view desynchronises it from `current` with no symptom and no way to detect it. */}
      {prefs.mode === 'vertical' ? (
        <div ref={scrollRef} data-lenis-prevent style={{ overflowAnchor: 'none' }} onScroll={onScroll} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onDoubleClick={onTrackDoubleClick} {...menuBind}
          className={`h-screen-d touch-pan-y overflow-y-auto overscroll-contain ${zoom > 1 ? 'overflow-x-auto' : 'overflow-x-hidden'}`}>
          <div className="mx-auto" style={{ width: colW || '100%', filter: THEME_FILTER[prefs.theme] }}>
            <div className="h-2" />
            {flat.map((p, i) => (
              <ReaderPageRow key={p.key} item={p} height={heights[i]} gap={prefs.gap}
                divider={p.firstOfChapter && p.ci > 0 ? (chapters[p.ci]?.title || tr('Next chapter')) : null}
                seam={talkOn && p.firstOfChapter && p.ci > 0 ? chapters[p.ci - 1]?.id ?? null : null}
                seamLabel={p.firstOfChapter && p.ci > 0 ? chapters[p.ci - 1]?.title ?? null : null}
                seamSeries={p.firstOfChapter && p.ci > 0 ? chapters[p.ci - 1]?.seriesId ?? null : null}
                seamActive={activeSet.has(i) || activeSet.has(i - 1)} onSeam={openTalk}
                src={activeSet.has(i) ? srcFor(i) : null}
                stripSrc={p.collapsed ? stripSrc(i) : null}
                recollapsible={collapsing && !!p.junk && !p.missing && expanded.has(p.key)}
                missingSource={p.missing ? sourceNameOf(chapters[p.ci]?.sourceId) : null}
                wide={!p.missing && isWide(p) ? wideMode : 'whole'} rightFirst={rightFirst}
                crop={rowCrop(p, !p.missing && isWide(p) ? wideMode : 'whole')} imgFilter={imgFilter}
                onLoaded={prefs.cropBorders ? onPageLoad : undefined}
                onExpand={expandPage} onCollapse={collapsePage} />
            ))}
            {ended && upNextCard}
            {failed && !!flat.length && failureCard}
          </div>
        </div>
      ) : (
        <div ref={scrollRef} data-lenis-prevent onScroll={onScroll} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onDoubleClick={onTrackDoubleClick} {...menuBind}
          dir={pagedRtl ? 'rtl' : 'ltr'}
          className="hide-scrollbar flex h-screen-d snap-x snap-mandatory overflow-x-auto overflow-y-hidden" style={{ filter: THEME_FILTER[prefs.theme] }}>
          {slides.map((slideIdxs, s) => {
            // One page of the pair brought into frame (#232/#261, `focus`): the slide holds just it, and everything below
            // lays it out as a single page.
            const focused = focus?.slide === s && slideIdxs.includes(focus.page);
            const idxs = focused ? [focus!.page] : slideIdxs;
            // The pages in the order the slide draws them (shownOf: RTL manga's right page first; a joined spread by the side
            // the server found).
            const shown = focused ? idxs : shownOf(s);
            // #229: a spread joined from two files is one picture. Laid out left to right as drawn, whatever the track's
            // direction, and with no gap down the middle -- only here: every other pair keeps its gutter. Under Wide pages ->
            // Rotate, on a screen held upright, it is turned on its side as a spread in one file is.
            const isJoined = joined[s] && idxs.length === 2;
            const turnedPair = isJoined && wideMode === 'rotate';
            // v0.61.0: one half of a wide page (Wide pages → Split) is a slide of its own, keyed apart from its twin.
            const halfOf = half[s];
            return (
              <div key={halfOf ? `${flat[idxs[0]].key}:${halfOf}` : flat[slideIdxs[0]].key} dir={isJoined ? 'ltr' : undefined} data-joined={isJoined || undefined}
                className={`relative flex h-full w-full shrink-0 snap-center snap-always items-center justify-center${isJoined ? '' : ' gap-1'}`}>
                {turnedPair ? (
                  // Both pages, or neither: half a spread turned on its side is no page at all.
                  shown.every((i) => activeSet.has(i) && srcFor(i) && flat[i].width && flat[i].height)
                    ? <SlideTurnedPair pages={shown.map((i) => ({ src: srcFor(i)!, alt: tr('Page {n}', { n: flat[i].number }), width: flat[i].width!, height: flat[i].height! }))}
                        area={area} zoom={zoom} filter={imgFilter} />
                    : shown.map((i) => <span key={flat[i].key} className="text-ink-600">{flat[i].number}</span>)
                ) : shown.map((i) => {
                  const p = flat[i];
                  if (!(activeSet.has(i) && srcFor(i))) return <span key={p.key} className="text-ink-600">{p.number}</span>;
                  // A placeholder page gets a box of its own so the caption sits over THAT page and not over
                  // the whole spread. `h-full` on the box is what keeps the image's `max-h-full` meaningful:
                  // a percentage max-height against an auto-height parent is no limit at all, and the page
                  // would overflow the slide. Ordinary pages keep the bare <img>, byte for byte as before.
                  if (p.missing) {
                    return (
                      <div key={p.key} className={`relative flex h-full items-center justify-center ${idxs.length === 2 ? 'max-w-[50%]' : 'max-w-full'}`}
                        style={{ transform: zoom !== 1 ? `scale(${zoom})` : undefined }}>
                        <ReaderImg src={srcFor(i)!} alt={tr('Page {n}', { n: p.number })} className="max-h-full object-contain" filter={imgFilter} />
                        <MissingCaption number={p.number} source={sourceNameOf(chapters[p.ci]?.sourceId)} dir={uiDir} />
                      </div>
                    );
                  }
                  // v0.61.0, Crop page borders: this page's measured margins -- undefined until measured, null when the
                  // page could not be read back (then it is drawn whole). A spread's two pages share a top and a bottom
                  // and keep their gutter (pairCrop), so neither is trimmed until both are measured.
                  const cropOn = prefs.cropBorders;
                  const box = cropOn ? pageBoxes.current.get(p.key) : undefined;
                  const loaded = cropOn ? (el: HTMLImageElement) => onPageLoad(p.key, el) : undefined;
                  // v0.61.0, Wide pages: one half of the page, or the page turned on its side, fitted to the slide. A page
                  // whose size is not known is never wide (lib/readerSpread.ts rule 5), so it never gets here.
                  if (halfOf && p.width && p.height) {
                    return <SlideRegion key={p.key} src={srcFor(i)!} alt={tr('Page {n}', { n: p.number })} width={p.width} height={p.height}
                      region={cropOn ? halfCrop(halfOf, box?.all ?? WHOLE) : halfOf === 'left' ? LEFT_HALF : RIGHT_HALF}
                      half={halfOf} area={area} zoom={zoom} pending={cropOn && box === undefined} onLoaded={loaded}
                      filter={imgFilter} trimmed={cropOn ? (box?.all ?? WHOLE).l : undefined} />;
                  }
                  if (wideMode === 'rotate' && idxs.length === 1 && isWide(p)) {
                    return <SlideTurned key={p.key} src={srcFor(i)!} alt={tr('Page {n}', { n: p.number })} width={p.width!} height={p.height!}
                      area={area} zoom={zoom} filter={imgFilter} />;
                  }
                  if (cropOn) {
                    const w = p.width || box?.w;
                    const h = p.height || box?.h;
                    if (!(w && h)) {
                      return <SlidePending key={p.key} src={srcFor(i)!} alt={tr('Page {n}', { n: p.number })} zoom={zoom} onLoaded={loaded} filter={imgFilter}
                        className={`max-h-full object-contain ${idxs.length === 2 ? 'max-w-[50%]' : 'max-w-full'}`} />;
                    }
                    let region: Region = box?.all ?? WHOLE;
                    let pending = box === undefined;
                    if (shown.length === 2) {
                      // By where the pages SIT, left then right (pairOnScreen): the gutter is the left page's right side and
                      // the right page's left side, and on a right-to-left track the first page drawn is the right one.
                      const sits = pairOnScreen(s) ?? shown;
                      const pair = sits.map((j) => pageBoxes.current.get(flat[j].key));
                      pending = pair.some((b) => b === undefined);
                      region = pairCrop(pair[0]?.all ?? WHOLE, pair[1]?.all ?? WHOLE)[sits.indexOf(i)];
                    }
                    // Half the slide each, less half the gap -- a joined spread has none.
                    return <SlideRegion key={p.key} src={srcFor(i)!} alt={tr('Page {n}', { n: p.number })} width={w} height={h}
                      region={region} area={shown.length === 2 ? { w: area.w / 2 - (isJoined ? 0 : 2), h: area.h } : area} zoom={zoom}
                      pending={pending} onLoaded={loaded} filter={imgFilter} trimmed={region.l} />;
                  }
                  return (
                    <ReaderImg key={p.key} src={srcFor(i)!} alt={tr('Page {n}', { n: p.number })}
                      className={`max-h-full object-contain ${idxs.length === 2 ? 'max-w-[50%]' : 'max-w-full'}`}
                      style={{ transform: zoom !== 1 ? `scale(${zoom})` : undefined }} filter={imgFilter} />
                  );
                })}
              </div>
            );
          })}
          {ended && (
            <div data-lenis-prevent dir={uiDir} className="flex h-full w-full shrink-0 snap-center items-start justify-center overflow-y-auto">
              {upNextCard}
            </div>
          )}
          {failed && !!flat.length && (
            <div data-lenis-prevent dir={uiDir} className="flex h-full w-full shrink-0 snap-center items-start justify-center overflow-y-auto">
              {failureCard}
            </div>
          )}
        </div>
      )}

      {/* #232/#261: one page of a pair in frame -- which one, and the way back to both, as a squared key like the reader's other
          actions (never a capsule). Under the bars while they show; the key's cap is this device's own binding. */}
      {prefs.mode === 'paged' && focus && !chrome && flat[focus.page] && (
        <div dir={uiDir} className="pointer-events-none absolute inset-x-0 bottom-[max(0.9rem,calc(env(safe-area-inset-bottom)+0.4rem))] z-30 flex justify-center" data-focus-label>
          <button type="button" onClick={() => setFocus(null)}
            className="pointer-events-auto flex items-center gap-2 rounded-md border border-white/15 bg-black/70 px-3 py-1.5 text-xs text-white backdrop-blur">
            <span>{tr('Page {n}', { n: flat[focus.page].number })}</span>
            <span aria-hidden className="text-white/50">·</span>
            <span>{tr('Show both pages')}</span>
            {hasKeyboard && keyMap.focus[0] && <kbd dir="ltr" className="min-w-5 rounded border border-white/25 px-1 text-center text-[10px] text-white/80">{capLabel(keyMap.focus[0])}</kbd>}
          </button>
        </div>
      )}

      {/* v0.87.0: on a paged track, the chapter's talk on its last page -- the strip between chapters has no place there.
          The focus label's spot, while the bars are away; the top bar's key does the same while they show. */}
      {prefs.mode === 'paged' && talkOn && !chrome && !focus && atChapterEnd && activeChapter && !talkFor && (
        <div dir={uiDir} className="pointer-events-none absolute inset-x-0 bottom-[max(0.9rem,calc(env(safe-area-inset-bottom)+0.4rem))] z-30 flex justify-center" data-talk-end>
          <TalkKey bookId={activeChapter.id} onOpen={openTalk} />
        </div>
      )}

      {/* CHROME */}
      {/* ⚠️ Each bar's dark pane runs on past the screen edge (the `before:` above the top bar, the `after:` below the
          bottom one). The bars come in on framer's default spring for `y`, which overshoots by about 8 px around 170 ms,
          and the gradient moved with them: for that moment the page showed through between the screen edge and the
          bar, unshaded, with a hard line where the bar began (#170). The pane is off screen at rest, so the look is
          unchanged, and the spring stays. Reintroduce by dropping either pane: effects.test.ts "the reader's bars
          leave no gap at the screen edge while they bounce in" fails. */}
      <AnimatePresence>
        {chrome && (
          <>
            <motion.header initial={{ y: -64, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -64, opacity: 0 }}
              className="absolute inset-x-0 top-0 z-40 flex items-center gap-2 bg-linear-to-b from-black/90 via-black/55 to-transparent px-3 pb-8 pt-[max(0.9rem,calc(env(safe-area-inset-top)+0.55rem))] before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-16 before:bg-black/90">
              <button onClick={back} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-black/45 text-white backdrop-blur">
                <IcChevronLeft width={22} height={22} />
              </button>
              {/* Tapping the title is the route to the series while reading, and the chevron is the whole
                  affordance -- without it this reads as inert as it used to. BOTH lines are inside the link
                  deliberately: the title alone is a ~20px strip wedged between two 40px buttons, and a
                  near-miss lands on the header's transparent gradient and does nothing at all, which is the
                  same dead tap being complained about. active:opacity-80 because touch has no hover. */}
              {seriesHref ? (
                <Link href={seriesHref} aria-label={activeChapter?.seriesTitle
                  ? tr('Open the series page for {title}', { title: `\u2068${activeChapter.seriesTitle}\u2069` }) : tr('Open the series page')}
                  className="group min-w-0 flex-1 transition active:opacity-80">
                  {titleBlock}
                </Link>
              ) : (
                <div className="min-w-0 flex-1">{titleBlock}</div>
              )}
              <IncognitoTag />
              {/* Chapter jump, at every width. This was `hidden lg:block`, so on a phone the only way
                  through a series was prev/next, one chapter at a time. */}
              {chapterRefs.length > 0 && (
                <button onClick={() => setShowChapters(true)} aria-label={tr('Chapters')}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-black/45 text-white backdrop-blur">
                  <IcGrid width={18} height={18} />
                </button>
              )}
              <button onClick={toggleBookmark} aria-label={bookmarked ? tr('Remove bookmark') : tr('Bookmark this page')}
                aria-pressed={bookmarked}
                className={`grid h-10 w-10 shrink-0 place-items-center rounded-full bg-black/45 backdrop-blur ${bookmarked ? 'text-accent' : 'text-white'}`}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill={bookmarked ? 'currentColor' : 'none'}
                     stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                  <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z" />
                </svg>
              </button>
              {/* v0.87.0: the talk of the chapter on screen. A circle like its neighbours; the count is a squared tag. */}
              {talkOn && activeChapter && (
                <button onClick={() => setTalkFor(activeChapter.id)} aria-label={tr('Comments')} data-talk-open
                  className="relative grid h-10 w-10 shrink-0 place-items-center rounded-full bg-black/45 text-white backdrop-blur">
                  <IcComment width={20} height={20} />
                  {!!activeTalk?.comments.length && (
                    <span aria-hidden className="absolute -end-0.5 -top-0.5 rounded-[4px] bg-accent px-1 text-[10px] font-bold leading-4 text-black tabular-nums">
                      {activeTalk.comments.length}
                    </span>
                  )}
                </button>
              )}
              {hasKeyboard && (
                <button onClick={() => setShowKeys(true)} aria-label={tr('Keyboard shortcuts')} title={tr('Keyboard shortcuts')}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-black/45 text-white backdrop-blur">
                  <svg aria-hidden width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
                  </svg>
                </button>
              )}
              <button onClick={() => setShowSettings(true)} data-reader-settings className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-black/45 text-white backdrop-blur">
                <IcSliders width={20} height={20} />
              </button>
            </motion.header>

            <motion.footer initial={{ y: 64, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 64, opacity: 0 }}
              className="absolute inset-x-0 bottom-0 z-40 bg-linear-to-t from-black/90 via-black/55 to-transparent px-4 pt-10 pb-[max(0.9rem,calc(env(safe-area-inset-bottom)+0.4rem))] after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-16 after:bg-black/90">
              {/* In paged mode the bar follows the TRACK, both ways: on a right-to-left read the previous chapter
                  is on the right, next on the left, and the slider fills from the right, so dragging it moves the
                  way the pages do. On a left-to-right read it is stated LTR rather than inherited -- under the
                  Arabic interface it used to inherit RTL and run opposite to its own pages. The chevrons swap to
                  keep pointing outwards; the counter stays LTR so "12/40" never reorders. The webtoon column
                  has no horizontal direction, so there the bar inherits the page's, as it always has. */}
              <div dir={prefs.mode === 'paged' ? (pagedRtl ? 'rtl' : 'ltr') : undefined} className="relative mx-auto flex max-w-3xl items-center gap-2">
                {/* scrubber preview: a small render of the target page while dragging */}
                {scrubbing && flat[current] && (() => {
                  const it = flat[current];
                  const ch = chapters[it.ci];
                  if (!ch) return null;
                  const src = ch.offline ? blobUrls.current.get(it.key) || null : img.page(ch.id, it.number, 200);
                  return (
                    <div className="pointer-events-none absolute bottom-full left-1/2 mb-3 -translate-x-1/2 overflow-hidden rounded-xl border border-ink-600 bg-ink-900 shadow-lift">
                      {src ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={src} alt="" className="h-44 w-32 object-cover" decoding="async" />
                      ) : (
                        <div className="grid h-44 w-32 place-items-center text-xs text-ink-600">{it.number}</div>
                      )}
                      <p className="truncate bg-black/75 px-2 py-1 text-center text-[10px] text-fog-200">{ch.title} · {it.number}/{ch.pages.length}</p>
                    </div>
                  );
                })()}
                <button onClick={() => goChapter(prevId, true)} disabled={!prevId} aria-label={tr('Previous chapter')}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-black/45 text-white backdrop-blur disabled:opacity-30">
                  {pagedRtl ? <IcChevronRight width={18} height={18} /> : <IcChevronLeft width={18} height={18} />}
                </button>
                {/* The counter is the button. A long-press would be invisible on a phone, which this repo
                    already learned once from a hover-only affordance nobody found. */}
                <button dir="ltr" onClick={() => setShowPages(true)} aria-label={tr('Jump to a page')}
                  className="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] tabular-nums text-fog-300 transition hover:bg-white/10 hover:text-white">
                  {chapterPageCount ? `${pageInChapter}/${chapterPageCount}` : `${current + 1}/${total}`}
                </button>
                <input type="range" min={0} max={Math.max(0, total - 1)} value={current}
                  onPointerDown={() => setScrubbing(true)}
                  // Let go of focus after a drag: a slider that keeps it owns Space and the arrows, so in the
                  // webtoon column Space stopped scrolling until the controls hid. Tab still reaches it.
                  onPointerUp={(e) => { setScrubbing(false); e.currentTarget.blur(); }}
                  onPointerCancel={() => setScrubbing(false)}
                  onChange={(e) => jumpTo(Number(e.target.value))}
                  className="h-1 flex-1 accent-[rgb(var(--accent))]" />
                <button onClick={goNext} disabled={!nextId} aria-label={armedNext != null ? tr('Tap again to skip to the next chapter') : tr('Next chapter')}
                  className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-white backdrop-blur disabled:opacity-30 ${armedNext != null ? 'bg-accent' : 'bg-black/45'}`}>
                  {pagedRtl ? <IcChevronLeft width={18} height={18} /> : <IcChevronRight width={18} height={18} />}
                </button>
              </div>
            </motion.footer>
          </>
        )}
      </AnimatePresence>

      {/* Quiet, and never a dead end. The count is the whole point: a skip you cannot see is
          indistinguishable from a missing page, which is exactly the complaint this feature exists to
          remove rather than create. Tapping puts them back, for this chapter only.

          ⚠️ Deliberately NOT gated on the chrome being visible. It was at first, and the browser test
          caught what that means: the reader auto-hides its chrome a few seconds in, so the one thing
          telling you a page had been removed disappeared along with it. A notice you have to go looking
          for is not a notice. */}
      <AnimatePresence>
        {armedNext != null && (
          <motion.div role="status" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
            className="pointer-events-none fixed inset-x-0 bottom-28 z-50 mx-auto w-fit rounded-full bg-black/80 px-3 py-1.5 text-[11px] text-fog-200 backdrop-blur">
            {tr('Tap again to skip to the next chapter')}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {hiddenHere > 0 && (
          <motion.button
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
            onClick={() => {
              const ch = chapters[flat[current]?.ci ?? 0];
              if (!ch) return;
              setExpanded((prev) => {
                const n = new Set(prev);
                ch.pages.forEach((p) => { if (p.junk && !p.missing) n.add(`${ch.id}:${p.number}`); });
                return n;
              });
            }}
            className="fixed inset-x-0 bottom-24 z-30 mx-auto w-fit rounded-full bg-black/70 px-3 py-1.5 text-[11px] text-fog-300 backdrop-blur">
            {hiddenHere === 1
              ? tr('skipped 1 repeated page — show')
              : tr('skipped {n} repeated pages — show', { n: hiddenHere })}
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showKeys && <ReaderShortcuts keyMap={keyMap} onClose={() => setShowKeys(false)} />}
        {showSettings && (
          <ReaderSettings
            prefs={prefs}
            set={setPref}
            spreadShift={spreadShift}
            onSpreadShift={applyShift}
            translate={translate}
            onTranslate={trOffer?.available ? applyTranslate : undefined}
            device={device}
            setDevice={setDevice}
            autoApplied={autoApplied}
            padConnected={padConnected}
            rtlTrack={pagedRtl}
            spreadChoices={spreadChoices.map((o) => ({ key: `${o.kind}:${o.first}`, label: spreadLabel(o), side: o.kind === 'merge' ? o.side : undefined, onSelect: () => { setShowSettings(false); applySpread(o); } }))}
            onClose={() => setShowSettings(false)}
            // The series' own source, by name. With no name there is no row at all: a raw source id is
            // never shown (an extension's is nineteen digits).
            sourceName={seriesSource?.name || undefined}
            sourceDefault={!!(seriesSource && Object.keys(loadSourcePrefs(seriesSource.id)).length)}
            libraryName={seriesLibrary?.name}
            onLibraryDefault={() => {
              if (!seriesLibrary) return;
              // The content's look only (#235): the theme stays each reader's own, and the server would drop it anyway.
              const look: LibraryLook = { mode: prefs.mode, spread: prefs.spread, pagedDirection: prefs.pagedDirection };
              const sid = seriesId0;
              api(`/api/admin/libraries/${seriesLibrary.id}`, { method: 'PATCH', json: { readerPrefs: look } })
                .then(() => {
                  setLibraryLook(look);
                  rememberLibraryLook(sid, look);
                  toast(tr('Saved as the default for {library}.', { library: seriesLibrary.name }));
                })
                .catch(() => toast(tr('Could not save'), 'error'));
              setShowSettings(false);
            }}
            onSourceDefault={(save) => {
              if (!seriesSource) return;
              if (save) saveSourcePrefs(seriesSource.id, { mode: prefs.mode, theme: prefs.theme, spread: prefs.spread, pagedDirection: prefs.pagedDirection });
              else clearSourcePrefs(seriesSource.id);
              setShowSettings(false);
            }}
          />
        )}
      </AnimatePresence>

      {showPages && (
        /* No control with no network: the decision is stored on the server, and a tile that flips and then
           silently reverts on the next load is worse than no tile at all. Read when the sheet opens rather
           than subscribed to, which is enough -- the sheet is short-lived and the failure path restores the
           flag anyway. */
        <PageGrid title={activeChapter?.title || tr('Pages')} pages={gridPages} current={current}
          onPick={jumpTo} onClose={() => setShowPages(false)}
          onToggleJunk={!serverReachableHint() ? undefined : toggleJunk} />
      )}
      {showChapters && (
        <ChapterSheet title={tr('Chapters')} chapters={chapterRefs} activeId={activeChapter?.id}
          onPick={goChapter} onClose={() => setShowChapters(false)}
          header={editions && (
            <div role="group" aria-label={tr('Editions')} data-editions className="mb-2 flex flex-wrap gap-1.5">
              {editionChipLabels(editions, { name: languageName, chapter: (n) => chapterLabel({ number: n }) }).map((label, i) => (editions[i].current
                ? <span key={editions[i].seriesId} aria-current="true" className="chip chip-active text-xs">{label}</span>
                : <button key={editions[i].seriesId} type="button" onClick={() => void switchEdition(editions[i])} className="chip text-xs">{label}</button>))}
            </div>
          )} />
      )}

      {talkFor && (() => {
        const ch = chapters.find((c) => c.id === talkFor);
        return (
          <ChapterTalkSheet bookId={talkFor} seriesId={ch?.seriesId} title={ch?.title || tr('Comments')} subtitle={ch?.seriesTitle}
            page={talkFor === activeChapter?.id ? pageInChapter || null : null}
            onPage={(n) => {
              const ci = chapters.findIndex((c) => c.id === talkFor);
              setTalkFor(null);
              if (ci >= 0) jumpTo(indexOfKey.get(`${talkFor}:${n}`) ?? startIndex(flat, ci, n));
            }}
            onClose={() => setTalkFor(null)} />
        );
      })()}

      {!ready && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-ink-950">
          <div className="animate-pulse-soft text-fog-500">{tr('Loading chapter…')}</div>
        </div>
      )}
      {/* Nothing loaded at all. `ready` alone used to clear the overlay here and leave the bare backdrop. */}
      {ready && failed && !flat.length && (
        <div data-lenis-prevent className="absolute inset-0 z-50 flex items-center justify-center overflow-y-auto bg-ink-950">
          {failureCard}
        </div>
      )}
    </div>
  );
}

export default function ReaderPage() {
  return (
    <Suspense fallback={<div className="fixed inset-0 bg-ink-950" />}>
      <ReaderInner />
    </Suspense>
  );
}
