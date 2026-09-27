// The extension engine's page cache, kept empty.
//
// Suwayomi keeps a copy of every page it serves. Each page Uchiyomi downloads through an extension passes
// through the engine, which writes it to /tmp/Tachidesk/manga-cache (ImageResponse.getImageResponse at v2.3.2243)
// and never deletes it: no size limit, no expiry. In the shipped compose files that directory is not in a volume
// but in the container's writable layer -- the HOST's system disk. On 2026-09-27 it held 17 GB and had filled the
// owner's root filesystem to 100 %. Every one of those pages was already in a CBZ Uchiyomi wrote; the copy is
// waste.
//
// The engine has a mutation for exactly this, clearCachedImages, and calling it from here fixes every existing
// install without a compose change. It runs:
//   * after an extension download job ends: once no extension download has been in flight for SETTLE_MS, so the
//     moment between two chapters of one job does not count as the end of it;
//   * and every EVERY_MS while none is in flight, which also covers what never counts as a job (a preview read,
//     the completion pass's page fetches) and a cache that was already full when this version started. The
//     same settle applies: the idle clear waits out the gap between two chapters too, which is exactly when
//     the next one is about to start.
//
// ⚠️ NEVER while an extension download is in flight. The mutation deletes the whole directory
// (File.deleteRecursively), and the engine writes each page as `<n>.tmp` before renaming it into place, so a
// clear in the middle of a chapter turns a good page into a failed one. Removing the directory itself is safe
// for the NEXT page: getImageResponse calls mkdirs() before every save. Both read off the v2.3.2243 bytecode, and
// the clear measured on a throwaway engine of that image: manga-cache gone, thumbnails untouched, cachedPages true.
// In flight is only checked as a clear STARTS: a chapter that starts during a long one (the first clear on an
// install that has been filling for months) can lose a page to it, which the downloader's resume asks for again.
//
// Nothing at all until the engine has answered once (client.ts engineAnswered): a JVM still starting at boot,
// and a desktop that never downloaded its engine (SUWAYOMI_URL is always set there), get no request and no
// warning.
//
// Only cachedPages. The thumbnail caches hold covers the engine fetches again on demand, and its downloaded
// thumbnails belong to its own library; neither grows with downloads, and neither is ours to empty.
//
// Errors are only logged, once per run of failures: an engine that is still booting, or has gone away, must not
// fill the log every few minutes, and nothing else waits on this succeeding.
import { gql as defaultGql, suwayomiConfigured, engineAnswered, type Gql } from './client';
import { SW_PREFIX } from './sources';
import { listActivity } from '../../downloadActivity';
import { gateBusy } from '../../gate';

/** How long no extension download may be in flight after the last one ended before its job counts as over. */
export const SETTLE_MS = 60_000;
/** The idle cadence: the most often a clear runs when no job has just ended. */
export const EVERY_MS = 30 * 60_000;
/** After a failed clear, the next try. Sooner than EVERY_MS: the usual failure is an engine still starting. */
export const RETRY_MS = 5 * 60_000;
/** How often the keeper looks. */
export const TICK_MS = 60_000;

/** The mutation, pages only; its input fields are ClearCachedImagesInput's at v2.3.2243. */
export const CLEAR_PAGES_M = 'mutation { clearCachedImages(input: { cachedPages: true }) { cachedPages } }';

/**
 * Ask the engine to empty its page cache. True when it says it did; false when it could not delete everything
 * (deleteRecursively's own answer -- a file held open on Windows, say).
 *
 * Two minutes, not gql's thirty seconds: the first clear on an install that has been filling for months deletes
 * tens of thousands of files before it answers. A timeout would not stop the engine, only make us retry early.
 */
export async function clearEnginePageCache(run: Gql = defaultGql): Promise<boolean> {
  const d = await run<{ clearCachedImages: { cachedPages: boolean | null } }>(CLEAR_PAGES_M, {}, 120_000);
  return d.clearCachedImages?.cachedPages === true;
}

/**
 * Is an extension download in flight: recorded as live (waiting for its source's gate, or fetching), or holding
 * an `sw:` gate. The second catches the completion pass, whose page fetches run under the gate but are never
 * recorded as downloads.
 */
export function extensionDownloadInFlight(): boolean {
  return gateBusy(SW_PREFIX) || listActivity().active.some((a) => a.source.startsWith(SW_PREFIX));
}

/** When the most recent extension download ended, in epoch ms; 0 when none has in the last day. */
export function lastExtensionDownloadEnded(): number {
  let at = 0;
  for (const a of listActivity().recent) if (a.source.startsWith(SW_PREFIX) && (a.finishedAt ?? 0) > at) at = a.finishedAt!;
  return at;
}

export type KeeperLog = { info(msg: string): void; warn(msg: string): void };

export interface KeeperDeps {
  /** An engine to talk to, and not switched off (EXTENSION_ENGINE). Asked on every tick. */
  configured: () => boolean;
  /** The engine has answered this process at least once (client.ts engineAnswered). */
  answered: () => boolean;
  busy: () => boolean;
  lastEnded: () => number;
  clear: () => Promise<boolean>;
  now: () => number;
  log: KeeperLog;
  settleMs: number;
  everyMs: number;
  retryMs: number;
}

/** What one tick did, for the tests and nothing else. */
export type TickResult = 'off' | 'unanswered' | 'running' | 'busy' | 'waiting' | 'cleared' | 'failed';

/**
 * The keeper's decision, with every input injectable. `startEngineCacheKeeper` is the one production caller;
 * tests drive `tick()` against a clock of their own.
 */
export function engineCacheKeeper(overrides: Partial<KeeperDeps> = {}) {
  const d: KeeperDeps = {
    configured: suwayomiConfigured,
    answered: engineAnswered,
    busy: extensionDownloadInFlight,
    lastEnded: lastExtensionDownloadEnded,
    clear: () => clearEnginePageCache(),
    now: () => Date.now(),
    log: console,
    settleMs: SETTLE_MS,
    everyMs: EVERY_MS,
    retryMs: RETRY_MS,
    ...overrides,
  };
  // 0 = not since this process started, so the first idle tick clears whatever an older version left behind.
  let lastClearAt = 0;
  let retryAt = 0;
  let failing = false;
  let running = false;

  async function tick(): Promise<TickResult> {
    // Asked first and every time: with no engine there is nothing to call, and nothing to log about it.
    if (!d.configured()) return 'off';
    // Nor with one that has not answered yet: a JVM still starting, or a desktop engine never downloaded.
    if (!d.answered()) return 'unanswered';
    if (running) return 'running';
    if (d.busy()) return 'busy';
    const now = d.now();
    if (now < retryAt) return 'waiting';
    const ended = d.lastEnded();
    // The settle keeps both kinds of clear out of the gap between two chapters of one job: no job has ended
    // until nothing has been in flight for a minute, and an idle clear that lands in that gap lands just as
    // the next chapter starts writing pages.
    const settled = now - ended >= d.settleMs;
    // A download that ended after the last clear left pages behind.
    const jobEnded = ended > lastClearAt && settled;
    const due = now - lastClearAt >= d.everyMs && settled;
    if (!jobEnded && !due) return 'waiting';
    running = true;
    try {
      if (!(await d.clear())) throw new Error('it could not delete every cached page');
      // The time the clear STARTED: a download that ends while it runs is newer, and gets a clear of its own.
      lastClearAt = now;
      retryAt = 0;
      if (failing) d.log.info('extension engine: its page cache is being cleared again');
      failing = false;
      return 'cleared';
    } catch (e) {
      retryAt = now + d.retryMs;
      if (!failing) {
        d.log.warn(`extension engine: could not clear its page cache (${(e as Error)?.message || e}); ` +
          `trying again every ${Math.round(d.retryMs / 60_000)} min without logging each attempt`);
      }
      failing = true;
      return 'failed';
    } finally {
      running = false;
    }
  }

  return { tick };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Wired once from server.ts. Idempotent; the timer never holds the process open. */
export function startEngineCacheKeeper(log: KeeperLog): void {
  if (timer) return;
  const keeper = engineCacheKeeper({ log });
  timer = setInterval(() => { void keeper.tick().catch(() => { /* tick handles its own errors */ }); }, TICK_MS);
  timer.unref?.();
}

/** For tests. */
export function stopEngineCacheKeeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
