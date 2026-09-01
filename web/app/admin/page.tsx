'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, img } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { triggerRefresh } from '@/lib/refresh';
import { bytes, relativeTime } from '@/lib/format';
import { useToast } from '@/components/Toast';
import { ConfirmDialog, Modal, msgOf } from '@/components/ConfirmDialog';
import { Avatar } from '@/components/Avatar';
import { IcChevronLeft, IcTrash, IcPlus, IcRefresh } from '@/components/icons';
import { Backdrop, Img } from '@/components/ui';
import { SeriesCard } from '@/components/cards';
import { Switch } from '@/components/Switch';
import { ConsoleNav } from '@/components/ConsoleNav';
import { motion, useReducedMotion } from 'framer-motion';
import { t as tr, keys } from '@/lib/i18n';
import type { Series } from '@/lib/types';

/**
 * Ten panels, grouped by what an admin is actually doing rather than by what the code is called.
 *
 * The previous shell put all ten in one horizontally scrolling pill row, which is a list rather than an
 * information architecture: "Overview" and "Sessions" were peers, and on a laptop the last three scrolled off
 * the edge where nobody found them. Extensions had no entry at all -- it rendered inside Providers, which is
 * why nobody found that either.
 */
const GROUPS = [
  // `keys()` is the identity function; it exists so these reach the translation extractor. ConsoleNav
  // renders them as `tr(g.label)` and `tr(tab)`, which a scan for inline tr() calls cannot see, and that blind
  // spot has now shipped an English sidebar twice. See lib/i18n.ts.
  { id: 'server',  label: 'Server',  tabs: keys('Overview', 'Tasks', 'Settings') },
  { id: 'people',  label: 'People',  tabs: keys('Members', 'Sessions', 'Activity') },
  { id: 'content', label: 'Content', tabs: keys('Library', 'Health', 'Art') },
  { id: 'sources', label: 'Sources', tabs: keys('Providers', 'Extensions') },
] as const;
// The group labels themselves, for the same reason.
const _GROUP_LABELS = keys('Server', 'People', 'Content', 'Sources');

const TABS = GROUPS.flatMap((g) => g.tabs);
type Tab = (typeof TABS)[number];
const STATUS_STYLE: Record<string, string> = {
  ok: 'bg-emerald-600/20 text-emerald-300', blocked: 'bg-red-600/20 text-red-300',
  rate_limited: 'bg-amber-600/20 text-amber-300', down: 'bg-orange-600/20 text-orange-300', disabled: 'bg-ink-700 text-fog-400',
  // Answers without error, returns nothing. Deliberately not red: it may be a site redesign rather than a
  // failure, and until it is tested nobody knows which.
  quiet: 'bg-fog-600/20 text-fog-300',
};

export default function AdminPage() {
  const { isAdmin } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('Overview');

  if (!isAdmin) return <div className="flex min-h-screen-d items-center justify-center text-fog-400">{tr('Admins only.')}</div>;

  const panel = (
    <>
      {tab === 'Overview' && <Overview onTab={setTab} />}
      {tab === 'Members' && <Members />}
      {tab === 'Providers' && <Providers />}
      {tab === 'Extensions' && <div className="board"><Extensions span="full" /></div>}
      {tab === 'Art' && <ArtReview />}
      {tab === 'Health' && <Health />}
      {tab === 'Library' && <LibraryPanel />}
      {tab === 'Tasks' && <Tasks />}
      {tab === 'Activity' && <Activity />}
      {tab === 'Sessions' && <Sessions />}
      {tab === 'Settings' && <Settings />}
    </>
  );

  return (
    <div className="min-h-screen-d px-4 lg:px-0">
      <AdminHero onBack={() => router.back()} />

      <ConsoleNav groups={GROUPS} tab={tab} onTab={setTab} ariaLabel={tr('Admin')}>
        {panel}
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
  const toast = useToast();
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

  const scan = async () => {
    toast(tr('Scanning library…'));
    await triggerRefresh();
    setTimeout(() => qc.invalidateQueries({ queryKey: ['admin-stats'] }), 2500);
  };

  // Separate singular keys rather than a plural library. Nine languages with one count each does not justify
  // Intl.PluralRules and a rules table; "1 members" does need fixing, and every language here can express
  // both forms as two strings.
  const facts = [
    stats ? tr('{n} series', { n: stats.seriesTotal }) : null,
    stats ? (stats.members === 1 ? tr('1 member') : tr('{n} members', { n: stats.members })) : null,
    stats ? tr('{size} cached', { size: bytes(stats.cacheBytes) }) : null,
    stats?.lastScan ? tr('scanned {when}', { when: relativeTime(new Date(stats.lastScan).toISOString()) }) : null,
  ].filter(Boolean) as string[];

  return (
    <div className="bleed relative isolate mb-6 overflow-hidden lg:mt-2 lg:rounded-b-3xl">
      {rnd?.seriesId && <Backdrop seriesId={rnd.seriesId} className="absolute inset-0" />}
      {/* Drowned deliberately: this is a wash to sit text on, not a picture to look at. */}
      <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/90 to-ink-950/70" />
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
          <button onClick={scan} className="btn-accent px-5 py-2.5 text-sm">
            <IcRefresh width={16} height={16} />{tr('Scan library now')}
          </button>
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
  const { data: sessions } = useQuery({ queryKey: ['admin-sessions'], queryFn: () => api<{ content: any[] }>('/api/admin/sessions') });
  const { data: sources } = useQuery({ queryKey: ['sources'], queryFn: () => api<{ content: any[] }>('/api/sources') });

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
                <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-ink-950 via-ink-950/80 to-ink-950/35 rtl:bg-gradient-to-l" />
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
      <TabTile label={tr('Sessions')} value={String(sessions?.content?.length ?? 0)}
        sub={sessions?.content?.[0] ? relativeTime(sessions.content[0].last_seen) : undefined} onClick={() => onTab('Sessions')} />
      <TabTile label={tr('Providers')} value={String(sources?.content?.length ?? 0)} onClick={() => onTab('Providers')} />
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
          {failing.map((c) => (
            <div key={c.id} className={`rounded-2xl border px-3 py-2.5 ${HEALTH_TONE[c.status]}`}>
              <p className="text-sm font-medium text-fog-100">{c.title}</p>
              <p className="mt-0.5 text-[11px] text-fog-400">{c.summary}</p>
            </div>
          ))}
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

function Providers() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: srcs } = useQuery({ queryKey: ['sources'], queryFn: () => api<{ content: any[] }>('/api/sources') });
  const { data: health } = useQuery({ queryKey: ['admin-sources'], queryFn: () => api<{ content: any[] }>('/api/admin/sources'), refetchInterval: 10000 });
  const hmap = new Map((health?.content || []).map((h) => [h.source_id, h]));
  const act = async (id: string, action: string, ok: string) => { try { await api(`/api/admin/sources/${id}/${action}`, { method: 'POST' }); toast(ok, 'success'); qc.invalidateQueries({ queryKey: ['admin-sources'] }); qc.invalidateQueries({ queryKey: ['sources'] }); } catch { toast('Failed', 'error'); } };
  const { data: custom } = useQuery({ queryKey: ['admin-custom'], queryFn: () => api<{ content: any[] }>('/api/admin/sources/custom') });
  const customIds = new Set((custom?.content || []).map((c: any) => c.id));
  const [reloading, setReloading] = useState(false);
  const reload = async () => {
    setReloading(true);
    try {
      const r = await api<{ available: number }>('/api/admin/sources/reload', { method: 'POST' });
      toast(`Reloaded — ${r.available} source${r.available === 1 ? '' : 's'} available`, 'success');
      qc.invalidateQueries({ queryKey: ['sources'] });
      qc.invalidateQueries({ queryKey: ['admin-sources'] });
    } catch { toast('Reload failed', 'error'); }
    setReloading(false);
  };
  const inval = () => { qc.invalidateQueries({ queryKey: ['sources'] }); qc.invalidateQueries({ queryKey: ['admin-sources'] }); qc.invalidateQueries({ queryKey: ['admin-custom'] }); };
  const [eng, setEng] = useState<'auto' | 'madara' | 'manganato' | 'mangathemesia'>('auto');
  const [sname, setSname] = useState('');
  const [sbase, setSbase] = useState('');
  const [adding, setAdding] = useState(false);
  type Smoke = { ok: boolean; timedOut?: boolean; checks: { name: string; ok: boolean; detail: string }[] };
  const [smoke, setSmoke] = useState<{ name: string; res: Smoke } | null>(null);
  const addSite = async () => {
    if (!sname.trim() || !sbase.trim()) return;
    setAdding(true); setSmoke(null);
    const nm = sname.trim();
    try {
      const r = await api<{ engine?: string; smoke?: Smoke }>('/api/admin/sources/custom', { json: { engine: eng, name: nm, base: sbase.trim() } });
      const eng2 = eng === 'auto' && r.engine ? ` (${r.engine})` : '';
      if (r.smoke) setSmoke({ name: nm, res: r.smoke });
      if (r.smoke && r.smoke.ok) toast(`Added ${nm}${eng2} — verified ✓`, 'success');
      else if (r.smoke) toast(`Added ${nm}${eng2}, but some checks failed — see below`, 'error');
      else toast(`Added ${nm}${eng2}`, 'success');
      setSname(''); setSbase(''); inval();
    }
    catch (e: any) { toast(msgOf(e, "Couldn't add — check the URL or pick the engine manually"), 'error'); }
    setAdding(false);
  };
  // A live verdict per source, kept until the panel is left. The stored error can be months older than the
  // running container, so a test result always wins the display.
  const [sweep, setSweep] = useState<any>(null);
  const [checking, setChecking] = useState(false);
  /** Run the daily watchdog on demand. Slow on purpose: every source is probed one at a time. */
  const checkAll = async () => {
    setChecking(true);
    try {
      const r = await api<any>('/api/admin/sources/check', { method: 'POST' });
      setSweep(r);
      toast(r.needsAttention.length ? `${r.needsAttention.length} source(s) need attention` : 'All sources healthy',
        r.needsAttention.length ? 'error' : 'success');
      inval();
    } catch (e: any) { toast(msgOf(e, 'Could not run the check'), 'error'); }
    setChecking(false);
  };

  const [tested, setTested] = useState<Map<string, any>>(new Map());
  const [testingId, setTestingId] = useState<string | null>(null);
  const testSource = async (id: string) => {
    setTestingId(id);
    try {
      const r = await api<any>(`/api/admin/sources/${encodeURIComponent(id)}/test`, { method: 'POST' });
      setTested((m) => new Map(m).set(id, r));
      toast(r.ok ? 'Working' : (r.diagnosis?.reason || 'Still failing'), r.ok ? 'success' : 'error');
      inval();
    } catch (e: any) {
      toast(msgOf(e, 'Could not test that source'), 'error');
    }
    setTestingId(null);
  };
  /** The one-click half of a moved site: the probe already found where it went. */
  const moveSite = async (id: string) => {
    const to = tested.get(id)?.probe?.finalUrl;
    if (!to) return;
    const origin = (() => { try { return new URL(to).origin; } catch { return null; } })();
    if (!origin) return;
    try {
      const r = await api<any>(`/api/admin/sources/custom/${encodeURIComponent(id)}`, { method: 'PATCH', json: { base: origin } });
      toast(r.smoke?.ok ? `Moved to ${origin}, verified` : `Moved to ${origin}`, r.smoke?.ok ? 'success' : 'error');
      setTested((m) => { const n = new Map(m); n.delete(id); return n; });
      inval();
    } catch (e: any) { toast(msgOf(e, 'Could not update the address'), 'error'); }
  };

  const removeSite = async (id: string) => { try { await api(`/api/admin/sources/custom/${id}`, { method: 'DELETE' }); toast('Removed', 'success'); inval(); } catch { toast('Failed', 'error'); } };

  type ImportJob = { running: boolean; total: number; done: number; added: number; already: number; notFound: number; failed: number; details: Array<{ title: string; status: string; source?: string }> };
  const [imp, setImp] = useState('');
  const [importing, setImporting] = useState(false);
  const { data: importStatus, refetch: refetchImport } = useQuery({ queryKey: ['admin-import'], queryFn: () => api<{ job: ImportJob | null }>('/api/admin/import/status'), refetchInterval: 2000 });
  const job = importStatus?.job;
  const runImport = async () => {
    const titles = imp.split('\n').map((t) => t.trim()).filter(Boolean);
    if (!titles.length) return;
    setImporting(true);
    try { await api('/api/admin/import', { json: { titles } }); toast(`Importing ${titles.length} title${titles.length === 1 ? '' : 's'}…`, 'success'); refetchImport(); }
    catch (e: any) { toast(msgOf(e, 'Import failed to start'), 'error'); }
    setImporting(false);
  };

  // --- intake: parse a backup/list into the textarea for review, importing nothing yet ---
  type ParseResult = { origin: string; total: number; truncated: boolean; items: Array<{ title: string; inLibrary: boolean }> };
  const backupRef = useRef<HTMLInputElement>(null);
  const [mdUrl, setMdUrl] = useState('');
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState<{ total: number; already: number; truncated: boolean } | null>(null);
  const applyParsed = (r: ParseResult) => {
    // pre-filter what's already here: re-importing your own library is just a slow no-op
    const fresh = r.items.filter((i) => !i.inLibrary).map((i) => i.title);
    setImp(fresh.join('\n'));
    setParsed({ total: r.total, already: r.items.length - fresh.length, truncated: r.truncated });
    toast(fresh.length ? `${fresh.length} titles ready to review` : 'Everything in that list is already in your library', fresh.length ? 'success' : undefined);
  };
  const parseBackup = async (f: File) => {
    if (f.size > 10 * 1024 * 1024) { toast('That file is unusually large (max ~10 MB)', 'error'); return; }
    setParsing(true);
    try {
      const dataUrl = await new Promise<string>((res, rej) => { const rd = new FileReader(); rd.onload = () => res(String(rd.result)); rd.onerror = () => rej(new Error('read')); rd.readAsDataURL(f); });
      applyParsed(await api<ParseResult>('/api/admin/import/parse', { json: { dataUrl } }));
    } catch (e: any) { toast(msgOf(e, 'Could not read that backup'), 'error'); }
    setParsing(false);
  };
  const parseMangadex = async () => {
    setParsing(true);
    try { applyParsed(await api<ParseResult>('/api/admin/import/parse', { json: { mangadexList: mdUrl.trim() } })); }
    catch (e: any) { toast(msgOf(e, 'Could not read that list'), 'error'); }
    setParsing(false);
  };
  const list = srcs?.content || [];
  return (
    <div className="board">
      <div className="full flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fog-400">{list.length} source{list.length === 1 ? '' : 's'} installed</p>
        <div className="flex gap-1.5">
          {/* The same sweep that runs daily on its own, so what you see here is what happens unattended. */}
          <button onClick={checkAll} disabled={checking} className="chip shrink-0 text-xs disabled:opacity-50">
            {checking ? 'Checking…' : '🔍 Check all now'}
          </button>
          <button onClick={reload} disabled={reloading} className="chip shrink-0 text-xs disabled:opacity-50">{reloading ? 'Reloading…' : '↻ Reload sources'}</button>
        </div>
      </div>
      {sweep && (
        <div className="full rounded-xl border border-ink-700 bg-ink-850/60 p-3">
          <p className="text-xs text-fog-300">
            Checked {sweep.sources.length} source{sweep.sources.length === 1 ? '' : 's'}.
            {sweep.needsAttention.length
              ? ` ${sweep.needsAttention.length} need${sweep.needsAttention.length === 1 ? 's' : ''} attention.`
              : ' Nothing needs attention.'}
            {sweep.extensionsUpdated.length ? ` Updated ${sweep.extensionsUpdated.length} extension(s).` : ''}
            {sweep.extensionsFailed?.length
              ? ` ${sweep.extensionsFailed.length} extension(s) could not be updated.`
              : ''}
          </p>
          {(sweep.extensionsFailed || []).map((f: any) => (
            <p key={f.pkgName} className="mt-1 text-[11px] text-amber-300">
              <span className="text-amber-200">{f.name}</span>: {f.reason}
            </p>
          ))}
          {sweep.sources.filter((v: any) => v.action).map((v: any) => (
            <p key={v.id} className="mt-1 text-[11px] text-emerald-300">✓ {v.name}: followed its move to a new address</p>
          ))}
          {sweep.needsAttention.map((v: any) => (
            <p key={v.id} className="mt-1 text-[11px] text-fog-400"><span className="text-fog-200">{v.name}</span>: {v.fix || v.reason}</p>
          ))}
        </div>
      )}

      {/* Add a site (Madara / Manganato engines — most manga aggregators) */}
      <div className="card grad-border wide p-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Add a site')}</p>
        <div className="flex flex-wrap gap-2">
          <select value={eng} onChange={(e) => setEng(e.target.value as any)} className="field w-auto">
            <option value="auto">{tr('Auto-detect')}</option>
            <option value="madara">{tr('Madara (WordPress)')}</option>
            <option value="mangathemesia">{tr('MangaThemesia')}</option>
            <option value="manganato">{tr('Manganato')}</option>
          </select>
          <input value={sname} onChange={(e) => setSname(e.target.value)} placeholder={tr('Name')} className="field min-w-[110px] flex-1" />
          <input value={sbase} onChange={(e) => setSbase(e.target.value)} placeholder="https://site.com" autoCapitalize="none" className="field min-w-[170px] flex-[2]" />
          <button onClick={addSite} disabled={adding || !sname.trim() || !sbase.trim()} className="btn-accent px-4 text-sm disabled:opacity-50">{adding ? 'Adding…' : 'Add'}</button>
        </div>
        <p className="mt-1.5 text-[11px] text-fog-500">Just paste a site&apos;s homepage URL — the engine is auto-detected (or pick it). Picked up instantly, no restart. Works for sites on the Madara, MangaThemesia, or Manganato engines.</p>
        {smoke && (
          <div className={`mt-2.5 rounded-xl border p-2.5 ${smoke.res.ok ? 'border-emerald-600/30 bg-emerald-600/10' : 'border-amber-600/30 bg-amber-600/10'}`}>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-fog-400">
              {smoke.res.ok ? `✓ ${smoke.name} verified — search, chapters & pages all work`
                : smoke.res.timedOut ? `${smoke.name}: verification timed out — slow or heavily protected site (added anyway)`
                : `${smoke.name}: some checks failed — this site may be only partly supported`}
            </p>
            <ul className="space-y-1">
              {smoke.res.checks.map((c, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <span className={c.ok ? 'text-emerald-400' : 'text-red-400'}>{c.ok ? '✓' : '✗'}</span>
                  <span className="text-fog-200">{c.name}</span>
                  <span className="text-fog-500">— {c.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Extension sources, from an optional Suwayomi server running Mihon/Tachiyomi extensions */}
      <Extensions span="full" />

      {/* Import a list of titles */}
      <div className="card grad-border wide p-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Import a list')}</p>
        <p className="mb-2 text-[11px] text-fog-500">Bring your library over from another app. Uchiyomi searches your sources for each title and adds the best match.</p>

        {/* file / MangaDex intake — parsed into a reviewable list before anything is added */}
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <input ref={backupRef} type="file" accept=".tachibk,.proto.gz,.gz" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) parseBackup(f); e.currentTarget.value = ''; }} />
          <button onClick={() => backupRef.current?.click()} disabled={parsing} className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-50">
            {parsing ? 'Reading…' : 'Mihon / Tachiyomi backup'}
          </button>
          <span className="text-[11px] text-fog-600">or</span>
          <input value={mdUrl} onChange={(e) => setMdUrl(e.target.value)} placeholder={tr('public MangaDex list link')} autoCapitalize="none" className="field min-w-0 flex-1" />
          <button onClick={() => parseMangadex()} disabled={parsing || !mdUrl.trim()} className="chip text-xs disabled:opacity-50">{tr('Load')}</button>
        </div>
        <p className="mb-2 text-[10px] text-fog-600">A .tachibk backup stays on your server — only the titles are read. MangaDex lists must be public; private follows need a MangaDex login, which Uchiyomi doesn&apos;t ask for.</p>

        <textarea value={imp} onChange={(e) => setImp(e.target.value)} rows={4} placeholder={'…or paste titles, one per line'} className="field resize-y" />
        {parsed && (
          <div className="mt-2 rounded-xl border border-ink-700 bg-ink-900/50 p-2.5 text-xs">
            <p className="text-fog-300">{tr('Found')}<strong className="text-fog-100">{parsed.total}</strong> titles
              {parsed.already > 0 && <> · <span className="text-fog-500">{parsed.already} already in your library (skipped)</span></>}
              {parsed.truncated && <> · <span className="text-amber-400">capped at 500</span></>}
            </p>
            <p className="mt-1 text-[11px] text-fog-500">{tr('Loaded into the box above — edit or delete lines before importing.')}</p>
          </div>
        )}
        <button onClick={runImport} disabled={importing || job?.running || !imp.trim()} className="btn-accent mt-2 w-full py-2 text-sm disabled:opacity-50">
          {job?.running ? `Importing… ${job.done}/${job.total}` : importing ? 'Starting…' : `Import ${imp.trim() ? imp.trim().split('\n').filter((l) => l.trim()).length + ' ' : ''}titles`}
        </button>
        {job && (
          <div className="mt-2.5 rounded-xl border border-ink-700 bg-ink-900/50 p-2.5 text-xs">
            <p className="mb-1.5 font-semibold text-fog-300">{job.running ? `Working… ${job.done}/${job.total}` : `Done — ${job.added} added · ${job.already} already had · ${job.notFound} not found · ${job.failed} failed`}</p>
            <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-ink-700"><div className="h-full bg-accent transition-all" style={{ width: `${job.total ? (job.done / job.total) * 100 : 0}%` }} /></div>
            <ul className="max-h-40 space-y-0.5 overflow-y-auto">
              {(job.details || []).slice(-40).reverse().map((d, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className={d.status === 'added' ? 'text-emerald-400' : d.status === 'already' ? 'text-fog-500' : d.status === 'not_found' ? 'text-amber-400' : 'text-red-400'}>
                    {d.status === 'added' ? '✓' : d.status === 'already' ? '·' : d.status === 'not_found' ? '?' : '✗'}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-fog-200">{d.title}</span>
                  {d.source && <span className="shrink-0 text-fog-500">{d.source}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {list.length === 0 ? (
        <div className="card grad-border full p-6 text-center">
          <p className="text-sm font-semibold text-fog-100">{tr('No sources installed')}</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-fog-500">Mount a compiled source pack at the server&apos;s <code className="rounded bg-ink-800 px-1 py-0.5">SOURCES_DIR</code>, then hit Reload. With none installed, Uchiyomi reads only the library you already own.</p>
        </div>
      ) : (
        <>
          {list.map((s: any) => {
            const h = hmap.get(s.id) as any;
            const st = s.status as string;
            return (
              <div key={s.id} className="card grad-border p-4">
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-sm text-fog-100">{s.name}{customIds.has(s.id) && <span className="ms-2 rounded bg-ink-700 px-1.5 py-0.5 text-[10px] text-fog-400">custom</span>}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[st] || STATUS_STYLE.ok}`}>{st === 'rate_limited' ? 'rate-limited' : st}</span>
                </div>
                {/* The diagnosis, then the fix, then the raw error last and small. The raw string was all there
                    used to be: "timeout", truncated to one line, written by three different faults. */}
                {(() => {
                  const t = tested.get(s.id);
                  const d = t?.diagnosis;
                  const unwell = st === 'blocked' || st === 'rate_limited' || st === 'down' || st === 'quiet';
                  if (!d && !(h?.last_error && unwell)) return null;
                  return (
                    <div className="mt-1.5 space-y-1">
                      {d && <p className="text-[12px] text-fog-200">{d.reason || 'Working normally.'}</p>}
                      {d?.fix && <p className="text-[11px] leading-relaxed text-fog-400">{d.fix}</p>}
                      {h?.last_error && unwell && (
                        <p className="truncate text-[11px] text-fog-600" title={h.last_error}>{h.consecutive}× · {h.last_error}</p>
                      )}
                    </div>
                  );
                })()}
                {(() => {
                  const t = tested.get(s.id);
                  if (!t) return null;
                  return (
                    <div className={`mt-2 rounded-xl border p-2 ${t.ok ? 'border-emerald-600/30 bg-emerald-600/10' : 'border-amber-600/30 bg-amber-600/10'}`}>
                      {t.checks.map((c: any, i: number) => (
                        <p key={i} className="text-[11px] text-fog-300">{c.ok ? '✓' : '✗'} {c.name}: <span className="text-fog-500">{c.detail}</span></p>
                      ))}
                      {t.timedOut && <p className="text-[11px] text-amber-300">Gave up waiting. The site is slow or heavily protected.</p>}
                    </div>
                  );
                })()}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button onClick={() => testSource(s.id)} disabled={testingId === s.id} className="chip text-xs disabled:opacity-50">
                    {testingId === s.id ? 'Testing…' : tr('Test')}
                  </button>
                  {(st === 'blocked' || st === 'rate_limited' || st === 'down') && <button onClick={() => act(s.id, 'unblock', 'Cleared')} className="chip text-xs">{tr('Clear block')}</button>}
                  <button onClick={() => act(s.id, st === 'disabled' ? 'enable' : 'disable', st === 'disabled' ? 'Enabled' : 'Disabled')} className="chip text-xs">{st === 'disabled' ? 'Enable' : 'Disable'}</button>
                  {customIds.has(s.id) && tested.get(s.id)?.diagnosis?.code === 'moved' && (
                    <button onClick={() => moveSite(s.id)} className="chip text-xs text-accent">{tr('Update address')}</button>
                  )}
                  {customIds.has(s.id) && <button onClick={() => removeSite(s.id)} className="ms-auto text-xs text-red-300 hover:underline">{tr('Remove')}</button>}
                </div>
              </div>
            );
          })}
        </>
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
      toast(`Hunting art for ${r.total} series…`, 'success');
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
      <div className="full grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 min-[1700px]:grid-cols-8">
        {rows.map((r) => (
          <button key={r.id} onClick={() => setOpen(r)} className="card overflow-hidden p-0 text-start transition hover:border-accent/40">
            <div className="relative h-16 w-full overflow-hidden bg-ink-900">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/img/series/${encodeURIComponent(r.id)}/backdrop?rv=${bust[r.id] || 0}`} alt="" className="h-full w-full object-cover" loading="lazy" />
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
      toast(`${kind === 'banner' ? 'Banner' : 'Cover'} updated`, 'success');
      onApplied();
    } catch { toast('Failed to apply', 'error'); }
    setBusy(false);
  };
  const reset = async (kind: 'cover' | 'banner') => {
    if (busy) return;
    setBusy(true);
    try { await api(`/api/admin/series/${row.id}/art`, { method: 'PUT', json: { kind, mode: 'reset' } }); toast('Reset to automatic', 'success'); onApplied(); }
    catch { toast('Failed', 'error'); }
    setBusy(false);
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="glass max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-ink-700 p-5" onClick={(e) => e.stopPropagation()}>
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

/**
 * Tasks report different result shapes (updater: chapters added; backup: size on disk).
 *
 * `healthy: false` is the case this panel could not previously express. A sweep in which every source was
 * down and one in which nothing was new both rendered '+0 chapters', so a library that had quietly stopped
 * updating looked exactly like a quiet week.
 */
function taskResult(r: any): string {
  if (!r) return '';
  if (typeof r.added === 'number') {
    const base = ` · +${r.added} chapters`;
    if (r.healthy === false) {
      const bits: string[] = [];
      if (r.failed) bits.push(`${r.failed} series did not answer`);
      if (r.chapterFailures) bits.push(`${r.chapterFailures} chapters could not be saved`);
      return `${base} · ${bits.join(', ') || 'some sources failed'}`;
    }
    return base;
  }
  if (typeof r.bytes === 'number') {
    // Both of these used to be invisible: the archive could be missing every config file, or its size could
    // have failed to measure, and the panel showed a contented size either way.
    const warn = [r.configEmpty && 'config not captured', r.sizeUnknown && 'size not measured'].filter(Boolean);
    return ` · ${r.sizeUnknown ? 'size unknown' : bytes(r.bytes)}${warn.length ? ` · ${warn.join(', ')}` : ''}`;
  }
  return '';
}

function Tasks() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['admin-tasks'], queryFn: () => api<{ content: any[] }>('/api/admin/tasks'), refetchInterval: 5000 });
  const run = async (id: string) => { try { await api(`/api/admin/tasks/${id}/run`, { method: 'POST' }); toast('Started', 'success'); qc.invalidateQueries({ queryKey: ['admin-tasks'] }); } catch { toast('Failed', 'error'); } };
  // Chronological, per-row actions: a list, not a card grid. But an explicit column template rather than
  // `justify-between`, which at 1592px left a lake of nothing between a task's name and its own button.
  return (
    <div className="board">
      <div className="card grad-border full divide-y divide-ink-800/70 overflow-hidden">
        {(data?.content || []).map((t: any) => (
          <div key={t.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-3.5 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_auto]">
            <p className="col-start-1 row-start-1 min-w-0 truncate text-sm text-fog-100">{t.name}</p>
            {/* Phone stacks the schedule under the name; from lg it takes a track of its own. */}
            <p className="col-start-1 row-start-2 min-w-0 truncate text-[11px] text-fog-500 lg:col-start-2 lg:row-start-1">{t.schedule} · {t.lastRun ? `last run ${relativeTime(new Date(t.lastRun).toISOString())}` : 'not run yet'}{taskResult(t.lastResult)}</p>
            <button onClick={() => run(t.id)} disabled={t.running}
              className="chip col-start-2 row-span-2 row-start-1 shrink-0 justify-self-end text-xs disabled:opacity-50 lg:col-start-3 lg:row-span-1">{t.running ? 'Running…' : 'Run now'}</button>
          </div>
        ))}
      </div>
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
              {s.device_name || 'Device'}
              <span className="lg:hidden"> · {s.ip || 'unknown'} · active {relativeTime(s.last_seen)}</span>
            </p>
            <p className="hidden min-w-0 truncate font-mono text-[11px] text-fog-500 lg:col-start-3 lg:row-start-1 lg:block">{s.ip || 'unknown'}</p>
            <div className="col-start-2 row-span-2 row-start-1 flex shrink-0 items-center gap-2 justify-self-end lg:col-start-4 lg:row-span-1">
              <span className="hidden text-[11px] text-fog-500 lg:inline">active {relativeTime(s.last_seen)}</span>
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

function Settings() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['admin-settings'], queryFn: () => api<any>('/api/admin/settings') });
  const [name, setName] = useState<string | null>(null);
  const [hours, setHours] = useState<number | null>(null);
  const save = async (body: any, ok: string) => { try { await api('/api/admin/settings', { method: 'PATCH', json: body }); toast(ok, 'success'); qc.invalidateQueries({ queryKey: ['admin-settings'] }); } catch { toast('Failed', 'error'); } };
  if (!data) return <div className="board"><div className="card grad-border p-6 text-center text-sm text-fog-500">{tr('Loading…')}</div></div>;
  // Three settings look like three settings. Padding a sparse panel out with a chart is the exact failure
  // this rework exists to undo, so this one is deliberately left with room around it.
  return (
    <div className="board">
      <div className="card grad-border p-4">
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Server name')}</label>
        <input value={name ?? data.server_name} onChange={(e) => setName(e.target.value)} className="field" />
        <button onClick={() => save({ serverName: name ?? data.server_name }, 'Saved')} className="btn-accent mt-2 w-full py-2 text-sm">{tr('Save name')}</button>
      </div>
      <div className="card grad-border flex items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="text-sm text-fog-100">{tr('Open registration')}</p>
          <p className="max-w-prose text-[11px] text-fog-500">{tr('Let anyone create their own account')}</p>
        </div>
        <Switch on={!!data.allow_registration} label={tr('Open registration')}
          onChange={(next) => save({ allowRegistration: next }, next ? 'Registration open' : 'Registration closed')} />
      </div>
      <div className="card grad-border p-4">
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Auto-update interval (hours)')}</label>
        <input type="number" min={1} max={168} value={hours ?? data.updater_hours} onChange={(e) => setHours(Number(e.target.value))} className="field" />
        <button onClick={() => save({ updaterHours: hours ?? data.updater_hours }, 'Saved')} className="btn-accent mt-2 w-full py-2 text-sm">{tr('Save interval')}</button>
      </div>
    </div>
  );
}

interface HealthItem { seriesId?: string; seriesIds?: string[]; titles?: string[]; title: string; detail: string }
interface HealthCheck { id: string; title: string; status: 'ok' | 'warn' | 'problem'; summary: string; note?: string; items: HealthItem[] }

const HEALTH_TONE: Record<HealthCheck['status'], string> = {
  problem: 'border-red-500/40 bg-red-500/10 text-red-300',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  ok: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
};
const HEALTH_LABEL: Record<HealthCheck['status'], string> = { problem: 'Needs attention', warn: 'Worth a look', ok: 'All good' };

/** Read-only audit of the library: gaps, truncated downloads, duplicates, and failing sources. */
interface DeletedRow { id: string; title: string; folder: string; books_count: number; deleted_at: string }

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
      <div className="max-h-44 overflow-y-auto p-1.5">
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
        {tr('A library is a folder, plus any series you file into it by hand. Give it an age rating and everything in it inherits that, and choose who can open it.')}
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
                {l.pinned > 0 && <> · {tr('{n} filed by hand', { n: l.pinned })}</>}
                {' · '}{!anyMembers ? tr('admins only') : l.members.length ? tr('{n} can open it', { n: l.members.length }) : tr('nobody can open it')}
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
              <button onClick={() => setAccess(l)} className="chip text-xs">{tr('Access')}</button>
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
      toast(`Deleted ${res.files} file(s), ${(res.bytes / 1048576).toFixed(1)} MB`, 'success');
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
              <p><strong className="text-fog-100">This deletes {purge.books_count} chapter file(s) from your
                disk.</strong>{tr('It cannot be undone from here.')}</p>
              <p className="mt-2">Everyone&rsquo;s reading progress and history are kept, so the record of
                having read it survives even though the files do not.</p>
              <p className="mt-2 text-fog-500">Folder: {purge.folder}</p>
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
      <div className="full space-y-3">
        <p className="max-w-prose text-xs text-fog-500">
          Removing a series hides it from the library, search and the updater. Its files are left exactly where
          they are, and everyone&rsquo;s reading progress is kept, so putting it back changes nothing else.
        </p>
        {isLoading ? (
          <div className="card grad-border p-4 text-sm text-fog-500">{tr('Loading…')}</div>
        ) : !rows.length ? (
          <div className="card grad-border p-6 text-center text-sm text-fog-500">{tr('Nothing has been removed.')}</div>
        ) : (
          <div className="card grad-border divide-y divide-ink-800/70 overflow-hidden">
            {rows.map((r) => (
              <div key={r.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-4 py-3 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)_auto]">
                <p className="col-start-1 row-start-1 min-w-0 truncate text-sm text-fog-100">{r.title}</p>
                <p className="col-start-1 row-start-2 min-w-0 truncate text-[11px] text-fog-500 lg:col-start-2 lg:row-start-1">
                  {r.books_count} chapter{r.books_count === 1 ? '' : 's'} · removed {relativeTime(r.deleted_at)} · {r.folder}
                </p>
                <div className="col-start-2 row-span-2 row-start-1 flex shrink-0 gap-1.5 justify-self-end lg:col-start-3 lg:row-span-1">
                  <button onClick={() => restore(r)} disabled={busy === r.id} className="chip shrink-0 text-xs disabled:opacity-50">
                    {busy === r.id ? 'Restoring\u2026' : 'Put back'}
                  </button>
                  {/* The escalation, and only ever after the reversible step. Hiding is undoable; this is not. */}
                  <button onClick={() => setPurge(r)} className="chip shrink-0 text-xs hover:border-rose-500/50 hover:text-rose-400">{tr('Delete files')}</button>
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
  const [merge, setMerge] = useState<HealthItem | null>(null);
  const [keepFirst, setKeepFirst] = useState(true);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const { data, isFetching, refetch } = useQuery({
    queryKey: ['admin-health'],
    queryFn: () => api<{ generatedAt: string; checks: HealthCheck[] }>('/api/admin/health'),
  });
  const checks = data?.checks || [];
  const bad = checks.filter((c) => c.status !== 'ok').length;

  // One card per check, and a failing one earns the full width of the board -- the same severity rule the
  // overview uses, so the shape of the panel is the verdict.
  return (
    <div className="board">
      <div className="full flex items-center justify-between gap-3">
        <p className="text-xs text-fog-500">
          {!data ? 'Checking your library…'
            : bad ? `${bad} of ${checks.length} checks found something`
            : 'Everything looks healthy'}
          {data && <> · checked {relativeTime(data.generatedAt)}</>}
        </p>
        <button onClick={() => refetch()} disabled={isFetching} className="chip shrink-0 text-xs disabled:opacity-50">
          {isFetching ? 'Checking…' : 'Re-check'}
        </button>
      </div>

      {merge && merge.seriesIds && (
        <ConfirmDialog
          title={tr('Merge these two?')}
          confirmLabel="Merge"
          busy={busy}
          body={
            <>
              <p>Every chapter, and everyone&rsquo;s reading progress, favourites and ratings, move onto the copy you keep. <strong className="text-fog-100">{tr('Nothing is deleted')}</strong> &mdash; no chapter is dropped even if both copies have it, and no files are touched.</p>
              <div className="mt-3 space-y-2">
                {(merge.titles || []).map((t, i) => (
                  <label key={i} className="flex cursor-pointer items-center gap-2 rounded-lg border border-ink-700 px-3 py-2 text-sm">
                    <input type="radio" checked={keepFirst === (i === 0)} onChange={() => setKeepFirst(i === 0)} />
                    <span className="truncate">{tr('Keep')}<strong className="text-fog-100">{t}</strong></span>
                  </label>
                ))}
              </div>
            </>
          }
          onConfirm={async () => {
            const [a, b] = merge.seriesIds!;
            const keep = keepFirst ? a : b;
            const gone = keepFirst ? b : a;
            setBusy(true);
            try {
              const r = await api<{ moved: number }>(`/api/admin/series/${gone}/merge`, { method: 'POST', json: { into: keep } });
              toast(`Merged \u2014 ${r.moved} chapter${r.moved === 1 ? '' : 's'} moved`, 'success');
              setMerge(null);
              refetch();
            } catch (e) { toast(msgOf(e, 'Could not merge'), 'error'); }
            setBusy(false);
          }}
          onClose={() => setMerge(null)}
        />
      )}
      {checks.map((c) => {
        const isOpen = open === c.id;
        return (
          <div key={c.id} className={`card grad-border overflow-hidden ${c.status !== 'ok' ? 'full' : ''}`}>
            <button
              onClick={() => setOpen(isOpen ? null : c.id)}
              disabled={!c.items.length}
              className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3.5 text-start disabled:cursor-default"
            >
              <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${HEALTH_TONE[c.status]}`}>
                {HEALTH_LABEL[c.status]}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-fog-100">{c.title}</p>
                <p className="text-[11px] text-fog-500">{c.summary}</p>
              </div>
              {!!c.items.length && (
                <span className="shrink-0 text-xs text-fog-500">{isOpen ? 'Hide' : 'Show'}</span>
              )}
            </button>

            {isOpen && (
              <div className="border-t border-ink-800/70">
                {c.note && <p className="px-4 pt-3 text-[11px] leading-relaxed text-fog-500">{c.note}</p>}
                <div className="divide-y divide-ink-800/70">
                  {c.items.map((it, i) => (
                    <div key={`${c.id}-${i}`} className="flex items-center gap-3 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-fog-100">{it.title}</p>
                        <p className="text-[11px] text-fog-500">{it.detail}</p>
                      </div>
                      {c.id === 'duplicates' && it.seriesIds && it.seriesIds.length === 2 && (
                        <button onClick={() => setMerge(it)} className="chip shrink-0 text-xs hover:border-accent/50 hover:text-accent">{tr('Merge')}</button>
                      )}
                      {it.seriesId && (
                        <a href={`/series/${it.seriesId}`} className="chip shrink-0 text-xs">{tr('Open')}</a>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface ExtStatus { configured: boolean; reachable: boolean; version?: string | null; error?: string; enabled?: number; known?: number }
interface CatalogExt { pkgName: string; name: string; lang: string | null; versionName: string | null; iconUrl: string | null; installed: boolean; hasUpdate: boolean; obsolete: boolean; nsfw: boolean }
interface Catalog { content: CatalogExt[]; total: number; matched: number; shown: number; installed: number; updatable: number; hiddenAdult: number; langs: string[] }

/**
 * Browse and install Mihon / Tachiyomi extensions.
 *
 * Installing one switches its sources on in the same action — having to find them again in a second list is
 * exactly the friction this replaced. Uchiyomi never hosts extensions: the catalogue comes from repositories
 * the operator adds here, and the extension server does the fetching.
 */
function Extensions({ span = '' }: { span?: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [q2, setQ2] = useState('');
  const [lang, setLang] = useState('');
  const [onlyInstalled, setOnlyInstalled] = useState(false);
  const [showAdult, setShowAdult] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState('');
  const [addingRepo, setAddingRepo] = useState(false);
  const [showRepos, setShowRepos] = useState(false);

  const { data: status } = useQuery({ queryKey: ['ext-status'], queryFn: () => api<ExtStatus>('/api/admin/extensions/status') });
  const { data: repos } = useQuery({
    queryKey: ['ext-repos'],
    queryFn: () => api<{ content: string[] }>('/api/admin/extensions/repos'),
    enabled: !!status?.configured && !!status?.reachable,
  });
  const { data: cat, isFetching } = useQuery({
    queryKey: ['ext-catalog', q2, lang, onlyInstalled, showAdult],
    queryFn: () => api<Catalog>(`/api/admin/extensions/catalog?q=${encodeURIComponent(q2)}&lang=${encodeURIComponent(lang)}${onlyInstalled ? '&installed=true' : ''}${showAdult ? '&nsfw=true' : ''}`),
    enabled: !!status?.configured && !!status?.reachable,
  });

  if (!status) return null;

  if (!status.configured) {
    return (
      <div className={`card grad-border p-4 ${span}`}>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Extensions')}</p>
        <p className="text-[11px] leading-relaxed text-fog-500">
          The extension engine isn&apos;t running. It normally starts with the rest of Uchiyomi — if you turned it
          off, bring it back with <code className="text-fog-300">docker compose up -d yomi-suwayomi</code>.
        </p>
      </div>
    );
  }

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['ext-catalog'] });
    qc.invalidateQueries({ queryKey: ['ext-status'] });
    qc.invalidateQueries({ queryKey: ['ext-repos'] });
    qc.invalidateQueries({ queryKey: ['sources'] });
  };

  const act = async (e: CatalogExt, action: 'install' | 'uninstall' | 'update') => {
    setBusy(e.pkgName);
    try {
      const r = await api<{ sources: number }>(`/api/admin/extensions/catalog/${encodeURIComponent(e.pkgName)}`, { json: { action } });
      refreshAll();
      toast(action === 'uninstall' ? `Removed ${e.name}`
        : action === 'update' ? `Updated ${e.name}`
        : `Added ${e.name}${r.sources ? ` — ${r.sources} source${r.sources === 1 ? '' : 's'} ready to search` : ''}`, 'success');
    } catch (err: any) { toast(msgOf(err, `Could not ${action} ${e.name}`), 'error'); }
    setBusy(null);
  };

  /**
   * Update everything at once. The per-row button stays: this is for the common case of coming back after a
   * week and finding several at once, which is otherwise several trips through a 1,400-row list.
   */
  const updateAll = async () => {
    setBusy('__updateall');
    try {
      const r = await api<{ updated: string[]; failed: { name: string; reason: string }[] }>(
        '/api/admin/extensions/update-all', { json: {} },
      );
      refreshAll();
      if (r.failed.length) {
        // Naming the first one and why beats a count: the reason is usually the repository's, not ours.
        toast(`Updated ${r.updated.length}. Could not update ${r.failed[0].name}: ${r.failed[0].reason}`, 'error');
      } else {
        toast(r.updated.length
          ? `Updated ${r.updated.length} extension${r.updated.length === 1 ? '' : 's'}`
          : 'Everything is already up to date', 'success');
      }
    } catch (err: any) { toast(msgOf(err, 'Could not update extensions'), 'error'); }
    setBusy(null);
  };

  const refreshRepos = async () => {
    setBusy('__refresh');
    try {
      const r = await api<{ count: number }>('/api/admin/extensions/refresh', { json: {} });
      refreshAll();
      toast(`Refreshed — ${r.count} extension${r.count === 1 ? '' : 's'} available`, 'success');
    } catch { toast('Could not refresh the list', 'error'); }
    setBusy(null);
  };

  const addRepo = async () => {
    if (!repoUrl.trim()) return;
    setAddingRepo(true);
    try {
      const r = await api<{ url: string; corrected: boolean; total: number }>('/api/admin/extensions/repos', { json: { url: repoUrl.trim() } });
      setRepoUrl('');
      refreshAll();
      toast(r.total ? `Added — ${r.total} extension${r.total === 1 ? '' : 's'} available${r.corrected ? ' (used the full index)' : ''}`
                    : 'Added, but that repository returned no extensions', r.total ? 'success' : 'error');
    } catch (e: any) { toast(msgOf(e, 'Could not add that repository'), 'error'); }
    setAddingRepo(false);
  };

  const removeRepo = async (url: string) => {
    try {
      await api('/api/admin/extensions/repos', { method: 'DELETE', json: { url } });
      refreshAll();
      toast('Repository removed', 'success');
    } catch { toast('Could not remove it', 'error'); }
  };

  const list = cat?.content || [];

  return (
    <div className={`card grad-border p-4 ${span}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Extensions')}</p>
        <div className="flex items-center gap-2">
          <span className={`rounded-full border px-2 py-0.5 text-[10px] ${status.reachable ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-red-500/40 bg-red-500/10 text-red-300'}`}>
            {status.reachable ? `ready${status.version ? ` · ${status.version}` : ''}` : 'engine unreachable'}
          </span>
          {status.reachable && (
            <button onClick={refreshRepos} disabled={busy === '__refresh'} className="chip text-[11px] disabled:opacity-50">
              {busy === '__refresh' ? 'Refreshing…' : '↻ Refresh'}
            </button>
          )}
        </div>
      </div>

      {!status.reachable ? (
        <p className="text-[11px] text-fog-500">
          Can&apos;t reach the extension engine{status.error ? ` (${status.error})` : ''}. Uchiyomi keeps working; extensions
          are just unavailable until it&apos;s back.
        </p>
      ) : (
        <>
          <p className="mb-2 text-[11px] leading-relaxed text-fog-500">
            The same extensions Mihon and Tachiyomi use. Adding one switches its sources on straight away, so it&apos;s
            searchable from Discover immediately.
          </p>

          {/* repositories — where the catalogue comes from */}
          <div className="mb-2 rounded-lg border border-ink-700/60 bg-ink-850/40 p-2">
            <button onClick={() => setShowRepos(!showRepos)} className="flex w-full items-center justify-between text-start">
              <span className="text-[11px] text-fog-300">
                {repos?.content.length
                  ? `${repos.content.length} extension ${repos.content.length === 1 ? 'repository' : 'repositories'} · ${cat?.total ?? 0} extensions available`
                  : 'No extension repository yet — add one to see extensions'}
              </span>
              <span className="text-[11px] text-fog-500">{showRepos ? 'Hide' : 'Manage'}</span>
            </button>
            {showRepos && (
              <div className="mt-2 space-y-1.5">
                {(repos?.content || []).map((u) => (
                  <div key={u} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-fog-400">{u}</span>
                    <button onClick={() => removeRepo(u)} className="shrink-0 text-[11px] text-red-300 hover:underline">{tr('Remove')}</button>
                  </div>
                ))}
                <div className="flex gap-2 pt-1">
                  <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://…/index.json"
                    autoCapitalize="none" autoCorrect="off"
                    className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-xs text-fog-100 outline-none focus:border-accent" />
                  <button onClick={addRepo} disabled={addingRepo || !repoUrl.trim()} className="btn-accent shrink-0 px-3 py-1.5 text-xs disabled:opacity-50">
                    {addingRepo ? 'Checking…' : 'Add'}
                  </button>
                </div>
                <p className="text-[10px] leading-relaxed text-fog-600">
                  Uchiyomi doesn&apos;t host extensions, so you point it at a repository you trust — the same URL you&apos;d
                  use in Mihon. If it hands back an empty list, Uchiyomi retries the full <code>index.json</code>, which is
                  where most repositories now keep the real catalogue.
                </p>
              </div>
            )}
          </div>

          {/* Out of date is a thing to be told, not a thing to go looking for. The per-row Update button was
              only ever visible to someone already scrolling the installed list. */}
          {!!cat?.updatable && (
            <div className="mb-2 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
              <p className="min-w-0 flex-1 text-[11px] leading-snug text-amber-200">
                {cat.updatable === 1 ? '1 extension is out of date' : `${cat.updatable} extensions are out of date`}
                <span className="text-amber-200/60"> · a newer version is available from its repository</span>
              </p>
              <button onClick={updateAll} disabled={!!busy}
                className="shrink-0 rounded-full bg-amber-500/25 px-3 py-1 text-[11px] font-medium text-amber-100 transition hover:bg-amber-500/40 disabled:opacity-50">
                {busy === '__updateall' ? 'Updating…' : 'Update all'}
              </button>
            </div>
          )}

          {/* search + filters */}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <input value={q2} onChange={(e) => setQ2(e.target.value)} placeholder={tr('Search extensions…')}
              className="min-w-[150px] flex-1 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-xs text-fog-100 outline-none focus:border-accent" />
            <select value={lang} onChange={(e) => setLang(e.target.value)}
              className="rounded-lg border border-ink-700 bg-ink-850 px-2 py-1.5 text-xs text-fog-100 outline-none focus:border-accent">
              <option value="">{tr('All languages')}</option>
              {(cat?.langs || []).map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <button onClick={() => setShowAdult(!showAdult)}
              className={`rounded-full px-2.5 py-1 text-[11px] transition ${showAdult ? 'bg-accent text-white' : 'bg-ink-700 text-fog-300 hover:text-fog-100'}`}>
              18+
            </button>
            <button onClick={() => setOnlyInstalled(!onlyInstalled)}
              className={`rounded-full px-2.5 py-1 text-[11px] transition ${onlyInstalled ? 'bg-accent text-white' : 'bg-ink-700 text-fog-300 hover:text-fog-100'}`}>
              Added{status.enabled ? ` (${cat?.installed ?? 0})` : ''}
            </button>
          </div>

          {cat && cat.matched > cat.shown && (
            <p className="mb-1 text-[10px] text-fog-600">Showing {cat.shown} of {cat.matched} matches — narrow the search to see the rest.</p>
          )}

          <div className="max-h-96 space-y-1 overflow-y-auto">
            {list.map((e) => (
              <div key={e.pkgName} className="flex items-center gap-2 rounded-lg border border-ink-700/60 bg-ink-850/40 px-2.5 py-1.5">
                {e.iconUrl
                  ? <img src={e.iconUrl} alt="" width={22} height={22} className="h-[22px] w-[22px] shrink-0 rounded" loading="lazy" />
                  : <span className="h-[22px] w-[22px] shrink-0 rounded bg-ink-700" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-fog-100">
                    {e.name}
                    {e.nsfw && <span className="ms-1.5 rounded bg-red-500/15 px-1 py-0.5 text-[9px] text-red-300">18+</span>}
                    {e.obsolete && <span className="ms-1.5 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] text-amber-300">obsolete</span>}
                  </p>
                  <p className="text-[10px] text-fog-600">{e.lang || 'all'}{e.versionName ? ` · v${e.versionName}` : ''}</p>
                </div>
                {e.hasUpdate && (
                  <button onClick={() => act(e, 'update')} disabled={busy === e.pkgName}
                    className="shrink-0 rounded-full bg-amber-500/20 px-2.5 py-1 text-[11px] text-amber-200 disabled:opacity-50">
                    {busy === e.pkgName ? '…' : 'Update'}
                  </button>
                )}
                <button onClick={() => act(e, e.installed ? 'uninstall' : 'install')} disabled={busy === e.pkgName}
                  className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] transition disabled:opacity-50 ${e.installed ? 'bg-ink-700 text-fog-300 hover:text-fog-100' : 'bg-accent text-white'}`}>
                  {busy === e.pkgName ? '…' : e.installed ? 'Remove' : 'Add'}
                </button>
              </div>
            ))}
            {!list.length && !isFetching && (
              <p className="py-2 text-[11px] text-fog-600">
                {cat?.total ? 'Nothing matches that search.' : 'No extensions yet — add a repository above to see what’s available.'}
              </p>
            )}
            {isFetching && !list.length && <p className="py-2 text-[11px] text-fog-600">{tr('Loading…')}</p>}
          </div>
        </>
      )}
    </div>
  );
}
