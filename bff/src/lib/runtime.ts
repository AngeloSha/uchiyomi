// Small shared runtime state across routes (last scan, last updater run + result).
export const runtime: { lastScan: number; lastUpdate: number; lastUpdateResult: { series: number; added: number } | null; updating: boolean } = {
  lastScan: 0,
  lastUpdate: 0,
  lastUpdateResult: null,
  updating: false,
};
