'use client';
// The settings primitives: one vocabulary for every row on the profile's Settings / Connections / Account
// tabs and on Admin → Settings.
//
// Before v0.39.0 those pages had three save idioms side by side (full-width "Save name" buttons, switches
// that saved on their own, a dirty-tracked Save chip), cards of every shape, and no feedback for the rows
// that autosaved -- you flipped a switch and trusted it. Everything here saves on change (or on blur/Enter
// for typed fields) and says so in ONE place, the `SaveState` live region at the end of the row. Toasts are
// kept for actions with side effects (revoke, generate, log out others), never for "your setting stuck".
//
// House rules that every row here relies on: logical properties only (`ms`/`pe`/`text-start`), because the
// profile ships in Arabic and a `ml-auto` control block would sit on the wrong side of its label there; no
// width cap wider than `max-w-prose`/`.field`, because the owner's "768 px ribbon" complaint was exactly a
// settings grid living inside a capped container on a 2560 px display.
import Link from 'next/link';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode, type Ref, type RefObject } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Switch } from './Switch';
import { msgOf } from './ConfirmDialog';
import { OnBody, Sheet, useRtl } from './ui';
import { IcCheck, IcChevronRight } from './icons';
import { useReduceEffects } from '@/lib/effects';
import { arrival } from '@/lib/destinations';
import { openInConsole } from '@/lib/consoleOnScreen';
import { t as tr } from '@/lib/i18n';

export type SaveStatus = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string };
const IDLE: SaveStatus = { kind: 'idle' };
/** How long the tick stays before it fades. Long enough to be seen after a Tab away, short enough that a
 *  row edited twice in a row reads as two saves rather than one that never ends. */
const SAVED_MS = 1500;

/**
 * Where a row sits decides its padding (v0.86.0). Loose, the rhythm every row had before: rows down a card, the first
 * and last flush with its title and its end. In a `RowGroup`, an inset list: each row padded on all sides, so the hairline
 * between rows runs edge to edge and a whole-row button (`SummaryRow`) lights up to the card's edge. Bare, inside a
 * `RowBlock`, which pads the row and what hangs under it as one. ProfileMenu, Edit details and the source sheet render
 * rows with no group around them, and keep exactly the loose rhythm they had.
 */
type Pad = 'loose' | 'group' | 'bare';
const RowPad = createContext<Pad>('loose');
const PAD: Record<Pad, string> = { loose: 'py-3 first:pt-1 last:pb-0', group: 'px-4 py-3', bare: '' };
/** Help folded to two lines (v0.86.0): on the settings pages' groups, not in an editor, which is where the detail lives. */
const Folded = createContext(false);

/**
 * The settings grid: more columns on a wider display, never wider columns, and NO cap.
 *
 * ⚠️ Never add a `max-w-*` here or on anything that holds it. `layout.mjs` fails any container with a
 * max-width between 700 and 1500 px holding three or more children, because that is what produced the
 * "768 px ribbon" of settings down the middle of a 2560 px screen. Line length is bounded where it matters
 * instead: `max-w-prose` on help text and `.field` on inputs, both under 700 px.
 */
export const SETTINGS_GRID = 'grid items-start gap-3 lg:gap-4 xl:grid-cols-2 3xl:grid-cols-3';

/**
 * The one feedback idiom for a setting.
 *
 * ALWAYS in the DOM, even while idle: a live region announces changes to content that was already there
 * when the page loaded. A `<span role="status">` that mounts together with "Saved" is new content, not a
 * change, and screen readers say nothing -- so the region is rendered empty first and filled later.
 *
 * The tick fades rather than vanishing because a 1500 ms label that blinks out reads as an error to
 * peripheral vision; the fade is 0 s under reduced motion. `mode="wait"` keeps the three states from
 * overlapping inside the fixed-width span while one is still on its way out.
 *
 * `max-w-56 truncate`: the error branch shows the server's own sentence. Unbounded, a long message made
 * the control block wider than the card at 390 px and the whole page scrolled sideways; capped, it wraps
 * under the control on its own line (the block is `flex-wrap`, see Row) and clips there. The full sentence
 * is still announced (the live region reads the text, not the clip) and is on the title.
 */
export function SaveState({ status }: { status: SaveStatus }) {
  const still = useReducedMotion();
  const fade = { duration: still ? 0 : 0.25 };
  const snap = { duration: 0 };
  return (
    <span role="status" aria-live="polite" title={status.kind === 'error' ? status.message : undefined}
      className="min-w-14 max-w-56 truncate text-end text-[11px] tabular-nums">
      <AnimatePresence mode="wait" initial={false}>
        {status.kind === 'saving' && (
          <motion.span key="saving" initial={{ opacity: 1 }} exit={{ opacity: 0 }} transition={snap} className="text-fog-500">
            {tr('Saving…')}
          </motion.span>
        )}
        {status.kind === 'saved' && (
          <motion.span key="saved" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade} className="text-accent">
            {'✓ ' + tr('Saved')}
          </motion.span>
        )}
        {status.kind === 'error' && (
          <motion.span key="error" initial={{ opacity: 1 }} exit={{ opacity: 0 }} transition={snap} className="text-rose-300">
            {status.message}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

/**
 * Where the autosaves inside a `SaveScope` report: `from` is the reporting hook's own id.
 */
type SaveReport = (from: string, status: SaveStatus) => void;
const ScopeReport = createContext<SaveReport | null>(null);

/**
 * Whether a report from `from` is what a scope's label shows now that `owner` sent the last one it showed: a save
 * that starts, and any error, always; the rest of a save's life only while it is still the latest.
 */
export const scopeTakes = (owner: string, from: string, s: SaveStatus): boolean =>
  s.kind === 'saving' || s.kind === 'error' || from === owner;

/**
 * One `SaveState` for a whole surface instead of one per row (v0.53.0, Edit details).
 *
 * A dialog of tabs has no row end the eye returns to, and a tick beside each of twenty fields is the "Saved in
 * two places" this file exists to remove once a header also says it. So every `useAutosave` under a `SaveScope`
 * reports here, and the rows under it draw no `SaveState` of their own (`Row` checks).
 *
 * The label is the LATEST save's: a run that starts takes it, and the end of an older one is not shown over it.
 * An error always takes it, whoever sent it -- a failure hidden behind a later "Saved" is a setting the person
 * believes stuck.
 */
export function useSaveScope(): { status: SaveStatus; report: SaveReport } {
  const [status, setStatus] = useState<SaveStatus>(IDLE);
  const owner = useRef('');
  const report = useCallback<SaveReport>((from, s) => {
    if (!scopeTakes(owner.current, from, s)) return;
    owner.current = from;
    setStatus(s);
  }, []);
  return { status, report };
}

/** The rows under it report to `report` (from `useSaveScope`) and leave the feedback to its one `SaveState`. */
export function SaveScope({ report, children }: { report: SaveReport; children: ReactNode }) {
  return <ScopeReport.Provider value={report}>{children}</ScopeReport.Provider>;
}

/**
 * Drive a `SaveState` from a promise.
 *
 * `run(fn)` shows Saving…, awaits `fn`, shows the tick for `SAVED_MS`, then goes idle; a throw shows the
 * server's own sentence (via `msgOf`) until the next run. It resolves `true`/`false` rather than throwing so
 * an optimistic control (`SwitchRow`) can revert without a try/catch at every call site.
 *
 * One timer, owned here: a second `run` before the first tick has faded clears the pending timer, or the
 * first save's timer would blank the second save's tick early. Unmount clears it too, or a row unmounted
 * mid-tick would set state on a component that is gone. A result that lands AFTER a newer run started is
 * ignored for the label (the newer run owns it) but still reported to its caller.
 *
 * Under a `SaveScope` every state is reported to it as well, for the surface's one label.
 *
 * NEVER toasts. Toasts are for actions with side effects; a setting that says "Saved" in two places at
 * once is the noise this file exists to remove.
 */
export function useAutosave(): { status: SaveStatus; run: (fn: () => Promise<unknown> | unknown) => Promise<boolean> } {
  const [status, setStatus] = useState<SaveStatus>(IDLE);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);
  const alive = useRef(true);
  const me = useId();
  const report = useContext(ScopeReport);
  const show = useCallback((s: SaveStatus) => { setStatus(s); report?.(me, s); }, [report, me]);
  const clear = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; clear(); };
  }, [clear]);
  const run = useCallback(async (fn: () => Promise<unknown> | unknown): Promise<boolean> => {
    const mine = ++seq.current;
    clear();
    show({ kind: 'saving' });
    try {
      await fn();
      // A save that lands after the row is gone (a tab switch mid-request) must not arm a timer nobody
      // will clear; one that lands after a NEWER run started leaves the label to that run.
      if (alive.current && mine === seq.current) {
        show({ kind: 'saved' });
        clear();
        timer.current = setTimeout(() => { timer.current = null; show(IDLE); }, SAVED_MS);
      }
      return true;
    } catch (e) {
      if (alive.current && mine === seq.current) show({ kind: 'error', message: msgOf(e, tr('Could not save')) });
      return false;
    }
  }, [clear, show]);
  return { status, run };
}

/**
 * A titled card of rows. Keeps `.card` because `scripts/shots/capture.mjs` crops by that class.
 *
 * `ref` is a plain prop (React 19) so a section can be scrolled into view by whoever renders it -- the
 * tracking section still answers `?card=tracking` from the import page that way. `id` names it for the search
 * palette's `?section=` (v0.55.4, lib/useSectionArrival.ts), and the scroll margin keeps it clear of the desktop's
 * sticky top bar when it is scrolled to.
 *
 * ⚠️ `min-w-0` on the `<section>` is load-bearing. A grid item's minimum width is its content's minimum
 * width, so one row that came out wider than the card (a Japanese pill group) widened the grid column and
 * the page scrolled sideways at 390 px. With it, the card holds its width and the row inside wraps.
 */
export function Section({ title, description, icon, action, id, className, ref, children }: {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  id?: string;
  className?: string;
  ref?: Ref<HTMLElement>;
  children: ReactNode;
}) {
  const hid = useId();
  return (
    <section ref={ref} id={id} aria-labelledby={hid} className={`card grad-border min-w-0 p-4 scroll-mt-4 lg:scroll-mt-20 ${className ?? ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {icon && <span aria-hidden className="shrink-0 text-accent">{icon}</span>}
          <h2 id={hid} className="font-display text-base font-semibold">{title}</h2>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {description && <p className="mt-0.5 max-w-prose text-xs text-fog-500">{description}</p>}
      <div className="mt-2 divide-y divide-ink-800/80">{children}</div>
    </section>
  );
}

/**
 * One row: a label (and help) at the start, the control and its `SaveState` at the end.
 *
 * ⚠️ `flex-wrap` + `basis-32` + `ms-auto` is not decoration. A three-option `Segmented` beside
 * "Wiederholte Seiten" does not fit in the 324 px a card leaves at 390 px; with these three the control
 * wraps under the label and stays end-aligned, in both directions. Without `flex-wrap` it squeezed the
 * label to one letter per line; without `ms-auto` the wrapped control sat under the label's start.
 * `basis-32` rather than `basis-48`: 192 px reserved for a one-word label made Mode and Theme wrap their
 * pills under the label in a 434 px column at 1280 while Fit stayed inline, every second row two lines.
 *
 * ⚠️ The control block itself wraps too (`max-w-full flex-wrap justify-end`, and never `shrink-0`). Pills
 * plus the 56 px status span plus their gap came to more than the row in six of the eight languages, and a
 * block that could neither shrink nor wrap pushed "✓ Gespeichert" through the card's edge for the 1.5 s it
 * showed, and in Japanese the pills alone did that while idle. Now the status drops under the pills,
 * end-aligned, when it does not fit beside them. Reintroduce by putting `shrink-0` back: the page scrolls
 * sideways at 390 px in ja and fr.
 *
 * `stacked` is for controls that want the full width: a chip grid, the avatar picker, a text field, a
 * range. The label line then carries the `SaveState`.
 *
 * Under a `SaveScope` there is no `SaveState` here at all: the scope's one label says it (see useSaveScope).
 *
 * The padding is the place's (`RowPad`): the loose rhythm down a card, an inset row in a `RowGroup`, none in a `RowBlock`.
 */
export function Row({ label, help, htmlFor, stacked, status, id, device, className, children }: {
  label: ReactNode;
  help?: ReactNode;
  htmlFor?: string;
  stacked?: boolean;
  status?: SaveStatus;
  id?: string;
  /** Kept by this browser, not by the account: a small tag after the label says so (`DeviceTag`). */
  device?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const scoped = useContext(ScopeReport) !== null;
  const pad = PAD[useContext(RowPad)];
  const name = device ? <>{label}<DeviceTag /></> : label;
  // A `<label>` only when there is a control to point at; a `<label>` with nothing to label is announced as
  // one anyway and confuses the reading order.
  const labelEl = htmlFor
    ? <label htmlFor={htmlFor} className="text-sm text-fog-100">{name}</label>
    : <p className="text-sm text-fog-100">{name}</p>;
  const helpEl = help != null && help !== false ? <Help>{help}</Help> : null;
  if (stacked) {
    return (
      <div id={id} className={`${pad} ${className ?? ''}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">{labelEl}{helpEl}</div>
          {!scoped && <SaveState status={status ?? IDLE} />}
        </div>
        <div className="mt-2">{children}</div>
      </div>
    );
  }
  return (
    <div id={id} className={`flex flex-wrap items-center gap-x-4 gap-y-2 ${pad} ${className ?? ''}`}>
      <div className="min-w-0 flex-1 basis-32">{labelEl}{helpEl}</div>
      <div className="ms-auto flex max-w-full flex-wrap items-center justify-end gap-2">
        {children}
        {!scoped && <SaveState status={status ?? IDLE} />}
      </div>
    </div>
  );
}

/**
 * A switch that saves as it flips.
 *
 * The knob moves at once and the save follows: a switch that waits for the round trip before moving feels
 * broken on a slow link, and people flip it again. The local value holds until the prop catches up (the
 * caller's query refetch) and reverts when `run` reports a failure, so the switch never shows a state the
 * server refused. It is NOT disabled while saving -- a disabled button drops focus, and keyboard users
 * would lose their place on every flip.
 */
export function SwitchRow({ label, help, on, disabled, id, device, onChange }: {
  label: string;
  help?: ReactNode;
  on: boolean;
  disabled?: boolean;
  id?: string;
  device?: boolean;
  onChange: (next: boolean) => Promise<unknown> | unknown;
}) {
  const { status, run } = useAutosave();
  const [local, setLocal] = useState(on);
  // The prop catching up is adopted DURING render (React's "previous prop" pattern), not in an effect: an
  // effect would paint one frame of the stale value first, which on a switch is a visible double-flip.
  const [seen, setSeen] = useState(on);
  if (on !== seen) { setSeen(on); setLocal(on); }
  const flip = async (next: boolean) => {
    setLocal(next);
    const ok = await run(() => onChange(next));
    if (!ok) setLocal(on);
  };
  return (
    <Row id={id} label={label} help={help} status={status} device={device}>
      <Switch on={local} onChange={(next) => { void flip(next); }} disabled={disabled} label={label} />
    </Row>
  );
}

/**
 * A pill radio group, for a setting with two to five named values.
 *
 * ARIA radio semantics rather than a row of toggle buttons: a screen reader then says "Paged, radio button,
 * 2 of 2, checked" instead of three unrelated buttons. Roving tabindex means ONE tab stop per group, with
 * the arrows moving inside it -- and ArrowLeft/ArrowRight swap under RTL so "next" is still the pill in
 * the reading direction. `value: null` checks nothing (a custom weekly goal); the first pill is then the
 * tab stop, or the group would be unreachable from the keyboard.
 *
 * ⚠️ `layoutId` comes from `useId()` and is unique PER INSTANCE. BottomNav's pill is `"navpill"` because
 * there is exactly one nav; with a shared id here the pill would fly from the Theme row to the Mode row
 * whenever either changed.
 *
 * ⚠️ The group is `max-w-full flex-wrap`, never wider than the row it sits in. "ウェブトゥーン（スクロール）"
 * beside "ページ送り（スワイプ）" is 353 px of pills in a 324 px row, and an `inline-flex` that cannot wrap
 * ran past the card and scrolled the page sideways at 390 px. Wrapped, the second pill sits under the
 * first inside the same rounded border; nothing is clipped and nothing leaves the card.
 *
 * Square, 8 px corners: the owner's "no more pills" (v0.53.0 brought `square` to Edit details; since v0.86.0 it is the
 * only shape, and `square` is still accepted so no caller changes). A wrapped square group also reads as one grid of
 * choices, where a capsule bent around two rows does not.
 *
 * The checked mark slides only when motion is welcome: still under Reduce effects as under the system's reduced
 * motion, as the Library's tabs are.
 *
 * An option with an `icon` (v0.60.0, the Library's layouts) shows the icon alone -- pass it `aria-hidden` -- and its label
 * is the radio's name, for a screen reader, and its hover.
 */
export function Segmented<T extends string>({ label, value, options, disabled, onChange }: {
  label: string;
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string; icon?: ReactNode }>;
  disabled?: boolean;
  square?: boolean;
  onChange: (v: T) => void;
}) {
  const id = useId();
  // Both hooks on every render and in this order (ProgressRing.tsx says why).
  const plain = useReduceEffects();
  const still = useReducedMotion();
  const rtl = useRtl();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const checked = options.findIndex((o) => o.value === value);
  const pick = (i: number) => {
    const o = options[i];
    if (!o) return;
    // Re-picking the checked pill is not a change: no save, no tick.
    if (o.value !== value) onChange(o.value);
    refs.current[i]?.focus();
  };
  const onKey = (e: { key: string; preventDefault: () => void }, i: number) => {
    const next = radioKey(e.key, i, options.length, rtl);
    if (next === null) return;
    e.preventDefault();
    pick(next);
  };
  return (
    <div role="radiogroup" aria-label={label}
      className={`relative inline-flex max-w-full flex-wrap gap-0.5 rounded-xl border border-ink-700 bg-ink-850 p-0.5 ${disabled ? 'opacity-40' : ''}`}>
      {options.map((o, i) => {
        const selected = i === checked;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (checked === -1 && i === 0) ? 0 : -1}
            disabled={disabled}
            ref={(el) => { refs.current[i] = el; }}
            onClick={() => pick(i)}
            onKeyDown={(e) => onKey(e, i)}
            title={o.icon ? o.label : undefined}
            className={`relative rounded-lg ${o.icon ? 'px-2' : 'px-3'} py-1.5 text-xs disabled:cursor-not-allowed`}
          >
            {selected && (
              <motion.span aria-hidden layoutId={id} className="absolute inset-0 rounded-lg bg-accent-soft"
                transition={still || plain ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 34 }} />
            )}
            {o.icon
              ? <span className={`relative grid h-4 place-items-center ${selected ? 'text-accent' : 'text-fog-400'}`}>{o.icon}<span className="sr-only">{o.label}</span></span>
              : <span className={`relative ${selected ? 'text-accent' : 'text-fog-300'}`}>{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A text field that saves when you leave it.
 *
 * The draft is local while the field has focus and follows `value` otherwise, so a refetch cannot overwrite
 * half a word. It commits on blur and on Enter ONLY, never in onChange -- a server name saved per keystroke
 * is sixty PATCHes and a "Saved" that flickers the whole time you type.
 *
 * ⚠️ Enter then Tab must not save twice. `last` is what the server holds as far as this row knows: the prop
 * on arrival, then whatever was just sent. Comparing the draft with the PROP alone is not enough, because the
 * prop only catches up after the caller's refetch, and the blur that follows an Enter lands before that.
 * Escape puts the draft back to `last`, i.e. to what is actually saved.
 *
 * ⚠️ The sync effect is keyed on `value` ALONE and reads focus through a ref. Keyed on focus as well, the
 * blur that commits also re-ran it and snapped the field back to the OLD prop until the refetch landed --
 * and for good, when a caller's refetch returns the same value it already had.
 *
 * `required`: an emptied field goes back to the last saved value instead of being sent, the way
 * `NumberRow` already treats an empty box. The server refuses an empty name with a bare 400, which the row
 * could only render as "Could not save" over a box that stayed empty until Escape.
 *
 * An Escape that puts an edit back is that and nothing more: it is marked handled, so a dialog around the row
 * does not also close on it and drop the edit unsaved (Edit details closes on an unhandled Escape). `dir`: a
 * value in another script than the interface -- a series title -- keeps its own direction (`auto`).
 */
export function TextRow({ label, help, value, onSave, placeholder, maxLength, id, autoComplete, required, dir }: {
  label: string;
  help?: ReactNode;
  value: string;
  onSave: (v: string) => Promise<unknown>;
  placeholder?: string;
  maxLength?: number;
  id?: string;
  autoComplete?: string;
  required?: boolean;
  dir?: 'auto' | 'ltr' | 'rtl';
}) {
  const auto = useId();
  const fid = id ?? auto;
  const { status, run } = useAutosave();
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const setFocused = (f: boolean) => { focused.current = f; };
  const last = useRef(value);
  useEffect(() => {
    last.current = value;
    if (!focused.current) setDraft(value);
  }, [value]);
  const commit = () => {
    const next = draft.trim();
    if (required && !next) { setDraft(last.current); return; }
    if (next === last.current) return;
    last.current = next;
    void run(async () => {
      try { await onSave(next); } catch (e) { last.current = value; throw e; }
    });
  };
  return (
    <Row label={label} help={help} htmlFor={fid} stacked status={status}>
      <input
        id={fid}
        className="field"
        dir={dir}
        value={draft}
        placeholder={placeholder}
        maxLength={maxLength}
        required={required}
        autoComplete={autoComplete}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commit(); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') {
            if (draft !== last.current) e.preventDefault();
            setDraft(last.current);
          }
        }}
      />
    </Row>
  );
}

/**
 * A number field with the same blur/Enter/Escape rules as `TextRow`.
 *
 * Commit clamps `Math.floor(n)` into `[min, max]` and shows the clamped value, so typing 200 into an
 * interval capped at 168 saves 168 and SAYS 168 rather than saving something the field no longer shows.
 * Empty reverts to the last saved value instead of saving 0: an empty field is a deleted field, and 0 is a
 * legal value here ("Wait 0 days"), so the two cannot share a meaning.
 *
 * ⚠️ Untouched is not a change, and that is checked BEFORE the clamp. The stored value may sit outside
 * `[min, max]` on purpose -- a weekly goal of 0 means "no goal", and the Custom box (min 1) shows it as 0
 * -- and clamping first turned a plain focus-and-Tab through the row into a PUT of 1 and a goal ring in the
 * hero. Only a number the person actually entered is clamped and saved.
 */
export function NumberRow({ label, help, value, onSave, min, max, step, unit, id }: {
  label: string;
  help?: ReactNode;
  value: number;
  onSave: (n: number) => Promise<unknown>;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  id?: string;
}) {
  const auto = useId();
  const fid = id ?? auto;
  const hid = `${fid}-help`;
  const { status, run } = useAutosave();
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);
  const setFocused = (f: boolean) => { focused.current = f; };
  const last = useRef(value);
  // Keyed on `value` alone, for the reason given on TextRow.
  useEffect(() => {
    last.current = value;
    if (!focused.current) setDraft(String(value));
  }, [value]);
  const commit = () => {
    const raw = draft.trim();
    const parsed = Number(raw);
    if (raw === '' || !Number.isFinite(parsed)) { setDraft(String(last.current)); return; }
    if (parsed === last.current) { setDraft(String(last.current)); return; }
    const n = Math.min(max, Math.max(min, Math.floor(parsed)));
    setDraft(String(n));
    if (n === last.current) return;
    last.current = n;
    void run(async () => {
      try { await onSave(n); } catch (e) { last.current = value; throw e; }
    });
  };
  return (
    <Row label={label} help={help != null ? <span id={hid}>{help}</span> : undefined} htmlFor={fid} status={status}>
      <input
        id={fid}
        type="number"
        inputMode="numeric"
        className="field w-24"
        min={min}
        max={max}
        step={step}
        value={draft}
        aria-describedby={help != null ? hid : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commit(); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') setDraft(String(last.current));
        }}
      />
      {unit && <span className="text-xs text-fog-500">{unit}</span>}
    </Row>
  );
}

/**
 * A slider. It writes on EVERY change -- the caller's store debounces (the reader prefs store already
 * waits 1.5 s before its PUT), and a slider that only wrote on release would leave the reader's brightness
 * preview lagging the thumb. The tick flashes on release (pointerup/keyup/blur) only, and only if the value
 * moved: forty ticks during one drag would be forty announcements to a screen reader.
 */
export function RangeRow({ label, value, min, max, step, format, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const fid = useId();
  const [status, setStatus] = useState<SaveStatus>(IDLE);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moved = useRef(false);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const settle = () => {
    if (!moved.current) return;
    moved.current = false;
    if (timer.current) clearTimeout(timer.current);
    setStatus({ kind: 'saved' });
    timer.current = setTimeout(() => { timer.current = null; setStatus(IDLE); }, SAVED_MS);
  };
  return (
    <Row label={`${label} · ${format(value)}`} htmlFor={fid} stacked status={status}>
      <input
        id={fid}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => { moved.current = true; onChange(Number(e.target.value)); }}
        onPointerUp={settle}
        onKeyUp={settle}
        onBlur={settle}
        className="w-full accent-[rgb(var(--accent))]"
      />
    </Row>
  );
}

/**
 * A row that leads somewhere. The WHOLE row is the target -- a `<Link>` when it has an address, a
 * `<button>` otherwise -- so there is no button inside a link and no dead space beside a small chip.
 * The chevron mirrors under RTL because "onward" points the other way there.
 */
export function LinkRow({ href, label, help, onClick }: {
  href?: string;
  label: string;
  help?: ReactNode;
  onClick?: () => void;
}) {
  const cls = `group flex w-full items-center gap-3 text-start ${PAD[useContext(RowPad)]}`;
  const inner = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-fog-100">{label}</span>
        {help != null && help !== false && <span className="block max-w-prose text-[11px] leading-relaxed text-fog-500">{help}</span>}
      </span>
      <IcChevronRight width={18} height={18} aria-hidden className="shrink-0 text-fog-500 transition group-hover:text-fog-200 rtl:-scale-x-100" />
    </>
  );
  return href
    ? <Link href={href} onClick={onClick} className={cls}>{inner}</Link>
    : <button type="button" onClick={onClick} className={cls}>{inner}</button>;
}

/**
 * A small "show more" under a row, for the paragraph that explains a switch without sitting in the way of
 * it. Controlled (`open` + `onOpenChange`) or uncontrolled (`defaultOpen`): the install-count consent
 * disclosure is controlled because switching consent ON has to open it -- what is sent must be visible at
 * the moment of consent. `id` names the CONTENT (`aria-controls` points at it).
 */
export function Disclosure({ label, open, defaultOpen, onOpenChange, id, children }: {
  label: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (o: boolean) => void;
  id?: string;
  children: ReactNode;
}) {
  const auto = useId();
  const cid = id ?? auto;
  const [inner, setInner] = useState(!!defaultOpen);
  const isOpen = open ?? inner;
  const toggle = () => {
    const next = !isOpen;
    if (open === undefined) setInner(next);
    onOpenChange?.(next);
  };
  return (
    <div>
      {/* `py-1.5` with the margins pulled in by the same amount: a bare 12 px line was a 16 px tap target
          on a phone, so the padding makes it 28 px while `mt-0.5` (2 + 6 = the old 8) and `-mb-1.5` keep
          the text exactly where it was in the rhythm. */}
      <button type="button" aria-expanded={isOpen} aria-controls={cid} onClick={toggle}
        className="mt-0.5 -mb-1.5 flex items-center gap-1 py-1.5 text-xs text-fog-400 hover:text-fog-200">
        {label}
        {/* A down chevron that rotates rather than a right one that points: it needs no mirroring. */}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`transition-transform ${isOpen ? 'rotate-180' : ''}`}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {isOpen && <div id={cid} className="mt-2">{children}</div>}
    </div>
  );
}

/* ============================ v0.86.0: the settings redesign ============================ */
//
// The owner, 2026-10-19: "a million toggle in setting and a million section a million pill … organized, look cooler,
// more user friendly … easier to find, understand what it does". Profile → Settings and Admin → Settings became a few
// categories with search (components/SettingsLayout.tsx; the console's pages since v0.88.0, components/ConsoleLayout.tsx), each a short page of titled groups. The pieces below are what
// those groups are made of: the inset group itself, pictures for choices that are easier seen than named, the
// platform's own menu for long lists, one summary row for a setting too big for a row (it opens an editor), and a fold
// for the rows few people change. Every one saves the way the rows above do -- at once, with the tick at its end.

/** Where search or `?section=` asked the settings to go (components/ConsoleLayout.tsx): a row, and the More options or
 *  editor that holds it, which open themselves for it. `seq` makes the same row asked for twice two arrivals. */
export interface SettingsTarget { row: string; more?: string; editor?: string; seq: number }
export const SettingsGo = createContext<SettingsTarget | null>(null);

/**
 * The arrow keys of a radio group, as `Segmented` has always read them: the next or previous option in the reading
 * direction (ArrowLeft is "next" under RTL), ArrowDown/ArrowUp likewise, Home and End. `null` for any other key.
 */
export function radioKey(key: string, i: number, n: number, rtl: boolean): number | null {
  const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
  const back = rtl ? 'ArrowRight' : 'ArrowLeft';
  if (key === forward || key === 'ArrowDown') return (i + 1) % n;
  if (key === back || key === 'ArrowUp') return (i - 1 + n) % n;
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  return null;
}

/**
 * A row's help, folded to two lines in a settings group until asked for (v0.86.0). The page used to show seventeen
 * paragraphs at once, and the switches drowned in them. Folded, not cut: the whole sentence is in the DOM -- a screen
 * reader reads it all, and the settings search matches it -- and "More" opens it where it is. "More" shows only when
 * the text really runs past two lines, measured, so a short help never offers to open.
 */
function Help({ children }: { children: ReactNode }) {
  const folded = useContext(Folded);
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!folded || !el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [folded, children]);
  const cls = 'max-w-prose text-[11px] leading-relaxed text-fog-500';
  if (!folded) return <p className={cls}>{children}</p>;
  return (
    <>
      <p ref={ref} className={`${cls} ${open ? '' : 'line-clamp-2'}`}>{children}</p>
      {(long || open) && (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
          className="-my-1 py-1 text-[11px] font-medium text-fog-400 hover:text-fog-100">
          {open ? tr('Less') : tr('More')}
        </button>
      )}
    </>
  );
}

/**
 * A tag after a row's label: the choice is kept by this browser, not by the account (v0.86.0). It says where the setting
 * lives, which four helps used to end on ("This device only."), and squared like every key since "no more pills".
 */
export function DeviceTag() {
  return (
    <span className="ms-1.5 inline-flex -translate-y-px items-center rounded-md border border-ink-600 px-1.5 align-middle text-[10px] font-medium leading-4 text-fog-400">
      {tr('This device')}
    </span>
  );
}

/**
 * A titled group of rows (v0.86.0): a short sentence-case heading, then one card whose rows are divided by hairlines,
 * iPhone Settings' inset list. The settings pages are made of these instead of a card per section, so a page reads as a
 * few named groups rather than a wall of equal cards. A note about the whole group goes UNDER it (`description`), as
 * those lists do, where it explains without standing between the heading and the first switch.
 *
 * `overflow-hidden` so a whole-row button's hover and the arrival flash keep the card's corners; nothing inside opens in
 * place over its edge (editors and dialogs are moved out to <body>, see `EditorSheet`). `min-w-0`, as Section's is, so
 * a wide row wraps inside the card instead of widening the grid column.
 */
export function RowGroup({ title, description, action, id, className, children }: {
  title?: string;
  description?: ReactNode;
  /** A key at the end of the heading: Notifications' Add. */
  action?: ReactNode;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const hid = useId();
  return (
    <section id={id} aria-labelledby={title ? hid : undefined} data-row-group className={`min-w-0 scroll-mt-4 lg:scroll-mt-20 ${className ?? ''}`}>
      {(title || action) && (
        <div className="mb-1.5 flex min-h-8 items-end justify-between gap-3 px-1">
          {title ? <h3 id={hid} className="text-[13px] font-semibold text-fog-300">{title}</h3> : <span />}
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      <div className="card grad-border divide-y divide-ink-800/80 overflow-hidden rounded-2xl">
        <RowPad.Provider value="group"><Folded.Provider value={true}>{children}</Folded.Provider></RowPad.Provider>
      </div>
      {description && <p className="mt-1.5 max-w-prose px-1 text-[11px] leading-relaxed text-fog-500">{description}</p>}
    </section>
  );
}

/**
 * A row and whatever hangs under it -- a disclosure, a note, a second field -- as ONE divider unit: the group draws
 * one line under the pair, and the block pads the pair as a row is padded where it sits. It replaces the wrapper plus
 * `py-0!` on the Row inside that SwitchWithMore and the cleanup's day count each built by hand.
 */
export function RowBlock({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  const pad = useContext(RowPad);
  return (
    <div id={id} className={`${PAD[pad]} ${className ?? ''}`}>
      <RowPad.Provider value="bare">{children}</RowPad.Provider>
    </div>
  );
}

/**
 * A few rows under a small heading inside a group or More options: "Paged mode", "Webtoon mode". The group's hairline
 * runs above it, and its own rows are divided as the group's are.
 */
export function RowSubgroup({ title, children }: { title: string; children: ReactNode }) {
  const inset = useContext(RowPad) === 'group' ? 'px-4' : '';
  return (
    <div>
      <p className={`${inset} pt-3 text-[11px] font-semibold text-fog-500`}>{title}</p>
      <div className="divide-y divide-ink-800/80">{children}</div>
    </div>
  );
}

/**
 * Picture cards (v0.86.0): a choice that is easier seen than named -- the reader's mode and theme, what a wide page
 * becomes, the page's background -- as square cards with a small drawing of the result (components/settingsArt.tsx),
 * where a row of pills asked the reader to imagine it.
 *
 * The same radio group as `Segmented`: one tab stop, the arrows inside it (swapped under RTL, `radioKey`), "2 of 3,
 * checked" announced, and a value outside the options checks nothing with the first card as the tab stop. Two options
 * are two columns, more are three, never wider than `max-w-md`: on a wide pane they stay pictures, not banners.
 * `optionProps` puts attributes on each card (the background's `data-tone-choice`, which the tests and walks select by).
 */
export function ChoiceCards<T extends string>({ label, value, options, disabled, onChange, optionProps }: {
  label: string;
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string; art: ReactNode }>;
  disabled?: boolean;
  onChange: (v: T) => void;
  optionProps?: (v: T) => Record<string, string>;
}) {
  const rtl = useRtl();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const checked = options.findIndex((o) => o.value === value);
  const pick = (i: number) => {
    const o = options[i];
    if (!o) return;
    if (o.value !== value) onChange(o.value);
    refs.current[i]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} data-choice-cards
      className={`grid max-w-md gap-2.5 ${options.length === 2 ? 'grid-cols-2' : 'grid-cols-3'} ${disabled ? 'opacity-40' : ''}`}>
      {options.map((o, i) => {
        const on = i === checked;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on}
            tabIndex={on || (checked === -1 && i === 0) ? 0 : -1} disabled={disabled}
            ref={(el) => { refs.current[i] = el; }}
            onClick={() => pick(i)}
            onKeyDown={(e) => {
              const next = radioKey(e.key, i, options.length, rtl);
              if (next === null) return;
              e.preventDefault();
              pick(next);
            }}
            {...optionProps?.(o.value)}
            className={`min-w-0 rounded-xl border p-1.5 text-start transition disabled:cursor-not-allowed ${on ? 'border-accent bg-accent-soft' : 'border-ink-700 hover:border-ink-500'}`}>
            <span aria-hidden className="relative block h-16 overflow-hidden rounded-lg">{o.art}</span>
            <span className="mt-1.5 flex items-start gap-1 px-0.5 text-xs font-medium leading-tight text-fog-100">
              {on && <IcCheck width={12} height={12} className="mt-px shrink-0 text-accent" aria-hidden />}
              <span className="min-w-0 break-words">{o.label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Picture cards as a row of their own, under the label, with the tick beside the label. */
export function ChoiceRow<T extends string>({ id, label, help, value, options, disabled, device, onChange, optionProps }: {
  id?: string;
  label: string;
  help?: ReactNode;
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string; art: ReactNode }>;
  disabled?: boolean;
  device?: boolean;
  onChange: (v: T) => Promise<unknown> | unknown;
  optionProps?: (v: T) => Record<string, string>;
}) {
  const { status, run } = useAutosave();
  return (
    <Row id={id} stacked label={label} help={help} status={status} device={device}>
      <ChoiceCards label={label} value={value} options={options} disabled={disabled} optionProps={optionProps}
        onChange={(v) => { void run(() => onChange(v)); }} />
    </Row>
  );
}

/** Two or three named values as square keys beside the label, saved as picked (the profile's own `Choice` until v0.86.0). */
export function SegmentedRow<T extends string>({ id, label, help, value, options, disabled, device, onChange }: {
  id?: string;
  label: string;
  help?: ReactNode;
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string }>;
  disabled?: boolean;
  device?: boolean;
  onChange: (v: T) => Promise<unknown> | unknown;
}) {
  const { status, run } = useAutosave();
  return (
    <Row id={id} label={label} help={help} status={status} device={device}>
      <Segmented label={label} value={value} options={options} disabled={disabled} onChange={(v) => { void run(() => onChange(v)); }} />
    </Row>
  );
}

/**
 * A long list as the platform's own menu (v0.86.0): the language, an interval in hours, a time of day. A native
 * `<select>`, so a phone shows its own wheel or sheet and a keyboard types to jump, and the stored value is always one of
 * the options -- the number boxes it replaces took any number and clamped it after. Optimistic as `SwitchRow` is: the
 * menu shows the pick at once and goes back to the stored value if the save is refused.
 *
 * `[color-scheme:dark]` keeps the opened list dark on every tone; the chevron is drawn, at the end in either direction,
 * because `appearance-none` takes the platform's away.
 */
export function SelectRow<T extends string>({ id, label, help, value, options, disabled, device, onChange }: {
  id?: string;
  label: string;
  help?: ReactNode;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  disabled?: boolean;
  device?: boolean;
  onChange: (v: T) => Promise<unknown> | unknown;
}) {
  const fid = useId();
  const { status, run } = useAutosave();
  const [local, setLocal] = useState<T>(value);
  // The prop catching up is adopted during render (SwitchRow's "previous prop" pattern).
  const [seen, setSeen] = useState<T>(value);
  if (value !== seen) { setSeen(value); setLocal(value); }
  const pick = async (v: T) => {
    setLocal(v);
    if (!(await run(() => onChange(v)))) setLocal(value);
  };
  return (
    <Row id={id} label={label} help={help} htmlFor={fid} status={status} device={device}>
      <span className="relative inline-flex max-w-full">
        <select id={fid} value={local} disabled={disabled} onChange={(e) => { void pick(e.target.value as T); }}
          className="field w-auto max-w-full cursor-pointer appearance-none py-2 pe-9 [color-scheme:dark] disabled:cursor-default disabled:opacity-40">
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
          strokeLinejoin="round" aria-hidden className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-fog-500">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </span>
    </Row>
  );
}

/**
 * A setting too big for one row -- a list, a ranking, a few fields that only make sense together -- as ONE row that says
 * what is set now and opens its editor (`EditorSheet`), or that leads to the page where it lives (`href`). The WHOLE row
 * is the target, as LinkRow's is, so there is no small key to aim for.
 *
 * `href` is a real link -- a middle click still opens a tab -- whose plain click arrives the way the search palette's
 * destinations do (lib/destinations.ts arrival): another page is a client-side navigation, this console on another tab a
 * whole load, because a console reads its `?tab=` once.
 */
export function SummaryRow({ id, label, value, help, href, onClick, ref, device }: {
  id?: string;
  label: string;
  /** What is set now, short: "2 blocked · 3 ranked". */
  value?: ReactNode;
  help?: ReactNode;
  href?: string;
  onClick?: () => void;
  ref?: Ref<HTMLElement | null>;
  device?: boolean;
}) {
  const pad = PAD[useContext(RowPad)];
  const cls = `group flex w-full items-center gap-3 text-start transition hover:bg-ink-800/40 focus-visible:outline-offset-[-2px] ${pad}`;
  const inner = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-fog-100">{label}{device && <DeviceTag />}</span>
        {help != null && help !== false && <span className="mt-0.5 block max-w-prose text-[11px] leading-relaxed text-fog-500">{help}</span>}
      </span>
      {value != null && value !== false && <span className="min-w-0 max-w-[45%] truncate text-end text-xs text-fog-400">{value}</span>}
      <IcChevronRight width={18} height={18} aria-hidden className="shrink-0 text-fog-500 transition group-hover:text-fog-200 rtl:-scale-x-100" />
    </>
  );
  if (href) {
    const go = (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      // Another page of the console on screen (Server's "When someone signs up" is on Members): opened in place, the row
      // with it (lib/consoleOnScreen.ts).
      if (openInConsole(href)) { e.preventDefault(); return; }
      const how = arrival(href, window.location, (s) => !!document.getElementById(s));
      if (how === 'push') return; // Link's own client-side navigation
      e.preventDefault();
      if (how === 'load') window.location.assign(href);
      else if (how === 'scroll') {
        const s = new URL(href, window.location.href).searchParams.get('section');
        if (s) document.getElementById(s)?.scrollIntoView({ block: 'start' });
      }
    };
    return <Link id={id} ref={ref as Ref<HTMLAnchorElement>} href={href} onClick={go} className={cls}>{inner}</Link>;
  }
  return (
    <button id={id} ref={ref as Ref<HTMLButtonElement>} type="button" aria-haspopup="dialog" onClick={onClick} className={cls}>{inner}</button>
  );
}

/**
 * An editor's open state (v0.86.0), opened as well when search or `?section=` arrives at a row inside it (`SettingsGo`),
 * once per arrival. Closing puts focus back on the summary row that opened it -- hand `row` to that row's `ref`.
 */
export function useEditor(id: string): { open: boolean; show: () => void; close: () => void; row: RefObject<HTMLElement | null> } {
  const go = useContext(SettingsGo);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(0);
  if (go && go.editor === id && go.seq !== seen) { setSeen(go.seq); setOpen(true); }
  const row = useRef<HTMLElement | null>(null);
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => row.current?.focus());
  }, []);
  return { open, show, close, row };
}

/**
 * The editor a SummaryRow opens (v0.86.0): the app's bottom sheet -- centred on a wide screen -- moved out to <body>,
 * because a `.card` blurs its backdrop and that traps fixed children (OnBody says why), and clear of the phone's bottom
 * nav. Its rows keep the loose rhythm and show their help in full: the editor is where the detail lives. `footer` pins a
 * row under the scroller, as the scanlation groups' one Save.
 */
export function EditorSheet({ title, open, onClose, footer, children }: {
  title: string;
  open: boolean;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <OnBody>
      <Sheet title={title} onClose={onClose} overBottomNav footer={footer} wrapTitle>
        <RowPad.Provider value="loose">
          <Folded.Provider value={false}>
            <div className="divide-y divide-ink-800/80 pb-3" data-editor-sheet>{children}</div>
          </Folded.Provider>
        </RowPad.Provider>
      </Sheet>
    </OnBody>
  );
}

/**
 * The rows few people change, folded under one "More options" row at the end of a group (v0.86.0). Search and
 * `?section=` open it when they arrive at a row inside (`SettingsGo`), so a folded setting is never hidden from someone
 * looking for it.
 */
export function MoreOptions({ id, label, children }: { id: string; label?: string; children: ReactNode }) {
  const go = useContext(SettingsGo);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(0);
  if (go && go.more === id && go.seq !== seen) { setSeen(go.seq); setOpen(true); }
  const pad = PAD[useContext(RowPad)];
  const cid = `${id}-rows`;
  return (
    <div id={id} data-more-options>
      <button type="button" aria-expanded={open} aria-controls={cid} onClick={() => setOpen((o) => !o)}
        className={`group flex w-full items-center gap-2 text-start text-sm text-fog-300 transition hover:bg-ink-800/40 hover:text-fog-100 focus-visible:outline-offset-[-2px] ${pad}`}>
        <span className="min-w-0 flex-1">{label ?? tr('More options')}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
          strokeLinejoin="round" aria-hidden className={`shrink-0 text-fog-500 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && <div id={cid} className="divide-y divide-ink-800/80 border-t border-ink-800/80">{children}</div>}
    </div>
  );
}

/** The padding a row has where it is drawn (`RowPad`): for a row that is not a `Row` -- a notification target's. */
export function useRowPad(): string {
  return PAD[useContext(RowPad)];
}
