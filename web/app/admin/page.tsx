'use client';
import { Suspense, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTabParam } from '@/lib/useTabParam';
import { AdminSettings } from '@/components/AdminSettings';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, img } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { triggerRefresh } from '@/lib/refresh';
import { scheduleText, taskResult } from '@/lib/tasks';
import { bytes, relativeTime } from '@/lib/format';
import { shownDeviceName } from '@/lib/device';
import { useToast } from '@/components/Toast';
import { ConfirmDialog, Modal, msgOf } from '@/components/ConfirmDialog';
import { Avatar } from '@/components/Avatar';
import { IcChevronLeft, IcChevronRight, IcTrash, IcPlus, IcRefresh } from '@/components/icons';
import { CardProgress, FixAllIssues, HealthCardActions, HealthRow, hasCardActions, scanState } from '@/components/HealthActions';
import { RepairHistory, RepairLiveStrip, RepairTaskLines } from '@/components/RepairLive';
import { ActionStatus } from '@/components/ActionList';
import { RepairRunProvider } from '@/lib/useRepairRun';
import { FindRunProvider } from '@/lib/useFindRun';
import { FindRunCard } from '@/components/FindSources';
import { checkTitle } from '@/lib/healthCopy';
import { checkNote, checkSummary, itemDetail, itemTitle } from '@/lib/said';
import { keysFor } from '@/lib/healthKeys';
import type { ActionState } from '@/lib/actionState';
import { Backdrop, Img } from '@/components/ui';
import { SeriesCard } from '@/components/cards';
import { ConsoleNav } from '@/components/ConsoleNav';
import { motion, useReducedMotion } from 'framer-motion';
import { t as tr, keys } from '@/lib/i18n';
import type { HealthCheck, Series } from '@/lib/types';
import { bridge, hiddenOnDesktop, isDesktop, visibleGroups, DESKTOP_HIDDEN, type UpdateStatus } from '@/lib/desktop';
import { SourcesPanel } from '@/components/SourcesPanel';
import { OVERVIEW_KEY, OVERVIEW_URL, SOURCES_TAB_ALIASES, splitSources, type SourcesOverview } from '@/lib/sourcesPanel';
import { StatusEdge, StatusMark } from '@/components/StatusMark';
import { TONE_SURFACE, healthMark } from '@/lib/status';
import Link from 'next/link';
import { healthLinks } from '@/lib/healthLinks';
import { useLayer } from '@/lib/layers';
import { SourceHealthBody } from '@/components/SourceHealthBody';

/**
 * Ten panels, grouped by what an admin is actually doing rather than by what the code is called.
 *
 * The previous shell put all ten in one horizontally scrolling pill row, which is a list rather than an
 * information architecture: "Overview" and "Sessions" were peers, and on a laptop the last three scrolled off
 * the edge where nobody found them. Extensions had no entry at all -- it rendered inside Providers, which is
 * why nobody found that either. Since v0.54.0 the two are one Sources tab.
 */
const GROUPS = [
  // `keys()` is the identity function; it exists so these reach the translation extractor. ConsoleNav
  // renders them as `tr(g.label)` and `tr(tab)`, which a scan for inline tr() calls cannot see, and that blind
  // spot has now shipped an English sidebar twice. See lib/i18n.ts.
  { id: 'server',  label: 'Server',  tabs: keys('Overview', 'Tasks', 'Settings') },
  { id: 'people',  label: 'People',  tabs: keys('Members', 'Sessions', 'Activity') },
  { id: 'content', label: 'Content', tabs: keys('Library', 'Health', 'Art') },
  // v0.54.0: ONE tab for every source, where Providers and Extensions were two halves of one list (SourcesPanel.tsx).
  // Their old names and links land on it (lib/sourcesPanel.ts SOURCES_TAB_ALIASES).
  { id: 'sources', label: 'Sources', tabs: keys('Sources') },
] as const;
// The group labels themselves, for the same reason.
const _GROUP_LABELS = keys('Server', 'People', 'Content', 'Sources');

const TABS = GROUPS.flatMap((g) => g.tabs);
type Tab = (typeof TABS)[number];

/**
 * The tab lives in the URL (`?tab=Settings`), read through `useSearchParams`, which a statically exported
 * page may only call under a Suspense boundary -- the build fails without one. The fallback keeps the
 * page's height so the shell does not jump when the boundary resolves.
 */
export default function AdminPage() {
  return (
    <Suspense fallback={<div className="min-h-screen-d" />}>
      <AdminInner />
    </Suspense>
  );
}

function AdminInner() {
  const { isAdmin } = useAuth();
  const router = useRouter();
  // In the URL rather than in state: a refresh, the back button and every deep link used to land on
  // Overview, and `/admin/?tab=Settings` is the address the docs can now give (lib/useTabParam.ts).
  const [tab, setTab] = useTabParam<Tab>(TABS, 'Overview', SOURCES_TAB_ALIASES);
  // Uchiyomi Desktop has no Members or Sessions (lib/desktop.ts). The rail never lists them, and a deep link
  // or an old bookmark to one lands on Overview rather than on a panel whose every request answers 404.
  // `GROUPS` and the line above stay as they are: only what ConsoleNav receives is filtered.
  const hiddenTab = hiddenOnDesktop(DESKTOP_HIDDEN.adminTabs, tab);
  useEffect(() => { if (hiddenTab) setTab('Overview'); }, [hiddenTab]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isAdmin) return <div className="flex min-h-screen-d items-center justify-center text-fog-400">{tr('Admins only.')}</div>;

  const panel = (
    <>
      {tab === 'Overview' && <Overview onTab={setTab} />}
      {tab === 'Members' && <Members />}
      {tab === 'Sources' && <SourcesPanel />}
      {tab === 'Art' && <ArtReview />}
      {tab === 'Health' && <Health />}
      {tab === 'Library' && <LibraryPanel />}
      {tab === 'Tasks' && <Tasks />}
      {tab === 'Activity' && <Activity />}
      {tab === 'Sessions' && <Sessions />}
      {tab === 'Settings' && <AdminSettings />}
    </>
  );

  return (
    <div className="min-h-screen-d px-4 lg:px-0">
      <AdminHero onBack={() => router.back()} />

      <ConsoleNav groups={isDesktop() ? visibleGroups(GROUPS, DESKTOP_HIDDEN.adminTabs) : GROUPS} tab={tab} onTab={setTab} ariaLabel={tr('Admin')}>
        {hiddenTab ? null : panel}
      </ConsoleNav>
    </div>
  );
}

/**
 * The header.
 *
 * Two things it is trying to fix. The panel had no visual identity at all -- flat cards on flat black, in an
 * app whose every other surface is composed over ambient art -- and the health of the server, which is the
 * question an admin arrives with, was reachable only by opening a tab and waiting for it to load.
 *
 * So the backdrop is real art from THIS library (a random series, the same `Backdrop` the series page uses,
 * blurred and drowned under a gradient), and the headline is the verdict rather than a row of numbers. The
 * counts are still there, just demoted to the line that supports it.
 */
function AdminHero({ onBack }: { onBack: () => void; onScan?: undefined }) {
  const qc = useQueryClient();
  const { data: stats } = useQuery({ queryKey: ['admin-stats'], queryFn: () => api<any>('/api/admin/stats') });
  const { data: health } = useQuery({
    queryKey: ['admin-health'],
    queryFn: () => api<{ generatedAt: string; checks: Array<{ status: string }> }>('/api/admin/health'),
  });
  // One random series for the wash. `keepPreviousData` is deliberately off: a different backdrop on each
  // visit is the point, and it is the cheapest way to make the panel feel like part of the library.
  const { data: rnd } = useQuery({
    queryKey: ['admin-hero-art'],
    queryFn: () => api<{ seriesId: string | null }>('/api/random'),
    staleTime: 5 * 60_000,
  });

  const bad = health ? health.checks.filter((c) => c.status !== 'ok').length : null;
  const verdict = !health ? tr('Checking your library…')
    : bad === 1 ? tr('1 check found something')
    : bad ? tr('{n} checks found something', { n: bad })
    : tr('Everything looks healthy');

  // The scan's answer, under the button (v0.49.0): it used to be dropped, so a scan refused because one ran a
  // minute ago looked exactly like one that found nothing. Then Health is checked again, and its header mark.
  const [scanned, setScanned] = useState<ActionState | null>(null);
  const scan = async () => {
    const at = Date.now();
    setScanned({ kind: 'working', startedAt: at, step: tr('Scanning library…') });
    const r = await triggerRefresh();
    setScanned(scanState(r, at));
    await Promise.all([qc.invalidateQueries({ queryKey: ['admin-stats'] }), qc.invalidateQueries({ queryKey: ['admin-health'] })]);
    await qc.invalidateQueries({ queryKey: ['health-summary'] });
  };

  // Separate singular keys rather than a plural library. Nine languages with one count each does not justify
  // Intl.PluralRules and a rules table; "1 members" does need fixing, and every language here can express
  // both forms as two strings.
  const facts = [
    stats ? (stats.seriesTotal === 1 ? tr('1 series') : tr('{n} series', { n: stats.seriesTotal })) : null,
    // Desktop is one person: "1 member" there would describe a household that does not exist.
    stats && !isDesktop() ? (stats.members === 1 ? tr('1 member') : tr('{n} members', { n: stats.members })) : null,
    stats ? tr('{size} cached', { size: bytes(stats.cacheBytes) }) : null,
    // Which layout this is, in one word: the answer to "where is my database" without reading a compose file.
    stats?.database ? (stats.database === 'embedded' ? tr('embedded database') : tr('external database')) : null,
    stats?.lastScan ? tr('scanned {when}', { when: relativeTime(new Date(stats.lastScan).toISOString()) }) : null,
    // From what the sources said the last time the updater asked. Absent until a sweep has stamped it.
    stats?.backlog?.chapters
      ? stats.backlog.chapters === 1 ? tr('1 chapter behind')
        : stats.backlog.series === 1 ? tr('{n} chapters behind in 1 series', { n: stats.backlog.chapters })
        : tr('{n} chapters behind across {m} series', { n: stats.backlog.chapters, m: stats.backlog.series })
      : null,
  ].filter(Boolean) as string[];

  return (
    <div className="bleed relative isolate mb-6 overflow-hidden lg:mt-2 lg:rounded-b-3xl">
      {rnd?.seriesId && <Backdrop seriesId={rnd.seriesId} className="absolute inset-0" />}
      {/* Drowned deliberately: this is a wash to sit text on, not a picture to look at. */}
      <div className="absolute inset-0 bg-linear-to-t from-ink-950 via-ink-950/90 to-ink-950/70" />
      {/* The bloom takes the verdict's colour, so the whole top of the page goes amber the moment a check
          fails. One ternary, no assets, and every pixel of it is data. */}
      <div aria-hidden className="pointer-events-none absolute inset-0"
        style={{ background: `radial-gradient(75% 120% at var(--start) 0%, ${bad ? 'rgba(245,158,11,0.20)' : 'rgb(var(--accent) / 0.22)'}, transparent 60%)` }} />

      <div className="relative px-4 pb-6 pt-[max(0.9rem,calc(env(safe-area-inset-top)+0.5rem))] lg:px-8 lg:pb-8 lg:pt-8">
        <div className="mb-5 flex items-center gap-2">
          <button onClick={onBack} aria-label={tr('Back')}
            className="grid h-10 w-10 place-items-center rounded-full bg-black/40 text-fog-100 backdrop-blur">
            <IcChevronLeft width={22} height={22} />
          </button>
          <span className="text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Admin')}</span>
        </div>

        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 0.61, 0.36, 1] }}>
          <div className="flex items-center gap-2.5">
            <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${
              !health ? 'bg-fog-600' : bad ? 'bg-amber-400' : 'bg-emerald-400'
            } ${!health ? 'animate-pulse' : ''}`} />
            <h1 className="font-display text-2xl font-bold leading-tight text-fog-50 lg:text-4xl">{verdict}</h1>
          </div>
          {facts.length > 0 && (
            <p className="mt-2 text-sm text-fog-400">{facts.join(' · ')}</p>
          )}
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.08, ease: [0.22, 0.61, 0.36, 1] }} className="mt-5">
          <button onClick={scan} disabled={scanned?.kind === 'working'} data-hero-scan className="btn-accent px-5 py-2.5 text-sm disabled:opacity-60">
            <IcRefresh width={16} height={16} />{scanned?.kind === 'working' ? tr('Scanning library…') : tr('Scan library now')}
          </button>
          {scanned && scanned.kind !== 'working' && <div data-hero-scan-result className="max-w-xl"><ActionStatus state={scanned} /></div>}
        </motion.div>
      </div>
    </div>
  );
}

/**
 * The overview.
 *
 * Four bands, in the order an admin wants the answers: what is wrong, who is reading, what they are
 * reading, and where to go next. Severity takes width -- a failing check spans the whole board and a clean
 * bill of health is one small tile -- so the panel reports the server's state by its shape before a word of
 * it is read.
 *
 * The four stat tiles and the scan button that used to lead this panel live in the hero, where they are
 * read before anything is clicked. Repeating them here would be the same numbers twice on one screen.
 */
function Overview({ onTab }: { onTab: (t: Tab) => void }) {
  const still = useReducedMotion();
  const { data: stats } = useQuery({ queryKey: ['admin-stats'], queryFn: () => api<any>('/api/admin/stats') });
  const { data: health } = useQuery({
    queryKey: ['admin-health'],
    queryFn: () => api<{ generatedAt: string; checks: HealthCheck[] }>('/api/admin/health'),
  });
  // What the household is actually reading, cross-user and last-14-days. The endpoint has existed since the
  // home screen shipped and admin has never called it; it is the best available answer to "is anyone
  // reading any of this", for one query and no new component.
  const { data: trending } = useQuery({
    queryKey: ['trending'],
    queryFn: () => api<{ content: Series[] }>('/api/trending'),
    staleTime: 5 * 60_000,
  });
  const { data: audit } = useQuery({ queryKey: ['admin-audit', 8], queryFn: () => api<{ content: any[] }>('/api/admin/audit?limit=8') });
  const { data: tasks } = useQuery({ queryKey: ['admin-tasks'], queryFn: () => api<{ content: any[] }>('/api/admin/tasks') });
  // Not asked on desktop, where the route answers 404: there is no Sessions tab for the tile to open.
  const desktop = isDesktop();
  const { data: sessions } = useQuery({ queryKey: ['admin-sessions'], queryFn: () => api<{ content: any[] }>('/api/admin/sessions'), enabled: !desktop });
  const { data: sources } = useQuery({ queryKey: OVERVIEW_KEY, queryFn: () => api<SourcesOverview>(OVERVIEW_URL) });

  const failing = (health?.checks ?? []).filter((c) => c.status !== 'ok');
  const activity: any[] = stats?.activity ?? [];
  const rail = trending?.content ?? [];
  const latest = audit?.content?.[0];
  const lastRun = Math.max(0, ...(tasks?.content ?? []).map((t: any) => t.lastRun || 0));

  return (
    <div className="board">
      {/* Severity takes width: a problem is the widest thing on screen, "all good" is a small tile. */}
      <NeedsAttention health={health} className={failing.length ? 'full' : ''} />

      {/* Band A -- the house: one card per member, washed in the cover of what they last read. */}
      {activity.length > 0 && (
        <div className="full">
          <h2 className="mb-2 font-display text-base font-semibold">{tr('Member activity')}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {activity.map((m: any, i: number) => (
              <motion.div key={m.id} className="card grad-border relative min-h-28 overflow-hidden p-4"
                initial={still ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: i * 0.04, ease: [0.22, 0.61, 0.36, 1] }}>
                {/* The cover re-checks visibility for THIS admin on the way out, so a restricted admin gets
                    the broken-image glyph rather than art from a library they cannot open. */}
                {m.last_series_id && (
                  <Img src={img.seriesThumb(m.last_series_id)} alt=""
                    className="pointer-events-none absolute inset-0 h-full w-full scale-110 opacity-25 blur-[2px]" />
                )}
                <div aria-hidden className="absolute inset-0 bg-linear-to-r from-ink-950 via-ink-950/80 to-ink-950/35 rtl:bg-linear-to-l" />
                <div className="relative flex items-center gap-3">
                  <Avatar avatar={m.avatar} size={48} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fog-50">{m.display_name}</p>
                    <p className="truncate text-[11px] text-fog-500">
                      {m.last_active ? tr('active {when}', { when: relativeTime(m.last_active) }) : tr('No activity yet.')}
                    </p>
                    {m.last_series_title && <p className="truncate text-[11px] text-fog-400">{m.last_series_title}</p>}
                  </div>
                  <span className="ms-auto shrink-0 text-end">
                    <span className="font-display text-xl font-bold tabular-nums text-accent">{m.week}</span>
                    <span className="block text-[10px] tabular-nums text-fog-500">{m.total}</span>
                  </span>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {/* Band B -- what the household is reading. Unmounts entirely when empty: never a heading over nothing. */}
      {rail.length > 0 && (
        <div className="full">
          <h2 className="mb-2 font-display text-base font-semibold">{tr('Top 10 in your library')}</h2>
          <div className="hide-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 pb-1 [scroll-snap-type:x_mandatory] lg:mx-0 lg:px-0"
            data-lenis-prevent>
            {/* The heading says ten. */}
            {rail.slice(0, 10).map((sx) => <SeriesCard key={sx.id} series={sx} />)}
          </div>
        </div>
      )}

      {/* Band C -- where to go next, each tile carrying the one number that decides whether to go there. */}
      <TabTile label={tr('Tasks')} value={String(tasks?.content?.length ?? 0)}
        sub={lastRun ? relativeTime(new Date(lastRun).toISOString()) : undefined} onClick={() => onTab('Tasks')} />
      {!desktop && (
        <TabTile label={tr('Sessions')} value={String(sessions?.content?.length ?? 0)}
          sub={sessions?.content?.[0] ? relativeTime(sessions.content[0].last_seen) : undefined} onClick={() => onTab('Sessions')} />
      )}
      {/* The sources that are on, as Admin → Sources' "Your sources" counts them. */}
      <TabTile label={tr('Sources')} value={String(sources ? splitSources(sources.sources).on.length : 0)} onClick={() => onTab('Sources')} />
      {/* Activity's headline is a time rather than a count: "how long since anything happened" is the
          question, and eight rows of audit cannot answer "how many". */}
      <TabTile label={tr('Activity')} value={latest ? relativeTime(latest.at) : '0'}
        sub={latest ? `${latest.event.replace(/[._]/g, ' ')}${latest.username ? ` · ${latest.username}` : ''}` : tr('No activity yet.')}
        onClick={() => onTab('Activity')} />
    </div>
  );
}

/**
 * Whether anything is wrong, and what.
 *
 * Sized by severity rather than by convention: the caller hands it `full` when something is failing, so the
 * same component is a quiet tile on a healthy server and the widest thing on the board on a broken one.
 */
function NeedsAttention({ health, className = '' }: {
  health?: { generatedAt: string; checks: HealthCheck[] };
  className?: string;
}) {
  const failing = (health?.checks ?? []).filter((c) => c.status !== 'ok');
  return (
    <div className={`card grad-border p-4 ${className}`}>
      <h2 className="mb-2 font-display text-base font-semibold">{tr('Needs attention')}</h2>
      {!health ? (
        <p className="text-sm text-fog-500">{tr('Checking your library…')}</p>
      ) : !failing.length ? (
        <>
          <p className="text-sm text-fog-200">{tr('Everything looks healthy')}</p>
          <p className="mt-1 text-[11px] text-fog-500">{tr('checked {when}', { when: relativeTime(health.generatedAt) })}</p>
        </>
      ) : (
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {failing.map((c) => {
            // The tint alone told a problem from a warning only to someone who can tell red from amber:
            // the glyph's shape says it too, and names it to a screen reader. The edge is StatusEdge's bar,
            // the one every card that needs a second look wears from v0.49.0. Inset 12 px rather than the
            // default 16: the tile is short, and 12 still clears its 16 px corners (checked at 390 and 1280).
            const m = healthMark(c.status);
            return (
              <div key={c.id} className={`relative rounded-2xl border px-3 py-2.5 ${TONE_SURFACE[m.tone]}`}>
                <StatusEdge tone={m.tone} inset="inset-y-3" />
                {/* In the reader's language: the title by the check's id, the summary by its codes (lib/said.ts). */}
                <p className="flex items-center gap-1.5 text-sm font-medium text-fog-100"><StatusMark tone={m.tone} title={m.label} />{checkTitle(c)}</p>
                <p dir="auto" className="mt-0.5 text-[11px] text-fog-400">{checkSummary(c)}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A navigational tile: the one number that decides whether the tab behind it is worth opening. */
function TabTile({ label, value, sub, onClick }: { label: string; value: string; sub?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="card grad-border p-4 text-start transition hover:border-accent/40">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-fog-500">{label}</p>
      <p className="mt-1 font-display text-3xl font-bold tabular-nums text-fog-50">{value}</p>
      {sub && <p className="mt-0.5 truncate text-[11px] text-fog-500">{sub}</p>}
    </button>
  );
}

/**
 * The household.
 *
 * One card per member rather than one divided list. The list was correct at 864px and wrong at 1592, where
 * every row left a lake of nothing between a name and the chips that act on it; a card puts the actions
 * under the face they belong to at every width, and twenty members become a wall you can scan.
 */
function Members() {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['admin-users'], queryFn: () => api<{ content: any[] }>('/api/admin/users') });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [busy, setBusy] = useState(false);
  // A password reset and a deletion are the two things here that cannot be undone by clicking again, so
  // both go through the app's own dialogs. prompt()/confirm() were untranslatable, unstyled, and in a
  // standalone PWA are rendered badly or suppressed outright.
  const [resetting, setResetting] = useState<any | null>(null);
  const [pw, setPw] = useState('');
  const [deleting, setDeleting] = useState<any | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const inval = () => qc.invalidateQueries({ queryKey: ['admin-users'] });

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    try { await api('/api/admin/users', { json: { username: username.trim(), password, displayName: displayName.trim() || undefined, role } }); toast(`Created @${username.trim()}`, 'success'); setUsername(''); setPassword(''); setDisplayName(''); setRole('user'); inval(); }
    catch (e: any) { toast(e instanceof ApiError && e.status === 409 ? 'Username taken' : msgOf(e, 'Could not create account'), 'error'); }
    setBusy(false);
  };
  const patch = async (u: any, body: any, ok: string) => { try { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', json: body }); toast(ok, 'success'); inval(); } catch (e: any) { toast(msgOf(e, 'Could not update'), 'error'); } };
  const closeReset = () => { setResetting(null); setPw(''); };
  const del = async (u: any) => {
    setDeletingBusy(true);
    try { await api(`/api/admin/users/${u.id}`, { method: 'DELETE' }); toast('Deleted', 'success'); setDeleting(null); inval(); }
    catch { toast('Could not delete (last admin?)', 'error'); }
    setDeletingBusy(false);
  };

  return (
    <div className="board">
      <form onSubmit={create} className="card grad-border p-4">
        <h2 className="mb-3 font-display text-base font-semibold">{tr('New account')}</h2>
        <div className="space-y-2">
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={tr('username')} autoCapitalize="none" autoCorrect="off" className="field" />
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={tr('display name (optional)')} className="field" />
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder={tr('password (min 8)')} className="field" />
          <div className="flex gap-2">{(['user', 'admin'] as const).map((r) => <button key={r} type="button" onClick={() => setRole(r)} className={`flex-1 rounded-xl border py-2 text-sm capitalize ${role === r ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>{r}</button>)}</div>
        </div>
        <button type="submit" disabled={busy || !username.trim() || password.length < 8} className="btn-accent mt-3 w-full disabled:opacity-50"><IcPlus width={18} height={18} /> {busy ? 'Creating…' : 'Create account'}</button>
      </form>

      {(data?.content ?? []).map((u: any) => {
        const self = u.id === user?.id;
        const canDl = u.perms?.canDownload !== false;
        return (
          <div key={u.id} className="card grad-border p-4">
            <div className="flex items-center gap-3">
              <Avatar avatar={u.avatar} size={40} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-fog-100">{u.display_name}</p>
                <p className="truncate text-[11px] text-fog-500">@{u.username}</p>
              </div>
              {!self && (
                <button onClick={() => setDeleting(u)} aria-label={tr('Remove')}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-ink-700 text-red-300"><IcTrash width={16} height={16} /></button>
              )}
            </div>
            <p className="mt-2 text-[11px] text-fog-500">{u.role === 'admin' ? 'Admin' : 'Member'}{self ? ' · you' : ''}{u.disabled ? ' · disabled' : ''}{u.totp_enabled ? ' · 2FA' : ''}</p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <button onClick={() => setResetting(u)} className="chip text-xs">{tr('Reset')}</button>
              {!self && (
                <>
                  <button onClick={() => patch(u, { role: u.role === 'admin' ? 'user' : 'admin' }, 'Role updated')} className="chip text-xs">{u.role === 'admin' ? 'Make member' : 'Make admin'}</button>
                  <button onClick={() => patch(u, { disabled: !u.disabled }, u.disabled ? 'Enabled' : 'Disabled')} className="chip text-xs">{u.disabled ? 'Enable' : 'Disable'}</button>
                  <button onClick={() => patch(u, { perms: { ...u.perms, canDownload: !canDl } }, 'Permission updated')} className="chip text-xs">{canDl ? 'Deny downloads' : 'Allow downloads'}</button>
                  {/* Library access. "All libraries" is the ABSENCE of grant rows, not a full set of them, so a
                      library added next month is visible to unrestricted accounts without editing anyone. */}
                  {u.role !== 'admin' && <LibraryAccess user={u} onSaved={inval} />}
                  {u.role !== 'admin' && <AgeCap user={u} onSaved={inval} />}
                </>
              )}
            </div>
          </div>
        );
      })}

      {resetting && (
        <Modal title={tr('Change password')} onClose={closeReset}>
          <p className="mb-3 text-sm text-fog-400">@{resetting.username}</p>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password"
            placeholder={tr('New password (min 8 characters)')} className="field" />
          <div className="mt-4 flex gap-2">
            <button onClick={closeReset} className="btn-ghost flex-1 py-2 text-sm">{tr('Cancel')}</button>
            <button disabled={pw.length < 8}
              onClick={() => { patch(resetting, { password: pw }, 'Password reset · sessions revoked'); closeReset(); }}
              className="btn-accent flex-1 py-2 text-sm disabled:opacity-50">{tr('Update password')}</button>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title={tr('Remove “{name}”?', { name: `@${deleting.username}` })}
          body={tr('Their reading history, favourites and sessions go with the account. Nothing in the library is touched and no files are deleted.')}
          confirmLabel={tr('Remove')}
          confirmText={deleting.username}
          danger
          busy={deletingBusy}
          onConfirm={() => del(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

// ---- Art Review: see every series' art at a glance, fix the ugly ones in two clicks ----
interface ArtRow { id: string; title: string; books_count: number; has_banner: boolean; has_cover: boolean; override_banner: boolean; override_cover: boolean; override_v: number | null }
interface ArtCandidate { origin: string; title: string; banner: string | null; cover: string | null }

function ArtReview() {
  const toast = useToast();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<'all' | 'nobanner' | 'nocover' | 'fixed'>('nobanner');
  const [open, setOpen] = useState<ArtRow | null>(null); // series whose candidate sheet is open
  const [bust, setBust] = useState<Record<string, number>>({}); // per-series cache-bust after an apply
  const { data } = useQuery({ queryKey: ['admin-art'], queryFn: () => api<{ content: ArtRow[] }>('/api/admin/art/overview') });
  const { data: bf } = useQuery({
    queryKey: ['admin-art-backfill'],
    queryFn: () => api<{ job: any }>('/api/admin/art/backfill/status'),
    refetchInterval: (q) => (q.state.data?.job?.running ? 3000 : false),
  });
  const rows = (data?.content ?? []).filter((r) =>
    filter === 'all' ? true
    : filter === 'nobanner' ? !r.has_banner && !r.override_banner
    : filter === 'nocover' ? !r.has_cover && !r.override_cover
    : r.override_banner || r.override_cover,
  );
  const startBackfill = async () => {
    try {
      const r = await api<{ total: number }>('/api/admin/art/backfill', { method: 'POST' });
      toast(`Hunting art for ${r.total} series…`, 'success', { busy: true });
      qc.invalidateQueries({ queryKey: ['admin-art-backfill'] });
    } catch (e: any) { toast(msgOf(e, 'Backfill already running?'), 'error'); }
  };
  const job = bf?.job;
  return (
    <div className="board">
      <div className="card grad-border full p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold">Cover &amp; banner health</h2>
            <p className="text-xs text-fog-500">Backfill re-hunts AniList + MangaDex for missing art. Click a series to pick art by hand.</p>
          </div>
          <button onClick={startBackfill} disabled={!!job?.running} className="btn-accent px-4 py-2 text-sm disabled:opacity-50">
            {job?.running ? `Backfilling ${job.done}/${job.total}…` : 'Backfill missing banners'}
          </button>
        </div>
        {job && !job.running && (
          <p className="mt-2 text-xs text-fog-400">Last run: +{job.banners} banners, +{job.covers} covers, {job.misses} not found.</p>
        )}
      </div>
      <div className="hide-scrollbar full flex gap-1.5 overflow-x-auto pb-1">
        {([['nobanner', 'Missing banner'], ['nocover', 'Missing cover'], ['fixed', 'Overridden'], ['all', 'All']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setFilter(k)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${filter === k ? 'bg-accent text-white' : 'bg-ink-800 text-fog-300'}`}>
            {label}{k !== 'all' ? ` (${(data?.content ?? []).filter((r) => (k === 'nobanner' ? !r.has_banner && !r.override_banner : k === 'nocover' ? !r.has_cover && !r.override_cover : r.override_banner || r.override_cover)).length})` : ''}
          </button>
        ))}
      </div>
      <div className="full grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 wide:grid-cols-8">
        {rows.map((r) => (
          <button key={r.id} onClick={() => setOpen(r)} className="card overflow-hidden p-0 text-start transition hover:border-accent/40">
            <div className="relative h-16 w-full overflow-hidden bg-ink-900">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {/* As the series page shows it (v0.53.0): a banner sharp, a stand-in cover blurred -- the art being judged. */}
              <img src={`/img/series/${encodeURIComponent(r.id)}/backdrop?style=banner&rv=${bust[r.id] || 0}`} alt="" className="h-full w-full object-cover" loading="lazy" />
              {!r.has_banner && !r.override_banner && <span className="absolute end-1 top-1 rounded bg-red-600/80 px-1.5 py-0.5 text-[9px] font-bold text-white">NO BANNER</span>}
            </div>
            <div className="flex items-center gap-2 p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`${img.seriesThumb(r.id)}&rv=${bust[r.id] || 0}`} alt="" className="h-12 w-8 shrink-0 rounded object-cover" loading="lazy" />
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-fog-100">{r.title}</p>
                <p className="text-[10px] text-fog-500">
                  {(r.override_banner || r.override_cover) ? 'custom art' : r.has_banner ? 'banner ✓' : r.has_cover ? 'cover only' : 'first-page art'}
                </p>
              </div>
            </div>
          </button>
        ))}
      </div>
      {open && <ArtPicker row={open} onClose={() => setOpen(null)} onApplied={() => { setBust((b) => ({ ...b, [open.id]: Date.now() })); qc.invalidateQueries({ queryKey: ['admin-art'] }); }} />}
    </div>
  );
}

function ArtPicker({ row, onClose, onApplied }: { row: ArtRow; onClose: () => void; onApplied: () => void }) {
  // A dialog on the notices' layer stack (lib/layers.ts): it toasts while open ("Failed to apply").
  useLayer('dialog');
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['admin-art-cand', row.id],
    queryFn: () => api<{ content: ArtCandidate[] }>(`/api/admin/art/candidates/${row.id}`),
    staleTime: 10 * 60 * 1000,
  });
  const apply = async (kind: 'cover' | 'banner', url: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/api/admin/series/${row.id}/art`, { method: 'PUT', json: { kind, mode: 'url', url } });
      toast(kind === 'banner' ? tr('Banner updated') : tr('Cover updated'), 'success');
      onApplied();
    } catch { toast(kind === 'banner' ? tr('Could not change the banner') : tr('Could not change the cover'), 'error'); }
    setBusy(false);
  };
  const reset = async (kind: 'cover' | 'banner') => {
    if (busy) return;
    setBusy(true);
    try { await api(`/api/admin/series/${row.id}/art`, { method: 'PUT', json: { kind, mode: 'reset' } }); toast(kind === 'banner' ? tr('Banner reset to automatic') : tr('Cover reset to automatic'), 'success'); onApplied(); }
    catch { toast(tr('Failed'), 'error'); }
    setBusy(false);
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/70 p-4 backdrop-blur-xs" onClick={onClose}>
      {/* max-w-xl, the widest a centred panel may be: from lg up the notices' column beside it is sized to clear
          36 rem (lib/notices.ts WIDE_BESIDE_DIALOG), and at 42 rem this one's corner sat under it. */}
      <div role="dialog" aria-modal="true" aria-label={row.title} data-lenis-prevent className="glass max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-ink-700 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-semibold leading-tight">{row.title}</h3>
          <button onClick={onClose} className="shrink-0 text-fog-500 hover:text-fog-200">✕</button>
        </div>
        {(row.override_banner || row.override_cover) && (
          <div className="mb-3 flex gap-2">
            {row.override_cover && <button onClick={() => reset('cover')} disabled={busy} className="chip text-xs">{tr('Reset cover to auto')}</button>}
            {row.override_banner && <button onClick={() => reset('banner')} disabled={busy} className="chip text-xs">{tr('Reset banner to auto')}</button>}
          </div>
        )}
        {isLoading ? (
          <p className="py-8 text-center text-sm text-fog-500">{tr('Searching AniList + MangaDex…')}</p>
        ) : !(data?.content?.length) ? (
          <p className="py-8 text-center text-sm text-fog-500">{tr('No candidates found — use Edit details on the series page to paste a URL.')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {data!.content.map((c, i) => (
              <div key={i} className="card overflow-hidden p-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={c.banner || c.cover || ''} alt="" className="h-28 w-full object-cover" loading="lazy" />
                <div className="p-2">
                  <p className="truncate text-[11px] text-fog-300">{c.title}</p>
                  <p className="text-[10px] uppercase tracking-wide text-fog-500">{c.origin}</p>
                  <div className="mt-1.5 flex gap-1.5">
                    {c.banner && <button onClick={() => apply('banner', c.banner!)} disabled={busy} className="btn-accent flex-1 px-2 py-1 text-[11px] disabled:opacity-50">{tr('Use as banner')}</button>}
                    {c.cover && <button onClick={() => apply('cover', c.cover!)} disabled={busy} className="btn-ghost flex-1 px-2 py-1 text-[11px] disabled:opacity-50">{tr('Use as cover')}</button>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Tasks() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['admin-tasks'], queryFn: () => api<{ content: any[] }>('/api/admin/tasks'), refetchInterval: 5000 });
  const run = async (id: string) => {
    try {
      const r = await api<{ ok?: boolean; error?: string; started?: boolean; series?: number; books?: number }>(`/api/admin/tasks/${id}/run`, { method: 'POST' });
      // A refusal is a 200 with ok:false (the task is already running), and used to toast "Started" too.
      // `not_enabled` is reachable in one narrow window: this list polls every five seconds, so a task
      // switched off in Settings is still on screen for a moment afterwards. "Failed" would be a lie about
      // something the admin had just done on purpose.
      // ⚠️ `sweep_running` and `repair_running` (v0.41.0) are the two jobs refusing to run beside each
      // other -- the repair beside a chapter sweep, and the sweep beside a repair -- and they are the two
      // refusals here that clear by themselves. Under "Already running" each read as the task the admin
      // had just pressed being stuck, which is the opposite of what is happening and sends them restarting
      // the container. Each one names the OTHER job, or the sentence is about a task that is idle.
      if (r?.ok === false) {
        toast(r.error === 'sweep_running' ? tr('A chapter sweep is running — try again in a few minutes')
          : r.error === 'repair_running' ? tr('The library repair is running — try again in a few minutes')
          : r.error === 'busy' ? tr('Already running')
          : r.error === 'not_enabled' ? tr('That task is switched off')
          : tr('Failed'), 'error');
      }
      // ⚠️ The scan is the one task that runs to completion before answering, and it answers with its
      // counts. Toasting "Started" for it hid the only fact that mattered: in #34 a library scanned to zero
      // series and the reporter's summary was "the run now buttons don't work" -- because from the outside,
      // "Started" followed by nothing changing is indistinguishable from a button that does nothing.
      else if (typeof r?.series === 'number') {
        const s = scanState({ scanned: true, series: r.series, books: r.books }, Date.now());
        toast(s.kind === 'done' ? s.outcome : '', r.series ? 'success' : 'error');
      }
      // The verify task is detached (one stat per chapter over a share is minutes, and a request that long
      // dies at the proxy while the walk goes on), so its counts cannot be in this answer. The one place
      // they appear is the Tasks line, which this panel polls -- and the admin who just restored a database
      // is told exactly that, or "Started" followed by nothing is a button that did nothing (#34).
      else if (id === 'verify' && r?.started) toast(tr('Started — the Tasks line shows what it found when it is done.'), 'success');
      // The repair is detached for the same reason and reports the same way, so it gets the same sentence
      // rather than a bare "Started": a nightly run counts two thousand files and can replace a chapter,
      // and none of that is in this answer.
      else if (id === 'repair' && r?.started) toast(tr('Started — the Tasks line shows what it did'), 'success');
      else toast(tr('Started'), 'success');
      qc.invalidateQueries({ queryKey: ['admin-tasks'] });
    } catch { toast(tr('Failed'), 'error'); }
  };
  // Chronological, per-row actions: a list, not a card grid. But an explicit column template rather than
  // `justify-between`, which at 1592px left a lake of nothing between a task's name and its own button.
  return (
    <div className="board">
      <DesktopBackups />
      <div className="card grad-border full divide-y divide-ink-800/70 overflow-hidden">
        {(data?.content || []).map((t: any) => (
          <div key={t.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-3.5 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_auto]">
            <p className="col-start-1 row-start-1 min-w-0 truncate text-sm text-fog-100">{tr(t.name)}</p>
            {/* Phone stacks the schedule under the name; from lg it takes a track of its own. */}
            {/* ⚠️ `remaining` is shown because the backlog is the one number that tells you whether a task is
                keeping up. The server has always sent it and nothing displayed it, so a job that had quietly
                stopped picking up new work looked identical to one with nothing to do. */}
            {/* Wraps rather than truncates: a task's result is the only record of a detached run, and the
                verify line ("one folder looked unmounted…: /library-dl, 4000 checked, 312 missing…") is
                900 px wide -- truncated, it read as a clean run on every width. */}
            <p className="col-start-1 row-start-2 min-w-0 break-words text-[11px] text-fog-500 lg:col-start-2 lg:row-start-1">
              {scheduleText(t)} · {t.lastRun ? tr('last run {when}', { when: relativeTime(new Date(t.lastRun).toISOString()) }) : tr('not run yet')}
              {/* The repair's line is the last FULL run's since v0.49.0 (the nightly, or Run now here): say which. */}
              {t.lastRun && t.lastOrigin === 'nightly' ? ` ${tr('(nightly)')}` : t.lastRun && t.lastOrigin === 'manual' ? ` ${tr('(run by hand)')}` : ''}
              {taskResult(t.lastResult)}
              {typeof t.remaining === 'number' && t.remaining > 0 && (
                <span className="text-amber-300"> · {tr('{n} waiting', { n: t.remaining.toLocaleString() })}</span>
              )}
            </p>
            {t.id === 'repair' && (
              <div className="col-start-1 row-start-3 min-w-0 lg:col-start-2 lg:row-start-2">
                <RepairTaskLines nextAt={t.nextAt} latestOther={t.latestOther} running={!!t.running} />
              </div>
            )}
            <button onClick={() => run(t.id)} disabled={t.running}
              className="btn-key col-start-2 row-span-2 row-start-1 justify-self-end lg:col-start-3 lg:row-span-1">{t.running ? tr('Running…') : tr('Run now')}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Uchiyomi Desktop's backups, under Tasks where the nightly backup is listed. Renders nothing without the
 * shell's bridge, so the server build's Tasks tab is unchanged.
 *
 * The backups are files in a folder on this computer, so the useful thing is to open that folder (to copy
 * one to another drive, or to find last night's). Restoring cannot happen inside the page: the shell has to
 * stop the library server, load the dump into the database and start it again (design-inapp §6), so this
 * asks first -- it replaces everything since that backup -- and then hands over to the shell's own dialog.
 */
function DesktopBackups() {
  const toast = useToast();
  const b = bridge();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!b || (typeof b.revealBackups !== 'function' && typeof b.restoreBackup !== 'function')) return null;
  const restore = async () => {
    setBusy(true);
    try { await b.restoreBackup(); setAsking(false); }
    // Electron prefixes a rejected IPC call with "Error invoking remote method '…': Error: "; the shell's own
    // sentence is what follows it.
    catch (e: any) { toast(String(e?.message || '').replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '') || tr('Could not restore that backup'), 'error'); }
    setBusy(false);
  };
  return (
    <div className="full flex flex-wrap items-center justify-end gap-2">
      {typeof b.revealBackups === 'function' && (
        <button type="button" onClick={() => b.revealBackups()} className="chip text-xs">{tr('Open backups folder')}</button>
      )}
      {typeof b.restoreBackup === 'function' && (
        <button type="button" onClick={() => setAsking(true)} className="chip text-xs">{tr('Restore a backup…')}</button>
      )}
      {asking && (
        <ConfirmDialog
          title={tr('Restore a backup?')}
          body={tr('Uchiyomi closes your library, replaces its database and settings with the backup you choose, and opens again. Everything since that backup — reading progress, new series, settings — is replaced. The manga files themselves are not touched.')}
          confirmLabel={tr('Choose a backup…')}
          danger
          busy={busy}
          onConfirm={() => { void restore(); }}
          onClose={() => setAsking(false)}
        />
      )}
    </div>
  );
}

function Activity() {
  const { data } = useQuery({ queryKey: ['admin-audit'], queryFn: () => api<{ content: any[] }>('/api/admin/audit?limit=150'), refetchInterval: 8000 });
  const label = (e: string) => e.replace(/\./g, ' ').replace(/_/g, ' ');
  // A feed stays a feed -- chronological data must not be chopped into a card grid. What changes is that a
  // row is now an explicit column template, so at 1592px the detail fills the space that used to be a lake
  // between the event and its timestamp, and the 60-character truncation of the detail is no longer needed.
  return (
    <div className="board">
      <div className="card grad-border full divide-y divide-ink-800/70 overflow-hidden">
        {(data?.content || []).map((a: any) => {
          const detail = a.detail && Object.keys(a.detail).length ? JSON.stringify(a.detail) : '';
          return (
            <div key={a.id} className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-baseline gap-x-3 px-4 py-2.5 lg:grid-cols-[8px_minmax(0,20rem)_minmax(0,1fr)_auto]">
              <span aria-hidden className={`h-2 w-2 translate-y-1 rounded-full ${/fail|block|disable|delete/.test(a.event) ? 'bg-red-400' : /login|ok|register/.test(a.event) ? 'bg-emerald-400' : 'bg-accent'}`} />
              <p className="min-w-0 truncate text-sm text-fog-100"><span className="font-medium capitalize">{label(a.event)}</span>{a.username ? <span className="text-fog-400"> · {a.username}</span> : ''}</p>
              {/* Hidden below lg rather than reflowed: a display:none child takes no track, so the phone
                  template is the three columns it declares and the desktop one is four. */}
              <p className="hidden min-w-0 truncate font-mono text-[11px] text-fog-500 lg:block">{detail}</p>
              <p className="shrink-0 text-end text-[11px] text-fog-500">{relativeTime(a.at)}{a.ip ? ` · ${a.ip}` : ''}</p>
            </div>
          );
        })}
        {!data?.content?.length && <p className="px-4 py-8 text-center text-sm text-fog-500">{tr('No activity yet.')}</p>}
      </div>
    </div>
  );
}

function Sessions() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['admin-sessions'], queryFn: () => api<{ content: any[] }>('/api/admin/sessions') });
  const revoke = async (id: string) => { await api(`/api/admin/sessions/${id}`, { method: 'DELETE' }); toast('Revoked', 'success'); qc.invalidateQueries({ queryKey: ['admin-sessions'] }); };
  return (
    <div className="board">
      <div className="card grad-border full divide-y divide-ink-800/70 overflow-hidden">
        {(data?.content || []).map((s: any) => (
          <div key={s.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-3 lg:grid-cols-[minmax(0,16rem)_minmax(0,14rem)_minmax(0,10rem)_auto]">
            <p className="col-start-1 row-start-1 min-w-0 truncate text-sm text-fog-100">{s.display_name || s.username}</p>
            {/* Phone folds device and ip under the name; from lg each takes its own track. */}
            <p className="col-start-1 row-start-2 min-w-0 truncate text-[11px] text-fog-500 lg:col-start-2 lg:row-start-1">
              {/* The stored name through the same mapping as Profile → Sessions: an older sign-in's English "Browser"
                  is not shown, and no name is "Device" in the reader's words. */}
              {shownDeviceName(s.device_name) || tr('Device')}
              <span className="lg:hidden"> · {s.ip || tr('unknown ip')} · {tr('active {when}', { when: relativeTime(s.last_seen) })}</span>
            </p>
            <p className="hidden min-w-0 truncate font-mono text-[11px] text-fog-500 lg:col-start-3 lg:row-start-1 lg:block">{s.ip || tr('unknown ip')}</p>
            <div className="col-start-2 row-span-2 row-start-1 flex shrink-0 items-center gap-2 justify-self-end lg:col-start-4 lg:row-span-1">
              <span className="hidden text-[11px] text-fog-500 lg:inline">{tr('active {when}', { when: relativeTime(s.last_seen) })}</span>
              {/* `current` marks the caller's own session. The admin route does not send it yet, so this is
                  inert rather than wrong: without it, revoking the row you are sitting on logs you out. */}
              {s.current ? (
                <span className="flex items-center gap-1.5 text-[11px] text-fog-500">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />{tr('You')}
                </span>
              ) : (
                <button onClick={() => revoke(s.id)} className="text-xs text-red-300 hover:underline">{tr('Revoke')}</button>
              )}
            </div>
          </div>
        ))}
        {!data?.content?.length && <p className="px-4 py-8 text-center text-sm text-fog-500">{tr('No active sessions.')}</p>}
      </div>
    </div>
  );
}

// `HealthItem` / `HealthCheck` live in lib/types.ts (v0.41.0): HealthActions.tsx renders an item's chips
// and this page mounts them, so declaring the shapes here would have meant that component importing from a
// Next route file which imports the component straight back. `info` items -- a source you switched off, a
// short chapter you already confirmed -- are rendered dimmed so the eye lands on the real findings.

/** Read-only audit of the library: gaps, truncated downloads, duplicates, and failing sources. */
interface DeletedRow {
  id: string; title: string; folder: string; books_count: number; deleted_at: string;
  /** Counted from lib_books: a row whose files Delete files removed has every chapter pruned and none live. */
  live_books: number; pruned_books: number;
}
/** Delete files has already been through this one: nothing on disk, every chapter row a tombstone. */
const filesGone = (r: DeletedRow) => r.live_books === 0 && r.pruned_books > 0;

/** What has been removed from the library, and the way back. Removing never touches files, so this is
 *  always reversible -- the series keeps its id, and with it everyone's progress, favourites and ratings. */
interface LibraryRow {
  id: string; name: string; path: string; n: number;
  age_rating: number | null;
  /** How many of its series were placed here by hand rather than by the folder rule. */
  pinned: number;
  /** Who can open it. Includes members with no restriction at all, who see every library. */
  members: string[];
}
interface LibraryCandidate { path: string; series: number; looksLikeSource: boolean; depth?: number }
interface FolderRow { name: string; path: string; series: number }
interface FolderPage { path: string; parent: string | null; folders: FolderRow[] }

/**
 * Libraries are declared here, never inferred from the filesystem.
 *
 * The candidate list is offered rather than a free-text box because the obvious guess is wrong on a real
 * install: the top level of a library root usually holds SOURCE folders written by the downloader, and
 * promoting one of those makes a "library" named after a scraper. Those candidates are flagged as such.
 */
/**
 * Which libraries one member may see.
 *
 * "All libraries" is the absence of grant rows, not a full set of them. That distinction matters on upgrade
 * (nobody's access changes) and later (a library created next month is visible to unrestricted accounts
 * without touching a single user row), so the toggle writes null rather than every id.
 *
 * Admins are unrestricted by definition and never get this control.
 */
/**
 * The highest age rating one member may see.
 *
 * Mirrors LibraryAccess deliberately: null means no cap, the same way no grant rows means every library, so
 * an account with neither restriction behaves exactly as it did before either existed.
 *
 * The wording says "and below" because a cap is a ceiling, not a band -- and the note about unrated content
 * is there because it is the first thing a parent will ask, and finding out by discovering an unrated title
 * on a child's account would be a bad way to learn it.
 */
const AGE_CAPS = [6, 10, 13, 15, 17, 18];

function AgeCap({ user, onSaved }: { user: any; onSaved: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const cap: number | null = user.max_age_rating ?? null;

  const save = async (next: number | null) => {
    setBusy(true);
    try {
      await api(`/api/admin/users/${user.id}`, { method: 'PATCH', json: { maxAgeRating: next } });
      toast(next === null ? 'No age limit' : `Limited to ${next}+ and below`, 'success');
      onSaved();
    } catch (e) { toast(msgOf(e, 'Could not change that'), 'error'); }
    setBusy(false);
  };

  return (
    <>
      <button onClick={() => setOpen((v) => !v)} className={`chip text-xs ${cap !== null ? 'chip-active' : ''}`}>
        {cap === null ? 'Any age rating' : `${cap}+ and below`}
      </button>
      {open && (
        <div className="mt-1.5 w-full rounded-xl border border-ink-700 p-2.5">
          <label className="flex cursor-pointer items-center justify-between gap-3 text-xs">
            <span className="text-fog-200">{tr('No age limit')}</span>
            <input type="checkbox" checked={cap === null} disabled={busy}
              onChange={(e) => save(e.target.checked ? null : 13)}
              className="size-4 shrink-0 accent-accent" />
          </label>
          {cap !== null && (
            <div className="mt-2 flex flex-wrap gap-1.5 border-t border-ink-800 pt-2">
              {AGE_CAPS.map((v) => (
                <button key={v} disabled={busy} onClick={() => save(v)}
                  className={`chip text-xs disabled:opacity-50 ${cap === v ? 'chip-active' : ''}`}>
                  {v}+
                </button>
              ))}
            </div>
          )}
          <p className="mt-2 text-[11px] text-fog-500">{tr('Series with')}<strong className="text-fog-300">no rating stay visible</strong>. Most libraries carry
            no ratings at all, so hiding them would empty this account rather than filter it. Rate a series
            from its own page to have a limit apply to it.
          </p>
        </div>
      )}
    </>
  );
}

function LibraryAccess({ user, onSaved }: { user: any; onSaved: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data } = useQuery({
    queryKey: ['admin-libraries'],
    queryFn: () => api<{ content: LibraryRow[] }>('/api/admin/libraries'),
    enabled: open,
  });
  const libs = data?.content ?? [];
  const granted: string[] | null = user.libraries ?? null;

  const save = async (next: string[] | null) => {
    setBusy(true);
    try {
      await api(`/api/admin/users/${user.id}`, { method: 'PATCH', json: { libraries: next } });
      toast(next ? `Limited to ${next.length} librar${next.length === 1 ? 'y' : 'ies'}` : 'All libraries', 'success');
      onSaved();
    } catch (e) { toast(msgOf(e, 'Could not change that'), 'error'); }
    setBusy(false);
  };

  const toggle = (id: string) => {
    const base = granted ?? libs.map((l) => l.id);
    save(base.includes(id) ? base.filter((x) => x !== id) : [...base, id]);
  };

  // Only worth showing once there is more than one library to choose between.
  return (
    <>
      <button onClick={() => setOpen((v) => !v)} className={`chip text-xs ${granted ? 'chip-active' : ''}`}>
        {granted ? `${granted.length} librar${granted.length === 1 ? 'y' : 'ies'}` : 'All libraries'}
      </button>
      {open && (
        <div className="mt-1.5 w-full rounded-xl border border-ink-700 p-2.5">
          <label className="flex cursor-pointer items-center justify-between gap-3 text-xs">
            <span className="text-fog-200">{tr('All libraries')}<span className="ms-1 text-fog-500">(including any added later)</span></span>
            <input type="checkbox" checked={!granted} disabled={busy}
              onChange={(e) => save(e.target.checked ? null : libs.map((l) => l.id))}
              className="size-4 shrink-0 accent-accent" />
          </label>
          {granted && (
            <div className="mt-2 flex flex-wrap gap-1.5 border-t border-ink-800 pt-2">
              {libs.map((l) => (
                <button key={l.id} disabled={busy} onClick={() => toggle(l.id)}
                  className={`chip text-xs disabled:opacity-50 ${granted.includes(l.id) ? 'chip-active' : ''}`}>
                  {l.name}
                </button>
              ))}
              {!granted.length && <p className="text-[11px] text-amber-300">{tr('This member currently sees nothing.')}</p>}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Pick a folder: browse what is actually on disk, or type the path.
 *
 * The old dialog offered a fixed list of candidates and nothing else, and that list was computed from the
 * FIRST path segment only -- which on a real install holds the source names the downloader wrote. So the
 * only options offered were the ones not to pick, and the folder an admin actually wanted could not be
 * reached at all. The API always accepted any path; nothing ever asked for one.
 */
function FolderPicker({ value, onPick }: { value: string; onPick: (p: string) => void }) {
  const [at, setAt] = useState('');
  const { data, isFetching } = useQuery({
    queryKey: ['admin-folders', at],
    queryFn: () => api<FolderPage>(`/api/admin/libraries/folders?path=${encodeURIComponent(at)}`),
  });

  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900/40">
      <div className="flex items-center gap-2 border-b border-ink-800 px-2.5 py-1.5">
        <button type="button" disabled={data?.parent === null}
          onClick={() => setAt(data?.parent ?? '')}
          className="chip shrink-0 text-[11px] disabled:opacity-40">↑</button>
        <p className="truncate font-mono text-[11px] text-fog-400">{at || tr('Library root')}</p>
      </div>
      <div data-lenis-prevent className="max-h-44 overflow-y-auto p-1.5">
        {isFetching && !data ? (
          <p className="px-2 py-3 text-center text-[11px] text-fog-600">{tr('Loading…')}</p>
        ) : !data?.folders.length ? (
          <p className="px-2 py-3 text-center text-[11px] text-fog-600">{tr('No folders here')}</p>
        ) : data.folders.map((f) => (
          <div key={f.path} className="flex items-center gap-2">
            <button type="button" onClick={() => setAt(f.path)}
              className="min-w-0 flex-1 truncate rounded px-2 py-1 text-start text-xs text-fog-200 hover:bg-ink-800/70">
              {f.name} <span className="text-fog-600">· {f.series}</span>
            </button>
            <button type="button" onClick={() => onPick(f.path)}
              className={`chip shrink-0 text-[11px] ${value === f.path ? 'chip-active' : ''}`}>
              {tr('Use')}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function LibrariesSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<LibraryRow | null>(null);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [age, setAge] = useState<string>('');
  const [preview, setPreview] = useState<{ series: number; sample: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState<LibraryRow | null>(null);
  const [access, setAccess] = useState<LibraryRow | null>(null);

  const { data } = useQuery({
    queryKey: ['admin-libraries'],
    queryFn: () => api<{ content: LibraryRow[]; candidates: LibraryCandidate[] }>('/api/admin/libraries'),
  });
  const libs = data?.content ?? [];
  const candidates = data?.candidates ?? [];
  // Only to tell "nobody may open this" apart from "there is nobody yet", which on a fresh install is the
  // difference between a warning and a fact. Admins always see everything and are not members.
  const { data: people } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api<{ content: { role: string }[] }>('/api/admin/users'),
  });
  const anyMembers = (people?.content ?? []).some((u) => u.role !== 'admin');
  // Uchiyomi Desktop keeps libraries and their age rating but not who may open them (lib/desktop.ts).
  const desktopLibs = isDesktop();
  const refresh = () => { for (const k of [['admin-libraries'], ['admin-users'], ['library'], ['home']]) qc.invalidateQueries({ queryKey: k }); };

  // Preview follows whatever is typed or clicked, so "what will this contain" is answered before committing.
  useEffect(() => {
    const p = path.trim();
    // Nothing to promise when the path has not been touched: the handler claims only series a LESS specific
    // library holds, so an unchanged path is always zero, and "0 series would move" reads like a warning.
    if (!p || (editing && p === editing.path)) { setPreview(null); return; }
    let alive = true;
    const t = setTimeout(() => {
      api<{ series: number; sample: string[] }>(`/api/admin/libraries/preview?path=${encodeURIComponent(p)}`)
        .then((r) => { if (alive) setPreview(r); })
        .catch(() => { if (alive) setPreview(null); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [path, editing]);

  const openNew = () => { setAdding(true); setEditing(null); setName(''); setPath(''); setAge(''); setPreview(null); };
  const openEdit = (l: LibraryRow) => {
    setEditing(l); setAdding(false);
    setName(l.name); setPath(l.path); setAge(l.age_rating == null ? '' : String(l.age_rating)); setPreview(null);
  };

  const save = async () => {
    setBusy(true);
    try {
      const ageRating = age === '' ? null : Number(age);
      if (editing) {
        const body: Record<string, unknown> = { name: name.trim(), ageRating };
        if (editing.id !== 'lib' && path.trim() !== editing.path) body.path = path.trim();
        await api(`/api/admin/libraries/${editing.id}`, { method: 'PATCH', json: body });
        toast(tr('Saved'), 'success');
      } else {
        // One request. This used to POST the library and then PATCH the rating separately, and skip the
        // PATCH entirely when the rating was null -- so a failed second call created an unrated library
        // under a "Created" toast, which is the one outcome nobody would check for.
        await api('/api/admin/libraries', { method: 'POST', json: { name: name.trim(), path: path.trim(), ageRating } });
        toast(tr('Created'), 'success');
      }
      setAdding(false); setEditing(null);
      refresh();
    } catch (e) { toast(msgOf(e, tr('Could not save that library')), 'error'); }
    setBusy(false);
  };

  const remove = async (l: LibraryRow) => {
    setBusy(true);
    try {
      await api(`/api/admin/libraries/${l.id}`, { method: 'DELETE' });
      toast(tr('Removed'), 'success');
      setConfirmDel(null);
      refresh();
    } catch (e) { toast(msgOf(e, tr('Could not remove that library')), 'error'); }
    setBusy(false);
  };

  const open = adding || editing;
  const canSave = name.trim() && (editing?.id === 'lib' || path.trim());

  return (
    <section className="full">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="font-display text-base font-semibold">{tr('Libraries')}</h3>
        <button onClick={openNew} className="chip shrink-0 text-xs"><IcPlus width={13} height={13} />{tr('New library')}</button>
      </div>
      <p className="mb-3 max-w-prose text-xs leading-relaxed text-fog-500">
        {desktopLibs
          ? tr('A library is a folder, plus any series you file into it by hand. Give it an age rating and everything in it inherits that.')
          : tr('A library is a folder, plus any series you file into it by hand. Give it an age rating and everything in it inherits that, and choose who can open it.')}
      </p>

      {/* Cards rather than one divided list: at 1592px a row left a lake between a library's path and the
          buttons that act on it, and a library is a thing rather than an entry in a feed. */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {libs.map((l) => (
          <div key={l.id} className="card grad-border p-3">
            <div className="min-w-0">
              <p className="truncate text-sm text-fog-100">{l.name}</p>
              <p className="truncate font-mono text-[11px] text-fog-500">
                {l.path || tr('everything not in another library')}
              </p>
              <p className="truncate text-[11px] text-fog-600">
                {l.n} {tr('series')}
                {l.pinned > 0 && <> · {l.pinned === 1 ? tr('1 filed by hand') : tr('{n} filed by hand', { n: l.pinned })}</>}
                {/* Who may open it is per-person access, which desktop does not have (one person, no members). */}
                {!desktopLibs && <>{' · '}{!anyMembers ? tr('admins only') : l.members.length ? tr('{n} can open it', { n: l.members.length }) : tr('nobody can open it')}</>}
              </p>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {/* The rating is its own control on the card, not just a badge.
                  It lives inside the settings dialog, which is correct, but "Edit" gave no hint that age
                  ratings were in there -- so a rating that had never been set looked like a feature that
                  did not exist. Showing the UNRATED state is the point: no badge used to mean both
                  "everyone can see this" and "I never looked". */}
              <button onClick={() => openEdit(l)}
                className={`chip text-xs ${l.age_rating != null ? 'border-amber-500/40 text-amber-300' : ''}`}>
                {l.age_rating != null ? tr('{n}+', { n: l.age_rating }) : tr('Not rated')}
              </button>
              {!desktopLibs && <button onClick={() => setAccess(l)} className="chip text-xs">{tr('Access')}</button>}
              <button onClick={() => openEdit(l)} className="chip text-xs">{tr('Settings')}</button>
              {l.id !== 'lib' && (
                <button onClick={() => setConfirmDel(l)} className="chip text-xs hover:border-rose-500/50 hover:text-rose-400">{tr('Remove')}</button>
              )}
            </div>
          </div>
        ))}
      </div>

      {candidates.length > 0 && (
        <>
          <p className="mb-1.5 mt-4 text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Folders you could split out')}</p>
          <div className="flex flex-wrap gap-1.5">
            {candidates.slice(0, 12).map((c) => (
              <button key={c.path} onClick={() => { openNew(); setPath(c.path); setName(c.path.split('/').pop() || c.path); }}
                className={`chip text-xs ${c.looksLikeSource ? 'opacity-60' : ''}`}>
                <span className="font-mono">{c.path}</span> <span className="text-fog-500">· {c.series}</span>
                {c.looksLikeSource && <span className="ms-1 text-amber-400">{tr('source?')}</span>}
              </button>
            ))}
          </div>
        </>
      )}

      {open && (
        <Modal title={editing ? tr('Edit library') : tr('New library')} onClose={() => { setAdding(false); setEditing(null); }}>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Name')}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className="field" />

          {editing?.id !== 'lib' && (
            <>
              <label className="mb-1 mt-3 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Folder')}</label>
              <input value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false}
                placeholder={tr('e.g. Manga/Seinen')} className="field font-mono" />
              <p className="mb-2 mt-1 text-[11px] text-fog-600">
                {tr('Type any folder under your library root, or browse below. Libraries may sit inside one another — the most specific one wins.')}
              </p>
              <FolderPicker value={path} onPick={(p) => { setPath(p); if (!name.trim()) setName(p.split('/').pop() || p); }} />
            </>
          )}

          <label className="mb-1 mt-3 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Age rating')}</label>
          <select value={age} onChange={(e) => setAge(e.target.value)} className="field">
            <option value="">{tr('Not rated — visible to everyone')}</option>
            {[6, 10, 13, 15, 17, 18].map((v) => <option key={v} value={String(v)}>{v}+</option>)}
          </select>
          <p className="mt-1 text-[11px] text-fog-600">
            {tr('Everything in this library inherits it. A single series can still be rated differently from its own page.')}
          </p>

          {preview && (
            <p className="mt-3 text-[11px] leading-relaxed text-fog-500">
              {tr('{n} series would move', { n: preview.series })}
              {preview.sample.length > 0 && <>, {tr('including')} {preview.sample.slice(0, 3).join(', ')}{preview.sample.length > 3 ? '…' : ''}</>}
              . {tr('No files are deleted.')}
            </p>
          )}

          <div className="mt-4 flex gap-2">
            <button onClick={() => { setAdding(false); setEditing(null); }} className="btn-ghost flex-1 py-2 text-sm">{tr('Cancel')}</button>
            <button onClick={save} disabled={busy || !canSave} className="btn-accent flex-1 py-2 text-sm disabled:opacity-50">
              {busy ? tr('Working…') : editing ? tr('Save') : tr('Create')}
            </button>
          </div>
        </Modal>
      )}

      {access && <LibraryAccessDialog lib={access} onClose={() => setAccess(null)} onSaved={refresh} />}

      {confirmDel && (
        <ConfirmDialog
          title={tr('Remove “{name}”?', { name: confirmDel.name })}
          body={<>{tr('Its series go back to whichever library still covers their folder, or to the default. Nothing is deleted, no files are touched, and no reading progress changes.')}</>}
          confirmLabel={tr('Remove library')}
          danger
          busy={busy}
          onConfirm={() => remove(confirmDel)}
          onClose={() => setConfirmDel(null)}
        />
      )}
    </section>
  );
}

/**
 * Who can open one library.
 *
 * The subtlety worth stating in the UI: a member with no restrictions at all can see EVERY library, so they
 * are shown as already able to open this one. Granting them is a no-op. Revoking them is not -- it has to
 * write out every other library explicitly, because "everything except this" cannot be said any other way.
 * The server does that; this just has to describe it honestly.
 */
function LibraryAccessDialog({ lib, onClose, onSaved }: { lib: LibraryRow; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set(lib.members));
  const { data } = useQuery({ queryKey: ['admin-users'], queryFn: () => api<{ content: any[] }>('/api/admin/users') });
  const members = (data?.content ?? []).filter((u) => u.role !== 'admin');

  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/admin/libraries/${lib.id}`, { method: 'PATCH', json: { members: [...sel] } });
      toast(tr('Saved'), 'success');
      onSaved();
      onClose();
    } catch (e) { toast(msgOf(e, tr('Could not change that')), 'error'); }
    setBusy(false);
  };

  return (
    <Modal title={tr('Who can open “{name}”?', { name: lib.name })} onClose={onClose}>
      {!members.length ? (
        <p className="text-sm text-fog-500">{tr('No members yet.')}</p>
      ) : (
        <div className="space-y-1">
          {members.map((u) => (
            <label key={u.id} className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-ink-800/50">
              <span className="min-w-0 truncate text-fog-200">{u.display_name || u.username}</span>
              <input type="checkbox" checked={sel.has(u.id)} disabled={busy}
                onChange={(e) => setSel((prev) => { const n = new Set(prev); e.target.checked ? n.add(u.id) : n.delete(u.id); return n; })}
                className="size-4 shrink-0 accent-accent" />
            </label>
          ))}
        </div>
      )}
      <p className="mt-3 text-[11px] leading-relaxed text-fog-600">
        {tr('Admins can always see everything. A member with no limits set can open every library, including ones added later — unticking them here is what turns that into an explicit list.')}
      </p>
      <div className="mt-4 flex gap-2">
        <button onClick={onClose} className="btn-ghost flex-1 py-2 text-sm">{tr('Cancel')}</button>
        <button onClick={save} disabled={busy} className="btn-accent flex-1 py-2 text-sm disabled:opacity-50">
          {busy ? tr('Working…') : tr('Save')}
        </button>
      </div>
    </Modal>
  );
}

function LibraryPanel() {
  const qc = useQueryClient();
  const [purge, setPurge] = useState<DeletedRow | null>(null);
  const [purging, setPurging] = useState(false);

  const deleteFiles = async (r: DeletedRow) => {
    setPurging(true);
    try {
      const res = await api<{ files: number; bytes: number }>(`/api/admin/series/${r.id}/delete-files`,
        { method: 'POST', json: { confirm: r.title } });
      // Counted in pairs and translated (v0.52.0): "Deleted 1 file(s)" was the one English toast left on this panel.
      const size = `${(res.bytes / 1048576).toFixed(1)} MB`;
      toast(res.files === 1 ? tr('Deleted 1 file, {size}', { size }) : tr('Deleted {n} files, {size}', { n: res.files, size }), 'success');
      setPurge(null);
      qc.invalidateQueries({ queryKey: ['admin-deleted'] });
    } catch (e: any) {
      // A refusal carries the actual reason and, for a permissions problem, the exact fix.
      let msg = msgOf(e, 'Could not delete the files');
      try { const b = JSON.parse(e?.body || '{}'); if (b.fix) msg = `${b.message} ${b.fix}`; } catch {}
      toast(msg, 'error');
    }
    setPurging(false);
  };
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['admin-deleted'],
    queryFn: () => api<{ content: DeletedRow[] }>('/api/admin/series/deleted'),
  });
  const rows = data?.content || [];

  // The third step. Remove hides, Delete files lets the bytes go, Forget erases the row and everyone's
  // history on it -- the one action here that rewrites other members' stats and Wrapped, and the one with
  // no Put back. The server refuses (409) while anything could bring the series back: a live chapter row
  // (which is what an unmounted share leaves behind), a root that is not there, a folder that still holds
  // chapters. The refusal carries the fix.
  const [forget, setForget] = useState<DeletedRow | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const forgetSeries = async (r: DeletedRow) => {
    setForgetting(true);
    try {
      const res = await api<{ books: number; absorbed: number; users: number }>(`/api/admin/series/${r.id}/forget`,
        { method: 'POST', json: { confirm: r.title } });
      toast(res.users === 0 ? tr('Forgotten. Nobody had read it.')
        : res.users === 1 ? tr("Forgotten. 1 member's history on it is gone.")
        : tr("Forgotten. {n} members' history on it is gone.", { n: res.users }), 'success');
      setForget(null);
      qc.invalidateQueries({ queryKey: ['admin-deleted'] });
    } catch (e: any) {
      let msg = msgOf(e, tr('Could not forget it'));
      try { const b = JSON.parse(e?.body || '{}'); if (b.fix) msg = `${b.message} ${b.fix}`; } catch {}
      toast(msg, 'error');
    }
    setForgetting(false);
  };

  const restore = async (r: DeletedRow) => {
    setBusy(r.id);
    try {
      await api(`/api/admin/series/${r.id}/restore`, { method: 'POST' });
      toast(`\u201c${r.title}\u201d is back in the library`, 'success');
      qc.invalidateQueries({ queryKey: ['admin-deleted'] });
    } catch (e) { toast(msgOf(e, 'Could not restore it'), 'error'); }
    setBusy(null);
  };

  return (
    <div className="board">
      <LibrariesSection />
      {purge && (
        <ConfirmDialog
          title={`Delete the files for "${purge.title}"?`}
          body={
            <>
              {/* `live_books`, not books_count: the scan wrote books_count before anything was pruned, and a
                  series with two files left and three tombstones would be told "this deletes 5". */}
              <p><strong className="text-fog-100">This deletes {purge.live_books} chapter file(s) from your
                disk.</strong>{tr('It cannot be undone from here.')}</p>
              <p className="mt-2">Everyone&rsquo;s reading progress and history are kept, so the record of
                having read it survives even though the files do not.</p>
              {/* The path is LTR text whatever the UI direction: unmarked, Arabic moved its leading slash
                  to the far end ("library-dl/mangadex/gone-for-good/"). */}
              <p className="mt-2 text-fog-500">{tr('Folder')}: <span dir="ltr">{purge.folder}</span></p>
            </>
          }
          confirmLabel="Delete files"
          confirmText={purge.title}
          danger
          busy={purging}
          onConfirm={() => deleteFiles(purge)}
          onClose={() => setPurge(null)}
        />
      )}
      {forget && (
        <ConfirmDialog
          title={tr('Forget "{title}" for good?', { title: forget.title })}
          body={
            <>
              {/* The opposite of the Delete-files reassurance above, on purpose: that dialog promises the
                  history survives, and this is the step that takes it. Named per kind so nobody reads
                  "history" as "just the progress bar". */}
              <p><strong className="text-fog-100">{tr("This erases the series and everyone's reading history on it — progress, bookmarks, notes, ratings, favourites, tracker links.")}</strong></p>
              <p className="mt-2">{tr('Stats and Wrapped change. If the files ever reappear it comes back as a new series with no history. This cannot be undone.')}</p>
              <p className="mt-2 text-fog-500">{tr('Folder')}: <span dir="ltr">{forget.folder}</span></p>
            </>
          }
          confirmLabel={tr('Forget')}
          confirmText={forget.title}
          danger
          busy={forgetting}
          onConfirm={() => forgetSeries(forget)}
          onClose={() => setForget(null)}
        />
      )}
      <div className="full space-y-3">
        <p className="max-w-prose text-xs text-fog-500">
          {tr('Removing a series hides it from the library, search and the updater. Its files are left exactly where they are, and everyone’s reading progress is kept, so putting it back changes nothing else.')}
        </p>
        {isLoading ? (
          <div className="card grad-border p-4 text-sm text-fog-500">{tr('Loading…')}</div>
        ) : !rows.length ? (
          <div className="card grad-border p-6 text-center text-sm text-fog-500">{tr('Nothing has been removed.')}</div>
        ) : (
          <div className="card grad-border divide-y divide-ink-800/70 overflow-hidden">
            {rows.map((r) => (
              <div key={r.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-4 py-3 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)_auto]">
                {/* Two lines on a phone, one with an ellipsis and a tooltip on a desktop: a real title
                    ("Kaguya-sama: Love Is War – The First Kiss That Never Ends") measured 506 px against a
                    168 px column at 390, and two long-prefix titles were indistinguishable in the list. The
                    typed step in the dialog carries the full title either way. `lg:block` first, so the
                    -webkit-box the clamp needs gives way to the nowrap ellipsis. */}
                <p className="col-start-1 row-start-1 min-w-0 line-clamp-2 text-sm text-fog-100 lg:block lg:truncate" title={r.title}>{r.title}</p>
                {/* The state LEADS the caption: at 390 px the caption truncates after ~130 px, and "files
                    deleted" at its end was exactly the part cut off. The explanation is a visible second
                    line, not a title= tooltip -- a phone never shows one. The button stays "Put back": a
                    longer label ("Put back (files were deleted)") squeezed the title to "Gone F…" in German. */}
                <p className="col-start-1 row-start-2 min-w-0 truncate text-[11px] text-fog-500 lg:col-start-2 lg:row-start-1">
                  {filesGone(r) ? `${tr('files deleted')} · ` : ''}
                  {r.books_count === 1
                    ? tr('1 chapter · removed {when}', { when: relativeTime(r.deleted_at) })
                    : tr('{n} chapters · removed {when}', { n: r.books_count, when: relativeTime(r.deleted_at) })}
                  {' · '}{r.folder}
                </p>
                {filesGone(r) && (
                  <p className="col-span-2 col-start-1 row-start-3 min-w-0 text-[11px] text-fog-400 lg:col-span-1 lg:col-start-2 lg:row-start-2">
                    {tr('The chapter files are gone. Put back lists them as deleted from the server; Fetch again on the series page brings back the ones Uchiyomi downloaded.')}
                  </p>
                )}
                <div className="col-start-2 row-span-2 row-start-1 flex shrink-0 gap-1.5 justify-self-end lg:col-start-3 lg:row-span-1">
                  {/* After Delete files the button still works -- the series comes back with every chapter
                      marked "Deleted from the server", which is where Fetch again lives -- and the caption
                      above says so: an unmarked "Put back" here used to restore a series whose chapters all
                      404'd. */}
                  <button onClick={() => restore(r)} disabled={busy === r.id} className="chip shrink-0 text-xs disabled:opacity-50">
                    {busy === r.id ? tr('Restoring…') : tr('Put back')}
                  </button>
                  {/* The escalation, and only ever after the reversible step. Hiding is undoable; this is not.
                      Only while a chapter row still claims a file: with every file gone it would only report
                      "Deleted 0 file(s)", and a row that never had a chapter is refused outright ("no files
                      on disk"). ⚠️ `live_books > 0`, the exact complement of Forget's `=== 0` below, so a
                      row never carries both and never a third chip: at 390 px three chips squeezed "Never
                      Had Chapters" to 21 px of title. */}
                  {r.live_books > 0 && (
                    <button onClick={() => setPurge(r)} className="chip shrink-0 text-xs hover:border-rose-500/50 hover:text-rose-400">{tr('Delete files')}</button>
                  )}
                  {/* The third step, and only once nothing is left on disk to bring the series back: the
                      files-gone row, or a row that never had a chapter. Painted rose outright rather than
                      on hover -- the other two chips are recoverable, this one is not. The server refuses
                      on its own if a folder still holds chapters or a root is not there, and the toast
                      carries its fix. */}
                  {r.live_books === 0 && (
                    <button onClick={() => setForget(r)} className="chip shrink-0 border-rose-500/40 text-xs text-rose-300 hover:border-rose-500/70 hover:text-rose-200">{tr('Forget')}</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Health() {
  const [open, setOpen] = useState<string | null>(null);
  const { data, isFetching, refetch } = useQuery({
    queryKey: ['admin-health'],
    queryFn: () => api<{ generatedAt: string; checks: HealthCheck[] }>('/api/admin/health'),
  });
  const checks = data?.checks || [];
  const bad = checks.filter((c) => c.status !== 'ok').length;
  // After anything on this page changes a finding -- a repair that ENDED, an ignore -- the page is checked
  // again, and the header's mark with it: the refetch stores a new summary, and the header reads that summary.
  const qc = useQueryClient();
  const recheck = () => refetch().then(() => qc.invalidateQueries({ queryKey: ['health-summary'] }));

  // One card per check, and a failing one earns the full width of the board -- the same severity rule the
  // overview uses, so the shape of the panel is the verdict. The repair provider holds the live run and its
  // history for every row, card and the page's own Fix all issues (lib/useRepairRun.tsx); the find provider
  // (v0.49.1) follows a "Find other sources" run for the rows that offer it and for its card under the checks.
  return (
    <RepairRunProvider onEnded={recheck}>
    <FindRunProvider onEnded={recheck}>
      <div className="board">
        {/* Wraps: at phone width the sentence and the key do not fit on one line (v0.48.3). */}
        <div className="full flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-fog-500">
            {!data ? tr('Checking your library…')
              : bad ? tr('Checks that found something: {n} of {m}', { n: bad, m: checks.length })
              : tr('Everything looks healthy')}
            {data && <> · {tr('checked {when}', { when: relativeTime(data.generatedAt) })}</>}
          </p>
          <button type="button" onClick={() => refetch()} disabled={isFetching} className="btn-key">
            <IcRefresh aria-hidden width={14} height={14} />{isFetching ? tr('Checking…') : tr('Re-check')}
          </button>
        </div>

        <RepairLiveStrip />
        <FixAllIssues checks={checks} />

        {checks.map((c) => {
          const isOpen = open === c.id;
          // Notes explain important states that are deliberately not findings. A readable partial chapter, for
          // example, is absent from the active failure ledger but this note is the only place Health says where
          // it appears and when it is repaired. Keep those cards expandable even when `items` is empty -- and
          // a card with an action of its own (Scan the library now) too.
          const expandable = !!c.items.length || !!c.note || hasCardActions(c);
          const mark = healthMark(c.status);
          const rowKeys = keysFor(c.id, c.items);
          return (
            <div key={c.id} data-health-check={c.id} className={`card grad-border relative overflow-hidden ${c.status !== 'ok' ? 'full' : ''}`}>
              <StatusEdge tone={mark.tone} />
              {/* ⚠️ The disclosure is the FIRST button in the card: the end-to-end walks open a card by
                  clicking the first button inside `[data-health-check="…"]`. Every action lives in the body. */}
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : c.id)}
                aria-expanded={expandable ? isOpen : undefined}
                aria-controls={expandable ? `health-${c.id}-details` : undefined}
                disabled={!expandable}
                className="flex w-full min-w-0 items-center gap-x-3 px-4 py-3.5 text-start disabled:cursor-default"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span className="text-sm text-fog-100">{checkTitle(c)}</span>
                    <StatusMark {...mark} size="xs" />
                    <CardProgress checkId={c.id} />
                  </p>
                  <p dir="auto" className="mt-0.5 text-[11px] text-fog-500">{checkSummary(c)}</p>
                </div>
                {expandable && (
                  <>
                    <span className="sr-only">{isOpen ? tr('Hide details') : tr('Show details')}</span>
                    <span aria-hidden className="inline-grid shrink-0 text-fog-500 rtl:-scale-x-100">
                      <IcChevronRight width={16} height={16} className={`transition ${isOpen ? 'rotate-90' : ''}`} />
                    </span>
                  </>
                )}
              </button>
              {c.id === 'update' && <DesktopUpdateNote />}

              {/* v0.53.0: Source health draws a body of its own -- the sources the library depends on first, one line
                  and one key each, the rest folded, and its glossary at its foot (components/SourceHealthBody.tsx). */}
              {isOpen && c.id === 'sources' && (
                <div id={`health-${c.id}-details`} className="border-t border-ink-800/70">
                  <SourceHealthBody check={c} />
                </div>
              )}
              {isOpen && c.id !== 'sources' && (
                <div id={`health-${c.id}-details`} className="border-t border-ink-800/70">
                  <HealthCardActions check={c} />
                  {c.note && <p data-health-note dir="auto" className="px-4 pt-3 text-[11px] leading-relaxed text-fog-500">{checkNote(c)}</p>}
                  <div className="divide-y divide-ink-800/70">
                    {c.items.map((it, i) => (
                      <HealthRow key={rowKeys[i]} rowKey={rowKeys[i]} check={c} item={it}
                        // To the chapter the finding is about, not just its series (lib/healthLinks.ts). A duplicate
                        // pair gets one per copy, each naming its copy: two bare "Open"s cannot be told apart on a
                        // phone, where there is no tooltip. Text links, not chips: they go somewhere, they do nothing.
                        // Two lines, never cut: "Öffnen · Einstellungen der Q…" hid which settings it opens (the
                        // arrow is held to the last word by a no-break space).
                        links={healthLinks(c.id, it).map((l) => (
                          <Link key={l.href} href={l.href} className="line-clamp-2 max-w-[11rem] break-words text-end text-xs text-accent hover:underline"
                            title={l.label} aria-label={l.label ? `${tr('Open')}: ${l.label}` : undefined}
                            // A page off the app (the install guide, v0.52.0) opens beside it, never in place of it.
                            {...(/^https?:\/\//.test(l.href) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
                            {l.label ? `${tr('Open')} · ${l.label}` : tr('Open')}{'\u00a0'}›
                          </Link>
                        ))}>
                        {/* The server's words, in the reader's language where it sent their codes (lib/said.ts) and
                            in English where it could not (a folder's own error); a title in any script: `dir="auto"`,
                            or in an Arabic page a sentence's full stop and closing bracket land at its start. */}
                        <p dir="auto" className="break-words text-sm text-fog-100">{itemTitle(it)}</p>
                        <p dir="auto" className="text-[11px] text-fog-500">{itemDetail(it)}</p>
                      </HealthRow>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <FindRunCard />
        <RepairHistory />
      </div>
    </FindRunProvider>
    </RepairRunProvider>
  );
}

/**
 * Under the Health "Version" card on Uchiyomi Desktop: what the SHELL knows about a newer release.
 *
 * The card above still comes from the server's own GitHub check, which is the only update path on an
 * unsigned Mac. The shell adds the half the server cannot do: on Windows it has already downloaded the
 * update (`ready` -> restart to install); on a Mac it can only point at the release page. Renders nothing
 * without the bridge, or while there is nothing newer, so the server build's card is exactly as it was.
 */
function DesktopUpdateNote() {
  const b = bridge();
  const [u, setU] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    if (!b?.update?.status) return;
    let live = true;
    b.update.status().then((s) => { if (live) setU(s); }).catch(() => {});
    return () => { live = false; };
  }, [b]);
  if (!b || !u?.available) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-ink-800/70 px-4 py-2.5">
      <p className="min-w-0 flex-1 text-sm text-fog-100">
        {u.version ? tr('New version available — {version}', { version: u.version }) : tr('New version available')}
      </p>
      {u.ready && typeof b.update.installNow === 'function' ? (
        <button type="button" onClick={() => b.update.installNow()} className="chip shrink-0 text-xs">{tr('Restart to update')}</button>
      ) : u.url ? (
        <a href={u.url} target="_blank" rel="noopener noreferrer" className="chip shrink-0 text-xs">{tr('Download')}</a>
      ) : null}
    </div>
  );
}
