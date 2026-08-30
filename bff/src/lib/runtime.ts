// Small shared runtime state across routes (last scan, last updater run + result, last backup).
// In-memory only: it resets on restart. Anything that must survive a restart (e.g. the backup's last run)
// is also persisted to server_settings.
export const runtime: {
  lastScan: number;
  lastUpdate: number;
  // `healthy` is what separates a quiet night from a broken one. Without it the admin panel showed
  // '+0 chapters' for both, and a library that had silently stopped updating looked exactly like one with
  // nothing new.
  lastUpdateResult: { series: number; added: number; failed?: number; chapterFailures?: number; healthy?: boolean } | null;
  updating: boolean;
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
  lastBackup: 0,
  lastBackupResult: null,
  backingUp: false,
};
