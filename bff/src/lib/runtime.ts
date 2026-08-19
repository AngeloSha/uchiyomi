// Small shared runtime state across routes (last scan, last updater run + result, last backup).
// In-memory only: it resets on restart. Anything that must survive a restart (e.g. the backup's last run)
// is also persisted to server_settings.
export const runtime: {
  lastScan: number;
  lastUpdate: number;
  lastUpdateResult: { series: number; added: number } | null;
  updating: boolean;
  lastBackup: number;
  lastBackupResult: { bytes: number; ms: number } | null;
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
