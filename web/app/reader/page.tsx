'use client';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { api, img } from '@/lib/api';
import { Book, Page, PageInfo } from '@/lib/types';
import { chapterLabel } from '@/lib/format';
import { deviceId } from '@/lib/device';
import { getOfflineChapter, getPageBlob, queueProgress } from '@/lib/downloads';
import { applyCover, clearCover } from '@/lib/theme';
import { ReaderPrefs, loadPrefs, savePrefs, loadSeriesPrefs, saveSeriesPrefs, THEME_FILTER } from '@/lib/readerPrefs';
import { ReaderSettings } from '@/components/ReaderSettings';
import { IcChevronLeft, IcChevronRight, IcSliders } from '@/components/icons';

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

  const [prefs, setPrefs] = useState<ReaderPrefs>(loadPrefs());
  const [zoom, setZoom] = useState(1);

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
      if ((p.mode || p.theme) && seriesId0) saveSeriesPrefs(seriesId0, { mode: n.mode, theme: n.theme });
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
    didInitScroll.current = false;
    appending.current = false;
    noMore.current = false;
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
    setCurrent(idx);
    didInitScroll.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, colW, tops]);

  // ---- track current page on scroll ----
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prefs.mode === 'paged') {
      setCurrent((c) => { const i = Math.round(el.scrollLeft / Math.max(1, el.clientWidth)); return c === i ? c : i; });
      return;
    }
    const probe = el.scrollTop + el.clientHeight * 0.4;
    let lo = 0, hi = tops.length - 1, ans = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (tops[mid] <= probe) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    setCurrent((c) => (c === ans ? c : ans));
  }, [tops, prefs.mode]);

  // ---- continuous reading: append next chapter near the end ----
  useEffect(() => {
    if (!ready || !flat.length || appending.current || noMore.current) return;
    if (current < flat.length - 4) return;
    appending.current = true;
    (async () => {
      const last = chapters[chapters.length - 1];
      const idx = chapterRefs.findIndex((c) => c.id === last?.id);
      const next = idx >= 0 ? chapterRefs[idx + 1] : null;
      if (!next) { noMore.current = true; appending.current = false; return; }
      const ch = await loadChapter(next.id);
      if (ch && ch.pages.length) setChapters((cs) => (cs.some((c) => c.id === ch.id) ? cs : [...cs, ch]));
      else noMore.current = true;
      appending.current = false;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, ready, flat.length, chapterRefs]);

  // ---- submit progress for the active chapter (debounced) ----
  const lastSent = useRef('');
  useEffect(() => {
    if (!ready || !flat.length) return;
    const it = flat[current];
    if (!it) return;
    const ch = chapters[it.ci];
    if (!ch) return;
    const isLastOfChapter = current === flat.length - 1 || flat[current + 1]?.ci !== it.ci;
    const tag = `${ch.id}:${it.number}`;
    if (lastSent.current === tag) return;
    const t = setTimeout(async () => {
      lastSent.current = tag;
      const payload = { page: it.number, completed: isLastOfChapter, seriesId: ch.seriesId, deviceId: deviceId() };
      try { await api(`/api/books/${ch.id}/progress`, { method: 'PUT', json: payload }); }
      catch { await queueProgress({ bookId: ch.id, ...payload }); }
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
  const activeChapter = chapters[flat[current]?.ci ?? 0];
  const activeIdx = chapterRefs.findIndex((c) => c.id === activeChapter?.id);
  const prevId = activeIdx > 0 ? chapterRefs[activeIdx - 1]?.id : undefined;
  const nextId = activeIdx >= 0 && activeIdx < chapterRefs.length - 1 ? chapterRefs[activeIdx + 1]?.id : undefined;

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

  // ---- per-series memory (mode/theme/zoom) ----
  useEffect(() => {
    if (!seriesId) return;
    const sp = loadSeriesPrefs(seriesId);
    if (sp.mode || sp.theme) setPrefs((cur) => ({ ...cur, ...(sp.mode ? { mode: sp.mode } : {}), ...(sp.theme ? { theme: sp.theme } : {}) }));
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
  const chapterPageCount = activeChapter?.pages.length ?? 0;

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
                    <span className="h-px w-10 bg-ink-700" />
                    {chapters[p.ci]?.title || 'Next chapter'}
                    <span className="h-px w-10 bg-ink-700" />
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
            {noMore.current && (
              <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-fog-500">
                <p className="font-display text-base font-semibold text-fog-200">You're all caught up</p>
                <button onClick={back} className="btn-ghost mt-1 text-sm">Back to series</button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div ref={scrollRef} data-lenis-prevent onScroll={onScroll} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
          className="hide-scrollbar flex h-screen-d snap-x snap-mandatory overflow-x-auto overflow-y-hidden" style={{ filter: THEME_FILTER[prefs.theme] }}>
          {flat.map((p, i) => (
            <div key={p.key} className="relative flex h-full w-full shrink-0 snap-center items-center justify-center">
              {activeSet.has(i) && srcFor(i) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={srcFor(i)!} alt={`Page ${p.number}`} className="max-h-full max-w-full object-contain" decoding="async" style={{ transform: zoom !== 1 ? `scale(${zoom})` : undefined }} />
              ) : (
                <span className="text-ink-600">{p.number}</span>
              )}
            </div>
          ))}
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
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-white">{activeChapter?.seriesTitle || 'Reading'}</p>
                <p className="truncate text-[11px] text-fog-400">{activeChapter?.title}</p>
              </div>
              {/* desktop chapter jump */}
              {chapterRefs.length > 0 && (
                <select value={activeChapter?.id || ''} onChange={(e) => goChapter(e.target.value)}
                  className="hidden max-w-[180px] rounded-full border border-ink-600 bg-ink-900/80 px-3 py-2 text-xs text-fog-200 outline-none lg:block">
                  {chapterRefs.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              )}
              <button onClick={() => setShowSettings(true)} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-black/45 text-white backdrop-blur">
                <IcSliders width={20} height={20} />
              </button>
            </motion.header>

            <motion.footer initial={{ y: 64, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 64, opacity: 0 }}
              className="absolute inset-x-0 bottom-0 z-40 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-4 pt-10 pb-[max(0.9rem,calc(env(safe-area-inset-bottom)+0.4rem))]">
              <div className="mx-auto flex max-w-3xl items-center gap-2">
                <button onClick={() => goChapter(prevId)} disabled={!prevId}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-black/45 text-white backdrop-blur disabled:opacity-30">
                  <IcChevronLeft width={18} height={18} />
                </button>
                <span className="shrink-0 text-[11px] tabular-nums text-fog-300">{chapterPageCount ? `${pageInChapter}/${chapterPageCount}` : `${current + 1}/${total}`}</span>
                <input type="range" min={0} max={Math.max(0, total - 1)} value={current}
                  onChange={(e) => {
                    const idx = Number(e.target.value);
                    setCurrent(idx);
                    if (prefs.mode === 'vertical') scrollRef.current?.scrollTo({ top: tops[idx] || 0 });
                    else scrollRef.current?.scrollTo({ left: idx * (scrollRef.current?.clientWidth || 0) });
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
          <div className="animate-pulse-soft text-fog-500">Loading chapter…</div>
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
