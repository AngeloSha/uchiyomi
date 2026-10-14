'use client';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { IcRefresh } from './icons';
import { triggerRefresh } from '@/lib/refresh';
import { useToast } from './Toast';
import { t as tr } from '@/lib/i18n';

/**
 * "Check for new chapters" as a key (UI refresh): the round Refresh button the top bar had, now beside what it fills,
 * on Updates. Home still asks on every visit, the palette has "Refresh library", and Admin has "Scan library now".
 * The two notices are the top bar's, word for word: the result takes the busy card's place (one key, 'refresh').
 */
export function CheckForNew() {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    // One card: "Library refreshed" takes the place of the busy one (the same key).
    toast(tr('Checking for new chapters…'), 'info', { busy: true, key: 'refresh' });
    await triggerRefresh();
    setTimeout(() => {
      qc.invalidateQueries({ queryKey: ['home'] });
      qc.invalidateQueries({ queryKey: ['library'] });
      qc.invalidateQueries({ queryKey: ['updates'] });
      toast(tr('Library refreshed'), 'success', { key: 'refresh' });
      setBusy(false);
    }, 1800);
  };

  return (
    <button type="button" onClick={refresh} disabled={busy} data-check-for-new className="btn-key">
      <IcRefresh width={14} height={14} className={busy ? 'animate-spin' : undefined} />
      {tr('Check for new chapters')}
    </button>
  );
}
