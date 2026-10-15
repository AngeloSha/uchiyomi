'use client';
import { t as tr } from '@/lib/i18n';
import { bookCountText } from '@/lib/format';
import { streakStats, dayMs, type InsightsPayload } from '@/lib/insights';
import { Card, Empty, Stat, shortDate } from './shared';

/** Current and longest run of days with a finished chapter, the busiest day and the busiest week. */
export function Streaks({ data, span }: { data: InsightsPayload; span?: string }) {
  const s = streakStats(data.daily, Date.parse(data.now));
  const days = (n: number) => (n === 1 ? tr('1 day') : tr('{n} days', { n }));
  return (
    <Card id="you-streaks" title={tr('Streaks and bests')} span={span}>
      {!s.bestDay ? <Empty>{tr('Finish a chapter to start a streak.')}</Empty> : (
        <div className="grid grid-cols-2 gap-2">
          <Stat label={tr('Current streak')} value={days(s.current)} />
          <Stat label={tr('Longest streak')} value={days(s.longest)} />
          <Stat label={tr('Best day')} value={bookCountText(s.bestDay.n)} hint={longDateOrShort(s.bestDay.day)} />
          <Stat label={tr('Best week')} value={s.bestWeek ? bookCountText(s.bestWeek.n) : '-'} hint={s.bestWeek ? tr('week of {date}', { date: shortDate(dayMs(s.bestWeek.start)) }) : undefined} />
        </div>
      )}
    </Card>
  );
}

const longDateOrShort = (day: string): string => new Date(dayMs(day)).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
