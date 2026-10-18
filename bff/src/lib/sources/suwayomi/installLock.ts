// One extension install or removal at a time (v0.82.0).
//
// Four things change which extensions the engine has: an admin's Install, Update or Remove (routes/admin.ts), the
// scheduled extension check (lib/extensionMonitor.ts: updates, and putting back a wiped engine's), Fix everything
// (lib/autofix.ts) and the backup extensions (lib/backupExtensions.ts). Each install downloads an APK and converts it
// (tens of seconds), and each ends in a reload that re-registers every source. Two at once had the engine converting
// two packages while a reload read a list one of them was half way through -- and the monitor's own note says a second
// scheduler driving the install mutation "is how you get one APK installed twice at once". So they queue here: first
// come, first served, each caller saying how long it will wait. Held only around the engine's mutation, the rows that
// record it and the reload, never around a search.
//
// In-process on purpose: one bff talks to one engine (a second bff on the same database is a setup the docs refuse).

/** What a caller waiting longer than it would gets back instead of its function's answer. */
export const BUSY = Symbol('install lock busy');

interface Waiter { who: string; go: () => void }

let holder: string | null = null;
const queue: Waiter[] = [];

/** Who holds the lock now ("admin", "extension check", "Fix everything", "backup"), or null. */
export const installLockHolder = (): string | null => holder;

/**
 * Run `fn` holding the lock. `waitMs` is how long to wait for it: 0 takes it only when it is free. Past the wait the
 * answer is BUSY and `fn` never runs. The lock is released however `fn` ends.
 */
export async function withInstallLock<T>(who: string, fn: () => Promise<T>, waitMs = 0): Promise<T | typeof BUSY> {
  if (holder !== null) {
    if (waitMs <= 0) return BUSY;
    const got = await new Promise<boolean>((resolve) => {
      const me: Waiter = { who, go: () => { clearTimeout(timer); resolve(true); } };
      const timer = setTimeout(() => {
        const at = queue.indexOf(me);
        if (at >= 0) queue.splice(at, 1);
        resolve(false);
      }, waitMs);
      queue.push(me);
    });
    // Handed over by the releaser (holder already set to us), or timed out.
    if (!got) return BUSY;
  } else {
    holder = who;
  }
  try {
    return await fn();
  } finally {
    const next = queue.shift();
    if (next) {
      holder = next.who;
      next.go();
    } else {
      holder = null;
    }
  }
}

/** Tests only: whether anyone is waiting. */
export const _installLockWaiting = (): number => queue.length;
