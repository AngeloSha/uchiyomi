'use client';

export interface Bar { label: string; value: number; hint?: string }

/**
 * A labelled bar per row, as divs.
 *
 * Deliberately not an SVG: the two charts this app already had are divs, text in an SVG cannot wrap or
 * ellipsise, and a genre name in German will need to. Widths are percentages, so this is fluid for free and
 * the 390px budget is satisfied without measuring anything.
 *
 * Brightness carries the value as well as length, so the ranking survives being read at a glance -- and at
 * the bottom of a long list, where every bar is short, the difference is still visible.
 */
export function Bars({ items, max: maxIn, wideHint = false }: { items: Bar[]; max?: number; wideHint?: boolean }) {
  const max = Math.max(1, maxIn ?? Math.max(0, ...items.map((i) => i.value)));
  // No RTL handling here on purpose. Rows are a flex line of ordinary elements, so the label, the track and
  // the number already swap ends with `dir`, and the bar grows from whichever edge the text starts at. The
  // reversal the other two charts need is for data laid out along an axis this one does not have.
  return (
    <div className="space-y-1.5">
      {items.map((b) => {
        const pct = Math.round((b.value / max) * 100);
        return (
          <div key={b.label} className="flex items-center gap-2.5">
            <span className="w-20 shrink-0 truncate text-[11px] text-fog-400" title={b.label}>{b.label}</span>
            <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-ink-800">
              <div
                className="h-full rounded-full transition-[width] duration-500 ease-out"
                style={{
                  width: `${Math.max(pct, b.value > 0 ? 3 : 0)}%`,
                  background: `rgb(var(--accent) / ${(0.35 + 0.65 * (b.value / max)).toFixed(3)})`,
                }}
              />
            </div>
            {/* v0.61.0: `wideHint` for a hint that is an amount of time ("4.5 hr", the Studio's devices), not a count. */}
            <span className={`${wideHint ? 'w-14' : 'w-8'} shrink-0 text-end text-[11px] tabular-nums text-fog-500`}>{b.hint ?? b.value}</span>
          </div>
        );
      })}
    </div>
  );
}
