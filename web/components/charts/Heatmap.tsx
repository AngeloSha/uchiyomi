'use client';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useRtl } from '@/components/ui';
import { t as tr } from '@/lib/i18n';
import { monthText, yearText } from '@/lib/format';

const CELL = 12;
const GAP = 3;
const STEP = CELL + GAP;
const DAY_MS = 86_400_000;
/** One row of ticks above a scrolling strip (the year, then the month), in viewBox units. */
const TICK = 12;
/** Columns a tick needs before the next one, or it is left out: a strip that opens late in a month or a year. */
const ROOM = 3;

/**
 * A year of reading as a grid of days: one column per week, one row per weekday.
 *
 * **Brightness encodes value**, which is the language the rest of this app already speaks -- the cards, the
 * genre tiles and the rank numerals all say "more" by getting brighter rather than by changing hue. So a
 * busy day is a stronger accent, not a different colour, and the empty days stay visible as a faint grid
 * instead of vanishing (a heatmap whose zeroes are invisible reads as missing data, not as a quiet week).
 *
 * **No intrinsic width.** `width="100%"` plus a viewBox, so it fits whatever column it is given, down to a
 * 390px phone, without a media query and without measuring anything. Giving an SVG a pixel width is what
 * put a fixed-size ring in a fluid card on the profile page.
 *
 * **Except when it scrolls** (`scroll`, the Reading studio's "All time", #265): years of weeks squeezed to the card's
 * width would be cells a pixel wide, so the cells keep their size, the strip scrolls sideways inside its card, and it
 * opens on the newest weeks. A strip that long needs a way to tell where it is, so this mode alone puts the year and the
 * month over the first week of each.
 *
 * **RTL reverses the weeks, not the drawing.** Mirroring the `<g>` would mirror the month labels with it.
 */
export function Heatmap({ values, start, max: maxIn, label, scroll = false }: {
  /** Dense: one entry per day, index 0 is `start`. */
  values: number[];
  /** ISO date (YYYY-MM-DD) of `values[0]`, read as UTC. */
  start: string;
  /** Fix the scale across several heatmaps; defaults to this one's own busiest day. */
  max?: number;
  /** Accessible name. `role="img"` REQUIRES one, and it also collapses the subtree -- so the per-day
   *  <title> elements below are invisible to a screen reader and this is the only thing it will hear. */
  label?: string;
  /** Fixed-size cells in a sideways scroller, with year and month ticks, opened on the newest weeks. */
  scroll?: boolean;
}) {
  const rtl = useRtl();
  const { cells, weeks, max, months, years } = useMemo(() => {
    const startMs = Date.parse(`${start}T00:00:00Z`);
    // Weeks begin on Sunday, matching `byDow`, whose index 0 is Sunday because that is what
    // `Date.getUTCDay()` returns. The first column is short whenever the range does not begin on one.
    const lead = Number.isNaN(startMs) ? 0 : new Date(startMs).getUTCDay();
    const total = lead + values.length;
    const weeks = Math.ceil(total / 7);
    const max = Math.max(1, maxIn ?? Math.max(0, ...values));
    const cells = values.map((v, i) => {
      const slot = lead + i;
      return { col: Math.floor(slot / 7), row: slot % 7, v, at: startMs + i * DAY_MS };
    });
    // The ticks: the week holding the 1st of each month, and of each January for the year. The strip's own first
    // month and year go over its first week too, unless the next tick comes too soon to leave them room.
    const months: { col: number; at: number }[] = [];
    const years: { col: number; at: number }[] = [];
    if (scroll && !Number.isNaN(startMs)) {
      for (const c of cells) {
        const d = new Date(c.at);
        if (d.getUTCDate() !== 1) continue;
        months.push({ col: c.col, at: c.at });
        if (d.getUTCMonth() === 0) years.push({ col: c.col, at: c.at });
      }
      if (!months.length || months[0].col >= ROOM) months.unshift({ col: 0, at: startMs });
      if (!years.length || years[0].col >= ROOM) years.unshift({ col: 0, at: startMs });
    }
    return { cells, weeks, max, months, years };
  }, [values, start, maxIn, scroll]);

  const total = values.reduce((a, b) => a + b, 0);
  const w = Math.max(1, weeks * STEP - GAP);
  const h = 7 * STEP - GAP;
  const top = scroll ? 2 * TICK + 4 : 0;
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const x = (col: number) => (rtl ? weeks - 1 - col : col) * STEP;
  // A tick starts at its week's start edge and runs on over the weeks after it: rightwards here, leftwards in Arabic,
  // where SVG text inherits the page's direction and `start` is the right end of the text.
  const tickX = (col: number) => x(col) + (rtl ? CELL : 0);

  // Opened on the newest weeks: the end of the strip, which is its left in Arabic (the weeks run from the right). An RTL
  // scroller counts scrollLeft from 0 at its right edge down to negative, so asking for -scrollWidth is its far left,
  // clamped, and scrollWidth its far right in LTR. Once per strip and direction, so a refetch never yanks a reader back.
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = rtl ? -el.scrollWidth : el.scrollWidth;
  }, [rtl, weeks]);

  const svg = (
    <svg width={scroll ? w : '100%'} height={scroll ? h + top : undefined} viewBox={`0 ${-top} ${w} ${h + top}`} role="img"
      className="block overflow-visible"
      aria-label={label ?? tr('{n} days of reading, {t} chapters in total', { n: values.length, t: total })}>
      {years.map((k) => (
        <text key={`y${k.at}`} x={tickX(k.col)} y={-top + TICK - 2} fontSize={10} fontWeight={600} className="fill-fog-400">{yearText(k.at)}</text>
      ))}
      {months.map((k) => (
        <text key={`m${k.at}`} x={tickX(k.col)} y={-top + 2 * TICK - 2} fontSize={10} className="fill-fog-500">{monthText(k.at)}</text>
      ))}
      {cells.map((c) => {
        // The zero cell is a grid line, not a value: a faint fill that never reaches the accent ramp.
        const t = c.v === 0 ? 0 : 0.18 + 0.82 * Math.min(1, c.v / max);
        return (
          <rect
            key={c.at}
            x={x(c.col)}
            y={c.row * STEP}
            width={CELL}
            height={CELL}
            rx={3}
            fill={c.v === 0 ? 'rgb(255 255 255 / 0.06)' : `rgb(var(--accent) / ${t.toFixed(3)})`}
          >
            <title>{`${fmt(c.at)} — ${c.v}`}</title>
          </rect>
        );
      })}
    </svg>
  );
  if (!scroll) return svg;
  // Sideways only: `-horizontal`, so a mouse wheel over the strip still scrolls the page (v0.67.1, the rails).
  return (
    <div ref={scroller} data-heatmap-scroll data-lenis-prevent-horizontal className="overflow-x-auto overscroll-x-contain pb-2">
      {svg}
    </div>
  );
}
