'use client';
// Show hidden chapters (#240 by @Squeaks72, rebuilt to hide only): the chapter numbers an admin hid from a series, what
// each one is, and the way back. A hidden number is gone from every surface, for everyone, and never downloaded -- and
// nothing of it is deleted (bff lib/hiddenChapters.ts) -- so Restore needs nothing but this list: the chapters it held,
// their reading progress and its grey row are all back on the next request.
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { chapterLabel } from '@/lib/format';
import { Modal, msgOf } from './ConfirmDialog';
import { useToast } from './Toast';

/** One hidden number, as GET /api/admin/series/:id/chapters/hidden answers it. */
export interface HiddenChapter {
  number: number;
  /** Chapter rows the server keeps at the number: a file, or a deleted one's row. */
  onServer: number;
  /** A source the series follows lists it. */
  listed: boolean;
  title: string | null;
}

/** What a hidden number is, in a few words: on the server (and how many copies), listed by a source, both, or neither. */
export function hiddenCaption(h: Pick<HiddenChapter, 'onServer' | 'listed'>): string {
  if (h.onServer > 1) return h.listed ? tr('{n} copies on the server, listed by a source', { n: h.onServer }) : tr('{n} copies on the server', { n: h.onServer });
  if (h.onServer === 1) return h.listed ? tr('1 copy on the server, listed by a source') : tr('1 copy on the server');
  return h.listed ? tr('Listed by a source') : tr('Not listed any more');
}

/** A title worth showing beside the number: not one that only says the number again ("Chapter 12"), as GhostRow has it. */
const ownTitle = (t: string | null): string | null => (t && !/^(ch(apter)?\.?\s*)?[\d.]+$/i.test(t) ? t : null);

/**
 * The list, from More's Show hidden chapters: Restore on each, and Restore all. Closes itself once the last one is
 * back. `onChanged` refreshes the series page's chapters, its grey rows and More's count.
 */
export function HiddenChaptersDialog({ seriesId, onClose, onChanged }: { seriesId: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const path = `/api/admin/series/${encodeURIComponent(seriesId)}/chapters`;
  const list = useQuery({ queryKey: ['series-hidden', seriesId], queryFn: () => api<{ content: HiddenChapter[] }>(`${path}/hidden`) });
  const rows = list.data?.content ?? [];
  // By the count, never the array: a fresh `[]` every render as a dependency re-ran this for ever (React #185).
  const count = rows.length;
  useEffect(() => { if (list.isSuccess && count === 0) onClose(); }, [list.isSuccess, count, onClose]);

  const restore = async (body: { numbers: number[] } | { all: true }) => {
    setBusy(true);
    try {
      const r = await api<{ restored: number[] }>(`${path}/unhide`, { method: 'POST', json: body });
      const n = r.restored.length;
      toast(n === 1 ? tr('1 chapter is back.') : tr('{n} chapters are back.', { n }), 'success');
      await qc.invalidateQueries({ queryKey: ['series-hidden', seriesId] });
      onChanged();
    } catch (e) {
      toast(msgOf(e, tr('Could not restore that')), 'error');
    }
    setBusy(false);
  };

  return (
    <Modal title={tr('Hidden chapters')} onClose={onClose}>
      <p className="text-sm leading-relaxed text-fog-300">
        {tr('Hidden from everyone: not in the chapter list, Continue, the unread counts, Updates or Health, and never downloaded. Nothing was deleted, so Restore brings a chapter back as it was.')}
      </p>
      {list.isLoading && <p className="mt-4 text-sm text-fog-500">{tr('Loading…')}</p>}
      {list.isError && <p className="mt-4 text-sm text-rose-300">{tr('Could not load the hidden chapters')}</p>}
      {count > 0 && (
        <ul className="mt-3 divide-y divide-ink-800/70" data-hidden-chapters>
          {rows.map((h) => {
            const title = ownTitle(h.title);
            return (
              <li key={h.number} className="flex items-center gap-3 py-2.5" data-hidden-number={h.number}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-fog-100">
                    {chapterLabel({ number: h.number })}
                    {title && <span className="text-fog-500"> · {title}</span>}
                  </p>
                  <p className="text-xs text-fog-500">{hiddenCaption(h)}</p>
                </div>
                <button type="button" className="btn-key" disabled={busy} onClick={() => void restore({ numbers: [h.number] })}
                  aria-label={tr('Restore chapter {n}', { n: h.number })}>
                  {tr('Restore')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {count > 1 && <button type="button" className="btn-key" disabled={busy} onClick={() => void restore({ all: true })} data-restore-all>{tr('Restore all')}</button>}
        <button type="button" className="btn-key" onClick={onClose}>{tr('Close')}</button>
      </div>
    </Modal>
  );
}
