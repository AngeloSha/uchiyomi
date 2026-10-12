// The reader's keys, as actions (v0.61.0, Reader → Keys and controller, per device).
//
// The keyboard handler was a chain of `e.key === …` tests in app/reader/page.tsx, so nothing could be rebound and
// nothing about it could be tested without a browser. The keys are now a map from an action to the keys that do it,
// the defaults reproduce that chain exactly (test/readerKeys.test.ts runs both side by side), and a device's own
// bindings replace the defaults one action at a time.
//
// Rules a binding cannot break:
//  - Escape and Tab are reserved. Escape always leaves the reader -- or closes the sheet that is open over it -- and Tab
//    moves focus. Neither can be bound to anything else.
//  - Ctrl, Alt and Meta are never part of a binding: they are the browser's (Alt+← is Back, Ctrl+F is Find) and the
//    command palette's. A key pressed with one of them is never the reader's.
//  - Shift is the only modifier, and only on a named key (Shift+Space is back a page): on a character Shift makes
//    another character, which is bound as itself (`F`, `{`).
//  - A focused control owns the keys it uses -- the page slider its arrows, a button its Space and Enter -- whatever
//    they are bound to here.

/** What a key, a controller button or a tap can do in the reader. */
export type ReaderAction = 'next' | 'prev' | 'pageLeft' | 'pageRight' | 'nextChapter' | 'prevChapter' | 'fullscreen' | 'menu' | 'exit';
export const READER_ACTIONS: readonly ReaderAction[] = ['next', 'prev', 'pageLeft', 'pageRight', 'nextChapter', 'prevChapter', 'fullscreen', 'menu', 'exit'];

/** The actions that turn or scroll a page: these repeat while a key or a button is held. The rest happen once a press. */
export const PAGE_ACTIONS: ReadonlySet<ReaderAction> = new Set(['next', 'prev', 'pageLeft', 'pageRight']);

export type KeyMap = Record<ReaderAction, string[]>;
/** A device's own bindings: an action listed here uses exactly these keys instead of its default ones. */
export type KeyOverrides = Partial<Record<ReaderAction, string[]>>;

/**
 * Paged mode's keys, as v0.60's handler had them: Space, ↓ and Page Down for the next page, Shift+Space, ↑ and Page Up
 * for the one before -- whichever way the pages run -- and ← → PHYSICAL, like the tap zones (on a right-to-left read
 * the next page is to the left). [ ] step a chapter, f is full screen. Nothing shows the controls or leaves by key
 * but Escape, which is reserved.
 */
export const DEFAULT_KEYS_PAGED: KeyMap = {
  next: ['Space', 'ArrowDown', 'PageDown'],
  prev: ['Shift+Space', 'ArrowUp', 'PageUp'],
  pageLeft: ['ArrowLeft'],
  pageRight: ['ArrowRight'],
  nextChapter: [']'],
  prevChapter: ['['],
  fullscreen: ['f'],
  menu: [],
  exit: [],
};

/**
 * The webtoon column's: Space and ↓ scroll most of a screen on, Shift+Space and ↑ back. Page Down and Page Up stay the
 * browser's own (they scroll the column natively), and ← → do nothing: the column has no sideways.
 */
export const DEFAULT_KEYS_VERTICAL: KeyMap = {
  next: ['Space', 'ArrowDown'],
  prev: ['Shift+Space', 'ArrowUp'],
  pageLeft: [],
  pageRight: [],
  nextChapter: [']'],
  prevChapter: ['['],
  fullscreen: ['f'],
  menu: [],
  exit: [],
};

/** Keys nobody can bind: Escape (leave, or close what is open) and Tab (focus). */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(['Escape', 'Tab', 'Shift+Escape', 'Shift+Tab']);
/** Keys that are only ever half of a press, or not a key at all. */
const NOT_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'Hyper', 'Super', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock', 'Dead', 'Unidentified', 'Process', 'Compose']);
/** The keys a focused control uses for itself; while one has focus they are its, whatever they are bound to. */
const CONTROL_KEYS = new Set(['Space', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

/** A key press as one binding string: `Space` for the space bar, `Shift+` before a named key held with Shift. */
export function normalize(key: string, shift = false): string {
  const base = key === ' ' || key === 'Spacebar' ? 'Space' : key;
  return shift && base.length > 1 ? `Shift+${base}` : base;
}

/** Whether `k` may be a binding: a real key, not reserved, with no modifier but Shift on a named key. */
export function bindable(k: unknown): k is string {
  if (typeof k !== 'string' || !k || k.length > 40) return false;
  if (RESERVED_KEYS.has(k)) return false;
  if (/^(Control|Ctrl|Alt|Meta|Cmd|Super)\+/i.test(k)) return false;
  const base = k.startsWith('Shift+') ? k.slice(6) : k;
  if (!base || NOT_KEYS.has(base) || RESERVED_KEYS.has(base)) return false;
  // Shift on a character makes another character, which is bound as itself.
  if (k.startsWith('Shift+') && base.length === 1) return false;
  return true;
}

/** The keys in force: the mode's defaults, with this device's bindings in place of the actions it has rebound. */
export function keyMapFor(mode: 'paged' | 'vertical', overrides: KeyOverrides = {}): KeyMap {
  const base = mode === 'paged' ? DEFAULT_KEYS_PAGED : DEFAULT_KEYS_VERTICAL;
  const out = { ...base };
  for (const a of READER_ACTIONS) if (Array.isArray(overrides[a])) out[a] = overrides[a]!;
  return out;
}

const findAction = (map: KeyMap, k: string): ReaderAction | null => READER_ACTIONS.find((a) => map[a].includes(k)) ?? null;

/**
 * What a key press does in the reader, or null for nothing: the action, and whether the browser's own handling of the
 * key is to be stopped (a bound key's is). `owned` says a control has focus. Escape is not here: it is reserved, and
 * the reader handles it before any binding.
 */
export function actionForKey(
  e: { key: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; repeat?: boolean },
  map: KeyMap,
  o: { owned?: boolean } = {},
): ReaderAction | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  const k = normalize(e.key, !!e.shiftKey);
  if (RESERVED_KEYS.has(k) || RESERVED_KEYS.has(e.key)) return null;
  let action = findAction(map, k);
  // Shift held on a named key that nobody bound WITH Shift is the key itself: Shift+↓ turns the page as ↓ always did.
  // Not the space bar, where Shift is the whole difference.
  if (!action && k.startsWith('Shift+') && k !== 'Shift+Space') action = findAction(map, k.slice(6));
  if (!action) return null;
  if (o.owned && CONTROL_KEYS.has(k.startsWith('Shift+') ? k.slice(6) : k)) return null;
  // A held key repeats. A page turn may (a held ↓ keeps turning); a chapter, full screen, the controls or leaving may
  // not: `]` repeating walked the reader through chapter after chapter.
  if (e.repeat && !PAGE_ACTIONS.has(action)) return null;
  return action;
}

/** Bindings from storage made safe: known actions only, each a list of distinct bindable keys. Junk is dropped. */
export function cleanKeyOverrides(raw: unknown): KeyOverrides {
  const out: KeyOverrides = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const a of READER_ACTIONS) {
    const v = (raw as Record<string, unknown>)[a];
    if (Array.isArray(v)) out[a] = [...new Set(v.filter(bindable))].slice(0, 8);
  }
  return out;
}

/**
 * Bind `key` to `action` on this device: it is added to the action's keys and taken from any other action that had it
 * (`from` names that action, so the sheet can say so). Other actions are written out in full only when they lose a key.
 */
export function bindKey(overrides: KeyOverrides, mode: 'paged' | 'vertical', action: ReaderAction, key: string): { overrides: KeyOverrides; from: ReaderAction | null } {
  const map = keyMapFor(mode, overrides);
  const out: KeyOverrides = { ...overrides };
  let from: ReaderAction | null = null;
  for (const a of READER_ACTIONS) {
    if (a !== action && map[a].includes(key)) { out[a] = map[a].filter((k) => k !== key); from = a; }
  }
  if (!map[action].includes(key)) out[action] = [...map[action], key];
  return { overrides: out, from };
}

/** Take `key` off `action` on this device. */
export function unbindKey(overrides: KeyOverrides, mode: 'paged' | 'vertical', action: ReaderAction, key: string): KeyOverrides {
  const map = keyMapFor(mode, overrides);
  return { ...overrides, [action]: map[action].filter((k) => k !== key) };
}
