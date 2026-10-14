'use client';
// Incognito reading on screen (v0.61.0): a line above every page while it is on, with the way to turn it off, and a
// squared tag in the reader's top bar. The switch itself is the account's (lib/incognito.ts says what it does).
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { t as tr } from '@/lib/i18n';
import { incognitoOf, incognitoRef } from '@/lib/incognito';
import { IcEyeOff } from './icons';
import { useToast } from './Toast';

export { incognitoRef } from '@/lib/incognito';

/**
 * The account's Incognito reading and the way to change it. Keeps incognitoRef in step for the reader's payload; the
 * change is applied at once and put back if the server refuses it, as every account switch is.
 */
export function useIncognito(): { on: boolean; set: (next: boolean) => Promise<void> } {
  const { user, setSettings } = useAuth();
  const on = incognitoOf(user?.settings);
  useEffect(() => { incognitoRef.current = on; }, [on]);
  const set = async (next: boolean) => {
    setSettings({ incognito: next });
    incognitoRef.current = next;
    try { await api('/api/settings', { method: 'PUT', json: { incognito: next } }); }
    catch (e) { setSettings({ incognito: !next }); incognitoRef.current = !next; throw e; }
  };
  return { on, set };
}

/** Above every page while it is on: what it means, and Turn off. */
export function IncognitoBanner() {
  const { on, set } = useIncognito();
  const toast = useToast();
  if (!on) return null;
  return (
    <div data-incognito-banner className="flex items-center justify-center gap-2 bg-ink-800 px-4 py-1.5 text-[11px] text-fog-300 lg:ps-[calc(var(--rail-w)+1rem)]">
      <IcEyeOff width={12} height={12} aria-hidden className="shrink-0" />
      <span className="min-w-0">{tr('Incognito reading is on: what you read is not recorded.')}</span>
      <button type="button" onClick={() => { set(false).catch(() => toast(tr('Could not save'), 'error')); }}
        className="btn-key h-6 shrink-0 px-2 text-[11px]" data-incognito-off>{tr('Turn off')}</button>
    </div>
  );
}

/** In the reader's top bar while it is on: a squared tag, never a capsule. */
export function IncognitoTag() {
  const { on } = useIncognito();
  if (!on) return null;
  return (
    <span data-incognito-tag className="inline-flex shrink-0 items-center gap-1 rounded-[4px] border border-white/25 bg-black/45 px-1.5 text-[10px] font-semibold leading-5 text-white backdrop-blur">
      <IcEyeOff width={11} height={11} aria-hidden />{tr('Incognito')}
    </span>
  );
}
