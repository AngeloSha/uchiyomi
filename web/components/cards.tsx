'use client';
import Link from 'next/link';
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { img } from '@/lib/api';
import { Book, Series } from '@/lib/types';
import { chapterLabel, languageName, numberText, progressOf, relativeTime } from '@/lib/format';
import { codeLabel, libraryCaption } from '@/lib/editions';
import { deviceId, shownDeviceName } from '@/lib/device';
import { coverTriplet } from '@/lib/theme';
import { CARD_W, Img } from './ui';
import { IcHeart, IcMore, IcPlay, IcPlus, IcStar, IcUsers, IcWifiOff } from './icons';
import { SourceIcon } from './SourcePicker';
import { ProgressRing } from './ProgressRing';
import { iconStack, type StackSource } from '@/lib/sourceGroups';
import { useOfflineSeries } from '@/lib/useOfflineSeries';
import { effectsReduced, useReduceEffects } from '@/lib/effects';
import { t as tr } from '@/lib/i18n';
import { useSeriesMenu } from './SeriesMenu';
import { publicCoverFallback } from '@/lib/coverFallback';
import { anilistNumbers, type SortValue } from '@/lib/sortValue';
import { coverProgress, seriesProgress } from '@/lib/seriesProgress';

/**
 * The unread count on a series' tag (v0.61.2, #202): the whole number, grouped the way the reader's language groups
 * digits ("1,150"). It stopped at "99+", which in a library of long series said the same thing on nearly every cover.
 * The tooltip says what it counts, because a bare number on a cover reads as the chapter total (that is how #202 read
 * it). The direction stays on the TEXT, as before: a grouped number is one left-to-right run in Arabic too.
 * Reintroduce the cap: "the unread tag says the whole count" in v600Library.test.ts reads "99+".
 */
function UnreadCount({ n }: { n: number }) {
  const label = tr('{n} unread', { n: numberText(n) });
  return <span dir="ltr" data-unread={n} className="tabular-nums" title={label} aria-label={label}>{numberText(n)}</span>;
}

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
    // Reduce effects is read on every move, not cached with the media queries above: it can be switched on
    // while the page is open, and a tilt that kept going until the next reload would be the switch lying.
    if (!enabled() || effectsReduced()) return;
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

/**
 * One quiet line under a card's title (v0.58.0): the value its shelf is sorted by (lib/sortValue.ts), or a rail's own
 * fact as plain words. Nothing when empty.
 */
export type CardNote = SortValue | string | null | undefined;

const noteOf = (note: CardNote): { kind?: SortValue['kind']; text: string; hint: string } | null =>
  !note ? null : typeof note === 'string' ? { text: note, hint: note } : note;

/**
 * The line itself, right after the title's paragraph: a small star before AniList's score ("★ 84"), the people icon
 * before its popularity ("312K readers") -- v0.60.0, where the words "on AniList" were spelled under every title. The
 * long form is the line's hover, and the star names the score to a screen reader. In the interface's direction, not the
 * title's `auto`: it is the app's sentence about the series.
 */
function NoteLine({ note, attr, className }: { note: CardNote; attr: 'data-sort-value' | 'data-card-note'; className: string }) {
  const v = noteOf(note);
  if (!v) return null;
  return (
    <p {...({ [attr]: v.kind ?? 'true' } as Record<string, string>)} title={v.hint !== v.text ? v.hint : undefined} className={className}>
      {v.kind === 'score' && (
        <IcStar role="img" aria-label={tr('AniList score')} width={11} height={11} fill="currentColor" strokeWidth={1.2} className="shrink-0 text-fog-400" />
      )}
      {v.kind === 'popularity' && <IcUsers aria-hidden width={12} height={12} className="shrink-0 text-fog-400" />}
      <span className="min-w-0 truncate">{v.text}</span>
    </p>
  );
}

/**
 * How far the reader is through the series (v0.60.0): 3 px along the cover's bottom edge from its start, once a chapter
 * is read, and the whole edge in the accent once every one is -- `booksReadCount / booksCount`, which every card was
 * handed and none showed. Over the artwork, under the badges.
 */
function CoverReadBar({ series }: { series: Series }) {
  const p = coverProgress(series);
  if (!p) return null;
  return (
    <span aria-hidden data-read-progress={p.finished ? 'done' : String(Math.round(p.fraction * 100))}
      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[3px] bg-black/55">
      <span className={`block h-full ${p.finished ? 'bg-accent' : 'bg-fog-100/90'}`}
        style={{ width: p.finished ? '100%' : `${Math.max(3, p.fraction * 100).toFixed(1)}%` }} />
    </span>
  );
}

/**
 * The card's ⋯ (v0.60.0): its right-click menu (components/SeriesMenu.tsx) for a mouse, which has no long-press and whose
 * right-click not everyone thinks of. From lg up with a fine pointer only -- a landscape tablet is lg wide with no hover
 * (lib/compactChapters.ts) -- shown on hover or keyboard focus, and kept while its menu is open. A sibling of the card's
 * link, never inside it: a button in a link is two targets in one. `className` places it and shows it (`grid`); the tiles
 * hand it a box the size of the cover that moves as the cover does.
 */
function MoreKey({ menu, title, className }: { menu: ReturnType<typeof useSeriesMenu>; title: string; className: string }) {
  // The fade is new, so it goes under Reduce effects; reduced motion shortens it to nothing in app/globals.css.
  const plain = useReduceEffects();
  return (
    <button type="button" data-card-more onClick={(e) => menu.openFrom(e.currentTarget)}
      aria-label={tr('Actions for {title}', { title })} aria-haspopup="menu" aria-expanded={menu.open}
      className={`pointer-events-auto z-20 size-7 place-items-center rounded-lg border border-white/10 bg-black/65 text-fog-100 backdrop-blur hover:bg-black/85 focus-visible:opacity-100 ${
        menu.open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} ${plain ? '' : 'transition-opacity duration-150'} ${className}`}>
      <IcMore width={15} height={15} />
    </button>
  );
}

/** Portrait series cover -> series detail.
 *
 *  `eager` skips lazy-loading for tiles that are on screen at first paint. A lazy <img> waits for layout
 *  before the browser will even queue the request, so on the first rail it is pure added latency. */
export function SeriesCard({ series, w = CARD_W, eager = false, note }: {
  series: Series; w?: string; eager?: boolean;
  /** One quiet line under the title, a rail's own fact about the series: Home's most popular says AniList's score. */
  note?: CardNote;
}) {
  // yomi.unread first: it is computed per user in lib/enrich.ts. booksUnreadCount is now corrected there too,
  // but a rail added later that forgets to enrich would fall back to seriesDto's placeholder -- which is the
  // total chapter count -- so the badge would claim every chapter is unread. Preferring the enriched field
  // means such a rail shows no badge rather than a wrong one.
  const unread = series.yomi?.unread ?? series.booksUnreadCount ?? 0;
  const savedOffline = useOfflineSeries().has(series.id);
  const tilt = useTilt();
  const tint = useTileTint(series.color);
  // Right-click, press-and-hold or Shift+F10 (#100, components/SeriesMenu.tsx), and the ⋯ on a computer (v0.60.0).
  const menu = useSeriesMenu(series);
  const title = series.metadata?.title || series.name;
  return (
    <div className={`group relative shrink-0 ${w} [scroll-snap-align:start]`}>
    <Link href={`/series/?id=${series.id}`} className="block" {...menu.bind}>
      <div
        onPointerMove={tilt.onPointerMove}
        onPointerLeave={tilt.onPointerLeave}
        style={{ ...tilt.style, ...tint }}
        className="grad-border relative aspect-[2/3] overflow-hidden rounded-2xl border border-ink-700/60 shadow-lift transition-all duration-300 group-hover:-translate-y-1.5 group-hover:shadow-glow group-active:scale-[0.97]"
      >
        <Img src={img.seriesThumb(series.id)} alt={title} eager={eager} className="h-full w-full transition-transform duration-500 group-hover:scale-[1.07]" />
        <div aria-hidden className="pointer-events-none absolute inset-0 z-10" style={tilt.glare} />
        {series.yomi?.favorite && (
          <span className="absolute start-2 top-2 z-10 rounded-full bg-black/55 p-1.5 text-accent backdrop-blur">
            <IcHeart width={14} height={14} fill="currentColor" stroke="none" />
          </span>
        )}
        {/* dir="ltr" (UnreadCount): "99+" was a number and a sign, and in Arabic the paragraph's direction put the sign
            first ("+99"); a grouped count is one run too. Squared (v0.60.0), as every count tag in the app is since "no more pills". ⚠️ The direction on the TEXT, never
            on the positioned box: a box's own direction decides which side `end` is, and an ltr box sat top-right in an
            Arabic page (discoverSearch.test.ts says the same of Discover's 18+ mark). */}
        {unread > 0 && (
          <span className="absolute end-2 top-2 z-10 rounded-[4px] bg-accent px-2 py-0.5 text-[11px] font-bold text-black shadow-glow">
            <UnreadCount n={unread} />
          </span>
        )}
        {/* Bottom-end: NEW owns bottom-start, the unread count owns top-end, favourite owns top-start -- logical sides, so
            they mirror in Arabic as Discover's cards do. */}
        {savedOffline && (
          <span title={tr('Saved for offline')} aria-label={tr('Saved for offline')}
            className="absolute bottom-1.5 end-1.5 z-10 rounded-full bg-black/60 p-1 text-fog-200 backdrop-blur">
            <IcWifiOff width={11} height={11} />
          </span>
        )}
        {(series.yomi?.newCount ?? 0) > 0 && (
          <span className="absolute bottom-2 start-2 z-10 rounded-[4px] bg-accent px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-black shadow-glow rtl:tracking-normal">{tr('New')}</span>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-black/85 to-transparent" />
        <CoverReadBar series={series} />
      </div>
      <p className="mt-2 line-clamp-2 px-0.5 text-[13px] font-medium leading-tight text-fog-200 transition group-hover:text-fog-50">
        {title}
      </p>
      <NoteLine note={note} attr="data-card-note" className="mt-0.5 flex min-w-0 items-center gap-1 px-0.5 text-[11px] leading-tight text-fog-500 tabular-nums" />
    </Link>
    {/* The cover's box, lifted and tilted with it, so the ⋯ stays on its corner. */}
    <div style={{ transform: tilt.style?.transform, transition: tilt.style?.transition }}
      className="pointer-events-none absolute inset-x-0 top-0 hidden aspect-[2/3] transition-all duration-300 group-hover:-translate-y-1.5 lg:pointer-fine:block">
      <MoreKey menu={menu} title={title} className="absolute bottom-2 end-1.5 grid" />
    </div>
    {menu.element}
    </div>
  );
}

/** Wide "continue reading" card for an on-deck book. */
/**
 * A chapter to go on with: Keep reading's card, and Pick back up's (v0.61.0), whose `note` says when the reading stopped
 * ("Read 3 months ago") where Keep reading names the other device it was on.
 */
export function ContinueCard({ book, eager = false, note }: { book: Book; eager?: boolean; note?: string }) {
  const pct = progressOf(book);
  // Where in the chapter, said as well as drawn (UI refresh): "page 12/40" beside the chapter, the bar along the edge.
  const pages = book.media?.pagesCount || 0;
  const page = book.readProgress && !book.readProgress.completed ? book.readProgress.page : 0;
  // Progress already syncs across devices; this just says where you left off, and only when that was
  // somewhere else — "you were reading this on the device you're holding" is noise.
  const elsewhere = book.lastDevice && book.lastDevice.id !== deviceId() ? book.lastDevice : null;
  // A platform ("iPhone"), or "another device" in the reader's words -- never the English "Browser" an older sign-in
  // stored for a platform it did not know, nor a sign-in method ("SSO") as if it were a place.
  const where = elsewhere ? shownDeviceName(elsewhere.name, { device: true }) || tr('another device') : '';
  return (
    <Link
      href={`/reader/?book=${book.id}`}
      className="group relative h-44 w-72 shrink-0 overflow-hidden rounded-3xl border border-ink-700/60 shadow-lift transition-all duration-300 hover:-translate-y-1 hover:shadow-glow [scroll-snap-align:start]"
    >
      <Img src={img.bookThumb(book.id)} alt={book.seriesTitle} eager={eager} className="absolute inset-0 h-full w-full transition-transform duration-500 group-hover:scale-105" />
      <div className="absolute inset-0 bg-linear-to-t from-black via-black/45 to-black/10" />
      <div className="absolute inset-x-0 bottom-0 p-4">
        <p className="line-clamp-1 font-display text-base font-semibold text-white">{book.seriesTitle}</p>
        <p className="text-xs text-fog-300">
          {chapterLabel(book)}
          {page > 0 && pages > 0 && <span className="tabular-nums text-fog-400" data-continue-page> · {tr('page {page}/{pages}', { page, pages })}</span>}
          {note && <span className="text-fog-500" data-continue-note> · {note}</span>}
          {!note && elsewhere && (
            // One sentence per language: relativeTime is the reader's language now, and "on iPhone vor 3 Tagen"
            // was English words around a German phrase.
            <span className="text-fog-500"> · {elsewhere.at
              ? tr('on {device} {when}', { device: where, when: relativeTime(elsewhere.at) })
              : tr('on {device}', { device: where })}</span>
          )}
        </p>
      </div>
      {/* Flush along the bottom edge, as the covers' read bar (CoverReadBar): how far into the chapter. */}
      <span aria-hidden data-continue-progress className="absolute inset-x-0 bottom-0 h-[3px] bg-white/15">
        <span className="block h-full bg-accent" style={{ width: `${Math.max(2, Math.round((pct || 0) * 100))}%` }} />
      </span>
      <span className="absolute end-3 top-3 grid h-10 w-10 place-items-center rounded-full bg-accent text-black shadow-glow transition group-hover:scale-110 group-active:scale-90">
        <IcPlay width={18} height={18} />
      </span>
    </Link>
  );
}

/** The work's languages under a Library card (v0.52.0, #72): `EN · ES-419`, the edition this card opens brighter. */
function EditionLangs({ series, className }: { series: Series; className: string }) {
  return (
    <>
      {!!series.edition?.langs && series.edition.langs.length > 1 && (
        <p data-edition-langs className={className} title={series.edition.langs.map(languageName).join(' · ')}>
          {libraryCaption(series.edition.langs, series.lang).map((c, i) => (
            <span key={c.lang}>
              {i > 0 && <span aria-hidden> · </span>}
              <span className={c.current ? 'text-fog-300' : ''}>{c.label}</span>
            </span>
          ))}
        </p>
      )}
    </>
  );
}

/** Grid tile (library / search). */
/** Shift with a press would extend the page's text selection across the grid; in select mode Shift picks a range. */
const noShiftSelect = (e: React.MouseEvent) => { if (e.shiftKey) e.preventDefault(); };

export function SeriesTile({ series, eager = false, selectable, selected, onToggle, note, compact = false }: {
  series: Series; eager?: boolean;
  /** select mode: the tile stops navigating and toggles instead; the click is passed on for Shift (lib/libraryPick.ts) */
  selectable?: boolean; selected?: boolean; onToggle?: (e: React.MouseEvent) => void;
  /**
   * One quiet line under the title (v0.58.0): in the Library, the value the shelf is sorted by -- "★ 84", "312K readers",
   * "★ 4/5", "Read 3d ago" (lib/sortValue.ts). Nothing when empty.
   */
  note?: CardNote;
  /** The Library's Compact layout (v0.60.0): one-line titles and smaller badges, so more fit across. */
  compact?: boolean;
}) {
  // yomi.unread first: it is computed per user in lib/enrich.ts. booksUnreadCount is now corrected there too,
  // but a rail added later that forgets to enrich would fall back to seriesDto's placeholder -- which is the
  // total chapter count -- so the badge would claim every chapter is unread. Preferring the enriched field
  // means such a rail shows no badge rather than a wrong one.
  const unread = series.yomi?.unread ?? series.booksUnreadCount ?? 0;
  const savedOffline = useOfflineSeries().has(series.id);
  const tint = useTileTint(series.color);
  // The card's tilt and glare (UI refresh: a Library tile reacts like a Home card), never in Select mode, where a
  // press toggles the tile and nothing should move under it.
  const tilt = useTilt();
  const tilts = !selectable;
  // Not in Select mode: there a press toggles the tile, and the Library's own bar holds the actions (#100).
  const menu = useSeriesMenu(series);
  const title = series.metadata?.title || series.name;
  const corner = compact ? 'rounded-xl' : 'rounded-2xl';
  const body = (
    <>
      <div style={{ ...(tilts ? tilt.style : undefined), ...tint }}
        onPointerMove={tilts ? tilt.onPointerMove : undefined} onPointerLeave={tilts ? tilt.onPointerLeave : undefined}
        className={`grad-border relative aspect-[2/3] overflow-hidden ${corner} border border-ink-700/60 transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-glow group-active:scale-[0.97]`}>
        <Img src={img.seriesThumb(series.id)} alt={title} eager={eager} className="h-full w-full transition-transform duration-500 group-hover:scale-[1.07]" />
        {tilts && <div aria-hidden className="pointer-events-none absolute inset-0 z-10" style={tilt.glare} />}
        {selectable && (
          <>
            {selected && <span className={`absolute inset-0 z-10 ${corner} border-2 border-accent bg-accent/20`} />}
            <span className={`absolute start-1.5 top-1.5 z-20 grid h-6 w-6 place-items-center rounded-full border text-[11px] font-bold ${
              selected ? 'border-accent bg-accent text-black' : 'border-white/50 bg-black/50 text-transparent'}`}>✓</span>
          </>
        )}
        {/* Top-start, under the select bubble in Select mode (v0.60.0): the bubble sat on the heart, and a favourite looked
            like any other series exactly while choosing which to Favourite. */}
        {series.yomi?.favorite && (
          <span className={`absolute start-1.5 ${selectable ? 'top-9' : 'top-1.5'} z-10 rounded-full bg-black/55 ${compact ? 'p-0.5' : 'p-1'} text-accent backdrop-blur`}>
            <IcHeart width={compact ? 10 : 12} height={compact ? 10 : 12} fill="currentColor" stroke="none" />
          </span>
        )}
        {/* Bottom-end: NEW owns bottom-start, the unread count owns top-end, favourite owns top-start -- logical sides, so
            they mirror in Arabic as Discover's cards do. */}
        {savedOffline && (
          <span title={tr('Saved for offline')} aria-label={tr('Saved for offline')}
            className="absolute bottom-1.5 end-1.5 z-10 rounded-full bg-black/60 p-1 text-fog-200 backdrop-blur">
            <IcWifiOff width={11} height={11} />
          </span>
        )}
        {/* dir="ltr" on the text (UnreadCount), as SeriesCard's: "99+" read "+99" in Arabic, and on the box it put the box top-right there.
            Squared, as SeriesCard's. */}
        {unread > 0 && (
          <span className={`absolute end-1.5 top-1.5 z-10 rounded-[4px] bg-accent font-bold text-black ${compact ? 'px-1 text-[9px]' : 'px-1.5 py-0.5 text-[10px]'}`}>
            <UnreadCount n={unread} />
          </span>
        )}
        {(series.yomi?.newCount ?? 0) > 0 && (
          <span className={`absolute bottom-1.5 start-1.5 z-10 rounded-[4px] bg-accent font-bold uppercase text-black ${compact ? 'px-1 text-[8px]' : 'px-1.5 py-0.5 text-[9px]'}`}>{tr('New')}</span>
        )}
        <CoverReadBar series={series} />
      </div>
      <p dir="auto" className={`${compact ? 'mt-1 truncate text-[11px]' : 'mt-1.5 line-clamp-2 text-xs'} font-medium leading-tight text-fog-300 transition group-hover:text-fog-100`}>
        {title}
      </p>
      <NoteLine note={note} attr="data-sort-value"
        className={`mt-0.5 flex min-w-0 items-center gap-1 ${compact ? 'text-[10px]' : 'text-[11px]'} leading-tight text-fog-500 tabular-nums`} />
      {/* The work's languages (v0.52.0, #72): the Library shows one card for every language edition the viewer may
          browse, and this line says so -- `EN · ES-419`, the edition this card opens brighter. The names are its
          title, for a hover and a screen reader. */}
      <EditionLangs series={series} className="mt-0.5 truncate text-[10px] font-semibold tracking-wide text-fog-600" />
    </>
  );
  if (selectable) {
    return <button type="button" onClick={onToggle} onMouseDown={noShiftSelect} aria-pressed={!!selected} className="group block w-full text-start">{body}</button>;
  }
  return (
    <div className="group relative">
      <Link href={`/series/?id=${series.id}`} className="block" {...menu.bind}>{body}</Link>
      {/* The cover's box, lifted and tilted with it, so the ⋯ stays on its corner. */}
      <div style={{ transform: tilt.style?.transform, transition: tilt.style?.transition }}
        className="pointer-events-none absolute inset-x-0 top-0 hidden aspect-[2/3] transition-all duration-300 group-hover:-translate-y-1 lg:pointer-fine:block">
        <MoreKey menu={menu} title={title} className="absolute bottom-2 end-1.5 grid" />
      </div>
      {menu.element}
    </div>
  );
}

/**
 * A series as a row (v0.60.0, the Library's List layout): a small cover, the title with its languages, the value the
 * shelf is sorted by -- else when it was last read -- and how far in, written out ("41 / 201"), with AniList's score and
 * the unread count at the end. The same link, Select toggle and menu as the tile.
 */
export function SeriesRow({ series, eager = false, selectable, selected, onToggle, note }: {
  series: Series; eager?: boolean;
  selectable?: boolean; selected?: boolean; onToggle?: (e: React.MouseEvent) => void;
  note?: CardNote;
}) {
  const unread = series.yomi?.unread ?? series.booksUnreadCount ?? 0;
  const savedOffline = useOfflineSeries().has(series.id);
  const tint = useTileTint(series.color);
  const menu = useSeriesMenu(series);
  const title = series.metadata?.title || series.name;
  const progress = seriesProgress(series);
  const sorted = noteOf(note);
  const lastRead = series.yomi?.lastReadAt;
  const readLine = !sorted && lastRead && Number.isFinite(Date.parse(lastRead)) ? tr('Read {when}', { when: relativeTime(lastRead) }) : '';
  const score = anilistNumbers(series.yomi?.anilist)?.score ?? null;
  const body = (
    <div className={`flex items-center gap-3 rounded-2xl border p-2 pe-3 transition-colors duration-200 lg:pointer-fine:pe-12 ${
      selected ? 'border-accent/70 bg-accent/10' : 'border-ink-800/80 bg-ink-900/40 group-hover:border-ink-700 group-hover:bg-ink-850/70'}`}>
      <div style={tint} className="grad-border relative h-[4.5rem] w-12 shrink-0 overflow-hidden rounded-lg border border-ink-700/60">
        <Img src={img.seriesThumb(series.id)} alt="" eager={eager} className="h-full w-full" />
        {selectable && (
          <span className={`absolute start-1 top-1 z-20 grid h-5 w-5 place-items-center rounded-full border text-[10px] font-bold ${
            selected ? 'border-accent bg-accent text-black' : 'border-white/50 bg-black/50 text-transparent'}`}>✓</span>
        )}
        {savedOffline && (
          <span title={tr('Saved for offline')} aria-label={tr('Saved for offline')}
            className="absolute bottom-1 end-1 z-10 rounded-full bg-black/60 p-0.5 text-fog-200">
            <IcWifiOff width={10} height={10} />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p dir="auto" className="truncate text-sm font-medium leading-snug text-fog-100">{title}</p>
        <EditionLangs series={series} className="truncate text-[10px] font-semibold tracking-wide text-fog-600" />
        {sorted
          ? <NoteLine note={note} attr="data-sort-value" className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] leading-tight text-fog-500 tabular-nums" />
          : readLine && <p data-row-read className="mt-0.5 truncate text-[11px] leading-tight text-fog-500">{readLine}</p>}
        {progress && (
          <div className="mt-1.5 flex items-center gap-2">
            <span aria-hidden className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-ink-700/80">
              <span className={`block h-full rounded-full ${progress.finished ? 'bg-accent' : 'bg-fog-300/80'}`}
                style={{ width: `${(progress.fraction * 100).toFixed(1)}%` }} />
            </span>
            {/* Two counts and a slash: the same in every language, and left to right in Arabic too. */}
            <span dir="ltr" data-row-progress className="shrink-0 text-[11px] tabular-nums text-fog-500">
              {numberText(progress.read)} / {numberText(progress.total)}
            </span>
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        {/* AniList's score, unless the line under the title already says it. */}
        {score !== null && sorted?.kind !== 'score' && (
          <span className="flex items-center gap-1 text-[11px] tabular-nums text-fog-400">
            <IcStar role="img" aria-label={tr('AniList score')} width={11} height={11} fill="currentColor" strokeWidth={1.2} className="shrink-0" />
            {numberText(score)}
          </span>
        )}
        <span className="flex items-center gap-1">
          {series.yomi?.favorite && <IcHeart aria-label={tr('Favourite')} role="img" width={12} height={12} fill="currentColor" stroke="none" className="text-accent" />}
          {(series.yomi?.newCount ?? 0) > 0 && (
            <span className="rounded-[4px] bg-accent px-1.5 py-0.5 text-[9px] font-bold uppercase text-black">{tr('New')}</span>
          )}
          {unread > 0 && (
            <span className="rounded-[4px] bg-accent px-1.5 py-0.5 text-[10px] font-bold text-black">
              <UnreadCount n={unread} />
            </span>
          )}
        </span>
      </div>
    </div>
  );
  if (selectable) {
    return <button type="button" onClick={onToggle} onMouseDown={noShiftSelect} aria-pressed={!!selected} className="group block w-full text-start">{body}</button>;
  }
  return (
    <div className="group relative">
      <Link href={`/series/?id=${series.id}`} className="block" {...menu.bind}>{body}</Link>
      <MoreKey menu={menu} title={title} className="absolute end-2.5 top-1/2 hidden -translate-y-1/2 lg:pointer-fine:grid" />
      {menu.element}
    </div>
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
  /** Held in this source's language (v0.52.0): owned. A title held only in another language is still addable. */
  inLibrary?: boolean;
  /** The library entry that title is, when the server knows it: an owned card opens it. */
  librarySeriesId?: string;
  /** The languages the library holds the title in (v0.52.0), when it holds it at all: the `EN in library` mark. */
  libraryLangs?: string[];
  /** The language the source declares, null when it says nothing (v0.52.0): the add dialog's language chip. */
  lang?: string | null;
  /** A search result known to be 18+ (v0.55.4, #158): the small "18+" mark on its cover. */
  rating?: 'adult' | 'safe';
  /**
   * Which work this is (v0.56.0): `lib:<seriesId>`, `al:` / `mu:` / `md:` an online service's id, or `n:<name>` while
   * the server has not placed the name. The wall folds by it (lib/wall.ts). Absent from an older server.
   */
  work?: string;
  /** The library holds this work in any language (v0.56.0): the wall does not show it; search does, with its marks. */
  owned?: boolean;
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
export function SourceCard({ item, providers, onAdd, eager }: {
  item: SourceItem;
  /**
   * Every place the card can be added from (v0.56.0), drawn as up to three overlapping favicons in a corner box and a
   * "+2" for the rest -- one per extension (`iconStack`), so MangaDex's languages are one icon. A wall merged from
   * several sources otherwise hides where a title came from, and the stack says it without a word over the artwork:
   * as a text chip a source's name was the loudest thing on the wall -- a dozen "MangaDex" labels over artwork -- and
   * so was the "3 sources" badge this replaced. The names are the box's tooltip, and the card's description to a
   * screen reader; the add dialog names each source in words before anything is fetched.
   */
  providers?: StackSource[];
  onAdd: () => void;
  eager?: boolean;
}) {
  const owned = !!item.inLibrary;
  const stack = providers?.length ? iconStack(providers) : null;
  const stackId = useId();
  // An owned title opens its entry in the library; adding it again would only say "already there".
  const rootCls = 'group block w-full text-start disabled:cursor-default';
  const body = (
    <>
      <div className={`grad-border relative aspect-[2/3] overflow-hidden rounded-2xl border border-ink-700/60 transition-all duration-300
                       ${owned ? 'opacity-55' : 'group-hover:-translate-y-1 group-hover:shadow-glow group-active:scale-[0.97]'}`}>
        <Img src={sourceCover(item.source, item.coverUrl)} alt={item.title} eager={eager}
          fallbackSrc={publicCoverFallback(item.coverUrl)}
          className="h-full w-full" imgClassName="transition-transform duration-500 group-hover:scale-[1.07]" />

        {/* The icons overlap the way the source chip's do (SourcePicker), each ringed in the box's own ground so the
            overlap reads. One box, one row: with "+2" it is about 60 px on a 110-px phone tile. The "+2" is isolated left to
            right like the 18+ mark below, or an Arabic line reads it "2+". */}
        {stack && (
          <span id={stackId} role="img" aria-label={stack.names} title={stack.names} data-source-stack={stack.icons.length + stack.more}
            className="absolute end-1.5 top-1.5 z-10 flex items-center gap-1 rounded-md bg-ink-950/80 p-1 backdrop-blur">
            <span className="inline-flex items-center">
              {stack.icons.map((s, i) => (
                <span key={s.id} className={`inline-flex ${i > 0 ? '-ms-1.5' : ''}`}>
                  <SourceIcon id={s.id} name={s.name} size={16} ring="ring-1 ring-ink-950" />
                </span>
              ))}
            </span>
            {stack.more > 0 && <bdi dir="ltr" className="pe-0.5 text-[10px] font-semibold tabular-nums text-fog-200">+{stack.more}</bdi>}
          </span>
        )}
        {/* Known to be 18+ (v0.55.4, #158): a search for one title answers with whatever the sources hold, and an 18+ one
            says so before it is opened. Below the source icons. The text is isolated left to right, so the "+" stays
            where the translation puts it in an Arabic line -- on the text, not on the box: the box's `end` would follow
            its own direction and land at the other corner, away from the icons it sits under. */}
        {item.rating === 'adult' && (
          <span data-rating-mark
            className={`absolute end-1.5 ${stack ? 'top-9' : 'top-1.5'} z-10 rounded-md bg-ink-950/80 px-1.5 py-0.5 text-[10px] font-semibold text-red-300 backdrop-blur`}>
            <bdi dir="ltr">{tr('18+')}</bdi>
          </span>
        )}

        {/* Held in another language (v0.52.0): the card stays addable -- a new edition -- and says which language is
            here, in the bottom-start corner, across from the add button. Codes, never names: "EN · ES" fits a 110-px
            tile. */}
        {!owned && !!item.libraryLangs?.length && (
          <span data-library-langs className="absolute bottom-1.5 start-1.5 z-10 max-w-[70%] truncate rounded-md bg-ink-950/80 px-1.5 py-0.5 text-[10px] font-semibold text-fog-200 backdrop-blur">
            {tr('{langs} in library', { langs: item.libraryLangs.map(codeLabel).join(' · ') })}
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
    </>
  );
  // The sources are the card's description: the name says what pressing it does, and a button's own content is not
  // read out (its children are presentational), so a role="img" inside it needs pointing at to be heard at all.
  const described = stack ? stackId : undefined;
  return owned && item.librarySeriesId
    ? <Link href={`/series/?id=${encodeURIComponent(item.librarySeriesId)}`} aria-label={item.title} aria-describedby={described} className={rootCls}>{body}</Link>
    : <button type="button" onClick={onAdd} disabled={owned} aria-label={owned ? item.title : tr('Add to library')} aria-describedby={described} className={rootCls}>{body}</button>;
}

/**
 * Discover's last tile while sources are still being asked (v0.58.0): which ones, so someone scrolling to the end of
 * Newest, Popular or a search sees that more is coming -- the wall asks every source now, and fills for longer. A
 * SourceCard's size (its 2:3 box; no title under it), dashed and quiet, with the progress ring turning, which stands
 * still under Reduce effects or reduced motion as it does everywhere. The first `shown` names, then "+N" for the rest,
 * isolated left to right as the source stack's "+2" is, or an Arabic line reads it "3+".
 */
export function StillLoadingCard({ names, shown = 3 }: { names: string[]; shown?: number }) {
  const head = names.slice(0, shown);
  const more = names.length - head.length;
  return (
    <div data-still-loading={names.length} className="w-full">
      <div className="flex aspect-[2/3] flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border border-dashed border-ink-700 bg-ink-900/40 px-2 text-center">
        <ProgressRing progress="spin" size={18} tone="muted" />
        <p className="text-[11px] font-medium text-fog-300">{tr('Still loading')}</p>
        <ul className="w-full space-y-0.5 text-[11px] leading-tight text-fog-500">
          {head.map((n, i) => <li key={`${i}:${n}`} dir="auto" className="truncate">{n}</li>)}
          {more > 0 && <li className="tabular-nums"><bdi dir="ltr">+{more}</bdi></li>}
        </ul>
      </div>
    </div>
  );
}
