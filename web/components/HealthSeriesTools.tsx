'use client';
// The few keys a series' own card on Health (components/HealthBySeries.tsx) carries beside its rows: find the missing
// chapters, write the details by hand, and remove the series from the library. Each opens the series page's own dialog
// right on the Health page, instead of walking off to the series.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Series } from '@/lib/types';
import { t as tr } from '@/lib/i18n';
import { FindMissingDialog } from '@/components/FindMissingDialog';
import { SeriesEditor } from '@/components/SeriesEditor';
import { ConfirmDialog, msgOf } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';

/** Health's "Find missing chapters": the series page's dialog, opened on the Health page. */
export function FindMissingLink({ id, className }: { id: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const close = () => {
    setOpen(false);
    for (const k of [['series', id], ['series-books', id], ['series-listing', id], ['admin-health']]) qc.invalidateQueries({ queryKey: k });
  };
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>{tr('Find missing chapters')}{' '}›</button>
      {open && <FindMissingDialog seriesId={id} onClose={close} />}
    </>
  );
}

function EditorHost({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: series } = useQuery({ queryKey: ['series', id], queryFn: () => api<Series>(`/api/series/${id}`) });
  if (!series) return null;
  return (
    <SeriesEditor id={id} series={series} tab="details" onClose={onClose}
      onSaved={() => { for (const k of [['series', id], ['admin-health'], ['home'], ['library']]) qc.invalidateQueries({ queryKey: k }); }} />
  );
}

/** "Add details by hand" (a series missing its description or genres) and "Remove from library" (hidden; no files are deleted). */
export function SeriesRowTools({ id, title, details, className }: { id: string; title: string; details?: boolean; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const remove = async () => {
    setBusy(true);
    try {
      await api(`/api/admin/series/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast(tr('Series removed from the library'), 'success');
      setRemoving(false);
      for (const k of [['admin-health'], ['health-summary'], ['home'], ['library']]) qc.invalidateQueries({ queryKey: k });
    } catch (e) { toast(msgOf(e, tr('Could not remove it')), 'error'); }
    setBusy(false);
  };
  return (
    <>
      {details && <button type="button" className={className} onClick={() => setEditing(true)}>{tr('Add details by hand')}{' '}›</button>}
      <button type="button" className={className} onClick={() => setRemoving(true)}>{tr('Remove from library')}{' '}›</button>
      {editing && <EditorHost id={id} onClose={() => setEditing(false)} />}
      {removing && (
        <ConfirmDialog title={tr('Remove from library?')} danger busy={busy} confirmLabel={tr('Remove')}
          body={(
            <>
              <p><strong className="text-fog-100">{tr('No files are deleted.')}</strong>{' '}{tr('The chapters stay exactly where they are on disk, and nothing in your library folder is touched.')}</p>
              <p className="mt-2">{title}</p>
              <p className="mt-2">{tr('Everyone’s reading progress, history, favourites and ratings are kept, so you can put it back at any time from Admin → Library, or just add it again.')}</p>
            </>
          )}
          onConfirm={remove} onClose={() => setRemoving(false)} />
      )}
    </>
  );
}
