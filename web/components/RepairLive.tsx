'use client';
// The library repair, live and remembered (v0.49.0).
//
// - RepairLiveStrip: while any repair runs -- this admin's press, another's, the nightly -- the top of Health
//   says what it is, which step, what it is on, how long it has been going, how long it usually takes, and
//   offers Stop. The downloads pill that used to hold the repair's Cancel is gone; this and Library ->
//   Downloads' Server tasks card both stop it through POST /api/sources/runs/repair/cancel.
// - RepairHistory: "Recent repairs", the kept runs (bff lib/repairRuns.ts), nightly and pressed alike, each
//   with who, what, how long and what it did. A one-row fix no longer replaces the nightly's Tasks line; this
//   is where it lives instead, and Tasks links here.
// - RepairTaskLines: the Tasks tab's repair row -- next run, the running step, the latest one-off fix.
//
// Motion: the working ring is ProgressRing's, which stops turning under Reduce effects or reduced motion
// (a still dashed arc); the clock and the step text still say it is moving.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ActionList, type ActionSpec } from '@/components/ActionList';
import { StatusMark } from '@/components/StatusMark';
import { IcChevronRight } from '@/components/icons';
import { t as tr } from '@/lib/i18n';
import { durationText, formatClock, relativeTime } from '@/lib/format';
import { repairStepLabel } from '@/lib/jobs';
import { currentText, kindLabel, nextRunLine, phaseLine, recordLine, skipLine, whoLine } from '@/lib/healthCopy';
import { useRepairRun, useRepairStatus } from '@/lib/useRepairRun';
import { useTicker } from '@/lib/ticker';
import type { RepairLiveRun, RepairRunRecord, RunStatus, RunTarget } from '@/lib/repairRun';
import type { Tone } from '@/lib/status';

/** What the running run is doing, as one line: "Step 2 of 4 · Filling gaps · Searching other sources". */
function runStep(run: RepairLiveRun): string {
  const bits: string[] = [];
  if (run.steps.length > 1 && run.stepIndex >= 0) bits.push(tr('Step {i} of {n}', { i: run.stepIndex + 1, n: run.steps.length }));
  const step = repairStepLabel(run.step ?? undefined);
  if (step) bits.push(step);
  const phase = phaseLine(run.current);
  if (phase) bits.push(phase);
  return bits.join(' · ');
}

export function RepairLiveStrip() {
  const rr = useRepairRun();
  const run = rr.status?.run;
  if (!run) return null;
  const typical = rr.status?.estimates?.[run.kind]?.typicalMs;
  const facts = [
    whoLine(run),
    typical ? tr('Usually {d}', { d: durationText(typical) }) : '',
    run.budget ? tr('Searches left: {n} of {m}', { n: run.budget.left, m: run.budget.of }) : '',
  ].filter(Boolean).join(' · ');
  const cur = run.current;
  // A determinate bar only when the step knows how far it has got; otherwise the turning (or, reduced, still)
  // ring alone.
  const progress = cur?.of && cur.of > 0 ? Math.min(1, (cur.done ?? 0) / cur.of) : null;
  const spec: ActionSpec = {
    id: 'repair-live',
    label: tr('Repairing: {what}', { what: kindLabel(run.kind, run.target) }),
    what: facts,
    state: {
      kind: 'working',
      startedAt: run.startedAt,
      step: runStep(run) || tr('Working…'),
      detail: currentText(cur) || undefined,
      progress,
      onStop: () => { void rr.stop(); },
      stopping: run.cancelRequested,
    },
    // The button is Stop while it works (ActionRow); pressing it asks the run to stop between two targets.
    onRun: () => { void rr.stop(); },
    buttonProps: { 'data-repair-stop': '' } as ActionSpec['buttonProps'],
  };
  return (
    <div data-repair-live={run.id} className="card grad-border full px-4 py-1">
      <ActionList actions={[spec]} />
    </div>
  );
}

const STATUS_TONE: Record<RunStatus, Tone> = {
  running: 'accent', done: 'accent', stopped: 'warn', failed: 'problem', skipped: 'off', interrupted: 'warn',
};

/** One kept run as a line of the history. */
function HistoryRow({ r }: { r: RepairRunRecord }) {
  const skips = (r.result?.skips ?? []).slice(0, 3);
  return (
    <li data-repair-run={r.id} className="py-2.5">
      <div className="flex min-w-0 items-start gap-2">
        <StatusMark tone={STATUS_TONE[r.status] ?? 'info'} title={r.status} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm text-fog-100">{kindLabel(r.kind, r.target as RunTarget)}</p>
          <p className="mt-0.5 text-[11px] text-fog-500">
            {[whoLine(r), r.finishedAt ? relativeTime(new Date(r.finishedAt).toISOString()) : '',
              r.ms != null ? tr('took {d}', { d: durationText(r.ms) }) : ''].filter(Boolean).join(' · ')}
          </p>
          <p className="mt-0.5 break-words text-[11px] leading-relaxed text-fog-400">{recordLine(r)}</p>
          {skips.map((k: any, i: number) => <p key={i} className="mt-0.5 text-[11px] text-amber-300/90">{skipLine(k)}</p>)}
        </div>
      </div>
    </li>
  );
}

/**
 * "Recent repairs": the last ten kept runs, at the bottom of Health. Opens by itself when the page is reached
 * through its hash (the Tasks row's "Latest one-off fix" links to `?tab=Health#repairs`).
 */
export function RepairHistory() {
  const rr = useRepairRun();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const check = () => {
      if (location.hash !== '#repairs') return;
      setOpen(true);
      requestAnimationFrame(() => document.getElementById('repairs')?.scrollIntoView({ block: 'start' }));
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, []);
  const runs = rr.runs.filter((r) => r.status !== 'running').slice(0, 10);
  const next = nextRunLine(rr.status?.nextAt);
  return (
    <section id="repairs" data-repair-history className="card grad-border full overflow-hidden">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="repairs-list"
        className="flex w-full items-center gap-3 px-4 py-3.5 text-start">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-fog-100">{tr('Recent repairs')}</p>
          <p className="text-[11px] text-fog-500">
            {[runs.length ? (runs.length === 1 ? tr('1 run kept') : tr('{n} runs kept', { n: runs.length })) : tr('No repair has run yet'), next].filter(Boolean).join(' · ')}
          </p>
        </div>
        <span className="sr-only">{open ? tr('Hide details') : tr('Show details')}</span>
        <span aria-hidden className="inline-grid shrink-0 text-fog-500 rtl:-scale-x-100">
          <IcChevronRight width={16} height={16} className={`transition ${open ? 'rotate-90' : ''}`} />
        </span>
      </button>
      {open && (
        <ul id="repairs-list" role="list" className="divide-y divide-ink-800/70 border-t border-ink-800/70 px-4">
          {runs.map((r) => <HistoryRow key={r.id} r={r} />)}
          {!runs.length && <li className="py-3 text-[11px] text-fog-500">{tr('No repair has run yet')}</li>}
        </ul>
      )}
    </section>
  );
}

/** The latest one-off fix, as the Tasks row carries it (`latestOther`). */
interface LatestOther { id: string; kind: string; target: RunTarget; finishedAt: number | null; status: RunStatus; result: any }

/**
 * Under the Tasks tab's repair row: when the nightly runs next, what a running repair is doing (with its clock),
 * and the latest one-off fix -- which no longer replaces the line above, and links to the history.
 */
export function RepairTaskLines({ nextAt, latestOther, running }: { nextAt?: number | null; latestOther?: LatestOther | null; running?: boolean }) {
  const { data: status } = useRepairStatus(running ? 2000 : false);
  const run = status?.run;
  const now = useTicker(!!run);
  const next = nextRunLine(nextAt ?? status?.nextAt);
  if (!run && !next && !latestOther) return null;
  return (
    <div data-repair-task-lines className="min-w-0 space-y-0.5 text-[11px] text-fog-500">
      {run && (
        <p className="break-words text-accent tabular-nums">
          {tr('Running: {what}', { what: runStep(run) || kindLabel(run.kind, run.target) })}
          {' · '}{formatClock(now - run.startedAt)}
        </p>
      )}
      {next && <p>{next}</p>}
      {latestOther && (
        <p className="break-words">
          <Link href="/admin/?tab=Health#repairs" className="text-fog-400 underline-offset-2 hover:text-accent hover:underline">
            {tr('Latest one-off fix: {what}', { what: kindLabel(latestOther.kind, latestOther.target) })}
          </Link>
          {latestOther.finishedAt ? ` · ${relativeTime(new Date(latestOther.finishedAt).toISOString())}` : ''}
          {` · ${recordLine(latestOther)}`}
        </p>
      )}
    </div>
  );
}
