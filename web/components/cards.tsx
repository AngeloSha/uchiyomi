'use client';
import Link from 'next/link';
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { img } from '@/lib/api';
import { Book, Series } from '@/lib/types';
import { chapterLabel, languageName, progressOf, relativeTime } from '@/lib/format';
import { codeLabel, libraryCaption } from '@/lib/editions';
import { deviceId, shownDeviceName } from '@/lib/device';
import { coverTriplet } from '@/lib/theme';
import { Img, ProgressBar } from './ui';
import { IcHeart, IcPlay, IcPlus, IcWifiOff } from './icons';
import { SourceIcon } from './SourcePicker';
import { ProgressRing } from './ProgressRing';
import { iconStack, type StackSource } from '@/lib/sourceGroups';
import { useOfflineSeries } from '@/lib/useOfflineSeries';
import { effectsReduced } from '@/lib/effects';
import { t as tr } from '@/lib/i18n';
import { useSeriesMenu } from './SeriesMenu';
import { publicCoverFallback } from '@/lib/coverFallback';

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

/** Portrait series cover -> series detail.
 *
 *  `eager` skips lazy-loading for tiles that are on screen at first paint. A lazy <img> waits for layout
 *  before the browser will even queue the request, so on the first rail it is pure added latency. */
export function SeriesCard({ series, w = 'w-32', eager = false, note }: {
  series: Series; w?: string; eager?: boolean;
  /** One quiet line under the title, a rail's own fact about the series: Home's most popular says AniList's score. */
  note?: string;
}) {
  // yomi.unread first: it is computed per user in lib/enrich.ts. booksUnreadCount is now corrected there too,
  // but a rail added later that forgets to enrich would fall back to seriesDto's placeholder -- which is the
  // total chapter count -- so the badge would claim every chapter is unread. Preferring the enriched field
  // means such a rail shows no badge rather than a wrong one.
  const unread = series.yomi?.unread ?? series.booksUnreadCount ?? 0;
  const savedOffline = useOfflineSeries().has(series.id);
  const tilt = useTilt();
  const tint = useTileTint(series.color);
  // Right-click, press-and-hold or Shift+F10 (#100, components/SeriesMenu.tsx).
  const menu = useSeriesMenu(series);
  return (
    <>
    <Link href={`/series/?id=${series.id}`} className={`group shrink-0 ${w} [scroll-snap-align:start]`} {...menu.bind}>
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
        {/* dir="ltr": "99+" is a number and a sign, and in Arabic the paragraph's direction put the sign first ("+99"). */}
        {unread > 0 && (
          <span dir="ltr" data-unread={unread} className="absolute right-2 top-2 z-10 rounded-full bg-accent px-2 py-0.5 text-[11px] font-bold text-black shadow-glow">
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
          <span className="absolute bottom-2 left-2 z-10 rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-black shadow-glow rtl:tracking-normal">{tr('New')}</span>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-black/85 to-transparent" />
      </div>
      <p className="mt-2 line-clamp-2 px-0.5 text-[13px] font-medium leading-tight text-fog-200 transition group-hover:text-fog-50">
        {series.metadata?.title || series.name}
      </p>
      {note && <p data-card-note className="mt-0.5 truncate px-0.5 text-[11px] leading-tight text-fog-500 tabular-nums">{note}</p>}
    </Link>
    {menu.element}
    </>
  );
}

/** Wide "continue reading" card for an on-deck book. */
export function ContinueCard({ book, eager = false }: { book: Book; eager?: boolean }) {
  const pct = progressOf(book);
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
        <p className="mb-2 text-xs text-fog-300">
          {chapterLabel(book)}
          {elsewhere && (
            // One sentence per language: relativeTime is the reader's language now, and "on iPhone vor 3 Tagen"
            // was English words around a German phrase.
            <span className="text-fog-500"> · {elsewhere.at
              ? tr('on {device} {when}', { device: where, when: relativeTime(elsewhere.at) })
              : tr('on {device}', { device: where })}</span>
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
export function SeriesTile({ series, eager = false, selectable, selected, onToggle, note }: {
  series: Series; eager?: boolean;
  /** select mode: the tile stops navigating and toggles instead */
  selectable?: boolean; selected?: boolean; onToggle?: () => void;
  /**
   * One quiet line under the title (v0.58.0): in the Library, the value the shelf is sorted by -- "312K on AniList",
   * "★ 4/5", "Read 3d ago" (lib/sortValue.ts). Nothing when empty.
   */
  note?: string;
}) {
  // yomi.unread first: it is computed per user in lib/enrich.ts. booksUnreadCount is now corrected there too,
  // but a rail added later that forgets to enrich would fall back to seriesDto's placeholder -- which is the
  // total chapter count -- so the badge would claim every chapter is unread. Preferring the enriched field
  // means such a rail shows no badge rather than a wrong one.
  const unread = series.yomi?.unread ?? series.booksUnreadCount ?? 0;
  const savedOffline = useOfflineSeries().has(series.id);
  const tint = useTileTint(series.color);
  // Not in Select mode: there a press toggles the tile, and the Library's own bar holds the actions (#100).
  const menu = useSeriesMenu(series);
  const Wrap: any = selectable ? 'button' : Link;
  const wrapProps = selectable
    ? { type: 'button', onClick: onToggle, className: 'group w-full text-left' }
    : { href: `/series/?id=${series.id}`, className: 'group', ...menu.bind };
  return (
    <>
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
        {/* dir="ltr", as SeriesCard's: "99+" read "+99" in Arabic. */}
        {unread > 0 && (
          <span dir="ltr" data-unread={unread} className="absolute right-1.5 top-1.5 z-10 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-bold text-black">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
        {(series.yomi?.newCount ?? 0) > 0 && (
          <span className="absolute bottom-1.5 left-1.5 z-10 rounded-full bg-accent px-1.5 py-0.5 text-[9px] font-bold uppercase text-black">{tr('New')}</span>
        )}
      </div>
      <p dir="auto" className="mt-1.5 line-clamp-2 text-xs font-medium leading-tight text-fog-300 transition group-hover:text-fog-100">
        {series.metadata?.title || series.name}
      </p>
      {/* In the interface's direction, not the title's `auto`: it is the app's sentence about the series. */}
      {note && <p data-sort-value className="mt-0.5 truncate text-[11px] leading-tight text-fog-500 tabular-nums">{note}</p>}
      {/* The work's languages (v0.52.0, #72): the Library shows one card for every language edition the viewer may
          browse, and this line says so -- `EN · ES-419`, the edition this card opens brighter. The names are its
          title, for a hover and a screen reader. */}
      {!!series.edition?.langs && series.edition.langs.length > 1 && (
        <p data-edition-langs className="mt-0.5 truncate text-[10px] font-semibold tracking-wide text-fog-600"
          title={series.edition.langs.map(languageName).join(' · ')}>
          {libraryCaption(series.edition.langs, series.lang).map((c, i) => (
            <span key={c.lang}>
              {i > 0 && <span aria-hidden> · </span>}
              <span className={c.current ? 'text-fog-300' : ''}>{c.label}</span>
            </span>
          ))}
        </p>
      )}
    </Wrap>
    {!selectable && menu.element}
    </>
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
