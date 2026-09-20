'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { IcChevronRight } from '@/components/icons';
import { Heatmap } from '@/components/charts/Heatmap';
import { Pace } from '@/components/charts/Pace';
import { Bars } from '@/components/charts/Bars';
import { t as tr, keys } from '@/lib/i18n';

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
    <div className={`${CARD} ${span}`}>
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
  const { data } = useQuery({ queryKey: ['collections'], queryFn: () => api<{ content: CollectionRow[] }>('/api/collections'), staleTime: 300_000 });
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
              <span className="shrink-0 text-xs tabular-nums text-fog-500">{tr('{n} series', { n: c.item_count })}</span>
            </Link>
          ))}
        </div>
      ) : (
        <p className="text-xs text-fog-500">{tr('No collections yet')}</p>
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
    <div className={`${CARD} ${span}`}>
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
          <div>
            <p className="mb-1.5 text-[11px] uppercase tracking-widest text-fog-500">
              {tr('{n} chapters', { n: total })}
            </p>
            {series.length > 0 && <Heatmap values={counts} start={series[0].day} />}
          </div>
          <div>
            <p className="mb-1 text-[11px] uppercase tracking-widest text-fog-500">{tr('Pace')}</p>
            <Pace values={counts} />
          </div>
          <div>
            <p className="mb-2 text-[11px] uppercase tracking-widest text-fog-500">{tr('By weekday')}</p>
            <Bars items={dow.map((v, i) => ({ label: tr(DOW[i]), value: v }))} />
          </div>
        </div>
      )}
    </div>
  );
}
