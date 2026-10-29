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

/**
 * An idle page can sleep until a future retry, then read once after the scanner's 30-second tick. The small grace
 * avoids reading just before that tick and missing the resumed work. A stale cached deadline also gets one read;
 * the next response clears it or supplies a new deadline. Browser timeouts are capped at their signed 32-bit limit.
 */
export function titleLogoScanResumeDelay(status: TitleLogoScanStatus | undefined, enabled: boolean, failed: boolean, now: number): number | null {
  if (!enabled || !status?.enabled || status.running || failed) return null;
  const at = titleLogoNextAttempt(status, 0);
  return at === null ? null : Math.min(2_147_483_647, Math.max(0, at + 31_000 - now));
}
