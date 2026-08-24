'use client';

/**
 * Ninety days of reading, drawn as the floor of the profile hero.
 *
 * The point of stretching it across the whole width rather than boxing it in a card is that at 1856px each
 * bar is 19px and the thing becomes a readable timeline; the 318px card it replaces could only ever be a
 * decoration. The last seven days burn at full accent and the eighty-three behind them at 42%, so "am I
 * still reading" is answered by brightness before any number is read.
 *
 * `days` arrives dense from `/api/stats` -- the BFF builds it with `generate_series`, one UTC row per day,
 * zeroes included. There is deliberately no client-side gap filling here: a second implementation of the
 * calendar would be a second place for the timezone to be wrong.
 */
export function TraceStrip({ days, className = '' }: {
  days: { day: string; chapters: number }[];
  className?: string;
}) {
  const max = Math.max(1, ...days.map((d) => d.chapters));

  return (
    <div className={`flex h-16 w-full items-end gap-px px-4 lg:h-20 lg:px-8 ${className}`}>
      {days.map((d, i) => (
        <div
          key={d.day}
          title={`${d.day}: ${d.chapters}`}
          className="min-w-0 flex-1 rounded-t-[1px] animate-fade-up"
          style={{
            // A 2% floor rather than 0: a day you read nothing is still a day, and a row of invisible bars
            // reads as a broken chart rather than as a quiet quarter.
            height: `${Math.max(2, (d.chapters / max) * 100)}%`,
            background: i >= days.length - 7 ? 'rgb(var(--accent))' : 'rgb(var(--accent) / 0.42)',
            animationDelay: `${Math.min(i, 60) * 6}ms`,
          }}
        />
      ))}
    </div>
  );
}
