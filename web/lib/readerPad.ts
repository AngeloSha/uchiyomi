// A game controller in the reader (v0.61.0, Reader → Keys and controller, per device).
//
// The Gamepad API has no events for buttons: a page polls the pad's state and works out presses itself. This is that
// arithmetic, pure, so it is tested without a pad (test/readerPad.test.ts): a press acts on the frame it goes down, a
// page turn held down repeats -- first after 400 ms, then every 150 ms, as a held key does -- and nothing else ever
// repeats: a held shoulder button changes chapter once. The left stick counts as the D-pad.
//
// Plugging a controller in is the opt-in: there is no switch, and nothing is polled until one is connected
// (lib/useGamepad.ts). The browser only offers the API to a secure page -- https, or this computer itself -- which the
// sheet says plainly on a plain-http address.
import { PAGE_ACTIONS, READER_ACTIONS, type ReaderAction } from './readerKeys';

/** Which buttons do what: indices in the browser's standard layout (A = 0, B = 1, … the D-pad 12-15). */
export type PadMap = Record<ReaderAction, number[]>;
export type PadOverrides = Partial<Record<ReaderAction, number[]>>;

/**
 * The defaults: the D-pad turns pages (↑ back, ↓ on, ← → physical, as the arrow keys), A on and B back, the shoulder
 * buttons step a chapter, Start shows the controls, Y brings one page of a pair into frame (v0.77.0, #261). Leaving and
 * full screen are unbound: a controller is held at arm's length, and a stray press should not end the reading.
 */
export const DEFAULT_PAD: PadMap = {
  next: [13, 0],
  prev: [12, 1],
  pageLeft: [14],
  pageRight: [15],
  nextChapter: [5],
  prevChapter: [4],
  fullscreen: [],
  menu: [9],
  focus: [3],
  exit: [],
};

/** The standard layout's buttons, as controllers print them. */
export const PAD_BUTTONS: Record<number, string> = {
  0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: '⧉', 9: '☰', 10: 'L3', 11: 'R3',
  12: '✛↑', 13: '✛↓', 14: '✛←', 15: '✛→', 16: '⌂',
};

export const REPEAT_DELAY = 400;
export const REPEAT_EVERY = 150;
/** How far the stick must lean to count as the D-pad. */
const STICK = 0.5;

export interface PadState {
  /** The stick on the previous frame. */
  axes: number[];
  /** Each held action: when it went down, and when it last acted. */
  held: Partial<Record<ReaderAction, { since: number; last: number }>>;
}
export const PAD_IDLE: PadState = { axes: [], held: {} };

/** The buttons with the left stick read as the D-pad. */
function withStick(buttons: readonly boolean[], axes: readonly number[]): boolean[] {
  const b = [...buttons];
  const x = axes[0] ?? 0;
  const y = axes[1] ?? 0;
  if (y < -STICK) b[12] = true;
  if (y > STICK) b[13] = true;
  if (x < -STICK) b[14] = true;
  if (x > STICK) b[15] = true;
  return b;
}

/**
 * The actions this frame of the pad does: `prev` and `now` are which buttons were down on the last frame and are down
 * on this one, `axes` the stick now, `t` the time in ms. Returns them with the state for the next frame.
 */
export function padActions(
  prev: readonly boolean[], now: readonly boolean[], axes: readonly number[], map: PadMap, t: number, state: PadState,
): { actions: ReaderAction[]; state: PadState } {
  const was = withStick(prev, state.axes);
  const is = withStick(now, axes);
  const actions: ReaderAction[] = [];
  const held: PadState['held'] = {};
  for (const a of READER_ACTIONS) {
    const buttons = map[a] ?? [];
    if (!buttons.some((i) => is[i])) continue;
    const h = state.held[a];
    if (!h || !buttons.some((i) => was[i])) {
      actions.push(a); // the press itself
      held[a] = { since: t, last: t };
      continue;
    }
    // Held. A page turn repeats, first after REPEAT_DELAY, then every REPEAT_EVERY; nothing else does.
    const due = h.last === h.since ? h.since + REPEAT_DELAY : h.last + REPEAT_EVERY;
    if (PAGE_ACTIONS.has(a) && t >= due) {
      actions.push(a);
      held[a] = { since: h.since, last: t };
    } else {
      held[a] = h;
    }
  }
  return { actions, state: { axes: [...axes], held } };
}

/** The pad in force: the defaults, with this device's own buttons in place of the actions it has rebound. */
export function padMapFor(overrides: PadOverrides = {}): PadMap {
  const out = { ...DEFAULT_PAD };
  for (const a of READER_ACTIONS) if (Array.isArray(overrides[a])) out[a] = overrides[a]!;
  return out;
}

/** Bindings from storage made safe: known actions, each a list of distinct button indices 0-31. */
export function cleanPadOverrides(raw: unknown): PadOverrides {
  const out: PadOverrides = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const a of READER_ACTIONS) {
    const v = (raw as Record<string, unknown>)[a];
    if (Array.isArray(v)) out[a] = [...new Set(v.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < 32))].slice(0, 8);
  }
  return out;
}

/** Bind button `i` to `action`, taking it from any other action that had it (`from` names that one). */
export function bindButton(overrides: PadOverrides, action: ReaderAction, i: number): { overrides: PadOverrides; from: ReaderAction | null } {
  const map = padMapFor(overrides);
  const out: PadOverrides = { ...overrides };
  let from: ReaderAction | null = null;
  for (const a of READER_ACTIONS) {
    if (a !== action && map[a].includes(i)) { out[a] = map[a].filter((b) => b !== i); from = a; }
  }
  if (!map[action].includes(i)) out[action] = [...map[action], i];
  return { overrides: out, from };
}

export function unbindButton(overrides: PadOverrides, action: ReaderAction, i: number): PadOverrides {
  return { ...overrides, [action]: padMapFor(overrides)[action].filter((b) => b !== i) };
}

/** The first button that went down between two frames, or null: what "Press a button…" waits for. */
export function pressedButton(prev: readonly boolean[], now: readonly boolean[]): number | null {
  for (let i = 0; i < now.length; i++) if (now[i] && !prev[i]) return i;
  return null;
}
