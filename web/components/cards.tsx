'use client';
import Link from 'next/link';
import { useCallback, useMemo, useRef, useState } from 'react';
import { img } from '@/lib/api';
import { Book, Series } from '@/lib/types';
import { chapterLabel, progressOf, relativeTime } from '@/lib/format';
import { deviceId } from '@/lib/device';
import { coverTriplet } from '@/lib/theme';
import { Img, ProgressBar } from './ui';
import { IcHeart, IcPlay, IcPlus, IcWifiOff } from './icons';
import { SourceIcon } from './SourcePicker';
import { useOfflineSeries } from '@/lib/useOfflineSeries';
import { t as tr } from '@/lib/i18n';

/** Pointer-tracked 3D tilt + moving glare for cover cards. Desktop-only (hover+fine pointer),
 *  disabled under prefers-reduced-motion; on touch the handlers never fire so nothing changes. */
function useTilt() {
  const [style, setStyle] = useState<React.CSSProperties | undefined>();
  const [glare, setGlare] = useState<React.CSSProperties>({ opacity: 0 });
  const ok = useRef<boolean | null>(null);
  const enabled = () => {
    if (ok.current === null)
      ok.current = typeof window !== 'undefined' &&
        window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
        !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return ok.current;
  };
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!enabled()) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;   // -0.5 .. 0.5
    const py = (e.clientY - r.top) / r.height - 0.5;
    setStyle({
      transform: `perspective(700px) rotateX(${(-py * 8).toFixed(2)}deg) rotateY(${(px * 10).toFixed(2)}deg) translateY(-6px) scale(1.03)`,
      transition: 'transform 120ms ease-out',
    });
    setGlare({
      opacity: 1,
      background: `radial-gradient(220px circle at ${((px + 0.5) * 100).toFixed(1)}% ${((py + 0.5) * 100).toFixed(1)}%, rgba(255,255,255,0.18), transparent 60%)`,
    });
  }, []);
  const onPointerLeave = useCallback(() => {
    setStyle({ transform: 'perspective(700px) rotateX(0deg) rotateY(0deg)', transition: 'transform 320ms ease' });
    setGlare({ opacity: 0, transition: 'opacity 320ms ease' });
  }, []);
  return { style, glare, onPointerMove, onPointerLeave };
}


/**
 * The cover's own dominant colour, as an "r g b" triplet on a `--tile` custom property.
 *
 * `glow` and `.grad-border` were taught to read `rgb(var(--tile, var(--accent)) / …)`, so setting this one
 * property tints a card's rim and hover shadow with its own artwork -- and every surface that does not set
 * it stays pixel-identical, because the fallback is the accent those tokens always used.
 *
 * A custom property declared ON THE ELEMENT is resolved per element at style time, which is why this can be
 * done for a grid of two hundred tiles with no JavaScript running on hover. Writing to `documentElement`
 * per pointerenter -- the obvious alternative -- restyles the whole document each time.
 */
function useTileTint(color?: string | null): React.CSSProperties {
  return useMemo(() => {
    const t = coverTriplet(color);
    return t ? ({ ['--tile' as string]: t } as React.CSSProperties) : {};
  }, [color]);
}

/** Portrait series cover -> series detail.
 *
 *  `eager` skips lazy-loading for tiles that are on screen at first paint. A lazy <img> waits for layout
 *  before the browser will even queue the request, so on the first rail it is pure added latency. */
export function SeriesCard({ series, w = 'w-32', eager = false }: { series: Series; w?: string; eager?: boolean }) {
  // yomi.unread first: it is computed per user in lib/enrich.ts. booksUnreadCount is now corrected there too,
  // but a rail added later that forgets to enrich would fall back to seriesDto's placeholder -- which is the
  // total chapter count -- so the badge would claim every chapter is unread. Preferring the enriched field
  // means such a rail shows no badge rather than a wrong one.
  const unread = series.yomi?.unread ?? series.booksUnreadCount ?? 0;
  const savedOffline = useOfflineSeries().has(series.id);
  const tilt = useTilt();
  const tint = useTileTint(series.color);
  return (
    <Link href={`/series/?id=${series.id}`} className={`group shrink-0 ${w} [scroll-snap-align:start]`}>
      <div
        onPointerMove={tilt.onPointerMove}
        onPointerLeave={tilt.onPointerLeave}
        style={{ ...tilt.style, ...tint }}
        className="grad-border relative aspect-[2/3] overflow-hidden rounded-2xl border border-ink-700/60 shadow-lift transition-all duration-300 group-hover:-translate-y-1.5 group-hover:shadow-glow group-active:scale-[0.97]"
      >
        <Img src={img.seriesThumb(series.id)} alt={series.metadata?.title || series.name} eager={eager} className="h-full w-full transition-transform duration-500 group-hover:scale-[1.07]" />
        <div aria-hidden className="pointer-events-none absolute inset-0 z-10" style={tilt.glare} />
        {series.yomi?.favorite && (
          <span className="absolute left-2 top-2 z-10 rounded-full bg-black/55 p-1.5 text-accent backdrop-blur">
            <IcHeart width={14} height={14} fill="currentColor" stroke="none" />
          </span>
        )}
        {unread > 0 && (
          <span className="absolute right-2 top-2 z-10 rounded-full bg-accent px-2 py-0.5 text-[11px] font-bold text-black shadow-glow">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
        {/* Bottom-right: NEW owns bottom-left, the unread count owns top-right, favourite owns top-left. */}
        {savedOffline && (
          <span title={tr('Saved for offline')} aria-label={tr('Saved for offline')}
            className="absolute bottom-1.5 right-1.5 z-10 rounded-full bg-black/60 p-1 text-fog-200 backdrop-blur">
            <IcWifiOff width={11} height={11} />
          </span>
        )}
        {(series.yomi?.newCount ?? 0) > 0 && (
          <span className="absolute bottom-2 left-2 z-10 rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold tracking-wide text-black shadow-glow">NEW</span>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-black/85 to-transparent" />
      </div>
      <p className="mt-2 line-clamp-2 px-0.5 text-[13px] font-medium leading-tight text-fog-200 transition group-hover:text-fog-50">
        {series.metadata?.title || series.name}
      </p>
    </Link>
  );
}

/** Wide "continue reading" card for an on-deck book. */
export function ContinueCard({ book, eager = false }: { book: Book; eager?: boolean }) {
  const pct = progressOf(book);
  // Progress already syncs across devices; this just says where you left off, and only when that was
  // somewhere else — "you were reading this on the device you're holding" is noise.
  const elsewhere = book.lastDevice && book.lastDevice.id !== deviceId() ? book.lastDevice : null;
  return (
    <Link
      href={`/reader/?book=${book.id}`}
      className="group relative h-44 w-72 shrink-0 overflow-hidden rounded-3xl border border-ink-700/60 shadow-lift transition-all duration-300 hover:-translate-y-1 hover:shadow-glow [scroll-snap-align:start]"
    >
      <Img src={img.bookThumb(book.id)} alt={book.seriesTitle} eager={eager} className="absolute inset-0 h-full w-full transition-transform duration-500 group-hover:scale-105" />
      <div className="absolute inset-0 bg-linear-to-t from-black via-black/45 to-black/10" />
      <div className="absolute inset-x-0 bottom-0 p-4">
        <p className="line-clamp-1 font-display text-base font-semibold text-white">{book.seriesTitle}</p>
        <p className="mb-2 text-xs text-fog-300">
          {chapterLabel(book)}
          {elsewhere && (
            <span className="text-fog-500"> · on {elsewhere.name || 'another device'}{elsewhere.at ? ` ${relativeTime(elsewhere.at)}` : ''}</span>
          )}
        </p>
        <ProgressBar value={pct || 0.02} />
      </div>
      <span className="absolute right-3 top-3 grid h-10 w-10 place-items-center rounded-full bg-accent text-black shadow-glow transition group-hover:scale-110 group-active:scale-90">
        <IcPlay width={18} height={18} />
      </span>
    </Link>
  );
}

/** Grid tile (library / search). */
export function SeriesTile({ series, eager = false, selectable, selected, onToggle }: {
  series: Series; eager?: boolean;
  /** select mode: the tile stops navigating and toggles instead */
  selectable?: boolean; selected?: boolean; onToggle?: () => void;
}) {
  // yomi.unread first: it is computed per user in lib/enrich.ts. booksUnreadCount is now corrected there too,
  // but a rail added later that forgets to enrich would fall back to seriesDto's placeholder -- which is the
  // total chapter count -- so the badge would claim every chapter is unread. Preferring the enriched field
  // means such a rail shows no badge rather than a wrong one.
  const unread = series.yomi?.unread ?? series.booksUnreadCount ?? 0;
  const savedOffline = useOfflineSeries().has(series.id);
  const tint = useTileTint(series.color);
  const Wrap: any = selectable ? 'button' : Link;
  const wrapProps = selectable
    ? { type: 'button', onClick: onToggle, className: 'group w-full text-left' }
    : { href: `/series/?id=${series.id}`, className: 'group' };
  return (
    <Wrap {...wrapProps}>
      <div style={tint} className="grad-border relative aspect-[2/3] overflow-hidden rounded-2xl border border-ink-700/60 transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-glow group-active:scale-[0.97]">
        <Img src={img.seriesThumb(series.id)} alt={series.metadata?.title || series.name} eager={eager} className="h-full w-full transition-transform duration-500 group-hover:scale-[1.07]" />
        {selectable && (
          <>
            {selected && <span className="absolute inset-0 z-10 rounded-2xl border-2 border-accent bg-accent/20" />}
            <span className={`absolute left-1.5 top-1.5 z-20 grid h-6 w-6 place-items-center rounded-full border text-[11px] font-bold ${
              selected ? 'border-accent bg-accent text-black' : 'border-white/50 bg-black/50 text-transparent'}`}>✓</span>
          </>
        )}
        {series.yomi?.favorite && (
          <span className="absolute left-1.5 top-1.5 z-10 rounded-full bg-black/55 p-1 text-accent backdrop-blur">
            <IcHeart width={12} height={12} fill="currentColor" stroke="none" />
          </span>
        )}
        {/* Bottom-right: NEW owns bottom-left, the unread count owns top-right, favourite owns top-left. */}
        {savedOffline && (
          <span title={tr('Saved for offline')} aria-label={tr('Saved for offline')}
            className="absolute bottom-1.5 right-1.5 z-10 rounded-full bg-black/60 p-1 text-fog-200 backdrop-blur">
            <IcWifiOff width={11} height={11} />
          </span>
        )}
        {unread > 0 && (
          <span className="absolute right-1.5 top-1.5 z-10 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-bold text-black">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
        {(series.yomi?.newCount ?? 0) > 0 && (
          <span className="absolute bottom-1.5 left-1.5 z-10 rounded-full bg-accent px-1.5 py-0.5 text-[9px] font-bold text-black">NEW</span>
        )}
      </div>
      <p className="mt-1.5 line-clamp-2 text-xs font-medium leading-tight text-fog-300 transition group-hover:text-fog-100">
        {series.metadata?.title || series.name}
      </p>
    </Wrap>
  );
}

/**
 * A cover from an external source, through this server.
 *
 * Same-origin on purpose: a cross-origin `<img>` is unreliable in a standalone iOS PWA, which is the app's
 * primary target. `Img`'s `fallbackSrc` carries the direct URL for the case where the proxy itself fails.
 */
/**
 * ⚠️ `v=2` is a cache buster, and it is not decoration.
 *
 * Until v0.26.2 a cover the server could not fetch was answered with a grey placeholder at HTTP 200 and
 * `Cache-Control: immutable, max-age=31536000`. Every browser and service worker that saw one is holding it
 * for a YEAR, keyed by this URL. Fixing the server cannot reach those copies; only a different URL can.
 * Bump this token again if a future change ever needs to invalidate covers client-side.
 */
export const sourceCover = (source: string | undefined, u?: string | null, w?: 800 | 1600) =>
  (u
    ? `/img/sources/cover?${source ? `source=${encodeURIComponent(source)}&` : ''}u=${encodeURIComponent(u)}${w ? `&w=${w}` : ''}&v=2`
    : '');

/** One row from a source: a `latest` item, or a grouped search hit with several providers behind it. */
export interface SourceItem {
  source: string;
  sourceId: string;
  title: string;
  coverUrl?: string;
  updatedAt?: string;
  inLibrary?: boolean;
  /** >1 when the same title was found on several sources. */
  providerCount?: number;
}

/**
 * A series you do not own yet, on a wall of things you could.
 *
 * The whole card is the button. It used to be a plain `<div>` with an `opacity-0 group-hover:opacity-100`
 * strip as the only add affordance, which on a touch device is not a subtle problem: there is no hover, so
 * the primary action of the page was invisible AND unreachable, and tapping the cover did nothing at all.
 *
 * Chrome is `SeriesTile`'s, deliberately, so the things you own and the things you could own read as one
 * system rather than as two grids that happen to be adjacent.
 */
export function SourceCard({ item, sourceName, onAdd, eager }: {
  item: SourceItem;
  /**
   * Shown as the source's favicon in a corner box, because a wall merged from several sources otherwise
   * hides where a title came from. The name itself is the hover title only: as a text chip it was the
   * loudest thing on the wall -- a dozen "MangaDex" labels over artwork -- and the add dialog names the
   * source in words before anything is fetched.
   */
  sourceName?: string;
  onAdd: () => void;
  eager?: boolean;
}) {
  const owned = !!item.inLibrary;
  return (
    <button
      type="button"
      onClick={onAdd}
      disabled={owned}
      aria-label={owned ? item.title : tr('Add to library')}
      className="group block w-full text-start disabled:cursor-default"
    >
      <div className={`grad-border relative aspect-[2/3] overflow-hidden rounded-2xl border border-ink-700/60 transition-all duration-300
                       ${owned ? 'opacity-55' : 'group-hover:-translate-y-1 group-hover:shadow-glow group-active:scale-[0.97]'}`}>
        <Img src={sourceCover(item.source, item.coverUrl)} alt={item.title} eager={eager}
          fallbackSrc={item.coverUrl || undefined}
          className="h-full w-full" imgClassName="transition-transform duration-500 group-hover:scale-[1.07]" />

        {sourceName && (
          <span title={sourceName} className="absolute end-1.5 top-1.5 z-10 grid place-items-center rounded-md bg-ink-950/80 p-1 backdrop-blur">
            <SourceIcon id={item.source} name={sourceName} size={16} />
          </span>
        )}
        {/* A bare "3" in a corner said nothing; the word makes it the fact it is: the same title on three
            sources, and the add dialog will offer the choice. */}
        {(item.providerCount ?? 0) > 1 && !owned && (
          <span className="absolute start-1.5 top-1.5 z-10 rounded-md bg-ink-950/80 px-1.5 py-0.5 text-[10px] font-semibold text-accent backdrop-blur">
            {tr('{n} sources', { n: item.providerCount ?? 0 })}
          </span>
        )}

        {owned ? (
          // Accent, not emerald: emerald is a health colour everywhere else in this app, and a large solid
          // fill of it over artwork reads as a system status chip pasted onto a cover.
          <span className="absolute inset-x-0 bottom-0 z-10 bg-accent/85 py-1.5 text-center text-[11px] font-semibold text-black backdrop-blur">
            {tr('In library')}
          </span>
        ) : (
          // Always visible. Not a hover reveal.
          <span aria-hidden className="absolute bottom-1.5 end-1.5 z-10 grid size-7 place-items-center rounded-full bg-accent text-black shadow-glow transition group-hover:scale-110">
            <IcPlus width={15} height={15} />
          </span>
        )}
      </div>
      <p className="mt-1.5 line-clamp-2 text-xs font-medium leading-tight text-fog-300 transition group-hover:text-fog-100">
        {item.title}
      </p>
    </button>
  );
}
