'use client';
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { useSearchParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { Book, Page, Series, SeriesSource, StoredPrefs } from '@/lib/types';
import { chapterLabel, isVolumeName, relativeTime } from '@/lib/format';
import { listDownloads, downloadChapter, deleteDownload } from '@/lib/downloads';
import { applyCover, clearCover } from '@/lib/theme';
import { Img, Backdrop, Rail, SectionTitle } from '@/components/ui';
import { SeriesCard } from '@/components/cards';
import { useToast } from '@/components/Toast';
import { ConfirmDialog, Modal, msgOf } from '@/components/ConfirmDialog';
import { useAuth, canDownload } from '@/lib/auth';
import { IcChevronLeft, IcHeart, IcStar, IcPlay, IcDownload, IcCheck, IcTrash, IcSliders, IcMoments } from '@/components/icons';
import { t as tr } from '@/lib/i18n';
import { FindMissingDialog } from '@/components/FindMissingDialog';
import { hasGroup, normGroup, reorder, withoutGroup } from '@/lib/scanlators';

// The four the scanner itself writes from ComicInfo's PublishingStatus. Kept as a suggestion list rather
// than a hard enum, because a file can carry anything and rejecting it would reject Uchiyomi's own data.
const STATUSES = ['ONGOING', 'COMPLETED', 'HIATUS', 'CANCELLED'];
const fld = 'w-full rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 text-sm text-fog-100 outline-hidden transition focus:border-accent/60';

function ArtEditor({ label, kind, busy, onUpload, onSetUrl, onReset }: { label: string; kind: 'cover' | 'banner'; busy: boolean; onUpload: (k: 'cover' | 'banner', f: File) => void; onSetUrl: (k: 'cover' | 'banner', url: string) => void; onReset: (k: 'cover' | 'banner') => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');
  return (
    <div className="mt-4 border-t border-ink-800 pt-3">
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-fog-500">{label}</p>
      <div className="flex flex-wrap items-center gap-2">
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(kind, f); e.currentTarget.value = ''; }} />
        <button onClick={() => fileRef.current?.click()} disabled={busy} className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-50">{tr('Upload image')}</button>
        <button onClick={() => onReset(kind)} disabled={busy} className="chip text-xs disabled:opacity-50">{tr('Reset to auto')}</button>
      </div>
      <div className="mt-2 flex gap-2">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={tr('…or paste an image URL')} autoCapitalize="none" className={`${fld} flex-1`} />
        <button onClick={() => { onSetUrl(kind, url); setUrl(''); }} disabled={busy || !url.trim()} className="btn-accent px-3 text-xs disabled:opacity-50">Set</button>
      </div>
    </div>
  );
}

interface ScanlatorGroup { name: string; onDisk: number; listed: number }
interface ScanlatorInfo {
  prefs: StoredPrefs | null;
  global: StoredPrefs;
  effective: { priority: string[]; blocked: string[]; patienceDays: number };
  groups: ScanlatorGroup[];
}
interface PrefsDraft { priority: string[]; blocked: string[]; patience: string }

/**
 * Which groups' releases the updater takes for this series, and how long it waits for a preferred one.
 *
 * Collapsed by default and fetched only when opened: the group list is built by asking the source for the
 * full chapter listing, which is a network call the edit dialog should not make for every "fix the title".
 *
 * The draft is seeded from the STORED override, not from the effective rules. The effective priority is
 * the server default when this series has none of its own, and seeding from it would turn "follows the
 * defaults" into a per-series copy of them on the first Save -- a copy that then stops following when the
 * defaults change. Blank patience means the same thing for the same reason.
 */
function ScanlatorPrefs({ id, onSaved }: { id: string; onSaved: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ['series-scanlators', id],
    queryFn: () => api<ScanlatorInfo>(`/api/admin/series/${id}/scanlators`),
    enabled: open,
  });
  // `null` until the row arrives, so a half-loaded form can never save an empty ruleset over a real one.
  const [draft, setDraft] = useState<PrefsDraft | null>(null);
  useEffect(() => {
    if (data && !draft) {
      setDraft({ priority: data.prefs?.priority ?? [], blocked: data.prefs?.blocked ?? [],
                 patience: data.prefs?.patienceDays == null ? '' : String(data.prefs.patienceDays) });
    }
  }, [data, draft]);

  // One row per group, by the server's equality: ranked groups first in rank order, then blocked ones, then
  // everything the source lists or the disk holds, busiest first. A group that is in the stored lists but
  // no longer appears anywhere still gets a row, or there would be no way to un-block it.
  const rows = useMemo(() => {
    if (!data || !draft) return [] as ScanlatorGroup[];
    const counts = new Map(data.groups.map((g) => [normGroup(g.name), g]));
    const seen = new Set<string>();
    const out: ScanlatorGroup[] = [];
    const push = (name: string) => {
      const k = normGroup(name);
      if (!k || seen.has(k)) return;
      seen.add(k);
      const g = counts.get(k);
      out.push({ name: g?.name ?? name, onDisk: g?.onDisk ?? 0, listed: g?.listed ?? 0 });
    };
    draft.priority.forEach(push);
    draft.blocked.forEach(push);
    [...data.groups].sort((a, b) => b.listed - a.listed || b.onDisk - a.onDisk).forEach((g) => push(g.name));
    return out;
  }, [data, draft]);

  const rankIn = (priority: string[], name: string) => { const k = normGroup(name); return priority.findIndex((p) => normGroup(p) === k); };
  // Preferring a group unblocks it and blocking one un-ranks it: a group in both lists would be blocked
  // (the server takes the union) while showing a rank that can never be used.
  const togglePrefer = (name: string) => setDraft((d) => d && (rankIn(d.priority, name) >= 0
    ? { ...d, priority: withoutGroup(d.priority, name) }
    : { ...d, priority: [...d.priority, name], blocked: withoutGroup(d.blocked, name) }));
  const toggleBlock = (name: string) => setDraft((d) => d && (hasGroup(d.blocked, name)
    ? { ...d, blocked: withoutGroup(d.blocked, name) }
    : { ...d, blocked: [...d.blocked, name], priority: withoutGroup(d.priority, name) }));
  const move = (name: string, dir: -1 | 1) => setDraft((d) => d && { ...d, priority: reorder(d.priority, rankIn(d.priority, name), dir) });

  const patch = async (scanlatorPrefs: StoredPrefs | null) => {
    setBusy(true);
    try {
      await api(`/api/admin/series/${id}`, { method: 'PATCH', json: { scanlatorPrefs } });
      toast(tr('Saved'), 'success');
      qc.invalidateQueries({ queryKey: ['series-scanlators', id] });
      onSaved();
      return true;
    } catch (e) { toast(msgOf(e, tr('Could not save')), 'error'); return false; }
    finally { setBusy(false); }
  };
  const save = () => {
    if (!draft) return;
    const raw = draft.patience.trim();
    const patienceDays = raw === '' ? null : Number(raw);
    if (patienceDays != null && (!Number.isInteger(patienceDays) || patienceDays < 0 || patienceDays > 30)) {
      toast(tr('Patience is a whole number of days, 0 to 30'), 'error');
      return;
    }
    return patch({ priority: draft.priority, blocked: draft.blocked, patienceDays });
  };
  const useDefaults = async () => { if (await patch(null)) setDraft({ priority: [], blocked: [], patience: '' }); };

  const serverDefault = data?.global.patienceDays ?? 2;
  return (
    <div className="mt-3 border-t border-ink-800 pt-3">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between text-start">
        <span className="text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Scanlators')}</span>
        <span className="text-xs text-fog-500">{open ? '▴' : '▾'}</span>
      </button>
      {open && isLoading && <div className="skeleton mt-2 h-16 rounded-lg" />}
      {open && !!error && <p className="mt-2 text-xs text-rose-300">{msgOf(error, tr('Could not load the groups'))}</p>}
      {open && data && draft && (
        <>
          <p className="mt-1 text-[11px] leading-relaxed text-fog-500">
            {tr('Preferred groups are taken first, in this order; blocked groups are never taken. New chapters wait for a preferred group for the patience below, then the best available copy is fetched.')}
          </p>
          {!rows.length && <p className="mt-2 text-xs text-fog-500">{tr('No groups known for this series yet.')}</p>}
          <div className="mt-2 space-y-1">
            {rows.map((g) => {
              const rank = rankIn(draft.priority, g.name);
              const blocked = hasGroup(draft.blocked, g.name);
              const serverBlocked = hasGroup(data.global.blocked, g.name);
              return (
                <div key={normGroup(g.name)} className="flex items-center gap-1.5 text-xs">
                  {/* Counts under the name, not beside it: on a phone the buttons leave the name a few characters. */}
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate ${blocked || serverBlocked ? 'text-fog-600 line-through' : 'text-fog-200'}`} title={g.name}>{g.name}</span>
                    <span className="block text-[10px] text-fog-600">{tr('{d} on disk · {l} listed', { d: g.onDisk, l: g.listed })}</span>
                  </span>
                  {rank >= 0 && (
                    <span className="flex shrink-0 items-center">
                      <button onClick={() => move(g.name, -1)} disabled={rank === 0} aria-label={tr('Move up')} className="px-1 text-fog-400 disabled:opacity-30">▲</button>
                      <button onClick={() => move(g.name, 1)} disabled={rank === draft.priority.length - 1} aria-label={tr('Move down')} className="px-1 text-fog-400 disabled:opacity-30">▼</button>
                    </span>
                  )}
                  <button onClick={() => togglePrefer(g.name)} disabled={serverBlocked && rank < 0}
                    className={`chip shrink-0 px-2 py-0.5 text-[10px] disabled:opacity-40 ${rank >= 0 ? 'chip-active' : ''}`}>
                    {rank >= 0 ? `#${rank + 1}` : tr('Prefer')}
                  </button>
                  {serverBlocked
                    ? <span className="shrink-0 text-[10px] text-fog-600">{tr('blocked on server')}</span>
                    : <button onClick={() => toggleBlock(g.name)}
                        className={`chip shrink-0 px-2 py-0.5 text-[10px] ${blocked ? 'border-rose-500/40 text-rose-300' : ''}`}>
                        {blocked ? tr('Blocked') : tr('Block')}
                      </button>}
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="text-xs text-fog-400" htmlFor={`patience-${id}`}>{tr('Patience (days)')}</label>
            <input id={`patience-${id}`} type="number" min={0} max={30} step={1} inputMode="numeric" value={draft.patience}
              onChange={(e) => setDraft((d) => d && { ...d, patience: e.target.value })}
              placeholder={String(serverDefault)} className={`${fld} w-20`} />
            <span className="text-[11px] text-fog-500">{tr('Currently {n} days', { n: data.effective.patienceDays })}</span>
          </div>
          <p className="mt-1 text-[11px] text-fog-600">{tr('Blank uses the server default ({n}). 0 takes the best copy available at once.', { n: serverDefault })}</p>
          <div className="mt-3 flex gap-2">
            <button onClick={save} disabled={busy} className="btn-accent flex-1 py-2 text-xs disabled:opacity-50">{tr('Save')}</button>
            <button onClick={useDefaults} disabled={busy || !data.prefs} className="chip text-xs disabled:opacity-50">{tr('Use server defaults')}</button>
          </div>
        </>
      )}
    </div>
  );
}

function SeriesEditModal({ id, series, onClose, onSaved }: { id: string; series: Series; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(series.metadata?.title || series.name || '');
  const [summary, setSummary] = useState(series.metadata?.summary || series.booksMetadata?.summary || '');
  // Seed from the OVERRIDE where one exists, falling back to the scanned value. Seeding from the scan alone
  // would show the scanned author while an override was active, and saving would then overwrite the override
  // with the very value it was created to replace.
  const [author, setAuthor] = useState(series.overrides?.author ?? series.metadata?.author ?? '');
  const [status, setStatus] = useState(series.overrides?.status ?? series.metadata?.status ?? '');
  // A minimum age, or '' meaning "whatever the files said". Age caps on member accounts compare against
  // this, and an unrated series stays visible to everyone -- so setting one is opting a title IN to being
  // filtered, never opting the rest of the library out.
  const [ageRating, setAgeRating] = useState<string>(
    series.overrides?.ageRating != null ? String(series.overrides.ageRating)
      : series.metadata?.ageRating != null ? String(series.metadata.ageRating) : '',
  );
  const [genres, setGenres] = useState<string[]>(series.overrides?.genres ?? series.metadata?.genres ?? []);
  const [genreDraft, setGenreDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const addGenre = (raw: string) => {
    const t = raw.trim().replace(/,$/, '').trim();
    if (!t || genres.some((g) => g.toLowerCase() === t.toLowerCase())) { setGenreDraft(''); return; }
    setGenres([...genres, t]);
    setGenreDraft('');
  };
  const dataUrlOf = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error('read')); r.readAsDataURL(f); });
  const putArt = async (kind: 'cover' | 'banner', body: Record<string, unknown>) => { await api(`/api/admin/series/${id}/art`, { method: 'PUT', json: { kind, ...body } }); onSaved(); };
  const onUpload = async (kind: 'cover' | 'banner', f: File) => {
    if (f.size > 11 * 1024 * 1024) { toast('Image too large (max ~11 MB)', 'error'); return; }
    setBusy(true);
    try { await putArt(kind, { mode: 'upload', dataUrl: await dataUrlOf(f) }); toast(`${kind === 'cover' ? 'Cover' : 'Background'} updated`, 'success'); }
    catch { toast('Upload failed', 'error'); }
    setBusy(false);
  };
  const onSetUrl = async (kind: 'cover' | 'banner', url: string) => { if (!url.trim()) return; setBusy(true); try { await putArt(kind, { mode: 'url', url: url.trim() }); toast('Updated', 'success'); } catch { toast('Failed — check the URL', 'error'); } setBusy(false); };
  const onReset = async (kind: 'cover' | 'banner') => { setBusy(true); try { await putArt(kind, { mode: 'reset' }); toast('Reset to automatic', 'success'); } catch { toast('Failed', 'error'); } setBusy(false); };
  // Every field goes on every save. The route writes all five columns, so omitting one would silently
  // clear its override rather than leave it alone.
  const saveText = async () => {
    setBusy(true);
    try {
      await api(`/api/admin/series/${id}/meta`, { method: 'PUT', json: { title, summary, author, status, genres, ageRating: ageRating === '' ? null : Number(ageRating) } });
      toast('Saved', 'success');
      onSaved();
    } catch (e) { toast(msgOf(e, 'Could not save'), 'error'); }
    setBusy(false);
  };

  // Which library this series is filed under. `''` means the folder rule decides, which is the default and
  // what almost every series should stay on -- picking one explicitly is a decision that then survives
  // rescans, new libraries, and re-pathing an existing one, which is the whole point and also the reason not
  // to do it by accident.
  const [lib, setLib] = useState<string>(series.libraryPinned ? series.libraryId : '');
  const { data: libs } = useQuery({
    queryKey: ['admin-libraries'],
    queryFn: () => api<{ content: { id: string; name: string; age_rating: number | null }[] }>('/api/admin/libraries'),
  });
  const saveLib = async (next: string) => {
    const prev = lib;
    setLib(next);
    try { await api(`/api/admin/series/${id}/library`, { method: 'POST', json: { libraryId: next || null } }); onSaved(); }
    catch (e) { setLib(prev); toast(msgOf(e, tr('Could not move that')), 'error'); }
  };

  const [autoUpdate, setAutoUpdate] = useState(series.autoUpdate !== false);
  const toggleAuto = async (next: boolean) => {
    setAutoUpdate(next);
    try { await api(`/api/admin/series/${id}`, { method: 'PATCH', json: { autoUpdate: next } }); }
    catch (e) { setAutoUpdate(!next); toast(msgOf(e, 'Could not change that'), 'error'); }
  };

  // Extra sources are added from Find missing chapters, where a person has seen the source's title and its
  // overlap with what is on disk. Here they can only be removed; the primary is not removable at all, since
  // it is the row the series was created from.
  const [unfollowing, setUnfollowing] = useState<string | null>(null);
  const unfollow = async (s: SeriesSource) => {
    setUnfollowing(s.sourceId);
    try {
      await api(`/api/admin/series/${id}/sources/${encodeURIComponent(s.sourceId)}`, { method: 'DELETE' });
      toast(tr('No longer following {s}', { s: s.name }), 'success');
      onSaved();
    } catch (e) { toast(msgOf(e, tr('Could not remove that')), 'error'); }
    setUnfollowing(null);
  };

  const [checking, setChecking] = useState(false);
  const checkNow = async () => {
    setChecking(true);
    try {
      await api(`/api/admin/series/${id}/check`, { method: 'POST' });
      toast('Checking for new chapters\u2026', 'info');
      // the download runs on the server; poll rather than hold the request open
      const started = Date.now();
      const tick = async () => {
        const st = await api<{ running: boolean; added?: number; waiting?: number; error?: string }>(`/api/admin/series/${id}/check`).catch(() => null);
        if (st && !st.running) {
          setChecking(false);
          if (st.error) toast('Check failed', 'error');
          else {
            // A number held for a preferred group is not "up to date": say it is being waited for.
            const held = st.waiting ? ` · ${st.waiting} held for a preferred group` : '';
            toast(st.added ? `Added ${st.added} new chapter${st.added === 1 ? '' : 's'}${held}` : st.waiting ? `Nothing new yet${held}` : 'Already up to date', 'success');
            onSaved();
          }
          return;
        }
        if (Date.now() - started > 10 * 60_000) { setChecking(false); return; }
        setTimeout(tick, 3000);
      };
      setTimeout(tick, 2000);
    } catch (e) { setChecking(false); toast(msgOf(e, 'Could not start a check'), 'error'); }
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/70 p-4 backdrop-blur-xs" onClick={onClose}>
      <div className="glass max-h-[88vh] w-full max-w-md overflow-y-auto rounded-2xl border border-ink-700 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-semibold leading-tight">{tr('Edit series')}</h3>
          <button onClick={onClose} className="shrink-0 text-fog-500 hover:text-fog-200">✕</button>
        </div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Library')}</label>
        <select value={lib} onChange={(e) => saveLib(e.target.value)} className={fld}>
          <option value="">{tr('Automatic — follow the folder')}</option>
          {(libs?.content ?? []).map((l) => (
            <option key={l.id} value={l.id}>{l.name}{l.age_rating != null ? ` (${l.age_rating}+)` : ''}</option>
          ))}
        </select>
        <p className="mb-3 mt-1 text-[11px] text-fog-600">
          {lib ? tr('Filed here by hand. Rescans and new libraries will leave it alone.')
               : tr('Whichever library covers this folder, most specific first.')}
        </p>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Title')}</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={fld} />
        <label className="mb-1 mt-3 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Description')}</label>
        <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={5} className={`${fld} resize-y`} />
        <label className="mb-1 mt-3 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Author')}</label>
        <input value={author} onChange={(e) => setAuthor(e.target.value)} className={fld} placeholder={tr('Leave blank to use what the files say')} />
        <label className="mb-1 mt-3 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Status')}</label>
        <select value={STATUSES.includes(status.toUpperCase()) ? status.toUpperCase() : (status ? '__other' : '')}
          onChange={(e) => setStatus(e.target.value === '__other' ? status : e.target.value)} className={fld}>
          <option value="">{tr('Use what the files say')}</option>
          {STATUSES.map((v) => <option key={v} value={v}>{v.charAt(0) + v.slice(1).toLowerCase()}</option>)}
          <option value="__other">{tr('Something else…')}</option>
        </select>
        {!!status && !STATUSES.includes(status.toUpperCase()) && (
          <input value={status} onChange={(e) => setStatus(e.target.value)} className={`${fld} mt-2`} placeholder={tr('Status')} />
        )}
        <label className="mb-1 mt-3 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Age rating')}</label>
        <select value={ageRating} onChange={(e) => setAgeRating(e.target.value)} className={fld}>
          <option value="">{tr('Not rated — visible to everyone')}</option>
          {[6, 10, 13, 15, 17, 18].map((v) => <option key={v} value={String(v)}>{v}+</option>)}
        </select>
        <p className="mt-1 text-[11px] text-fog-500">
          Members with an age limit below this will not see the series anywhere: not in the library, search,
          the reader, or an external OPDS app.
        </p>
        <label className="mb-1 mt-3 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Genres')}</label>
        <div className="flex flex-wrap gap-1.5 rounded-lg border border-ink-700 bg-ink-900/60 p-2">
          {genres.map((g) => (
            <span key={g} className="inline-flex items-center gap-1 rounded-full bg-ink-800 px-2.5 py-1 text-xs text-fog-200">
              {g}
              <button type="button" onClick={() => setGenres(genres.filter((x) => x !== g))}
                aria-label={`Remove ${g}`} className="text-fog-500 hover:text-rose-400">×</button>
            </span>
          ))}
          <input
            value={genreDraft}
            onChange={(e) => (e.target.value.endsWith(',') ? addGenre(e.target.value) : setGenreDraft(e.target.value))}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addGenre(genreDraft); }
                                else if (e.key === 'Backspace' && !genreDraft && genres.length) setGenres(genres.slice(0, -1)); }}
            onBlur={() => addGenre(genreDraft)}
            placeholder={genres.length ? 'Add…' : 'Action, Fantasy…'}
            className="min-w-[8rem] flex-1 bg-transparent px-1 py-1 text-sm text-fog-50 outline-hidden"
          />
        </div>
        <p className="mt-1 text-[11px] text-fog-500">Genres drive Browse and the recommendation rails. Clearing them all means this series genuinely has none.</p>
        <button onClick={saveText} disabled={busy} className="btn-accent mt-3 w-full py-2 text-sm disabled:opacity-50">{tr('Save details')}</button>
        <div className="mt-4 rounded-xl border border-ink-700 p-3">
          <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
            <span>
              <span className="text-fog-100">{tr('Follow new chapters')}</span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-fog-500">{tr('The scheduled check fetches new chapters for this series.')}</span>
            </span>
            <input type="checkbox" checked={autoUpdate} onChange={(e) => toggleAuto(e.target.checked)} className="size-4 shrink-0 accent-accent" />
          </label>
          <button onClick={checkNow} disabled={checking} className="mt-2 w-full rounded-full border border-ink-700 py-2 text-sm text-fog-300 disabled:opacity-50">
            {checking ? 'Checking\u2026' : 'Check for new chapters now'}
          </button>
          <div className="mt-3 border-t border-ink-800 pt-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Sources')}</p>
            <div className="mt-1.5 space-y-1">
              {(series.sources ?? []).map((s) => (
                <div key={s.sourceId} className="flex items-center gap-2 text-sm">
                  <span className={`min-w-0 truncate ${s.registered ? 'text-fog-200' : 'text-fog-600'}`}>{s.name}</span>
                  {s.primary && <span className="chip shrink-0 px-2 py-0.5 text-[10px]">{tr('primary')}</span>}
                  {!s.registered && <span className="shrink-0 text-[11px] text-fog-600">{tr('not installed')}</span>}
                  {s.chapters != null && <span className="ms-auto shrink-0 text-[11px] text-fog-500">{s.chapters} {tr('chapters')}</span>}
                  {!s.primary && (
                    <button onClick={() => unfollow(s)} disabled={unfollowing === s.sourceId} aria-label={tr('Stop following {s}', { s: s.name })}
                      className={`shrink-0 text-fog-500 hover:text-rose-400 disabled:opacity-50 ${s.chapters == null ? 'ms-auto' : ''}`}>×</button>
                  )}
                </div>
              ))}
              {!(series.sources ?? []).length && <p className="text-xs text-fog-500">{tr('No source — the chapters were scanned from disk.')}</p>}
            </div>
            <p className="mt-1.5 text-[11px] text-fog-600">{tr('Add one from Find missing chapters')}</p>
          </div>
          <ScanlatorPrefs id={id} onSaved={onSaved} />
        </div>
        <ArtEditor label="Cover" kind="cover" busy={busy} onUpload={onUpload} onSetUrl={onSetUrl} onReset={onReset} />
        <ArtEditor label="Background" kind="banner" busy={busy} onUpload={onUpload} onSetUrl={onSetUrl} onReset={onReset} />
        <p className="mt-4 text-[11px] leading-relaxed text-fog-500">Changes apply for everyone. “Reset to auto” restores the automatic source / AniList / first-page art.</p>
      </div>
    </div>
  );
}

interface CollectionRow { id: string; name: string; accent: string | null; item_count: number }

/** "Add to collection" sheet: pick an existing list or create one inline. */
function CollectionSheet({ seriesId, onClose }: { seriesId: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['collections'], queryFn: () => api<{ content: CollectionRow[] }>('/api/collections') });
  const add = async (c: CollectionRow) => {
    try {
      await api(`/api/collections/${c.id}/items`, { json: { seriesId } });
      toast(`Added to ${c.name}`, 'success');
      qc.invalidateQueries({ queryKey: ['collections'] });
      qc.invalidateQueries({ queryKey: ['collection', c.id] });
      onClose();
    } catch { toast('Failed', 'error'); }
  };
  const createAndAdd = async () => {
    const n = name.trim();
    if (!n) return;
    try {
      const c = await api<CollectionRow>('/api/collections', { json: { name: n } });
      await add(c);
    } catch { toast('Failed to create', 'error'); }
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/70 p-4 backdrop-blur-xs" onClick={onClose}>
      <div className="glass w-full max-w-sm rounded-2xl border border-ink-700 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-semibold">{tr('Add to collection')}</h3>
          <button onClick={onClose} className="shrink-0 text-fog-500 hover:text-fog-200">✕</button>
        </div>
        {isLoading ? (
          <div className="skeleton h-24 rounded-xl" />
        ) : (
          <div className="max-h-64 space-y-1.5 overflow-y-auto">
            {(data?.content ?? []).map((c) => (
              <button key={c.id} onClick={() => add(c)}
                className="flex w-full items-center gap-2.5 rounded-xl border border-ink-700 px-3 py-2.5 text-start transition hover:border-accent/50">
                <span aria-hidden className="h-4 w-1.5 shrink-0 rounded-full" style={{ background: c.accent || 'rgb(var(--accent))' }} />
                <span className="min-w-0 truncate text-sm text-fog-100">{c.name}</span>
                <span className="ms-auto shrink-0 text-[11px] text-fog-500">{c.item_count}</span>
              </button>
            ))}
            {!(data?.content ?? []).length && <p className="py-2 text-center text-xs text-fog-500">{tr('No collections yet — create one below.')}</p>}
          </div>
        )}
        <div className="mt-3 flex gap-2 border-t border-ink-800 pt-3">
          <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && createAndAdd()}
            placeholder={tr('New collection…')} className={`${fld} flex-1`} />
          <button onClick={createAndAdd} disabled={!name.trim()} className="btn-accent px-3 text-xs disabled:opacity-50">{tr('Create')}</button>
        </div>
      </div>
    </div>
  );
}

function StarRating({ value, onSet }: { value: number | null; onSet: (n: number) => void }) {
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} onClick={() => onSet(n)} className={n <= (value || 0) ? 'text-accent' : 'text-ink-600'}>
          <IcStar width={22} height={22} fill={n <= (value || 0) ? 'currentColor' : 'none'} />
        </button>
      ))}
    </div>
  );
}

/**
 * Correct one chapter's number or title.
 *
 * Numbers come from the filename via the first number found in it, so "Vol 2 Ch 5.cbz" reads as chapter 2:
 * it sorts between 1 and 3, and 2 is what gets reported to a connected tracker. This is the escape hatch.
 * The affected-users warning matters because renumbering a chapter someone has finished changes the number
 * their AniList account gets told.
 */
/**
 * Rename the folder a series lives in, on disk.
 *
 * The backend refuses unless EVERY root the series occupies is writable, because a series routinely spans
 * the read library and the downloads folder, and renaming only the writable half leaves the old name live
 * under the other one -- which the next scan re-reads as a second series, with half of everyone's progress
 * stranded on it. The refusal carries both a reason and the exact fix (usually a PUID), so this shows what
 * the server said rather than a generic failure: "could not rename" would hide the one useful sentence.
 */
function RenameFolderModal({ id, folder, title, onClose, onSaved }: {
  id: string; folder: string; title: string; onClose: () => void; onSaved: () => void;
}) {
  const [next, setNext] = useState(folder);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ message?: string; fix?: string } | null>(null);
  const toast = useToast();

  const save = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      await api(`/api/admin/series/${id}/rename-folder`, { method: 'POST', json: { folder: next.trim() } });
      toast('Folder renamed', 'success');
      onSaved();
      onClose();
    } catch (e: any) {
      let shown = false;
      try {
        const b = JSON.parse(e?.body || '{}');
        if (b.message || b.fix) { setRefusal({ message: b.message, fix: b.fix }); shown = true; }
      } catch {}
      if (!shown) toast(msgOf(e, 'Could not rename the folder'), 'error');
    }
    setBusy(false);
  };

  const changed = next.trim() !== folder.trim() && next.trim().length > 0;

  return (
    <Modal title={`Rename the folder for \u201c${title}\u201d`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-fog-500">
          This moves the folder on disk. Chapter ids and everyone&rsquo;s reading progress stay exactly as
          they are, so nothing is marked unread and nothing is re-downloaded.
        </p>
        <label className="block">
          <span className="mb-1 block text-xs text-fog-500">{tr('Folder, relative to your library root')}</span>
          <input
            value={next}
            onChange={(e) => setNext(e.target.value)}
            spellCheck={false}
            className="w-full rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 font-mono text-sm text-fog-100 outline-hidden focus:border-accent/60"
          />
        </label>
        <p className="text-[11px] text-fog-600">{tr('Currently')}<span className="font-mono">{folder}</span></p>

        {refusal && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
            <p>{refusal.message}</p>
            {refusal.fix && <p className="mt-1 text-amber-300/90">{refusal.fix}</p>}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="chip text-xs">{tr('Cancel')}</button>
          <button onClick={save} disabled={busy || !changed} className="btn-accent px-4 py-2 text-sm disabled:opacity-50">
            {busy ? 'Renaming\u2026' : 'Rename folder'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ChapterEditModal({ book, onClose, onSaved }: { book: Book; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [number, setNumber] = useState(String(book.number ?? ''));
  const [title, setTitle] = useState(book.metadata?.title || book.name || '');
  const [busy, setBusy] = useState(false);
  const completed = !!book.readProgress?.completed;

  const save = async (reset = false) => {
    const n = reset ? null : Number(number);
    if (!reset && !Number.isFinite(n)) { toast('Chapter number must be a number', 'error'); return; }
    setBusy(true);
    try {
      const r = await api<{ affectedUsers: number }>(`/api/admin/books/${book.id}/meta`, {
        method: 'PUT',
        json: reset ? { number: null, title: null } : { number: n, title },
      });
      toast(r.affectedUsers > 0 ? `Saved. ${r.affectedUsers} reader(s) had finished this chapter.` : 'Saved', 'success');
      onSaved();
      onClose();
    } catch (e) { toast(msgOf(e, 'Could not save'), 'error'); }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/70 p-4 backdrop-blur-xs" onClick={onClose}>
      <div className="glass w-full max-w-sm rounded-2xl border border-ink-700 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-semibold leading-tight">{tr('Edit chapter')}</h3>
          <button onClick={onClose} className="shrink-0 text-fog-500 hover:text-fog-200">✕</button>
        </div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Chapter number')}</label>
        <input value={number} onChange={(e) => setNumber(e.target.value)} inputMode="decimal" className={fld} />
        <label className="mb-1 mt-3 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Title')}</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={fld} />
        {completed && (
          <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-[11px] leading-relaxed text-amber-200">
            You have finished this chapter. Changing its number changes what gets reported to a connected
            tracker. Progress never moves backwards on its own, so if the new number is lower you will need
            to resync that series deliberately.
          </p>
        )}
        <div className="mt-4 flex gap-2">
          <button onClick={() => save(true)} disabled={busy} className="btn-ghost flex-1 py-2 text-sm disabled:opacity-50">{tr('Reset to file')}</button>
          <button onClick={() => save()} disabled={busy} className="btn-accent flex-1 py-2 text-sm disabled:opacity-50">{tr('Save')}</button>
        </div>
      </div>
    </div>
  );
}

function ChapterRow({ book, downloaded, sourceNames, primarySource, onReader, onToggleDownload, onMark, onEdit }: {
  book: Book;
  downloaded: boolean;
  /** Source id -> display name, from the series' followed sources; names the badge on a chapter another source supplied. */
  sourceNames?: Record<string, string>;
  /** The series' own source. A chapter from it gets no source badge: that is the normal case, not news. */
  primarySource?: string;
  onReader: () => void;
  onToggleDownload: () => Promise<void>;
  onMark: (mode: 'read' | 'unread' | 'previous') => void;
  /** admin only: opens the number/title editor. Absent for everyone else. */
  onEdit?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const rp = book.readProgress;
  const state = rp?.completed ? 'read' : rp ? 'reading' : 'unread';
  // Only a name is shown; an id that resolves to nothing (a source since removed) shows no badge at all.
  const altSource = book.sourceId && book.sourceId !== primarySource ? (sourceNames?.[book.sourceId] ?? null) : null;
  /**
   * The server's read-chapter cleanup deleted the file. The row STAYS -- this is a real chapter of the
   * series, it is read, and the counts and progress all refer to it -- but the two buttons that promise
   * pages must stop promising them. Opening it would lay out zero pages and downloading it would save an
   * empty chapter, and both would look like a bug in the reader rather than a decision the admin made.
   *
   * ⚠️ UNLESS IT IS ALREADY ON THIS DEVICE. The reader consults the offline copy before the server, so a
   * chapter saved before the cleanup took it still opens and still reads perfectly. Greying that out would
   * take away the one copy of it left in the world.
   */
  const pruned = book.pruned === true && !downloaded;

  return (
    <div className="flex items-center gap-3 border-b border-ink-800/70 py-2.5">
      <button onClick={onReader} disabled={pruned} className="flex min-w-0 flex-1 items-center gap-3 text-start disabled:cursor-default">
        <div className={`relative h-14 w-10 shrink-0 overflow-hidden rounded-lg border ${state === 'read' ? 'border-ink-800 opacity-45' : 'border-ink-700'}`}>
          <Img src={img.bookThumb(book.id)} alt="" className="h-full w-full" />
          {state === 'reading' && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-accent" />}
        </div>
        <span className={`h-2 w-2 shrink-0 rounded-full ${state === 'read' ? 'bg-ink-600' : state === 'reading' ? 'bg-accent' : 'bg-accent/40'}`} />
        <div className="min-w-0">
          <p className={`truncate text-sm ${state === 'read' ? 'text-fog-500' : 'text-fog-100'}`}>{chapterLabel(book)}</p>
          {(book.scanlator || altSource || book.pruned) && (
            <p className="mt-0.5 flex flex-wrap gap-1">
              {/* Shown even when a copy is saved on this device -- it is still gone from the server, and
                  "yours is the last one" is exactly what somebody wants to know before clearing downloads. */}
              {book.pruned && <span className="rounded-full border border-ink-700 px-1.5 text-[10px] leading-4 text-fog-600">{downloaded ? tr('Deleted from the server') : tr('Deleted to free space')}</span>}
              {book.scanlator && <span className="max-w-[10rem] truncate rounded-full border border-ink-700 px-1.5 text-[10px] leading-4 text-fog-500">{book.scanlator}</span>}
              {altSource && <span className="max-w-[10rem] truncate rounded-full border border-ink-700 px-1.5 text-[10px] leading-4 text-fog-500">{altSource}</span>}
            </p>
          )}
          {state === 'reading' && rp && (
            <p className="text-[11px] text-accent">page {rp.page}/{book.media.pagesCount}</p>
          )}
        </div>
      </button>
      {book.metadata?.releaseDate && (
        <span className="shrink-0 text-[11px] text-fog-500">{relativeTime(book.metadata.releaseDate)}</span>
      )}
      <button
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          try { await onToggleDownload(); } catch {}
          setBusy(false);
        }}
        // `pruned` already excludes a chapter saved on this device, so removing that copy still works --
        // which matters, because it is the only copy left.
        disabled={pruned}
        className={`grid h-9 w-9 place-items-center rounded-full border disabled:opacity-30 ${downloaded ? 'border-accent/40 text-accent' : 'border-ink-700 text-fog-500'}`}
        aria-label={downloaded ? 'Remove download' : 'Download'}
      >
        {busy ? <span className="text-[10px] font-semibold text-accent">…</span> : downloaded ? <IcCheck width={16} height={16} /> : <IcDownload width={16} height={16} />}
      </button>
      <div className="relative shrink-0">
        <button onClick={() => setMenu((m) => !m)} aria-label={tr('Chapter actions')}
          className="grid h-9 w-9 place-items-center rounded-full border border-ink-700 text-fog-500">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
        </button>
        {menu && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setMenu(false)} />
            <div className="absolute right-0 top-10 z-30 w-48 overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-lift">
              <button onClick={() => { setMenu(false); onMark(rp?.completed ? 'unread' : 'read'); }}
                className="block w-full px-3.5 py-2.5 text-start text-xs text-fog-200 hover:bg-ink-800">
                {rp?.completed ? 'Mark unread' : 'Mark read'}
              </button>
              <button onClick={() => { setMenu(false); onMark('previous'); }}
                className="block w-full px-3.5 py-2.5 text-start text-xs text-fog-200 hover:bg-ink-800">{tr('Mark previous as read')}</button>
              {onEdit && (
                <button onClick={() => { setMenu(false); onEdit(); }}
                  className="block w-full border-t border-ink-800 px-3.5 py-2.5 text-start text-xs text-fog-200 hover:bg-ink-800">
                  Edit number &amp; title
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SeriesInner() {
  const id = useSearchParams().get('id') || '';
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { isAdmin, user } = useAuth();
  const [editChapter, setEditChapter] = useState<Book | null>(null);
  const [editing, setEditing] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [findingMissing, setFindingMissing] = useState(false);
  const [asc, setAsc] = useState(true);
  const [downloaded, setDownloaded] = useState<Set<string>>(new Set());
  const [showSummary, setShowSummary] = useState(false);
  const [downloadingAll, setDownloadingAll] = useState(false);

  const { data: series } = useQuery({ queryKey: ['series', id], queryFn: () => api<Series>(`/api/series/${id}`), enabled: !!id });
  const { data: books } = useQuery({
    queryKey: ['series-books', id],
    queryFn: () => api<Page<Book>>(`/api/series/${id}/books?size=1000&sort=metadata.numberSort,asc`),
    enabled: !!id,
  });
  const { data: similar } = useQuery({ queryKey: ['similar', id], queryFn: () => api<{ content: Series[] }>(`/api/series/${id}/similar`), enabled: !!id });
  // Saved pages and notes for this series. Both, because this door is the ONLY route to
  // `/moments/?series=<id>`, and that filtered view is the only place the note composer mounts -- the
  // nav, the profile verb and the palette all go to the bare `/moments`. Counting bookmarks alone left a
  // series with notes and no saved pages with no door at all, and a series with neither unable to write
  // its first note: the same trap the composer's own comment says it avoids one level down.
  const { data: moments } = useQuery({
    queryKey: ['bookmarks', id],
    queryFn: () => api<{ content: unknown[] }>(`/api/bookmarks?seriesId=${encodeURIComponent(id)}`),
    enabled: !!id,
  });
  const { data: seriesNotes } = useQuery({
    queryKey: ['notes', id],
    queryFn: () => api<{ content: unknown[] }>(`/api/notes?seriesId=${encodeURIComponent(id)}`),
    enabled: !!id,
  });
  const momentCount = moments?.content?.length ?? 0;
  const noteCount = seriesNotes?.content?.length ?? 0;

  const [fav, setFav] = useState(false);
  const [rating, setRating] = useState<number | null>(null);
  useEffect(() => {
    if (series?.yomi) { setFav(series.yomi.favorite); setRating(series.yomi.rating); }
  }, [series]);

  useEffect(() => {
    listDownloads().then((d) => setDownloaded(new Set(d.filter((c) => c.seriesId === id).map((c) => c.bookId))));
  }, [id]);

  // ambient cover-art theming
  useEffect(() => {
    applyCover(series?.color);
    return () => clearCover();
  }, [series?.color]);

  const chapters = useMemo(() => {
    const c = books?.content ?? [];
    return asc ? c : [...c].reverse();
  }, [books, asc]);
  // For the per-chapter source badge: which source each id is, and which one is the series' own. A chapter
  // fetched through "Find missing chapters" carries the adapter it came from without that source being
  // followed, so the names come from the full source list too -- never the raw id, which for an extension
  // is a nineteen-digit number nobody can read.
  const { data: allSources } = useQuery({
    queryKey: ['sources'],
    queryFn: () => api<{ content: { id: string; name: string }[] }>('/api/sources'),
    staleTime: 60_000,
    enabled: (books?.content ?? []).some((b) => !!b.sourceId),
  });
  const sourceNames = useMemo(() => ({
    ...Object.fromEntries((allSources?.content ?? []).map((s) => [s.id, s.name])),
    ...Object.fromEntries((series?.sources ?? []).map((s) => [s.sourceId, s.name])),
  }), [series, allSources]);
  const primarySource = series?.sources?.find((s) => s.primary)?.sourceId;

  const resumeBook = useMemo(() => {
    const c = books?.content ?? [];
    return c.find((b) => !b.readProgress?.completed) || c[0];
  }, [books]);

  const inProgress = books?.content.some((b) => b.readProgress && !b.readProgress.completed);

  const back = () => (typeof window !== 'undefined' && window.history.length > 1 ? router.back() : router.push('/'));

  const toggleFav = async () => {
    const next = !fav;
    setFav(next);
    try {
      if (next) await api('/api/favorites', { json: { seriesId: id } });
      else await api(`/api/favorites/${id}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['home'] });
    } catch { setFav(!next); }
  };

  const setStars = async (n: number) => {
    setRating(n);
    try { await api(`/api/ratings/${id}`, { method: 'PUT', json: { stars: n } }); } catch {}
  };

  const toggleDownload = async (bookId: string) => {
    if (downloaded.has(bookId)) {
      await deleteDownload(bookId);
      setDownloaded((s) => { const n = new Set(s); n.delete(bookId); return n; });
    } else {
      await downloadChapter(bookId);
      setDownloaded((s) => new Set(s).add(bookId));
    }
  };

  // manual read-state changes go through the same progress endpoint the reader uses, but `silent`
  // so bulk-marking a backlog doesn't count as chapters "read this week" on the leaderboard
  const setRead = async (targets: Book[], completed: boolean) => {
    for (const b of targets) {
      try {
        await api(`/api/books/${b.id}/progress`, {
          method: 'PUT',
          json: { page: completed ? b.media.pagesCount || 1 : 0, completed, seriesId: id, silent: true },
        });
      } catch {}
    }
    qc.invalidateQueries({ queryKey: ['series-books', id] });
    qc.invalidateQueries({ queryKey: ['series', id] });
    qc.invalidateQueries({ queryKey: ['home'] });
  };
  const markChapter = async (b: Book, mode: 'read' | 'unread' | 'previous') => {
    if (mode === 'previous') {
      const prev = (books?.content ?? []).filter((x) => x.number < b.number && !x.readProgress?.completed);
      if (!prev.length) { toast('Nothing before this chapter is unread'); return; }
      toast(`Marking ${prev.length} chapter${prev.length > 1 ? 's' : ''} read…`);
      await setRead(prev, true);
      toast(`Marked ${prev.length} read`, 'success');
    } else {
      await setRead([b], mode === 'read');
      toast(mode === 'read' ? 'Marked read' : 'Marked unread', 'success');
    }
  };
  const markAllRead = async () => {
    const todo = (books?.content ?? []).filter((b) => !b.readProgress?.completed);
    if (!todo.length) { toast('Everything is already read', 'success'); return; }
    toast(`Marking ${todo.length} chapters read…`);
    await setRead(todo, true);
    toast(`Marked ${todo.length} chapters read`, 'success');
  };

  const downloadAll = async () => {
    if (downloadingAll || !books) return;
    // A pruned chapter has no pages left on the server, so including it would "save" an empty chapter to
    // this device and then report it as downloaded. Skipped silently: it is not an error and there is
    // nothing the reader can do about it.
    const todo = books.content.filter((b) => !downloaded.has(b.id) && !b.pruned);
    if (!todo.length) { toast('Everything is already downloaded', 'success'); return; }
    setDownloadingAll(true);
    toast(`Downloading ${todo.length} chapters…`);
    let done = 0;
    for (const b of todo) {
      try {
        await downloadChapter(b.id);
        setDownloaded((s) => new Set(s).add(b.id));
        done++;
      } catch {
        toast('Stopped — device storage may be full', 'error');
        break;
      }
    }
    setDownloadingAll(false);
    if (done) toast(`Saved ${done} chapters offline`, 'success');
  };

  const meta = series?.metadata;
  const summary = meta?.summary || series?.booksMetadata?.summary;
  const title = meta?.title || series?.name || '…';
  const author = meta?.author || meta?.publisher || '';
  // "Updated {X ago}" from the newest chapter's date (always available; a real publish date exists for only some series)
  const updatedAt = useMemo(() => {
    const ts = (books?.content ?? [])
      .map((b) => b.metadata?.releaseDate)
      .filter(Boolean)
      .map((d) => new Date(d as string).getTime())
      .filter((n) => !Number.isNaN(n));
    return ts.length ? new Date(Math.max(...ts)).toISOString() : null;
  }, [books]);
  // volume-based series (old manga stored as tomes) get "volumes" wording instead of "chapters"
  const mostlyVolumes = useMemo(() => {
    const c = books?.content ?? [];
    return c.length > 0 && c.filter((b) => isVolumeName(b.name || b.metadata?.title)).length > c.length / 2;
  }, [books]);

  // shared blocks (rendered once)
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [busyAdmin, setBusyAdmin] = useState(false);

  const doDelete = async () => {
    setBusyAdmin(true);
    try {
      await api(`/api/admin/series/${id}`, { method: 'DELETE' });
      toast('Series removed from the library', 'success');
      router.push('/library');
    } catch (e) {
      toast(msgOf(e, 'Could not remove it'), 'error');
    }
    setBusyAdmin(false);
  };

  const Actions = (
    <div className="mt-4 flex flex-col gap-2">
      <button onClick={() => resumeBook && router.push(`/reader/?book=${resumeBook.id}`)} className="btn-accent w-full">
        <IcPlay width={18} height={18} /> {inProgress ? 'Continue' : 'Start reading'}
      </button>
      <div className="flex gap-2">
        <button onClick={toggleFav} className={`flex flex-1 items-center justify-center gap-2 rounded-full border py-3 text-sm ${fav ? 'border-accent/50 bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>
          <IcHeart width={18} height={18} fill={fav ? 'currentColor' : 'none'} stroke={fav ? 'none' : 'currentColor'} /> {fav ? 'Saved' : 'Favorite'}
        </button>
        <button onClick={downloadAll} disabled={downloadingAll} className="flex flex-1 items-center justify-center gap-2 rounded-full border border-ink-700 py-3 text-sm text-fog-300 disabled:opacity-50">
          <IcDownload width={18} height={18} /> {downloadingAll ? 'Saving…' : 'Download all'}
        </button>
      </div>
      <button onClick={() => setCollecting(true)} className="flex items-center justify-center gap-2 rounded-full border border-ink-700 py-2.5 text-sm text-fog-300">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h10" /><path d="M19 15v6M16 18h6" /></svg>{tr('Add to collection')}</button>
      {/* Always rendered. It is not a link to an empty page: with nothing saved yet it is the way IN to
          writing this series' first note, which is the only thing on the other side that can be created. */}
      <Link href={`/moments/?series=${encodeURIComponent(id)}`}
        className="flex items-center justify-center gap-2 rounded-full border border-ink-700 py-2.5 text-sm text-fog-300">
        <IcMoments width={16} height={16} />
        {momentCount > 0
          ? tr('{n} saved pages', { n: momentCount })
          : noteCount > 0
            ? tr('{n} notes', { n: noteCount })
            : tr('Add a note')}
      </Link>
      <div className="mt-1 flex items-center justify-between">
        <StarRating value={rating} onSet={setStars} />
        <span className="text-xs text-fog-500">{rating ? `${rating}/5` : 'Rate this'}</span>
      </div>
      {canDownload(user) && (series?.booksCount ?? 0) >= 3 && (
        <button onClick={() => setFindingMissing(true)} className="mt-1 flex items-center justify-center gap-2 rounded-full border border-ink-700 py-2.5 text-sm text-fog-300">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /><path d="M11 8v6M8 11h6" /></svg>{tr('Find missing chapters')}</button>
      )}
      {isAdmin && (
        <>
          <button onClick={() => setEditing(true)} className="mt-1 flex items-center justify-center gap-2 rounded-full border border-ink-700 py-2.5 text-sm text-fog-300">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>{tr('Edit details')}</button>
          {series?.folder && (
            <button onClick={() => setRenaming(true)} className="flex items-center justify-center gap-2 rounded-full border border-ink-700 py-2.5 text-sm text-fog-300">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9L11.7 5H19a2 2 0 0 1 2 2v2" /><path d="M3 9h18l-1.5 9a2 2 0 0 1-2 1.8H6.5a2 2 0 0 1-2-1.8Z" /></svg>{tr('Rename folder')}</button>
          )}
          <button onClick={() => setDeleting(true)} className="flex items-center justify-center gap-2 rounded-full border border-ink-700 py-2.5 text-sm text-fog-500 hover:border-rose-500/40 hover:text-rose-300">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>{tr('Remove from library')}</button>
        </>
      )}
    </div>
  );

  const metaBits: ReactNode[] = [
    author ? <span className="text-fog-300">by {author}</span> : null,
    meta?.status ? <span className="capitalize">{meta.status.toLowerCase()}</span> : null,
    series ? <>{series.booksCount} {mostlyVolumes ? 'volumes' : 'chapters'}</> : null,
    (series?.yomi?.unread ?? series?.booksUnreadCount ?? 0) > 0 ? <span className="text-accent">{tr('{n} unread', { n: series!.yomi?.unread ?? series!.booksUnreadCount })}</span> : null,
    behindBit(series),
    updatedAt ? <>Updated {relativeTime(updatedAt)}</> : null,
    rating ? <span className="text-accent">★ {rating}/5</span> : null,
  ].filter(Boolean);
  const Meta = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fog-400 lg:text-sm">
      {metaBits.map((n, i) => (
        <span key={i} className="inline-flex items-center gap-2">
          {i > 0 && <span aria-hidden className="text-ink-600">·</span>}
          {n}
        </span>
      ))}
    </div>
  );

  const Genres = !!meta?.genres?.length && (
    <div className="flex flex-wrap gap-2">
      {meta.genres.slice(0, 8).map((g) => <span key={g} className="chip text-xs">{g}</span>)}
    </div>
  );

  const Summary = summary && (
    <p className={`max-w-3xl text-sm leading-relaxed text-fog-300 ${showSummary ? '' : 'line-clamp-3 lg:line-clamp-4'}`} onClick={() => setShowSummary((s) => !s)}>
      {summary}
    </p>
  );

  const Chapters = (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="font-display text-lg font-semibold">{tr('Chapters')}</h2>
        <div className="flex items-center gap-1.5">
          <button onClick={markAllRead} className="chip text-xs"><IcCheck width={14} height={14} />{tr('Mark all read')}</button>
          <button onClick={() => setAsc((a) => !a)} className="chip text-xs">
            <IcSliders width={14} height={14} /> {asc ? 'Oldest' : 'Newest'}
          </button>
        </div>
      </div>
      <div className="lg:grid lg:gap-x-8 lg:[grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
        {chapters.map((b) => (
          <ChapterRow key={b.id} book={b} downloaded={downloaded.has(b.id)} sourceNames={sourceNames} primarySource={primarySource}
            onReader={() => router.push(`/reader/?book=${b.id}`)} onToggleDownload={() => toggleDownload(b.id)}
            onMark={(mode) => markChapter(b, mode)}
            onEdit={isAdmin ? () => setEditChapter(b) : undefined} />
        ))}
        {!books && Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton my-3 h-6 rounded" />)}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen-d">
      {/* sticky back bar */}
      <div className="safe-top sticky top-0 z-30 flex items-center gap-2 bg-linear-to-b from-ink-950 to-transparent px-4 pb-3 lg:static lg:bg-none lg:px-0 lg:py-4">
        <button onClick={back} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ink-800/70 text-fog-100 backdrop-blur lg:bg-ink-850">
          <IcChevronLeft width={22} height={22} />
        </button>
        <span className="truncate text-sm text-fog-300 lg:text-base">{title}</span>
      </div>

      {/* banner — real art pulled from the internet (AniList), genre-banner fallback */}
      <div className="relative -mt-[58px] h-64 overflow-hidden lg:mt-0 lg:h-[22rem] lg:rounded-3xl">
        {series && <Backdrop seriesId={id} genres={series.metadata?.genres} version={series.artVersion} className="absolute inset-0" />}
        <div className="absolute inset-0 bg-linear-to-t from-ink-950 via-ink-950/65 to-ink-950/30" />
        <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(85% 95% at 22% 0%, rgb(var(--cover, 124 92 255) / 0.32), transparent 62%)' }} />
        {/* desktop title-over-art (Jellyfin style) — offset to the right of the floating poster */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, delay: 0.08, ease: [0.22, 0.61, 0.36, 1] }}
          className="pointer-events-none absolute inset-x-0 bottom-0 hidden flex-col justify-end p-8 lg:flex lg:ps-[288px]">
          {(meta?.status || rating) && (
            <div className="mb-2 flex items-center gap-2">
              {meta?.status && <span className="chip text-[11px] capitalize">{meta.status.toLowerCase()}</span>}
              {rating ? <span className="chip text-[11px] text-accent">★ {rating}/5</span> : null}
            </div>
          )}
          <h1 className="font-display text-4xl font-bold leading-tight text-white [text-shadow:0_2px_16px_rgba(0,0,0,0.6)]">{title}</h1>
          <div className="mt-2">{Meta}</div>
        </motion.div>
      </div>

      {/* content */}
      <div className="px-4 lg:grid lg:grid-cols-[260px_1fr] lg:gap-8 lg:px-0">
        {/* cover + actions */}
        <div className="-mt-20 lg:-mt-32 lg:sticky lg:top-20 lg:self-start">
          <div className="flex items-end gap-4 lg:block">
            <motion.div initial={{ opacity: 0, y: 18, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.5, ease: [0.22, 0.61, 0.36, 1] }}
              className="h-44 w-32 shrink-0 overflow-hidden rounded-2xl border border-ink-600 shadow-lift lg:h-auto lg:w-full">
              {series && <Img src={img.seriesThumb(id, series.artVersion, 800)} alt={series.name} className="aspect-[2/3] h-full w-full" />}
            </motion.div>
            {/* title beside cover on mobile */}
            <div className="min-w-0 pb-1 lg:hidden">
              <h1 className="font-display text-2xl font-bold leading-tight text-white">{title}</h1>
              {Meta}
            </div>
          </div>
          {Actions}
        </div>

        {/* info + chapters */}
        <div className="mt-7 flex flex-col gap-4 lg:mt-4">
          {Genres}
          {Summary}
          {Chapters}
        </div>
      </div>

      {deleting && series && (
        <ConfirmDialog
          title={tr('Remove from library?')}
          danger
          busy={busyAdmin}
          confirmLabel="Remove"
          confirmText={series.name}
          body={
            <>
              <p><strong className="text-fog-100">{tr('No files are deleted.')}</strong> The chapters stay exactly where they are on disk, and nothing in your library folder is touched.</p>
              <p className="mt-2">Everyone&rsquo;s reading progress, history, favourites and ratings are kept, so you can put it back at any time from Admin &rarr; Library, or just add it again.</p>
            </>
          }
          onConfirm={doDelete}
          onClose={() => setDeleting(false)}
        />
      )}
      {renaming && series?.folder && (
        <RenameFolderModal
          id={id}
          folder={series.folder}
          title={series.metadata?.title || series.name}
          onClose={() => setRenaming(false)}
          onSaved={() => { for (const k of [['series', id], ['series-books', id], ['library'], ['home']]) qc.invalidateQueries({ queryKey: k }); }}
        />
      )}
      {editing && series && <SeriesEditModal id={id} series={series} onClose={() => setEditing(false)} onSaved={() => { for (const k of [['series', id], ['series-books', id], ['home'], ['library']]) qc.invalidateQueries({ queryKey: k }); }} />}
      {editChapter && (
        <ChapterEditModal book={editChapter} onClose={() => setEditChapter(null)}
          onSaved={() => { for (const k of [['series-books', id], ['series', id], ['home']]) qc.invalidateQueries({ queryKey: k }); }} />
      )}
      {collecting && <CollectionSheet seriesId={id} onClose={() => setCollecting(false)} />}
      {findingMissing && <FindMissingDialog seriesId={id} onClose={() => setFindingMissing(false)} />}

      {(similar?.content?.length ?? 0) > 0 && (
        <section className="mt-10">
          <SectionTitle>{tr('More like this')}</SectionTitle>
          <Rail>{similar!.content.map((s) => <SeriesCard key={s.id} series={s} />)}</Rail>
        </section>
      )}
    </div>
  );
}

export default function SeriesPage() {
  return (
    <Suspense fallback={<div className="min-h-screen-d" />}>
      <SeriesInner />
    </Suspense>
  );
}

/**
 * "3 behind" -- how many chapters the source has that this library does not.
 *
 * The updater has stamped `source_missing` on the row for months and `seriesDto` threw it away, so the one
 * number that answers "is there more of this?" was computed on a schedule and never shown.
 *
 * Five things must all be true before it says anything, because the failure mode here is not a wrong pixel,
 * it is telling someone there are three new chapters when there are none:
 *
 *   1. the source has been asked at all -- `source` is null until the updater first visits;
 *   2. it ANSWERED -- `missing` is null when the check errored, and a failed check is not "0 behind";
 *   3. there is actually something missing -- zero is not news;
 *   4. auto-update is on for this series -- with it off the number stops being maintained and goes stale
 *      silently, which is worse than absent;
 *   5. and the check is recent. Past 48 hours the number is still shown, but the sentence leads with how
 *      old it is and drops the accent, because "3 behind" and "3 behind, as of last week" are different
 *      claims and only one of them is being made.
 *
 * Never red. Red means destructive everywhere else in this palette, and a series having new chapters is the
 * good news on this page.
 */
//
// ⚠️ A FUNCTION, NOT A COMPONENT, and it is called -- `behindBit(series)` -- rather than rendered as
// `<BehindBit />`. Every entry in `metaBits` is dropped by a trailing `.filter(Boolean)`, and a React
// element is an object, so it is ALWAYS truthy: as a component this survived the filter even when it
// rendered nothing, and the row's `i > 0` separator then emitted a stray "·" on every series page whose
// source has not been checked -- which is most of them.
function behindBit(series?: Series): ReactNode {
  const src = series?.source;
  if (!src || src.missing == null || src.missing <= 0) return null;      // rules 1-3
  if (series?.autoUpdate === false) return null;                          // rule 4
  const age = Date.now() - Date.parse(src.checkedAt);
  const stale = !Number.isFinite(age) || age > 48 * 3600_000;             // rule 5
  return stale
    ? <span className="text-fog-500">{tr('{n} behind, as of {ago}', { n: src.missing, ago: relativeTime(src.checkedAt) })}</span>
    : <span className="text-accent">{tr('{n} behind', { n: src.missing })}</span>;
}
