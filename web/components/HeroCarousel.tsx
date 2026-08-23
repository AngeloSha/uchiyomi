'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { api, img } from '@/lib/api';
import { Series } from '@/lib/types';
import { Backdrop, backdropUrl, useWideViewport } from './ui';
import { applyCover } from '@/lib/theme';
import { IcPlay, IcHeart, IcChevronLeft, IcChevronRight } from './icons';
import { t as tr } from '@/lib/i18n';

function FavButton({ series }: { series: Series }) {
  const qc = useQueryClient();
  const [fav, setFav] = useState(!!series.yomi?.favorite);
  useEffect(() => setFav(!!series.yomi?.favorite), [series.id, series.yomi?.favorite]);
  const toggle = async (e: React.MouseEvent) => {
    e.preventDefault();
    const next = !fav;
    setFav(next);
    try {
      if (next) await api('/api/favorites', { json: { seriesId: series.id } });
      else await api(`/api/favorites/${series.id}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['home'] });
    } catch { setFav(!next); }
  };
  return (
    <button onClick={toggle} className={`grid h-12 w-12 place-items-center rounded-full border backdrop-blur transition active:scale-90 ${fav ? 'border-accent/50 bg-accent-soft text-accent' : 'border-white/20 bg-black/30 text-white'}`}>
      <IcHeart width={20} height={20} fill={fav ? 'currentColor' : 'none'} stroke={fav ? 'none' : 'currentColor'} />
    </button>
  );
}

export function HeroCarousel({ slides }: { slides: Series[] }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const startX = useRef(0);
  const n = slides.length;
  const cur = slides[i];

  useEffect(() => { if (i >= n) setI(0); }, [n, i]);
  useEffect(() => {
    if (!n || paused) return;
    const t = setTimeout(() => setI((v) => (v + 1) % n), 6500);
    return () => clearTimeout(t);
  }, [i, n, paused]);
  useEffect(() => { if (cur?.color) applyCover(cur.color); }, [cur?.color]);

  // preload the NEXT slide's backdrop while the current one shows → rotation never waits on the network
  const wide = useWideViewport();
  useEffect(() => {
    if (n < 2) return;
    const nxt = slides[(i + 1) % n];
    if (nxt) { const im = new Image(); im.src = backdropUrl(nxt.id, { hero: true, wide }); }
  }, [i, n, slides, wide]);

  if (!n || !cur) return null;
  const go = (d: number) => setI((v) => (v + d + n) % n);
  const summary = cur.metadata?.summary || cur.booksMetadata?.summary;

  return (
    <div
      className="relative h-[58vh] min-h-[420px] w-full overflow-hidden lg:-mx-8 lg:h-[64vh] lg:w-[calc(100%+4rem)]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onTouchStart={(e) => { startX.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => { const dx = e.changedTouches[0].clientX - startX.current; if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1); }}
    >
      <AnimatePresence>
        <motion.div key={cur.id} initial={{ opacity: 0, scale: 1.06 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }} className="absolute inset-0">
          {/* real art pulled from the internet (AniList) — sharp banner in the hero; genre-banner fallback.
              Scrims stay light so the actual art shows: clear top, legibility gradient only bottom-left. */}
          <Backdrop seriesId={cur.id} genres={cur.metadata?.genres} hero className="absolute inset-0" />
          <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/30 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-r from-ink-950/65 via-ink-950/20 to-transparent" />
          <div className="absolute inset-0" style={{ background: 'radial-gradient(60% 70% at 22% 55%, rgb(var(--cover, 124 92 255) / 0.12), transparent 70%)' }} />
        </motion.div>
      </AnimatePresence>

      <div className="relative z-10 flex h-full items-end px-5 pb-12 lg:px-14 lg:pb-20">
        <div className="flex items-end gap-7">
          <Link href={`/series/?id=${cur.id}`} className="hidden h-72 w-48 shrink-0 overflow-hidden rounded-2xl border border-white/10 shadow-lift transition hover:-translate-y-1 lg:block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img.seriesThumb(cur.id, undefined, 800)} alt={cur.metadata?.title || cur.name} className="h-full w-full object-cover" />
          </Link>
          <div className="max-w-xl">
            <span className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-fog-100 backdrop-blur">★ Daily pick</span>
            <h1 className="font-brand text-3xl font-bold leading-[1.05] text-white drop-shadow-[0_2px_16px_rgba(0,0,0,0.6)] lg:text-6xl">{cur.metadata?.title || cur.name}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fog-300 lg:text-sm">
              {cur.metadata?.status && <span className="capitalize text-fog-200">{cur.metadata.status.toLowerCase()}</span>}
              <span>· {cur.booksCount} ch</span>
              {(cur.metadata?.genres ?? []).slice(0, 3).map((g) => <span key={g} className="capitalize">· {g}</span>)}
            </div>
            {summary && <p className="mt-3 line-clamp-2 max-w-lg text-sm text-fog-300 lg:line-clamp-3">{summary}</p>}
            <div className="mt-5 flex items-center gap-3">
              <Link href={`/series/?id=${cur.id}`} className="btn-accent px-7 py-3.5"><IcPlay width={18} height={18} />{tr('Read')}</Link>
              <FavButton series={cur} />
            </div>
          </div>
        </div>
      </div>

      {/* dots */}
      <div className="absolute bottom-5 left-1/2 z-10 flex -translate-x-1/2 gap-2">
        {slides.map((_, k) => (
          <button key={k} aria-label={`Slide ${k + 1}`} onClick={() => setI(k)} className="grid place-items-center py-1">
            <span className={`h-2 rounded-full transition-all ${k === i ? 'w-7 bg-accent' : 'w-2 bg-white/35'}`} />
          </button>
        ))}
      </div>
      {/* arrows (phone + desktop) */}
      <button onClick={() => go(-1)} aria-label={tr('Previous')} className="absolute left-2 top-1/2 z-10 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white backdrop-blur transition hover:bg-black/60 active:scale-90 lg:left-4 lg:h-11 lg:w-11"><IcChevronLeft width={20} height={20} /></button>
      <button onClick={() => go(1)} aria-label={tr('Next')} className="absolute right-2 top-1/2 z-10 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white backdrop-blur transition hover:bg-black/60 active:scale-90 lg:right-4 lg:h-11 lg:w-11"><IcChevronRight width={20} height={20} /></button>
    </div>
  );
}
