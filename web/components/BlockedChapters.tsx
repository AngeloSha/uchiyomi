'use client';
// A blocked group's chapters still on the shelf (#396, bff lib/blockedPurge.ts), and the question whether to remove
// them completely. Blocking a group is saved at once and only hides; this is the confirmed second step, asked wherever
// a block is made -- under "Translated by" in a series' Sources & translations sheet (`seriesId`), and in the
// Scanlation groups editor for every series (none). Asked inline, never in a dialog: both live in a Sheet, and a Modal
// opened under a Sheet cannot be tapped.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';

export interface BlockedChapters {
  chapters: number;
  series: number;
  readers: number;
  books: Array<{ id: string; seriesId: string; seriesTitle: string; number: number; scanlator: string | null; pruned: boolean }>;
}

/** The query key: one series, or '*' for every series. A block saved anywhere invalidates ['blocked-chapters']. */
export const blockedChaptersKey = (seriesId?: string) => ['blocked-chapters', seriesId ?? '*'];

/** The question's sentence, by how many chapters, series and readers it is about. */
export function blockedChaptersText(d: Pick<BlockedChapters, 'chapters' | 'series' | 'readers'>, everySeries: boolean): string {
  const parts = [
    d.chapters === 1 ? tr('1 downloaded chapter is only from blocked groups.') : tr('{n} downloaded chapters are only from blocked groups.', { n: d.chapters }),
    ...(everySeries && d.series > 1 ? [tr('They are in {n} different series.', { n: d.series })] : []),
    tr('Remove them completely, as if they had never been downloaded?'),
    ...(d.readers === 1 ? [tr('Reading history on them goes too, for 1 reader.')]
      : d.readers > 1 ? [tr('Reading history on them goes too, for {n} readers.', { n: d.readers })] : []),
  ];
  return parts.join(' ');
}

export function BlockedChaptersAsk({ seriesId }: { seriesId?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({
    queryKey: blockedChaptersKey(seriesId),
    queryFn: () => api<BlockedChapters>(`/api/admin/blocked-chapters${seriesId ? `?seriesId=${encodeURIComponent(seriesId)}` : ''}`),
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  // Keep answers for exactly the chapters asked about: a chapter blocked later asks again.
  const [kept, setKept] = useState<string | null>(null);
  if (!data?.chapters) return null;
  const asked = data.books.map((b) => b.id).join(',');
  if (kept === asked) return null;
  const remove = async () => {
    setBusy(true);
    try {
      const r = await api<{ removed: number; left: unknown[]; busy: string[] }>('/api/admin/blocked-chapters/purge', {
        method: 'POST', json: { bookIds: data.books.map((b) => b.id) },
      });
      toast(r.removed === 1 ? tr('Removed 1 chapter') : tr('Removed {n} chapters', { n: r.removed }), 'success');
      if (r.left.length || r.busy.length) toast(tr('Some chapters could not be removed now. Try again in a moment.'), 'error');
      for (const k of ['blocked-chapters', 'series-books', 'series-listing', 'series-versions', 'series', 'library', 'home']) {
        void qc.invalidateQueries({ queryKey: [k] });
      }
    } catch (e) { toast(msgOf(e, tr('Could not remove the chapters')), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div role="alertdialog" aria-label={tr('Remove blocked chapters')} data-blocked-chapters-ask
      className="mt-2 border-s-2 border-rose-400/70 bg-ink-850/80 py-2 pe-2 ps-2.5">
      <p className="text-[12px] leading-relaxed text-fog-100">{blockedChaptersText(data, !seriesId)}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => void remove()} disabled={busy} className="btn-key btn-key-danger" data-blocked-chapters-remove>
          {busy ? tr('Working…') : tr('Remove completely')}
        </button>
        <button type="button" onClick={() => setKept(asked)} disabled={busy} className="btn-key" data-blocked-chapters-keep>{tr('Keep')}</button>
      </div>
    </div>
  );
}
