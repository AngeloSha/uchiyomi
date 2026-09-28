/**
 * The live state of an action, and what its row says about it (v0.49.0).
 *
 * The owner could not tell, on Health, what a fix does, how, how long it takes, or whether it was working:
 * a button went grey, a toast said "Started" for three seconds and pointed at another tab, and the result
 * never came back to the row that asked for it. Every action row (components/ActionList.tsx) now carries
 * one of these states, and this is the part with no React in it -- the words, the tone and the clock for
 * each state -- so a test can hold them.
 *
 * ⚠️ A `done` or `failed` state is never cleared here or by the row that shows it. That line is the lasting
 * outcome the owner asked for; only the caller, starting the action again, replaces it.
 */
import { t as tr } from './i18n';
import { formatClock, type Eta } from './format';
import type { Tone } from './status';

export type { Eta };
export { etaLine, formatClock } from './format';

export type ActionState =
  | { kind: 'idle' }
  /** Pressed, and the server has not answered yet. */
  | { kind: 'starting' }
  | {
    kind: 'working';
    /** When the work began (epoch ms), for the ticking clock. */
    startedAt: number;
    /** What it is doing now, already translated: "Short chapters", "Checking the result…". */
    step?: string;
    /** 1-based, with `stepCount`, for "Step 2 of 4". */
    stepIndex?: number;
    stepCount?: number;
    /** 0..1 when the work knows how far it has got; null or absent when it does not. */
    progress?: number | null;
    /** What it is working on, already translated: "Walk Tale ch 3". */
    detail?: string;
    /** Present when the work can be stopped: the row's button becomes Stop. */
    onStop?: () => void;
    stopping?: boolean;
  }
  | {
    kind: 'done';
    finishedAt: number;
    /** How long it took, for "Took 2:04". */
    tookMs?: number;
    /** What it did, already translated: "Replaced with a 24-page copy". */
    outcome: string;
    /** It finished but did not do all of it (a source did not answer): amber, not the accent. */
    partial?: boolean;
  }
  | { kind: 'failed'; finishedAt?: number; reason: string }
  /**
   * The server would not start it: a sweep is running, a repair already is. Amber, not red -- the action is
   * fine and will work later, and healthActions.test.ts has long required the refusals to read differently
   * from a failure.
   */
  | { kind: 'refused'; reason: string };

export const IDLE: ActionState = { kind: 'idle' };

/** Starting or working: its buttons are disabled, and its siblings' too. */
export function isBusy(s: ActionState | undefined | null): boolean {
  return !!s && (s.kind === 'starting' || s.kind === 'working');
}

export interface StateSummary {
  tone: Tone;
  /** The visible line, empty when idle. */
  text: string;
  /** The ticking "1:24" while working, "Took 2:04" when done; shown aria-hidden, never announced. */
  clock?: string;
  /**
   * What the live region says. It changes only when the STATE does -- never per tick -- so a screen reader
   * hears "Working…" once and "Done: …" once, instead of the time every second.
   */
  announce: string;
}

/** A state as its row's status line, at time `now`. */
export function stateSummary(s: ActionState, now: number): StateSummary {
  switch (s.kind) {
    case 'idle':
      return { tone: 'info', text: '', announce: '' };
    case 'starting':
      return { tone: 'accent', text: tr('Starting…'), announce: tr('Starting…') };
    case 'working': {
      if (s.stopping) return { tone: 'accent', text: tr('Stopping…'), clock: formatClock(now - s.startedAt), announce: tr('Stopping…') };
      const counted = !!s.stepIndex && !!s.stepCount && s.stepCount > 1;
      const head = counted
        ? (s.step ? tr('Step {i} of {n} · {step}', { i: s.stepIndex!, n: s.stepCount!, step: s.step }) : tr('Step {i} of {n}', { i: s.stepIndex!, n: s.stepCount! }))
        : (s.step || tr('Working…'));
      return {
        tone: 'accent',
        text: s.detail ? `${head} · ${s.detail}` : head,
        clock: formatClock(now - s.startedAt),
        announce: tr('Working…'),
      };
    }
    case 'done':
      return {
        tone: s.partial ? 'warn' : 'accent',
        text: s.outcome,
        clock: s.tookMs != null && Number.isFinite(s.tookMs) ? tr('Took {clock}', { clock: formatClock(s.tookMs) }) : undefined,
        announce: tr('Done: {outcome}', { outcome: s.outcome }),
      };
    case 'failed':
      return { tone: 'problem', text: s.reason, announce: tr('Failed: {reason}', { reason: s.reason }) };
    case 'refused':
      return { tone: 'warn', text: s.reason, announce: s.reason };
  }
}

/**
 * What a row's button says in each state, and whether it is the Stop button. The label for running it is
 * the caller's own verb ("Fill now"); after a failure it offers to try again, after success to run again.
 */
export function actionButton(s: ActionState, runLabel?: string): { label: string; stop: boolean } {
  switch (s.kind) {
    case 'starting':
      return { label: tr('Starting…'), stop: false };
    case 'working':
      if (s.onStop) return { label: s.stopping ? tr('Stopping…') : tr('Stop'), stop: true };
      return { label: runLabel ?? tr('Run'), stop: false };
    case 'failed':
      return { label: tr('Try again'), stop: false };
    case 'done':
      return { label: runLabel ?? tr('Run again'), stop: false };
    default:
      return { label: runLabel ?? tr('Run'), stop: false };
  }
}
