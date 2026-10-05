'use client';
/**
 * Admin → Tasks → Rescan everything (v0.55.4, discussion #150): the panel under its row. Start runs a preview on the
 * server (a scan, then a look for every chapter's own file) and changes nothing; this panel shows it running, then
 * what Apply would do -- the four counts, the series with nothing left with a link to each, and the optional
 * renumbering by the newer file-name rules -- then Apply, and what it did.
 *
 * The sentences live in lib/rescan.ts, where a test holds them. The server decides everything (bff lib/rescan.ts):
 * this page only shows the plan and sends back its id and the series ticked.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { bookCountText, relativeTime } from '@/lib/format';
import { useReduceEffects } from '@/lib/effects';
import { useToast } from '@/components/Toast';
import {
  applyRefusalText, exampleLine, fileName, numbersLine, planHeadline, progressLine, rescanView, uncheckedLine, unmountedLine,
  type RescanPlanView, type RescanStatus,
} from '@/lib/rescan';

export const RESCAN_KEY = ['rescan-status'];
const STATUS_URL = '/api/admin/tasks/rescan/status';

/** The panel's box: a quiet inset under the row, full width, never a capsule. */
const BOX = 'mt-3 min-w-0 space-y-3 rounded-xl border border-ink-700/70 bg-ink-900/40 p-3 sm:p-4';

export function RescanPanel({ running }: { running: boolean }) {
  const qc = useQueryClient();
  const { data: s } = useQuery({
    queryKey: RESCAN_KEY,
    queryFn: () => api<RescanStatus>(STATUS_URL),
    // Every two seconds while a preview or an Apply runs -- the Tasks list's own `running` wakes it, the status keeps it.
    refetchInterval: (qy) => (qy.state.data?.running || running ? 2000 : false),
  });
  // The plan whose result (or preview) the admin closed: nothing is undone, the panel just steps aside.
  const [dismissed, setDismissed] = useState<string | null>(null);
  // A run that has just ended changes the Tasks line (an Apply's result is its): asked now, not at its next poll.
  const was = useRef(s?.running ?? null);
  useEffect(() => {
    if (was.current && !s?.running) qc.invalidateQueries({ queryKey: ['admin-tasks'] });
    was.current = s?.running ?? null;
  }, [s?.running, qc]);
  const view = rescanView(s, dismissed);
  if (!s || view === 'none') return null;
  if (view === 'running') return <Running s={s} />;
  if (view === 'failed') {
    return (
      <div className={BOX} data-rescan-panel="failed">
        <p role="alert" className="text-[13px] text-amber-300">{tr('The rescan did not finish. The server log says why.')}</p>
        <div className="flex justify-end"><button type="button" className="btn-key" onClick={() => setDismissed('failed')}>{tr('Close')}</button></div>
      </div>
    );
  }
  const plan = s.plan!;
  if (view === 'result') {
    // What Apply did is the line above; what stays here is what a line cannot hold: a link to each series left empty.
    return (
      <div className={BOX} data-rescan-panel="result">
        <Emptied plan={plan} />
        <div className="flex justify-end"><button type="button" className="btn-key" onClick={() => setDismissed(plan.id)}>{tr('Close')}</button></div>
      </div>
    );
  }
  return <Preview plan={plan} onClose={() => setDismissed(plan.id)} onApplied={() => qc.invalidateQueries({ queryKey: RESCAN_KEY })} />;
}

/** A preview or an Apply on its way: its phase, and how far, as a bar when there is a count. */
function Running({ s }: { s: RescanStatus }) {
  const plain = useReduceEffects();
  const total = s.of ?? 0;
  const done = Math.min(s.done, total);
  return (
    <div className={BOX} data-rescan-panel="running">
      <p className="text-[12px] tabular-nums text-fog-300" aria-live="polite" data-rescan-progress>{progressLine(s)}</p>
      {total > 0 && (
        // The bar fills from the start edge, so from the right in Arabic (--start, app/globals.css).
        <div className="h-1.5 overflow-hidden rounded-[3px] bg-ink-700" role="progressbar" aria-valuemin={0} aria-valuemax={total}
          aria-valuenow={done} aria-label={progressLine(s)}>
          <div className={`h-full origin-[var(--start)] bg-accent ${plain ? '' : 'transition-transform duration-500 ease-out motion-reduce:transition-none'}`}
            style={{ transform: `scaleX(${done / total})` }} />
        </div>
      )}
    </div>
  );
}

/** The series every chapter of which is gone: listed with a link, never hidden or removed by the rescan. */
function Emptied({ plan }: { plan: RescanPlanView }) {
  if (!plan.emptied) return null;
  const more = plan.emptied - plan.emptiedList.length;
  return (
    <div className="min-w-0" data-rescan-emptied>
      <p className="text-[12px] font-medium text-fog-200">{tr('Series with nothing left')}</p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-fog-500">
        {tr('Nothing is hidden or removed. Open one to remove it, or to merge it with the series its files went to.')}
      </p>
      <ul className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
        {plan.emptiedList.map((e) => (
          <li key={e.seriesId} className="flex min-w-0 items-baseline gap-2 text-[12px]">
            <Link href={`/series/?id=${encodeURIComponent(e.seriesId)}`} dir="auto"
              className="min-w-0 truncate text-fog-100 underline-offset-2 hover:text-accent hover:underline">{e.title}</Link>
            <span className="shrink-0 text-fog-500">{bookCountText(e.chapters)}</span>
          </li>
        ))}
      </ul>
      {more > 0 && <p className="mt-1 text-[11px] text-fog-500">{more === 1 ? tr('and 1 more') : tr('and {n} more', { n: more })}</p>}
    </div>
  );
}

function Preview({ plan, onClose, onApplied }: { plan: RescanPlanView; onClose: () => void; onApplied: () => void }) {
  const toast = useToast();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const numbers = plan.numbers ?? [];
  const toggle = (id: string, on: boolean) => setTicked((t) => { const n = new Set(t); if (on) n.add(id); else n.delete(id); return n; });
  const nothing = plan.gone === 0 && ticked.size === 0;
  const apply = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      const r = await api<{ ok?: boolean; error?: string; started?: boolean }>('/api/admin/tasks/rescan/apply', {
        method: 'POST', json: { plan: plan.id, renumber: [...ticked] },
      });
      // A refusal is the panel's to say, beside the button it is about: a stale preview, or the job it would run beside.
      if (r?.ok === false) setRefusal(applyRefusalText(r.error));
      else onApplied();
    } catch { toast(tr('Failed'), 'error'); }
    setBusy(false);
  };
  return (
    <section className={BOX} data-rescan-panel="preview" aria-label={tr('Rescan everything')}>
      <p className="text-[11px] text-fog-500">{tr('Preview')} · {relativeTime(new Date(plan.at).toISOString())}</p>
      {/* A folder left alone comes first: its chapters are not in any count below, and a line at the end is the line off
          the edge of a phone. */}
      {plan.unmounted.map((u) => (
        <p key={u.root} className="text-[12px] leading-snug text-amber-300" data-rescan-unmounted>{unmountedLine(u)}</p>
      ))}
      <p className="text-[13px] leading-snug text-fog-100" data-rescan-headline>{planHeadline(plan)}</p>
      {plan.unchecked > 0 && <p className="text-[12px] text-fog-400">{uncheckedLine(plan.unchecked)}</p>}
      {plan.gone > 0 && (
        <p className="text-[11px] leading-relaxed text-fog-500">
          {tr('Apply marks them “File no longer on disk”. Nothing is erased and no file is touched: everyone’s reading history stays, and a file that comes back is picked up again by the next scan.')}
        </p>
      )}
      <Emptied plan={plan} />
      {plan.movedList.length > 0 && (
        <details className="min-w-0 text-[12px]" data-rescan-moved>
          <summary className="cursor-pointer text-fog-400 hover:text-fog-200">{tr('Which ones were probably moved or renamed')}</summary>
          <ul className="mt-1.5 space-y-1">
            {plan.movedList.map((m) => (
              <li key={`${m.seriesId}:${m.file}`} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-fog-400">
                <bdi className="min-w-0 truncate">{m.title} · {fileName(m.file)}</bdi>
                <span aria-hidden className="inline-block shrink-0 rtl:-scale-x-100">→</span>
                <bdi className="min-w-0 truncate text-fog-200">{m.to.title} · {fileName(m.to.file)}</bdi>
              </li>
            ))}
          </ul>
        </details>
      )}
      {numbers.length > 0 && (
        // The rule above the group is a div's, not the fieldset's: a legend sits IN a fieldset's border and drew a line
        // beside itself.
        <div className="min-w-0 border-t border-ink-800/70 pt-3">
        <fieldset className="min-w-0" data-rescan-numbers>
          <legend className="text-[12px] font-medium text-fog-200">{tr('Number chapters again by the new file-name rules (optional)')}</legend>
          <p className="mt-0.5 text-[11px] leading-relaxed text-fog-500">
            {tr('Chapters added before v0.55.2 keep the first number in their file name, so “Vol 2 Ch 5” is chapter 2. Tick a series to number its files by the new rules instead. Trackers are told nothing now; the next chapter a reader finishes there sends its new number.')}
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-fog-600">{tr('Series numbered by posting order, or in the middle of a renumber, are not listed.')}</p>
          {numbers.length > 1 && (
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className="btn-key" onClick={() => setTicked(new Set(numbers.map((n) => n.seriesId)))}>{tr('Select all')}</button>
              <button type="button" className="btn-key" disabled={!ticked.size} onClick={() => setTicked(new Set())}>{tr('Select none')}</button>
            </div>
          )}
          {/* A long list scrolls in place; data-lenis-prevent, as every inner scroller (the smooth scroll would take it). */}
          <ul className="mt-2 max-h-80 space-y-1 overflow-y-auto overscroll-contain pe-1" data-lenis-prevent>
            {numbers.map((n) => (
              <li key={n.seriesId}>
                <label className="flex min-w-0 items-start gap-2.5 rounded-lg px-1 py-1.5 hover:bg-ink-800/40">
                  <input type="checkbox" checked={ticked.has(n.seriesId)} onChange={(e) => toggle(n.seriesId, e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--accent))]" data-rescan-tick={n.seriesId} />
                  {/* The title isolated in a block of the page's direction: dir="auto" on the block set a Latin title
                      to the left of an Arabic page, away from its checkbox. */}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-fog-100"><bdi>{n.title}</bdi></span>
                    <span className="block text-[11px] leading-snug text-fog-500">{numbersLine(n)}</span>
                    {/* One box per example: a file name broken across two lines is reordered line by line, and in
                        Arabic half a name landed before the other example. */}
                    {n.examples.length > 0 && (
                      <span className="block text-[11px] leading-snug text-fog-600">
                        {n.examples.map((e) => <span key={e.file} className="me-3 inline-block max-w-full">{exampleLine(e)}</span>)}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {(plan.numbersTotal ?? numbers.length) > numbers.length && (
            <p className="mt-1 text-[11px] text-fog-500">
              {(plan.numbersTotal! - numbers.length) === 1 ? tr('and 1 more') : tr('and {n} more', { n: plan.numbersTotal! - numbers.length })}
            </p>
          )}
        </fieldset>
        </div>
      )}
      {plan.stale && (
        <p className="text-[12px] text-amber-300">
          {tr('This preview is more than 30 minutes old, or a newer one replaced it. Run it again to see the library as it is now.')}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-ink-800/70 pt-3">
        {refusal && <p role="status" className="me-auto min-w-0 flex-1 basis-48 text-[11px] leading-snug text-amber-300" data-rescan-refusal>{refusal}</p>}
        <button type="button" className="btn-key" onClick={onClose}>{tr('Close')}</button>
        <button type="button" className="btn-key btn-key-primary" onClick={apply} disabled={busy || nothing || plan.stale} data-rescan-apply>
          {tr('Apply')}
        </button>
      </div>
    </section>
  );
}
