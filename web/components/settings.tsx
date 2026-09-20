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
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Switch } from './Switch';
import { msgOf } from './ConfirmDialog';
import { useRtl } from './ui';
import { IcChevronRight } from './icons';
import { t as tr } from '@/lib/i18n';

export type SaveStatus = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string };
const IDLE: SaveStatus = { kind: 'idle' };
/** How long the tick stays before it fades. Long enough to be seen after a Tab away, short enough that a
 *  row edited twice in a row reads as two saves rather than one that never ends. */
const SAVED_MS = 1500;

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
 * NEVER toasts. Toasts are for actions with side effects; a setting that says "Saved" in two places at
 * once is the noise this file exists to remove.
 */
export function useAutosave(): { status: SaveStatus; run: (fn: () => Promise<unknown> | unknown) => Promise<boolean> } {
  const [status, setStatus] = useState<SaveStatus>(IDLE);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);
  const alive = useRef(true);
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
    setStatus({ kind: 'saving' });
    try {
      await fn();
      // A save that lands after the row is gone (a tab switch mid-request) must not arm a timer nobody
      // will clear; one that lands after a NEWER run started leaves the label to that run.
      if (alive.current && mine === seq.current) {
        setStatus({ kind: 'saved' });
        clear();
        timer.current = setTimeout(() => { timer.current = null; setStatus(IDLE); }, SAVED_MS);
      }
      return true;
    } catch (e) {
      if (alive.current && mine === seq.current) setStatus({ kind: 'error', message: msgOf(e, tr('Could not save')) });
      return false;
    }
  }, [clear]);
  return { status, run };
}

/**
 * A titled card of rows. Keeps `.card` because `scripts/shots/capture.mjs` crops by that class.
 *
 * `ref` is a plain prop (React 19) so a section can be scrolled into view by whoever renders it -- the
 * tracking section still answers `?card=tracking` from the import page that way.
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
    <section ref={ref} id={id} aria-labelledby={hid} className={`card grad-border min-w-0 p-4 ${className ?? ''}`}>
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
 */
export function Row({ label, help, htmlFor, stacked, status, id, className, children }: {
  label: ReactNode;
  help?: ReactNode;
  htmlFor?: string;
  stacked?: boolean;
  status?: SaveStatus;
  id?: string;
  className?: string;
  children?: ReactNode;
}) {
  // A `<label>` only when there is a control to point at; a `<label>` with nothing to label is announced as
  // one anyway and confuses the reading order.
  const labelEl = htmlFor
    ? <label htmlFor={htmlFor} className="text-sm text-fog-100">{label}</label>
    : <p className="text-sm text-fog-100">{label}</p>;
  const helpEl = help != null && help !== false ? <p className="max-w-prose text-[11px] leading-relaxed text-fog-500">{help}</p> : null;
  if (stacked) {
    return (
      <div id={id} className={`py-3 first:pt-1 last:pb-0 ${className ?? ''}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">{labelEl}{helpEl}</div>
          <SaveState status={status ?? IDLE} />
        </div>
        <div className="mt-2">{children}</div>
      </div>
    );
  }
  return (
    <div id={id} className={`flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-1 last:pb-0 ${className ?? ''}`}>
      <div className="min-w-0 flex-1 basis-32">{labelEl}{helpEl}</div>
      <div className="ms-auto flex max-w-full flex-wrap items-center justify-end gap-2">
        {children}
        <SaveState status={status ?? IDLE} />
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
export function SwitchRow({ label, help, on, disabled, onChange }: {
  label: string;
  help?: ReactNode;
  on: boolean;
  disabled?: boolean;
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
    <Row label={label} help={help} status={status}>
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
 */
export function Segmented<T extends string>({ label, value, options, disabled, onChange }: {
  label: string;
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string }>;
  disabled?: boolean;
  onChange: (v: T) => void;
}) {
  const id = useId();
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
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = options.length;
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    let next: number | null = null;
    if (e.key === forward || e.key === 'ArrowDown') next = (i + 1) % n;
    else if (e.key === back || e.key === 'ArrowUp') next = (i - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next === null) return;
    e.preventDefault();
    pick(next);
  };
  return (
    <div role="radiogroup" aria-label={label}
      className={`relative inline-flex max-w-full flex-wrap rounded-full border border-ink-700 bg-ink-850 p-0.5 ${disabled ? 'opacity-40' : ''}`}>
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
            className="relative rounded-full px-3 py-1.5 text-xs disabled:cursor-not-allowed"
          >
            {selected && (
              <motion.span aria-hidden layoutId={id} className="absolute inset-0 rounded-full bg-accent-soft"
                transition={still ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 34 }} />
            )}
            <span className={`relative ${selected ? 'text-accent' : 'text-fog-300'}`}>{o.label}</span>
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
 */
export function TextRow({ label, help, value, onSave, placeholder, maxLength, id, autoComplete, required }: {
  label: string;
  help?: ReactNode;
  value: string;
  onSave: (v: string) => Promise<unknown>;
  placeholder?: string;
  maxLength?: number;
  id?: string;
  autoComplete?: string;
  required?: boolean;
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
          else if (e.key === 'Escape') setDraft(last.current);
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
  const cls = 'group flex w-full items-center gap-3 py-3 text-start first:pt-1 last:pb-0';
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
