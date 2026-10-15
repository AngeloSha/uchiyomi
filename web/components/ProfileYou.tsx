'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { IcChevronRight } from '@/components/icons';
import { Heatmap } from '@/components/charts/Heatmap';
import { Pace } from '@/components/charts/Pace';
import { Bars } from '@/components/charts/Bars';
import { Columns } from '@/components/charts/Columns';
import { t as tr, keys } from '@/lib/i18n';
import { bookCountText } from '@/lib/format';
import { hoursText, perChapterText, readerTz } from '@/lib/readingTime';
import { shownDeviceName } from '@/lib/device';

/**
 * The You tab of the profile: what you have earned, what you have read, and your lists.
 *
 * Moved out of app/profile/page.tsx unchanged in v0.39.0, when that page went from one 1168-line file to a
 * shell around four tab components. This is the only one of the four that is still a `.board` of cards
 * rather than a settings grid: nothing here is a setting, so it keeps the card chrome the hero was designed
 * against. The page passes `stats` down because the hero already holds the same query.
 */

/** Every board card wears the same chrome. `.grad-border` is what makes a wall of dark cards read as a console. */
export const CARD = 'card grad-border p-4';

export interface Stats {
  chapters_completed: number;
  days?: number;
  first_read_at?: string | null;
  series_touched: number;
  last_read_at: string | null;
  byDay: { day: string; chapters: number }[];
  currentStreak: number;
  longestStreak: number;
  weekChapters: number;
  weeklyGoal: number;
}
interface CollectionRow { id: string; name: string; item_count: number }

/** GET /api/stats/time (v0.61.0): reading time from page turns, the reader's own (bff lib/readingTime.ts). */
export interface ReadingTime {
  tz: string;
  days: number;
  week: { ms: number; chapters: number };
  month: { ms: number; chapters: number };
  year: { year: number; ms: number; chapters: number };
  window: { ms: number; chapters: number; perChapterMs: number | null; byHour: number[]; byDevice: { name: string | null; ms: number }[] };
}

/**
 * The devices' rows: each name as the session list says it, unnamed ones as "Device" -- one row per name shown, since
 * two devices the server could not name read the same and a list of two "Device" rows says nothing.
 */
export function deviceRows(list: ReadingTime['window']['byDevice']): { label: string; value: number; hint: string }[] {
  const by = new Map<string, number>();
  for (const d of list) {
    const label = shownDeviceName(d.name, { device: true }) || tr('Device');
    by.set(label, (by.get(label) ?? 0) + d.ms);
  }
  return [...by].sort((a, b) => b[1] - a[1]).map(([label, ms]) => ({ label, value: ms, hint: hoursText(ms) }));
}

// Rendered as `tr(b.label)`, so the labels are declared. See lib/i18n.ts.
const BADGE_LABELS = keys('Reader', 'Bookworm', 'On a roll', 'Centurion', 'Devoted', 'Legend');
export const BADGES = [
  { emoji: '📖', label: BADGE_LABELS[0], test: (s: Stats) => s.chapters_completed >= 10 },
  { emoji: '🐛', label: BADGE_LABELS[1], test: (s: Stats) => s.chapters_completed >= 50 },
  { emoji: '🔥', label: BADGE_LABELS[2], test: (s: Stats) => s.longestStreak >= 7 },
  { emoji: '💯', label: BADGE_LABELS[3], test: (s: Stats) => s.chapters_completed >= 100 },
  { emoji: '🌙', label: BADGE_LABELS[4], test: (s: Stats) => s.longestStreak >= 30 },
  { emoji: '👑', label: BADGE_LABELS[5], test: (s: Stats) => s.chapters_completed >= 500 },
];

/* ================================== You ================================== */

/**
 * What you have earned, plus the single next thing.
 *
 * It used to render all six at once with five of them greyed out, which is a wall of things you have not
 * done sitting on your own profile.
 */
export function BadgesCard({ stats, span = '' }: { stats?: Stats; span?: string }) {
  if (!stats) return <div className={`card skeleton h-32 ${span}`} />;
  const earned = BADGES.filter((b) => b.test(stats));
  const next = BADGES.find((b) => !b.test(stats));
  return (
    <div id="badges" className={`${CARD} scroll-mt-4 lg:scroll-mt-20 ${span}`}>
      <h2 className="mb-3 font-display text-base font-semibold">{tr('Badges')}</h2>
      <div className="flex flex-wrap gap-2">
        {earned.map((b) => (
          <span key={b.label} className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent-soft px-3 py-1.5 text-xs text-fog-100">
            <span>{b.emoji}</span>{tr(b.label)}
          </span>
        ))}
        {next && (
          <span key={next.label} className="inline-flex items-center gap-1.5 rounded-full border border-ink-700 px-3 py-1.5 text-xs text-ink-500 opacity-60">
            <span>{next.emoji}</span>{tr(next.label)}
          </span>
        )}
      </div>
    </div>
  );
}

export function ListsCard({ span = '' }: { span?: string }) {
  // v0.61.0: every list this reader may read, smart and shared ones too, each counted for them (lib/lists.ts).
  const { data } = useQuery({ queryKey: ['lists-all'], queryFn: () => api<{ content: CollectionRow[] }>('/api/collections?scope=all'), staleTime: 60_000 });
  const rows = data?.content ?? [];
  return (
    <div className={`${CARD} ${span}`}>
      <h2 className="mb-3 font-display text-base font-semibold">{tr('Lists')}</h2>
      {rows.length ? (
        <div className="space-y-1.5">
          {rows.slice(0, 6).map((c) => (
            <Link key={c.id} href={`/collection/?id=${encodeURIComponent(c.id)}`}
              className="flex items-center justify-between gap-3 rounded-xl border border-ink-700/70 bg-ink-850/50 px-3 py-2">
              <span className="min-w-0 truncate text-sm text-fog-100">{c.name}</span>
              <span className="shrink-0 text-xs tabular-nums text-fog-500">{c.item_count === 1 ? tr('1 series') : tr('{n} series', { n: c.item_count })}</span>
            </Link>
          ))}
        </div>
      ) : (
        <p className="text-xs text-fog-500">{tr('No lists yet')}</p>
      )}
      <Link href="/collections/" className="chip mt-3 text-xs">{tr('See all')}<IcChevronRight width={14} height={14} aria-hidden className="rtl:-scale-x-100" /></Link>
    </div>
  );
}

/**
 * The profile's old Reading tab held four settings cards and no reading. This is the reading, and since
 * v0.39.0 it sits on the You tab next to the badges and lists, where a reader looks first.
 *
 * One request, three views of it: the calendar, the trend, and the week. `/api/stats` already computed a
 * dense daily series and simply had nowhere to be drawn at more than 90 days.
 */
export function StudioCard({ span = '' }: { span?: string }) {
  const [days, setDays] = useState(90);
  const { data, isLoading } = useQuery({
    queryKey: ['stats', days],
    queryFn: () => api<Stats>(`/api/stats?days=${days}`),
  });
  // v0.61.0: reading time over the same window, plus the week, the month and the year (bff lib/readingTime.ts).
  const tz = readerTz();
  const { data: time } = useQuery({
    queryKey: ['stats-time', days, tz],
    queryFn: () => api<ReadingTime>(`/api/stats/time?days=${days}&tz=${encodeURIComponent(tz)}`),
  });
  const devices = deviceRows(time?.window.byDevice ?? []);

  const series = data?.byDay ?? [];
  const counts = series.map((d) => d.chapters);
  const total = counts.reduce((a, b) => a + b, 0);

  // Sunday-first, matching the heatmap's rows and `Date.getUTCDay()`. Bucketed on the client because the
  // window is already here -- asking the server for the same numbers a second way is how two endpoints
  // start disagreeing.
  const dow = [0, 0, 0, 0, 0, 0, 0];
  for (const d of series) {
    const t = Date.parse(`${d.day}T00:00:00Z`);
    if (!Number.isNaN(t)) dow[new Date(t).getUTCDay()] += d.chapters;
  }
  const DOW = keys('Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat');

  if (isLoading && !data) return <div className={`card skeleton h-64 ${span}`} />;

  return (
    <div id="reading-studio" className={`${CARD} scroll-mt-4 lg:scroll-mt-20 ${span}`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-base font-semibold">{tr('Reading studio')}</h2>
        <div className="flex gap-1.5">
          {[90, 180, 365].map((d) => (
            <button key={d} onClick={() => setDays(d)} aria-pressed={days === d}
              className={`chip text-[11px] ${days === d ? 'border-accent/50 text-accent' : 'text-fog-400'}`}>
              {tr('{n} days', { n: d })}
            </button>
          ))}
        </div>
      </div>

      {total === 0 ? (
        <p className="py-6 text-center text-sm text-fog-500">{tr('Nothing read in this window yet.')}</p>
      ) : (
        <div className="space-y-5">
          {/* v0.61.0: how long, in three squared tiles -- the last week, the last month and the year (Wrapped's) -- then
              the pace per chapter and what the figures are built on. Static: nothing counts up. */}
          {time && (
            <div data-studio-time>
              <p className="mb-1.5 text-[11px] uppercase tracking-widest text-fog-500">{tr('Reading time')}</p>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: tr('Last 7 days'), ...time.week },
                  { label: tr('Last 30 days'), ...time.month },
                  { label: String(time.year.year), ...time.year },
                ].map((tile) => (
                  <div key={tile.label} className="min-w-0 rounded-xl border border-ink-700/70 bg-ink-850/50 px-2.5 py-2">
                    <p className="truncate text-[10px] text-fog-500">{tile.label}</p>
                    <p className="truncate font-display text-base font-semibold tabular-nums text-fog-100">{hoursText(tile.ms)}</p>
                    <p className="truncate text-[10px] text-fog-500">{bookCountText(tile.chapters)}</p>
                  </div>
                ))}
              </div>
              {perChapterText(time.window.perChapterMs) && <p className="mt-2 text-xs text-fog-300">{perChapterText(time.window.perChapterMs)}</p>}
              <p className="mt-0.5 text-[11px] text-fog-500">{tr('Counted from page turns; long pauses are left out.')}</p>
            </div>
          )}
          <div>
            <p className="mb-1.5 text-[11px] uppercase tracking-widest text-fog-500">
              {bookCountText(total)}
            </p>
            {series.length > 0 && <Heatmap values={counts} start={series[0].day} numbers />}
          </div>
          <div>
            <p className="mb-1 text-[11px] uppercase tracking-widest text-fog-500">{tr('Pace')}</p>
            <Pace values={counts} />
          </div>
          <div>
            <p className="mb-2 text-[11px] uppercase tracking-widest text-fog-500">{tr('By weekday')}</p>
            <Bars items={dow.map((v, i) => ({ label: tr(DOW[i]), value: v }))} />
          </div>
          {/* v0.61.0: when in the day, in the reader's own hours, and on which devices. */}
          {!!time?.window.byHour.some((v) => v > 0) && (
            <div data-studio-hours>
              <p className="mb-2 text-[11px] uppercase tracking-widest text-fog-500">{tr('By hour')}</p>
              <Columns values={time.window.byHour} />
            </div>
          )}
          {devices.length > 0 && (
            <div data-studio-devices>
              <p className="mb-2 text-[11px] uppercase tracking-widest text-fog-500">{tr('Devices')}</p>
              <Bars items={devices} wideHint />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
