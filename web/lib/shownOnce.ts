// State that must survive an accidental remount.
//
// I18nProvider remounts its whole subtree when the language changes (`<div key={lang}>` in
// lib/I18nProvider.tsx) because `t` is a plain import that nothing is subscribed to. That is a deliberate
// trade and it is fine for every screen except three, where a value is shown EXACTLY ONCE and cannot be
// retrieved again:
//
//   * the OPDS password, on /profile
//   * a freshly minted API token, in SecurityPanel
//   * the 2FA recovery codes, in SecurityPanel
//
// Tap a language chip while any of those is on screen and it is destroyed permanently, along with a
// half-finished 2FA enrolment mid-QR-scan. Nothing warns, and the value is genuinely unrecoverable: the
// server stores a hash.
//
// So these three live in a module-scoped map instead of purely in component state. A remount reads the value
// back rather than losing it. Deliberately NOT localStorage or sessionStorage: a secret shown once should not
// outlive the tab, survive a crash, or be readable by anything else on the origin. Cleared on sign-out.
const held = new Map<string, unknown>();

/** Forget everything. Called on sign-out, so a shared machine does not hand the next person a token. */
export function clearShownOnce(): void {
  held.clear();
}

export function readShownOnce<T>(key: string): T | null {
  return (held.get(key) as T) ?? null;
}

export function writeShownOnce<T>(key: string, value: T | null): void {
  if (value === null) held.delete(key);
  else held.set(key, value);
}
