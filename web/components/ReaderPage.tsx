'use client';
import { memo } from 'react';
import { useImgRetry } from '@/components/ui';
import { IcRefresh } from '@/components/icons';
import { t as tr } from '@/lib/i18n';
import { LEFT_HALF, RIGHT_HALF, cropStyle, fitBox } from '@/lib/readerCrop';
import type { Half, WidePages } from '@/lib/readerSpread';

/**
 * One page of the reader, in its two renderers' shared parts (v0.61.0).
 *
 * Lifted out of app/reader/page.tsx, which had grown past 1,500 lines with every page of the webtoon column drawn
 * inline: each scroll event that moved the page counter rendered every row of every loaded chapter again. A row is
 * now a memoised component whose props are primitives and stable callbacks, so a row re-renders when something about
 * IT changes -- its image entering or leaving the window, its height -- and not because the reader scrolled.
 */

/** How tall the chapter divider is. The reader's height model reserves the same (app/reader/page.tsx). */
export const DIVIDER_H = 60;

/** The parts of a reading-flow item a row draws (lib/readerFlow.ts FlowItem). */
export interface RowItem {
  key: string;
  number: number;
  width: number | null;
  height: number | null;
  junk?: boolean;
  missing?: boolean;
  collapsed?: boolean;
}

/**
 * One row of the webtoon column: the chapter divider when the row starts a chapter, then the page's own box.
 *
 * `height` is the reader's model of the box (never measured back from the DOM: overflow-anchor is off for that
 * reason). `src` is null outside the render window -- the row then shows the page's number -- and `stripSrc` is the
 * thumbnail a collapsed page is drawn from. `divider` is the next chapter's title, for the first page of a chapter
 * after the first. `missingSource` names the source on a placeholder's caption. `wide` is what a wide page becomes
 * (Reader → Wide pages, v0.61.0) -- the reader passes `whole` for every page that is not wide -- and `rightFirst` puts
 * a split page's right half on top.
 */
export const ReaderPageRow = memo(function ReaderPageRow({
  item, height, gap, divider, src, stripSrc, recollapsible, missingSource, wide, rightFirst, onExpand, onCollapse,
}: {
  item: RowItem;
  height: number;
  gap: number;
  divider: string | null;
  src: string | null;
  stripSrc: string | null;
  recollapsible: boolean;
  missingSource: string | null;
  wide: WidePages;
  rightFirst: boolean;
  onExpand: (key: string) => void;
  onCollapse: (key: string) => void;
}) {
  // Do not duplicate buildFlow's rule here: it deliberately keeps missing+junk placeholders open.
  const collapsed = !!item.collapsed;
  return (
    <div>
      {divider != null && (
        <div style={{ height: DIVIDER_H }} className="flex items-center justify-center gap-3 text-xs text-fog-500">
          <span className="h-px w-8 bg-ink-700" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fog-600">{tr('Up Next')}</span>
          <span className="text-fog-400">{divider}</span>
          <span className="h-px w-8 bg-ink-700" />
        </div>
      )}
      <div style={{ height: height || undefined, marginBottom: gap }} className="relative w-full bg-ink-900">
        {collapsed ? (
          /* A band of the real page, not a placeholder standing in for it. Seeing that it IS the
             credit page is the whole difference between "the reader set this aside" and "a page is
             missing" -- and it costs nothing extra, because the box below already crops with
             object-cover; only the height changed. `object-top` because the top of a credit page is
             the part that identifies it. The THUMBNAIL is used deliberately: a page nobody is
             reading must never pull a full-size scan down. */
          <button
            type="button"
            aria-expanded={false}
            onClick={() => onExpand(item.key)}
            /* ⚠️ BOTH, and neither is optional. The scroll container owns a tap gesture that
               toggles the chrome and a double-tap that zooms; it seeds that gesture on pointerdown
               and reads it on pointerup. Stop only one and a tap on a strip still expands the page
               AND toggles the chrome, and a double-tap expands then zooms. */
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            aria-label={tr('Show repeated page {n}', { n: item.number })}
            className="group block h-full w-full overflow-hidden text-start"
          >
            {stripSrc && (
              <img src={stripSrc} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover object-top opacity-50" />
            )}
            <span className="absolute inset-0 flex items-center justify-center gap-2.5 bg-ink-950/45 text-[10px] font-semibold uppercase tracking-[0.16em] text-fog-400 group-hover:text-fog-200">
              <span className="h-px w-6 bg-ink-600" />
              {tr('repeated page — tap to show')}
              <span className="h-px w-6 bg-ink-600" />
            </span>
          </button>
        ) : src && wide === 'split' ? (
          /* v0.61.0: a wide page as its two halves, one above the other, each the column's width -- the right half on
             top when the series reads right to left. The reader reserved 4 x colW x h / w for the pair. */
          <div data-wide="split" className="flex h-full w-full flex-col">
            {(rightFirst ? [RIGHT_HALF, LEFT_HALF] : [LEFT_HALF, RIGHT_HALF]).map((region) => (
              <div key={region.l} data-half={region.l ? 'right' : 'left'} className="relative w-full flex-1 overflow-hidden">
                <ReaderImg src={src} alt={tr('Page {n}', { n: item.number })} className="block max-w-none" style={cropStyle(region).img} />
              </div>
            ))}
          </div>
        ) : src && wide === 'rotate' && item.width && item.height ? (
          /* v0.61.0: a wide page turned on its side to the column's width. The box keeps the page's own shape -- as
             wide as the row is tall -- and turns about its centre. */
          <div data-wide="rotate" className="absolute inset-0 m-auto" style={{ width: height, height: height * (item.height / item.width), transform: 'rotate(90deg)' }}>
            <ReaderImg src={src} alt={tr('Page {n}', { n: item.number })} className="block h-full w-full max-w-none" />
          </div>
        ) : src ? (
          <ReaderImg src={src} alt={tr('Page {n}', { n: item.number })} className="block h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-ink-600">{item.number}</div>
        )}
        {/* Opened by hand, so it can be closed by hand -- otherwise expanding one to check it is a
            one-way door for the rest of the session. */}
        {recollapsible && (
          <button
            type="button"
            aria-expanded
            onClick={() => onCollapse(item.key)}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            aria-label={tr('Collapse repeated page {n}', { n: item.number })}
            className="absolute end-2 top-2 rounded-full bg-ink-950/75 px-2 py-1 text-[10px] font-medium text-fog-300 backdrop-blur hover:text-white"
          >
            {tr('collapse')}
          </button>
        )}
        {/* The server saved this chapter short and this page is its placeholder: say so, over the
            flat panel, or a grey page reads as the reader failing to load it. Not on a collapsed
            strip (a hand-marked one): the band is too short for two lines and expanding it shows
            the caption. */}
        {item.missing && !collapsed && <MissingCaption number={item.number} source={missingSource} />}
      </div>
    </div>
  );
});

/**
 * One half of a wide page as a slide of the paged track (v0.61.0, Wide pages → Split): a box of the half's shape,
 * fitted to the slide, that clips the page drawn at twice its width. Zoomed like any page.
 */
export function SlideHalf({ src, alt, width, height, half, area, zoom }: {
  src: string; alt: string; width: number; height: number; half: Exclude<Half, null>; area: { w: number; h: number }; zoom: number;
}) {
  const st = cropStyle(half === 'left' ? LEFT_HALF : RIGHT_HALF);
  const fit = fitBox(width * st.sx, height * st.sy, area.w, area.h);
  return (
    <div data-half={half} className="relative shrink-0 overflow-hidden"
      style={{ width: fit.width, height: fit.height, transform: zoom !== 1 ? `scale(${zoom})` : undefined }}>
      <ReaderImg src={src} alt={alt} className="block max-w-none" style={st.img} />
    </div>
  );
}

/**
 * A wide page turned on its side to fill a slide held upright (v0.61.0, Wide pages → Rotate). CSS only, so the slides
 * are the same: a box of the page's own shape, sized so that once turned a quarter it fits the slide, centred, turned,
 * and zoomed like any page.
 */
export function SlideTurned({ src, alt, width, height, area, zoom }: {
  src: string; alt: string; width: number; height: number; area: { w: number; h: number }; zoom: number;
}) {
  // Turned, the page stands `height` wide and `width` tall: fit THAT, then draw the box the other way round.
  const fit = fitBox(height, width, area.w, area.h);
  return (
    <div data-rotated className="absolute inset-0 m-auto"
      style={{ width: fit.height, height: fit.width, transform: `rotate(90deg)${zoom !== 1 ? ` scale(${zoom})` : ''}` }}>
      <ReaderImg src={src} alt={alt} className="block h-full w-full max-w-none" />
    </div>
  );
}

/**
 * One reader page, with a retry.
 *
 * Both call sites -- the continuous column and the paged slide -- keep their own classes, because the two
 * layouts size a page completely differently: one fills a box whose height was reserved from `page_dims`,
 * the other is bounded by the viewport. Only the failure behaviour is shared.
 */
export function ReaderImg({ src, alt, className, style }: {
  src: string; alt: string; className?: string; style?: React.CSSProperties;
}) {
  const { src: shown, failed, onError, retry } = useImgRetry(src);
  if (failed) {
    // A broken glyph tells the reader nothing and offers nothing. This says which page failed and gives them
    // the one action that fixes it, without reloading the chapter and losing their place.
    return (
      <div className="flex h-full w-full items-center justify-center p-4">
        <button onClick={retry} className="chip text-xs text-fog-300">
          <IcRefresh width={13} height={13} />{tr('Page did not load — tap to retry')}
        </button>
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={shown} alt={alt} className={className} style={style} decoding="async" onError={onError} />;
}

/**
 * The caption over a page the source never served (v0.40.0).
 *
 * The server saved the chapter short -- at least 80 % of its pages arrived -- with a flat panel at this
 * index, so the page count, progress and spreads are all unchanged; the one thing a reader cannot tell from
 * the panel is WHY it is blank. This says why, names the source when the reader can be told one, and says
 * what happens next (the sweep re-asks for the holes). Both renderers draw it inside the page's own box.
 *
 * ⚠️ `pointer-events-none`, and no button: a tap on it must be the tap it always was -- chrome toggle,
 * double-tap zoom -- because the scroll container owns those gestures and reads them from the same
 * pointerdown/up pair. There is nothing to do here by hand anyway: the retry is the server's, not the
 * reader's. Reintroduce by making the caption a <button>: a tap on a missing page stops toggling the chrome.
 */
export function MissingCaption({ number, source, dir }: { number: number; source: string | null; dir?: 'ltr' | 'rtl' }) {
  return (
    <div role="note" dir={dir} className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 text-center">
      <span className="text-sm font-medium text-fog-200">
        {source ? tr('Page {n} could not be fetched from {source}', { n: number, source }) : tr('Page {n} could not be fetched', { n: number })}
      </span>
      <span className="text-xs text-fog-500">{tr('It will be retried automatically.')}</span>
    </div>
  );
}
