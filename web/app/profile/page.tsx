'use client';
import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { motion, useReducedMotion } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { relativeTime } from '@/lib/format';
import { useSectionArrival } from '@/lib/useSectionArrival';
import { Avatar } from '@/components/Avatar';
import { ConsoleFootRow, ConsoleLayout, type PageView } from '@/components/ConsoleLayout';
import { HouseBoard } from '@/components/HouseBoard';
import { SpineWall } from '@/components/SpineWall';
import { TraceStrip } from '@/components/TraceStrip';
import { Modal, msgOf } from '@/components/ConfirmDialog';
import { Backdrop } from '@/components/ui';
import { useToast } from '@/components/Toast';
import { IcSparkle, IcPlay, IcRefresh, IcSettings, IcLogOut, IcMoments, IcUser, IcChart, IcLink, IcKey, IcPlus } from '@/components/icons';
import { BadgesCard, ListsCard, StudioCard, type Stats } from '@/components/ProfileYou';
import { ProfileInsights } from '@/components/ProfileInsights';
import { useProfileSettingsViews } from '@/components/ProfileSettings';
import { ProfileConnections } from '@/components/ProfileConnections';
import { ProfileAccount } from '@/components/ProfileAccount';
import { PROFILE_SETTINGS } from '@/lib/settingsIndex.profile';
import { t as tr } from '@/lib/i18n';
import { isDesktop } from '@/lib/desktop';

/**
 * The profile console (v0.88.0): ONE grouped list -- your card, then You and Insights, then Settings: General,
 * Appearance, Reading, This device, Connections and Account -- beside the page on screen, or before it on a phone
 * (components/ConsoleLayout.tsx). Admin, Support and Sign out are its foot.
 *
 * You is the person (the household's week, badges, the reading studio, lists); Insights is what their reading adds up to
 * (v0.75.0, from #249); the Settings group is how the app behaves for them, Connections everything that talks to another
 * service (trackers, OPDS readers, API tokens), and Account who they are here (password, 2FA, sessions, sign out).
 *
 * Until v0.88.0 these were five tabs under a hero that took the top of every one of them, and Settings four categories
 * under its tab: "a tab under a tab", with Connections "not under anything" (the owner, 2026-10-19). The hero is You's
 * own now, and the person's name, weekly goal and counts are the card at the top of the list.
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
  const { data: stats } = useQuery({ queryKey: ['stats'], queryFn: () => api<Stats>('/api/stats') });

  const saveGoal = async (n: number) => {
    if (!n || n < 1) return;
    setGoalOpen(false);
    try {
      await api('/api/settings', { method: 'PUT', json: { weeklyGoal: n } });
      qc.invalidateQueries({ queryKey: ['stats'] });
    } catch (e: any) { toast(msgOf(e, tr('Could not change that')), 'error'); }
  };

  // Each row's line says what is on the page; the settings pages' say what is set (components/ProfileSettings.tsx).
  const views: Record<string, PageView> = {
    you: { icon: <IcUser width={18} height={18} />, tint: 'bg-accent/15 text-accent',
      summary: tr('Your week, badges and lists'), ownHeader: true, pane: <YouPage stats={stats} /> },
    insights: { icon: <IcChart width={18} height={18} />, tint: 'bg-emerald-500/15 text-emerald-300',
      summary: tr('What your reading adds up to'), pane: <ProfileInsights /> },
    ...settings.views,
    connections: { icon: <IcLink width={18} height={18} />, tint: 'bg-cyan-500/15 text-cyan-300',
      summary: tr('Trackers, reading apps and API tokens'), pane: <ProfileConnections focusTracking={focusTracking} /> },
    // Uchiyomi Desktop has no Account page (the registry's `web`): no password, no 2FA, no other sessions, and the app
    // signs itself in (lib/desktop.ts). `?tab=account` there opens You.
    account: { icon: <IcKey width={18} height={18} />, tint: 'bg-rose-500/15 text-rose-300',
      summary: tr('Password, two-factor and sessions'), pane: <ProfileAccount /> },
  };

  return (
    <div className="min-h-screen-d px-4 pt-[max(0.9rem,calc(env(safe-area-inset-top)+0.5rem))] lg:px-0 lg:pt-6" data-profile-console>
      <ConsoleLayout index={PROFILE_SETTINGS} label={tr('Profile')} views={views} home="you"
        conds={{ web: !desktop, 'local-accounts': true, extensions: false, pointer: settings.pointer }}
        card={<ProfileCard stats={stats} onGoal={() => setGoalOpen(true)} />}
        footer={<FootRows isAdmin={isAdmin} />} />
      {goalOpen && (
        <GoalModal current={stats?.weeklyGoal ?? 0} onClose={() => setGoalOpen(false)} onSave={saveGoal} />
      )}
    </div>
  );
}

/**
 * The person, at the top of the list: who is signed in, this week against the goal, and what it all adds up to. In the
 * rail on a computer, the first thing on a phone. The weekly goal's one home (v0.86.0; the palette's Weekly goal lands
 * on it): the ring opens its dialog, and with no goal yet a plus says there is one to set.
 */
function ProfileCard({ stats, onGoal }: { stats?: Stats; onGoal: () => void }) {
  const { user } = useAuth();
  // A person's own name, or the handle they log in with -- never a label describing the page they are already looking
  // at (the old page's <h1> read "Your reading").
  const name = user
    ? user.displayName && user.displayName !== 'me'
      ? user.displayName
      : user.username
        ? `@${user.username}`
        : user.displayName
    : '';
  const streak = stats?.currentStreak ?? 0;
  const line = streak > 0 ? tr('{n} day streak', { n: streak })
    : stats?.last_read_at ? tr('Last read {when}', { when: relativeTime(stats.last_read_at) })
    : '';
  const cell = 'flex min-w-0 flex-col items-center gap-1 rounded-xl px-1 py-2 text-center';
  return (
    <div data-profile-card className="card grad-border relative isolate overflow-hidden rounded-2xl p-4">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10"
        style={{ background: 'radial-gradient(90% 120% at var(--start) 0%, rgb(var(--accent) / 0.22), transparent 65%)' }} />
      <div className="flex items-center gap-3">
        <Avatar avatar={user?.avatar} size={44} />
        <div className="min-w-0">
          <h1 className="truncate font-display text-lg font-bold leading-tight text-fog-50">{name}</h1>
          {line && <p className="truncate text-[12px] text-fog-400">{line}</p>}
        </div>
      </div>
      {/* <div>s inside the <dl>, never <span>s: a <dl> may only hold <div> and dt/dd groups. */}
      <dl className="mt-3 grid grid-cols-3 gap-1">
        <div>
          <dt className="sr-only">{tr('Weekly goal')}</dt>
          <dd>
            <button id="weekly-goal" type="button" onClick={onGoal} aria-label={tr('Weekly goal')}
              className={`${cell} w-full transition hover:bg-ink-800/60`}>
              {!stats ? <span className="skeleton size-9 rounded-full" />
                : stats.weeklyGoal > 0 ? <GoalRing value={stats.weekChapters} goal={stats.weeklyGoal} size={36} />
                : <span className="grid size-9 place-items-center rounded-full border-2 border-dashed border-fog-600 text-fog-400"><IcPlus width={16} height={16} /></span>}
              <span aria-hidden className="text-[11px] text-fog-500">
                {stats && stats.weeklyGoal > 0 ? `${stats.weekChapters}/${stats.weeklyGoal}` : tr('Weekly goal')}
              </span>
            </button>
          </dd>
        </div>
        {[
          { label: tr('Chapters'), value: stats?.chapters_completed },
          { label: tr('Series'), value: stats?.series_touched },
        ].map((f) => (
          <div key={f.label} className={cell}>
            <dd className="grid h-9 place-items-center font-display text-xl font-bold tabular-nums text-fog-50">
              {typeof f.value === 'number' ? compact(f.value) : <span className="skeleton h-6 w-10 rounded-md" />}
            </dd>
            <dt className="text-[11px] text-fog-500">{f.label}</dt>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * You: the hero -- what to do next, over the art of what you read most this year -- and the household's week, your
 * badges, the reading studio and your lists under it. The hero is this page's own since v0.88.0: it used to sit above
 * every tab, so on a phone each of them opened on a screen of it.
 */
function YouPage({ stats }: { stats?: Stats }) {
  const { user } = useAuth();
  const still = useReducedMotion();
  const year = new Date().getFullYear();
  const { data: lb } = useQuery({ queryKey: ['leaderboard'], queryFn: () => api<{ content: LeaderRow[] }>('/api/leaderboard') });
  const { data: home } = useQuery({ queryKey: ['home'], queryFn: () => api<HomePayload>('/api/home') });
  const { data: history } = useQuery({ queryKey: ['history', 60], queryFn: () => api<{ content: HistoryRow[] }>('/api/history?limit=60') });
  const { data: wrapped } = useQuery({ queryKey: ['wrapped', year], queryFn: () => api<Wrapped>(`/api/wrapped?year=${year}`), staleTime: 30 * 60_000 });
  // Last-resort hero art, so a library with series but no reading still opens washed in its own covers.
  const { data: rnd } = useQuery({ queryKey: ['profile-hero-art'], queryFn: () => api<{ seriesId: string | null }>('/api/random'), staleTime: 30 * 60_000 });

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

  return (
    <>
      <header data-profile-hero className="relative isolate mb-6 overflow-hidden rounded-3xl">
        {anchorId && (
          <motion.div className="absolute inset-0 -z-10"
            initial={still ? false : { opacity: 0, scale: 1.06 }} animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}>
            <Backdrop seriesId={anchorId} hero className="absolute inset-0" />
          </motion.div>
        )}
        <div aria-hidden className="absolute inset-0 -z-10 bg-linear-to-t from-ink-950 to-ink-950/30" />
        <div aria-hidden className="absolute inset-0 -z-10 bg-linear-to-r from-ink-950/85 via-ink-950/30 to-transparent rtl:bg-linear-to-l" />
        {/* A CSS radial has no logical direction keyword, so the anchor comes from --start, which flips to
            100% under dir="rtl". Tailwind's rtl: variant cannot mirror a gradient position. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10"
          style={{ background: 'radial-gradient(70% 110% at var(--start) 100%, rgb(var(--accent) / 0.26), transparent 62%)' }} />

        {/* In the flow, over a floor of art: the hero is as tall as what it holds, and never shorter than enough of the
            art to read as a picture. Absolutely placed and bottom-aligned, as it was, anything that did not fit was
            clipped off its top -- the name and the headline went first. */}
        <div className="flex min-h-[min(22rem,52vh)] flex-col justify-end pt-24">
          <div className="flex items-end justify-between gap-10 px-4 pb-4 lg:px-8 lg:pb-6">
            <motion.div className="min-w-0 max-w-2xl"
              initial={still ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: [0.22, 0.61, 0.36, 1] }}>
              <p className="font-display text-3xl font-bold leading-tight text-fog-50 [text-shadow:0_2px_16px_rgba(0,0,0,0.6)] @min-[48rem]/pane:text-4xl">{headline}</p>
              {sub && <p className="mt-1 text-xs text-fog-400">{sub}</p>}
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

            {/* Only where the page is wide enough. `min-w-0` and NOT `shrink-0`: twelve overlapped 96px spines are 888px
                of max-content that cannot shrink, and beside a `min-w-0` text column the flex algorithm hands the shelf
                all of it -- the text column was once 32px wide. The pane's width decides, never the window's: the list
                beside it takes 19rem of a computer's screen. */}
            <div className="hidden min-w-0 @min-[56rem]/pane:block @min-[56rem]/pane:max-w-[46%]">
              <SpineWall ids={shelf.ids} titles={shelf.titles} label={shelf.label} />
            </div>
          </div>
          {/* The floor: 90 days, full width. Renders an empty box while stats load, so nothing shifts. */}
          <TraceStrip days={stats?.byDay ?? []} className="shrink-0" />
        </div>
      </header>

      {/* Every row is wide + 1, so the auto-fill columns pair up. */}
      <div className="board">
        <HouseBoard span="wide" members={lb?.content ?? []} youId={user?.id ?? ''} weekCovers={week.ids} weekTitles={week.titles} />
        <BadgesCard stats={stats} />
        <StudioCard span="wide" />
        <ListsCard />
      </div>
    </>
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
