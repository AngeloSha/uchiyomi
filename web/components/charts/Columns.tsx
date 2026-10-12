'use client';
import { hoursText } from '@/lib/readingTime';
import { t as tr } from '@/lib/i18n';

/**
 * Reading time by hour of the day (v0.61.0): twenty-four columns, midnight first, as divs in a flex row.
 *
 * Divs like Bars, not an SVG like Pace: the row is an ordinary flex line, so under `dir="rtl"` it runs right to left by
 * itself -- midnight at the right edge, as an Arabic reader reads a timeline -- with nothing reversed by hand. Heights
 * are percentages of the busiest hour, and an hour with any reading keeps a sliver so it is not mistaken for none. Four
 * hours are named under the row (0, 6, 12, 18); each column says its hour and its time on hover and to a screen reader.
 * Static: nothing grows in.
 */
export function Columns({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <div role="img" aria-label={tr('Reading time by hour of the day')}>
      <div className="flex h-16 items-end gap-0.5">
        {values.map((v, h) => (
          <div key={h} title={`${h}:00 · ${hoursText(v)}`} className="flex h-full min-w-0 flex-1 items-end">
            <div className="w-full rounded-t-sm"
              style={{ height: `${Math.max(v > 0 ? 4 : 0, Math.round((v / max) * 100))}%`, background: `rgb(var(--accent) / ${(0.35 + 0.65 * (v / max)).toFixed(3)})` }} />
          </div>
        ))}
      </div>
      <div aria-hidden className="mt-1 flex text-[9px] tabular-nums text-fog-600">
        {values.map((_, h) => <span key={h} className="min-w-0 flex-1 text-start">{h % 6 === 0 ? h : ''}</span>)}
      </div>
    </div>
  );
}
