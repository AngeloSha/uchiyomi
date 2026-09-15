'use client';
import { useState, ReactNode, useRef, useEffect, useCallback } from 'react';
import { genreBackdrop } from '@/lib/art';
import { t as tr } from '@/lib/i18n';

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

/**
 * Whether the app is currently rendering right-to-left.
 *
 * Read from the document rather than from i18n state because the layout provider is what actually sets
 * `dir`, and it is the same source the CSS logical properties are resolving against. Starts `false` and
 * corrects after mount: this is a static export, so the first paint happens before any locale is known, and
 * a hook that guessed would be wrong for one frame in every language rather than none.
 *
 * Charts use it to reverse their DATA, never their geometry -- a mirrored `<g>` mirrors the numerals too.
 */
export function useRtl(): boolean {
  const [rtl, setRtl] = useState(false);
  useEffect(() => {
    const read = () => setRtl(document.documentElement.dir === 'rtl');
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['dir'] });
    return () => mo.disconnect();
  }, []);
  return rtl;
}

/**
 * A bottom sheet, for the reader.
 *
 * `Modal` in ConfirmDialog.tsx is centred and sized for a form. The reader is the one immersive surface in
 * the app -- no shell, no nav -- and the two things you reach for there (jump to a page, jump to a chapter)
 * are one-handed, so they come up from the bottom edge where a thumb already is.
 *
 * `data-lenis-prevent` on the scroller is not optional: Lenis drives smooth scrolling for the whole app, and
 * without it a flick inside the sheet scrolls the chapter behind it instead.
 */
export function Sheet({ title, onClose, overBottomNav, action, footer, children }: {
  title: string;
  onClose: () => void;
  /** Something small beside the close button: the (i) that opens the explainer, for instance. */
  action?: ReactNode;
  /**
   * A row pinned under the scrolling body -- a form's Save, for one. It lives OUTSIDE the scroller on
   * purpose: a `sticky bottom-0` inside it sticks to the scrollport's edge, which on a phone is exactly
   * the band the bottom nav paints over (the nav is a root-level sibling above `main`), so a sticky Save
   * was permanently hidden there. Out here the same `overBottomNav` rule pads it clear of the bar.
   */
  footer?: ReactNode;
  /**
   * Clear the bottom nav bar as well as the safe area.
   *
   * ⚠️ Off by default because this was written for the reader, which hides the whole shell -- there is no
   * nav bar there to clear. Opened from a page that HAS one, the default padding puts the last rows of the
   * sheet underneath it: on the library's filters that made the final genre unreachable, on a phone, with
   * nothing on screen to suggest anything was missing. 5.5rem is the bar plus its own safe-area inset.
   */
  overBottomNav?: boolean;
  children: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    // Open where you already are. A `<select>` -- which the chapter sheet replaced -- scrolls to the
    // selected option for free; a scrollable div does not, so on chapter 180 of 200 this opened at
    // chapter 1 and the marked row was several screens down. `aria-current` is the contract.
    const here = bodyRef.current?.querySelector('[aria-current]');
    if (here) here.scrollIntoView({ block: 'center' });
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 backdrop-blur-xs"
      role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      {/* The panel is a column: header, the one scroller, then the optional footer. Only the middle scrolls, so
          the footer stays put and the padding that clears the bottom nav is applied to whichever of the two
          is last. A sheet WITH a footer may take 85vh rather than 75: the footer's rows come out of the
          scroller's share, and at 390×667 the admin sources sheet's footer plus the nav padding left the
          scroller 179 px -- its second section began below the fold. */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={`glass flex w-full flex-col rounded-t-3xl border border-ink-700 pt-4
                   sm:mb-6 sm:max-w-xl sm:rounded-3xl ${footer ? 'max-h-[85vh]' : 'max-h-[75vh]'} ${
                     overBottomNav
                       ? 'pb-[calc(5.5rem+env(safe-area-inset-bottom))] sm:pb-[max(1rem,env(safe-area-inset-bottom))]'
                       : 'pb-[max(1rem,env(safe-area-inset-bottom))]'
                   }`}
      >
        <div className="mb-3 flex items-center justify-between gap-3 px-4">
          <h2 className="min-w-0 truncate font-display text-base font-semibold text-fog-50">{title}</h2>
          <span className="flex shrink-0 items-center gap-2">
            {action}
            <button onClick={onClose} aria-label={tr('Close')}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink-800/80 text-fog-300">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </span>
        </div>
        <div ref={bodyRef} data-lenis-prevent className="min-h-0 flex-1 overflow-y-auto px-4">
          {children}
        </div>
        {footer && <div className="border-t border-ink-800/70 px-4 pt-3">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * One automatic retry for an <img> the caller draws itself, plus a manual one after that.
 *
 * `Img` above already does this, but it is the wrong component for a reader page. `Img` owns its own box and
 * fades in over 700ms with a blur and a scale -- right for a cover appearing once on a shelf, wrong for the
 * ninth page of a webtoon sliding past under a thumb, and it would fight the exact height the reader has
 * already reserved from `page_dims`. So the behaviour is a hook and the markup stays with the caller.
 *
 * Reader pages were raw `<img>` with no `onError` at all: one 502 from the page endpoint and that page was a
 * broken-image glyph until the whole chapter was reloaded.
 *
 * The retry appends `r=<attempt>` because a browser that has cached the failed response would otherwise
 * serve it straight back. It changes no server-side cache key -- those are keyed on width -- so it does not
 * cost a fresh CBZ open.
 */
export function useImgRetry(src: string, autoTries = 1) {
  const [attempt, setAttempt] = useState(0);
  // A new page in the same slot must start from a clean slate, or a page that failed once leaves the next
  // one showing its retry button.
  useEffect(() => { setAttempt(0); }, [src]);
  const failed = attempt > autoTries;
  const shown = attempt === 0 ? src : `${src}${src.includes('?') ? '&' : '?'}r=${attempt}`;
  return {
    src: failed ? '' : shown,
    failed,
    onError: useCallback(() => setAttempt((a) => a + 1), []),
    retry: useCallback(() => setAttempt(0), []),
  };
}

/** Image with skeleton + fade-in + graceful fallback. */
export function Img({
  src,
  alt,
  className = '',
  imgClassName = '',
  fallbackSrc,
  eager = false,
}: {
  src: string;
  alt: string;
  className?: string;
  /**
   * Classes for the inner <img>, not the wrapper. `className` lands on the positioning div, so an
   * `object-top` passed there is inert -- and a 2:3 cover cropped into a landscape box without it crops to
   * the middle of the artwork, which on a manga cover is reliably the part with no face and no title.
   */
  imgClassName?: string;
  /**
   * One retry before the broken-image glyph.
   *
   * Discover serves external covers through a same-origin proxy, because a cross-origin `<img>` is flaky in
   * a standalone iOS PWA -- but the proxy can 502 where the origin is fine. Without a second chance every
   * such cover is a grey box, which is why that page had four raw `<img onError>` blocks instead of using
   * this component at all.
   */
  fallbackSrc?: string;
  eager?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [fellBack, setFellBack] = useState(false);
  const error = failed || !src; // no src at all is the same broken tile as a src that 404s
  const shown = fellBack && fallbackSrc ? fallbackSrc : src;
  const setError = () => {
    if (fallbackSrc && !fellBack && fallbackSrc !== src) { setFellBack(true); return; }
    setFailed(true);
  };
  // `relative` is only applied when the caller has not chosen a position of their own.
  //
  // Tailwind emits `.absolute` BEFORE `.relative`, and CSS resolves by stylesheet order, not by the order
  // of names in a class attribute. So `<Img className="absolute inset-0 h-full w-full">` silently stayed
  // relative, `h-full` had no definite parent height to resolve against, and the wrapper grew to the
  // image's natural size: a 112px card rendered 620px tall with its own content pushed out of sight. It
  // looks like a layout mistake in the caller and is not one.
  const positioned = /(^|\s)(absolute|fixed|sticky|static)(\s|$)/.test(className);
  return (
    <div className={`${positioned ? '' : 'relative'} overflow-hidden bg-ink-800 ${className}`}>
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
          src={shown}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={setError}
          className={`h-full w-full object-cover ${imgClassName} transition-all duration-700 ease-out ${loaded ? 'scale-100 opacity-100 blur-none' : 'scale-105 opacity-0 blur-md'}`}
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
