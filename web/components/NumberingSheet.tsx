'use client';
// The exact plan of a renumbering, before anything moves (#116): every file on disk, the number it has and the
// number it gets, the post it was matched to and how, what could not be matched, and Confirm.
//
// The plan comes from GET /api/admin/series/:id/numbering, which lists the source afresh and changes nothing;
// Confirm POSTs the same mode with `confirm: true`. The renames keep each chapter's row -- its id, and with it
// reading progress, bookmarks and notes -- which the sheet says in so many words, because "renamed" reads like
// "re-downloaded" to anyone who has lost progress to a re-download before.
//
// A Sheet (z-60) opened by the page, never over another sheet: the versions sheet closes before this opens.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { Sheet } from '@/components/ui';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';
import { numLabel, planCounts, type NumberingAnswer, type PlanAnswer, type PlanMove, type RenumberMode } from '@/lib/numbering';

/** At most this many moves are drawn at once; a 226-post series lists the rest behind "Show all". */
const FIRST_MOVES = 60;

export function NumberingSheet({ seriesId, mode, onClose }: { seriesId: string; mode: RenumberMode; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [applying, setApplying] = useState(false);
  const [all, setAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data, isLoading, isError, error: loadError } = useQuery({
    queryKey: ['numbering-plan', seriesId, mode],
    queryFn: () => api<PlanAnswer>(`/api/admin/series/${encodeURIComponent(seriesId)}/numbering?mode=${mode}`),
    retry: false,
    staleTime: 0,
  });

  const title = mode === 'source' ? tr('Use the source’s numbers') : mode === 'remap' ? tr('Renumber to the source’s new numbers') : tr('Number by posting order');
  const plan = data?.plan;
  const counts = plan ? planCounts(plan) : null;
  const moving = (plan?.moves ?? []).filter((m) => m.via !== 'none' && (m.to !== m.from || m.file !== m.fromFile));
  const shown = all ? moving : moving.slice(0, FIRST_MOVES);

  const confirm = async () => {
    setApplying(true);
    setError(null);
    try {
      const r = await api<NumberingAnswer>(`/api/admin/series/${encodeURIComponent(seriesId)}/numbering`, { json: { mode, confirm: true } });
      for (const k of [['series-listing', seriesId], ['series-books', seriesId], ['series-versions', seriesId], ['series', seriesId]]) qc.invalidateQueries({ queryKey: k });
      if (r.state === 'applied' || r.state === 'unchanged') {
        toast(tr('Renumbered'), 'success');
        onClose();
      } else {
        // Held, not failed: the source did not answer, or the rename is still running past the request.
        setError(r.running ? tr('Still renaming. The series page shows the new numbers when it is done.') : tr('It could not be applied yet. The source may not have answered; try again in a moment.'));
      }
    } catch (e) {
      setError(msgOf(e, tr('Could not do that')));
    }
    setApplying(false);
  };

  const line = (m: PlanMove) => (
    <li key={m.bookId} className="flex items-baseline gap-2 py-1.5 text-[12px]" data-plan-move>
      <span className="shrink-0 tabular-nums text-fog-400">{tr('Ch. {n}', { n: numLabel(m.from) })}</span>
      <span aria-hidden className="inline-block shrink-0 text-fog-600 rtl:rotate-180">→</span>
      <span className="shrink-0 tabular-nums text-fog-100">{tr('Ch. {n}', { n: numLabel(m.to) })}</span>
      {m.title && <span dir="auto" className="min-w-0 truncate text-fog-500">· {m.title}</span>}
    </li>
  );

  // Not dismissable while the rename runs: the answer would land on a closed sheet.
  const close = () => { if (!applying) onClose(); };
  return (
    <Sheet title={title} onClose={close} overBottomNav
      footer={plan && (
        <div className="pb-1">
          {error && <p role="alert" className="mb-2 text-[12px] text-amber-300">{error}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} disabled={applying} className="btn-key flex-1">{tr('Cancel')}</button>
            <button type="button" onClick={() => void confirm()} disabled={applying} className="btn-key btn-key-primary flex-1" data-plan-confirm>
              {applying ? tr('Renaming…') : moving.length ? tr('Rename the files') : tr('Apply')}
            </button>
          </div>
        </div>
      )}>
      {isLoading && <p className="py-4 text-sm text-fog-500">{tr('Listing the source…')}</p>}
      {isError && <p role="alert" className="py-4 text-sm text-amber-300">{msgOf(loadError, tr('Could not do that'))}</p>}
      {plan && counts && (
        <div data-numbering-plan>
          {counts.renamed + counts.unchanged + counts.parked > 0 && <p className="text-sm text-fog-100">
            {[
              counts.renamed === 1 ? tr('1 chapter renamed') : tr('{n} chapters renamed', { n: counts.renamed }),
              counts.unchanged ? (counts.unchanged === 1 ? tr('1 unchanged') : tr('{n} unchanged', { n: counts.unchanged })) : '',
              counts.parked ? (counts.parked === 1 ? tr('1 chapter could not be matched') : tr('{n} chapters could not be matched', { n: counts.parked })) : '',
            ].filter(Boolean).join(' · ')}
          </p>}
          <p className="mt-1 text-[12px] leading-relaxed text-fog-400">{tr('Reading progress, bookmarks and notes stay with their chapters.')}</p>
          {counts.parked > 0 && (
            <p className="mt-1 text-[12px] leading-relaxed text-amber-200">
              {tr('A chapter no post matches keeps its file, at a free number just after the chapter before it.')}
            </p>
          )}
          {plan.reasons.includes('listing_only') && (
            <p className="mt-1 text-[12px] leading-relaxed text-amber-200">{tr('Some chapters were matched only by the old chapter list. Check them before you confirm.')}</p>
          )}
          {counts.collisions > 0 && (
            <p className="mt-1 text-[12px] leading-relaxed text-fog-400">
              {counts.collisions === 1
                ? tr('1 number is shared by more than one file; each keeps its file, the extra ones as “Chapter N (2)”.')
                : tr('{n} numbers are shared by more than one file; each keeps its file, the extra ones as “Chapter N (2)”.', { n: counts.collisions })}
            </p>
          )}
          {data?.tracker && (
            <p className="mt-1 text-[12px] leading-relaxed text-fog-400">{tr('This series is linked to a tracker. After the renumbering it is told the highest chapter you finished in the new numbers, which can be much higher than before.')}</p>
          )}

          {moving.length > 0 && (
            <ul className="mt-3 divide-y divide-ink-800/60">
              {shown.map(line)}
            </ul>
          )}
          {plan.parked.length > 0 && (
            <>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-fog-500">{tr('Not matched')}</p>
              <ul className="divide-y divide-ink-800/60">{plan.parked.map(line)}</ul>
            </>
          )}
          {!all && moving.length > FIRST_MOVES && (
            <button type="button" onClick={() => setAll(true)} className="btn-key mt-2">{tr('Show all {n}', { n: moving.length })}</button>
          )}
          {!moving.length && !plan.parked.length && (
            <p className="mt-2 text-[12px] text-fog-500">{tr('No file is renamed: only the numbers new chapters get change.')}</p>
          )}
        </div>
      )}
    </Sheet>
  );
}
