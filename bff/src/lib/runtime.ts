// Small shared runtime state across routes (last scan, last updater run + result, last backup).
// In-memory only: it resets on restart. Anything that must survive a restart (e.g. the backup's last run)
// is also persisted to server_settings.
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
} = {
  lastScan: 0,
  lastUpdate: 0,
  lastUpdateResult: null,
  updating: false,
  stopping: false,
  lastBackup: 0,
  lastBackupResult: null,
  backingUp: false,
};
