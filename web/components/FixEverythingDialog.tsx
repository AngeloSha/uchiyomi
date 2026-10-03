'use client';
// Health's "Fix everything" (v0.55.0): one key beside Re-check, and a dialog in Replace's pattern -- the question, the
// run, the end.
//
// The owner: "the fix all button in health should … give an option to auto pick stuff or to manually do it … for auto
// it just shows at the end what happened and what it did in short without cluttering". Fix all issues was the repair
// alone and vanished while a dead source or a duplicate was still amber. Now:
// - the key shows whenever any card has a finding (lib/autofix.ts showFixEverything), and while a run goes it says so;
// - the question offers "Fix it for me" (the default: ONE background run of every remedy, bff lib/autofix.ts) or "Let me
//   choose" -- the safe repair Fix all issues ran (lib/repairRun.ts pagePlan / pageBody), and the cards for the rest;
// - the run is a phase, a bar over the ten phases and what it is on, with Stop and Run in background -- opened again
//   while it goes, the dialog is the run, never the question;
// - the end is one headline ("All green", or "2 need you"), at most six lines of what it did, each Needs-you item with
//   its one key, what clears by itself, and everything else behind Details.
// A Sheet, as Replace's is: it comes up from the bottom on a phone, and it is portalled out of the board by the page.
import { useId, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { t as tr } from '@/lib/i18n';
import { numberText } from '@/lib/format';
import { useReduceEffects } from '@/lib/effects';
import { TONE_TEXT } from '@/lib/status';
import {
  autofixBlocked, autofixCount, autofixHeadline, autofixPhaseLabel, autofixProgress, autofixRefusal, autofixStepLine, autofixStepOf, autofixWait,
  canRunAgain, cardsToLook, clearsLines, doneLines, fixView, logLines, needsYouLines, showFixEverything,
  type AutofixRun, type DoneLine, type NeedsYouKey,
} from '@/lib/autofix';
import { useAutofix, type AutofixApi } from '@/lib/useAutofixRun';
import { useRepairRun } from '@/lib/useRepairRun';
import { useFindRun } from '@/lib/useFindRun';
import { kindOfBody, pageBody, pagePlan, pageRecord } from '@/lib/repairRun';
import { repairGate, rowState } from '@/lib/healthCopy';
import type { HealthCheck } from '@/lib/types';
import { Sheet } from '@/components/ui';
import { ActionStatus } from '@/components/ActionList';
import { StatusGlyph } from '@/components/StatusMark';
import { ProgressRing } from '@/components/ProgressRing';
import { Disclosure } from '@/components/settings';
import { IcCheck, IcClock } from '@/components/icons';

const NONE: ReadonlySet<string> = new Set();

/** The view the dialog is on, read from the page's one autofix follower. */
function viewOf(af: AutofixApi | null) {
  return fixView({ status: af?.status, slot: af?.slot, seen: af?.seen ?? NONE, aside: af?.aside ?? NONE });
}

/**
 * The key, in Health's top row beside Re-check: the page's one filled key while there is something to fix; while a run
 * goes, "Fixing everything" with how far it has got; once a run this page saw has ended and its end is unread, the
 * end's mark. Pressed, it opens the dialog -- on the run while one goes.
 */
export function FixEverythingKey({ checks, onOpen }: { checks: HealthCheck[]; onOpen: () => void }) {
  const af = useAutofix();
  const { view, run } = viewOf(af);
  const unread = view === 'end' && !!run;
  if (!af || !showFixEverything(checks, { live: view === 'run', unread })) return null;
  if (view === 'run') {
    return (
      <button type="button" onClick={onOpen} className="btn-key" data-fix-everything="running" title={run ? autofixStepLine(run) : undefined}>
        <ProgressRing size={14} progress={run ? autofixProgress(run) : 'spin'} />
        <span>{tr('Fixing everything')}</span>
      </button>
    );
  }
  if (unread) {
    const head = autofixHeadline(run!);
    return (
      <button type="button" onClick={onOpen} className="btn-key" data-fix-everything="ended" title={head.text}>
        <StatusGlyph tone={head.tone} size={12} />
        <span>{tr('Fix everything')}</span>
      </button>
    );
  }
  return (
    <button type="button" onClick={onOpen} className="btn-key btn-key-primary" data-fix-everything="">
      {tr('Fix everything')}
    </button>
  );
}

/**
 * The dialog: the question, the run or the end, whichever lib/autofix.ts fixView says. `onShowCheck`: a Needs-you
 * item's card key -- the page closes this and opens that card.
 */
export function FixEverythingDialog({ checks, onClose, onShowCheck }: {
  checks: HealthCheck[];
  onClose: () => void;
  onShowCheck: (check: string) => void;
}) {
  const af = useAutofix();
  const { view, run } = viewOf(af);
  if (view === 'run') return <RunView af={af} run={run} onClose={onClose} />;
  if (view === 'end' && run) return <EndView af={af} run={run} onClose={onClose} onShowCheck={onShowCheck} />;
  return <AskView af={af} checks={checks} onClose={onClose} />;
}

/** One of the two choices, as a card with its radio: the title (and a tag), then what it does. */
function ModeCard({ name, mode, checked, onPick, title, tag, children }: {
  name: string; mode: 'auto' | 'manual'; checked: boolean; onPick: () => void; title: string; tag?: string; children: ReactNode;
}) {
  return (
    <label className={`flex min-w-0 cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 ${checked ? 'border-accent/60 bg-ink-800/60' : 'border-ink-700'}`}>
      <input type="radio" name={name} checked={checked} onChange={onPick} className="mt-1 h-4 w-4 shrink-0 accent-[rgb(var(--accent))]"
        data-fix-mode={mode} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-fog-50">{title}</span>
          {/* A squared tag, never a capsule. */}
          {tag && <span className="shrink-0 rounded-[4px] bg-accent-soft px-1.5 text-[10px] font-semibold leading-4 text-accent">{tag}</span>}
        </span>
        <span className="mt-1.5 block">{children}</span>
      </span>
    </label>
  );
}

/** Before Start: the two choices, Fix it for me first and chosen. */
function AskView({ af, checks, onClose }: { af: AutofixApi | null; checks: HealthCheck[]; onClose: () => void }) {
  const rr = useRepairRun();
  const fr = useFindRun();
  const name = useId();
  // Fix it for me is the default: the owner's "auto pick stuff", recommended.
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const n = cardsToLook(checks);
  // Let me choose: the safe repair Fix all issues ran -- every repair step some finding offers (solver, failures, short
  // chapters, gaps), with `now` for the failures.
  const plan = pagePlan(checks);
  const gate = repairGate(rr.blocked, rr.status?.run, false);
  // What holds the server now, from what the page follows: the server would refuse beside it (409 busy).
  const blocked = autofixBlocked(rr.status, fr?.status);
  const slot = af?.slot;
  const refusal = slot && (slot.phase === 'refused' || slot.phase === 'failed') ? slot.reason ?? null : null;
  const line = mode === 'auto'
    ? (blocked ? autofixRefusal(blocked) : refusal)
    : (gate.disabledWhy ?? (plan.length ? null : tr('Nothing is safe to fix by itself right now: every card waits for your choice.')));
  const canStart = mode === 'auto' ? !!af && !blocked : plan.length > 0 && !gate.disabled;
  const start = () => {
    if (!canStart) return;
    if (mode === 'auto') { void af?.start(); return; }
    // The repair runs in the background; the page's live strip says what it does, and the cards wait for the rest.
    void rr.start('page', 'safe_repair', pageBody(plan));
    onClose();
  };
  const lines = [
    tr('Replaces broken sources, fetches missing and broken chapters, and finds new sources, installing up to 3 extensions if it has to.'),
    tr('Merges duplicate series, deletes chapters saved twice or numbered impossibly, and applies safe renumbering. These can’t be undone.'),
    tr('What only you can fix is listed at the end.'),
  ];
  return (
    <Sheet title={tr('Fix everything')} onClose={onClose} overBottomNav wrapTitle
      subtitle={n > 0 ? <span data-fix-cards={n}>{n === 1 ? tr('1 card needs a look') : tr('{n} cards need a look', { n })}</span> : undefined}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2 pb-1">
          {line && (
            <p role="status" className={`me-auto min-w-0 flex-1 basis-48 text-[11px] leading-snug ${blocked || refusal || gate.disabled ? 'text-amber-300/90' : 'text-fog-400'}`}
              data-fix-busy>{line}</p>
          )}
          <button type="button" onClick={onClose} className="btn-key" data-fix-cancel>{tr('Cancel')}</button>
          <button type="button" onClick={start} disabled={!canStart || slot?.phase === 'starting'} className="btn-key btn-key-primary" data-fix-start>
            {tr('Start')}
          </button>
        </div>
      }>
      <div className="pb-3" data-fix-view="ask">
        <fieldset className="grid grid-cols-1 gap-2.5">
          <legend className="sr-only">{tr('Fix everything')}</legend>
          <ModeCard name={name} mode="auto" checked={mode === 'auto'} onPick={() => setMode('auto')} title={tr('Fix it for me')} tag={tr('Recommended')}>
            {/* Spans, not a list: a radio's <label> holds phrasing content only. */}
            <span className="block space-y-1.5">
              {lines.map((l, i) => (
                <span key={i} className="flex items-start gap-2.5 text-[12px] leading-snug text-fog-300" data-fix-line={i + 1}>
                  {/* A circle, equal sides and no padding: a number, never a capsule (Replace's plan lines). */}
                  <span aria-hidden className="mt-px grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent-soft text-[10px] font-semibold tabular-nums text-accent">
                    {numberText(i + 1)}
                  </span>
                  <span className="min-w-0">{l}</span>
                </span>
              ))}
            </span>
          </ModeCard>
          <ModeCard name={name} mode="manual" checked={mode === 'manual'} onPick={() => setMode('manual')} title={tr('Let me choose')}>
            <span className="block text-[12px] leading-snug text-fog-300">
              {tr('Fix the safe things only (retries, short chapters, gaps), and decide the rest card by card.')}
            </span>
          </ModeCard>
        </fieldset>
      </div>
    </Sheet>
  );
}

/** After Start: the phase, a bar over the ten phases, and what it is on -- with Stop and Run in background. */
function RunView({ af, run, onClose }: { af: AutofixApi | null; run: AutofixRun | null; onClose: () => void }) {
  const plain = useReduceEffects();
  // Stop pressed here, or anywhere: the server says so to every viewer (`stopping`) until the run reaches its safe point.
  // Reintroduce this page's press alone: "another admin's Stop reads Stopping" in autofix.test.ts fails.
  const stopping = !!run && (run.stopping === true || af?.stopping === run.id);
  const progress = autofixProgress(run);
  const count = run ? autofixCount(run) : '';
  const wait = run ? autofixWait(run) : '';
  // ONE sentence split around its placeholder, so the title is its own bidi run (ReplaceDialog's idiom).
  const [nowBefore, nowAfter] = tr('Now: {title}').split('{title}');
  return (
    <Sheet title={tr('Fix everything')} onClose={onClose} overBottomNav wrapTitle
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2 pb-1">
          <button type="button" onClick={() => { void af?.stop(); }} disabled={!run || stopping} className="btn-key btn-key-danger" data-fix-stop>
            {stopping ? tr('Stopping…') : tr('Stop')}
          </button>
          <button type="button" onClick={onClose} className="btn-key" data-fix-background>{tr('Run in background')}</button>
        </div>
      }>
      <div className="pb-3" data-fix-view="run" data-fix-run={run?.status ?? 'starting'}>
        {!run ? (
          <p className="flex items-center gap-2 py-2 text-sm text-fog-300">
            <ProgressRing size={14} progress="spin" />{tr('Starting…')}
          </p>
        ) : (
          <>
            <p className="text-sm font-medium text-fog-50" data-fix-phase={run.phase ?? ''}>{autofixPhaseLabel(run.phase) || tr('Working…')}</p>
            {/* The bar fills from the start edge, so from the right in Arabic (--start, app/globals.css), and moves without
                easing under Reduce effects. */}
            <div className="mt-3 h-1.5 overflow-hidden rounded-[3px] bg-ink-700" role="progressbar" aria-valuemin={0} aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)} aria-valuetext={autofixStepLine(run)} aria-label={tr('Fix everything')}>
              <div className={`h-full origin-[var(--start)] bg-accent ${plain ? '' : 'transition-transform duration-500 ease-out'}`}
                style={{ transform: `scaleX(${progress})` }} />
            </div>
            <p className="mt-2 text-[12px] tabular-nums text-fog-400" data-fix-step>
              {[autofixStepOf(run), count].filter(Boolean).join(' · ')}
            </p>
            {wait ? <p className="mt-0.5 text-[12px] leading-snug text-fog-300" data-fix-waiting>{wait}</p>
              : run.current?.title && (
                <p className="mt-0.5 flex min-w-0 max-w-full text-[12px] text-fog-400" data-fix-now>
                  <span className="shrink-0 whitespace-pre">{nowBefore}</span>
                  <bdi dir="auto" className="block min-w-0 truncate text-fog-200">{run.current.title}</bdi>
                  {nowAfter && <span className="shrink-0 whitespace-pre">{nowAfter}</span>}
                </p>
              )}
            {stopping && (
              <p className="mt-3 text-[12px] leading-snug text-fog-400">
                {tr('It stops at the next safe point, never in the middle of a merge, a delete or a renumbering.')}
              </p>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}

/** A Needs-you item's one key: its page, its card here, or Admin → Settings. */
function NeedsKey({ k, onShowCheck }: { k: NeedsYouKey | null; onShowCheck: (check: string) => void }) {
  if (!k) return null;
  if (k.kind === 'card') return <button type="button" onClick={() => onShowCheck(k.check)} className="btn-key shrink-0" data-fix-key="health">{k.label}</button>;
  // Another of the console's tabs is a whole page load: it reads its tab from the address once (lib/useTabParam.ts).
  if (k.external) return <a href={k.href} target="_blank" rel="noopener noreferrer" className="btn-key shrink-0" data-fix-key="open">{k.label}</a>;
  if (k.page) return <a href={k.href} className="btn-key shrink-0" data-fix-key={k.href.includes('tab=Settings') ? 'settings' : 'open'}>{k.label}</a>;
  return <Link href={k.href} className="btn-key shrink-0" data-fix-key="open">{k.label}</Link>;
}

/** A line of what it did, and under Details what it named. */
function DoneRow({ d, items }: { d: DoneLine; items?: boolean }) {
  return (
    <li className="min-w-0" data-fix-done={items ? undefined : d.kind}>
      <p className="flex min-w-0 items-start gap-2 text-[13px] leading-snug text-fog-200">
        <IcCheck aria-hidden width={14} height={14} strokeWidth={2.4} className="mt-0.5 shrink-0 text-accent" />
        <span className="min-w-0 break-words">{d.text}</span>
      </p>
      {items && d.items.length > 0 && (
        <ul className="ms-6 mt-1 space-y-0.5">
          {d.items.map((it, i) => <li key={i} className="break-words text-[11px] leading-relaxed text-fog-400">{it}</li>)}
        </ul>
      )}
    </li>
  );
}

/**
 * The end: one headline, at most six lines of what it did, each Needs-you item with its key, what clears by itself,
 * and Details.
 *
 * ⚠️ The summary's lines are sentences in the reader's language (said codes, worded by lib/said.ts; one this build
 * cannot word is left out), so they take the page's direction -- never `dir="auto"`, which reads an Arabic sentence that
 * opens on a name ("Omniscient Reader، الفصول 12–14…") as left-to-right and puts the name at its far end. What each
 * line named is a said line too; the series "Now:" is on, a bare title, keeps its own direction. Close sets the end aside (the next press asks afresh); the ✕ only hides it, so a Needs-you item's card
 * can be seen and the end opened again for the next one.
 */
function EndView({ af, run, onClose, onShowCheck }: {
  af: AutofixApi | null; run: AutofixRun; onClose: () => void; onShowCheck: (check: string) => void;
}) {
  const head = autofixHeadline(run);
  const { shown, rest } = doneLines(run.summary);
  const needs = needsYouLines(run.summary);
  const clears = clearsLines(run.summary);
  const log = logLines(run);
  // Details: what it named (installed, merged, deleted) under the lines shown, then the lines past six, then the log.
  const named = [...shown.filter((d) => d.items.length > 0), ...rest];
  const again = canRunAgain(run);
  const slot = af?.slot;
  const refusal = slot && (slot.phase === 'refused' || slot.phase === 'failed') ? slot.reason ?? null : null;
  const close = () => { af?.dismiss(run.id); onClose(); };
  return (
    <Sheet title={tr('Fix everything')} onClose={onClose} overBottomNav wrapTitle
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2 pb-1">
          {refusal && <p role="status" className="me-auto min-w-0 flex-1 basis-48 text-[11px] leading-snug text-amber-300/90" data-fix-busy>{refusal}</p>}
          {/* Only while something a run could still change is left: never after all green, never for Needs you alone. */}
          {again && (
            <button type="button" onClick={() => { void af?.start(); }} disabled={slot?.phase === 'starting'} className="btn-key" data-fix-again>
              {tr('Run again')}
            </button>
          )}
          <button type="button" onClick={close} className="btn-key" data-fix-close>{tr('Close')}</button>
        </div>
      }>
      <div className="pb-3" data-fix-view="end" data-fix-run={run.status}>
        <p className={`flex min-w-0 items-center gap-2.5 font-display text-xl font-semibold leading-tight ${TONE_TEXT[head.tone]}`} data-fix-headline={head.kind}>
          <StatusGlyph tone={head.tone} size={18} />
          <span className="min-w-0">{head.text}</span>
        </p>
        {/* "Everything else is green" under "1 needs you" -- the solver down, and nothing else left -- muted, as in the
            sketch the owner saw: the headline is the amber line. */}
        {head.sub && <p className="mt-1 text-[12px] text-fog-400" data-fix-headline-sub>{head.sub}</p>}
        {run.status === 'stopped' && head.kind !== 'stopped' && (
          <p className="mt-1 text-[12px] text-fog-400">{tr('Stopped before it finished')}</p>
        )}
        {shown.length > 0 && (
          <ul className="mt-4 space-y-2" data-fix-done-list>
            {shown.map((d) => <DoneRow key={d.kind} d={d} />)}
          </ul>
        )}
        {needs.length > 0 && (
          <section className="mt-5" aria-label={tr('Needs you')}>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fog-500">{tr('Needs you')}</h3>
            <ul className="mt-1.5 divide-y divide-ink-800/70 rounded-xl border border-ink-700/60 bg-ink-900/40">
              {needs.map((nd, i) => (
                <li key={`${nd.check}:${i}`} className="flex min-w-0 items-center gap-3 px-3 py-2.5" data-fix-needs={nd.check}>
                  <StatusGlyph tone="warn" size={11} />
                  <p className="min-w-0 flex-1 break-words text-[13px] leading-snug text-fog-100">{nd.text}</p>
                  <NeedsKey k={nd.key} onShowCheck={onShowCheck} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {clears.length > 0 && (
          <section className="mt-5" aria-label={tr('Clears by itself')}>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fog-500">{tr('Clears by itself')}</h3>
            <ul className="mt-1.5 space-y-1">
              {clears.map((c, i) => (
                <li key={i} className="flex min-w-0 items-start gap-2 text-[12px] leading-snug text-fog-500" data-fix-clears>
                  <IcClock aria-hidden width={13} height={13} className="mt-px shrink-0" />
                  <span className="min-w-0 break-words">
                    <span>{c.text}</span>
                    {/* The time on one line: "in 3 / hours" split at a phone's edge. */}
                    {c.when && <span className="whitespace-nowrap">{` · ${c.when}`}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {(named.length > 0 || log.length > 0) && (
          <div className="mt-4" data-fix-details>
            <Disclosure label={tr('Details')}>
              {named.length > 0 && <ul className="space-y-2">{named.map((d) => <DoneRow key={d.kind} d={d} items />)}</ul>}
              {log.length > 0 && (
                <ol className={`${named.length ? 'mt-3' : ''} max-h-56 space-y-1 overflow-y-auto rounded-xl border border-ink-700/60 bg-ink-900/40 px-3 py-2`}
                  data-lenis-prevent data-fix-log>
                  {log.map((l, i) => <li key={i} className="text-[11px] leading-relaxed text-fog-400">{l}</li>)}
                </ol>
              )}
            </Disclosure>
          </div>
        )}
      </div>
    </Sheet>
  );
}

/**
 * Let me choose's safe repair, once this page pressed it: what it is doing until the live strip shows the run, then
 * what it did -- the line Fix all issues kept, which stays until the next press. Nothing before a press: the last one's
 * outcome is under Recent repairs.
 */
export function SafeRepairLine({ checks }: { checks: HealthCheck[] }) {
  const rr = useRepairRun();
  const slot = rr.slots.page;
  if (!slot) return null;
  const kind = kindOfBody(pageBody(pagePlan(checks)));
  const run = rr.status?.run && ((slot.runId && rr.status.run.id === slot.runId) || (!slot.runId && rr.status.run.kind === kind)) ? rr.status.run : null;
  const record = slot.runId ? rr.record(slot.runId) ?? pageRecord(rr.runs) : pageRecord(rr.runs);
  const state = rowState({ slot, run, record, action: 'safe_repair', onStop: run ? () => { void rr.stop('page'); } : undefined });
  // While it runs, the live strip below says it, with its Stop.
  if (state.kind === 'idle' || (state.kind === 'working' && run)) return null;
  return (
    <div className="full px-1" data-fix-safe-line>
      <p className="text-[11px] text-fog-500">{tr('Safe repair')}</p>
      <ActionStatus state={state} />
    </div>
  );
}
