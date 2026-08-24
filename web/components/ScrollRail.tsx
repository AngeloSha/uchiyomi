'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { IcChevronLeft, IcChevronRight } from './icons';
import { t as tr } from '@/lib/i18n';

/**
 * A horizontal strip you can actually move.
 *
 * Discover's rails were `hide-scrollbar … overflow-x-auto`, which on a desktop mouse left no input at all:
 * the bar was deleted, Lenis's smooth wheel swallows a vertical wheel over a horizontal-only scroller, and
 * there were no arrows. Touch and trackpad worked, which is why it survived. `globals.css` already ships a
 * slim dark scrollbar globally — this stops hiding it, gives it room under the content, and adds the arrows
 * a pointer expects.
 *
 * `scrollBy({ left })` is a PHYSICAL delta and does not mirror under `dir="rtl"`, where `scrollLeft` runs
 * from 0 down to -(scrollWidth - clientWidth). This app mirrors fully, so the sign comes from the computed
 * direction rather than being assumed, and the ends are measured on the absolute offset.
 */
export function ScrollRail({ children, className = '', size = 'md', label }: {
  children: ReactNode;
  /** Applied to the scroller itself, for layout: `bleed`, flex direction, gap, padding. */
  className?: string;
  /** `sm` for a chip strip, `md` for a card rail. Only changes the arrow buttons. */
  size?: 'sm' | 'md';
  /** Accessible name for the region, e.g. the heading the rail sits under. */
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [ends, setEnds] = useState({ start: true, end: true });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const x = Math.abs(el.scrollLeft); // negative in RTL
    // The 1px slack absorbs fractional layout: a rail sitting at 0.4px from its end is at its end.
    setEnds({ start: x <= 1, end: max <= 1 || x >= max - 1 });
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    // Content arrives late here — trending lands from a query, and each card's cover changes nothing about
    // width but the cards themselves do. Observing the scroller and its children covers both.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => ro.disconnect();
  }, [measure, children]);

  const go = (dir: -1 | 1) => {
    const el = ref.current;
    if (!el) return;
    const rtl = typeof getComputedStyle === 'function' && getComputedStyle(el).direction === 'rtl';
    el.scrollBy({ left: dir * el.clientWidth * 0.8 * (rtl ? -1 : 1), behavior: 'smooth' });
  };

  const btn = size === 'sm' ? 'h-7 w-7' : 'h-9 w-9';
  const ic = size === 'sm' ? 15 : 19;
  // -mt-1.5 cancels half of the pb-3 the rails carry for the scrollbar, so the arrow centres on the CONTENT
  // rather than on the padding box -- visible on the chip strip, where the bar is a third of the height.
  const arrow = `absolute top-1/2 z-10 hidden -mt-1.5 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white ` +
    `backdrop-blur transition hover:bg-black/65 active:scale-90 disabled:pointer-events-none disabled:opacity-0 lg:grid ${btn}`;

  return (
    <div className="relative" role={label ? 'group' : undefined} aria-label={label}>
      <div ref={ref} onScroll={measure} className={`overflow-x-auto ${className}`} data-lenis-prevent>
        {children}
      </div>
      <button type="button" onClick={() => go(-1)} disabled={ends.start} aria-label={tr('Previous')}
        className={`${arrow} start-1`}>
        <IcChevronLeft width={ic} height={ic} className="rtl:rotate-180" />
      </button>
      <button type="button" onClick={() => go(1)} disabled={ends.end} aria-label={tr('Next')}
        className={`${arrow} end-1`}>
        <IcChevronRight width={ic} height={ic} className="rtl:rotate-180" />
      </button>
    </div>
  );
}
