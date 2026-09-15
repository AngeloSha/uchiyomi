'use client';
// Twelve small squares, one per week, and a status dot. lib/activity.ts decides what they mean and when
// they are NOT drawn (a group with nothing in twelve weeks gets a sentence instead); this only paints them.
//
// The whole strip is one element with the cadence sentence as its accessible name and hover title, so the
// words the squares replaced are still there for anyone who cannot read a picture.
import type { ActivityStatus } from '@/lib/activity';

const DOT: Record<ActivityStatus, string> = {
  active: 'bg-emerald-400',
  quiet: 'bg-amber-400',
  done: 'bg-fog-600',
  unknown: 'bg-ink-600',
};

export function ActivityDots({ weeks, status, label }: { weeks: boolean[] | null; status: ActivityStatus; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5" role="img" aria-label={label} title={label}>
      {weeks && (
        <span className="inline-flex items-center gap-0.5">
          {weeks.map((on, i) => (
            <span key={i} data-week={on ? 'on' : 'off'} className={`h-1.5 w-1.5 rounded-[2px] ${on ? 'bg-accent/80' : 'bg-ink-700'}`} />
          ))}
        </span>
      )}
      <span data-status={status} className={`h-1.5 w-1.5 rounded-full ${DOT[status]}`} />
    </span>
  );
}
