import { one } from './db';

/**
 * Which sources a series should be taken from, in order of preference.
 *
 * From @Squeaks72's #93. The sibling of lib/scanlatorPrefs.ts, one level up: that one ranks the GROUP a copy
 * came from, this one ranks the SOURCE. A server-wide order, overridable per series, because the right answer
 * genuinely differs per title -- a source that is first to post one series is often behind on another.
 *
 * ⚠️ IT ONLY EVER CHOOSES AMONG COPIES OF A CHAPTER THE SERVER DOES NOT HAVE YET. #93 also re-downloaded held
 * chapters from a higher-ranked source, and that half was not taken: it trusted `lib_books.source_id` as "we
 * downloaded this" when `setBookMeta` stamps it on files in both roots, and nothing stopped a one-page "chapter
 * removed" notice from replacing a full chapter. Replacing what is on disk is a different decision with rules of
 * its own -- owned files only, never a shorter copy, off unless an admin turns it on -- and what #81 asks it to
 * follow is the scanlation group, not the source.
 *
 * Where it sits in the ranking (lib/releases.ts `releaseOrder`): below the group preferences and the
 * hosted-before-external rule, above the follow order. So it decides between two copies the release rules
 * consider equal, which is exactly the decision the follow order made alone before -- the primary won every
 * tie, whichever source was actually better.
 */
export interface StoredSourcePrefs {
  /** Source ids, most preferred first. Anything not listed ranks below everything listed. */
  priority?: string[];
}

export interface SourcePriority {
  order: readonly string[];
  /** 0 for the first listed source, and so on; `order.length` for every source the order does not name. */
  rank(sourceId: string | null | undefined): number;
}

/**
 * What an order may hold: source ids as the registry writes them, de-duplicated, at most 100.
 *
 * Checked by SHAPE, never against the sources registered right now. An extension source is only registered
 * while the engine is up, so an order saved -- or re-saved from the admin page -- during an engine restart
 * would otherwise lose every extension in it without anyone having removed them. An id nothing serves any
 * more simply ranks nothing until it is taken off the list. Case is kept: the registry is case-sensitive.
 */
export function cleanSourceOrder(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const id = typeof x === 'string' ? x.trim() : '';
    if (!/^[\p{L}\p{N}_.:\-]{1,120}$/u.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length === 100) break;
  }
  return out;
}

function build(order: string[]): SourcePriority {
  const at = new Map(order.map((id, i) => [id, i] as const));
  return { order, rank: (id) => (id && at.has(id) ? at.get(id)! : order.length) };
}

let globalCache: { at: number; order: string[] } | null = null;
const CACHE_MS = 15_000;

/** Drop the cached server-wide order after it has been written. */
export function invalidateSourcePrefs(): void { globalCache = null; }

async function globalOrder(): Promise<string[]> {
  if (globalCache && Date.now() - globalCache.at < CACHE_MS) return globalCache.order;
  const row = await one<{ source_prefs: unknown }>('SELECT source_prefs FROM server_settings WHERE id = 1').catch(() => null);
  const order = cleanSourceOrder((row?.source_prefs as StoredSourcePrefs | null)?.priority);
  globalCache = { at: Date.now(), order };
  return order;
}

/**
 * The order in force for one series: its own if it has one, else the server's.
 *
 * REPLACES rather than merges, unlike the scanlator preferences, which add the series' blocks to the
 * server's. An order is a single ranked sequence; interleaving two of them produces a third that neither
 * party asked for, and "prefer this source for this series" is a statement about this one.
 */
export async function effectiveSourcePriority(seriesPrefs: unknown): Promise<SourcePriority> {
  const own = cleanSourceOrder((seriesPrefs as StoredSourcePrefs | null)?.priority);
  return build(own.length ? own : await globalOrder());
}

/**
 * The chooser's source rank: the order first, the follow order after it.
 *
 * `follow` is the series' follow order (primary first). A source the order names goes ahead of every source
 * it does not; two sources it does not name keep their follow order between them. With no order at all this
 * IS the follow order, unchanged -- so nothing moves until an admin sets one.
 */
export function rankSources(priority: SourcePriority | null, follow: readonly string[]): (id?: string) => number {
  const f = new Map(follow.map((s, i) => [s, i] as const));
  const byFollow = (id?: string) => f.get(id ?? '') ?? follow.length;
  if (!priority?.order.length) return byFollow;
  const n = priority.order.length;
  return (id) => {
    const p = priority.rank(id);
    return p < n ? p : n + byFollow(id);
  };
}
