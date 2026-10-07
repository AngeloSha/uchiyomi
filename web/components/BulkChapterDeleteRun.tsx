'use client';

import { Modal } from '@/components/ConfirmDialog';
import { ProgressRing } from '@/components/ProgressRing';
import { bytes } from '@/lib/format';
import { t as tr } from '@/lib/i18n';
import type { BulkChapterDeleteReason, BulkChapterDeleteRun } from '@/lib/bulkChapterDelete';

const statusText = (run: BulkChapterDeleteRun): string => {
  if (run.status === 'running') return run.cancelRequested ? tr('Stopping…') : tr('Running');
  if (run.status === 'done') return tr('Done');
  if (run.status === 'cancelled') return tr('Cancelled');
  if (run.status === 'interrupted') return tr('Interrupted');
  return tr('Failed');
};

const reasonText = (reason?: BulkChapterDeleteReason): string => {
  switch (reason) {
    case 'not_found': return tr('Series not found');
    case 'hidden': return tr('Series is hidden');
    case 'merged': return tr('Series was merged');
    case 'busy': return tr('Series is busy');
    case 'nothing_to_delete': return tr('Nothing to delete');
    case 'refused': return tr('Deletion was refused');
    case 'cancelled': return tr('Cancelled');
    default: return tr('Failed');
  }
};

const chapterCount = (n: number): string => (n === 1 ? tr('1 chapter deleted') : tr('{n} chapters deleted', { n }));
const keptCount = (n: number): string => (n === 1 ? tr('1 chapter kept') : tr('{n} chapters kept', { n }));

export function BulkChapterDeleteRunDialog({
  run,
  cancelling,
  onCancel,
  onClose,
}: {
  run: BulkChapterDeleteRun;
  cancelling: boolean;
  onCancel: () => void;
  onClose: () => void;
}) {
  const running = run.status === 'running';
  const progress = run.total ? run.done / run.total : 0;
  const summary = [
    run.summary.chapters ? chapterCount(run.summary.chapters) : null,
    run.summary.bytes ? tr('{size} freed', { size: bytes(run.summary.bytes) }) : null,
    run.summary.kept ? keptCount(run.summary.kept) : null,
  ].filter(Boolean).join(' · ');

  return (
    <Modal title={tr('Delete chapters')} onClose={onClose} wide>
      <div data-bulk-delete-run={run.status} className="space-y-4">
        <div className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-900/45 p-3">
          <ProgressRing
            progress={progress}
            label={tr('Delete chapters')}
            valueText={tr('{done} of {total}', { done: run.done, total: run.total })}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <p className="font-medium text-fog-100">{statusText(run)}</p>
              <p className="shrink-0 text-xs tabular-nums text-fog-400" dir="ltr">
                {tr('{done} of {total}', { done: run.done, total: run.total })}
              </p>
            </div>
            {summary && <p className="mt-0.5 text-xs text-fog-400">{summary}</p>}
            {run.error && <p dir="auto" className="mt-1 text-xs text-rose-300">{run.error}</p>}
          </div>
        </div>

        {running && (
          <p className="text-xs leading-relaxed text-fog-400">
            {run.cancelRequested
              ? tr('Stopping after the current series…')
              : tr('This cleanup keeps running if you close this window or reload the page.')}
          </p>
        )}

        {run.results.length > 0 && (
          <div className="max-h-72 space-y-2 overflow-y-auto pe-1" data-lenis-prevent aria-label={tr('Results')}>
            {run.results.map((result) => {
              const detail = result.outcome === 'applied'
                ? [
                    chapterCount(result.chapters),
                    result.bytes ? bytes(result.bytes) : null,
                    result.kept ? keptCount(result.kept) : null,
                    result.paused ? tr('Updates stopped') : null,
                  ].filter(Boolean).join(' · ')
                : [reasonText(result.reason), result.kept ? keptCount(result.kept) : null].filter(Boolean).join(' · ');
              return (
                <div key={`${result.id}:${run.id}`} data-bulk-delete-result={result.outcome}
                  className="rounded-lg border border-ink-700 bg-ink-900/35 px-3 py-2">
                  <div className="flex items-start justify-between gap-3">
                    <p dir="auto" className="min-w-0 truncate text-sm text-fog-100">{result.title || result.id}</p>
                    <span className={`shrink-0 text-[11px] font-medium ${result.outcome === 'failed' ? 'text-rose-300' : result.outcome === 'applied' ? 'text-emerald-300' : 'text-fog-400'}`}>
                      {result.outcome === 'applied' ? tr('Deleted') : result.outcome === 'failed' ? tr('Failed') : tr('Skipped')}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-fog-400">{detail}</p>
                  {result.message && <p dir="auto" className="mt-0.5 text-[11px] text-rose-300">{result.message}</p>}
                </div>
              );
            })}
          </div>
        )}

        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-ghost flex-1 py-2 text-sm">{tr('Close')}</button>
          {running && (
            <button type="button" onClick={onCancel} disabled={cancelling || run.cancelRequested}
              data-cancel-bulk-delete className="flex-1 rounded-full bg-rose-500/90 py-2 text-sm font-semibold text-white disabled:opacity-40">
              {cancelling || run.cancelRequested ? tr('Stopping…') : tr('Stop')}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
