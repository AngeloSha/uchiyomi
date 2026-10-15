'use client';
import { api } from './api';
import { useAuth } from './auth';

/**
 * Reduce effects (lib/effects.ts) as the Settings switch and the profile's quick settings both hold it: `[on, set]`. `set` applies at
 * once (`setSettings` sets html.reduce-effects and its mirror), saves to the account, and puts the old value back and rejects when the
 * server refuses, so the switch never shows a state the account does not hold.
 */
export function useReduceEffects(): [boolean, (next: boolean) => Promise<void>] {
  const { user, setSettings } = useAuth();
  const on = user?.settings?.reduceEffects === true;
  const set = async (next: boolean) => {
    const prev = on;
    setSettings({ reduceEffects: next });
    try { await api('/api/settings', { method: 'PUT', json: { reduceEffects: next } }); }
    catch (e) { setSettings({ reduceEffects: prev }); throw e; }
  };
  return [on, set];
}
