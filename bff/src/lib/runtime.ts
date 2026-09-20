// Small shared runtime state across routes (last scan, last updater run + result, last backup).
// In-memory only: it resets on restart. Anything that must survive a restart (e.g. the backup's last run)
// is also persisted to server_settings.

/**
 * What one run of the read-chapter cleanup did. Declared here rather than imported from lib/chapterCleanup
 * because that module imports `runtime`, and a type-only cycle through a value import is the kind of thing
 * that works until someone reorders the imports.
 */
export interface CleanupResult {
  /** Chapters whose file was deleted. */
  deleted: number;
  /** Bytes reclaimed, as measured immediately before each unlink. */
  bytes: number;
  /** Eligible chapters left for the next run because this one hit its cap. */
  remaining: number;
  /** Files that were due but could not be removed; the rows are left unmarked so the next run retries. */
  failed: number;
  ms: number;
  /** Why nothing was done, when nothing was done. Absent on a run that actually looked. */
  skipped?: 'disabled' | 'read_only' | 'shutdown';
  /**
   * Why a run that looked ended early. `unmounted`: a due chapter's folder was missing along with the file,
   * which reads as the download volume not being there, so the run stopped at that chapter without marking
   * it (lib/chapterCleanup.ts); it and the chapters after it are counted in `failed`.
   */
  stopped?: 'unmounted';
  /** The grace period this run applied, so the panel reports the setting the run actually used. */
  days?: number;
}

export const runtime: {
  lastScan: number;
  lastUpdate: number;
  // `healthy` is what separates a quiet night from a broken one. Without it the admin panel showed
  // '+0 chapters' for both, and a library that had silently stopped updating looked exactly like one with
  // nothing new.
  // `visited`/`stopped`: a sweep now has a budget and a disk floor, and a sweep that stopped early is a
  // different night from one that finished, even at the same +N.
  lastUpdateResult: { series: number; visited?: number; added: number; failed?: number; chapterFailures?: number; healthy?: boolean; stopped?: 'budget' | 'disk' | 'shutdown' } | null;
  updating: boolean;
  /**
   * Set by SIGTERM/SIGINT. The updater's loops check it between chapters and between series, so a
   * `docker compose up -d` mid-sweep ends the sweep at a chapter boundary and says so, instead of dying
   * mid-write with the job card polling a dead id. There was no signal handler at all before this.
   */
  stopping: boolean;
  lastBackup: number;
  // configEmpty / sizeUnknown were computed by runBackup and then dropped before anything stored them, so
  // a backup missing the whole config directory reported as a clean run.
  lastBackupResult: { bytes: number; ms: number; configEmpty?: boolean; sizeUnknown?: boolean } | null;
  backingUp: boolean;
  /**
   * The opt-in read-chapter cleanup (lib/chapterCleanup.ts).
   *
   * `skipped` is not decoration. This job's normal outcome is "did nothing", and "did nothing because it is
   * switched off", "did nothing because the download dir is read-only" and "did nothing because no chapter
   * was due" are three different things an admin needs told apart before they conclude it is broken.
   */
  lastCleanup: number;
  lastCleanupResult: CleanupResult | null;
  cleaning: boolean;
  /**
   * Re-arms the nightly backup timer, installed by server.ts once the scheduler exists.
   *
   * The scheduler arms ONE timer per run and re-reads `backup_hour` only when that timer fires, so before
   * this hook a change made at 10:00 from 3 to 22 still fired at 03:00 the next morning and only the run
   * after that landed at 22:00 -- the admin panel said "daily at 22:00" for a night that ran at three. The
   * settings route calls this after writing the hour so the pending timer is replaced at once. `null` in
   * tests and until the server has started; callers use `runtime.rearmBackup?.()`.
   */
  rearmBackup: (() => void) | null;
} = {
  lastScan: 0,
  lastUpdate: 0,
  lastUpdateResult: null,
  updating: false,
  stopping: false,
  lastBackup: 0,
  lastBackupResult: null,
  backingUp: false,
  lastCleanup: 0,
  lastCleanupResult: null,
  cleaning: false,
  rearmBackup: null,
};
