'use client';
// Actions that say what they do, how, how long they take, and whether they are working (v0.49.0).
//
// The owner's complaint about Health, in four parts: you cannot tell what each fix does, how it does it,
// how long it takes, or whether it is working. Two presentations of one ActionSpec answer it:
//
// - ActionList / ActionRow: a full row -- the verb, one line of what it does, an optional "How it works",
//   the usual time, and a live status. Once per card, as the legend of what can be done there, and for the
//   big actions (a card's Fix all, the page's Fix all issues).
// - ActionKeys + ActionStatus: compact rectangular keys on each finding, with the same live status line
//   under the finding. A card can hold forty findings with three or four actions each, and a full row per
//   action would make a phone page thousands of pixels tall.
//
// ⚠️ The status line never clears itself. "Done · Took 2:04" or "The source did not answer" stays until the
// action runs again -- that lasting outcome is what the 3-second "Started" toast never gave anyone. The
// caller owns the state; nothing here resets it.
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { t as tr } from '@/lib/i18n';
import { useReduceEffects } from '@/lib/effects';
import { IDLE, actionButton, isBusy, stateSummary, type ActionState } from '@/lib/actionState';
import { TONE_GLYPH, TONE_TEXT } from '@/lib/status';
import { useTicker } from '@/lib/ticker';
import { ProgressRing } from './ProgressRing';
import { StatusGlyph } from './StatusMark';
import { IcAlert, IcCheck, IcChevronRight, IcClock } from './icons';

export interface ActionSpec {
  /** Stable per action, for keys and `data-action-row`. */
  id: string;
  /** The verb, translated: "Fill now". */
  label: string;
  /** One line of what it does, translated. */
  what: string;
  /** How it does it, translated; behind a "How it works" disclosure. */
  how?: string;
  /** How long it usually takes, already formatted (lib/format.ts `etaLine`). */
  eta?: string;
  icon?: ReactNode;
  /** The button's own word when it differs from the label ("Run" on a legend row). */
  runLabel?: string;
  danger?: boolean;
  primary?: boolean;
  disabled?: boolean;
  /** Why it is disabled, as the button's title. */
  disabledWhy?: string;
  state?: ActionState;
  /** Absent on a legend-only row, which then has no button. */
  onRun?: () => void;
  /**
   * Spread onto the button. Health passes `data-health-action`, which the walk41 browser test finds the
   * buttons by, so it must reach the <button> itself.
   */
  buttonProps?: ButtonHTMLAttributes<HTMLButtonElement> & Record<`data-${string}`, string>;
}

const keyClass = (a: Pick<ActionSpec, 'primary' | 'danger'>) =>
  `btn-key ${a.primary ? 'btn-key-primary' : ''} ${a.danger ? 'btn-key-danger' : ''}`;

/** The glyph for a state that is not idle: a ring while working, then a check, a warning, or a clock. */
function StateGlyph({ state, size }: { state: ActionState; size: number }) {
  switch (state.kind) {
    case 'starting':
      return <ProgressRing size={size} progress="spin" />;
    case 'working':
      return <ProgressRing size={size} progress={state.progress ?? 'spin'} />;
    case 'done':
      return state.partial
        ? <StatusGlyph tone="warn" size={size} />
        : <IcCheck aria-hidden width={size} height={size} strokeWidth={2.6} className={`shrink-0 ${TONE_GLYPH.accent}`} />;
    case 'failed':
      return <IcAlert aria-hidden width={size} height={size} strokeWidth={2.2} className={`shrink-0 ${TONE_GLYPH.problem}`} />;
    case 'refused':
      // Amber and a clock: it will work later, it did not break.
      return <IcClock aria-hidden width={size} height={size} strokeWidth={2.2} className={`shrink-0 ${TONE_GLYPH.warn}`} />;
    default:
      return null;
  }
}

/**
 * An action's live status line, under its row or its finding.
 *
 * The live region is ALWAYS mounted: a region that appears together with its first message is never
 * announced (the SaveState lesson, settings.tsx). It says only state changes -- "Working…", "Done: …",
 * "Failed: …" -- and the ticking clock beside the visible text is aria-hidden, or a screen reader would read
 * the time every second.
 */
export function ActionStatus({ state, bare, className }: {
  state?: ActionState;
  /** No glyph: the row already shows one in its first column. */
  bare?: boolean;
  className?: string;
}) {
  const s = state ?? IDLE;
  const working = s.kind === 'working';
  const now = useTicker(working);
  const plain = useReduceEffects();
  const sum = stateSummary(s, now);
  const p = working && typeof s.progress === 'number' && Number.isFinite(s.progress) ? Math.min(1, Math.max(0, s.progress)) : null;
  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">{sum.announce}</span>
      {s.kind !== 'idle' && (
        <div data-action-status={s.kind} className={className}>
          <p className={`mt-1.5 flex min-w-0 items-center gap-1.5 text-[11px] tabular-nums ${TONE_TEXT[sum.tone]}`}>
            {!bare && <StateGlyph state={s} size={12} />}
            {/* `dir="auto"`: a failure's reason is often the server's English sentence (a Test's diagnosis), which
                in an Arabic page printed its full stop first. A translated line resolves to its own language. */}
            <span dir="auto" className="min-w-0 break-words">{sum.text}</span>
            {sum.clock && <span aria-hidden className="ms-auto shrink-0 text-fog-500">{sum.clock}</span>}
          </p>
          {p !== null && (
            <div className="mt-1 h-[3px] overflow-hidden rounded-[2px] bg-ink-700">
              {/* Grows from the start edge, so it fills right-to-left in Arabic (--start, app/globals.css). */}
              <div className={`h-full origin-[var(--start)] bg-accent ${plain ? '' : 'transition-transform duration-500 ease-out'}`}
                style={{ transform: `scaleX(${p})` }} />
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** The full rows. */
export function ActionList({ actions, 'aria-label': ariaLabel }: { actions: ActionSpec[]; 'aria-label'?: string }) {
  return (
    <ul role="list" aria-label={ariaLabel} className="divide-y divide-ink-800/70">
      {actions.map((a) => <ActionRow key={a.id} {...a} />)}
    </ul>
  );
}

export function ActionRow(a: ActionSpec) {
  const state = a.state ?? IDLE;
  const btn = actionButton(state, a.runLabel);
  const stopping = state.kind === 'working' && !!state.stopping;
  return (
    <li data-action-row={a.id} data-action-state={state.kind}
      className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-start gap-x-3 py-3 first:pt-1 last:pb-1">
      <span className="mt-0.5 grid h-5 w-5 place-items-center text-fog-400">
        {state.kind === 'idle' ? a.icon : <StateGlyph state={state} size={16} />}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-fog-100">{a.label}</p>
        <p className="mt-0.5 max-w-prose text-[11px] leading-relaxed text-fog-400">{a.what}</p>
        {a.how && (
          <details className="group mt-1 text-[11px] text-fog-500">
            <summary className="inline-flex cursor-pointer select-none items-center gap-1 hover:text-fog-300">
              {tr('How it works')}
              {/* Mirrored on the outer span and turned on the inner one: combining the two on one element
                  turned the open chevron to point UP in Arabic. */}
              <span className="inline-grid rtl:-scale-x-100">
                <IcChevronRight aria-hidden width={12} height={12} className="transition group-open:rotate-90" />
              </span>
            </summary>
            {/* One step per line when a row explains several (Health's Fix all issues). */}
            <p className="mt-1 max-w-prose whitespace-pre-line leading-relaxed">{a.how}</p>
          </details>
        )}
        {a.eta && <p className="mt-1 text-[11px] tabular-nums text-fog-500">{a.eta}</p>}
        <ActionStatus state={state} bare />
      </div>
      {a.onRun && (
        <button type="button" {...a.buttonProps} className={keyClass(a)}
          // Busy disables it -- except as Stop, which is the one thing a running action's button is for.
          disabled={a.disabled || stopping || (isBusy(state) && !btn.stop)}
          title={a.disabled ? a.disabledWhy : undefined}
          onClick={btn.stop && state.kind === 'working' ? state.onStop : a.onRun}>
          {btn.label}
        </button>
      )}
    </li>
  );
}

/**
 * Compact keys on one finding. While any key of the group is busy, every key of it is disabled (the rule
 * HealthActions.tsx has had since v0.41.0: two repairs of one row at once race each other), and the busy one
 * shows a small ring in place of its icon. Its label stays the action's own verb; what happened is on the
 * ActionStatus line under the finding.
 */
export function ActionKeys({ actions, className }: { actions: ActionSpec[]; className?: string }) {
  const anyBusy = actions.some((a) => isBusy(a.state));
  return (
    <div data-action-keys className={`flex flex-wrap items-center gap-1.5 ${className ?? ''}`}>
      {actions.map((a) => {
        const state = a.state ?? IDLE;
        const busy = isBusy(state);
        const btn = actionButton(state, a.runLabel ?? a.label);
        const stopping = state.kind === 'working' && !!state.stopping;
        return (
          <button key={a.id} type="button" {...a.buttonProps} className={keyClass(a)}
            disabled={a.disabled || stopping || (anyBusy && !btn.stop)}
            title={a.disabled && a.disabledWhy ? a.disabledWhy : a.what}
            aria-busy={busy || undefined}
            onClick={btn.stop && state.kind === 'working' ? state.onStop : a.onRun}>
            {busy ? <ProgressRing size={12} progress="spin" /> : a.icon}
            <span>{btn.stop ? btn.label : (a.runLabel ?? a.label)}</span>
          </button>
        );
      })}
    </div>
  );
}
