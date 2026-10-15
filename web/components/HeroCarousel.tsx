'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { api, img } from '@/lib/api';
import { Series } from '@/lib/types';
import { useWideViewport } from './ui';
import { HeroArt } from './MosaicArt';
import { PhoneHeroCover } from './PhoneHeroCover';
import { backdropSources } from '@/lib/art';
import { applyCover } from '@/lib/theme';
import { IcPlay, IcHeart, IcChevronLeft, IcChevronRight } from './icons';
import { useReducedMotion } from 'framer-motion';
import { useReduceEffects } from '@/lib/effects';
import { EASE } from '@/lib/motion';
import { t as tr } from '@/lib/i18n';
import { statusText } from '@/lib/activity';
import { withCoverBust } from '@/lib/coverBust';

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
    <button onClick={toggle} aria-label={tr('Favourite')} aria-pressed={fav} className={`grid h-12 w-12 place-items-center rounded-xl border backdrop-blur transition active:scale-90 ${fav ? 'border-accent/50 bg-accent-soft text-accent' : 'border-white/20 bg-black/30 text-white'}`}>
      <IcHeart width={20} height={20} fill={fav ? 'currentColor' : 'none'} stroke={fav ? 'none' : 'currentColor'} />
    </button>
  );
}

/** The hero's round-cornered keys over art: glass, so they read on any picture. */
const HERO_KEY = 'h-10 w-10 place-items-center rounded-xl border border-white/15 bg-black/40 text-white backdrop-blur transition hover:bg-black/60 active:scale-95';

/** How long a slide shows before the next, while nothing holds it. */
const SLIDE_MS = 6500;

export function HeroCarousel({ slides }: { slides: Series[] }) {
  const [i, setI] = useState(0);
  // Held while the pointer is over the hero; `held` is the Pause key's (WCAG 2.2.2: a moving picture can be stopped).
  const [paused, setPaused] = useState(false);
  const [held, setHeld] = useState(false);
  const stopped = paused || held;
  // Both hooks on every render and in this order (effects.test.ts).
  const plain = useReduceEffects();
  const still = useReducedMotion();
  const reduced = plain || !!still;
  const startX = useRef(0);
  const n = slides.length;
  const cur = slides[i];

  useEffect(() => { if (i >= n) setI(0); }, [n, i]);
  useEffect(() => {
    if (!n || stopped) return;
    const t = setTimeout(() => setI((v) => (v + 1) % n), SLIDE_MS);
    return () => clearTimeout(t);
  }, [i, n, stopped]);
  useEffect(() => { if (cur?.color) applyCover(cur.color); }, [cur?.color]);

  // preload the NEXT slide's backdrop while the current one shows → rotation never waits on the network
  const wide = useWideViewport();
  useEffect(() => {
    if (n < 2) return;
    const nxt = slides[(i + 1) % n];
    // A phone's hero is the cover (components/PhoneHeroCover.tsx), so a phone warms the next cover instead.
    if (nxt) { const im = new Image(); im.src = wide ? backdropSources(nxt.id, nxt.autoHero, { hero: true, wide }, '')[0] : img.seriesThumb(nxt.id, nxt.artVersion, 1600); }
  }, [i, n, slides, wide]);

  if (!n || !cur) return null;
  const go = (d: number) => setI((v) => (v + d + n) % n);
  const summary = cur.metadata?.summary || cur.booksMetadata?.summary;

  return (
    <div
      data-home-hero
      className="bleed-lg under-topbar under-phone-header relative h-[min(150vw,82svh)] overflow-hidden lg:h-[64vh] lg:min-h-[420px]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onTouchStart={(e) => { startX.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => { const dx = e.changedTouches[0].clientX - startX.current; if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1); }}
    >
      <AnimatePresence>
        <motion.div key={cur.id} initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 1.06 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.9, ease: EASE }} className="absolute inset-0">
          {/* real art pulled from the internet (AniList) — sharp banner in the hero; for a series AniList has no banner
              for, the one the server made from its own pages (v0.51.0), as whole strips (UI refresh, components/MosaicArt.tsx);
              genre-banner fallback. Scrims stay light so the actual art shows: legibility gradient only bottom-start. */}
          {/* On a phone the slide is its series' cover, filling the hero (v0.67.1, the owner: the strips "still show the
              mashup of panels on phone"), as the series page's since v0.67.0. A computer keeps the banner and the strips. */}
          {wide ? <HeroArt series={cur} hero className="absolute inset-0" /> : <PhoneHeroCover id={cur.id} version={cur.artVersion} still={reduced} />}
          <div className="absolute inset-0 hidden bg-linear-to-t from-ink-950 via-ink-950/30 to-transparent lg:block" />
          <div className="absolute inset-0 hidden bg-linear-to-r from-ink-950/65 via-ink-950/20 to-transparent rtl:bg-linear-to-l lg:block" />
          {/* A phone's cover is shown: a fade at the foot for the title and keys, not the desktop's wash across it. */}
          <div className="absolute inset-x-0 bottom-0 h-[65%] bg-linear-to-t from-ink-950 via-ink-950/60 to-transparent lg:hidden" />
          <div className="absolute inset-0" style={{ background: 'radial-gradient(60% 70% at 22% 55%, rgb(var(--cover, 124 92 255) / 0.12), transparent 70%)' }} />
        </motion.div>
      </AnimatePresence>

      {/* The top bar is see-through over this (lib/overArt.ts), and so is a phone's header: a short scrim keeps their
          keys legible. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-28 bg-linear-to-b from-ink-950/70 to-transparent lg:h-32" />

      <div className="relative z-10 flex h-full items-end px-5 pb-12 lg:pb-20 lg:pe-14 lg:ps-[calc(var(--rail-w)+3.5rem)]">
        <div className="flex items-end gap-7">
          <Link href={`/series/?id=${cur.id}`} className="hidden h-72 w-48 shrink-0 overflow-hidden rounded-2xl border border-white/10 shadow-lift transition hover:-translate-y-1 lg:block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={withCoverBust(img.seriesThumb(cur.id, undefined, 800))} alt={cur.metadata?.title || cur.name} className="h-full w-full object-cover" />
          </Link>
          <div className="max-w-xl">
            <span className="mb-3 inline-flex items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1 text-2xs font-semibold uppercase tracking-wider text-fog-100 backdrop-blur rtl:tracking-normal">★ {tr('Daily pick')}</span>
            <h1 className="line-clamp-2 font-brand text-3xl font-bold leading-[1.05] text-white drop-shadow-[0_2px_16px_rgba(0,0,0,0.6)] lg:text-6xl">{cur.metadata?.title || cur.name}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fog-300 lg:text-sm">
              {cur.metadata?.status && <span className="capitalize text-fog-200">{statusText(cur.metadata.status)}</span>}
              <span>· {tr('{n} ch', { n: cur.booksCount })}</span>
              {(cur.metadata?.genres ?? []).slice(0, 3).map((g) => <span key={g} className="capitalize">· {g}</span>)}
            </div>
            {summary && <p className="mt-3 line-clamp-2 max-w-lg text-sm text-fog-300 lg:line-clamp-3">{summary}</p>}
            <div className="mt-5 flex items-center gap-3">
              <Link href={`/series/?id=${cur.id}`} className="btn-accent cta-glow px-7 py-3.5"><IcPlay width={18} height={18} />{tr('Read')}</Link>
              <FavButton series={cur} />
            </div>
            {/* Where the slides are: one segment each, the current one filling while it shows (still under Reduce effects
                or reduced motion, and while held). The segments are the slide buttons, under the text they belong to. */}
            {n > 1 && (
              <div className="mt-6 flex items-center gap-1.5" data-hero-slides>
                {slides.map((_, k) => (
                  <button key={k} type="button" aria-label={tr('Slide {n}', { n: k + 1 })} aria-current={k === i || undefined} onClick={() => setI(k)}
                    className="group grid h-5 place-items-center">
                    <span className={`relative h-1 overflow-hidden rounded-[2px] transition-[width,background-color] duration-300 ${k === i ? 'w-10 bg-white/25' : 'w-5 bg-white/25 group-hover:bg-white/45'}`}>
                      {k === i && (
                        <span key={`${i}:${stopped}`} aria-hidden className="absolute inset-0 origin-left bg-accent rtl:origin-right"
                          style={reduced || stopped ? undefined : { animation: `hero-progress ${SLIDE_MS}ms linear forwards` }} />
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Hold, and step: the Pause key on every screen (a phone swipes between slides); the arrows from lg up, together at
          the bottom end, clear of the sidebar and of the text. */}
      {n > 1 && (
        <div className="absolute bottom-5 end-4 z-10 flex items-center gap-2 lg:bottom-8 lg:end-8">
          <button type="button" onClick={() => go(-1)} aria-label={tr('Previous')} className={`hidden lg:grid ${HERO_KEY}`}><IcChevronLeft width={18} height={18} className="rtl:-scale-x-100" /></button>
          <button type="button" onClick={() => setHeld((v) => !v)} aria-label={held ? tr('Resume') : tr('Pause')} aria-pressed={held} className={`grid ${HERO_KEY}`}>
            {held ? <IcPlay width={15} height={15} /> : <span aria-hidden className="flex gap-[3px]"><span className="h-3.5 w-[3px] rounded-[1px] bg-current" /><span className="h-3.5 w-[3px] rounded-[1px] bg-current" /></span>}
          </button>
          <button type="button" onClick={() => go(1)} aria-label={tr('Next')} className={`hidden lg:grid ${HERO_KEY}`}><IcChevronRight width={18} height={18} className="rtl:-scale-x-100" /></button>
        </div>
      )}
    </div>
  );
}
