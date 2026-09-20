'use client';
import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { motion, useReducedMotion } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { relativeTime } from '@/lib/format';
import { useTabParam } from '@/lib/useTabParam';
import { Avatar } from '@/components/Avatar';
import { ConsoleNav } from '@/components/ConsoleNav';
import { HouseBoard } from '@/components/HouseBoard';
import { SpineWall } from '@/components/SpineWall';
import { TraceStrip } from '@/components/TraceStrip';
import { Modal, msgOf } from '@/components/ConfirmDialog';
import { Backdrop } from '@/components/ui';
import { useToast } from '@/components/Toast';
import { IcSparkle, IcChevronRight, IcPlay, IcRefresh, IcSettings, IcLogOut, IcMoments } from '@/components/icons';
import { BadgesCard, ListsCard, StudioCard, type Stats } from '@/components/ProfileYou';
import { ProfileSettings } from '@/components/ProfileSettings';
import { ProfileConnections } from '@/components/ProfileConnections';
import { ProfileAccount } from '@/components/ProfileAccount';
import { t as tr, keys } from '@/lib/i18n';

/**
 * One group, four entries, so `flat` drops the group eyebrow and the phone group sheet: profile has an index,
 * not an information architecture. The seventeen sections underneath used to be one 5000px column.
 *
 * You is the person (badges, the reading studio, lists); Settings is how the app behaves for them
 * (appearance, reader defaults, downloads, this device); Connections is everything that talks to another
 * service (trackers, OPDS readers, API tokens); Account is who they are here (password, 2FA, sessions,
 * sign out). Until v0.39.0 the second tab was "Reading" and held device settings plus one chart, Settings
 * held two cards, and Account held eight -- the same identity shown three times and the secrets behind
 * three identical "Manage" chips.
 */
const PROFILE_GROUPS = [
  // `keys()` is the identity function; it exists so these reach the translation extractor. ConsoleNav
  // renders them as `tr(tab)`, which a scan for inline tr() calls cannot see. See lib/i18n.ts.
  { id: 'you', label: 'You', tabs: keys('You', 'Settings', 'Connections', 'Account') },
] as const;
const PROFILE_TABS = PROFILE_GROUPS[0].tabs;
type Tab = (typeof PROFILE_TABS)[number];

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
 * `useSearchParams` needs a Suspense boundary above it in a statically exported app (the import page does
 * the same), so the page proper is one level down. `?tab=Connections` opens that tab, and `&card=tracking`
 * scrolls its Progress tracking section into view: the import page's tracker line sends people to that
 * section -- without the query every link to "Profile" landed on You, a tab away from the thing it pointed
 * at, and with the tab alone the section could sit below the fold at phone width, under the hero and the
 * rail. `?tab=` alone still just opens the tab, and every tab tap writes it back (lib/useTabParam.ts), so
 * a refresh, the back button and a language change all keep the tab.
 */
export default function ProfilePage() {
  return (
    <Suspense fallback={<div className="min-h-screen-d" />}>
      <ProfileInner />
    </Suspense>
  );
}

function ProfileInner() {
  const { user, isAdmin } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const still = useReducedMotion();
  const params = useSearchParams();
  const [tab, setTab] = useTabParam<Tab>(PROFILE_TABS, 'You');
  // Read once: the card is scrolled to on arrival, never again on a re-render or a tab change.
  const [focusTracking] = useState<boolean>(() => params.get('card') === 'tracking');
  const [goalOpen, setGoalOpen] = useState(false);

  const year = new Date().getFullYear();
  const { data: stats } = useQuery({ queryKey: ['stats'], queryFn: () => api<Stats>('/api/stats') });
  const { data: lb } = useQuery({ queryKey: ['leaderboard'], queryFn: () => api<{ content: LeaderRow[] }>('/api/leaderboard') });
  const { data: home } = useQuery({ queryKey: ['home'], queryFn: () => api<HomePayload>('/api/home') });
  const { data: history } = useQuery({ queryKey: ['history', 60], queryFn: () => api<{ content: HistoryRow[] }>('/api/history?limit=60') });
  const { data: wrapped } = useQuery({ queryKey: ['wrapped', year], queryFn: () => api<Wrapped>(`/api/wrapped?year=${year}`), staleTime: 30 * 60_000 });
  // Last-resort hero art, so a library with series but no reading still opens washed in its own covers.
  const { data: rnd } = useQuery({ queryKey: ['profile-hero-art'], queryFn: () => api<{ seriesId: string | null }>('/api/random'), staleTime: 30 * 60_000 });

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
    for (const r of history?.content ?? []) {
      if (!r.completed || !r.series_id || seen.has(r.series_id)) continue;
      if (new Date(r.created_at).getTime() < cutoff) continue;
      seen.add(r.series_id);
      ids.push(r.series_id);
      titles.push(r.series_title);
      if (ids.length === 8) break;
    }
    return { ids, titles };
  }, [history]);

  const anchorId = wrapped?.topSeries?.[0]?.id ?? home?.onDeck?.[0]?.seriesId ?? rnd?.seriesId ?? undefined;
  const onDeckBook = home?.onDeck?.[0]?.id;

  const saveGoal = async (n: number) => {
    if (!n || n < 1) return;
    setGoalOpen(false);
    try {
      await api('/api/settings', { method: 'PUT', json: { weeklyGoal: n } });
      qc.invalidateQueries({ queryKey: ['stats'] });
    } catch (e: any) { toast(msgOf(e, tr('Could not change that')), 'error'); }
  };

  // Only You is a `.board` of cards (every row is wide + 1, so the auto-fill columns pair up). The other
  // three are settings and render their own SETTINGS_GRID: a board of `null`-returning cards reflowed per
  // install, and its `align-items: start` left ragged heights beside each other.
  const panel = tab === 'You' ? (
    <div className="board">
      <HouseBoard span="wide" members={lb?.content ?? []} youId={user?.id ?? ''} weekCovers={week.ids} weekTitles={week.titles} />
      <BadgesCard stats={stats} />
      <StudioCard span="wide" />
      <ListsCard />
    </div>
  ) : tab === 'Settings' ? (
    <ProfileSettings weeklyGoal={stats?.weeklyGoal ?? 0} />
  ) : tab === 'Connections' ? (
    <ProfileConnections focusTracking={focusTracking && tab === 'Connections'} />
  ) : (
    <ProfileAccount />
  );

  return (
    <div className="min-h-screen-d px-4 lg:px-0">
      {/* ---------------------------------- HERO ---------------------------------- */}
      <header className="bleed relative isolate mb-6 overflow-hidden lg:mt-2 lg:rounded-3xl">
        {/* Taller than the spec's 46vh on a phone: the identity ladder, the fact pills and four verbs do not
            fit 388px, and the block is bottom-aligned, so anything that does not fit is clipped off the top. */}
        <div className="relative h-[56vh] min-h-[360px] lg:h-[min(420px,52vh)] xl:h-[min(460px,56vh)]">
          {anchorId && (
            <motion.div className="absolute inset-0"
              initial={still ? false : { opacity: 0, scale: 1.06 }} animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}>
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

          <div className="absolute inset-0 flex flex-col justify-end">
            <div className="px-4 pb-4 lg:px-8 lg:pb-6">
              <div className="lg:flex lg:items-end lg:justify-between lg:gap-10">
                <motion.div className="min-w-0 lg:max-w-2xl"
                  initial={still ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, ease: [0.22, 0.61, 0.36, 1] }}>
                  <div className="flex items-center gap-3">
                    <Avatar avatar={user?.avatar} size={44} />
                    <p className="truncate font-display text-sm font-semibold text-fog-100">{name}</p>
                  </div>
                  <h1 className="mt-2 font-display text-3xl font-bold leading-tight text-fog-50 [text-shadow:0_2px_16px_rgba(0,0,0,0.6)] lg:text-5xl">{headline}</h1>
                  {sub && <p className="mt-1 text-xs text-fog-400">{sub}</p>}

                  <motion.dl className="mt-4 flex flex-wrap items-center gap-2"
                    initial={still ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: still ? 0 : 0.08, ease: [0.22, 0.61, 0.36, 1] }}>
                    {!stats ? (
                      // <div>, not <span>: a <dl> may only hold <div> and dt/dd groups.
                      <>
                        <div className="skeleton h-10 w-24 rounded-lg" />
                        <div className="skeleton h-10 w-24 rounded-lg" />
                        <div className="skeleton h-10 w-24 rounded-lg" />
                      </>
                    ) : stats.weeklyGoal > 0 ? (
                      <div className="glass relative inline-flex items-center gap-2 rounded-full px-3 py-1.5 lg:px-3.5 lg:py-2">
                        {/* The whole pill opens the goal dialog. The button stretches over the pill with an
                            ::after rather than wrapping it, so <dt>/<dd> stay direct children of a <div> in
                            the <dl> instead of being buried in a <button>. */}
                        <button onClick={() => setGoalOpen(true)} aria-label={tr('Weekly goal')}
                          className="after:absolute after:inset-0 after:rounded-full">
                          <GoalRing value={stats.weekChapters} goal={stats.weeklyGoal} size={40} />
                        </button>
                        <dt className="text-[11px] uppercase tracking-wider text-fog-400">{tr('Weekly goal')}</dt>
                        <dd className="sr-only">{stats.weekChapters}/{stats.weeklyGoal}</dd>
                      </div>
                    ) : (
                      <div className="glass inline-flex flex-wrap items-center gap-2 rounded-full px-3 py-1.5 lg:px-3.5 lg:py-2">
                        <dt className="text-[11px] uppercase tracking-wider text-fog-400">{tr('Weekly goal')}</dt>
                        {/* flex-wrap, because three chips at their 98px min-content are what tipped a 390px
                            phone into horizontal overflow. */}
                        <dd className="flex flex-wrap gap-1.5">
                          {[5, 10, 20].map((n) => (
                            <button key={n} onClick={() => saveGoal(n)} className="chip px-2.5 py-1 text-xs">{n}</button>
                          ))}
                        </dd>
                      </div>
                    )}
                    {stats && (
                      <>
                        <div className="glass inline-flex items-baseline gap-2 rounded-full px-3 py-1.5 lg:px-3.5 lg:py-2">
                          <dd className="font-display text-lg font-bold tabular-nums text-fog-50">{compact(stats.chapters_completed)}</dd>
                          <dt className="text-[11px] uppercase tracking-wider text-fog-400">{tr('Chapters')}</dt>
                        </div>
                        <div className="glass inline-flex items-baseline gap-2 rounded-full px-3 py-1.5 lg:px-3.5 lg:py-2">
                          <dd className="font-display text-lg font-bold tabular-nums text-fog-50">{compact(stats.series_touched)}</dd>
                          <dt className="text-[11px] uppercase tracking-wider text-fog-400">{tr('Series')}</dt>
                        </div>
                      </>
                    )}
                  </motion.dl>

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
                    headline, three pills and three verbs without the top being clipped away.
                    `min-w-0` and NOT `shrink-0`: twelve overlapped 96px spines are 888px of max-content that
                    cannot shrink, and beside a `min-w-0` text column the flex algorithm hands the shelf all
                    of it. That left the text column 32px wide at 1024, and because this whole block is
                    `absolute inset-0 justify-end` inside an `overflow-hidden` header, the overflow is
                    clipped off the TOP: the avatar, the name, the headline and the pills all disappeared,
                    with no document overflow for a test to catch. It only becomes a shelf again at xl. */}
                <div className="hidden min-w-0 xl:block xl:max-w-[46%]">
                  <SpineWall ids={shelf.ids} titles={shelf.titles} label={shelf.label} />
                </div>
              </div>
            </div>
            {/* The floor: 90 days, full width. Renders an empty box while stats load, so nothing shifts.
                `shrink-0` because it is a flex item: without it the trace is the first thing the column
                crushes when the content above it grows, and it measured exactly 0px tall between 1024 and
                1280 -- gone, silently, with nothing overflowing for a test to notice. Any locale that adds
                a line to the headline would do the same at any width. */}
            <TraceStrip days={stats?.byDay ?? []} className="shrink-0" />
          </div>
        </div>
      </header>

      {/* ------------------------------ INDEX + PANEL ------------------------------ */}
      {/* The two things people actually come to this page to do were both at the bottom of the Account tab,
          behind a board of eight cards. They belong to the person, not to a panel, so they live on the rail.
          The nav is labelled "Profile", not "You": that was the first tab's name doubling as the name of the
          whole list, which read as "You › You" to a screen reader and in the phone sheet's heading. */}
      <ConsoleNav groups={PROFILE_GROUPS} tab={tab} onTab={setTab} ariaLabel={tr('Profile')} flat
        footer={<RailActions isAdmin={isAdmin} />}>
        {panel}
      </ConsoleNav>

      {goalOpen && (
        <GoalModal current={stats?.weeklyGoal ?? 0} onClose={() => setGoalOpen(false)} onSave={saveGoal} />
      )}
    </div>
  );
}

/**
 * Admin, Support and Sign out, pinned to the console rail.
 *
 * Sign out also has a row on the Account tab; Admin has no other door on this page since v0.39.0 (the art
 * card it used to have on Account said the same thing this rail item says, one tab away). Styled as rail
 * items rather than as buttons so the column still reads as one list, with Sign out in the app's
 * destructive red and set apart from the link above it.
 */
function RailActions({ isAdmin }: { isAdmin: boolean }) {
  const { logout } = useAuth();
  // Two shapes, one markup. On a desktop these are rail rows under the tab list; on a phone the rail does
  // not exist and they sit under the pill row, so they take the pill's shape and wrap instead of stacking
  // three full-width bars above the content.
  const row = 'flex items-center gap-2 rounded-full border border-ink-700 px-3 py-1.5 text-start text-sm transition ' +
    'lg:w-full lg:rounded-lg lg:border-0';
  // Mirrored under RTL like LinkRow's: in Arabic the rail's chevrons pointed away from the door.
  const chev = 'ms-auto hidden shrink-0 opacity-60 lg:block rtl:-scale-x-100';
  return (
    <>
      {isAdmin && (
        <Link href="/admin/" className={`${row} text-fog-400 hover:bg-ink-800/60 hover:text-fog-100`}>
          <IcSettings width={16} height={16} className="shrink-0" />
          <span className="min-w-0 truncate">{tr('Admin')}</span>
          <IcChevronRight width={15} height={15} className={chev} />
        </Link>
      )}
      {/* Promoted out of the bottom of the Account tab, where it sat behind eight cards and a scroll. It is
          asking for something rather than offering something, so it stays quiet: the same row as its
          neighbours, no accent fill, and the cup carries the colour on its own. */}
      <a href="https://ko-fi.com/angeloshaheen" target="_blank" rel="noopener noreferrer"
        className={`${row} text-fog-400 hover:bg-ink-800/60 hover:text-fog-100`}>
        <span aria-hidden className="shrink-0 text-base leading-none">☕</span>
        <span className="min-w-0 truncate">{tr('Support Uchiyomi')}</span>
        <IcChevronRight width={15} height={15} className={chev} />
      </a>
      <button onClick={logout} className={`${row} text-red-300/90 hover:bg-red-500/10 hover:text-red-300`}>
        <IcLogOut width={16} height={16} className="shrink-0" />
        <span className="min-w-0 truncate">{tr('Sign out')}</span>
      </button>
    </>
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
      <label className="mt-3 block text-xs text-fog-400" htmlFor="weekly-goal">{tr('Chapters')}</label>
      <input id="weekly-goal" type="number" inputMode="numeric" min={1} value={value}
        onChange={(e) => setValue(e.target.value)} className="field mt-1" />
      <div className="mt-4 flex gap-2">
        <button onClick={onClose} className="btn-ghost flex-1 py-2 text-sm">{tr('Cancel')}</button>
        <button onClick={() => onSave(n)} disabled={!n || n < 1} className="btn-accent flex-1 py-2 text-sm disabled:opacity-50">{tr('Save')}</button>
      </div>
    </Modal>
  );
}
