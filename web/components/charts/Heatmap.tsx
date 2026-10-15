'use client';
import { useMemo } from 'react';
import { useRtl } from '@/components/ui';
import { t as tr } from '@/lib/i18n';

const CELL = 12;
const GAP = 3;
const STEP = CELL + GAP;
const DAY_MS = 86_400_000;

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
 * **RTL reverses the weeks, not the drawing.** Mirroring the `<g>` would mirror the month labels with it.
 */
export function Heatmap({ values, start, max: maxIn, label, numbers }: {
  /** Write each day's value on its block. */
  numbers?: boolean;
  /** Dense: one entry per day, index 0 is `start`. */
  values: number[];
  /** ISO date (YYYY-MM-DD) of `values[0]`, read as UTC. */
  start: string;
  /** Fix the scale across several heatmaps; defaults to this one's own busiest day. */
  max?: number;
  /** Accessible name. `role="img"` REQUIRES one, and it also collapses the subtree -- so the per-day
   *  <title> elements below are invisible to a screen reader and this is the only thing it will hear. */
  label?: string;
}) {
  const rtl = useRtl();
  const { cells, weeks, max } = useMemo(() => {
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
    return { cells, weeks, max };
  }, [values, start, maxIn]);

  const total = values.reduce((a, b) => a + b, 0);
  const w = Math.max(1, weeks * STEP - GAP);
  const h = 7 * STEP - GAP;
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} role="img" className="block overflow-visible"
      aria-label={label ?? tr('{n} days of reading, {t} chapters in total', { n: values.length, t: total })}>
      {cells.map((c) => {
        // The zero cell is a grid line, not a value: a faint fill that never reaches the accent ramp.
        const t = c.v === 0 ? 0 : 0.18 + 0.82 * Math.min(1, c.v / max);
        const col = rtl ? weeks - 1 - c.col : c.col;
        return (
          <g key={c.at}>
          <rect
            x={col * STEP}
            y={c.row * STEP}
            width={CELL}
            height={CELL}
            rx={3}
            fill={c.v === 0 ? 'rgb(255 255 255 / 0.06)' : `rgb(var(--accent) / ${t.toFixed(3)})`}
          >
            <title>{`${fmt(c.at)} — ${c.v}`}</title>
          </rect>
          {numbers && (
            <text x={col * STEP + CELL / 2} y={c.row * STEP + CELL / 2} textAnchor="middle" dominantBaseline="central"
              fontSize={c.v >= 100 ? 5 : c.v >= 10 ? 6.5 : 8} fontWeight={600} pointerEvents="none" data-day-count
              fill={c.v === 0 ? 'rgb(255 255 255 / 0.28)' : t > 0.55 ? '#000' : 'rgb(255 255 255 / 0.92)'}>{c.v}</text>
          )}
          </g>
        );
      })}
    </svg>
  );
}
