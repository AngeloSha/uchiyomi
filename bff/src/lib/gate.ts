// Per-key concurrency gate with a politeness delay between releases.
//
// Every download path funnels through downloadChapter, and each "add a series" spawns its own detached
// background loop. Without a gate, importing a few hundred titles starts a few hundred simultaneous download
// loops against the same handful of sites — which reads as an attack and gets the server's IP blocked. Some
// sources have already rate-limited this app.
//
// One gate per source id keeps a slow site from starving a fast one.

/** One operation waiting for a slot, with the width it asks for, asked again each time a slot frees. */
interface Waiter { width: () => number; go: () => void }
interface Lane {
  active: number;
  queue: Waiter[];
  nextFreeAt: number;
}

const lanes = new Map<string, Lane>();
const laneOf = (key: string): Lane => {
  let l = lanes.get(key);
  if (!l) { l = { active: 0, queue: [], nextFreeAt: 0 }; lanes.set(key, l); }
  return l;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface GateOptions {
  /**
   * how many operations may run at once for this key. A function is asked again whenever a slot frees (v0.55.3): the
   * downloader's width falls to one while a source's pace is raised, and a lane busy at the old width narrows as its
   * operations finish rather than whenever it happens to drain.
   */
  concurrency?: number | (() => number);
  /** minimum gap between the start of one operation and the next, per key; a function is asked when a slot is had */
  minGapMs?: number | (() => number);
}

const valueOf = (v: number | (() => number) | undefined, fallback: number): number => (typeof v === 'function' ? v() : v ?? fallback);

/**
 * Let waiters in, in order, while the lane is under the width the first of them asks for -- one, as a rule; more only
 * when the lane has widened. The slot is counted HERE, before the waiter wakes: counted by the waiter itself, an
 * arrival in between saw the lane one short, walked in, and three ran in a lane of two.
 */
function admit(key: string, lane: Lane): void {
  while (lane.queue.length && lane.active < lane.queue[0].width()) {
    lane.active++;
    lane.queue.shift()!.go();
  }
  if (lane.active === 0 && lane.queue.length === 0) lanes.delete(key); // don't leak a lane per source forever
}

/** Run `fn` under the gate for `key`, waiting for a slot and for the politeness gap. */
export async function withGate<T>(key: string, fn: () => Promise<T>, opts: GateOptions = {}): Promise<T> {
  const width = () => Math.max(1, valueOf(opts.concurrency, 2));
  const lane = laneOf(key);

  // First come, first served: an arrival waits behind anyone already waiting, never past them into a slot the
  // first in line is about to be given -- and a lane that has widened since they queued lets them in now, in order.
  if (lane.queue.length || lane.active >= width()) {
    const turn = new Promise<void>((go) => lane.queue.push({ width, go }));
    admit(key, lane);
    await turn;
  } else lane.active++;
  try {
    const minGapMs = Math.max(0, valueOf(opts.minGapMs, 0));
    if (minGapMs) {
      const wait = lane.nextFreeAt - Date.now();
      if (wait > 0) await sleep(wait);
      lane.nextFreeAt = Date.now() + minGapMs;
    }
    return await fn();
  } finally {
    lane.active--;
    admit(key, lane);
  }
}

/**
 * Whether any key starting with `prefix` has an operation running or waiting. A lane only exists while it has
 * one (it is deleted as it empties), so its presence is the answer. The extension engine's page-cache keeper
 * (lib/sources/suwayomi/cache.ts) asks it for 'sw:', which also catches the completion pass's page fetches:
 * those run under the gate but are never recorded as downloads.
 */
export function gateBusy(prefix: string): boolean {
  for (const k of lanes.keys()) if (k.startsWith(prefix)) return true;
  return false;
}

/** Testing/introspection helper: how many operations are in flight or queued for a key. */
export function gateDepth(key: string): { active: number; queued: number } {
  const l = lanes.get(key);
  return { active: l?.active ?? 0, queued: l?.queue.length ?? 0 };
}
