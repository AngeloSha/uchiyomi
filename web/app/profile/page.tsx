'use client';
import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { motion, useReducedMotion } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { relativeTime } from '@/lib/format';
import { useSectionArrival } from '@/lib/useSectionArrival';
import { useReduceEffects } from '@/lib/effects';
import { Avatar } from '@/components/Avatar';
import { ConsoleFootRow, ConsoleLayout, type PageView } from '@/components/ConsoleLayout';
import { HouseBoard } from '@/components/HouseBoard';
import { SpineWall } from '@/components/SpineWall';
import { TraceStrip } from '@/components/TraceStrip';
import { Modal, msgOf } from '@/components/ConfirmDialog';
import { Backdrop, Img } from '@/components/ui';
import { useToast } from '@/components/Toast';
import { IcSparkle, IcPlay, IcRefresh, IcSettings, IcLogOut, IcMoments, IcUser, IcChart, IcLink, IcKey } from '@/components/icons';
import { BadgesCard, ListsCard, StudioCard, type Stats } from '@/components/ProfileYou';
import { ProfileInsights } from '@/components/ProfileInsights';
import { useProfileSettingsViews } from '@/components/ProfileSettings';
import { ProfileConnections } from '@/components/ProfileConnections';
import { ProfileAccount } from '@/components/ProfileAccount';
import { PROFILE_SETTINGS } from '@/lib/settingsIndex.profile';
import { t as tr } from '@/lib/i18n';
import { isDesktop } from '@/lib/desktop';

/**
 * The profile console (v0.88.0): the person's cinematic hero, then ONE list -- You and Insights as pictures, then
 * Settings: General, Appearance, Reading, This device, Connections and Account -- beside the page on screen, or before it
 * on a phone (components/ConsoleLayout.tsx). Admin, Support and Sign out are its foot.
 *
 * You is the person (the household's week, badges, the reading studio, lists); Insights is what their reading adds up to
 * (v0.75.0, from #249); the Settings group is how the app behaves for them, Connections everything that talks to another
 * service (trackers, OPDS readers, API tokens), and Account who they are here (password, 2FA, sessions, sign out).
 *
 * Until v0.88.0 these were five tabs under the hero and Settings four categories under its tab: "a tab under a tab",
 * with Connections "not under anything" (the owner, 2026-10-19). A first cut of the list put the person in a small card
 * and the hero inside You; the owner: "it was cinematic and nicer before with a hero section" -- so the hero is back
 * across the top, in full above You and as a band above the other pages on a computer, and on a phone above the list.
 */

/** 12.3k rather than 12345: six digits overflow a stat pill, and nobody reads the last three anyway. */
const compact = (n: number): string =>
  n < 10_000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`;

interface HistoryRow { series_id: string; series_title: string; completed: boolean; created_at: string }
interface LeaderRow { id: string; display_name: string; avatar?: { emoji?: string; color?: string } | null; week: number; total: number }
interface HomePayload { onDeck: { id: string; seriesId: string }[]; new: { id: string; name: string }[] }
interface Wrapped { topSeries: { id: string; title: string }[] }

function GoalRing({ value, goal, size = 64 }: { value: number; goal: number; size?: number }) {
  const pct = goal > 0 ? Math.min(1, value / goal) : 0;
  const stroke = Math.max(4, Math.round(size * 0.095));
  const r = (size - stroke) / 2 - 1;
  const c = 2 * Math.PI * r;
  const mid = size / 2;
  return (
    // `shrink-0`: inside a flex pill an SVG with an intrinsic size is otherwise the thing that refuses to
    // give, and 64px of it in a 61px remainder is where the 390px document overflow came from.
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle cx={mid} cy={mid} r={r} fill="none" stroke="rgb(38 38 47)" strokeWidth={stroke} />
      <circle cx={mid} cy={mid} r={r} fill="none" stroke="rgb(var(--accent))" strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - pct)} transform={`rotate(-90 ${mid} ${mid})`} />
      <text x={mid} y={mid + size * 0.11} textAnchor="middle" className="fill-fog-50 font-display font-bold"
        style={{ fontSize: Math.round(size * 0.3) }}>{value}</text>
    </svg>
  );
}

/**
 * `useSearchParams` needs a Suspense boundary above it in a statically exported app (the import page does the same), so
 * the page proper is one level down. `?tab=connections` opens that page, and `&card=tracking` scrolls its Progress
 * tracking section into view: the import page's tracker line sends people to that section. Older addresses
 * (`?tab=Connections`, `?tab=Settings&cat=reading`) open the same pages (lib/settingsIndex.ts `readPage`).
 */
export default function ProfilePage() {
  return (
    <Suspense fallback={<div className="min-h-screen-d" />}>
      <ProfileInner />
    </Suspense>
  );
}

function ProfileInner() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const params = useSearchParams();
  // v0.55.4: `?section=` -- a card found by the search palette (Appearance, API tokens…) is landed on once it is drawn;
  // a row of the console's own pages is the console's to land on (components/ConsoleLayout.tsx).
  useSectionArrival();
  // Read once: the card is scrolled to on arrival, never again on a re-render or a page change.
  const [focusTracking] = useState<boolean>(() => params.get('card') === 'tracking');
  const [goalOpen, setGoalOpen] = useState(false);
  const desktop = isDesktop();
  const settings = useProfileSettingsViews();

  const year = new Date().getFullYear();
  const { data: stats } = useQuery({ queryKey: ['stats'], queryFn: () => api<Stats>('/api/stats') });
  const { data: home } = useQuery({ queryKey: ['home'], queryFn: () => api<HomePayload>('/api/home') });
  const { data: history } = useQuery({ queryKey: ['history', 60], queryFn: () => api<{ content: HistoryRow[] }>('/api/history?limit=60') });
  const { data: wrapped } = useQuery({ queryKey: ['wrapped', year], queryFn: () => api<Wrapped>(`/api/wrapped?year=${year}`), staleTime: 30 * 60_000 });
  // Last-resort hero art, so a library with series but no reading still opens washed in its own covers.
  const { data: rnd } = useQuery({ queryKey: ['profile-hero-art'], queryFn: () => api<{ seriesId: string | null }>('/api/random'), staleTime: 30 * 60_000 });

  // The shelf: what you have actually been holding, newest first. A fresh account has no history, so it
  // falls back to the newest series in the library and the label says so rather than showing an empty rail.
  const shelf = useMemo(() => {
    const seen = new Set<string>();
    const ids: string[] = [];
    const titles: string[] = [];
    for (const r of history?.content ?? []) {
      if (!r.series_id || seen.has(r.series_id)) continue;
      seen.add(r.series_id);
      ids.push(r.series_id);
      titles.push(r.series_title);
      if (ids.length === 12) break;
    }
    if (ids.length) return { ids, titles, label: tr('Reading history') };
    const fresh = (home?.new ?? []).slice(0, 8);
    return { ids: fresh.map((s) => s.id), titles: fresh.map((s) => s.name), label: tr('Recently added') };
  }, [history, home]);

  // The art of the person's year: what they read most, else what is next, else any series here.
  const anchorId = wrapped?.topSeries?.[0]?.id ?? home?.onDeck?.[0]?.seriesId ?? rnd?.seriesId ?? undefined;

  const saveGoal = async (n: number) => {
    if (!n || n < 1) return;
    setGoalOpen(false);
    try {
      await api('/api/settings', { method: 'PUT', json: { weeklyGoal: n } });
      qc.invalidateQueries({ queryKey: ['stats'] });
    } catch (e: any) { toast(msgOf(e, tr('Could not change that')), 'error'); }
  };

  // Each row's line says what is on the page; the settings pages' say what is set (components/ProfileSettings.tsx). You
  // and Insights lead the list as pictures: your latest covers, and the last four weeks of your reading.
  const views: Record<string, PageView> = {
    you: { icon: <IcUser width={18} height={18} />, tint: 'bg-accent/20 text-accent',
      summary: tr('Your week, badges and lists'), ownHeader: true,
      tile: <CoverFan ids={shelf.ids} fallback={anchorId} />, pane: <YouBoard history={history?.content} /> },
    insights: { icon: <IcChart width={18} height={18} />, tint: 'bg-emerald-500/20 text-emerald-300',
      summary: tr('What your reading adds up to'), tile: <ActivityBars days={stats?.byDay ?? []} />, pane: <ProfileInsights /> },
    ...settings.views,
    connections: { icon: <IcLink width={18} height={18} />, tint: 'bg-cyan-500/15 text-cyan-300',
      summary: tr('Trackers, reading apps and API tokens'), pane: <ProfileConnections focusTracking={focusTracking} /> },
    // Uchiyomi Desktop has no Account page (the registry's `web`): no password, no 2FA, no other sessions, and the app
    // signs itself in (lib/desktop.ts). `?tab=account` there opens You.
    account: { icon: <IcKey width={18} height={18} />, tint: 'bg-rose-500/15 text-rose-300',
      summary: tr('Password, two-factor and sessions'), pane: <ProfileAccount /> },
  };

  return (
    <div className="min-h-screen-d px-4 lg:px-0" data-profile-console>
      <ConsoleLayout index={PROFILE_SETTINGS} label={tr('Profile')} views={views} home="you"
        conds={{ web: !desktop, 'local-accounts': true, extensions: false, pointer: settings.pointer }}
        hero={(mode) => (
          <ProfileHero mode={mode} stats={stats} anchorId={anchorId} onDeckBook={home?.onDeck?.[0]?.id} shelf={shelf}
            onGoal={() => setGoalOpen(true)} onQuickGoal={saveGoal} />
        )}
        art={anchorId ? <Backdrop seriesId={anchorId} hero className="absolute inset-0" /> : null}
        footer={<FootRows isAdmin={isAdmin} />} />
      {goalOpen && (
        <GoalModal current={stats?.weeklyGoal ?? 0} onClose={() => setGoalOpen(false)} onSave={saveGoal} />
      )}
    </div>
  );
}

/**
 * The person, cinematic: the art of what they read most this year, who they are, how the reading goes, the weekly goal
 * and the counts, what to do next, and ninety days of it as the floor. `full` above You (and above the list on a
 * phone); `band` above every other page on a computer -- the same art and numbers in one row, the name as its title
 * ("Welcome to Uchiyomi" over Account read oddly), so a settings page is not pushed below the fold. The weekly goal's
 * one home since v0.86.0 (`id="weekly-goal"`, which search lands on) is in both.
 *
 * ONE tree for both: the art stays mounted from one mode to the other, where two trees reloaded it and faded it in on
 * every page switch. And in the flow: the full hero is as tall as what it holds and never shorter than its share of the
 * screen. Absolutely placed and bottom-aligned, as it was until v0.88.0, a longer language clipped the name and the
 * headline off its top.
 */
function ProfileHero({ mode, stats, anchorId, onDeckBook, shelf, onGoal, onQuickGoal }: {
  mode: 'full' | 'band';
  stats?: Stats;
  anchorId?: string;
  onDeckBook?: string;
  shelf: { ids: string[]; titles: string[]; label: string };
  onGoal: () => void;
  onQuickGoal: (n: number) => void;
}) {
  const { user } = useAuth();
  // Both settings, both hooks on every render (components/Toast.tsx says why).
  const plain = useReduceEffects();
  const still = useReducedMotion();
  const reduced = plain || !!still;
  // The single worst string on the old page was an <h1> reading "Your reading". A person's own name, or the
  // handle they log in with -- never a label describing the page they are already looking at.
  const name = user
    ? user.displayName && user.displayName !== 'me'
      ? user.displayName
      : user.username
        ? `@${user.username}`
        : user.displayName
    : '';
  const streak = stats?.currentStreak ?? 0;
  const best = stats?.longestStreak ?? 0;
  const read = stats?.chapters_completed ?? 0;
  const lastRead = stats?.last_read_at ? tr('Last read {when}', { when: relativeTime(stats.last_read_at) }) : '';
  const headline = streak > 0 ? tr('{n} day streak', { n: streak })
    : read > 0 ? tr('Pick up where you left off')
    : tr('Welcome to Uchiyomi');
  const sub = streak > 0 ? (best > streak ? tr('Best {n} days', { n: best }) : lastRead)
    : read > 0 ? lastRead
    : '';
  const band = mode === 'band';
  const rise = (delay = 0) => ({
    initial: reduced ? false as const : { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    transition: reduced ? { duration: 0 } : { duration: 0.5, delay, ease: [0.22, 0.61, 0.36, 1] as const },
  });

  // Uppercase labels: spaced in Latin, never in Arabic, whose letters join (`rtl:tracking-normal`).
  const label = 'text-[11px] uppercase tracking-wider text-fog-400 rtl:tracking-normal';
  const pill = band ? 'px-3 py-1.5' : 'px-3 py-1.5 lg:px-3.5 lg:py-2';
  const pills = (
    <motion.dl className={band ? 'flex flex-wrap items-center gap-2' : 'mt-4 flex flex-wrap items-center gap-2'} {...rise(0.08)}>
      {!stats ? (
        // <div>, not <span>: a <dl> may only hold <div> and dt/dd groups.
        <>
          <div className="skeleton h-10 w-24 rounded-lg" />
          <div className="skeleton h-10 w-24 rounded-lg" />
          <div className="skeleton h-10 w-24 rounded-lg" />
        </>
      ) : stats.weeklyGoal > 0 ? (
        // `id`: the weekly goal's one home since v0.86.0 (search's Weekly goal lands here, lib/destinations.ts).
        <div id="weekly-goal" className={`glass relative inline-flex items-center gap-2 rounded-full ${pill}`}>
          {/* The whole pill opens the goal dialog. The button stretches over the pill with an
              ::after rather than wrapping it, so <dt>/<dd> stay direct children of a <div> in
              the <dl> instead of being buried in a <button>. */}
          <button onClick={onGoal} aria-label={tr('Weekly goal')}
            className="after:absolute after:inset-0 after:rounded-full">
            <GoalRing value={stats.weekChapters} goal={stats.weeklyGoal} size={band ? 32 : 40} />
          </button>
          <dt className={label}>{tr('Weekly goal')}</dt>
          <dd className="sr-only">{stats.weekChapters}/{stats.weeklyGoal}</dd>
        </div>
      ) : (
        <div id="weekly-goal" className={`glass inline-flex flex-wrap items-center gap-2 rounded-full ${pill}`}>
          <dt className={label}>{tr('Weekly goal')}</dt>
          {/* flex-wrap, because three chips at their 98px min-content are what tipped a 390px
              phone into horizontal overflow. */}
          <dd className="flex flex-wrap gap-1.5">
            {[5, 10, 20].map((n) => (
              <button key={n} onClick={() => onQuickGoal(n)} className="chip px-2.5 py-1 text-xs">{n}</button>
            ))}
          </dd>
        </div>
      )}
      {stats && (
        <>
          <div className={`glass inline-flex items-baseline gap-2 rounded-full ${pill}`}>
            <dd className="font-display text-lg font-bold tabular-nums text-fog-50">{compact(stats.chapters_completed)}</dd>
            <dt className={label}>{tr('Chapters')}</dt>
          </div>
          <div className={`glass inline-flex items-baseline gap-2 rounded-full ${pill}`}>
            <dd className="font-display text-lg font-bold tabular-nums text-fog-50">{compact(stats.series_touched)}</dd>
            <dt className={label}>{tr('Series')}</dt>
          </div>
        </>
      )}
    </motion.dl>
  );

  return (
    <header data-profile-hero={mode} className="bleed relative isolate mb-6 overflow-hidden lg:mt-2 lg:rounded-3xl">
      {anchorId && (
        <motion.div className="absolute inset-0"
          initial={reduced ? false : { opacity: 0, scale: 1.06 }} animate={{ opacity: 1, scale: 1 }}
          transition={reduced ? { duration: 0 } : { duration: 0.9, ease: [0.22, 1, 0.36, 1] }}>
          <Backdrop seriesId={anchorId} hero className="absolute inset-0" />
        </motion.div>
      )}
      {/* the `via` stop at 72% was here and never rendered -- v3's opacity scale is multiples of 5, so it matched
          nothing. v4 would honour it and darken this scrim; keeping the two stops that always applied
          keeps the page looking the way it has shipped. */}
      <div aria-hidden className="absolute inset-0 bg-linear-to-t from-ink-950 to-ink-950/30" />
      <div aria-hidden className="absolute inset-0 bg-linear-to-r from-ink-950/85 via-ink-950/30 to-transparent rtl:bg-linear-to-l" />
      {/* A CSS radial has no logical direction keyword, so the anchor comes from --start, which flips to
          100% under dir="rtl". Tailwind's rtl: variant cannot mirror a gradient position. */}
      <div aria-hidden className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(70% 110% at var(--start) 100%, rgb(var(--accent) / 0.26), transparent 62%)' }} />

      {band ? (
        <div className="relative">
          <div className="bleed-pad flex flex-wrap items-center justify-between gap-x-8 gap-y-3 pb-4 pt-6">
            <motion.div className="flex min-w-0 items-center gap-3" {...rise()}>
              <Avatar avatar={user?.avatar} size={44} />
              <div className="min-w-0">
                <h1 className="truncate font-display text-2xl font-bold leading-tight text-fog-50 [text-shadow:0_2px_16px_rgba(0,0,0,0.6)]">{name}</h1>
                <p className="truncate text-sm text-fog-300">{headline}</p>
              </div>
            </motion.div>
            {pills}
          </div>
          {/* The floor, thinner: ninety days still under every page. */}
          <TraceStrip days={stats?.byDay ?? []} className="h-8! shrink-0 lg:h-10!" />
        </div>
      ) : (
        // Never shorter than its share of the screen (taller than 46vh on a phone, where the identity ladder, the fact
        // pills and four verbs need it), taller when a language needs more: the art grows with it, nothing is cut.
        <div className="relative flex min-h-[max(360px,56svh)] flex-col justify-end pt-[max(1.5rem,calc(env(safe-area-inset-top)+1rem))] lg:min-h-[min(420px,52vh)] xl:min-h-[min(460px,56vh)]">
          <div className="bleed-pad pb-4 lg:pb-6">
            <div className="lg:flex lg:items-end lg:justify-between lg:gap-10">
              <motion.div className="min-w-0 lg:max-w-2xl" {...rise()}>
                <div className="flex items-center gap-3">
                  <Avatar avatar={user?.avatar} size={44} />
                  <p className="truncate font-display text-sm font-semibold text-fog-100">{name}</p>
                </div>
                <h1 className="mt-2 font-display text-3xl font-bold leading-tight text-fog-50 [text-shadow:0_2px_16px_rgba(0,0,0,0.6)] lg:text-5xl">{headline}</h1>
                {sub && <p className="mt-1 text-xs text-fog-400">{sub}</p>}
                {pills}
                <div className="mt-4 flex flex-wrap gap-2">
                  {onDeckBook ? (
                    <Link href={`/reader/?book=${encodeURIComponent(onDeckBook)}`} className="btn-accent px-5 py-2.5 text-sm">
                      <IcPlay width={16} height={16} />{tr('Keep reading')}
                    </Link>
                  ) : (
                    <Link href="/library/" className="btn-accent px-5 py-2.5 text-sm">
                      <IcPlay width={16} height={16} />{tr('Browse library')}
                    </Link>
                  )}
                  <Link href="/history/" className="btn-ghost px-5 py-2.5 text-sm">
                    <IcRefresh width={16} height={16} />{tr('Reading history')}
                  </Link>
                  <Link href="/moments" className="btn-ghost px-5 py-2.5 text-sm">
                    <IcMoments width={16} height={16} />{tr('Moments')}
                  </Link>
                  <Link href="/wrapped/" className="btn-ghost px-5 py-2.5 text-sm">
                    <IcSparkle width={16} height={16} />{tr('Your Uchiyomi Wrapped')}
                  </Link>
                </div>
              </motion.div>

              {/* Desktop only. A 96px shelf plus its label cannot share a phone hero with the name, the
                  headline, three pills and three verbs.
                  `min-w-0` and NOT `shrink-0`: twelve overlapped 96px spines are 888px of max-content that
                  cannot shrink, and beside a `min-w-0` text column the flex algorithm hands the shelf all
                  of it -- the text column was once 32px wide at 1024. It only becomes a shelf at xl. */}
              <div className="hidden min-w-0 xl:block xl:max-w-[46%]">
                <SpineWall ids={shelf.ids} titles={shelf.titles} label={shelf.label} />
              </div>
            </div>
          </div>
          {/* The floor: 90 days, full width. Renders an empty box while stats load, so nothing shifts.
              `shrink-0` because it is a flex item: without it the trace is the first thing the column
              crushes when the content above it grows, and it measured exactly 0px tall between 1024 and
              1280 -- gone, silently, with nothing overflowing for a test to notice. */}
          <TraceStrip days={stats?.byDay ?? []} className="shrink-0" />
        </div>
      )}
    </header>
  );
}

/**
 * You's tile: the three covers you held last, fanned like books picked up off a table, spreading as the tile lifts
 * under the pointer (its `hover` state, handed down by the tile, components/ConsoleLayout.tsx). A new account's are the
 * newest series here, and with none of those, the hero's own art. The fan is symmetric, so it needs no mirroring in
 * Arabic: it sits at the inline end and spreads both ways.
 */
function CoverFan({ ids, fallback }: { ids: string[]; fallback?: string }) {
  const picks = (ids.length ? ids : fallback ? [fallback] : []).slice(0, 3);
  // Back to front: the newest on top, in the middle.
  const at = picks.length === 1 ? [0] : picks.length === 2 ? [-1, 1] : [-1, 1, 0];
  return (
    <span className="absolute inset-0">
      {/* The accent behind the books, so the tile glows before a cover has loaded. */}
      <span className="absolute inset-0" style={{ background: 'radial-gradient(90% 90% at 50% 20%, rgb(var(--accent) / 0.35), transparent 70%)' }} />
      {picks.map((id, i) => {
        const slot = at[i];
        return (
          <motion.span key={`${id}-${i}`}
            className="absolute end-[18%] top-3 block aspect-[2/3] w-[30%] max-w-24 overflow-hidden rounded-lg shadow-xl shadow-black/60 ring-1 ring-white/10 @min-[52.5rem]/console:top-2.5 @min-[52.5rem]/console:w-[25%]"
            style={{ transformOrigin: '50% 110%', zIndex: slot === 0 ? 3 : 2 - i }}
            variants={{
              enter: { rotate: 0, x: '0%', opacity: 0 },
              rest: { rotate: slot * 9, x: `${slot * 34}%`, opacity: 1, transition: { duration: 0.5, delay: 0.15 + i * 0.06, ease: [0.22, 0.61, 0.36, 1] } },
              hover: { rotate: slot * 14, x: `${slot * 44}%`, transition: { duration: 0.25 } },
            }}>
            <Img src={img.seriesThumb(id)} alt="" className="h-full w-full" imgClassName="h-full w-full object-cover" />
          </motion.span>
        );
      })}
    </span>
  );
}

/**
 * Insights' tile: the last four weeks of reading as bars, the latest week in full accent and the three before it dimmed,
 * as the hero's floor draws them (components/TraceStrip.tsx). Each bar grows in once. One pixel between bars: 28 of
 * them share a tile half a 17rem rail wide.
 */
function ActivityBars({ days }: { days: { day: string; chapters: number }[] }) {
  const plain = useReduceEffects();
  const still = useReducedMotion();
  const reduced = plain || !!still;
  const last = days.slice(-28);
  const max = Math.max(1, ...last.map((d) => d.chapters));
  return (
    <span className="absolute inset-0">
      <span className="absolute inset-0" style={{ background: 'radial-gradient(90% 90% at 50% 15%, rgb(16 185 129 / 0.22), transparent 70%)' }} />
      <span className="absolute inset-x-3 top-4 flex h-[45%] items-end gap-px">
        {last.map((d, i) => (
          <motion.span key={d.day} className="min-w-0 flex-1 rounded-t-[2px]"
            style={{ height: `${Math.max(4, (d.chapters / max) * 100)}%`, background: i >= last.length - 7 ? 'rgb(var(--accent))' : 'rgb(var(--accent) / 0.42)', transformOrigin: '50% 100%' }}
            initial={reduced ? false : { scaleY: 0 }} animate={{ scaleY: 1 }}
            transition={reduced ? { duration: 0 } : { duration: 0.5, delay: 0.2 + i * 0.012, ease: [0.22, 0.61, 0.36, 1] }} />
        ))}
      </span>
    </span>
  );
}

/**
 * You: the household's week, your badges, the reading studio and your lists. The hero above says who and how; this is
 * what it adds up to with the people you read beside.
 */
function YouBoard({ history }: { history?: HistoryRow[] }) {
  const { user } = useAuth();
  const { data: stats } = useQuery({ queryKey: ['stats'], queryFn: () => api<Stats>('/api/stats') });
  const { data: lb } = useQuery({ queryKey: ['leaderboard'], queryFn: () => api<{ content: LeaderRow[] }>('/api/leaderboard') });
  // Your own finished-this-week covers, for HouseBoard's solo variant. Sourced from YOUR history, never from
  // /api/leaderboard: that endpoint has no per-user scoping, so a cover on it would be a broadcast.
  const week = useMemo(() => {
    const cutoff = Date.now() - 7 * 86_400_000;
    const seen = new Set<string>();
    const ids: string[] = [];
    // The titles come along for the ride: a cover id cannot name a link, and without them every spine in
    // the solo card announces itself as the literal word "Series" to a screen reader. The rows already
    // carry the title.
    const titles: string[] = [];
    for (const r of history ?? []) {
      if (!r.completed || !r.series_id || seen.has(r.series_id)) continue;
      if (new Date(r.created_at).getTime() < cutoff) continue;
      seen.add(r.series_id);
      ids.push(r.series_id);
      titles.push(r.series_title);
      if (ids.length === 8) break;
    }
    return { ids, titles };
  }, [history]);
  // Every row is wide + 1, so the auto-fill columns pair up.
  return (
    <div className="board">
      <HouseBoard span="wide" members={lb?.content ?? []} youId={user?.id ?? ''} weekCovers={week.ids} weekTitles={week.titles} />
      <BadgesCard stats={stats} />
      <StudioCard span="wide" />
      <ListsCard />
    </div>
  );
}

/**
 * Admin, Support and Sign out: the foot of the list, rows like the pages above them in a card of their own. Admin has no
 * other door on this page; Support is asking for something rather than offering something, so it stays quiet -- no
 * accent, the cup carries the colour on its own; Sign out is the app's destructive red (and also a row on Account).
 */
function FootRows({ isAdmin }: { isAdmin: boolean }) {
  const { logout } = useAuth();
  return (
    <div className="card grad-border overflow-hidden rounded-2xl p-1.5" data-console-foot>
      {isAdmin && <ConsoleFootRow href="/admin/" icon={<IcSettings width={18} height={18} />} label={tr('Admin')} />}
      <ConsoleFootRow href="https://ko-fi.com/angeloshaheen" external
        icon={<span className="text-base leading-none">☕</span>} label={tr('Support Uchiyomi')} />
      {/* Not on desktop: the app signs itself back in at once, so "Sign out" there would do nothing visible. */}
      {!isDesktop() && <ConsoleFootRow onClick={logout} icon={<IcLogOut width={18} height={18} />} label={tr('Sign out')} tone="danger" />}
    </div>
  );
}

/**
 * How many chapters a week you are aiming for.
 *
 * This was `window.prompt()`, which cannot be translated, is styled by the browser, and is suppressed
 * outright in some standalone PWA contexts -- so on an installed app the goal was simply unsettable.
 */
function GoalModal({ current, onClose, onSave }: { current: number; onClose: () => void; onSave: (n: number) => void }) {
  const [value, setValue] = useState(String(current || 10));
  const n = Number(value);
  return (
    <Modal title={tr('Weekly goal')} onClose={onClose}>
      <div className="flex flex-wrap gap-1.5">
        {[5, 10, 20].map((q) => (
          <button key={q} onClick={() => setValue(String(q))}
            className={`chip text-xs ${n === q ? 'chip-active' : ''}`}>{q}</button>
        ))}
      </div>
      <label className="mt-3 block text-xs text-fog-400" htmlFor="weekly-goal-input">{tr('Chapters')}</label>
      <input id="weekly-goal-input" type="number" inputMode="numeric" min={1} value={value}
        onChange={(e) => setValue(e.target.value)} className="field mt-1" />
      <div className="mt-4 flex gap-2">
        <button onClick={onClose} className="btn-ghost flex-1 py-2 text-sm">{tr('Cancel')}</button>
        <button onClick={() => onSave(n)} disabled={!n || n < 1} className="btn-accent flex-1 py-2 text-sm disabled:opacity-50">{tr('Save')}</button>
      </div>
    </Modal>
  );
}

