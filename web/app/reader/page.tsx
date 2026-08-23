'use client';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { Book, Page, PageInfo, Series } from '@/lib/types';
import { chapterLabel } from '@/lib/format';
import { deviceId } from '@/lib/device';
import { getOfflineChapter, getPageBlob, queueProgress } from '@/lib/downloads';
import { applyCover, clearCover } from '@/lib/theme';
import { ReaderPrefs, loadPrefs, savePrefs, loadSeriesPrefs, saveSeriesPrefs, syncPrefsFromServer, THEME_FILTER } from '@/lib/readerPrefs';
import { ReaderSettings } from '@/components/ReaderSettings';
import { Rail, SectionTitle } from '@/components/ui';
import { SeriesCard } from '@/components/cards';
import { IcChevronLeft, IcChevronRight, IcSliders } from '@/components/icons';
import { t as tr } from '@/lib/i18n';

interface PageDim { number: number; width: number | null; height: number | null }
interface Chapter { id: string; seriesId: string; seriesTitle: string; title: string; pages: PageDim[]; offline: boolean }
interface ChapterRef { id: string; label: string }
interface FlatItem { ci: number; number: number; width: number | null; height: number | null; key: string; firstOfChapter: boolean }

const WINDOW_BEHIND = 2;
const WINDOW_AHEAD = 6;
const DIVIDER_H = 60;

async function loadChapter(bookId: string): Promise<Chapter | null> {
  const off = await getOfflineChapter(bookId);
  if (off) {
    return { id: bookId, seriesId: off.seriesId, seriesTitle: off.seriesTitle, title: off.title, pages: off.pages, offline: true };
  }
  try {
    const b = await api<Book>(`/api/books/${bookId}`);
    const pInfo = await api<PageInfo[]>(`/api/books/${bookId}/pages`);
    return {
      id: bookId,
      seriesId: b.seriesId,
      seriesTitle: b.seriesTitle,
      title: b.metadata?.title || b.name,
      pages: pInfo.map((p) => ({ number: p.number, width: p.width ?? null, height: p.height ?? null })),
      offline: false,
    };
  } catch {
    return null;
  }
}

function ReaderInner() {
  const bookId = useSearchParams().get('book') || '';
  const router = useRouter();

  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [chapterRefs, setChapterRefs] = useState<ChapterRef[]>([]);
  const [startPage, setStartPage] = useState(1);
  const [ready, setReady] = useState(false);
  const [ended, setEnded] = useState(false); // reached the last chapter of the series → show Up Next

  const [prefs, setPrefs] = useState<ReaderPrefs>(loadPrefs());
  const [zoom, setZoom] = useState(1);
  const [rtl, setRtl] = useState(false); // series reads right-to-left → double-spread pair order flips
  const [scrubbing, setScrubbing] = useState(false); // slider drag in progress → show the page preview

  const [chrome, setChrome] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [current, setCurrent] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [colW, setColW] = useState(0);
  const didInitScroll = useRef(false);
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
    completedSent.current.clear();
    prevPos.current = null;
    blobUrls.current.forEach((u) => URL.revokeObjectURL(u));
    blobUrls.current.clear();
    (async () => {
      const first = await loadChapter(bookId);
      if (!alive || !first) { setReady(true); return; }
      // resume page from live progress
      try {
        const b = await api<Book>(`/api/books/${bookId}`);
        if (b.readProgress && !b.readProgress.completed) setStartPage(b.readProgress.page);
        else setStartPage(1);
      } catch { setStartPage(1); }
      if (!alive) return;
      setChapters([first]);
      if (first.offline && first.pages[0] && first.pages[0].width && first.pages[0].height) {
        // offline reading-direction hint not available here; keep current pref
      }
      // chapter list for prev/next/jump
      try {
        const list = await api<Page<Book>>(`/api/series/${first.seriesId}/books?size=1000&sort=metadata.numberSort,asc`);
        if (alive) setChapterRefs(list.content.map((b) => ({ id: b.id, label: chapterLabel(b) })));
      } catch {}
      // reading direction (drives double-spread pair order for RTL manga)
      try {
        const s = await api<Series>(`/api/series/${first.seriesId}`);
        if (alive) setRtl(s?.metadata?.readingDirection === 'RIGHT_TO_LEFT');
      } catch {}
      setReady(true);
    })();
    return () => {
      alive = false;
      blobUrls.current.forEach((u) => URL.revokeObjectURL(u));
      blobUrls.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // ---- flat page list across loaded chapters ----
  const flat: FlatItem[] = useMemo(() => {
    const arr: FlatItem[] = [];
    chapters.forEach((ch, ci) =>
      ch.pages.forEach((p, pi) =>
        arr.push({ ci, number: p.number, width: p.width, height: p.height, key: `${ch.id}:${p.number}`, firstOfChapter: pi === 0 }),
      ),
    );
    return arr;
  }, [chapters]);

  // ---- paged slides: 1 page per slide, or double spreads (chapter's first page solo, manga convention) ----
  const { slides, slideOf } = useMemo(() => {
    const sl: number[][] = [];
    if (prefs.mode === 'paged' && prefs.spread) {
      let k = 0;
      while (k < flat.length) {
        const it = flat[k];
        const nxt = flat[k + 1];
        if (it.firstOfChapter || !nxt || nxt.ci !== it.ci) { sl.push([k]); k++; }
        else { sl.push([k, k + 1]); k += 2; }
      }
    } else {
      for (let k = 0; k < flat.length; k++) sl.push([k]);
    }
    const so: number[] = new Array(flat.length);
    sl.forEach((idxs, s) => idxs.forEach((k) => { so[k] = s; }));
    return { slides: sl, slideOf: so };
  }, [flat, prefs.mode, prefs.spread]);

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
  const { heights, tops } = useMemo(() => {
    const hs = flat.map((p) => (p.width && p.height ? colW * (p.height / p.width) : colW * 1.4));
    const ts: number[] = [];
    let acc = 0;
    flat.forEach((p, i) => {
      if (p.firstOfChapter && p.ci > 0) acc += DIVIDER_H;
      ts.push(acc);
      acc += hs[i] + prefs.gap;
    });
    return { heights: hs, tops: ts };
  }, [flat, colW, prefs.gap]);

  // ---- active render window ----
  const activeSet = useMemo(() => {
    const s = new Set<number>();
    for (let i = current - WINDOW_BEHIND; i <= current + WINDOW_AHEAD; i++) if (i >= 0 && i < flat.length) s.add(i);
    return s;
  }, [current, flat.length]);

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

  // ---- initial scroll to resume page ----
  useEffect(() => {
    if (!ready || didInitScroll.current || !colW || !tops.length) return;
    const idx = Math.max(0, Math.min(flat.length - 1, startPage - 1));
    if (prefs.mode === 'vertical' && scrollRef.current && idx > 0) scrollRef.current.scrollTop = tops[idx];
    if (prefs.mode === 'paged' && scrollRef.current && idx > 0)
      scrollRef.current.scrollLeft = (slideOf[idx] ?? idx) * scrollRef.current.clientWidth;
    setCurrent(idx);
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
      const idx = chapterRefs.findIndex((c) => c.id === last?.id);
      const next = idx >= 0 ? chapterRefs[idx + 1] : null;
      if (!next) { noMore.current = true; setEnded(true); appending.current = false; return; }
      const ch = await loadChapter(next.id);
      if (ch && ch.pages.length) setChapters((cs) => (cs.some((c) => c.id === ch.id) ? cs : [...cs, ch]));
      else { noMore.current = true; setEnded(true); }
      appending.current = false;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, ready, flat.length, chapterRefs]);

  // ---- submit progress for the active chapter ----
  // Two paths: (a) regular page progress, debounced 600ms; (b) chapter COMPLETION, sent immediately —
  // the debounce used to swallow completions when readers scrolled through a chapter's last page without
  // lingering (webtoon fast-scroll can even skip it entirely), so finished chapters never counted as read.
  const lastSent = useRef('');
  const completedSent = useRef(new Set<string>());
  const prevPos = useRef<{ ci: number } | null>(null);
  const sendProgress = useCallback((chId: string, sId: string, page: number, completed: boolean) => {
    const payload = { page, completed, seriesId: sId, deviceId: deviceId() };
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
  const upNextCard = (
    <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
      className="mx-auto w-full max-w-3xl px-6 py-16 text-center">
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-fog-500">{tr('You finished')}</p>
      <h2 className="mt-1.5 font-display text-2xl font-bold text-white">{activeChapter?.seriesTitle || 'this series'}</h2>
      <div className="mt-6 flex justify-center gap-2">
        {/* labelled "Back to series", so go to the series -- `back` is history-first and from the home
            Continue rail would land on home instead */}
        <button onClick={() => (seriesHref ? router.push(seriesHref) : back())} className="btn-ghost text-sm">{tr('Back to series')}</button>
        <button onClick={() => router.push('/')} className="btn-accent text-sm">{tr('Home')}</button>
      </div>
      {!!upNext?.content?.length && (
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
      {prefs.mode === 'vertical' ? (
        <div ref={scrollRef} data-lenis-prevent onScroll={onScroll} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
          className={`h-screen-d touch-pan-y overflow-y-auto overscroll-contain ${zoom > 1 ? 'overflow-x-auto' : 'overflow-x-hidden'}`}>
          <div className="mx-auto" style={{ width: colW || '100%', filter: THEME_FILTER[prefs.theme] }}>
            <div className="h-2" />
            {flat.map((p, i) => (
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
                  {activeSet.has(i) && srcFor(i) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={srcFor(i)!} alt={`Page ${p.number}`} className="block h-full w-full object-cover" decoding="async" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-xs text-ink-600">{p.number}</div>
                  )}
                </div>
              </div>
            ))}
            {ended && upNextCard}
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
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={p.key} src={srcFor(i)!} alt={`Page ${p.number}`}
                      className={`max-h-full object-contain ${idxs.length === 2 ? 'max-w-[50%]' : 'max-w-full'}`}
                      decoding="async" style={{ transform: zoom !== 1 ? `scale(${zoom})` : undefined }} />
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
        </div>
      )}

      {/* CHROME */}
      <AnimatePresence>
        {chrome && (
          <>
            <motion.header initial={{ y: -64, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -64, opacity: 0 }}
              className="absolute inset-x-0 top-0 z-40 flex items-center gap-2 bg-gradient-to-b from-black/90 via-black/55 to-transparent px-3 pb-8 pt-[max(0.9rem,calc(env(safe-area-inset-top)+0.55rem))]">
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
              {/* desktop chapter jump */}
              {chapterRefs.length > 0 && (
                <select value={activeChapter?.id || ''} onChange={(e) => goChapter(e.target.value)}
                  className="hidden max-w-[180px] rounded-full border border-ink-600 bg-ink-900/80 px-3 py-2 text-xs text-fog-200 outline-none lg:block">
                  {chapterRefs.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
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
              className="absolute inset-x-0 bottom-0 z-40 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-4 pt-10 pb-[max(0.9rem,calc(env(safe-area-inset-bottom)+0.4rem))]">
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
                <span className="shrink-0 text-[11px] tabular-nums text-fog-300">{chapterPageCount ? `${pageInChapter}/${chapterPageCount}` : `${current + 1}/${total}`}</span>
                <input type="range" min={0} max={Math.max(0, total - 1)} value={current}
                  onPointerDown={() => setScrubbing(true)}
                  onPointerUp={() => setScrubbing(false)}
                  onPointerCancel={() => setScrubbing(false)}
                  onChange={(e) => {
                    const idx = Number(e.target.value);
                    setCurrent(idx);
                    if (prefs.mode === 'vertical') scrollRef.current?.scrollTo({ top: tops[idx] || 0 });
                    else scrollRef.current?.scrollTo({ left: (slideOf[idx] ?? idx) * (scrollRef.current?.clientWidth || 0) });
                  }}
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

      <AnimatePresence>
        {showSettings && <ReaderSettings prefs={prefs} set={setPref} onClose={() => setShowSettings(false)} />}
      </AnimatePresence>

      {!ready && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-ink-950">
          <div className="animate-pulse-soft text-fog-500">{tr('Loading chapter…')}</div>
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
