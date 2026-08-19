'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, img } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { triggerRefresh } from '@/lib/refresh';
import { bytes, relativeTime } from '@/lib/format';
import { useToast } from '@/components/Toast';
import { Avatar } from '@/components/Avatar';
import { IcChevronLeft, IcTrash, IcPlus, IcRefresh } from '@/components/icons';

const TABS = ['Overview', 'Members', 'Providers', 'Art', 'Tasks', 'Activity', 'Sessions', 'Settings'] as const;
type Tab = (typeof TABS)[number];
const msgOf = (e: any, fb: string) => { try { return JSON.parse(e?.body || '{}').message || fb; } catch { return fb; } };
const fld = 'w-full rounded-xl border border-ink-700 bg-ink-900 px-3 py-2.5 text-sm text-fog-50 outline-none focus:border-accent';
const STATUS_STYLE: Record<string, string> = {
  ok: 'bg-emerald-600/20 text-emerald-300', blocked: 'bg-red-600/20 text-red-300',
  rate_limited: 'bg-amber-600/20 text-amber-300', down: 'bg-orange-600/20 text-orange-300', disabled: 'bg-ink-700 text-fog-400',
};

export default function AdminPage() {
  const { isAdmin } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('Overview');
  if (!isAdmin) return <div className="flex min-h-screen-d items-center justify-center text-fog-400">Admins only.</div>;
  return (
    <div className="min-h-screen-d">
      <header className="safe-top flex items-center gap-2 px-4 pb-2 lg:px-0">
        <button onClick={() => router.back()} className="grid h-10 w-10 place-items-center rounded-full bg-ink-800/70 text-fog-100"><IcChevronLeft width={22} height={22} /></button>
        <h1 className="font-display text-2xl font-bold">Admin</h1>
      </header>
      <div className="px-4 lg:mx-auto lg:max-w-3xl lg:px-0">
        <div className="-mx-4 mb-4 flex gap-1.5 overflow-x-auto px-4 pb-1 lg:mx-0 lg:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TABS.map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition ${tab === t ? 'bg-accent text-white' : 'bg-ink-800 text-fog-300 hover:text-fog-100'}`}>{t}</button>
          ))}
        </div>
        {tab === 'Overview' && <Overview />}
        {tab === 'Members' && <Members />}
        {tab === 'Providers' && <Providers />}
        {tab === 'Art' && <ArtReview />}
        {tab === 'Tasks' && <Tasks />}
        {tab === 'Activity' && <Activity />}
        {tab === 'Sessions' && <Sessions />}
        {tab === 'Settings' && <Settings />}
      </div>
    </div>
  );
}

function Overview() {
  const toast = useToast();
  const { data: stats, refetch } = useQuery({ queryKey: ['admin-stats'], queryFn: () => api<any>('/api/admin/stats') });
  const rescan = async () => { toast('Scanning library…'); await triggerRefresh(); setTimeout(refetch, 2500); };
  return (
    <div>
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Series', value: stats ? String(stats.seriesTotal) : '—' },
          { label: 'Members', value: stats ? String(stats.members) : '—' },
          { label: 'Image cache', value: stats ? bytes(stats.cacheBytes) : '—' },
          { label: 'Last scan', value: stats?.lastScan ? relativeTime(new Date(stats.lastScan).toISOString()) : '—' },
        ].map((s) => <div key={s.label} className="card p-4 text-center"><p className="font-display text-xl font-bold text-fog-50">{s.value}</p><p className="text-[11px] text-fog-500">{s.label}</p></div>)}
      </div>
      <button onClick={rescan} className="btn-ghost mb-6 w-full text-sm"><IcRefresh width={16} height={16} /> Scan library now</button>
      {stats?.activity?.length > 0 && (
        <div>
          <h2 className="mb-2 font-display text-base font-semibold">Member activity</h2>
          <div className="card divide-y divide-ink-800/70 overflow-hidden">
            {stats.activity.map((a: any) => (
              <div key={a.id} className="flex items-center gap-3 px-4 py-3">
                <Avatar avatar={a.avatar} size={32} />
                <div className="min-w-0 flex-1"><p className="truncate text-sm text-fog-100">{a.display_name}</p><p className="text-[11px] text-fog-500">{a.last_active ? `active ${relativeTime(a.last_active)}` : 'no activity yet'}</p></div>
                <span className="text-xs text-fog-400">{a.total} ch · <span className="text-accent">{a.week} wk</span></span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

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
  const reset = async (u: any) => { const p = prompt(`New password for @${u.username} (min 8)`); if (p) patch(u, { password: p }, 'Password reset · sessions revoked'); };
  const del = async (u: any) => { if (!confirm(`Delete @${u.username}?`)) return; try { await api(`/api/admin/users/${u.id}`, { method: 'DELETE' }); toast('Deleted', 'success'); inval(); } catch { toast('Could not delete (last admin?)', 'error'); } };

  return (
    <div>
      <form onSubmit={create} className="card mb-5 p-4">
        <h2 className="mb-3 font-display text-base font-semibold">New account</h2>
        <div className="space-y-2">
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" autoCapitalize="none" autoCorrect="off" className={fld} />
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="display name (optional)" className={fld} />
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="password (min 8)" className={fld} />
          <div className="flex gap-2">{(['user', 'admin'] as const).map((r) => <button key={r} type="button" onClick={() => setRole(r)} className={`flex-1 rounded-xl border py-2 text-sm capitalize ${role === r ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>{r}</button>)}</div>
        </div>
        <button type="submit" disabled={busy || !username.trim() || password.length < 8} className="btn-accent mt-3 w-full disabled:opacity-50"><IcPlus width={18} height={18} /> {busy ? 'Creating…' : 'Create account'}</button>
      </form>
      <div className="card divide-y divide-ink-800/70 overflow-hidden">
        {(data?.content ?? []).map((u: any) => {
          const self = u.id === user?.id;
          const canDl = u.perms?.canDownload !== false;
          return (
            <div key={u.id} className="px-4 py-3">
              <div className="flex items-center gap-3">
                <Avatar avatar={u.avatar} size={36} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-fog-100">{u.display_name} <span className="text-fog-500">@{u.username}</span></p>
                  <p className="text-[11px] text-fog-500">{u.role === 'admin' ? 'Admin' : 'Member'}{self ? ' · you' : ''}{u.disabled ? ' · disabled' : ''}{u.totp_enabled ? ' · 2FA' : ''}</p>
                </div>
                <button onClick={() => reset(u)} className="chip text-xs">Reset</button>
                {!self && <button onClick={() => del(u)} className="grid h-9 w-9 place-items-center rounded-full border border-ink-700 text-red-300"><IcTrash width={16} height={16} /></button>}
              </div>
              {!self && (
                <div className="mt-2 flex flex-wrap gap-1.5 pl-12">
                  <button onClick={() => patch(u, { role: u.role === 'admin' ? 'user' : 'admin' }, 'Role updated')} className="chip text-xs">{u.role === 'admin' ? 'Make member' : 'Make admin'}</button>
                  <button onClick={() => patch(u, { disabled: !u.disabled }, u.disabled ? 'Enabled' : 'Disabled')} className="chip text-xs">{u.disabled ? 'Enable' : 'Disable'}</button>
                  <button onClick={() => patch(u, { perms: { ...u.perms, canDownload: !canDl } }, 'Permission updated')} className="chip text-xs">{canDl ? 'Deny downloads' : 'Allow downloads'}</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
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
  const list = srcs?.content || [];
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-fog-400">{list.length} source{list.length === 1 ? '' : 's'} installed</p>
        <button onClick={reload} disabled={reloading} className="chip text-xs disabled:opacity-50">{reloading ? 'Reloading…' : '↻ Reload sources'}</button>
      </div>

      {/* Add a site (Madara / Manganato engines — most manga aggregators) */}
      <div className="card mb-3 p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-fog-500">Add a site</p>
        <div className="flex flex-wrap gap-2">
          <select value={eng} onChange={(e) => setEng(e.target.value as any)} className={`${fld} w-auto`}>
            <option value="auto">Auto-detect</option>
            <option value="madara">Madara (WordPress)</option>
            <option value="mangathemesia">MangaThemesia</option>
            <option value="manganato">Manganato</option>
          </select>
          <input value={sname} onChange={(e) => setSname(e.target.value)} placeholder="Name" className={`${fld} min-w-[110px] flex-1`} />
          <input value={sbase} onChange={(e) => setSbase(e.target.value)} placeholder="https://site.com" autoCapitalize="none" className={`${fld} min-w-[170px] flex-[2]`} />
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

      {/* Import a list of titles */}
      <div className="card mb-3 p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-fog-500">Import a list</p>
        <p className="mb-2 text-[11px] text-fog-500">Paste titles (one per line) — e.g. from a Tachiyomi/Mihon backup or your MangaDex follows. Koryomi searches your sources for each and adds the best match.</p>
        <textarea value={imp} onChange={(e) => setImp(e.target.value)} rows={4} placeholder={'Solo Leveling\nThe Beginning After The End\n…'} className={`${fld} resize-y`} />
        <button onClick={runImport} disabled={importing || job?.running || !imp.trim()} className="btn-accent mt-2 w-full py-2 text-sm disabled:opacity-50">
          {job?.running ? `Importing… ${job.done}/${job.total}` : importing ? 'Starting…' : 'Import titles'}
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
        <div className="card p-6 text-center">
          <p className="text-sm font-semibold text-fog-100">No sources installed</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-fog-500">Mount a compiled source pack at the server&apos;s <code className="rounded bg-ink-800 px-1 py-0.5">SOURCES_DIR</code>, then hit Reload. With none installed, Koryomi reads only the library you already own.</p>
        </div>
      ) : (
        <div className="card divide-y divide-ink-800/70 overflow-hidden">
          {list.map((s: any) => {
            const h = hmap.get(s.id) as any;
            const st = s.status as string;
            return (
              <div key={s.id} className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-sm text-fog-100">{s.name}{customIds.has(s.id) && <span className="ml-2 rounded bg-ink-700 px-1.5 py-0.5 text-[10px] text-fog-400">custom</span>}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[st] || STATUS_STYLE.ok}`}>{st === 'rate_limited' ? 'rate-limited' : st}</span>
                </div>
                {h?.last_error && (st === 'blocked' || st === 'rate_limited' || st === 'down') && <p className="mt-1 truncate text-[11px] text-fog-500">{h.consecutive}× · {h.last_error}</p>}
                <div className="mt-2 flex gap-1.5">
                  {(st === 'blocked' || st === 'rate_limited' || st === 'down') && <button onClick={() => act(s.id, 'unblock', 'Cleared')} className="chip text-xs">Clear block</button>}
                  <button onClick={() => act(s.id, st === 'disabled' ? 'enable' : 'disable', st === 'disabled' ? 'Enabled' : 'Disabled')} className="chip text-xs">{st === 'disabled' ? 'Enable' : 'Disable'}</button>
                  {customIds.has(s.id) && <button onClick={() => removeSite(s.id)} className="ml-auto text-xs text-red-300 hover:underline">Remove</button>}
                </div>
              </div>
            );
          })}
        </div>
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
    <div className="space-y-4">
      <div className="card p-4">
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
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {([['nobanner', 'Missing banner'], ['nocover', 'Missing cover'], ['fixed', 'Overridden'], ['all', 'All']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setFilter(k)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${filter === k ? 'bg-accent text-white' : 'bg-ink-800 text-fog-300'}`}>
            {label}{k !== 'all' ? ` (${(data?.content ?? []).filter((r) => (k === 'nobanner' ? !r.has_banner && !r.override_banner : k === 'nocover' ? !r.has_cover && !r.override_cover : r.override_banner || r.override_cover)).length})` : ''}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {rows.map((r) => (
          <button key={r.id} onClick={() => setOpen(r)} className="card overflow-hidden p-0 text-left transition hover:border-accent/40">
            <div className="relative h-16 w-full overflow-hidden bg-ink-900">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/img/series/${encodeURIComponent(r.id)}/backdrop?rv=${bust[r.id] || 0}`} alt="" className="h-full w-full object-cover" loading="lazy" />
              {!r.has_banner && !r.override_banner && <span className="absolute right-1 top-1 rounded bg-red-600/80 px-1.5 py-0.5 text-[9px] font-bold text-white">NO BANNER</span>}
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
            {row.override_cover && <button onClick={() => reset('cover')} disabled={busy} className="chip text-xs">Reset cover to auto</button>}
            {row.override_banner && <button onClick={() => reset('banner')} disabled={busy} className="chip text-xs">Reset banner to auto</button>}
          </div>
        )}
        {isLoading ? (
          <p className="py-8 text-center text-sm text-fog-500">Searching AniList + MangaDex…</p>
        ) : !(data?.content?.length) ? (
          <p className="py-8 text-center text-sm text-fog-500">No candidates found — use Edit details on the series page to paste a URL.</p>
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
                    {c.banner && <button onClick={() => apply('banner', c.banner!)} disabled={busy} className="btn-accent flex-1 px-2 py-1 text-[11px] disabled:opacity-50">Use as banner</button>}
                    {c.cover && <button onClick={() => apply('cover', c.cover!)} disabled={busy} className="btn-ghost flex-1 px-2 py-1 text-[11px] disabled:opacity-50">Use as cover</button>}
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

/** Tasks report different result shapes (updater: chapters added; backup: size on disk). */
function taskResult(r: any): string {
  if (!r) return '';
  if (typeof r.added === 'number') return ` · +${r.added} chapters`;
  if (typeof r.bytes === 'number') return ` · ${bytes(r.bytes)}`;
  return '';
}

function Tasks() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['admin-tasks'], queryFn: () => api<{ content: any[] }>('/api/admin/tasks'), refetchInterval: 5000 });
  const run = async (id: string) => { try { await api(`/api/admin/tasks/${id}/run`, { method: 'POST' }); toast('Started', 'success'); qc.invalidateQueries({ queryKey: ['admin-tasks'] }); } catch { toast('Failed', 'error'); } };
  return (
    <div className="card divide-y divide-ink-800/70 overflow-hidden">
      {(data?.content || []).map((t: any) => (
        <div key={t.id} className="flex items-center gap-3 px-4 py-3.5">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-fog-100">{t.name}</p>
            <p className="text-[11px] text-fog-500">{t.schedule} · {t.lastRun ? `last run ${relativeTime(new Date(t.lastRun).toISOString())}` : 'not run yet'}{taskResult(t.lastResult)}</p>
          </div>
          <button onClick={() => run(t.id)} disabled={t.running} className="chip text-xs disabled:opacity-50">{t.running ? 'Running…' : 'Run now'}</button>
        </div>
      ))}
    </div>
  );
}

function Activity() {
  const { data } = useQuery({ queryKey: ['admin-audit'], queryFn: () => api<{ content: any[] }>('/api/admin/audit?limit=150'), refetchInterval: 8000 });
  const label = (e: string) => e.replace(/\./g, ' ').replace(/_/g, ' ');
  return (
    <div className="card divide-y divide-ink-800/70 overflow-hidden">
      {(data?.content || []).map((a: any) => (
        <div key={a.id} className="flex items-start gap-3 px-4 py-2.5">
          <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${/fail|block|disable|delete/.test(a.event) ? 'bg-red-400' : /login|ok|register/.test(a.event) ? 'bg-emerald-400' : 'bg-accent'}`} />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-fog-100"><span className="font-medium capitalize">{label(a.event)}</span>{a.username ? <span className="text-fog-400"> · {a.username}</span> : ''}</p>
            <p className="truncate text-[11px] text-fog-500">{relativeTime(a.at)}{a.ip ? ` · ${a.ip}` : ''}{a.detail && Object.keys(a.detail).length ? ` · ${JSON.stringify(a.detail).slice(0, 60)}` : ''}</p>
          </div>
        </div>
      ))}
      {!data?.content?.length && <p className="px-4 py-8 text-center text-sm text-fog-500">No activity yet.</p>}
    </div>
  );
}

function Sessions() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['admin-sessions'], queryFn: () => api<{ content: any[] }>('/api/admin/sessions') });
  const revoke = async (id: string) => { await api(`/api/admin/sessions/${id}`, { method: 'DELETE' }); toast('Revoked', 'success'); qc.invalidateQueries({ queryKey: ['admin-sessions'] }); };
  return (
    <div className="card divide-y divide-ink-800/70 overflow-hidden">
      {(data?.content || []).map((s: any) => (
        <div key={s.id} className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-fog-100">{s.display_name || s.username} <span className="text-fog-500">· {s.device_name || 'Device'}</span></p>
            <p className="truncate text-[11px] text-fog-500">{s.ip || 'unknown'} · active {relativeTime(s.last_seen)}</p>
          </div>
          <button onClick={() => revoke(s.id)} className="text-xs text-red-300 hover:underline">Revoke</button>
        </div>
      ))}
      {!data?.content?.length && <p className="px-4 py-8 text-center text-sm text-fog-500">No active sessions.</p>}
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
  if (!data) return <div className="card p-6 text-center text-sm text-fog-500">Loading…</div>;
  return (
    <div className="space-y-4">
      <div className="card p-4">
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-fog-500">Server name</label>
        <input value={name ?? data.server_name} onChange={(e) => setName(e.target.value)} className={fld} />
        <button onClick={() => save({ serverName: name ?? data.server_name }, 'Saved')} className="btn-accent mt-2 w-full py-2 text-sm">Save name</button>
      </div>
      <div className="card flex items-center justify-between p-4">
        <div><p className="text-sm text-fog-100">Open registration</p><p className="text-[11px] text-fog-500">Let anyone create their own account</p></div>
        <button onClick={() => save({ allowRegistration: !data.allow_registration }, data.allow_registration ? 'Registration closed' : 'Registration open')} className={`relative h-6 w-11 rounded-full transition ${data.allow_registration ? 'bg-accent' : 'bg-ink-700'}`}>
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${data.allow_registration ? 'left-[1.375rem]' : 'left-0.5'}`} />
        </button>
      </div>
      <div className="card p-4">
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-fog-500">Auto-update interval (hours)</label>
        <input type="number" min={1} max={168} value={hours ?? data.updater_hours} onChange={(e) => setHours(Number(e.target.value))} className={fld} />
        <button onClick={() => save({ updaterHours: hours ?? data.updater_hours }, 'Saved')} className="btn-accent mt-2 w-full py-2 text-sm">Save interval</button>
      </div>
      <div className="card p-4">
        <h3 className="mb-1 font-display text-base font-semibold">Support Koryomi</h3>
        <p className="mb-3 text-sm text-fog-400">Koryomi is free &amp; open-source. If you find it useful, you can help fund development.</p>
        <a href="https://ko-fi.com/angeloshaheen" target="_blank" rel="noopener noreferrer" className="btn-accent flex w-full items-center justify-center gap-2 py-2 text-sm">☕ Buy me a coffee</a>
      </div>
    </div>
  );
}
