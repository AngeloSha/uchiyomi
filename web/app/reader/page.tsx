'use client';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pairSlides } from '@/lib/readerSpread';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { chapterOutcome } from '@/lib/readerState';
import { buildFlow, startIndex, renderWindow } from '@/lib/readerFlow';
import { Book, Page, PageInfo, Series } from '@/lib/types';
import { chapterLabel } from '@/lib/format';
import { deviceId } from '@/lib/device';
import { getOfflineChapter, getPageBlob, queueProgress, noteOfflineProgress, listSeriesDownloads, setOfflinePageJunk } from '@/lib/downloads';
import { applyCover, clearCover } from '@/lib/theme';
import { ReaderPrefs, loadPrefs, savePrefs, loadSeriesPrefs, saveSeriesPrefs, syncPrefsFromServer, THEME_FILTER } from '@/lib/readerPrefs';
import { ReaderSettings } from '@/components/ReaderSettings';
import { Rail, SectionTitle, useImgRetry } from '@/components/ui';
import { PageGrid } from '@/components/PageGrid';
import { ChapterSheet } from '@/components/ChapterSheet';
import { SeriesCard } from '@/components/cards';
import { IcChevronLeft, IcChevronRight, IcSliders, IcRefresh, IcGrid } from '@/components/icons';
import { t as tr } from '@/lib/i18n';

interface PageDim { number: number; width: number | null; height: number | null; junk?: boolean }
interface Chapter { id: string; seriesId: string; seriesTitle: string; title: string; pages: PageDim[]; offline: boolean; readingDirection?: string | null; pruned?: boolean }
interface ChapterRef { id: string; label: string }
interface FlatItem { ci: number; number: number; width: number | null; height: number | null; key: string; firstOfChapter: boolean; junk?: boolean }

const WINDOW_BEHIND = 2;
const WINDOW_AHEAD = 6;
const DIVIDER_H = 60;
/**
 * How tall a collapsed page is. Enough to read as a band OF SOMETHING -- you can see it is a credit page --
 * without being tall enough to interrupt a scroll. A sibling of DIVIDER_H, and reserved the same way.
 */
const STRIP_H = 48;

async function loadChapter(bookId: string): Promise<Chapter | null> {
  const off = await getOfflineChapter(bookId);
  if (off) {
    return { id: bookId, seriesId: off.seriesId, seriesTitle: off.seriesTitle, title: off.title, pages: off.pages, offline: true, readingDirection: off.readingDirection };
  }
  try {
    const b = await api<Book>(`/api/books/${bookId}`);
    const pInfo = await api<PageInfo[]>(`/api/books/${bookId}/pages`);
    return {
      id: bookId,
      seriesId: b.seriesId,
      seriesTitle: b.seriesTitle,
      title: b.metadata?.title || b.name,
      pages: pInfo.map((p) => ({ number: p.number, width: p.width ?? null, height: p.height ?? null, junk: p.junk })),
      offline: false,
      // The server deleted this chapter's file after everyone finished it. Carried so the empty page list
      // below can be explained rather than blamed on the reader's library mount.
      pruned: b.pruned === true,
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
  const [zoom, setZoom] = useState(1);
  const [rtl, setRtl] = useState(false); // series reads right-to-left → double-spread pair order flips
  const [scrubbing, setScrubbing] = useState(false); // slider drag in progress → show the page preview

  const [chrome, setChrome] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showPages, setShowPages] = useState(false);
  const [showChapters, setShowChapters] = useState(false);
  const [current, setCurrent] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [colW, setColW] = useState(0);
  const didInitScroll = useRef(false);
  /** The last `chapterId:page` a progress ping was sent for. Declared here rather than beside sendProgress
   *  because the initial-scroll effect seeds it, and that effect is defined above sendProgress. */
  const lastSent = useRef('');
  const blobUrls = useRef<Map<string, string>>(new Map());
  const appending = useRef(false);
  const noMore = useRef(false);
  const tap = useRef<{ x: number; y: number; t: number } | null>(null);
  const lastTapAt = useRef(0);
  const tapTimer = useRef<any>(null);
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);

  const seriesId0 = chapters[0]?.seriesId || '';
  const setPref = (p: Partial<ReaderPrefs>) =>
    setPrefs((cur) => {
      const n = { ...cur, ...p };
      savePrefs(n);
      if ((p.mode || p.theme || p.spread !== undefined) && seriesId0) saveSeriesPrefs(seriesId0, { mode: n.mode, theme: n.theme, spread: n.spread });
      return n;
    });
  const applyZoom = (z: number) => {
    const clamped = Math.max(1, Math.min(3, z));
    setZoom(clamped);
    if (seriesId0) saveSeriesPrefs(seriesId0, { zoom: clamped });
  };

  // ---- (re)load on bookId change ----
  useEffect(() => {
    let alive = true;
    setReady(false);
    setEnded(false);
    didInitScroll.current = false;
    appending.current = false;
    noMore.current = false;
    setRefsFrom('none');
    completedSent.current.clear();
    prevPos.current = null;
    setExpanded(new Set());   // a page opened by hand belongs to the chapter it was opened in
    blobUrls.current.forEach((u) => URL.revokeObjectURL(u));
    blobUrls.current.clear();
    (async () => {
      const first = await loadChapter(bookId);
      if (!alive) return;
      setFailed(null);
      // Empty and absent are different sentences, and neither of them is silence.
      const outcome = chapterOutcome(first);
      // `|| !first` is for the type narrower's benefit; chapterOutcome already answers 'unavailable' for null.
      if (outcome !== 'ok' || !first) { setFailed(outcome === 'ok' ? 'unavailable' : outcome); setReady(true); return; }
      // Where to open, in order of authority: an explicit deep link, then the server, then this device.
      const clamp = (n: number) => Math.max(1, Math.min(n, first.pages.length || 1));
      if (wantPage > 0) {
        // Deep link. Deliberately does NOT read progress -- see wantPage above.
        setStartPage(clamp(wantPage));
      } else {
        // The server wins when it answers: progress is cross-device, and the outbox pushes this device's
        // offline position up to it. The downloaded copy is a fallback, not a peer.
        const canAsk = !(first.offline && typeof navigator !== 'undefined' && navigator.onLine === false);
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
        const list = await api<Page<Book>>(`/api/series/${first.seriesId}/books?size=1000&sort=metadata.numberSort,asc`);
        if (alive) { setChapterRefs(list.content.map((b) => ({ id: b.id, label: chapterLabel(b) }))); setRefsFrom('live'); }
      } catch {
        // Offline, this is the only list there is. Without it every downloaded chapter reported the end of the
        // series and prev/next were both dead, because an empty list reads as "there is no next chapter".
        try {
          const local = await listSeriesDownloads(first.seriesId);
          if (alive && local.length) {
            setChapterRefs(local.map((c) => ({ id: c.bookId, label: c.title || `Chapter ${c.number}` })));
            setRefsFrom('offline');
          }
        } catch {}
      }
      // reading direction (drives double-spread pair order for RTL manga)
      try {
        const s = await api<Series>(`/api/series/${first.seriesId}`);
        if (alive) setRtl(s?.metadata?.readingDirection === 'RIGHT_TO_LEFT');
      } catch { /* offline: the downloaded record's direction, set above, stands */ }
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
  const flat: FlatItem[] = useMemo(
    () => buildFlow(chapters, prefs.junkPages, expanded) as FlatItem[],
    [chapters, prefs.junkPages, expanded],
  );
  /** Vertical + `collapse`: a repeated page is drawn as a band of itself instead of being removed. */
  const collapsing = prefs.junkPages === 'collapse';
  /** `hide` is the only mode that takes a page out of the flow, so it is the only one that needs the chip. */
  const removing = prefs.junkPages === 'hide';

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
    return ch.pages.filter((p) => p.junk && !expanded.has(`${ch.id}:${p.number}`)).length;
  }, [chapters, flat, current, removing, expanded]);

  // ---- paged slides: 1 page per slide, or double spreads ----
  // The rules, and why each exists, live in lib/readerSpread.ts, where they can be tested without mounting
  // this component. This used to pair a landscape double-page spread with the portrait page before it,
  // which halved the spread and left every later pair in the chapter off by one.
  const { slides, slideOf } = useMemo(
    () => pairSlides(flat, prefs.mode === 'paged' && !!prefs.spread),
    [flat, prefs.mode, prefs.spread],
  );

  // ---- measure column width (× zoom) ----
  useEffect(() => {
    const measure = () => {
      const w = scrollRef.current?.clientWidth || window.innerWidth;
      const base = prefs.fitWidth ? Math.min(w, 860) : w;
      setColW(base * zoom);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [prefs.fitWidth, ready, zoom]);

  // keep the page roughly centered/in-place when zooming
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !didInitScroll.current) return;
    if (zoom > 1) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
    if (prefs.mode === 'vertical' && tops[current] != null) el.scrollTop = tops[current];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, colW]);

  // ---- reserved heights + cumulative tops (incl. chapter dividers) ----
  // ⚠️ `expanded` and `collapsing` belong in the dependency list below, not just in the body. This memo is
  // the reader's ENTIRE model of the layout -- `onScroll` binary-searches `tops` to decide what page you are
  // on, and nothing ever measures the DOM to check. Leave them out and opening a page silently reports the
  // wrong page from then on, with no symptom until the page counter disagrees with the screen.
  // Reintroduce by dropping `expanded` from the deps: expand a strip, then scroll -- the counter is off by
  // however much the page grew.
  const { heights, tops } = useMemo(() => {
    const hs = flat.map((p) =>
      collapsing && p.junk && !expanded.has(p.key)
        ? STRIP_H
        : p.width && p.height ? colW * (p.height / p.width) : colW * 1.4);
    const ts: number[] = [];
    let acc = 0;
    flat.forEach((p, i) => {
      if (p.firstOfChapter && p.ci > 0) acc += DIVIDER_H;
      ts.push(acc);
      acc += hs[i] + prefs.gap;
    });
    return { heights: hs, tops: ts };
  }, [flat, colW, prefs.gap, collapsing, expanded]);

  // ---- active render window ----
  // ⚠️ Memoised on `flat` itself, not `flat.length`. Expanding a page changes what is in the window without
  // changing how many items there are, and the blob prefetch below keys off this set's identity -- on
  // `flat.length` the set never changes, so an expanded page of a DOWNLOADED chapter would sit on its number
  // placeholder forever. Invisible online, where the image URL always works.
  const activeSet = useMemo(
    () => renderWindow(flat, current, WINDOW_BEHIND, WINDOW_AHEAD),
    [flat, current],
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
      for (const [k] of map) {
        const idx = flat.findIndex((p) => p.key === k);
        if (idx < current - 12 || idx > current + 18) {
          URL.revokeObjectURL(map.get(k)!);
          map.delete(k);
        }
      }
      if (alive) force((n) => n + 1);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSet]);

  const srcFor = (i: number): string | null => {
    const it = flat[i];
    const ch = chapters[it.ci];
    if (!ch) return null;
    if (ch.offline) return blobUrls.current.get(it.key) || null;
    return img.page(ch.id, it.number);
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

  // ---- initial scroll to resume page ----
  useEffect(() => {
    if (!ready || didInitScroll.current || !colW || !tops.length) return;
    // ⚠️ A page NUMBER, resolved -- never `startPage - 1`. Subtracting one is an index into a list that holds
    // every page, which stopped being true the moment `hide` could remove one, and the drift is silent: you
    // resume a little past where you left off, by exactly the number of pages removed before you.
    const idx = Math.max(0, Math.min(flat.length - 1, startIndex(flat, 0, startPage)));
    if (prefs.mode === 'vertical' && scrollRef.current && idx > 0) scrollRef.current.scrollTop = tops[idx];
    if (prefs.mode === 'paged' && scrollRef.current && idx > 0)
      scrollRef.current.scrollLeft = (slideOf[idx] ?? idx) * scrollRef.current.clientWidth;
    setCurrent(idx);
    // Seed the dedupe key so landing here does not immediately ping progress. Opening a saved Moment is
    // looking something up, not reading it, and it should not move where you were or add a reading event.
    const at = flat[idx];
    if (at) lastSent.current = `${chapters[at.ci]?.id}:${at.number}`;
    didInitScroll.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, colW, tops]);

  // ---- track current page on scroll ----
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prefs.mode === 'paged') {
      const s = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
      const idxs = slides[Math.max(0, Math.min(slides.length - 1, s))];
      const i = idxs ? idxs[idxs.length - 1] : 0; // last page of a spread → completion fires on the final spread
      setCurrent((c) => (c === i ? c : i));
      return;
    }
    const probe = el.scrollTop + el.clientHeight * 0.4;
    let lo = 0, hi = tops.length - 1, ans = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (tops[mid] <= probe) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    setCurrent((c) => (c === ans ? c : ans));
  }, [tops, prefs.mode, slides]);

  // ---- continuous reading: append next chapter near the end ----
  useEffect(() => {
    if (!ready || !flat.length || appending.current || noMore.current) return;
    if (current < flat.length - 4) return;
    appending.current = true;
    (async () => {
      const last = chapters[chapters.length - 1];
      // We do not know the shape of this series -- the list never arrived. Stop appending, but do NOT claim
      // the series is finished: an unknown is not a conclusion. This is the same distinction chapterOutcome
      // draws between "empty" and "absent", and it is why every offline chapter used to end with a trophy.
      if (!chapterRefs.length) { noMore.current = true; appending.current = false; return; }
      const idx = chapterRefs.findIndex((c) => c.id === last?.id);
      const next = idx >= 0 ? chapterRefs[idx + 1] : null;
      if (!next) { noMore.current = true; setEnded(true); appending.current = false; return; }
      const ch = await loadChapter(next.id);
      const outcome = chapterOutcome(ch);
      if (outcome === 'ok') setChapters((cs) => (cs.some((c) => c.id === ch!.id) ? cs : [...cs, ch!]));
      // There IS a next chapter -- chapterRefs says so -- and it would not load. Claiming the series is
      // finished here is how a corrupt file or a dropped connection came to read as an ending.
      else { noMore.current = true; setFailed(outcome); }
      appending.current = false;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, ready, flat.length, chapterRefs]);

  // ---- submit progress for the active chapter ----
  // Two paths: (a) regular page progress, debounced 600ms; (b) chapter COMPLETION, sent immediately —
  // the debounce used to swallow completions when readers scrolled through a chapter's last page without
  // lingering (webtoon fast-scroll can even skip it entirely), so finished chapters never counted as read.
  const completedSent = useRef(new Set<string>());
  const prevPos = useRef<{ ci: number } | null>(null);
  const sendProgress = useCallback((chId: string, sId: string, page: number, completed: boolean) => {
    // `at` is what lets the server refuse a stale write. The offline outbox always sent it; the live path
    // never did, so every live ping took the "no timestamp" leg of the guard and applied unconditionally --
    // a desktop tab left open on chapter 3 could still rewind the phone that had read to chapter 9.
    const payload = { page, completed, seriesId: sId, deviceId: deviceId(), at: Date.now() };
    // Alongside the write, not instead of it: this is what a downloaded chapter resumes from with no network.
    void noteOfflineProgress(chId, page, completed);
    api(`/api/books/${chId}/progress`, { method: 'PUT', json: payload }).catch(() => queueProgress({ bookId: chId, ...payload }));
  }, []);
  useEffect(() => {
    if (!ready || !flat.length) return;
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
      // completion fires immediately — a debounce here loses the event when the reader moves on quickly
      completedSent.current.add(ch.id);
      lastSent.current = tag;
      sendProgress(ch.id, ch.seriesId, it.number, true);
      return;
    }
    const t = setTimeout(() => {
      lastSent.current = tag;
      sendProgress(ch.id, ch.seriesId, it.number, false);
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, ready, flat.length]);

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

  // One place that knows how to move to a page, shared by the scrubber and the page grid. The initial-scroll
  // effect above deliberately does not use it: that one must also seed `lastSent` and run exactly once.
  const jumpTo = useCallback((idx: number) => {
    const el = scrollRef.current;
    const i = Math.max(0, Math.min(flat.length - 1, idx));
    setCurrent(i);
    if (!el) return;
    if (prefs.mode === 'vertical') el.scrollTo({ top: tops[i] || 0 });
    else el.scrollTo({ left: (slideOf[i] ?? i) * (el.clientWidth || 0) });
  }, [flat.length, prefs.mode, tops, slideOf]);

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
  const gridPages = useMemo(() => {
    const ci = flat[current]?.ci;
    if (ci == null) return [];
    const ch = chapters[ci];
    if (!ch) return [];
    return ch.pages.map((p) => ({
      idx: startIndex(flat, ci, p.number),
      junk: !!p.junk,
      number: p.number,
      // An offline chapter has no URL to request: its pages are blobs already decoded into memory, and
      // the same blob is the thumbnail.
      src: ch.offline ? blobUrls.current.get(`${ch.id}:${p.number}`) || null : img.page(ch.id, p.number, 200),
    }));
  }, [flat, current, chapters]);
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
  const goChapter = (cid?: string) => { if (cid) router.replace(`/reader/?book=${cid}`); };
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
    // localStorage already painted; this catches up a device that hasn't seen your settings yet
    syncPrefsFromServer().then((p) => setPrefs((cur) => ({ ...cur, ...p }))).catch(() => {});
  }, []);

  // ---- per-series memory (mode/theme/zoom) ----
  useEffect(() => {
    if (!seriesId) return;
    const sp = loadSeriesPrefs(seriesId);
    if (sp.mode || sp.theme || sp.spread !== undefined)
      setPrefs((cur) => ({ ...cur, ...(sp.mode ? { mode: sp.mode } : {}), ...(sp.theme ? { theme: sp.theme } : {}), ...(sp.spread !== undefined ? { spread: sp.spread } : {}) }));
    setZoom(sp.zoom && sp.zoom >= 1 ? sp.zoom : 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesId]);

  // ---- auto-hide chrome ----
  useEffect(() => {
    if (!chrome || showSettings) return;
    const t = setTimeout(() => setChrome(false), 3800);
    return () => clearTimeout(t);
  }, [chrome, showSettings]);

  // ---- keyboard (desktop) ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = scrollRef.current;
      if (e.key === '[') goChapter(prevId);
      else if (e.key === ']') goChapter(nextId);
      else if (e.key === 'f') toggleFullscreen();
      else if (e.key === 'Escape') back();
      else if (el && prefs.mode === 'vertical' && (e.key === ' ' || e.key === 'ArrowDown')) { e.preventDefault(); el.scrollBy({ top: el.clientHeight * 0.88, behavior: 'smooth' }); }
      else if (el && prefs.mode === 'vertical' && e.key === 'ArrowUp') { e.preventDefault(); el.scrollBy({ top: -el.clientHeight * 0.88, behavior: 'smooth' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prevId, nextId, prefs.mode, seriesId]);

  // ---- tap / double-tap / pinch (no overlay -> native scroll works) ----
  const onPointerDown = (e: React.PointerEvent) => {
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
    if (Math.abs(e.clientX - s.x) > 10 || Math.abs(e.clientY - s.y) > 10 || Date.now() - s.t > 300) return; // scroll/long-press
    const now = Date.now();
    if (now - lastTapAt.current < 300) {
      if (tapTimer.current) { clearTimeout(tapTimer.current); tapTimer.current = null; }
      lastTapAt.current = 0;
      applyZoom(zoom > 1 ? 1 : 2);
      return;
    }
    lastTapAt.current = now;
    const x = e.clientX;
    tapTimer.current = setTimeout(() => {
      tapTimer.current = null;
      if (prefs.mode === 'paged') {
        const w = scrollRef.current?.clientWidth || window.innerWidth;
        if (x < w * 0.3) scrollRef.current?.scrollBy({ left: -w, behavior: 'smooth' });
        else if (x > w * 0.7) scrollRef.current?.scrollBy({ left: w, behavior: 'smooth' });
        else setChrome((c) => !c);
      } else setChrome((c) => !c);
    }, 260);
  };

  const total = flat.length;
  const pageInChapter = activeChapter ? (flat[current]?.number ?? 0) : 0;

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

  // the header's two-line "what you are reading" block, wrapped in a link to the series when we know its id
  const titleBlock = (
    <>
      <p className="flex items-center gap-1 text-sm font-medium text-white transition group-hover:text-accent">
        <span className="truncate">{activeChapter?.seriesTitle || 'Reading'}</span>
        {seriesHref && <IcChevronRight width={14} height={14} className="shrink-0 text-fog-500 transition group-hover:text-accent" />}
      </p>
      <p className="truncate text-[11px] text-fog-400">{activeChapter?.title}</p>
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
        {failed === 'pruned'
          ? tr('This server deletes chapters once everyone who started them has finished, to save space. This one is gone; the rest of the series is not affected.')
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
        {offlineEnd ? tr('End of your downloads') : tr('You finished')}
      </p>
      <h2 className="mt-1.5 font-display text-2xl font-bold text-white">{activeChapter?.seriesTitle || 'this series'}</h2>
      {offlineEnd && (
        <p className="mx-auto mt-2 max-w-sm text-sm text-fog-400">
          {tr('This is the last chapter you have offline. Reconnect to keep reading.')}
        </p>
      )}
      <div className="mt-6 flex justify-center gap-2">
        {/* labelled "Back to series", so go to the series -- `back` is history-first and from the home
            Continue rail would land on home instead */}
        <button onClick={() => (seriesHref ? router.push(seriesHref) : back())} className="btn-ghost text-sm">{tr('Back to series')}</button>
        {offlineEnd
          ? <button onClick={() => router.push('/downloads/')} className="btn-accent text-sm">{tr('Downloads')}</button>
          : <button onClick={() => router.push('/')} className="btn-accent text-sm">{tr('Home')}</button>}
      </div>
      {!offlineEnd && !!upNext?.content?.length && (
        <div className="mt-12 text-start">
          <SectionTitle>{tr('Because you finished this')}</SectionTitle>
          <Rail>{upNext.content.map((s) => <SeriesCard key={s.id} series={s} />)}</Rail>
        </div>
      )}
    </motion.div>
  );

  return (
    <div className="fixed inset-0 z-40 bg-ink-950">
      <div className="pointer-events-none absolute inset-0 z-30 bg-black" style={{ opacity: 1 - prefs.brightness }} />
      {/* ambient cover wash framing the reader */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-36" style={{ background: 'linear-gradient(to bottom, rgb(var(--cover, 0 0 0) / 0.16), transparent)' }} />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-36" style={{ background: 'linear-gradient(to top, rgb(var(--cover, 0 0 0) / 0.16), transparent)' }} />

      {/* PAGES */}
      {/* ⚠️ overflow-anchor is off below because `tops` -- computed in JS and never measured back from the
          DOM -- is the only model of the layout there is. A browser that quietly adjusts scrollTop to keep
          content in view desynchronises it from `current` with no symptom and no way to detect it. */}
      {prefs.mode === 'vertical' ? (
        <div ref={scrollRef} data-lenis-prevent style={{ overflowAnchor: 'none' }} onScroll={onScroll} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
          className={`h-screen-d touch-pan-y overflow-y-auto overscroll-contain ${zoom > 1 ? 'overflow-x-auto' : 'overflow-x-hidden'}`}>
          <div className="mx-auto" style={{ width: colW || '100%', filter: THEME_FILTER[prefs.theme] }}>
            <div className="h-2" />
            {flat.map((p, i) => {
              const collapsed = collapsing && p.junk && !expanded.has(p.key);
              return (
              <div key={p.key}>
                {p.firstOfChapter && p.ci > 0 && (
                  <div style={{ height: DIVIDER_H }} className="flex items-center justify-center gap-3 text-xs text-fog-500">
                    <span className="h-px w-8 bg-ink-700" />
                    <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fog-600">{tr('Up Next')}</span>
                    <span className="text-fog-400">{chapters[p.ci]?.title || 'Next chapter'}</span>
                    <span className="h-px w-8 bg-ink-700" />
                  </div>
                )}
                <div style={{ height: heights[i] || undefined, marginBottom: prefs.gap }} className="relative w-full bg-ink-900">
                  {collapsed ? (
                    /* A band of the real page, not a placeholder standing in for it. Seeing that it IS the
                       credit page is the whole difference between "the reader set this aside" and "a page is
                       missing" -- and it costs nothing extra, because the box below already crops with
                       object-cover; only the height changed. `object-top` because the top of a credit page is
                       the part that identifies it. The THUMBNAIL is used deliberately: a page nobody is
                       reading must never pull a full-size scan down. */
                    <button
                      type="button"
                      aria-expanded={false}
                      onClick={() => setExpanded((prev) => new Set(prev).add(p.key))}
                      /* ⚠️ BOTH, and neither is optional. The scroll container owns a tap gesture that
                         toggles the chrome and a double-tap that zooms; it seeds that gesture on pointerdown
                         and reads it on pointerup. Stop only one and a tap on a strip still expands the page
                         AND toggles the chrome, and a double-tap expands then zooms. */
                      onPointerDown={(e) => e.stopPropagation()}
                      onPointerUp={(e) => e.stopPropagation()}
                      aria-label={tr('Show repeated page {n}', { n: p.number })}
                      className="group block h-full w-full overflow-hidden text-start"
                    >
                      {stripSrc(i) && (
                        <img src={stripSrc(i)!} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover object-top opacity-50" />
                      )}
                      <span className="absolute inset-0 flex items-center justify-center gap-2.5 bg-ink-950/45 text-[10px] font-semibold uppercase tracking-[0.16em] text-fog-400 group-hover:text-fog-200">
                        <span className="h-px w-6 bg-ink-600" />
                        {tr('repeated page — tap to show')}
                        <span className="h-px w-6 bg-ink-600" />
                      </span>
                    </button>
                  ) : activeSet.has(i) && srcFor(i) ? (
                    <ReaderImg src={srcFor(i)!} alt={`Page ${p.number}`} className="block h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-xs text-ink-600">{p.number}</div>
                  )}
                  {/* Opened by hand, so it can be closed by hand -- otherwise expanding one to check it is a
                      one-way door for the rest of the session. */}
                  {collapsing && p.junk && expanded.has(p.key) && (
                    <button
                      type="button"
                      aria-expanded
                      onClick={() => setExpanded((prev) => { const n = new Set(prev); n.delete(p.key); return n; })}
                      onPointerDown={(e) => e.stopPropagation()}
                      onPointerUp={(e) => e.stopPropagation()}
                      aria-label={tr('Collapse repeated page {n}', { n: p.number })}
                      className="absolute end-2 top-2 rounded-full bg-ink-950/75 px-2 py-1 text-[10px] font-medium text-fog-300 backdrop-blur hover:text-white"
                    >
                      {tr('collapse')}
                    </button>
                  )}
                </div>
              </div>
            );})}
            {ended && upNextCard}
            {failed && !!flat.length && failureCard}
          </div>
        </div>
      ) : (
        <div ref={scrollRef} data-lenis-prevent onScroll={onScroll} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
          className="hide-scrollbar flex h-screen-d snap-x snap-mandatory overflow-x-auto overflow-y-hidden" style={{ filter: THEME_FILTER[prefs.theme] }}>
          {slides.map((idxs) => {
            const shown = rtl && idxs.length === 2 ? [idxs[1], idxs[0]] : idxs; // RTL manga: right page reads first
            return (
              <div key={flat[idxs[0]].key} className="relative flex h-full w-full shrink-0 snap-center items-center justify-center gap-1">
                {shown.map((i) => {
                  const p = flat[i];
                  return activeSet.has(i) && srcFor(i) ? (
                    <ReaderImg key={p.key} src={srcFor(i)!} alt={`Page ${p.number}`}
                      className={`max-h-full object-contain ${idxs.length === 2 ? 'max-w-[50%]' : 'max-w-full'}`}
                      style={{ transform: zoom !== 1 ? `scale(${zoom})` : undefined }} />
                  ) : (
                    <span key={p.key} className="text-ink-600">{p.number}</span>
                  );
                })}
              </div>
            );
          })}
          {ended && (
            <div className="flex h-full w-full shrink-0 snap-center items-start justify-center overflow-y-auto">
              {upNextCard}
            </div>
          )}
          {failed && !!flat.length && (
            <div className="flex h-full w-full shrink-0 snap-center items-start justify-center overflow-y-auto">
              {failureCard}
            </div>
          )}
        </div>
      )}

      {/* CHROME */}
      <AnimatePresence>
        {chrome && (
          <>
            <motion.header initial={{ y: -64, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -64, opacity: 0 }}
              className="absolute inset-x-0 top-0 z-40 flex items-center gap-2 bg-linear-to-b from-black/90 via-black/55 to-transparent px-3 pb-8 pt-[max(0.9rem,calc(env(safe-area-inset-top)+0.55rem))]">
              <button onClick={back} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-black/45 text-white backdrop-blur">
                <IcChevronLeft width={22} height={22} />
              </button>
              {/* Tapping the title is the route to the series while reading, and the chevron is the whole
                  affordance -- without it this reads as inert as it used to. BOTH lines are inside the link
                  deliberately: the title alone is a ~20px strip wedged between two 40px buttons, and a
                  near-miss lands on the header's transparent gradient and does nothing at all, which is the
                  same dead tap being complained about. active:opacity-80 because touch has no hover. */}
              {seriesHref ? (
                <Link href={seriesHref} aria-label={`Open ${activeChapter?.seriesTitle || 'this'} series page`}
                  className="group min-w-0 flex-1 transition active:opacity-80">
                  {titleBlock}
                </Link>
              ) : (
                <div className="min-w-0 flex-1">{titleBlock}</div>
              )}
              {/* Chapter jump, at every width. This was `hidden lg:block`, so on a phone the only way
                  through a series was prev/next, one chapter at a time. */}
              {chapterRefs.length > 0 && (
                <button onClick={() => setShowChapters(true)} aria-label={tr('Chapters')}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-black/45 text-white backdrop-blur">
                  <IcGrid width={18} height={18} />
                </button>
              )}
              <button onClick={toggleBookmark} aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark this page'}
                aria-pressed={bookmarked}
                className={`grid h-10 w-10 shrink-0 place-items-center rounded-full bg-black/45 backdrop-blur ${bookmarked ? 'text-accent' : 'text-white'}`}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill={bookmarked ? 'currentColor' : 'none'}
                     stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                  <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z" />
                </svg>
              </button>
              <button onClick={() => setShowSettings(true)} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-black/45 text-white backdrop-blur">
                <IcSliders width={20} height={20} />
              </button>
            </motion.header>

            <motion.footer initial={{ y: 64, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 64, opacity: 0 }}
              className="absolute inset-x-0 bottom-0 z-40 bg-linear-to-t from-black/90 via-black/55 to-transparent px-4 pt-10 pb-[max(0.9rem,calc(env(safe-area-inset-bottom)+0.4rem))]">
              <div className="relative mx-auto flex max-w-3xl items-center gap-2">
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
                <button onClick={() => goChapter(prevId)} disabled={!prevId}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-black/45 text-white backdrop-blur disabled:opacity-30">
                  <IcChevronLeft width={18} height={18} />
                </button>
                {/* The counter is the button. A long-press would be invisible on a phone, which this repo
                    already learned once from a hover-only affordance nobody found. */}
                <button onClick={() => setShowPages(true)} aria-label={tr('Jump to a page')}
                  className="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] tabular-nums text-fog-300 transition hover:bg-white/10 hover:text-white">
                  {chapterPageCount ? `${pageInChapter}/${chapterPageCount}` : `${current + 1}/${total}`}
                </button>
                <input type="range" min={0} max={Math.max(0, total - 1)} value={current}
                  onPointerDown={() => setScrubbing(true)}
                  onPointerUp={() => setScrubbing(false)}
                  onPointerCancel={() => setScrubbing(false)}
                  onChange={(e) => jumpTo(Number(e.target.value))}
                  className="h-1 flex-1 accent-[rgb(var(--accent))]" />
                <button onClick={() => goChapter(nextId)} disabled={!nextId}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-black/45 text-white backdrop-blur disabled:opacity-30">
                  <IcChevronRight width={18} height={18} />
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
        {hiddenHere > 0 && (
          <motion.button
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
            onClick={() => {
              const ch = chapters[flat[current]?.ci ?? 0];
              if (!ch) return;
              setExpanded((prev) => {
                const n = new Set(prev);
                ch.pages.forEach((p) => { if (p.junk) n.add(`${ch.id}:${p.number}`); });
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
        {showSettings && <ReaderSettings prefs={prefs} set={setPref} onClose={() => setShowSettings(false)} />}
      </AnimatePresence>

      {showPages && (
        /* No control with no network: the decision is stored on the server, and a tile that flips and then
           silently reverts on the next load is worse than no tile at all. Read when the sheet opens rather
           than subscribed to, which is enough -- the sheet is short-lived and the failure path restores the
           flag anyway. */
        <PageGrid title={activeChapter?.title || tr('Pages')} pages={gridPages} current={current}
          onPick={jumpTo} onClose={() => setShowPages(false)}
          onToggleJunk={typeof navigator !== 'undefined' && navigator.onLine === false ? undefined : toggleJunk} />
      )}
      {showChapters && (
        <ChapterSheet title={tr('Chapters')} chapters={chapterRefs} activeId={activeChapter?.id}
          onPick={goChapter} onClose={() => setShowChapters(false)} />
      )}

      {!ready && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-ink-950">
          <div className="animate-pulse-soft text-fog-500">{tr('Loading chapter…')}</div>
        </div>
      )}
      {/* Nothing loaded at all. `ready` alone used to clear the overlay here and leave the bare backdrop. */}
      {ready && failed && !flat.length && (
        <div className="absolute inset-0 z-50 flex items-center justify-center overflow-y-auto bg-ink-950">
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

/**
 * One reader page, with a retry.
 *
 * Both call sites -- the continuous column and the paged slide -- keep their own classes, because the two
 * layouts size a page completely differently: one fills a box whose height was reserved from `page_dims`,
 * the other is bounded by the viewport. Only the failure behaviour is shared.
 */
function ReaderImg({ src, alt, className, style }: {
  src: string; alt: string; className?: string; style?: React.CSSProperties;
}) {
  const { src: shown, failed, onError, retry } = useImgRetry(src);
  if (failed) {
    // A broken glyph tells the reader nothing and offers nothing. This says which page failed and gives them
    // the one action that fixes it, without reloading the chapter and losing their place.
    return (
      <div className="flex h-full w-full items-center justify-center p-4">
        <button onClick={retry} className="chip text-xs text-fog-300">
          <IcRefresh width={13} height={13} />{tr('Page did not load — tap to retry')}
        </button>
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={shown} alt={alt} className={className} style={style} decoding="async" onError={onError} />;
}
