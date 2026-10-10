// The chapters earlier merges left twice, removed once, by themselves (v0.57.0).
//
// Before v0.57.0 a merge moved every chapter of the absorbed series across, so every chapter both had stayed in the
// list twice (lib/extraCopies.ts says why that changed). The owner's library held 1,187 such chapters in 8 merged series,
// every one a copy in the survivor's own folder beside a copy in the absorbed series' folder; asked, the owner chose to
// have them cleaned up automatically rather than by a button. So a few minutes after the first boot of v0.57.0 this
// goes through every series that absorbed another, with the merge's own rules (lib/extraCopies.ts leftoverPairs and
// removeExtraCopies), and stamps itself done in schema_migrations -- only once nothing is left that it could do, so a
// series it found busy is tried again later, and a restart half-way picks up where it stopped.
//
// It never works beside a sweep or a repair, and holds `runtime.repairing` while it runs (no sweep starts under it),
// claiming each series' folders the way the merge route does: a download into one of them waits, and so does it.
import { q, one } from './db';
import { runtime } from './runtime';
import { claimWriterFolders } from './bulkNewest';
import { folderBusy } from './numbering';
import { runsInside } from './updater';
import { leftoverPairs, removeExtraCopies } from './extraCopies';

type Log = { info: (m: string) => void; warn: (m: string) => void };

/** The schema_migrations id that says this has run to the end. */
export const LEFTOVERS_DONE = 'v0.57.0-merge-leftovers';

export interface LeftoversOutcome {
  /** Already done before (stamped): nothing was looked at. */
  done?: true;
  /** A sweep, a repair or a shutdown: not started; try again later. */
  waiting?: true;
  series: number;
  removed: number;
  deleted: number;
  bytes: number;
  setAside: number;
  /** Numbers left twice, for good (a bookmark, an unreachable file): they do not hold the stamp back. */
  kept: number;
  /** Series whose folders were busy: tried again later, and the stamp waits for them. */
  busy: number;
}

/** One pass over every series that absorbed another. Stamps itself done when no series was busy. */
export async function cleanMergeLeftovers(log?: Log): Promise<LeftoversOutcome> {
  const out: LeftoversOutcome = { series: 0, removed: 0, deleted: 0, bytes: 0, setAside: 0, kept: 0, busy: 0 };
  if (await one('SELECT 1 FROM schema_migrations WHERE id = $1', [LEFTOVERS_DONE])) return { ...out, done: true };
  if (runtime.updating || runtime.repairing || runtime.stopping) return { ...out, waiting: true };
  const t0 = Date.now();
  runtime.repairing = true;
  try {
    const survivors = await q<{ id: string; folder: string }>(
      `SELECT s.id, s.folder FROM lib_series s
        WHERE s.deleted_at IS NULL AND s.merged_into IS NULL
          AND EXISTS (SELECT 1 FROM lib_series m WHERE m.merged_into = s.id)
        ORDER BY s.id`);
    for (const s of survivors) {
      if (runtime.stopping) { out.busy++; break; }
      const pairs = await leftoverPairs(s.id);
      if (!pairs.length) continue;
      const absorbed = (await q<{ folder: string }>('SELECT folder FROM lib_series WHERE merged_into = $1', [s.id])).map((r) => r.folder);
      const claim = claimWriterFolders([s.folder, ...absorbed], folderBusy, () => runsInside(s.id) > 0);
      if (!claim) { out.busy++; continue; }
      try {
        const r = await removeExtraCopies(s.id, pairs, { userId: null, via: 'merge_leftovers' });
        out.series++;
        out.removed += r.removed;
        out.deleted += r.deleted;
        out.bytes += r.bytes;
        out.setAside += r.setAside;
        out.kept += Object.values(r.left).reduce((n, x) => n + (x ?? 0), 0);
      } finally {
        claim.release();
      }
    }
    if (!out.busy) {
      await q('INSERT INTO schema_migrations (id, ms) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [LEFTOVERS_DONE, Date.now() - t0]);
    }
  } finally {
    runtime.repairing = false;
  }
  if (out.removed || out.kept || out.busy) {
    log?.info(`merge leftovers: ${out.removed} extra chapter copies removed in ${out.series} merged series `
      + `(${out.deleted} files deleted, ${(out.bytes / 1e9).toFixed(2)} GB; ${out.setAside} set aside); `
      + `${out.kept} left twice; ${out.busy} series busy`);
  }
  return out;
}

/**
 * A few minutes after boot (the match check's pattern, lib/matchCheck.ts): the clean-up, then again every ten minutes
 * while it is waiting or a series was busy, until it has stamped itself done. Nothing at all once it has.
 */
export function scheduleMergeLeftovers(log: Log, delayMs = 3 * 60_000, retryMs = 10 * 60_000): void {
  const tick = async () => {
    let again = false;
    try {
      const r = await cleanMergeLeftovers(log);
      again = !r.done && (!!r.waiting || r.busy > 0);
    } catch (e) {
      log.warn(`merge leftovers: the clean-up failed: ${(e as Error)?.message || e}`);
      again = true;
    }
    if (again && !runtime.stopping) setTimeout(tick, retryMs).unref?.();
  };
  setTimeout(tick, delayMs).unref?.();
}
