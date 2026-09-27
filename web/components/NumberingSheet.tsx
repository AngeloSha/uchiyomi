'use client';
// The exact plan of a renumbering, before anything moves (#116): every file on disk, the number it has and the
// number it gets, the post it was matched to and how, what could not be matched, and Confirm.
//
// The plan comes from GET /api/admin/series/:id/numbering, which lists the source afresh and changes nothing;
// Confirm POSTs the same mode with `confirm: true`. The renames keep each chapter's row -- its id, and with it
// reading progress, bookmarks and notes -- which the sheet says in so many words, because "renamed" reads like
// "re-downloaded" to anyone who has lost progress to a re-download before.
//
// A Sheet (z-60), never over another sheet: the versions sheet closes before this opens. ⚠️ On <body>: Health opens
// it from a row inside a `.card`, whose backdrop-filter would make the card the sheet's containing block (ui.tsx
// OnBody).
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { OnBody, Sheet } from '@/components/ui';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';
import {
  numLabel, pendingLine, planCounts, refusalText, type NumberingAnswer, type PlanAnswer, type PlanMode, type PlanMove, type RenumberMode,
} from '@/lib/numbering';

/** At most this many moves are drawn at once; a 226-post series lists the rest behind "Show all". */
const FIRST_MOVES = 60;

/**
 * `mode` is the plan to show, or `next`: whatever waits for review, as the route picks it. `onConfirm` hands the
 * confirmed mode to the caller instead of posting it here -- a Health row posts it itself, so its own status line
 * says "Renaming…" with its clock and then what came of it; the sheet closes on the press.
 */
export function NumberingSheet({ seriesId, mode, onClose, onConfirm }: {
  seriesId: string; mode: PlanMode; onClose: () => void; onConfirm?: (mode: RenumberMode) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [applying, setApplying] = useState(false);
  const [all, setAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data, isLoading, isError, error: loadError } = useQuery({
    queryKey: ['numbering-plan', seriesId, mode],
    queryFn: () => api<PlanAnswer>(`/api/admin/series/${encodeURIComponent(seriesId)}/numbering${mode === 'next' ? '' : `?mode=${mode}`}`),
    retry: false,
    staleTime: 0,
  });

  // The change the plan is about: asked for, or the one the route picked for `next`.
  const m: RenumberMode | undefined = mode === 'next' ? data?.mode : mode;
  const title = m === 'source' ? tr('Use the source’s numbers') : m === 'remap' ? tr('Renumber to the source’s new numbers')
    : m === 'posting_order' ? tr('Number by posting order') : tr('Review renumbering');
  const plan = data?.plan;
  const counts = plan ? planCounts(plan) : null;
  const moving = (plan?.moves ?? []).filter((x) => x.via !== 'none' && (x.to !== x.from || x.file !== x.fromFile));
  const shown = all ? moving : moving.slice(0, FIRST_MOVES);

  const confirm = async () => {
    if (!m) return;
    if (onConfirm) { onConfirm(m); onClose(); return; }
    setApplying(true);
    setError(null);
    try {
      const r = await api<NumberingAnswer>(`/api/admin/series/${encodeURIComponent(seriesId)}/numbering`, { json: { mode: m, confirm: true } });
      for (const k of [['series-listing', seriesId], ['series-books', seriesId], ['series-versions', seriesId], ['series', seriesId]]) qc.invalidateQueries({ queryKey: k });
      if (r.state === 'applied' || r.state === 'unchanged') {
        toast(tr('Renumbered'), 'success');
        onClose();
      } else {
        // Held, not failed -- and said as what held it (lib/numbering.ts pendingLine): the rename still running, the
        // server's refusal, a download into the folder, else the source.
        setError(pendingLine(r));
      }
    } catch (e) {
      setError(refusalText(e, tr('Could not do that')));
    }
    setApplying(false);
  };

  const line = (x: PlanMove) => (
    <li key={x.bookId} className="flex items-baseline gap-2 py-1.5 text-[12px]" data-plan-move>
      <span className="shrink-0 tabular-nums text-fog-400">{tr('Ch. {n}', { n: numLabel(x.from) })}</span>
      <span aria-hidden className="inline-block shrink-0 text-fog-600 rtl:rotate-180">→</span>
      <span className="shrink-0 tabular-nums text-fog-100">{tr('Ch. {n}', { n: numLabel(x.to) })}</span>
      {x.title && <span dir="auto" className="min-w-0 truncate text-fog-500">· {x.title}</span>}
    </li>
  );

  // Not dismissable while the rename runs: the answer would land on a closed sheet.
  const close = () => { if (!applying) onClose(); };
  return (
    <OnBody>
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
            {/* Right under the list it unfolds, not after "Not matched", where it read as that list's. */}
            {!all && moving.length > FIRST_MOVES && (
              <button type="button" onClick={() => setAll(true)} className="btn-key mt-2" data-plan-all>{tr('Show all {n}', { n: moving.length })}</button>
            )}
            {plan.parked.length > 0 && (
              <>
                <p className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-fog-500">{tr('Not matched')}</p>
                <ul className="divide-y divide-ink-800/60">{plan.parked.map(line)}</ul>
              </>
            )}
            {!moving.length && !plan.parked.length && (
              <p className="mt-2 text-[12px] text-fog-500">{tr('No file is renamed: only the numbers new chapters get change.')}</p>
            )}
          </div>
        )}
      </Sheet>
    </OnBody>
  );
}
