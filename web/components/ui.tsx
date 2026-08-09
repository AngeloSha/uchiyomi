'use client';
import { useState, ReactNode, useRef, useEffect } from 'react';
import { genreBackdrop } from '@/lib/art';

/** Series backdrop: the BFF composites a wide, blurred, darkened full-bleed ambient from the series art
 *  (AniList banner or portrait cover), so we just render it object-cover — fills the hero on any aspect,
 *  no empty bars, no floating poster. Genre art is the fallback. `className` positions the wrapper.
 *  `hero` requests the sharp variant: the real art, served in a frame that matches the viewport
 *  (`ar=wide` desktop / `ar=tall` phone) so the client barely crops — mismatched shapes come back as the
 *  whole image over a blurred self-fill instead of a double-cropped zoom. */
/** True at/above the lg breakpoint; tracks rotations/resizes. Lazy init avoids a wrong first value. */
export function useWideViewport(): boolean {
  const [wide, setWide] = useState(() => (typeof window === 'undefined' ? true : window.matchMedia('(min-width: 1024px)').matches));
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const apply = () => setWide(mq.matches);
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return wide;
}

/** Backdrop URL builder — shared by <Backdrop> and preloaders (e.g. the hero preloading its next slide). */
export const backdropUrl = (seriesId: string, opts: { hero?: boolean; wide?: boolean; version?: number } = {}) => {
  const params = [opts.version ? `av=${opts.version}` : '', opts.hero ? `style=hero&ar=${opts.wide ? 'wide' : 'tall'}` : ''].filter(Boolean).join('&');
  return `/img/series/${encodeURIComponent(seriesId)}/backdrop${params ? `?${params}` : ''}`;
};

export function Backdrop({ seriesId, genres, className = '', version, hero }: { seriesId?: string; genres?: string[]; className?: string; version?: number; hero?: boolean }) {
  const fallback = genreBackdrop(genres);
  const wide = useWideViewport();
  const real = seriesId ? backdropUrl(seriesId, { hero, wide, version }) : fallback;
  const [src, setSrc] = useState(real);
  useEffect(() => { setSrc(real); }, [real]);
  return (
    <div className={className}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" aria-hidden="true" onError={() => setSrc(fallback)} className="absolute inset-0 h-full w-full object-cover" />
    </div>
  );
}

/** Image with skeleton + fade-in + graceful fallback. */
export function Img({
  src,
  alt,
  className = '',
  eager = false,
}: {
  src: string;
  alt: string;
  className?: string;
  eager?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  return (
    <div className={`relative overflow-hidden bg-ink-800 ${className}`}>
      {!loaded && !error && <div className="skeleton absolute inset-0" />}
      {error ? (
        <div className="flex h-full w-full items-center justify-center text-ink-500">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <path d="m4 16 4-4 4 4 3-3 5 5" />
          </svg>
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
          className={`h-full w-full object-cover transition-all duration-700 ease-out ${loaded ? 'scale-100 opacity-100 blur-0' : 'scale-105 opacity-0 blur-md'}`}
        />
      )}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between px-4">
      <h2 className="font-display text-lg font-semibold tracking-tight text-fog-50">{children}</h2>
      {action}
    </div>
  );
}

/** Horizontal snap rail. */
export function Rail({ children }: { children: ReactNode }) {
  return (
    <div className="hide-scrollbar flex gap-3 overflow-x-auto px-4 pb-1 [scroll-snap-type:x_mandatory]">
      {children}
    </div>
  );
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-ink-700">
      <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  );
}

export function CardSkeleton({ wide = false }: { wide?: boolean }) {
  return <div className={`skeleton shrink-0 rounded-2xl ${wide ? 'h-44 w-72' : 'aspect-[2/3] w-32'}`} />;
}

export function RailSkeleton({ wide = false }: { wide?: boolean }) {
  return (
    <div className="hide-scrollbar flex gap-3 overflow-x-hidden px-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <CardSkeleton key={i} wide={wide} />
      ))}
    </div>
  );
}

/** Fade/slide a block in once mounted. */
export function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  return (
    <div ref={ref} className={`transition-all duration-700 ${show ? 'opacity-100 translate-y-0' : 'translate-y-3 opacity-0'}`}>
      {children}
    </div>
  );
}
