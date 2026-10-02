'use client';
import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { PageTile } from '@/components/PageTile';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/components/Toast';
import { Modal } from '@/components/ConfirmDialog';
import { ART } from '@/lib/art';
import { IcChevronLeft, IcX, IcTrash, IcPlus, IcPencil } from '@/components/icons';
import { t as tr } from '@/lib/i18n';

interface Bookmark {
  book_id: string; series_id: string; page: number; note: string | null; created_at: string;
  book_title: string; number: string | null; series_title: string;
}
interface Note {
  id: string; series_id: string; book_id: string | null; body: string; updated_at: string;
  series_title: string; book_title: string | null; number: string | null;
}

export default function MomentsPage() {
  // `useSearchParams` in a statically exported app must sit under a Suspense boundary or `next build`
  // fails outright -- the same wrapper every other query-param page in this app carries.
  return (
    <Suspense fallback={<div className="px-4 pt-16"><div className="skeleton h-40 rounded-2xl" /></div>}>
      <Moments />
    </Suspense>
  );
}

function Moments() {
  const router = useRouter();
  const sp = useSearchParams();
  const seriesId = sp.get('series') || '';
  const qs = seriesId ? `?seriesId=${encodeURIComponent(seriesId)}` : '';
  const qc = useQueryClient();
  const toast = useToast();

  const { data: bm, isLoading: loadingMarks } = useQuery({
    queryKey: ['bookmarks', seriesId],
    queryFn: () => api<{ content: Bookmark[] }>(`/api/bookmarks${qs}`),
  });
  const { data: nt, isLoading: loadingNotes } = useQuery({
    queryKey: ['notes', seriesId],
    queryFn: () => api<{ content: Note[] }>(`/api/notes${qs}`),
  });

  const marks = bm?.content ?? [];
  const notes = nt?.content ?? [];
  const loading = loadingMarks || loadingNotes;

  // Group saved pages by series, newest series first (the API already returns newest-first, so first
  // appearance is the right order and no sort is needed).
  const groups = useMemo(() => {
    const out: Array<{ id: string; title: string; items: Bookmark[] }> = [];
    for (const m of marks) {
      const g = out.find((x) => x.id === m.series_id);
      if (g) g.items.push(m);
      else out.push({ id: m.series_id, title: m.series_title || tr('Unknown series'), items: [m] });
    }
    return out;
  }, [marks]);

  const filterTitle = seriesId
    ? groups[0]?.title || notes.find((n) => n.series_id === seriesId)?.series_title || ''
    : '';

  // Confirmed, unlike the single-chapter delete on /downloads. That one throws away bytes you can fetch
  // again; this throws away something you wrote, and nothing else in the app can bring it back.
  const del = useMutation({
    mutationFn: (id: string) => api(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => { toast(tr('Note deleted'), 'success'); qc.invalidateQueries({ queryKey: ['notes'] }); },
    onError: () => toast(tr('Could not delete that note'), 'error'),
  });
  const confirmDelete = (id: string) => {
    if (!window.confirm(tr('Delete this note? This cannot be undone.'))) return;
    del.mutate(id);
  };

  // Un-saving a page. `DELETE /api/bookmarks/:bookId/:page` has existed since the first commit with the
  // reader's star as its only caller, so a page saved by a mis-tap could be un-saved only by navigating
  // back to that exact page of that exact chapter and tapping the star again -- on the one screen that
  // exists to show you your saved pages.
  //
  // Confirmed ONLY when a note is attached, which is the same rule the note delete above states: a bare
  // bookmark costs one tap to recreate, so a dialog on every removal is friction for nothing, but a note
  // is something you wrote and deleting the page deletes it with no way back.
  const unsave = useMutation({
    mutationFn: (m: Bookmark) =>
      api(`/api/bookmarks/${encodeURIComponent(m.book_id)}/${m.page}`, { method: 'DELETE' }),
    onSuccess: () => { toast(tr('Removed from Moments'), 'success'); qc.invalidateQueries({ queryKey: ['bookmarks'] }); },
    onError: () => toast(tr('Could not remove that page'), 'error'),
  });
  const confirmUnsave = (m: Bookmark) => {
    if (m.note && !window.confirm(tr('Remove this page? The note on it goes too, and that cannot be undone.'))) return;
    unsave.mutate(m);
  };

  // `PUT /api/bookmarks/:bookId/:page` has always accepted a note; nothing in the app ever sent one, so the
  // caption on a tile could render a note that was impossible to create. This is the missing half.
  const [editing, setEditing] = useState<Bookmark | null>(null);

  const empty = !loading && !marks.length && !notes.length;

  return (
    <div className="min-h-screen-d">
      <header className="safe-top flex items-center gap-2 px-4 pb-2 lg:px-0 lg:pt-6">
        <button onClick={() => router.back()} aria-label={tr('Back')}
          className="grid h-10 w-10 place-items-center rounded-full bg-ink-800/70 text-fog-100">
          <IcChevronLeft width={22} height={22} />
        </button>
        <h1 className="font-display text-2xl font-bold lg:text-3xl">{tr('Moments')}</h1>
        {seriesId && (
          <Link href="/moments" className="chip ms-auto inline-flex items-center gap-1 text-xs">
            <span className="max-w-[9rem] truncate">{filterTitle || tr('This series')}</span>
            <IcX width={12} height={12} />
          </Link>
        )}
      </header>

      {/* Above the branch below, not inside it: a series can have notes without a single saved page, and a
          composer that only appears once something else is already there can never write the first one. */}
      {seriesId && !loading && <div className="px-4 lg:px-0"><NoteComposer seriesId={seriesId} /></div>}

      {loading ? (
        <div className="grid grid-cols-3 gap-x-3 gap-y-5 px-4 pt-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 lg:px-0 xl:grid-cols-8">
          {Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton aspect-[2/3] rounded-2xl" />)}
        </div>
      ) : empty ? (
        <EmptyState art={ART.emptyUpdates} title={tr('No moments yet')}
          sub={tr('Tap the bookmark in the reader to save a page. Saved pages show up here as the panel itself.')}
          cta={{ href: '/library', label: tr('Browse library') }} />
      ) : (
        <div className="px-4 pb-10 pt-2 lg:px-0">
          {notes.length > 0 && (
            <section className="mb-6">
              <h2 className="py-2 text-xs font-semibold uppercase tracking-widest text-fog-500">{tr('Notes')}</h2>
              <div className="card divide-y divide-ink-800/70 overflow-hidden">
                {notes.map((n) => (
                  <div key={n.id} className="flex items-start gap-3 px-3.5 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="whitespace-pre-wrap text-sm text-fog-100">{n.body}</p>
                      <p className="mt-1 truncate text-[11px] text-fog-500">
                        <Link href={`/series/?id=${n.series_id}`} className="hover:text-fog-300">{n.series_title}</Link>
                        <span className="text-fog-600"> · {relativeTime(n.updated_at)}</span>
                      </p>
                    </div>
                    <button onClick={() => confirmDelete(n.id)} aria-label={tr('Delete note')}
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-fog-500 hover:bg-ink-800 hover:text-rose-400">
                      <IcTrash width={14} height={14} />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {groups.map((g) => (
            <section key={g.id} className="mb-6">
              <h2 className="flex items-baseline gap-2 py-2">
                {/* `min-w-0` or the truncate does nothing: a flex item's default min-width is its
                    min-content, so a long series title refuses to shrink and shoves the count off-screen. */}
                <Link href={`/series/?id=${g.id}`}
                  className="min-w-0 truncate font-display text-base font-semibold text-fog-100 hover:text-white">{g.title}</Link>
                <span className="shrink-0 text-[11px] text-fog-500">{g.items.length === 1 ? tr('1 saved') : tr('{n} saved', { n: g.items.length })}</span>
              </h2>
              <div className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
                {g.items.map((m) => (
                  <div key={`${m.book_id}:${m.page}`} className="relative">
                    <PageTile bookId={m.book_id} page={m.page}
                      chapter={m.number} note={m.note} seriesTitle={m.series_title} />
                    {/* Over the tile rather than inside PageTile: the tile is one big link, and a button
                        nested in an <a> is not a valid or clickable control. */}
                    <button onClick={() => setEditing(m)} aria-label={m.note ? tr('Edit note') : tr('Add a note')}
                      className="absolute end-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-full bg-black/55 text-white/85 backdrop-blur transition hover:bg-black/75 hover:text-white">
                      <IcPencil width={13} height={13} />
                    </button>
                    <button onClick={() => confirmUnsave(m)} disabled={unsave.isPending}
                      aria-label={tr('Remove from Moments')}
                      className="absolute end-1.5 top-10 grid h-7 w-7 place-items-center rounded-full bg-black/55 text-white/85 backdrop-blur transition hover:bg-black/75 hover:text-white disabled:opacity-40">
                      <IcTrash width={13} height={13} />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {editing && (
        <PageNoteEditor mark={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

/** The note that rides along with one saved page. */
function PageNoteEditor({ mark, onClose }: { mark: Bookmark; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [body, setBody] = useState(mark.note ?? '');
  const save = useMutation({
    // An empty box clears the note rather than storing '', which is what the route's `nullish()` is for.
    mutationFn: () => api(`/api/bookmarks/${encodeURIComponent(mark.book_id)}/${mark.page}`,
      { method: 'PUT', json: { note: body.trim() || null } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['bookmarks'] }); onClose(); },
    onError: () => toast(tr('Could not save that note'), 'error'),
  });
  return (
    <Modal title={tr('Note on this page')} onClose={onClose}>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={500}
        placeholder={tr('What do you want to remember?')} className="field w-full resize-y text-sm" />
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onClose} className="chip text-xs text-fog-500">{tr('Cancel')}</button>
        <button disabled={save.isPending} onClick={() => save.mutate()}
          className="btn-accent text-xs disabled:opacity-50">{tr('Save')}</button>
      </div>
    </Modal>
  );
}

/** Series-level note composer. Only shown on a filtered view, because a note needs a series to belong to. */
function NoteComposer({ seriesId }: { seriesId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const add = useMutation({
    mutationFn: () => api('/api/notes', { method: 'POST', json: { seriesId, body } }),
    onSuccess: () => { setBody(''); setOpen(false); qc.invalidateQueries({ queryKey: ['notes'] }); },
    // Keeps the draft in the box on failure, so a rejected write does not also lose what was typed.
    onError: () => toast(tr('Could not save that note'), 'error'),
  });

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="chip mt-2 inline-flex items-center gap-1.5 text-xs">
        <IcPlus width={13} height={13} />{tr('Add a note')}
      </button>
    );
  }
  return (
    <div className="card mt-2 p-3">
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={4000}
        placeholder={tr('What do you want to remember?')} className="field w-full resize-y text-sm" />
      <div className="mt-2 flex justify-end gap-2">
        <button onClick={() => { setOpen(false); setBody(''); }} className="chip text-xs text-fog-500">{tr('Cancel')}</button>
        <button disabled={!body.trim() || add.isPending} onClick={() => add.mutate()}
          className="btn-accent text-xs disabled:opacity-50">{tr('Save')}</button>
      </div>
    </div>
  );
}
