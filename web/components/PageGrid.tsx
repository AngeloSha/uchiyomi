'use client';
import { Sheet, useImgRetry } from '@/components/ui';
import { t as tr } from '@/lib/i18n';

export interface GridPage {
  /** Index into the reader's flat page list, which is what a jump actually needs. */
  idx: number;
  number: number;
  src: string | null;
  /** A page the reader is skipping: drawn dimmed, with a mark, still openable. */
  junk?: boolean;
  /** A server-written placeholder. It may never be offered as a page to skip. */
  missing?: boolean;
}

/**
 * Thumbnails of the chapter you are in, as a way to jump.
 *
 * **The active chapter only.** Continuous reading appends the next chapter to the same flat list, so by the
 * third chapter the grid would hold six hundred tiles -- and "somewhere in the last three chapters" is not a
 * jump target. The chapter sheet is the control for going further than that.
 *
 * **Tiles at w=200**, which is the width the scrubber already requests. The page endpoint caches per width
 * and each new width is a fresh archive open plus a resize, so reusing a warm width makes this open with
 * thumbnails already on disk instead of paying for a whole new generation of them.
 */
export function PageGrid({ title, pages, current, onPick, onClose, onToggleJunk }: {
  title: string;
  pages: GridPage[];
  /** Flat index of the page being read, so it can be marked and scrolled to. */
  current: number;
  onPick: (idx: number) => void;
  onClose: () => void;
  /** Mark or un-mark a page by hand. Omitted when the decision cannot be saved (offline). */
  onToggleJunk?: (pageNumber: number, junk: boolean) => void;
}) {
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
        {pages.map((p) => (
          <button
            key={`${p.number}:${p.idx}`}
            onClick={() => { onPick(p.idx); onClose(); }}
            aria-label={p.junk ? tr('Open skipped page {n}', { n: p.number }) : tr('Open page {n}', { n: p.number })}
            aria-current={p.idx === current ? 'true' : undefined}
            className={`relative overflow-hidden rounded-lg border bg-ink-900 transition
              ${p.idx === current ? 'border-accent ring-1 ring-accent' : 'border-ink-700 hover:border-ink-500'}
              ${p.junk ? 'opacity-45' : ''}`}
          >
            <Thumb src={p.src} n={p.number} />
            {/* A skipped page is still HERE, and still openable. Dimmed rather than absent, because a page
                that silently vanished from the grid would look like a broken chapter. */}
            {p.junk && (
              <span className="absolute start-1 top-1 rounded bg-black/70 px-1 text-[9px] font-medium text-fog-300">
                {tr('skipped')}
              </span>
            )}
            <span className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/85 to-transparent pb-0.5 pt-3 text-[10px] font-medium tabular-nums text-white/90">
              {p.number}
            </span>
            {/* ⚠️ A <span role="button"> rather than a nested <button>, which is invalid HTML: the browser
                closes the outer button before this one, and the tile stops being clickable at all. The tile
                is the jump; this is the correction, so it stops the event rather than bubbling into it. */}
            {onToggleJunk && !p.missing && (
              <span
                role="button"
                tabIndex={0}
                aria-label={p.junk ? tr('Stop skipping page {n}', { n: p.number }) : tr('Skip page {n}', { n: p.number })}
                title={p.junk ? tr('Stop skipping this page') : tr('Skip this page')}
                onClick={(e) => { e.stopPropagation(); onToggleJunk(p.number, !p.junk); }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault(); e.stopPropagation(); onToggleJunk(p.number, !p.junk);
                }}
                className="absolute end-1 top-1 grid h-6 w-6 cursor-pointer place-items-center rounded-full
                           bg-black/70 text-[11px] leading-none text-fog-300 backdrop-blur
                           hover:bg-black/85 hover:text-white"
              >
                {p.junk ? '↺' : '⊘'}
              </span>
            )}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

function Thumb({ src, n }: { src: string | null; n: number }) {
  const { src: shown, failed, onError } = useImgRetry(src || '');
  if (!src || failed) {
    return <div className="flex aspect-[2/3] w-full items-center justify-center text-[11px] tabular-nums text-ink-500">{n}</div>;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={shown} alt="" onError={onError} loading="lazy" decoding="async"
    className="aspect-[2/3] w-full object-cover object-top" />;
}
