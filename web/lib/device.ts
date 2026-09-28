// Stable per-install device id, used for refresh-token + download tracking.
export function deviceId(): string {
  if (typeof window === 'undefined') return 'ssr';
  let id = localStorage.getItem('yomi_device');
  if (!id) {
    id = (crypto.randomUUID?.() || `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    localStorage.setItem('yomi_device', id);
  }
  return id;
}

/**
 * The platform, sent at sign-in and stored with the session: "on iPhone" on a Continue card, the session list.
 *
 * ⚠️ Nothing when the platform is not one of these (Linux, ChromeOS). The name is stored once and shown on every
 * device in ITS reader's language, so a word here is English everywhere: the old "Browser" read "no Browser" in
 * Portuguese. Unnamed, the card says "another device" and the session list "Device", both translated.
 */
export function deviceName(): string | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const ua = navigator.userAgent;
  if (/iphone/i.test(ua)) return 'iPhone';
  if (/ipad/i.test(ua)) return 'iPad';
  if (/android/i.test(ua)) return 'Android';
  if (/mac/i.test(ua)) return 'Mac';
  if (/windows/i.test(ua)) return 'Windows';
  return undefined;
}

/** The English fallbacks deviceName() stored before v0.49.0. Sessions keep them until they expire. */
const STORED_FALLBACKS = new Set(['Browser', 'device']);

/** A stored device name worth showing, or null for none -- the caller says "another device" in the reader's words. */
export function shownDeviceName(name: string | null | undefined): string | null {
  return name && !STORED_FALLBACKS.has(name) ? name : null;
}
