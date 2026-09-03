'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { requestPersist, storageEstimate } from '@/lib/downloads';
import { deviceId } from '@/lib/device';
import { bytes, relativeTime } from '@/lib/format';
import { readShownOnce, writeShownOnce } from '@/lib/shownOnce';
import { Avatar, AVATAR_EMOJIS, AVATAR_COLORS } from '@/components/Avatar';
import { PasswordCard, TotpCard, SessionsCard, TokensCard } from '@/components/SecurityPanel';
import { ConsoleNav } from '@/components/ConsoleNav';
import { HouseBoard } from '@/components/HouseBoard';
import { SpineWall } from '@/components/SpineWall';
import { TraceStrip } from '@/components/TraceStrip';
import { SettingsCard } from '@/components/SettingsCard';
import { Switch } from '@/components/Switch';
import { Modal, msgOf } from '@/components/ConfirmDialog';
import { Backdrop, ProgressBar } from '@/components/ui';
import { useToast } from '@/components/Toast';
import { IcDownload, IcSparkle, IcCheck, IcChevronRight, IcPlay, IcRefresh, IcSettings, IcLogOut } from '@/components/icons';
import { t as tr, LOCALES, keys } from '@/lib/i18n';
import { useT } from '@/lib/I18nProvider';

/**
 * One group, four entries, so `flat` drops the group eyebrow and the phone group sheet: profile has an index,
 * not an information architecture. The seventeen sections underneath used to be one 5000px column.
 */
const PROFILE_GROUPS = [
  // `keys()` is the identity function; it exists so these reach the translation extractor. ConsoleNav
  // renders them as `tr(tab)`, which a scan for inline tr() calls cannot see. See lib/i18n.ts.
  { id: 'you', label: 'You', tabs: keys('You', 'Reading', 'Settings', 'Account') },
] as const;
type Tab = (typeof PROFILE_GROUPS)[number]['tabs'][number];

/** Every board card wears the same chrome. `.grad-border` is what makes a wall of dark cards read as a console. */
const CARD = 'card grad-border p-4';

/** 12.3k rather than 12345: six digits overflow a stat pill, and nobody reads the last three anyway. */
const compact = (n: number): string =>
  n < 10_000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`;

function urlB64ToUint8(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// Rendered as `tr(a.name)`, so the names are declared rather than inline. See lib/i18n.ts.
const ACCENT_NAMES = keys('Violet', 'Cyan', 'Emerald', 'Rose', 'Amber', 'Azure');
const ACCENTS = ['#7c5cff', '#22d3ee', '#34d399', '#fb7185', '#f59e0b', '#60a5fa']
  .map((hex, i) => ({ name: ACCENT_NAMES[i], hex }));

interface Stats {
  chapters_completed: number;
  series_touched: number;
  last_read_at: string | null;
  byDay: { day: string; chapters: number }[];
  currentStreak: number;
  longestStreak: number;
  weekChapters: number;
  weeklyGoal: number;
}
interface HistoryRow { series_id: string; series_title: string; completed: boolean; created_at: string }
interface LeaderRow { id: string; display_name: string; avatar?: { emoji?: string; color?: string } | null; week: number; total: number }
interface CollectionRow { id: string; name: string; item_count: number }
interface HomePayload { onDeck: { id: string; seriesId: string }[]; new: { id: string; name: string }[] }
interface Wrapped { topSeries: { id: string; title: string }[] }

// Rendered as `tr(b.label)`, so the labels are declared. See lib/i18n.ts.
const BADGE_LABELS = keys('Reader', 'Bookworm', 'On a roll', 'Centurion', 'Devoted', 'Legend');
const BADGES = [
  { emoji: '📖', label: BADGE_LABELS[0], test: (s: Stats) => s.chapters_completed >= 10 },
  { emoji: '🐛', label: BADGE_LABELS[1], test: (s: Stats) => s.chapters_completed >= 50 },
  { emoji: '🔥', label: BADGE_LABELS[2], test: (s: Stats) => s.longestStreak >= 7 },
  { emoji: '💯', label: BADGE_LABELS[3], test: (s: Stats) => s.chapters_completed >= 100 },
  { emoji: '🌙', label: BADGE_LABELS[4], test: (s: Stats) => s.longestStreak >= 30 },
  { emoji: '👑', label: BADGE_LABELS[5], test: (s: Stats) => s.chapters_completed >= 500 },
];

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

export default function ProfilePage() {
  const { user, isAdmin } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const still = useReducedMotion();
  const [tab, setTab] = useState<Tab>('You');
  const [goalOpen, setGoalOpen] = useState(false);

  const year = new Date().getFullYear();
  const { data: stats } = useQuery({ queryKey: ['stats'], queryFn: () => api<Stats>('/api/stats') });
  const { data: lb } = useQuery({ queryKey: ['leaderboard'], queryFn: () => api<{ content: LeaderRow[] }>('/api/leaderboard') });
  const { data: home } = useQuery({ queryKey: ['home'], queryFn: () => api<HomePayload>('/api/home') });
  const { data: history } = useQuery({ queryKey: ['history', 60], queryFn: () => api<{ content: HistoryRow[] }>('/api/history?limit=60') });
  const { data: wrapped } = useQuery({ queryKey: ['wrapped', year], queryFn: () => api<Wrapped>(`/api/wrapped?year=${year}`), staleTime: 30 * 60_000 });
  // Last-resort hero art, so a library with series but no reading still opens washed in its own covers.
  const { data: rnd } = useQuery({ queryKey: ['profile-hero-art'], queryFn: () => api<{ seriesId: string | null }>('/api/random'), staleTime: 30 * 60_000 });

  // The OPDS password lives on the page rather than in its card because the language picker two tabs away
  // has to know a secret is on screen -- and because I18nProvider remounts this whole subtree on a language
  // change, which would otherwise destroy a token the server only ever sends once. See lib/shownOnce.ts.
  const [opdsLink, setOpdsLinkState] = useState<OpdsLink | null>(() => readShownOnce<OpdsLink>('opds.link'));
  const setOpdsLink = (v: OpdsLink | null) => { writeShownOnce('opds.link', v); setOpdsLinkState(v); };
  // Read at render time: the API token and the recovery codes are held by their own cards, and any tab switch
  // re-renders this component, so the guard is current by the time the Settings tab can be reached.
  const secretOnScreen = !!opdsLink?.token || !!readShownOnce('apiToken.fresh') || !!readShownOnce('totp.recovery');

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

  const cards = tab === 'You' ? (
    <>
      <HouseBoard span="wide" members={lb?.content ?? []} youId={user?.id ?? ''} weekCovers={week.ids} weekTitles={week.titles} />
      <BadgesCard stats={stats} />
      <AvatarCard span="wide" />
      <ListsCard />
    </>
  ) : tab === 'Reading' ? (
    <>
      <OfflineCard />
      <SmartDownloadsCard />
      <NotificationsCard />
      <TrackerCard span="wide" />
    </>
  ) : tab === 'Settings' ? (
    <>
      <AccentCard />
      <LanguageCard span="wide" locked={secretOnScreen} />
      <InstallCard />
    </>
  ) : (
    <>
      <SignedInCard />
      <PasswordCard />
      <TotpCard />
      <SessionsCard span="wide" />
      <TokensCard />
      <OpdsCard link={opdsLink} setLink={setOpdsLink} />
      {isAdmin && <AdminCard seriesId={rnd?.seriesId ?? undefined} />}
      <SignOutCard />
    </>
  );

  return (
    <div className="min-h-screen-d px-4 lg:px-0">
      {/* ---------------------------------- HERO ---------------------------------- */}
      <header className="bleed relative isolate mb-6 overflow-hidden lg:mt-2 lg:rounded-3xl">
        {/* Taller than the spec's 46vh on a phone: the identity ladder, the fact pills and three verbs do not
            fit 388px, and the block is bottom-aligned, so anything that does not fit is clipped off the top. */}
        <div className="relative h-[56vh] min-h-[360px] lg:h-[min(420px,52vh)] xl:h-[min(460px,56vh)]">
          {anchorId && (
            <motion.div className="absolute inset-0"
              initial={still ? false : { opacity: 0, scale: 1.06 }} animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}>
              <Backdrop seriesId={anchorId} hero className="absolute inset-0" />
            </motion.div>
          )}
          <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/72 to-ink-950/30" />
          <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-ink-950/85 via-ink-950/30 to-transparent rtl:bg-gradient-to-l" />
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

      {/* ------------------------------ INDEX + BOARD ------------------------------ */}
      {/* The two things people actually come to this page to do were both at the bottom of the Account tab,
          behind a board of eight cards. They belong to the person, not to a panel, so they live on the rail. */}
      <ConsoleNav groups={PROFILE_GROUPS} tab={tab} onTab={setTab} ariaLabel={tr('You')} flat
        footer={<RailActions isAdmin={isAdmin} />}>
        <div className="board">{cards}</div>
      </ConsoleNav>

      {goalOpen && (
        <GoalModal current={stats?.weeklyGoal ?? 0} onClose={() => setGoalOpen(false)} onSave={saveGoal} />
      )}
    </div>
  );
}

/**
 * Admin and Sign out, pinned to the console rail.
 *
 * Both already exist as cards on the Account tab and stay there -- this is a second way to reach them, not a
 * move, because someone who knows where they are should not have to relearn the page. Styled as rail items
 * rather than as buttons so the column still reads as one list, with Sign out in the app's destructive red
 * and set apart from the link above it.
 */
function RailActions({ isAdmin }: { isAdmin: boolean }) {
  const { logout } = useAuth();
  // Two shapes, one markup. On a desktop these are rail rows under the tab list; on a phone the rail does
  // not exist and they sit under the pill row, so they take the pill's shape and wrap instead of stacking
  // three full-width bars above the content.
  const row = 'flex items-center gap-2 rounded-full border border-ink-700 px-3 py-1.5 text-start text-sm transition ' +
    'lg:w-full lg:rounded-lg lg:border-0';
  const chev = 'ms-auto hidden shrink-0 opacity-60 lg:block';
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

/* ================================== You ================================== */

/**
 * What you have earned, plus the single next thing.
 *
 * It used to render all six at once with five of them greyed out, which is a wall of things you have not
 * done sitting on your own profile.
 */
function BadgesCard({ stats, span = '' }: { stats?: Stats; span?: string }) {
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

function AvatarCard({ span = '' }: { span?: string }) {
  const { user, setAvatar } = useAuth();
  const qc = useQueryClient();
  const av = user?.avatar ?? {};
  const save = async (next: { emoji?: string; color?: string }) => {
    const merged = { ...av, ...next };
    setAvatar(merged);
    try { await api('/api/settings', { method: 'PUT', json: { avatar: merged } }); } catch { /* the optimistic change stands; the next load re-reads the server */ }
    qc.invalidateQueries({ queryKey: ['leaderboard'] });
  };
  return (
    <div className={`${CARD} ${span}`}>
      <h2 className="mb-3 font-display text-base font-semibold">{tr('Your avatar')}</h2>
      <div className="flex items-center gap-4">
        <Avatar avatar={av} size={56} />
        <div className="flex flex-wrap gap-1.5">
          {AVATAR_COLORS.map((c) => (
            <button key={c} onClick={() => save({ color: c })} className="h-7 w-7 rounded-full"
              style={{ background: c, outline: av.color === c ? '2px solid white' : 'none', outlineOffset: 2 }} />
          ))}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {AVATAR_EMOJIS.map((e) => (
          <button key={e} onClick={() => save({ emoji: e })}
            className={`grid h-10 w-10 place-items-center rounded-xl border text-xl ${av.emoji === e ? 'border-accent bg-accent-soft' : 'border-ink-700'}`}>
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}

function ListsCard({ span = '' }: { span?: string }) {
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
      <Link href="/collections/" className="chip mt-3 text-xs">{tr('See all')}<IcChevronRight width={14} height={14} /></Link>
    </div>
  );
}

/* ================================ Reading ================================ */

/**
 * Everything about bytes on this device, in one card.
 *
 * It replaces three separate rows: a link to /downloads (which is already a bottom-nav tab, so this was its
 * third door), a size readout, and an unlabelled full-width button that silently called
 * `navigator.storage.persist()` and reported absolutely nothing back.
 */
function OfflineCard({ span = '' }: { span?: string }) {
  const toast = useToast();
  const [usage, setUsage] = useState({ usage: 0, quota: 0 });
  const [persisted, setPersisted] = useState(false);

  useEffect(() => {
    storageEstimate().then(setUsage);
    navigator.storage?.persisted?.().then(setPersisted).catch(() => {});
  }, []);

  const ask = async () => {
    const ok = await requestPersist();
    setPersisted(ok);
    toast(ok ? tr('Protected from eviction') : tr('The browser did not grant it.'), ok ? 'success' : 'error');
  };

  return (
    <div className={`${CARD} ${span}`}>
      <h2 className="font-display text-base font-semibold">{tr('Offline')}</h2>
      <p className="mt-2 font-display text-2xl font-bold tabular-nums text-fog-50">{bytes(usage.usage)}</p>
      <div className="mt-2"><ProgressBar value={usage.quota ? Math.min(1, usage.usage / usage.quota) : 0} /></div>

      <Link href="/downloads/" className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-ink-700/70 bg-ink-850/50 px-3 py-2">
        <span className="flex min-w-0 items-center gap-2 text-sm text-fog-200">
          <IcDownload className="shrink-0 text-accent" width={18} height={18} /><span className="truncate">{tr('Offline downloads')}</span>
        </span>
        <IcChevronRight className="shrink-0 text-fog-500" width={16} height={16} />
      </Link>

      <p className="mt-3 text-xs text-fog-500">
        {persisted ? tr('Protected from eviction') : tr('Tap to ask the browser to protect your downloads from eviction.')}
      </p>
      {!persisted && <button onClick={ask} className="btn-ghost mt-2 px-4 py-2 text-sm">{tr('Protect downloads')}</button>}
    </div>
  );
}

function SmartDownloadsCard({ span = '' }: { span?: string }) {
  const { user, setSettings } = useAuth();
  const so = (user?.settings?.smartOffline ?? {}) as { enabled?: boolean; perSeries?: number };
  const set = async (partial: { enabled?: boolean; perSeries?: number }) => {
    const next = { enabled: !!so.enabled, perSeries: so.perSeries || 3, ...partial };
    setSettings({ smartOffline: next });
    try { await api('/api/settings', { method: 'PUT', json: { smartOffline: next } }); } catch { /* optimistic; re-read on next load */ }
  };
  return (
    <div className={`${CARD} ${span}`}>
      <h2 className="mb-3 font-display text-base font-semibold">{tr('Smart downloads')}</h2>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-fog-100">{tr('Keep favorites offline')}</p>
          <p className="text-xs text-fog-500">{tr('Auto-download the latest unread chapters of your favorites.')}</p>
        </div>
        <Switch on={!!so.enabled} onChange={(next) => set({ enabled: next })} label={tr('Keep favorites offline')} />
      </div>
      {so.enabled && (
        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs text-fog-400">{tr('Per series:')}</span>
          {[3, 5, 10].map((n) => (
            <button key={n} onClick={() => set({ perSeries: n })} className={`chip text-xs ${(so.perSeries || 3) === n ? 'chip-active' : ''}`}>{n}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function NotificationsCard({ span = '' }: { span?: string }) {
  const [supported] = useState(() => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);
  const [enabledSrv, setEnabledSrv] = useState(false);
  const [key, setKey] = useState('');
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const k = await api<{ enabled: boolean; key: string }>('/api/push/key');
        setEnabledSrv(k.enabled); setKey(k.key);
        if (k.enabled && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.ready;
          setOn(!!(await reg.pushManager.getSubscription()));
        }
      } catch { /* no VAPID key configured; the card stays unmounted */ }
    })();
  }, []);

  const toggle = async () => {
    if (!supported) return;
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      if (on) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) { await api('/api/push/unsubscribe', { json: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
        setOn(false);
      } else {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') {
          const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) as unknown as BufferSource });
          const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh: string; auth: string } };
          if (j.endpoint && j.keys) { await api('/api/push/subscribe', { json: { endpoint: j.endpoint, keys: j.keys, deviceId: deviceId() } }); setOn(true); }
        }
      }
    } catch { /* permission denied or the SW is not ready; the switch snaps back to the real state */ }
    setBusy(false);
  };

  // No server key means push is not configured at all: the board reflows rather than showing a dead switch.
  if (!enabledSrv) return null;

  return (
    <div className={`${CARD} ${span}`}>
      <h2 className="mb-3 font-display text-base font-semibold">{tr('Notifications')}</h2>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-fog-100">{tr('New-chapter alerts')}</p>
          <p className="text-xs text-fog-500">
            {supported ? tr('Get a push notification when one of your favorites gets a new chapter.') : tr('Not supported on this browser.')}
          </p>
        </div>
        <Switch on={on} onChange={toggle} disabled={!supported || busy} label={tr('New-chapter alerts')} />
      </div>
    </div>
  );
}

interface TrackerStatus {
  /** Sent by the server so the UI never hardcodes the provider list. */
  label?: string;
  tokenHelp?: string;
  provider: string; connected: boolean; accountName: string | null;
  expiresAt: string | null; expiringSoon: boolean; lastSyncAt: string | null; lastError: string | null;
}

/**
 * Connect one or more trackers so finished chapters push automatically.
 *
 * The provider list comes from the server rather than being written here: each one reports its own name and
 * where a token comes from, so adding a fourth service is a backend change alone.
 *
 * Token-paste rather than an OAuth round-trip, for all of them. A real OAuth flow would need every
 * self-hoster to register an application with each service and keep its secret in their compose file, which
 * is a worse trade for a household app than copying a token once.
 *
 * The card renders nothing at all when the server offers no providers. The old page put the heading outside
 * this component, so an empty list left an orphan "Progress tracking" over blank space.
 */
function TrackerCard({ span = '' }: { span?: string }) {
  const { data, refetch } = useQuery({ queryKey: ['trackers'], queryFn: () => api<{ content: TrackerStatus[] }>('/api/trackers') });
  const all = data?.content || [];
  if (!all.length) return null;
  return (
    <div className={`${CARD} ${span}`}>
      <h2 className="mb-3 font-display text-base font-semibold">{tr('Progress tracking')}</h2>
      <div className="space-y-3">
        {all.map((t) => <TrackerRow key={t.provider} t={t} refetch={refetch} />)}
      </div>
    </div>
  );
}

function TrackerRow({ t, refetch }: { t: TrackerStatus; refetch: () => void }) {
  const toast = useToast();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  // A service's own name is a proper noun: it is passed as a placeholder rather than translated.
  const label = t.label || t.provider;
  const row = 'rounded-xl border border-ink-700/70 bg-ink-850/50 p-3';

  const connect = async () => {
    if (!token.trim()) return;
    setBusy(true);
    try {
      const r = await api<{ account: string }>(`/api/trackers/${t.provider}/connect`, { json: { token: token.trim() } });
      toast(tr('Connected to {name} as {account}', { name: label, account: r.account }), 'success');
      setToken('');
      setOpen(false);
      refetch();
      // Only AniList has a backfill endpoint today; the others start syncing from the next chapter read.
      if (t.provider === 'anilist') {
        const b = await api<{ series: number }>('/api/trackers/anilist/backfill', { json: {} });
        if (b.series) toast(tr('Syncing {n} series you have already finished…', { n: b.series }));
      }
    } catch (e: any) { toast(msgOf(e, tr('{name} did not accept that token', { name: label })), 'error'); }
    setBusy(false);
  };

  const disconnect = async () => {
    try { await api(`/api/trackers/${t.provider}`, { method: 'DELETE' }); toast(tr('Disconnected'), 'success'); refetch(); }
    catch { toast(tr('Could not disconnect'), 'error'); }
  };

  if (t.connected) {
    return (
      <div className={row}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-fog-100">{label} · <span className="text-accent">{t.accountName}</span></p>
            <p className="mt-0.5 text-xs text-fog-500">
              {tr('Finished chapters sync automatically')}
              {t.lastSyncAt && <> · {tr('last synced {when}', { when: relativeTime(t.lastSyncAt) })}</>}
            </p>
          </div>
          <button onClick={disconnect} className="chip shrink-0 text-xs">{tr('Disconnect')}</button>
        </div>
        {t.expiringSoon && (
          <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-300">
            {tr('This {name} token expires {when}. None of these services can refresh a token silently, so reconnect before then to keep syncing.',
              { name: label, when: t.expiresAt ? relativeTime(t.expiresAt) : tr('soon') })}
          </p>
        )}
        {t.lastError && (
          <p className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-300">{t.lastError}</p>
        )}
      </div>
    );
  }

  return (
    <div className={row}>
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 text-sm text-fog-100">{tr('Sync your reading to {name}', { name: label })}</p>
        <button onClick={() => setOpen((v) => !v)} className="chip shrink-0 text-xs">{open ? tr('Cancel') : tr('Connect')}</button>
      </div>
      {open && (
        <>
          {t.tokenHelp && <p className="mt-2 text-xs text-fog-500">{t.tokenHelp}</p>}
          <p className="mt-1 max-w-prose text-[11px] text-fog-600">
            {tr('The token carries access to your {name} account and cannot be scoped. It is stored encrypted here, and you can disconnect at any time.', { name: label })}
          </p>
          <div className="mt-3 flex gap-2">
            <input value={token} onChange={(e) => setToken(e.target.value)} type="password"
              placeholder={tr('{name} access token', { name: label })} autoCapitalize="none" autoCorrect="off" className="field flex-1" />
            <button onClick={connect} disabled={busy || !token.trim()} className="btn-accent shrink-0 px-4 text-sm disabled:opacity-50">
              {busy ? tr('Working…') : tr('Connect')}
            </button>
          </div>
        </>
      )}
      {t.lastError && <p className="mt-2 text-xs text-red-300">{t.lastError}</p>}
    </div>
  );
}

/* ================================ Settings ================================ */

function AccentCard({ span = '' }: { span?: string }) {
  const { user, setSettings } = useAuth();
  const [accent, setAccent] = useState<string>(user?.settings?.accent || '#7c5cff');
  const pick = async (hex: string) => {
    setAccent(hex);
    setSettings({ accent: hex });
    try { await api('/api/settings', { method: 'PUT', json: { accent: hex } }); } catch { /* optimistic; re-read on next load */ }
  };
  return (
    <div className={`${CARD} ${span}`}>
      <h2 className="mb-3 font-display text-base font-semibold">{tr('Accent')}</h2>
      <div className="flex flex-wrap gap-3">
        {ACCENTS.map((a) => (
          <button key={a.hex} onClick={() => pick(a.hex)} className="relative h-11 w-11 rounded-full"
            style={{ background: a.hex }} aria-label={tr(a.name)}>
            {accent.toLowerCase() === a.hex.toLowerCase() && (
              <span className="absolute inset-0 grid place-items-center text-black"><IcCheck width={18} height={18} /></span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Choose a language.
 *
 * Written to the server so it follows you to another device, and mirrored to localStorage so the login
 * screen -- which nobody is signed in to -- is already translated.
 *
 * `locked` is not politeness. I18nProvider remounts its entire subtree on a language change, so tapping a
 * chip while a once-only secret is on screen destroys it permanently -- the server keeps only a hash -- and
 * kills a half-finished 2FA enrolment mid-QR-scan. The reason is stated inline rather than in a toast that
 * arrives after the damage.
 *
 * The note about machine assistance is shown rather than buried in a commit message: someone reading their
 * own language deserves to know how it got there, and it is what makes "this is wrong" an invitation
 * instead of a complaint.
 */
function LanguageCard({ span = '', locked }: { span?: string; locked: boolean }) {
  const { lang, setLang } = useT();
  return (
    <div className={`${CARD} ${span}`}>
      <h2 className="mb-3 font-display text-base font-semibold">{tr('Language')}</h2>
      <div className="flex flex-wrap gap-1.5">
        {LOCALES.map((l) => (
          <button key={l.code} onClick={() => setLang(l.code)} disabled={locked}
            className={`chip text-xs disabled:opacity-40 ${lang === l.code ? 'chip-active' : ''}`}>
            {l.name}
          </button>
        ))}
      </div>
      {locked && (
        <p className="mt-2 max-w-prose text-[11px] text-amber-300">
          {tr('Copy what is on screen first. Changing language reloads this page, and the code is shown only once.')}
        </p>
      )}
      <p className="mt-3 max-w-prose text-[11px] text-fog-500">
        {tr('Translations other than English are machine-assisted and have not been checked by a native speaker. If something reads wrong, the language files are one JSON each — corrections are welcome.')}
      </p>
    </div>
  );
}

function InstallCard({ span = '' }: { span?: string }) {
  const [canInstall, setCanInstall] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    setCanInstall(!!(window as any).__yomiInstall);
    setIsIOS(/iphone|ipad|ipod/i.test(navigator.userAgent));
    setStandalone(window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true);
  }, []);

  const install = async () => {
    const e = (window as any).__yomiInstall;
    if (!e) return;
    e.prompt();
    await e.userChoice;
    (window as any).__yomiInstall = null;
    setCanInstall(false);
  };

  // Already installed: the card is about installing, so it unmounts rather than congratulating you.
  if (standalone) return null;

  return (
    <div className={`${CARD} ${span}`}>
      <h2 className="mb-3 font-display text-base font-semibold">{tr('Install Uchiyomi')}</h2>
      {canInstall ? (
        <button onClick={install} className="btn-accent w-full py-2.5 text-sm">
          <IcDownload width={18} height={18} />{tr('Add to home screen')}
        </button>
      ) : isIOS ? (
        <div className="text-sm text-fog-300">
          <p className="mb-1 font-medium text-fog-100">{tr('Add to your iPhone')}</p>
          <p>{tr('Tap Share in Safari, then Add to Home Screen.')}</p>
          <p className="mt-2 text-xs text-fog-500">{tr('On iOS, offline downloads may be cleared by the system under storage pressure.')}</p>
        </div>
      ) : (
        <p className="text-sm text-fog-400">{tr('Open in Chrome/Edge and use “Install app” from the menu.')}</p>
      )}
    </div>
  );
}

/* ================================ Account ================================ */

function SignedInCard({ span = '' }: { span?: string }) {
  const { user, isAdmin } = useAuth();
  return (
    <div className={`${CARD} ${span}`}>
      <h2 className="mb-3 font-display text-base font-semibold">{tr('Signed in as')}</h2>
      <div className="flex items-center gap-3">
        <Avatar avatar={user?.avatar} size={44} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fog-50">{user?.displayName}</p>
          {user?.username && <p className="truncate text-xs text-fog-500">@{user.username}</p>}
        </div>
        {isAdmin && (
          <span className="ms-auto shrink-0 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-semibold text-accent">{tr('Admin')}</span>
        )}
      </div>
    </div>
  );
}

interface OpdsLink { token: string; url: string; expiresInDays?: number }
/** The token that already exists, if any. The raw password is shown once, so this is the only way to see
 *  whether one is out there, when it expires, and whether a reader is still using it. */
interface OpdsStatus { exists: boolean; createdAt?: string; expiresAt?: string; lastSeen?: string | null; expired?: boolean; showAdult?: boolean }

function OpdsCard({ span = '', link, setLink }: { span?: string; link: OpdsLink | null; setLink: (v: OpdsLink | null) => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const [st, setSt] = useState<OpdsStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<OpdsStatus>('/api/opds/token').then(setSt).catch(() => {});
  useEffect(() => { load(); }, []);

  const gen = async () => {
    setBusy(true);
    try { setLink(await api<OpdsLink>('/api/opds/token', { method: 'POST' })); await load(); }
    catch (e: any) { toast(msgOf(e, tr('Could not change that')), 'error'); }
    setBusy(false);
  };
  const revoke = async () => {
    setBusy(true);
    try { await api('/api/opds/token', { method: 'DELETE' }); setLink(null); await load(); }
    catch (e: any) { toast(msgOf(e, tr('Could not change that')), 'error'); }
    setBusy(false);
  };
  // On the token, not the account: the phone in a pocket and the e-reader on the shelf are different
  // audiences, and an OPDS app has no button of its own for the reveal the Library page offers.
  const setAdult = async (on: boolean) => {
    try { setSt(await api<OpdsStatus>('/api/opds/token', { method: 'PATCH', json: { showAdult: on } })); }
    catch (e: any) { toast(msgOf(e, tr('Could not change that')), 'error'); }
  };

  const summary = st?.exists
    ? `${st.expired ? tr('Expired') : tr('A link is active')} · ${st.lastSeen ? tr('last used {when}', { when: relativeTime(st.lastSeen) }) : tr('never used')}`
    : tr('No link yet.');

  return (
    <SettingsCard
      title={tr('External readers (OPDS)')}
      summary={summary}
      // A password shown once must never be behind a collapsed card, including after a remount.
      defaultOpen={!!link}
      span={span}
    >
      <p className="text-sm text-fog-100">{tr('Read Uchiyomi in another app')}</p>
      <p className="mt-1 max-w-prose text-xs text-fog-500">
        {tr('Add Uchiyomi as an OPDS catalog in readers like Panels, Chunky, KOReader or Moon+. Generate a personal link, then enter the URL and credentials below in your reader.')}
      </p>

      {st?.exists && !link && (
        <div className="mt-3 rounded-xl border border-ink-700/70 bg-ink-850/50 p-3 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className={st.expired ? 'text-rose-300' : 'text-fog-200'}>{st.expired ? tr('Expired') : tr('A link is active')}</span>
            <button onClick={revoke} disabled={busy}
              className="chip shrink-0 text-[11px] hover:border-rose-500/50 hover:text-rose-400 disabled:opacity-50">{tr('Revoke')}</button>
          </div>
          <p className="mt-1 text-fog-500">
            {st.lastSeen ? tr('last used {when}', { when: relativeTime(st.lastSeen) }) : tr('never used')}
            {st.expiresAt && <> · {st.expired
              ? tr('expired {when}', { when: relativeTime(st.expiresAt) })
              : tr('expires {when}', { when: relativeTime(st.expiresAt) })}</>}
          </p>
        </div>
      )}

      {st?.exists && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-ink-700/70 bg-ink-850/50 p-3">
          <div className="min-w-0">
            <p className="text-xs text-fog-100">{tr('Include 18+ libraries in this reader')}</p>
            <p className="max-w-prose text-[11px] text-fog-500">
              {tr('Off by default. Your age limit, if you have one, still applies whatever this says.')}
            </p>
          </div>
          <Switch on={!!st.showAdult} disabled={busy} label={tr('Include 18+ libraries in this reader')} onChange={setAdult} />
        </div>
      )}

      {!link ? (
        <button onClick={gen} disabled={busy} className="btn-accent mt-3 w-full py-2 text-sm disabled:opacity-50">
          {busy ? tr('Working…') : st?.exists ? tr('Generate a new link') : tr('Generate OPDS link')}
        </button>
      ) : (
        <div className="mt-3 space-y-2 text-xs">
          <div>
            <span className="text-fog-500">{tr('Catalog URL')}</span>
            <div className="mt-0.5 break-all rounded-lg border border-ink-700 bg-ink-900/60 px-2 py-1.5 font-mono text-fog-100">{link.url}</div>
          </div>
          <div>
            <span className="text-fog-500">{tr('Username')}</span>
            <div className="mt-0.5 rounded-lg border border-ink-700 bg-ink-900/60 px-2 py-1.5 font-mono text-fog-100">{user?.username || 'me'}</div>
          </div>
          <div>
            <span className="text-fog-500">{tr('Password (shown once, copy it now)')}</span>
            <div className="mt-0.5 break-all rounded-lg border border-ink-700 bg-ink-900/60 px-2 py-1.5 font-mono text-accent">{link.token}</div>
          </div>
          <p className="max-w-prose text-[11px] text-fog-500">
            {tr('Generating again replaces the previous token.')}
            {link.expiresInDays != null && <> {tr('This one stops working in {n} days. You can revoke it sooner.', { n: link.expiresInDays })}</>}
          </p>
          <button onClick={() => setLink(null)} className="text-xs text-fog-400 hover:underline">{tr('Done')}</button>
        </div>
      )}
    </SettingsCard>
  );
}

/** Admins only, washed in real library art so the one door out of the profile does not look like a form row. */
function AdminCard({ seriesId, span = '' }: { seriesId?: string; span?: string }) {
  return (
    <Link href="/admin/" className={`card grad-border relative isolate block overflow-hidden ${span}`}>
      <div className="relative h-24 lg:h-28">
        {seriesId && <Backdrop seriesId={seriesId} className="absolute inset-0" />}
        <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-ink-950 via-ink-950/80 to-transparent rtl:bg-gradient-to-l" />
        <div className="absolute inset-0 flex items-center justify-between gap-3 px-4">
          <span className="min-w-0 font-display text-sm font-semibold text-fog-50">{tr('Admin and server settings')}</span>
          <IcChevronRight className="shrink-0 text-fog-400" width={18} height={18} />
        </div>
      </div>
    </Link>
  );
}

function SignOutCard({ span = '' }: { span?: string }) {
  const { logout } = useAuth();
  return (
    <div className={`${CARD} ${span}`}>
      <button onClick={logout} className="btn-ghost w-full py-2.5 text-sm text-red-300">{tr('Sign out')}</button>
      <p className="mt-3 flex items-center justify-center gap-1 text-center text-[11px] text-fog-600">
        <IcSparkle width={12} height={12} />{tr('Uchiyomi · personal reader for your Komga library')}
      </p>
    </div>
  );
}
