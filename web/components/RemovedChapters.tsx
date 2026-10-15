'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { Modal, msgOf } from './ConfirmDialog';
import { useToast } from './Toast';

/** The chapter numbers an admin removed from a series, and the way back: Restore one, or all. */
export function useRemovedChapters(id: string, enabled = true) {
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const removed = useQuery({
    queryKey: ['series-removed', id], enabled,
    queryFn: () => api<{ numbers: number[] }>(`/api/admin/series/${id}/chapters/removed`),
  });
  const restore = async (body: { numbers: number[] } | { all: true }) => {
    setBusy(true);
    try {
      await api(`/api/admin/series/${id}/chapters/restore`, { method: 'POST', json: body });
      toast(tr('Restored. The chapter is listed again at the next check.'), 'success');
      for (const k of ['series-removed', 'series-listing', 'series-books', 'series']) qc.invalidateQueries({ queryKey: [k, id] });
      for (const k of ['library', 'home']) qc.invalidateQueries({ queryKey: [k] });
    } catch (e) { toast(msgOf(e, tr('Could not restore that')), 'error'); }
    setBusy(false);
  };
  return { numbers: removed.data?.numbers ?? [], busy, restore };
}

/** The list itself: a row per removed chapter with its Restore, and Restore all under it. */
export function RemovedList({ numbers, busy, restore }: { numbers: number[]; busy: boolean; restore: (b: { numbers: number[] } | { all: true }) => Promise<void> }) {
  return (
    <>
      <ul className="divide-y divide-ink-700/60">
        {numbers.map((n) => (
          <li key={n} className="flex items-center gap-2 py-1.5 text-sm">
            <span className="min-w-0 flex-1 truncate text-fog-100">{tr('Chapter {n}', { n })}</span>
            <button type="button" disabled={busy} onClick={() => void restore({ numbers: [n] })} aria-label={`${tr('Restore')} ${tr('Chapter {n}', { n })}`} className="btn-key shrink-0 text-xs">
              {tr('Restore')}
            </button>
          </li>
        ))}
      </ul>
      {numbers.length > 1 && (
        <button type="button" disabled={busy} onClick={() => void restore({ all: true })} className="btn-key mt-2">{tr('Restore all')}</button>
      )}
    </>
  );
}

/**
 * "Removed chapters (N)…" on the series page: what Remove from series blocked, one tap from where it was done. Closes
 * itself once the last one is restored.
 */
export function RemovedChaptersDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { numbers, busy, restore } = useRemovedChapters(id);
  return (
    <Modal title={tr('Removed chapters')} onClose={onClose}>
      <p className="text-sm text-fog-300">{tr('Chapters you removed from this series. They are not listed or fetched. Restore one to let the next check list it again.')}</p>
      <div className="mt-3 max-h-[50vh] overflow-y-auto" data-lenis-prevent data-removed-dialog><RemovedList numbers={numbers} busy={busy} restore={restore} /></div>
      <div className="mt-5 flex justify-end"><button type="button" className="btn-key" onClick={onClose}>{tr('Close')}</button></div>
    </Modal>
  );
}
