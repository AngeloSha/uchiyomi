'use client';
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { useSearchParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { Book, Ghost, Listing, Page, Series, VersionCopy, Versions } from '@/lib/types';
import { chapterLabel, chapterName, isVolumeName, relativeTime } from '@/lib/format';
import { listDownloads, downloadChapter, deleteDownload } from '@/lib/downloads';
import { applyCover, clearCover } from '@/lib/theme';
import { Img, Backdrop, Rail, SectionTitle } from '@/components/ui';
import { SeriesCard } from '@/components/cards';
import { useToast } from '@/components/Toast';
import { ConfirmDialog, Modal, msgOf } from '@/components/ConfirmDialog';
import { useAuth, canDownload } from '@/lib/auth';
import { IcChevronLeft, IcHeart, IcStar, IcPlay, IcDownload, IcCloudDownload, IcCheck, IcTrash, IcMoments } from '@/components/icons';
import { t as tr } from '@/lib/i18n';
import { FindMissingDialog } from '@/components/FindMissingDialog';
import { normGroup } from '@/lib/scanlators';
import { GHOST_CAP, mergeRows, whyLabel, runLabel, chunkNumbers, MARK_CHUNK } from '@/lib/chapterRows';
import { ALL_GROUPS, copySourceId, groupsOfRow, matchesGroup } from '@/lib/groupFilter';
import { SourcesSheet, useSeriesGroups, useCheckNow } from '@/components/SourcesSheet';
import { SourcesExplainer } from '@/components/SourcesExplainer';
import { SupplyLine } from '@/components/SupplyLine';
import { ChapterFilterSheet } from '@/components/ChapterFilterSheet';
import { ChapterVersionsSheet } from '@/components/ChapterVersionsSheet';
import { GroupAvatar } from '@/components/GroupAvatar';
import { supplyLine } from '@/lib/supplyLine';
import { isDesktop } from '@/lib/desktop';

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

  // The same Check now as the Sources & translations sheet's chip, so the two report alike.
  const { checking, checkNow } = useCheckNow(id, onSaved);
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
              <span className="text-fog-100">{tr('Auto-update new chapters')}</span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-fog-500">{tr('The scheduled check fetches new chapters for this series.')}</span>
            </span>
            <input type="checkbox" checked={autoUpdate} onChange={(e) => toggleAuto(e.target.checked)} className="size-4 shrink-0 accent-accent" />
          </label>
          <button onClick={checkNow} disabled={checking} className="mt-2 w-full rounded-full border border-ink-700 py-2 text-sm text-fog-300 disabled:opacity-50">
            {checking ? tr('Checking…') : 'Check for new chapters now'}
          </button>
          {/* The sources (with their × to stop following one) and the Prefer / Block / patience controls live
              in the Sources & translations sheet on the series page now, beside the statistics they are
              decided from. One line here so an admin who learned them in this dialog is told where they
              went rather than left to conclude they are gone. */}
          <p className="mt-3 border-t border-ink-800 pt-3 text-[11px] text-fog-600">{tr('Translation groups are ranked in Sources & translations')}</p>
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
            tracker. Progress never moves backwards on its own: if the new number is lower, the tracker keeps
            the higher one until an admin imports your list again under Admin → Import (From your tracker).
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

/**
 * The muted caption under a chapter's label: who translated it, `via {source}` when the copy came from a
 * source other than the series' own, and `{n} versions` when the number has more than one copy on offer.
 * Plain text, one line, truncating -- the bordered pills this replaces put three boxes of text on every row,
 * which at 390 px was more chrome than chapter. `Deleted from the server` stays a small chip before it: a
 * tombstone is a state, not a caption.
 *
 * ⚠️ `{n} versions` is TEXT, never a button. This caption sits inside the row's opener, which is itself a
 * <button>, and a button inside a button is invalid DOM that browsers un-nest unpredictably (the v0.33 strip
 * sat OUTSIDE the opener for exactly this reason). The copies open from ⋯ → Versions on a chapter row, and
 * from the row tap on a ghost row.
 */
function RowCaption({ group, via, versions, tone = 'text-fog-500', pruned, lead, missing }: {
  group?: string | null;
  via?: string | null;
  versions?: number;
  tone?: string;
  pruned?: boolean;
  /** A first part before the group: a ghost's reason ("not here yet", "waiting for Asura Scans · 2 days left"). */
  lead?: { text: string; amber?: boolean } | null;
  /**
   * How many pages the saved file holds a placeholder for (`Book.missingPages`, v0.40.0). A chip like the
   * tombstone's, amber because it is news that clears itself: the sweep refills the holes and the server
   * drops the column when the last one lands. Zero or absent draws nothing.
   */
  missing?: number;
}) {
  const parts: ReactNode[] = [];
  const short = missing && missing > 0 ? (missing === 1 ? tr('1 page missing') : tr('{n} pages missing', { n: missing })) : null;
  // The same caption as plain text, for `title`: at the owner's desktop width a cell is 287 px and the
  // caption beside the thumb, the date and the two buttons gets ≈90, so "Reaper Scans · 2 versions" is an
  // ellipsis there and a hover is how the rest is read.
  const plain: string[] = [];
  if (lead) { parts.push(<span key="lead" className={lead.amber ? 'text-amber-300' : ''}>{lead.text}</span>); plain.push(lead.text); }
  // The avatar is an atomic inline BESIDE the name, not a flex box AROUND it: Chrome does not put an
  // ellipsis inside an inline-flex it has to cut, so a name wrapped with its avatar was clipped mid-letter
  // in the 250 px desktop grid cells ("Asura Sc") while a plain-text part ended in "…".
  if (group) { parts.push(<span key="g"><GroupAvatar name={group} size={14} className="me-1 align-text-bottom" />{group}</span>); plain.push(group); }
  if (via) { const t = tr('via {source}', { source: via }); parts.push(<span key="via">{t}</span>); plain.push(t); }
  if (versions && versions >= 2) { const t = tr('{n} versions', { n: versions }); parts.push(<span key="v">{t}</span>); plain.push(t); }
  if (!parts.length && !pruned && !short) return null;
  const title = [...(pruned ? [tr('Deleted from the server')] : []), ...(short ? [short] : []), ...plain].join(' · ');
  return (
    // One block that truncates as a whole (inline children, no flex): a flex row of shrink-0 parts would
    // run under the date at the end of the row instead of ending in an ellipsis.
    <p className={`mt-0.5 truncate text-[11px] ${tone}`} title={title}>
      {/* Shown even when a copy is saved on this device -- it is still gone from the server, and "yours is
          the last one" is exactly what somebody wants to know before clearing downloads. One wording for
          every tombstone: the same mark is left by an admin's Delete from server as by the scheduled
          cleanup, and the row cannot tell which, so "to free space" blamed a job that is off on most
          installs. */}
      {pruned && <span className="me-1 rounded-full border border-ink-700 px-1.5 text-[10px] leading-4 text-fog-600">{tr('Deleted from the server')}</span>}
      {/* Before the group, as a chip and not a caption part: "3 pages missing · Asura Scans" would read as
          the group's fault. The count is the file's -- the reader shows the caption on exactly those pages. */}
      {short && <span className="me-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] leading-4 text-amber-300">{short}</span>}
      {parts.map((n, i) => (
        <span key={i}>
          {i > 0 && <span aria-hidden className="text-ink-600"> · </span>}
          {n}
        </span>
      ))}
    </p>
  );
}

/**
 * The date at the end of a row: "3d ago" on the phone, "3d" on the desktop grid. A 287-px cell (three
 * columns at 1280) leaves the caption 71 px beside "3d ago", and a group name with its avatar is ≈90: the
 * word is what the column can spare there, and the number still reads as a date beside the others. Older
 * chapters show the locale date in both forms, as the column always has. `lg` is where the list becomes
 * the grid. Two spans rather than a media query in JS: the first paint of a static export knows no width.
 */
function RowDate({ iso, className = '' }: { iso: string; className?: string }) {
  const long = relativeTime(iso);
  const short = long === 'just now' ? 'now' : long.replace(/ ago$/, '');
  return (
    <span className={`shrink-0 text-[11px] text-fog-500 ${className}`}>
      <span className="lg:hidden">{long}</span>
      <span className="hidden lg:inline">{short}</span>
    </span>
  );
}

function ChapterRow({ book, downloaded, sourceNames, primarySource, versions, onReader, onToggleDownload, onMark, onEdit, onVersions, selectable, selected, onToggle }: {
  book: Book;
  downloaded: boolean;
  /** Select mode: the row toggles instead of opening, shows the ✓ bubble, and hides its own two controls. */
  selectable?: boolean; selected?: boolean; onToggle?: () => void;
  /** Source id -> display name, from the series' followed sources; names the caption on a chapter another source supplied. */
  sourceNames?: Record<string, string>;
  /** The series' own source. A chapter from it gets no `via`: that is the normal case, not news. */
  primarySource?: string;
  /** How many copies the sources offer for this number; the caption says so from two up. */
  versions?: number;
  onReader: () => void;
  onToggleDownload: () => Promise<void>;
  onMark: (mode: 'read' | 'unread' | 'previous') => void;
  /** admin only: opens the number/title editor. Absent for everyone else. */
  onEdit?: () => void;
  /** Opens the chapter sheet with every copy of this number; absent when the sources know none. */
  onVersions?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const rp = book.readProgress;
  const state = rp?.completed ? 'read' : rp ? 'reading' : 'unread';
  // Only a name is shown; an id that resolves to nothing (a source since removed) shows no caption at all.
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
    // `id="ch-N"` is what the chapter chips in the Sources & translations sheet scroll to. `lg:gap-2.5`: on
    // the desktop grid a 287-px cell (three columns at 1280) leaves the caption ≈90 px beside the thumb,
    // the dot, the date and two 36-px buttons -- exactly a group name with its avatar -- and a two-digit
    // day ("29d") took 4 of them back. Five gaps at 10 rather than 12 return ten. GhostRow matches.
    <div id={`ch-${book.number}`} className="border-b border-ink-800/70">
    <div className="flex items-center gap-3 py-2.5 lg:gap-2.5">
      {/* In select mode a pruned chapter is still selectable -- Mark read and Fetch again are exactly the
          things one wants for it -- so the disable only applies to opening. */}
      <button onClick={selectable ? onToggle : onReader} disabled={pruned && !selectable} aria-pressed={selectable ? !!selected : undefined}
        className="flex min-w-0 flex-1 items-center gap-3 text-start disabled:cursor-default">
        <div className={`relative h-14 w-10 shrink-0 overflow-hidden rounded-lg border ${state === 'read' ? 'border-ink-800 opacity-45' : 'border-ink-700'} ${book.pruned && !downloaded ? 'border-dashed border-ink-600' : ''}`}>
          {/* A tombstone has no file to draw a thumbnail from; asking would be a 404 per row on every visit.
              The dashed empty box is the ghost row's, so "no pages here" reads the same in both places. */}
          {!(book.pruned && !downloaded) && <Img src={img.bookThumb(book.id)} alt="" className="h-full w-full" />}
          {state === 'reading' && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-accent" />}
          {selectable && <SelectBubble selected={!!selected} />}
        </div>
        <span className={`h-2 w-2 shrink-0 rounded-full ${state === 'read' ? 'bg-ink-600' : state === 'reading' ? 'bg-accent' : 'bg-accent/40'}`} />
        <div className="min-w-0">
          <p className={`truncate text-sm ${state === 'read' ? 'text-fog-500' : 'text-fog-100'}`}>
            {chapterLabel(book)}
            {/* The chapter's own name, when the source gave one that is not just the number again. */}
            {chapterName(book) && <span className="text-fog-500"> · {chapterName(book)}</span>}
          </p>
          <RowCaption group={book.scanlator} via={altSource} versions={versions} pruned={book.pruned} missing={book.missingPages?.length} />
          {state === 'reading' && rp && (
            <p className="text-[11px] text-accent">page {rp.page}/{book.media.pagesCount}</p>
          )}
        </div>
      </button>
      {book.metadata?.releaseDate && <RowDate iso={book.metadata.releaseDate} />}
      {!selectable && <>
      {/* Not on Uchiyomi Desktop (lib/desktop.ts): the chapter is already a file on this computer. */}
      {!isDesktop() && <button
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
        // "Save offline", not "Download": the ☁ on a ghost row brings a chapter onto the server, this arrow
        // copies one to this device, and one word for both promised the wrong thing on one of them.
        aria-label={downloaded ? tr('Remove from this device') : tr('Save offline')}
      >
        {busy ? <span className="text-[10px] font-semibold text-accent">…</span> : downloaded ? <IcCheck width={16} height={16} /> : <IcDownload width={16} height={16} />}
      </button>}
      <div className="relative shrink-0">
        <button onClick={() => setMenu((m) => !m)} aria-label={tr('Chapter actions')}
          className="grid h-9 w-9 place-items-center rounded-full border border-ink-700 text-fog-500">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
        </button>
        {menu && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setMenu(false)} />
            <div className="absolute end-0 top-10 z-30 w-48 overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-lift">
              <button onClick={() => { setMenu(false); onMark(rp?.completed ? 'unread' : 'read'); }}
                className="block w-full px-3.5 py-2.5 text-start text-xs text-fog-200 hover:bg-ink-800">
                {rp?.completed ? tr('Mark unread') : tr('Mark read')}
              </button>
              <button onClick={() => { setMenu(false); onMark('previous'); }}
                className="block w-full px-3.5 py-2.5 text-start text-xs text-fog-200 hover:bg-ink-800">{tr('Mark previous as read')}</button>
              {onVersions && (
                <button onClick={() => { setMenu(false); onVersions(); }}
                  className="block w-full border-t border-ink-800 px-3.5 py-2.5 text-start text-xs text-fog-200 hover:bg-ink-800">
                  {tr('Versions')}
                </button>
              )}
              {onEdit && (
                <button onClick={() => { setMenu(false); onEdit(); }}
                  className="block w-full border-t border-ink-800 px-3.5 py-2.5 text-start text-xs text-fog-200 hover:bg-ink-800">
                  {tr('Edit number & title')}
                </button>
              )}
            </div>
          </>
        )}
      </div>
      </>}
    </div>
    </div>
  );
}

/** The ✓ bubble on a thumb in select mode -- the library tile's, so the two select modes look like one. */
function SelectBubble({ selected }: { selected: boolean }) {
  return (
    <>
      {selected && <span className="absolute inset-0 z-10 rounded-lg border-2 border-accent bg-accent/20" />}
      <span className={`absolute start-1.5 top-1.5 z-20 grid h-6 w-6 place-items-center rounded-full border text-[11px] font-bold ${
        selected ? 'border-accent bg-accent text-black' : 'border-white/50 bg-black/50 text-transparent'}`}>✓</span>
    </>
  );
}

/**
 * A chapter the sources list that this server does not hold.
 *
 * Same grid and height as ChapterRow so the list reads as one list, dimmed so it reads as absent. Tapping it
 * opens the chapter sheet -- every copy on offer, with Fetch on each -- so a row that looks like a chapter
 * does something when tapped (it used to be inert, and a row that does nothing is worse than one that says
 * so). The caption is the point of the row: "not here yet" and "only a blocked group has it" want different
 * things done about them, and only `failed` is amber, because it is the only one that is news rather than
 * a state. The downloader's error text is in the sheet for admins (the server sends `reason` to nobody
 * else).
 *
 * A reader can mark it read without ever fetching it (#69): the row then takes the chapter row's read
 * treatment -- the filled grey dot, the dimmed title -- plus a ✓ in the empty thumb, and it STAYS dashed and
 * dimmed, because "this server does not have it" is still true. The mark lives in its own table and becomes
 * ordinary progress when the chapter lands (bff lib/listingProgress).
 */
function GhostRow({ ghost, sourceNames, primarySource, selectable, selected, onToggle, onFetch, onOpen, onMark }: {
  ghost: Ghost;
  sourceNames?: Record<string, string>;
  primarySource?: string;
  selectable?: boolean; selected?: boolean; onToggle?: () => void;
  /**
   * Fetch this one chapter now, for a viewer who may download; absent for everyone else and for a row only
   * blocked groups released (the caller decides both, the row only draws the button). Select mode stays the
   * bulk path and hides it. Asked for on #40 with a Tachimanga screenshot: a fetch icon per row, no Select.
   */
  onFetch?: () => Promise<void>;
  /** Open the chapter sheet for this number. */
  onOpen: () => void;
  /**
   * Mark this number read (true) or unread (false) -- the ⋯ menu, the chapter row's. For every viewer who
   * can see the page, download permission or not: a mark costs no bytes. Select mode hides it like the ☁.
   */
  onMark?: (completed: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const read = ghost.read === true;
  const label = whyLabel(ghost);
  // The same rule as the chapter row's caption: the series' own source is the normal case, not news. The
  // listing carries the source's name, so an id the followed list no longer resolves still gets one --
  // ⚠️ unless that "name" IS the id: the server falls back to `getSource(id)?.name ?? id`, so a source that
  // is no longer loaded (an extension removed since the check) arrives as `ext:fake` or a nineteen-digit
  // number, and the ChapterRow rule is that a caption is a name or nothing. Reintroduce by dropping the
  // `!== ghost.sourceId` test: seed a ghost from an unloaded source and its caption reads the raw id.
  const altSource = ghost.sourceId !== primarySource
    ? (sourceNames?.[ghost.sourceId] ?? (ghost.sourceName !== ghost.sourceId ? ghost.sourceName : null))
    : null;
  // Most sources title a chapter "Chapter 12", which beside "Ch. 12" says nothing twice.
  const title = ghost.title?.trim() || '';
  const showTitle = !!title && !/^(ch(apter)?\.?\s*)?[\d.]+$/i.test(title);
  return (
    <div id={`ch-${ghost.number}`} className="border-b border-ink-800/70">
    {/* The dimming is the opener's and the date's, not the row's: the fetch button at the end of the line
        is a live control, and a child cannot undo its parent's opacity. */}
    <div className="flex items-center gap-3 py-2.5 lg:gap-2.5">
      <button type="button" onClick={selectable ? onToggle : onOpen} aria-pressed={selectable ? !!selected : undefined} aria-haspopup={selectable ? undefined : 'dialog'}
        className={`flex min-w-0 flex-1 items-center gap-3 text-start ${selected ? '' : 'opacity-60'}`}>
        <div className="relative grid h-14 w-10 shrink-0 place-items-center rounded-lg border border-dashed border-ink-600">
          {read && !selectable && (
            <span role="img" aria-label={tr('Read · not on the server')} className="text-fog-500"><IcCheck width={14} height={14} /></span>
          )}
          {selectable && <SelectBubble selected={!!selected} />}
        </div>
        <span className={`h-2 w-2 shrink-0 rounded-full ${read ? 'bg-ink-600' : 'border border-ink-600'}`} />
        <div className="min-w-0">
          <p className={`truncate text-sm ${read ? 'text-fog-500' : 'text-fog-300'}`}>
            {chapterLabel({ number: ghost.number })}
            {showTitle && <span className="text-fog-500"> · {title}</span>}
          </p>
          {/* "waiting for Asura Scans · 2 days left" already names the group; the group part is for the
              other reasons, where the caption would otherwise not say who has it. */}
          <RowCaption lead={label ? { text: tr(label.key, label.args), amber: ghost.why === 'failed' } : null}
            group={ghost.why === 'held' && label?.args.g ? null : ghost.scanlator} via={altSource} />
        </div>
      </button>
      {ghost.publishedAt && <RowDate iso={ghost.publishedAt} className={selected ? '' : 'opacity-60'} />}
      {/* The cloud, not the ⬇ of the row above: that arrow saves a chapter to THIS DEVICE, this one brings
          it onto the server, and the same glyph for both would promise the wrong thing on one of them. */}
      {onFetch && !selectable && (
        <button type="button" aria-label={tr('Fetch')} disabled={busy}
          onClick={async () => {
            if (busy) return;
            setBusy(true);
            try { await onFetch(); } finally { setBusy(false); }
          }}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-ink-700 text-fog-500 disabled:opacity-60">
          {busy ? <span className="text-[10px] font-semibold text-accent">…</span> : <IcCloudDownload width={16} height={16} />}
        </button>
      )}
      {/* The chapter row's ⋯, with the one action that applies to a chapter that is not here. */}
      {onMark && !selectable && (
        <div className="relative shrink-0">
          <button type="button" onClick={() => setMenu((m) => !m)} aria-label={tr('Chapter actions')}
            className="grid h-9 w-9 place-items-center rounded-full border border-ink-700 text-fog-500">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
          </button>
          {menu && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setMenu(false)} />
              <div className="absolute end-0 top-10 z-30 w-48 overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-lift">
                <button type="button" onClick={() => { setMenu(false); onMark(!read); }}
                  className="block w-full px-3.5 py-2.5 text-start text-xs text-fog-200 hover:bg-ink-800">
                  {read ? tr('Mark unread') : tr('Mark read')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
    </div>
  );
}

/** The one job the page started, and when: `dataUpdatedAt` is compared against `at`, see below. */
interface StartedJob { folder: string; at: number }
interface SourceJob { folder: string; status: string; reason?: string }

/** The localStorage key for the per-device "Show chapters not on the server yet" switch in the Filter sheet. */
const SHOW_GHOSTS_KEY = 'uchiyomi.showGhosts';
function readShowGhosts(): boolean {
  try { return localStorage.getItem(SHOW_GHOSTS_KEY) !== 'off'; } catch { return true; }
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
  // Ghost rows: the chapters the sources list that this server lacks. Per device, default on, because
  // "there are 12 more of these" is the news this page exists to carry; off is for a phone that only ever
  // reads what is already here.
  const [showGhosts, setShowGhosts] = useState(true);
  useEffect(() => { setShowGhosts(readShowGhosts()); }, []);
  const [showAll, setShowAll] = useState(false);
  // Select mode, the library's pattern. Two sets because a chapter is picked by id and a ghost has none --
  // it is picked by number, which is what the fetch route takes. Cleared whenever the list under it
  // changes shape, so a selection can never outlive the rows it was made from.
  const [selecting, setSelecting] = useState(false);
  const [pickedBooks, setPickedBooks] = useState<Set<string>>(new Set());
  const [pickedGhosts, setPickedGhosts] = useState<Set<number>>(new Set());
  const [acting, setActing] = useState(false);
  const [confirming, setConfirming] = useState<null | 'delete' | 'refetch'>(null);
  const [started, setStarted] = useState<StartedJob | null>(null);
  const clearPicks = () => { setPickedBooks(new Set()); setPickedGhosts(new Set()); };
  const leaveSelect = () => { setSelecting(false); clearPicks(); };
  // The four sheets and the explainer. ⚠️ At most one is open at a time, and a sheet is closed BEFORE any
  // Modal opens: `Modal`/`ConfirmDialog` are z-50 and `Sheet` z-60 inside main's stacking context, so a
  // dialog opened while a sheet is up paints under its backdrop and cannot be tapped. The explainer is a
  // Sheet too, so the (i) SWAPS it for the sources sheet (and back on close) rather than stacking: two
  // stacked sheets both listen for Escape, and one press closed both.
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [chapterSheet, setChapterSheet] = useState<{ number: number; book?: Book; ghost?: Ghost } | null>(null);
  // The older-chapters runs the reader unfolded, by the run's lowest number (chapterRows.ts). Hiding one
  // drops its ghosts from the picks: they leave the screen, and the same rule as `toggleGhosts` applies --
  // a row nobody can see cannot stay picked, or the bar keeps counting and Fetch acts on it.
  const [expandedRuns, setExpandedRuns] = useState<Set<number>>(new Set());
  const toggleRun = (from: number, numbers: number[]) => {
    const hiding = expandedRuns.has(from);
    setExpandedRuns((o) => { const next = new Set(o); next.has(from) ? next.delete(from) : next.add(from); return next; });
    if (hiding) setPickedGhosts((p) => { const n = new Set(p); for (const x of numbers) n.delete(x); return n; });
  };
  useEffect(() => { setSelecting(false); setPickedBooks(new Set()); setPickedGhosts(new Set()); setShowAll(false); setExpandedRuns(new Set()); setChapterSheet(null); }, [id, asc]);

  const { data: series } = useQuery({ queryKey: ['series', id], queryFn: () => api<Series>(`/api/series/${id}`), enabled: !!id });
  const { data: books } = useQuery({
    queryKey: ['series-books', id],
    queryFn: () => api<Page<Book>>(`/api/series/${id}/books?size=1000&sort=metadata.numberSort,asc`),
    enabled: !!id,
  });
  // What the sources list that the library lacks, as of the updater's last visit. A courtesy, never a
  // blocker: no retry, and an error renders no ghost rows rather than a message, because the chapters on
  // disk are the page and this is the margin note.
  const { data: listing, isFetched: listingSettled } = useQuery({
    queryKey: ['series-listing', id],
    queryFn: () => api<Listing>(`/api/series/${id}/listing`),
    enabled: !!id,
    retry: false,
  });
  const ghosts = useMemo(() => listing?.content ?? [], [listing]);
  // The groups behind the supply line, the Sources & translations sheet and the group filter: one hook,
  // the route for the viewer's role (SourcesSheet.tsx says which), fetched once for all three.
  const { groups, admin: adminGroups, error: groupsError, isLoading: groupsLoading, checkedAt: groupsCheckedAt } = useSeriesGroups(id, isAdmin);
  // Every copy of every listed number, for the `{n} versions` captions and the chapter sheet. Fetched once
  // per page as soon as there is a row to caption -- the caption needs the count before anyone opens
  // anything -- and cached for a minute, because it is one request for the whole list and the sweep that
  // changes its answer runs on the hour, not the second.
  const { data: versionsData } = useQuery({
    queryKey: ['series-versions', id],
    queryFn: () => api<Versions>(`/api/series/${id}/versions`),
    enabled: !!id && ((books?.content.length ?? 0) > 0 || ghosts.length > 0),
    staleTime: 60_000,
    retry: false,
  });
  // Every number with at least one copy: the chapter sheet lists a single copy too (it is where Fetch on a
  // ghost lives); the caption says "{n} versions" only from two up, since one copy is not a version, it is
  // the chapter.
  const versionsOf = useMemo(() => {
    const m = new Map<number, VersionCopy[]>();
    for (const v of versionsData?.content ?? []) if (v.copies.length >= 1) m.set(v.number, v.copies);
    return m;
  }, [versionsData]);
  // The group filter in the Filter sheet. `ALL_GROUPS` is the sentinel for "every group" (groupFilter.ts
  // says why a real name could not be); it resets with the series, since a group name is meaningless on
  // the next one.
  const [group, setGroup] = useState<string>(ALL_GROUPS);
  useEffect(() => { setGroup(ALL_GROUPS); }, [id]);
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

  // Numbers with a chapter row here: the sheet's chapter chips are solid for these, and a ghost on one of
  // them is a stale listing's, never a row (mergeRows applies the same rule; this keeps the filter's count
  // honest too).
  const allBooks = useMemo(() => books?.content ?? [], [books]);
  const haveNumbers = useMemo(() => new Set(allBooks.map((b) => b.number)), [allBooks]);
  // The sheet's solid chips are the LIVE rows only: a tombstone keeps its row (the ghost dedupe above is
  // right to count it -- the number is not "missing", it was deleted on purpose) but has no pages, and a
  // solid chip promises pages. Reintroduce by passing `haveNumbers` to the sheet: the chip for a pruned
  // number is solid, and tapping it lands on "Deleted from the server".
  const liveNumbers = useMemo(() => new Set(allBooks.filter((b) => !b.pruned).map((b) => b.number)), [allBooks]);
  const visibleGhosts = useMemo(() => (showGhosts ? ghosts.filter((g) => !haveNumbers.has(g.number)) : []), [showGhosts, ghosts, haveNumbers]);
  // The names the filter offers: the groups route's, or -- when it answered with nothing (a series scanned
  // from disk, a route that is not there) -- whatever the chapters on disk name, so a hand-built library
  // with tagged files still gets the filter.
  const groupNames = useMemo(() => {
    if (groups.length) return groups.map((g) => g.name);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const b of allBooks) for (const g of groupsOfRow(b)) { const k = normGroup(g); if (!seen.has(k)) { seen.add(k); out.push(g); } }
    return out;
  }, [groups, allBooks]);
  // The filter is applied BEFORE mergeRows, so the run rows and the "Show all" fold are computed over what
  // is shown: a filter that hid 40 of 50 capped ghosts and still said "Show all 120" would be lying.
  const filteredBooks = useMemo(() => (group === ALL_GROUPS ? allBooks : allBooks.filter((b) => matchesGroup(b, group))), [allBooks, group]);
  const filteredGhosts = useMemo(() => (group === ALL_GROUPS ? visibleGhosts : visibleGhosts.filter((g) => matchesGroup(g, group))), [visibleGhosts, group]);
  // The list, in the list's direction: chapters on disk and, between them, the ghosts (see chapterRows.ts).
  const rows = useMemo(() => mergeRows(filteredBooks, filteredGhosts, asc, showAll, expandedRuns), [filteredBooks, filteredGhosts, asc, showAll, expandedRuns]);
  // A series with no chapters at all (a "Nothing yet" add) has one thing to show: the run of older chapters
  // under its floor, which is every number the source lists. It opens unfolded, once per series AND
  // direction -- a ref, not an effect on `rows`, or Hide would be undone by the next listing refetch.
  // ⚠️ Keyed by `asc` too: the effect above folds every run on Newest/Oldest, and a key of `id` alone let
  // it re-open nothing, so one tap on the sort left the page with a single folded run row and no other
  // content until the reader found Show.
  const defaultedRun = useRef<string | null>(null);
  useEffect(() => {
    const key = `${id}:${asc}`;
    if (!series || series.booksCount !== 0 || !ghosts.length || defaultedRun.current === key) return;
    defaultedRun.current = key;
    setExpandedRuns(new Set(mergeRows([], ghosts, true, true).filter((r) => r.kind === 'run').map((r) => (r as Extract<typeof r, { kind: 'run' }>).from)));
  }, [series, ghosts, id, asc]);
  // For the per-chapter `via {source}` caption: which source each id is, and which one is the series' own.
  // A chapter fetched through "Find missing chapters" carries the adapter it came from without that source
  // being followed, so the names come from the full source list too -- never the raw id, which for an
  // extension is a nineteen-digit number nobody can read. ⚠️ Only for a viewer who may download: the route
  // answers 403 to everyone else, which was one failed request per visit for a member without download
  // rights; their names come from `series.sources` and the listing's `sourceName`.
  const { data: allSources } = useQuery({
    queryKey: ['sources'],
    queryFn: () => api<{ content: { id: string; name: string }[] }>('/api/sources'),
    staleTime: 60_000,
    enabled: canDownload(user) && (books?.content ?? []).some((b) => !!b.sourceId),
  });
  const sourceNames = useMemo(() => ({
    ...Object.fromEntries((allSources?.content ?? []).map((s) => [s.id, s.name])),
    ...Object.fromEntries((series?.sources ?? []).map((s) => [s.sourceId, s.name])),
  }), [series, allSources]);
  const primarySource = series?.sources?.find((s) => s.primary)?.sourceId;
  // The supply line's facts. `checkedAt`: the groups route's, or the listing's when the route did not send
  // one, or the source row's -- all the same `series_listing` check. `notHere` counts what the sweep would
  // take (the old "behind" semantics); the older run under the floor is the run row's to say. Settled =
  // the three queries behind it have answered or failed, so the line does not rewrite itself as they land.
  const supplyChecked = groupsCheckedAt ?? listing?.checkedAt ?? series?.sources?.find((s) => s.primary)?.checkedAt ?? null;
  const supplyLoaded = !!series && !!listingSettled && !groupsLoading;
  const supplyInput = useMemo(() => ({
    sources: series?.sources ?? [],
    groups: groups.map((g) => g.name),
    notHere: ghosts.filter((g) => g.why !== 'floor' && !haveNumbers.has(g.number)).length,
    listedTotal: ghosts.length,
    booksCount: series?.booksCount ?? 0,
    checkedAt: supplyChecked,
    autoUpdate: series?.autoUpdate !== false,
    groupsError: !!groupsError,
    isAdmin,
  }), [series, groups, ghosts, haveNumbers, supplyChecked, groupsError, isAdmin]);
  const supplyPhone = useMemo(() => supplyLine(supplyInput, false), [supplyInput]);
  const supplyWide = useMemo(() => supplyLine(supplyInput, true), [supplyInput]);

  const resumeBook = useMemo(() => {
    const c = books?.content ?? [];
    // A chapter the server deleted has no pages to resume into -- unless this device saved a copy, in which
    // case that copy is the last one and resuming into it is right. Without this, "Continue" on a series
    // whose next unread chapter was pruned opened straight onto "Chapter deleted".
    const openable = (b: Book) => !b.pruned || downloaded.has(b.id);
    return c.find((b) => !b.readProgress?.completed && openable(b)) || c.find(openable) || c[0];
  }, [books, downloaded]);

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
  /**
   * The same for chapters the server does not hold (#69): they have no book id for the progress endpoint,
   * so they go by number to their own route, in chunks of its cap (MARK_CHUNK). Neither writes a reading
   * event. ⚠️ No offline outbox: the outbox replays `/api/books/:id/progress` and a ghost has no book, so a
   * failure says so instead of pretending it will sync later. The caches are invalidated either way -- a
   * chunk that landed before a failure is still a change -- the books' too, because a number that landed
   * since the page loaded is marked on its chapter row by the server. Resolves to whether every chunk was
   * accepted.
   */
  const markGhosts = async (numbers: number[], completed: boolean): Promise<boolean> => {
    let ok = true;
    try {
      for (const chunk of chunkNumbers(numbers, MARK_CHUNK)) {
        await api(`/api/series/${id}/listing-progress`, { method: completed ? 'POST' : 'DELETE', json: { numbers: chunk } });
      }
    } catch {
      ok = false;
      toast(tr('Could not mark — try again when online'), 'error');
    }
    qc.invalidateQueries({ queryKey: ['series-listing', id] });
    qc.invalidateQueries({ queryKey: ['series-books', id] });
    qc.invalidateQueries({ queryKey: ['series', id] });
    qc.invalidateQueries({ queryKey: ['home'] });
    return ok;
  };
  const markGhost = async (number: number, completed: boolean) => {
    if (await markGhosts([number], completed)) toast(completed ? tr('Marked read') : tr('Marked unread'), 'success');
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
  // Deliberately the WHOLE list, not the group filter's subset: "Mark all read" is a statement about the
  // series, and a reader who filtered to one group to look at it did not thereby decide the other groups'
  // chapters are unread. Select mode is the way to mark a subset.
  // ⚠️ And the chapters on this server ONLY, never the grey rows (#69): a series listing 800 chapters would
  // otherwise tick all 800 with one tap -- and a contiguous run of ticks is exactly what the trackers are
  // told. Marking chapters the server does not hold is a choice made row by row or in select mode.
  // Reintroduce by adding the ghosts to `todo`: "Mark all read never touches the grey rows" in
  // seriesPage.test.ts fails.
  const markAllRead = async () => {
    const todo = (books?.content ?? []).filter((b) => !b.readProgress?.completed);
    if (!todo.length) { toast('Everything is already read', 'success'); return; }
    toast(`Marking ${todo.length} chapters read…`);
    await setRead(todo, true);
    toast(`Marked ${todo.length} chapters read`, 'success');
  };

  // The one download loop, for Save all offline and for Save offline in select mode: stops at the first
  // failure, because the usual cause is a full device and every further attempt would fail the same way.
  const saveOffline = async (todo: Book[]) => {
    toast(tr('Saving {n} chapters offline…', { n: todo.length }));
    let done = 0;
    for (const b of todo) {
      try {
        await downloadChapter(b.id);
        setDownloaded((s) => new Set(s).add(b.id));
        done++;
      } catch {
        toast(tr('Stopped — device storage may be full'), 'error');
        break;
      }
    }
    if (done) toast(tr('Saved {n} chapters offline', { n: done }), 'success');
  };
  const downloadAll = async () => {
    if (downloadingAll || !books) return;
    // A pruned chapter has no pages left on the server, so including it would "save" an empty chapter to
    // this device and then report it as downloaded. Skipped silently: it is not an error and there is
    // nothing the reader can do about it.
    const todo = books.content.filter((b) => !downloaded.has(b.id) && !b.pruned);
    if (!todo.length) { toast(tr('Everything is already saved offline'), 'success'); return; }
    setDownloadingAll(true);
    await saveOffline(todo);
    setDownloadingAll(false);
  };

  // ---- select mode -------------------------------------------------------------------------------
  const togglePickBook = (bookId: string) =>
    setPickedBooks((p) => { const n = new Set(p); n.has(bookId) ? n.delete(bookId) : n.add(bookId); return n; });
  const togglePickGhost = (number: number) =>
    setPickedGhosts((p) => { const n = new Set(p); n.has(number) ? n.delete(number) : n.add(number); return n; });
  const toggleGhosts = () => {
    const next = !showGhosts;
    setShowGhosts(next);
    try { localStorage.setItem(SHOW_GHOSTS_KEY, next ? 'on' : 'off'); } catch { /* private mode: the session still has it */ }
    // Rows that are no longer on screen cannot stay picked, or Fetch would act on what nobody can see.
    if (!next) setPickedGhosts(new Set());
  };
  // From the FILTERED lists: a pick the group filter has hidden is neither counted nor acted on, so the
  // toolbar's "{n} selected" is the number of rows the person can see ticked. The pick itself survives in
  // its set, and comes back when the filter is widened again.
  const pickedBookList = useMemo(() => filteredBooks.filter((b) => pickedBooks.has(b.id)), [filteredBooks, pickedBooks]);
  const pickedGhostList = useMemo(() => filteredGhosts.filter((g) => pickedGhosts.has(g.number)), [filteredGhosts, pickedGhosts]);
  // Each action's eligible subset. A button acts on its subset, never on the whole selection, and is
  // disabled when the subset is empty -- so picking three chapters and a ghost never makes Fetch try the
  // chapters. Mark read / Mark unread are the two that take BOTH kinds since #69 (bulkMark).
  const saveable = pickedBookList.filter((b) => !b.pruned && !downloaded.has(b.id));
  const fetchable = pickedGhostList.filter((g) => g.why !== 'blocked');
  const refetchable = pickedBookList.filter((b) => b.owned);
  // ⚠️ NOT filtered by `owned`. The server classifies each id and answers with a reason per skip, and the
  // toast below repeats it -- "3 skipped: not downloaded by Uchiyomi" is the one line that explains why a
  // hand-assembled library (86 % of the chapters on a real install) cannot be deleted from here. Filtering
  // here made that toast dead code: the ids never reached the server, and picking only such chapters
  // greyed the button out with no hint at all. Only tombstones are dropped, since there is no file to
  // delete and the server would say `already_pruned` for every one of them. Reintroduce by adding
  // `b.owned &&` back: pick a /library chapter and the delete says "0 deleted" -- or nothing.
  const deletable = pickedBookList.filter((b) => !b.pruned);
  const pickedCount = pickedBookList.length + pickedGhostList.length;

  const invalidateChapters = () => {
    for (const k of [['series-books', id], ['series-listing', id], ['series-versions', id], ['series-groups', id], ['series-scanlators', id], ['series', id], ['home'], ['source-jobs']]) qc.invalidateQueries({ queryKey: k });
  };
  // The picked chapters AND the picked grey rows (#69): select mode is how a reader who reads elsewhere ticks
  // a stretch of chapters this server never fetched. Two requests, one per kind, and one toast that counts
  // what was asked. A ghost failure has already said so (markGhosts), so only a clean run toasts success.
  // Reintroduce by marking `pickedBookList` alone: "select mode marks the grey rows too" in
  // seriesPage.test.ts fails.
  const bulkMark = async (completed: boolean) => {
    setActing(true);
    const n = pickedBookList.length + pickedGhostList.length;
    if (pickedBookList.length) await setRead(pickedBookList, completed);
    const ok = pickedGhostList.length ? await markGhosts(pickedGhostList.map((g) => g.number), completed) : true;
    if (ok) toast(completed ? tr('Marked {n} read', { n }) : tr('Marked {n} unread', { n }), 'success');
    setActing(false);
    leaveSelect();
  };
  const bulkSave = async () => {
    setActing(true);
    await saveOffline(saveable);
    setActing(false);
    leaveSelect();
  };
  // Fetch and Fetch again start a server job and return at once; the rows appear as the job lands them,
  // which is what the polling below is for.
  const startJob = async (path: string, body: Record<string, unknown>) => {
    setActing(true);
    try {
      const res = await api<{ folder: string; total: number }>(path, { method: 'POST', json: body });
      setStarted({ folder: res.folder, at: Date.now() });
      toast(tr('Fetching {n} chapters…', { n: res.total }), 'info');
      invalidateChapters();
      leaveSelect();
    } catch (e) {
      toast(msgOf(e, tr('Could not start.')), 'error');
    }
    setActing(false);
    setConfirming(null);
  };
  const bulkFetch = () => startJob('/api/sources/fetch', { seriesId: id, numbers: fetchable.map((g) => g.number) });
  // The fetch icon on one ghost row: the bar's Fetch for a list of one, same request, same toast, same
  // polling -- so a chapter arrives the same way whether it was picked alone or with twenty others.
  const fetchOne = (number: number) => startJob('/api/sources/fetch', { seriesId: id, numbers: [number] });
  /**
   * Poll the shared jobs key until the job for `folder` is no longer downloading; the job as last seen, or
   * null when the list no longer has it (over and aged out -- or, past the same five seconds `jobDone`
   * allows, never listed) or the server could not be asked three times running. Through `fetchQuery` so
   * the pill and the page's own 2 s poll read the same answer and the requests are deduped.
   */
  const awaitJob = async (folder: string): Promise<SourceJob | null> => {
    const at = Date.now();
    let misses = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const list = await qc.fetchQuery({ queryKey: ['source-jobs'], queryFn: () => api<{ content: SourceJob[] }>('/api/sources/jobs'), staleTime: 0 }).catch(() => null);
      if (!list) { if (++misses >= 3) return null; continue; }
      misses = 0;
      const job = list.content?.find((j) => j.folder === folder);
      if (job ? job.status !== 'downloading' : Date.now() - at > 5000) return job ?? null;
    }
  };
  // "Fetch all {n}" on an older-chapters run: the same request for the run's numbers, in chunks of at most
  // FETCH_CHUNK (the route's FILL_MAX_CHAPTERS), each posted only after the previous chunk's job has ENDED.
  // ⚠️ `startJob` returns when a job has started, not when it is done, and the route answers 409 `busy`
  // while the series' job runs: the first cut posted the chunks back to back, so on a run past 300 the
  // reader saw "Fetching 300 chapters…" and then one error toast per further chunk, and the rest was never
  // fetched. One toast for the whole run; the run stops at the first chunk that fails to start or whose job
  // ends in error, with that message. `acting` holds for the whole run, so the chip cannot be tapped into
  // a 409 of its own meanwhile.
  const fetchMany = async (numbers: number[]) => {
    const chunks = chunkNumbers(numbers);
    setActing(true);
    try {
      for (const [i, chunk] of chunks.entries()) {
        const res = await api<{ folder: string; total: number }>('/api/sources/fetch', { method: 'POST', json: { seriesId: id, numbers: chunk } });
        setStarted({ folder: res.folder, at: Date.now() });
        if (i === 0) {
          toast(tr('Fetching {n} chapters…', { n: numbers.length }), 'info');
          invalidateChapters();
          leaveSelect();
        }
        if (i === chunks.length - 1) break;
        const ended = await awaitJob(res.folder);
        if (ended?.status === 'error') { toast(ended.reason || tr('Fetch stopped. Try another source or wait.'), 'error'); break; }
      }
    } catch (e) {
      toast(msgOf(e, tr('Could not start.')), 'error');
    }
    setActing(false);
  };
  const bulkRefetch = () => startJob(`/api/admin/series/${id}/chapters/refetch`, { bookIds: refetchable.map((b) => b.id) });
  // "Fetch" on one copy in the chapter sheet. A pick names the copy by source and the source's own id (`copySourceId`, never
  // a split on ':'), and the server takes it as an explicit choice: the group rules, blocklist included, do
  // not apply to it. On a ghost row the copy lands as the chapter; on an on-disk row the file is replaced,
  // which is asked about first below.
  const pickGhost = (number: number, copy: VersionCopy) =>
    startJob('/api/sources/fetch', { seriesId: id, picks: [{ number, source: copy.source, sourceId: copySourceId(copy) }] });
  const [replacing, setReplacing] = useState<{ book: Book; copy: VersionCopy } | null>(null);
  const replaceWith = async () => {
    if (!replacing) return;
    await startJob(`/api/admin/series/${id}/chapters/refetch`, { picks: [{ bookId: replacing.book.id, source: replacing.copy.source, sourceId: copySourceId(replacing.copy) }] });
    setReplacing(null);
  };
  const bulkDelete = async () => {
    setActing(true);
    try {
      const res = await api<{ applied: number; skipped: { id: string; reason: string }[] }>(`/api/admin/series/${id}/chapters/delete`, {
        method: 'POST', json: { bookIds: deletable.map((b) => b.id) },
      });
      // Say what was skipped rather than silently deleting fewer than were selected, one line per reason
      // present: `not_owned` (the file is in a library the admin built, not one Uchiyomi fetched) and
      // `bookmarked` (a reader's bookmark names a page inside it) are the two a person can act on; the
      // rest -- `unlink_failed`, `outside_root`, `already_pruned` after a race -- are one line, because
      // the fix for all of them is the server log, not this page.
      const count = (reason: string) => res.skipped.filter((x) => x.reason === reason).length;
      const notOwned = count('not_owned');
      const bookmarked = count('bookmarked');
      const other = res.skipped.length - notOwned - bookmarked;
      const lines = [
        { n: notOwned, text: tr('{n} skipped: not downloaded by Uchiyomi', { n: notOwned }) },
        { n: bookmarked, text: tr('{n} skipped: bookmarked by a reader', { n: bookmarked }) },
        { n: other, text: tr('{n} could not be deleted', { n: other }) },
      ].filter((l) => l.n > 0);
      if (res.applied === 0 && lines.length) {
        // ⚠️ A delete that deleted nothing is not a success. A green "0 deleted" over unchanged rows was
        // what an unlink failure looked like; the dominant reason, in red, is what it looks like now.
        // Reintroduce by toasting "{n} deleted" unconditionally: pick a bookmarked chapter and delete it.
        // The other reasons still get their line (the docs promise one per reason), just not in red.
        const [head, ...rest] = lines.sort((a, b) => b.n - a.n);
        toast(head.text, 'error');
        for (const l of rest) toast(l.text, 'info');
      } else {
        toast(tr('{n} deleted', { n: res.applied }), 'success');
        for (const l of lines) toast(l.text, 'info');
      }
      invalidateChapters();
      leaveSelect();
    } catch (e) {
      toast(msgOf(e, tr('Could not delete those')), 'error');
    }
    setActing(false);
    setConfirming(null);
  };

  // While the job this page started is downloading, poll the shared jobs key every 2 s (the
  // FindMissingDialog pattern) and refresh the two chapter queries when it stops, so ghosts turn into rows
  // without a reload. ⚠️ `dataUpdatedAt` is compared against the moment the job started: the key is shared
  // with the downloads pill, so the first render after the POST sees that pill's CACHED list -- from before
  // the job existed -- and "the job is not in the list" would otherwise read as "the job has finished".
  const jobs = useQuery({
    queryKey: ['source-jobs'],
    queryFn: () => api<{ content: SourceJob[] }>('/api/sources/jobs'),
    enabled: !!started,
    refetchInterval: 2000,
  });
  const job = started ? jobs.data?.content?.find((j) => j.folder === started.folder) : undefined;
  const jobFresh = !!started && jobs.dataUpdatedAt >= started.at;
  // A fresh list without the job means it is over and has aged out -- or a poll that was already in flight
  // when the POST landed answered without it. Five seconds tells those apart: a job that has not appeared
  // by then is not going to. (`Date.now()` here is re-evaluated on every 2 s poll, which is what makes it
  // a clock rather than a constant.)
  const jobDone = jobFresh && (job ? job.status !== 'downloading' : Date.now() - started.at > 5000);
  useEffect(() => {
    if (!jobDone) return;
    setStarted(null);
    qc.invalidateQueries({ queryKey: ['series-books', id] });
    qc.invalidateQueries({ queryKey: ['series-listing', id] });
    // The versions' `onDisk` marker and the groups' `{n} on this server` both count the files that just landed.
    qc.invalidateQueries({ queryKey: ['series-versions', id] });
    qc.invalidateQueries({ queryKey: ['series-groups', id] });
    qc.invalidateQueries({ queryKey: ['series-scanlators', id] });
    qc.invalidateQueries({ queryKey: ['series', id] });
    qc.invalidateQueries({ queryKey: ['home'] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobDone]);

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

  // A "Nothing yet" series: added with no chapters, the older run under its floor is the page's only
  // content and the ☁ on those rows the call to action. Nothing to read, nothing to save offline.
  const nothingYet = !!series && series.booksCount === 0;
  const Actions = (
    <div className="mt-4 flex flex-col gap-2">
      <button onClick={() => resumeBook && router.push(`/reader/?book=${resumeBook.id}`)} disabled={nothingYet || !resumeBook} className="btn-accent w-full disabled:opacity-50">
        <IcPlay width={18} height={18} /> {nothingYet ? tr('Nothing to read yet') : inProgress ? tr('Continue') : tr('Start reading')}
      </button>
      {/*
        Which chapter that button opens. "Continue" on its own is a promise with no subject: on a long
        series there is no way to tell whether it resumes the chapter you were part-way through, moves on
        to the next unread one, or drops you at the top -- and those differ precisely when it matters.
      */}
      {!nothingYet && resumeBook && (
        <p className="-mt-1 truncate text-center text-xs text-fog-500">
          {resumeBook.readProgress && !resumeBook.readProgress.completed && resumeBook.media?.pagesCount
            ? tr('{chapter} · page {page} of {pages}', {
                chapter: [chapterLabel(resumeBook), chapterName(resumeBook)].filter(Boolean).join(' · '),
                page: resumeBook.readProgress.page ?? 1,
                pages: resumeBook.media.pagesCount,
              })
            : [chapterLabel(resumeBook), chapterName(resumeBook)].filter(Boolean).join(' · ')}
        </p>
      )}
      <div className="flex gap-2">
        <button onClick={toggleFav} className={`flex flex-1 items-center justify-center gap-2 rounded-full border py-3 text-sm ${fav ? 'border-accent/50 bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>
          <IcHeart width={18} height={18} fill={fav ? 'currentColor' : 'none'} stroke={fav ? 'none' : 'currentColor'} /> {fav ? 'Saved' : 'Favorite'}
        </button>
        {/* "Save all offline", not "Download all": this copies to THIS DEVICE; the server side is Fetch (☁).
            Never on Uchiyomi Desktop, where this device IS the server (lib/desktop.ts). */}
        {!nothingYet && !isDesktop() && (
          <button onClick={downloadAll} disabled={downloadingAll} className="flex flex-1 items-center justify-center gap-2 rounded-full border border-ink-700 py-3 text-sm text-fog-300 disabled:opacity-50">
            <IcDownload width={18} height={18} /> {downloadingAll ? tr('Saving…') : tr('Save all offline')}
          </button>
        )}
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
    // "{n} behind" used to sit here; the supply line under the title carries that count now ("4 not here
    // yet"), with the source and the groups beside it, and one line saying it is enough.
    updatedAt ? <>{tr('Updated {ago}', { ago: relativeTime(updatedAt) })}</> : null,
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

  // How many of the Filter sheet's two choices are off their default; the chip wears the number.
  const activeFilters = (group !== ALL_GROUPS ? 1 : 0) + (showGhosts ? 0 : 1);
  const Chapters = (
    <div>
      {/* The heading on its own line and ONE row of four short, text-only chips under it. Measured at
          390 px: with icons and the two long chips this was five chips on two rows plus two sentences;
          the four fit one row in English, and `flex-wrap` (never nowrap) is the safety valve for German
          -- a nowrap row past the viewport is the 1-pixel horizontal scroll the layout check flags. */}
      <div className="mb-2 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <h2 className="font-display text-lg font-semibold">{tr('Chapters')}</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <button onClick={markAllRead} className="chip text-xs">{tr('Mark all read')}</button>
          <button onClick={() => setAsc((a) => !a)} className="chip text-xs">{asc ? tr('Oldest') : tr('Newest')}</button>
          {/* The group filter and the ghost switch live in a sheet; the count of active choices is a tiny
              badge on the chip, not ` · {n}` text, which is what pushed the row past 358 px. Rendered only
              when there is something to filter by. */}
          {(groupNames.length > 0 || ghosts.length > 0) && (
            <button onClick={() => setFilterOpen(true)} aria-haspopup="dialog" className={`chip relative text-xs ${activeFilters > 0 ? 'chip-active' : ''}`}>
              {tr('Filter')}
              {activeFilters > 0 && (
                <span data-testid="filter-count" className="absolute -end-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-bold leading-none text-black">{activeFilters}</span>
              )}
            </button>
          )}
          {/* A mode, not a filter: the library's chip, so the two select modes are one habit. */}
          <button onClick={() => { setSelecting((v) => !v); clearPicks(); }} className={`chip text-xs whitespace-nowrap ${selecting ? 'chip-active' : ''}`}>
            {selecting ? tr('Done') : tr('Select')}
          </button>
        </div>
      </div>
      {group !== ALL_GROUPS && (
        <p className="mb-2 text-xs text-fog-500">
          {tr('{n} of {m} chapters match', { n: filteredBooks.length + filteredGhosts.length, m: allBooks.length + visibleGhosts.length })}
        </p>
      )}
      <div className="lg:grid lg:gap-x-8 lg:[grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
        {rows.map((r) => {
          if (r.kind === 'book') {
            const b = r.book;
            return (
              <ChapterRow key={b.id} book={b} downloaded={downloaded.has(b.id)} sourceNames={sourceNames} primarySource={primarySource}
                onReader={() => router.push(`/reader/?book=${b.id}`)} onToggleDownload={() => toggleDownload(b.id)}
                onMark={(mode) => markChapter(b, mode)}
                onEdit={isAdmin ? () => setEditChapter(b) : undefined}
                selectable={selecting} selected={pickedBooks.has(b.id)} onToggle={() => togglePickBook(b.id)}
                versions={versionsOf.get(b.number)?.length}
                onVersions={versionsOf.has(b.number) ? () => setChapterSheet({ number: b.number, book: b }) : undefined} />
            );
          }
          if (r.kind === 'ghost') {
            return (
              <GhostRow key={`g${r.ghost.number}`} ghost={r.ghost} sourceNames={sourceNames} primarySource={primarySource}
                selectable={selecting} selected={pickedGhosts.has(r.ghost.number)} onToggle={() => togglePickGhost(r.ghost.number)}
                onOpen={() => setChapterSheet({ number: r.ghost.number, ghost: r.ghost })}
                // Same audience and same exclusion as the bar's Fetch (`fetchable`): a row only blocked
                // groups released cannot be fetched while the block stands, so it gets no button.
                onFetch={canDownload(user) && r.ghost.why !== 'blocked' ? () => fetchOne(r.ghost.number) : undefined}
                onMark={(completed) => markGhost(r.ghost.number, completed)} />
            );
          }
          if (r.kind === 'run') {
            // One line for the whole stretch below the Latest-N floor, with Show/Hide to unfold it into
            // ordinary ghost rows (each with its ☁ and its sheet) and, for a viewer who may download,
            // "Fetch all {n}" for the whole stretch at once -- Find missing chapters is refused below three
            // chapters, so a "Nothing yet" series had no bulk way to its older chapters. The sentence
            // itself (range or single number, plural or singular) is `runLabel`'s, where a test can reach
            // it. `lg:col-span-full` because on a desktop the list is an auto-fill grid and a sentence in
            // one 250 px cell wrapped to two lines while the "Show all" row below it already spanned the row.
            const { key, args } = runLabel(r);
            // The run's own numbers, from the same filtered list the row was built from, so "Fetch all 5"
            // fetches the five the sentence counts and not a sixth the group filter hid.
            const numbers = filteredGhosts.filter((g) => g.why === 'floor' && g.number >= r.from && g.number <= r.to && !haveNumbers.has(g.number)).map((g) => g.number);
            return (
              <div key={`run${r.from}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-ink-800/70 py-2.5 text-xs text-fog-500 lg:col-span-full">
                <span className="me-auto">{tr(key, args)}</span>
                {/* The two chips travel together: when the sentence leaves no room they wrap as one pair to
                    the end of the next line, not one chip after the sentence and one orphaned below. */}
                <span className="ms-auto flex shrink-0 gap-1.5">
                  <button type="button" onClick={() => toggleRun(r.from, numbers)} aria-expanded={r.open} className={`chip shrink-0 px-2.5 py-1 text-[11px] ${r.open ? 'chip-active' : ''}`}>
                    {r.open ? tr('Hide') : tr('Show')}
                  </button>
                  {canDownload(user) && numbers.length > 0 && (
                    <button type="button" onClick={() => fetchMany(numbers)} disabled={acting} className="chip shrink-0 px-2.5 py-1 text-[11px] disabled:opacity-50">
                      <IcCloudDownload width={14} height={14} />{tr('Fetch all {n}', { n: numbers.length })}
                    </button>
                  )}
                </span>
              </div>
            );
          }
          return (
            <div key="more" className="flex items-center justify-center py-2.5 lg:col-span-full">
              <button type="button" onClick={() => setShowAll(true)} className="chip text-xs">{tr('Show all {n}', { n: r.hidden + GHOST_CAP })}</button>
            </div>
          );
        })}
        {!books && Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton my-3 h-6 rounded" />)}
      </div>
    </div>
  );

  // The library's toolbar, verbatim in shape: fixed ABOVE the bottom nav, safe-area padded, one row that
  // wraps. Every button is disabled when its subset is empty rather than hidden, so the row does not
  // reflow as the selection changes; the two admin buttons and Fetch are hidden outside their audience.
  //
  // ⚠️ `bottom-0` here puts the bar UNDER the phone nav, not over it. This renders inside AppShell's
  // `<main class="relative z-[1]">`, which is its own stacking context, while <BottomNav> is main's sibling
  // at z-40 in the root context -- so whatever z-index this div carries, the nav paints on top of it. With
  // seven chips wrapping to three rows at 390 px, Fetch, Fetch again, Delete from server and Cancel all sat
  // behind the nav and elementFromPoint returned the nav for every one of them. On phones the bar therefore
  // sits at the nav's top edge: 5.75rem plus the safe-area inset (the nav measures 92 px at 390 px; the
  // Sheet's 5.5rem `overBottomNav` value tucks under the bar's own bottom padding and would overlap by 4 px
  // here). From lg up the nav is hidden and the bar goes back to the bottom. Reintroduce by changing the
  // bottom class back to `bottom-0` and picking every row on a phone: only the first row of chips is
  // tappable.
  const Toolbar = selecting && pickedCount > 0 && (
    <div className="fixed inset-x-0 bottom-[calc(5.75rem+env(safe-area-inset-bottom))] z-40 border-t border-ink-700 bg-ink-950/95 px-4 pb-3 pt-3 backdrop-blur-xl lg:bottom-0 lg:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {/* pe-36 on phones keeps the chips clear of the downloads pill (fixed bottom-20 end-3), which floats
          over this bar's lower band while a source job is running. */}
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2 pe-36 lg:pe-0">
        <span className="me-auto text-sm font-medium text-fog-100">{acting ? '…' : tr('{n} selected', { n: pickedCount })}</span>
        <button disabled={acting || !pickedCount} onClick={() => bulkMark(true)} className="chip text-xs disabled:opacity-50">{tr('Mark read')}</button>
        <button disabled={acting || !pickedCount} onClick={() => bulkMark(false)} className="chip text-xs disabled:opacity-50">{tr('Mark unread')}</button>
        {/* The two icons say which side each acts on: ⬇ this device, ☁ the server. */}
        {!isDesktop() && <button disabled={acting || !saveable.length} onClick={bulkSave} className="chip text-xs disabled:opacity-50"><IcDownload width={14} height={14} />{tr('Save offline')}</button>}
        {canDownload(user) && <button disabled={acting || !fetchable.length} onClick={bulkFetch} className="chip text-xs disabled:opacity-50"><IcCloudDownload width={14} height={14} />{tr('Fetch')}</button>}
        {isAdmin && <button disabled={acting || !refetchable.length} onClick={() => setConfirming('refetch')} className="chip text-xs disabled:opacity-50"><IcCloudDownload width={14} height={14} />{tr('Fetch again')}</button>}
        {isAdmin && <button disabled={acting || !deletable.length} onClick={() => setConfirming('delete')} className="chip text-xs text-rose-300 disabled:opacity-50">{tr('Delete from server')}</button>}
        <button disabled={acting} onClick={leaveSelect} className="chip text-xs text-fog-500 disabled:opacity-50">{tr('Cancel')}</button>
      </div>
    </div>
  );

  // Room under the last rows while the bar is up: on a phone that is the bar (three rows of chips at
  // 390 px) plus the nav it now sits on, so pb-24 left the last two chapters unreachable.
  return (
    <div className={`min-h-screen-d ${Toolbar ? 'pb-40 lg:pb-24' : ''}`}>
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
          {/* The supply line, phone form: under the title block, full width, before the actions. The desktop
              form is the first row of the right column (the title block over the banner is
              `pointer-events-none`, so a button cannot live there). */}
          <div className="mt-3 lg:hidden"><SupplyLine parts={supplyPhone} loaded={supplyLoaded} wide={false} onOpen={() => setSourcesOpen(true)} /></div>
          {Actions}
        </div>

        {/* info + chapters */}
        <div className="mt-7 flex flex-col gap-4 lg:mt-4">
          <div className="hidden lg:block"><SupplyLine parts={supplyWide} loaded={supplyLoaded} wide onOpen={() => setSourcesOpen(true)} /></div>
          {Genres}
          {Summary}
          {Chapters}
        </div>
      </div>

      {/* The sheets. One at a time (see the state above); each closes itself before anything else opens. */}
      {sourcesOpen && (
        <SourcesSheet id={id} series={series} groups={groups} admin={adminGroups} error={groupsError} isLoading={groupsLoading} haveNumbers={liveNumbers}
          checkedAt={supplyChecked}
          onSaved={() => { for (const k of [['series', id], ['series-books', id], ['home'], ['library']]) qc.invalidateQueries({ queryKey: k }); }}
          onClose={() => setSourcesOpen(false)}
          onExplain={() => { setSourcesOpen(false); setExplaining(true); }}
          onFindMissing={() => { setSourcesOpen(false); setFindingMissing(true); }} />
      )}
      {explaining && <SourcesExplainer onClose={() => { setExplaining(false); setSourcesOpen(true); }} />}
      {filterOpen && (
        <ChapterFilterSheet groupNames={groupNames} group={group} onGroup={setGroup} hasGhosts={ghosts.length > 0}
          showGhosts={showGhosts} onToggleGhosts={toggleGhosts} onClose={() => setFilterOpen(false)} />
      )}
      {chapterSheet && (
        <ChapterVersionsSheet number={chapterSheet.number} ghost={chapterSheet.ghost} book={chapterSheet.book}
          copies={versionsOf.get(chapterSheet.number) ?? []} sourceNames={sourceNames} isAdmin={isAdmin}
          mayFetch={!!chapterSheet.ghost && canDownload(user)}
          // Replacing a file on the server is an admin's call: it changes what everyone reads -- and only a
          // file Uchiyomi downloaded can be replaced (`refetchable` above draws the same line): the server
          // answers `not_owned` for a /library file, so offering the button on one meant a danger dialog
          // followed by "none of those chapters can be fetched again". `!== false`, not `=== true`: `owned`
          // is absent on a server older than the field, and absent is not "no".
          mayReplace={!!chapterSheet.book && isAdmin && chapterSheet.book.owned !== false}
          onFetch={(copy) => { const n = chapterSheet.number; setChapterSheet(null); void (copy ? pickGhost(n, copy) : fetchOne(n)); }}
          // ⚠️ The sheet closes FIRST, then the confirm opens: a Modal under a Sheet cannot be tapped.
          onReplace={(copy) => { const b = chapterSheet.book!; setChapterSheet(null); setReplacing({ book: b, copy }); }}
          onClose={() => setChapterSheet(null)} />
      )}

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
      {Toolbar}
      {confirming === 'delete' && (
        <ConfirmDialog
          title={tr('Delete {n} chapters from the server?', { n: deletable.length })}
          danger
          busy={acting}
          confirmLabel={tr('Delete from server')}
          body={
            <>
              <p>{tr('The files are deleted from the server. The chapters stay listed and everyone keeps their reading history, but anyone partway through one loses their place.')}</p>
              {/* The two skips the server applies for the same reasons the scheduled cleanup does, said
                  before the click rather than only in the toast after it. */}
              <p className="mt-2">{tr('A chapter somebody has bookmarked, and a chapter in a library you assembled yourself, is skipped.')}</p>
              <p className="mt-2">{tr('Fetch again brings a chapter back.')}</p>
            </>
          }
          onConfirm={bulkDelete}
          onClose={() => setConfirming(null)}
        />
      )}
      {confirming === 'refetch' && (
        <ConfirmDialog
          title={tr('Fetch {n} chapters again?', { n: refetchable.length })}
          danger
          busy={acting}
          confirmLabel={tr('Fetch again')}
          body={<p>{tr('Each file is replaced with the copy the translation rules choose now. A different group’s copy may have a different page count, so reading positions inside the chapter may shift.')}</p>}
          onConfirm={bulkRefetch}
          onClose={() => setConfirming(null)}
        />
      )}
      {replacing && (
        <ConfirmDialog
          title={tr('Replace with this version?')}
          danger
          busy={acting}
          confirmLabel={tr('Replace')}
          // A tombstone has no file to set aside -- the cleanup already deleted it -- and a sentence that
          // says one is set aside on a row that reads "Deleted from the server" contradicts the row.
          body={<p>{replacing.book.pruned
            ? tr('The chapter was deleted from the server; this copy is downloaded onto the same row and everyone’s progress stays.')
            : tr('The current file is set aside and this copy is downloaded onto the same row. Everyone’s progress stays; the page count may differ.')}</p>}
          onConfirm={replaceWith}
          onClose={() => setReplacing(null)}
        />
      )}

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
