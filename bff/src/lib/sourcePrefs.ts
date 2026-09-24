import { one } from './db';

/**
 * Which sources a series should be taken from, in order of preference.
 *
 * The sibling of lib/scanlatorPrefs.ts, one level up: that one ranks the GROUP a copy came from, this one
 * ranks the SOURCE. A server-wide order, overridable per series, because the right answer genuinely
 * differs per title -- a source that is first to post one series is often behind on another.
 *
 * What it buys, and what `scanlatorPrefs` could not: an UPGRADE. Until now a chapter on disk was never
 * replaced, whoever released it ("a copy from a better-ranked group appearing later is not a missing
 * chapter", lib/updater.ts). That is right when the ranking is about who translated it and the copy is
 * already readable. It is wrong when a series has been following a mediocre source and the preferred one
 * catches up: every chapter fetched in the meantime stays the worse copy for good, and the only fix was
 * to delete them by hand and fetch again.
 *
 * So a listed chapter whose source outranks the source of the copy held can be re-fetched over it. Chapter
 * ids, reading progress and bookmarks all survive, because the file is written to the same path -- named
 * from the chapter NUMBER alone, which is exactly why lib/downloader.ts names it that way.
 *
 * ⚠️ THE UPGRADE IS ITS OWN OPT-IN. Setting an order only decides which copy of a chapter the server does
 * not have yet is taken (the updater feeds it to the release chooser as the source rank). Replacing files
 * already on disk is a separate server switch, `server_settings.source_upgrade`, off by default, because
 * it re-downloads a library the admin may consider finished. With it on, the updater bounds it three ways:
 *
 *   - UPGRADE_MAX_PER_SWEEP upgrade attempts per sweep across every series, behind the missing chapters
 *     in each series' own `maxNew`;
 *   - upgrade or nothing: only the listed copy from the higher-ranked source is asked -- no alternate, no
 *     source hunt, and a copy with missing pages is discarded -- so a failure leaves the held file alone;
 *   - UPGRADE_BACKOFF_DAYS after a failed attempt before the same (series, number) is asked again
 *     (`source_upgrade_failures`).
 */
export interface StoredSourcePrefs {
  /** Source ids, most preferred first. Anything not listed ranks below everything listed. */
  priority?: string[];
}

export interface SourcePriority {
  order: readonly string[];
  /** Lower is better. An unlisted source ranks below every listed one, never equal to it. */
  rank(sourceId: string | null | undefined): number;
  /**
   * Whether a copy from `offered` should replace one currently held from `held`. Never when the held
   * copy's source is unknown (see `build`).
   */
  outranks(offered: string | null | undefined, held: string | null | undefined): boolean;
}

const UNRANKED = Number.MAX_SAFE_INTEGER;

/** Upgrade attempts one sweep may make across the whole library. A standalone "Check now" gets its own. */
export const UPGRADE_MAX_PER_SWEEP = 20;
/** How long a (series, number) whose upgrade failed is left alone before it is asked again. */
export const UPGRADE_BACKOFF_DAYS = 7;

function build(order: string[]): SourcePriority {
  const at = new Map(order.map((id, i) => [id, i] as const));
  const rank = (id: string | null | undefined) => (id && at.has(id) ? at.get(id)! : UNRANKED);
  return {
    order,
    rank,
    // Both unranked is NOT an upgrade: with no opinion about either source there is no reason to spend a
    // download replacing a readable chapter, and "unranked beats unranked" would re-fetch the whole
    // library every sweep.
    //
    // ⚠️ Neither is a held copy whose source is UNKNOWN (`lib_books.source_id` null). That is every file the
    // scanner found on disk -- a person's own rips and imports -- and every chapter downloaded before
    // provenance was recorded. Ranking "unknown" last would make it lose to every listed source, so setting
    // an order would quietly start re-downloading over files nobody knows to be worse, a series' maxNew at
    // a time, every night until the whole library had been replaced. Only a copy we know came from a
    // lower-ranked source is ever replaced.
    outranks: (offered, held) => {
      if (!held) return false;
      const a = rank(offered);
      const b = rank(held);
      return a < b && a !== UNRANKED;
    },
  };
}

const clean = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))] : [];

let globalCache: { at: number; order: string[]; upgrade: boolean } | null = null;
const CACHE_MS = 15_000;

/** Drop the cached server-wide order and switch, after either has been written. */
export function invalidateSourcePrefs(): void { globalCache = null; }

async function globalRow(): Promise<{ order: string[]; upgrade: boolean }> {
  if (globalCache && Date.now() - globalCache.at < CACHE_MS) return globalCache;
  const row = await one<{ source_prefs: unknown; source_upgrade: boolean | null }>(
    'SELECT source_prefs, source_upgrade FROM server_settings WHERE id = 1').catch(() => null);
  const order = clean((row?.source_prefs as StoredSourcePrefs | null)?.priority);
  globalCache = { at: Date.now(), order, upgrade: row?.source_upgrade === true };
  return globalCache;
}

/** Whether held chapters may be replaced from a higher-ranked source at all. Off unless the admin says so. */
export async function sourceUpgradesOn(): Promise<boolean> {
  return (await globalRow()).upgrade;
}

/**
 * The order in force for one series: its own if it has one, else the server's.
 *
 * REPLACES rather than merges, unlike the scanlator preferences, which add the series' blocks to the
 * server's. An order is a single ranked sequence; interleaving two of them produces a third that neither
 * party asked for, and "prefer this source for this series" is a statement about this one.
 */
export async function effectiveSourcePriority(seriesPrefs: unknown): Promise<SourcePriority> {
  const own = clean((seriesPrefs as StoredSourcePrefs | null)?.priority);
  return build(own.length ? own : (await globalRow()).order);
}
