// Retiring a source once nothing uses it as a main source (v0.54.0): turning it off, or removing it.
//
// The owner: "can u remove any extension/providers that are not working good for me". Removing a source some series
// still read through froze them -- a site added by address was deleted with no check at all, and every series from it
// read "no longer installed" -- so a source is retired only once no series has it as its main source (`in_use`, with
// how many: "Replace it first"). Its follows go first, with their listing rows, as an unfollow takes them: a follow
// on a retired source is a listing row nothing can fetch through and a sweep ask that never answers. Then:
//   - `off`: switched off (source_health.disabled), as Turn off does -- loaded, never asked;
//   - `remove`, a site added by address: out of sites.json and the registry, its health row pruned;
//   - `remove`, an extension's source: switched off in the extension (suwayomi_sources.enabled), which unregisters it.
//     The extension itself stays installed -- one package carries every language's sources, and uninstalling is
//     Extensions' own decision;
//   - `remove`, MangaDex, a built-in or a pack source: nothing to remove it from, so it is turned off, and the answer
//     says so (`done: turned_off`).
// The Replace run calls it with `off` when it ends with nothing left on the source it replaced (`turnOff`).
import type { FastifyRequest } from 'fastify';
import { q } from './db';
import { logAudit } from './audit';
import { setDisabled, pruneOrphanedHealth } from './sourceHealth';
import { mainSourceCounts } from './findScope';
import { readSites, writeSites } from './sources/customSites';
import { reloadAll, isSwAdapterId, SW_PREFIX } from './sources';
import { setSourcesEnabled } from './sources/suwayomi/langs';
import { scheduleHealthSummaryRefresh } from './healthSummary';

export type RetireHow = 'off' | 'remove';
export type Retired =
  | { ok: true; done: 'turned_off' | 'removed' | 'switched_off'; followsDropped: number }
  | { inUse: number };

/** How many series have this source as their main source: what refuses a retirement and a site's removal. */
export async function mainUses(sourceId: string): Promise<number> {
  return (await mainSourceCounts([sourceId])).get(sourceId) ?? 0;
}

export async function retireSource(
  sourceId: string,
  o: { how: RetireHow; userId: string | null; req?: FastifyRequest; via?: 'admin' | 'replace' | 'autofix'; runId?: string },
): Promise<Retired> {
  // Reintroduce by dropping it: "refuses while it is some series' main source" in retireSource.int.test.ts retires it.
  const main = await mainUses(sourceId);
  if (main > 0) return { inUse: main };
  // Its follows, with the listing rows they carried (the unfollow route's rule).
  const dropped = await q<{ series_id: string }>('DELETE FROM series_sources WHERE source_id = $1 RETURNING series_id', [sourceId]);
  if (dropped.length) {
    await q('DELETE FROM series_listing WHERE source_id = $1 AND series_id = ANY($2::text[])', [sourceId, dropped.map((r) => r.series_id)]);
  }
  let done: 'turned_off' | 'removed' | 'switched_off' = 'turned_off';
  if (o.how === 'remove') {
    const sites = await readSites();
    if (sites.some((s) => s.id === sourceId)) {
      await writeSites(sites.filter((s) => s.id !== sourceId));
      await reloadAll();
      await pruneOrphanedHealth([sourceId]);
      done = 'removed';
    } else if (isSwAdapterId(sourceId)) {
      await setSourcesEnabled({ ids: [sourceId.slice(SW_PREFIX.length)], enabled: false });
      await reloadAll();
      done = 'switched_off';
    }
  }
  if (done === 'turned_off') await setDisabled(sourceId, true);
  await logAudit('source.retire', {
    userId: o.userId,
    detail: { source: sourceId, how: o.how, done, followsDropped: dropped.length, via: o.via ?? 'admin', ...(o.runId ? { runId: o.runId } : {}) },
    req: o.req,
  });
  scheduleHealthSummaryRefresh();
  return { ok: true, done, followsDropped: dropped.length };
}
