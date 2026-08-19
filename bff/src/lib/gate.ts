// Per-key concurrency gate with a politeness delay between releases.
//
// Every download path funnels through downloadChapter, and each "add a series" spawns its own detached
// background loop. Without a gate, importing a few hundred titles starts a few hundred simultaneous download
// loops against the same handful of sites — which reads as an attack and gets the server's IP blocked. Some
// sources have already rate-limited this app.
//
// One gate per source id keeps a slow site from starving a fast one.

interface Lane {
  active: number;
  queue: Array<() => void>;
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
  /** how many operations may run at once for this key */
  concurrency?: number;
  /** minimum gap between the start of one operation and the next, per key */
  minGapMs?: number;
}

/** Run `fn` under the gate for `key`, waiting for a slot and for the politeness gap. */
export async function withGate<T>(key: string, fn: () => Promise<T>, opts: GateOptions = {}): Promise<T> {
  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const minGapMs = Math.max(0, opts.minGapMs ?? 0);
  const lane = laneOf(key);

  if (lane.active >= concurrency) await new Promise<void>((resolve) => lane.queue.push(resolve));
  lane.active++;
  try {
    if (minGapMs) {
      const wait = lane.nextFreeAt - Date.now();
      if (wait > 0) await sleep(wait);
      lane.nextFreeAt = Date.now() + minGapMs;
    }
    return await fn();
  } finally {
    lane.active--;
    const next = lane.queue.shift();
    if (next) next();
    else if (lane.active === 0 && lane.queue.length === 0) lanes.delete(key); // don't leak a lane per source forever
  }
}

/** Testing/introspection helper: how many operations are in flight or queued for a key. */
export function gateDepth(key: string): { active: number; queued: number } {
  const l = lanes.get(key);
  return { active: l?.active ?? 0, queued: l?.queue.length ?? 0 };
}
