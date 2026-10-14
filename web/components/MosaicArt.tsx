'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Backdrop, useWideViewport } from './ui';
import { mosaicSource } from '@/lib/art';
import { isMosaicFrame, mosaicTiles, type MosaicFrame } from '@/lib/mosaic';
import { useReduceEffects } from '@/lib/effects';
import { EASE } from '@/lib/motion';

/**
 * The automatic banner as whole strips (UI refresh, lib/mosaic.ts): each crop of a series' own pages its own tile,
 * as many as the box has room for, the page showing between them, faded into the page at the bottom. The tiles
 * settle in one after another; under Reduce effects or reduced motion they are simply there.
 *
 * One picture for every tile -- the frame the server made, positioned per tile -- so it is one request, cached like
 * any other. If it fails, or turns out not to be the frame (an older server, a proxy's error page), `fallback` is
 * shown instead: the backdrop the series had before.
 *
 * The geometry is the art's, not the page's: tiles are laid left to right in a `dir="ltr"` box in Arabic too, the
 * way the server drew them.
 */
export function MosaicArt({ seriesId, autoHero, frame, fallback, className = '' }: {
  seriesId: string; autoHero: { seed: number } | null | undefined; frame: MosaicFrame; fallback: ReactNode; className?: string;
}) {
  const url = mosaicSource(seriesId, autoHero, frame === 'tall');
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    setOk(null);
    if (!url) { setOk(false); return; }
    const im = new Image();
    im.onload = () => { if (live) setOk(isMosaicFrame(frame, im.naturalWidth, im.naturalHeight)); };
    im.onerror = () => { if (live) setOk(false); };
    im.src = url;
    return () => { live = false; };
  }, [url, frame]);

  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ok]);

  // Both hooks on every render and in this order (effects.test.ts).
  const plain = useReduceEffects();
  const still = useReducedMotion();
  const reduced = plain || !!still;

  if (ok === false || !url) return <>{fallback}</>;
  const gap = box && box.w >= 1024 ? 6 : 4;
  const tiles = ok && box ? mosaicTiles(frame, box, gap) : [];
  // The bottom of the art fades into the page rather than stopping at a line. -webkit- first: Safari still needs it,
  // and a minifier keeps whichever comes last when it folds the pair.
  const fade = 'linear-gradient(to bottom, #000 64%, transparent)';
  return (
    <div ref={ref} data-mosaic={frame} dir="ltr" className={`overflow-hidden ${className}`}
      style={{ WebkitMaskImage: fade, maskImage: fade }}>
      {tiles.map((t, k) => (
        <motion.div key={`${url}#${t.place}`} data-mosaic-tile={t.place} aria-hidden
          className="absolute rounded-[4px] bg-ink-900 bg-no-repeat"
          initial={reduced ? false : { opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.07 * k, ease: EASE }}
          style={{ left: t.left, top: t.top, width: t.width, height: t.height, backgroundImage: `url("${url}")`, backgroundSize: t.backgroundSize, backgroundPosition: t.backgroundPosition }} />
      ))}
    </div>
  );
}

/**
 * A series' art for a hero or a banner: its automatic banner as whole strips when the server made one, else the
 * backdrop it always had -- its own banner, its cover, or its genre's art (lib/art.ts backdropSources). A portrait hero
 * (a phone's Home) takes the 2 x 2 frame; everything else the strip of four.
 */
export function HeroArt({ series, hero, banner, version, className = '' }: {
  series: { id: string; autoHero?: { seed: number } | null; metadata?: { genres?: string[] } | null };
  hero?: boolean; banner?: boolean;
  /** The series' art version, so a new banner or cover is a new URL (the series page's `artVersion`). */
  version?: number;
  className?: string;
}) {
  const wide = useWideViewport();
  // Without autoHero, so the fallback starts at the real backdrop rather than retrying the mosaic.
  const back = <Backdrop seriesId={series.id} genres={series.metadata?.genres} version={version} hero={hero} banner={banner} className={className} />;
  if (!series.autoHero) return back;
  return <MosaicArt seriesId={series.id} autoHero={series.autoHero} frame={hero && !wide ? 'tall' : 'wide'} fallback={back} className={className} />;
}
