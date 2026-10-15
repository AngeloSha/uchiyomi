'use client';
import { useSyncExternalStore } from 'react';

/**
 * Switches that used to be per-device and are now per-ACCOUNT, stored in the account's settings
 * (`showGhosts`, `alsoFollow` in `/api/settings`, bff lib/accountSettings.ts), the way
 * Reduce effects is (lib/effects.ts): someone who turns one off at their desk should not
 * have to find the switch again on every other browser.
 *
 *  - `showGhosts`: chapters the sources list that this server lacks, on the series page (ON by default);
 *  - `alsoFollow`: the Add dialog's "also check the other sources" (off by default);
 *
 * localStorage stays as a MIRROR, under the same keys and values these switches always used, for the two starts
 * that cannot ask the server: the first paint and an offline launch. Local wins until the account's value has
 * loaded; the account's value then overwrites it (`adoptAccountPrefs`, called from lib/auth.tsx on every
 * sign-in and refresh, so a switch changed on another device arrives here). An account that holds NO value yet
 * keeps what this device has, and `localOnlyPrefs` says what to upload so the choice is not lost on upgrade.
 */
export type AccountPref = 'showGhosts' | 'alsoFollow';

interface Spec { mirror: string; on: string; off: string | null; fallback: boolean }
// The strings are the ones the device-only versions wrote, so nothing already stored stops being read.
const SPECS: Record<AccountPref, Spec> = {
  showGhosts: { mirror: 'uchiyomi.showGhosts', on: 'on', off: 'off', fallback: true },
  alsoFollow: { mirror: 'uchiyomi.alsoFollow', on: '1', off: '0', fallback: false },
};
export const ACCOUNT_PREFS = Object.keys(SPECS) as AccountPref[];

const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

/** The device's copy, or the default when there is none (or storage is unreadable). */
export function readAccountPref(key: AccountPref): boolean {
  const s = SPECS[key];
  try {
    const v = localStorage.getItem(s.mirror);
    if (v === s.on) return true;
    if (s.off !== null && v === s.off) return false;
    return s.fallback;
  } catch { return s.fallback; }
}

/** Whether this device holds a value of its own (as opposed to the default). */
function hasLocal(key: AccountPref): boolean {
  const s = SPECS[key];
  try {
    const v = localStorage.getItem(s.mirror);
    return v === s.on || (s.off !== null && v === s.off);
  } catch { return false; }
}

/** Write the mirror and tell every `useAccountPref`. The default is stored as absent where it can be. */
export function writeAccountPref(key: AccountPref, on: boolean): void {
  const s = SPECS[key];
  try {
    if (on) localStorage.setItem(s.mirror, s.on);
    else if (s.off === null) localStorage.removeItem(s.mirror);
    else localStorage.setItem(s.mirror, s.off);
  } catch { /* storage refused: the account still holds it, only the first paint forgets */ }
  notify();
}

/**
 * The account's values laid over the device's: a key the settings hold as a boolean replaces the mirror, one it
 * does not hold leaves it alone. Called on every sign-in and session refresh.
 */
export function adoptAccountPrefs(settings: Record<string, unknown> | null | undefined): void {
  let changed = false;
  for (const key of ACCOUNT_PREFS) {
    const v = settings?.[key];
    if (typeof v !== 'boolean') continue;
    const had = readAccountPref(key);
    // Through the mirror without notifying: one notification for the lot, and only if something moved.
    const s = SPECS[key];
    try {
      if (v) localStorage.setItem(s.mirror, s.on);
      else if (s.off === null) localStorage.removeItem(s.mirror);
      else localStorage.setItem(s.mirror, s.off);
    } catch { /* see writeAccountPref */ }
    if (had !== v) changed = true;
  }
  if (changed) notify();
}

/**
 * What this device holds that the account does not, as a settings body to PUT -- the one-time carry-over for
 * someone who set a switch before it was an account setting. Only values that differ from the default.
 */
export function localOnlyPrefs(settings: Record<string, unknown> | null | undefined): Partial<Record<AccountPref, boolean>> {
  const out: Partial<Record<AccountPref, boolean>> = {};
  for (const key of ACCOUNT_PREFS) {
    if (typeof settings?.[key] === 'boolean') continue;
    if (!hasLocal(key)) continue;
    const v = readAccountPref(key);
    if (v !== SPECS[key].fallback) out[key] = v;
  }
  return out;
}

/** Forget the device's copies: sign-out, so the next account on a shared device starts from its own settings. */
export function clearAccountPrefs(): void {
  for (const key of ACCOUNT_PREFS) {
    try { localStorage.removeItem(SPECS[key].mirror); } catch { /* nothing to clear */ }
  }
  notify();
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** The value, re-rendering when it changes. The server snapshot is the default: nothing is hydrated against storage. */
export function useAccountPrefValue(key: AccountPref): boolean {
  return useSyncExternalStore(subscribe, () => readAccountPref(key), () => SPECS[key].fallback);
}
