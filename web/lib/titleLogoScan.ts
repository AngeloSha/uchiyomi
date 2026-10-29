/** Read-only overview of title artwork checks, separate from a series' never-checked fallback state. */
export interface TitleLogoScanStatus {
  enabled: boolean;
  running: boolean;
  counts: {
    total: number;
    ready: number;
    missing: number;
    error: number;
    unchecked: number;
    custom: number;
    text: number;
    eligible: number;
    needsLink: number;
    libraryOptOut: number;
    firstPage: number;
    pending: number;
    due: number;
  };
  checked: number;
  nextRetryAt: string | null;
  providerRetryAt: string | null;
  lastScanAt: string | null;
}

export const TITLE_LOGO_SCAN_KEY = ['admin-title-logo-scan'] as const;
export const TITLE_LOGO_STATUS_URL = '/api/admin/title-logos/status';
export const TITLE_LOGO_SCAN_URL = '/api/admin/title-logos/scan';

/** A settings page asks once while idle. Only an enabled, live scan is followed, and errors stop the timer. */
export function titleLogoScanPoll(status: TitleLogoScanStatus | undefined, enabled: boolean, failed = false): number | false {
  return enabled && status?.enabled && status.running && !failed ? 2500 : false;
}

/** Both the artwork's retry time and a source's requested pause must have passed before another attempt. */
export function titleLogoNextAttempt(status: TitleLogoScanStatus, now: number): number | null {
  const times = [status.nextRetryAt, status.providerRetryAt]
    .map((t) => t ? Date.parse(t) : NaN).filter((t) => Number.isFinite(t) && t > now);
  return times.length ? Math.max(...times) : null;
}
