'use client';
import { api } from './api';
import { useAuth } from './auth';
import { useAccountPrefValue, writeAccountPref, type AccountPref } from './accountPrefs';

/**
 * An account-level switch (lib/accountPrefs.ts): `[value, set]`. `set` applies at once -- the mirror, every other
 * reader of the switch, and the auth context's copy of the settings -- then saves to the account, and puts the
 * old value back and rejects when the server refuses, so a control built on it can show "Could not save".
 * Where nobody is waiting on the answer (a toggle in a sheet), `set(v).catch(() => {})` is enough: the device
 * keeps the choice either way.
 */
export function useAccountPref(key: AccountPref): [boolean, (next: boolean) => Promise<void>] {
  const value = useAccountPrefValue(key);
  const { setSettings } = useAuth();
  const set = async (next: boolean) => {
    const prev = value;
    writeAccountPref(key, next);
    setSettings({ [key]: next });
    try { await api('/api/settings', { method: 'PUT', json: { [key]: next } }); }
    catch (e) { writeAccountPref(key, prev); setSettings({ [key]: prev }); throw e; }
  };
  return [value, set];
}
