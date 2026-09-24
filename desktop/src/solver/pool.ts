// A bounded set of Electron partition NAMES for the solver's cookie jars.
//
// ⚠️ Electron cannot free a session: `session.fromPartition(name)` lives until the process exits, whether or
// not anything still uses it (measured in the spike: ~50 solves left +112 MB retained after every window had
// closed). The solver used to name a partition after its key -- `fs-o:<origin>` for the bff's session-less
// calls, `fs-s:<name>` for a FlareSolverr session -- so every new origin, and every session name a client
// made up (sessions.create with no name is a fresh uuid), was one more session held forever. FlareSolverr
// itself grew to 2.5 GB over 62 days on the owner's server.
//
// So the keys map onto a FIXED pool of names (`fs-o:0` .. `fs-o:<n-1>`). A new key takes a free name, or the
// least recently used one that is not in the middle of a solve; the backend then empties that jar before
// reuse. Pure (no Electron), so the bound is testable under plain Node.
export interface Claim {
  /** The Electron partition name to use (fixed set). */
  name: string;
  /** This key had no partition until now (a fresh jar). */
  fresh: boolean;
  /** The key that held this partition before and was pushed out (its jar must be emptied first). */
  evicted?: string;
}

export class PartitionPool {
  private byKey = new Map<string, { index: number; lastUsed: number }>();

  constructor(private readonly prefix: string, readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('capacity must be a positive integer');
  }

  /** The partition for `key`, taking a free one or evicting the least recently used idle key. */
  claim(key: string, now = Date.now(), busy: (key: string) => boolean = () => false): Claim {
    const have = this.byKey.get(key);
    if (have) {
      have.lastUsed = now;
      return { name: this.nameOf(have.index), fresh: false };
    }
    const used = new Set([...this.byKey.values()].map((v) => v.index));
    for (let i = 0; i < this.capacity; i++) {
      if (!used.has(i)) {
        this.byKey.set(key, { index: i, lastUsed: now });
        return { name: this.nameOf(i), fresh: true };
      }
    }
    // Full: the least recently used key that is not mid-solve gives up its partition. If every one is busy
    // (the server's gates keep that from happening: 4 + 1 solves at once, far under any capacity we use), the
    // least recently used one goes anyway rather than growing the pool.
    const order = [...this.byKey.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const victim = order.find(([k]) => !busy(k)) ?? order[0];
    const [evicted, slot] = victim;
    this.byKey.delete(evicted);
    this.byKey.set(key, { index: slot.index, lastUsed: now });
    return { name: this.nameOf(slot.index), fresh: true, evicted };
  }

  /** Forget a key (sessions.destroy). Its partition name becomes free. */
  release(key: string): boolean {
    return this.byKey.delete(key);
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  keys(): string[] {
    return [...this.byKey.keys()];
  }

  nameFor(key: string): string | undefined {
    const v = this.byKey.get(key);
    return v ? this.nameOf(v.index) : undefined;
  }

  /** Every partition name this pool can ever hand out: the whole memory bound, by construction. */
  allNames(): string[] {
    return Array.from({ length: this.capacity }, (_, i) => this.nameOf(i));
  }

  private nameOf(i: number): string {
    return `${this.prefix}:${i}`;
  }
}
