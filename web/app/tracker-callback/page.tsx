'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';
import { clearPending, readPending, readReturn } from '@/lib/trackerSignIn';

const BACK = '/profile/?tab=Connections&card=tracking';

/**
 * Where AniList and MyAnimeList send people back after they sign in (the redirect URL an admin registers is this
 * page's address). Reads what came back, finishes the connection through the server, and returns to the
 * Connections tab with a toast. It only acts on a sign-in this browser began (lib/trackerSignIn.ts), so a link
 * someone else crafted cannot attach their account to yours.
 */
export default function TrackerCallbackPage() {
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const ran = useRef(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const pending = readPending();
    const back = readReturn(window.location.search, window.location.hash);
    // Take the token out of the address bar and history at once, whatever happens next.
    window.history.replaceState(null, '', window.location.pathname);
    const fail = (m: string) => { clearPending(); setFailed(m); };
    if (!pending) return fail(tr('This sign-in was not started here. Go back and press Connect again.'));
    if (back.error) return fail(back.errorText || tr('The service did not finish signing you in.'));
    (async () => {
      try {
        let r: { account: string };
        if (pending.provider === 'myanimelist') {
          if (!back.code || back.state !== pending.state) return fail(tr('The sign-in did not come back complete. Go back and press Connect again.'));
          r = await api(`/api/trackers/myanimelist/oauth`, { json: { code: back.code, verifier: pending.verifier, redirectUri: pending.redirectUri } });
        } else {
          if (!back.token) return fail(tr('The sign-in did not come back complete. Go back and press Connect again.'));
          r = await api(`/api/trackers/${pending.provider}/connect`, { json: { token: back.token } });
        }
        clearPending();
        toast(tr('Connected to {name} as {account}', { name: pending.provider === 'anilist' ? 'AniList' : 'MyAnimeList', account: r.account }), 'success');
        qc.invalidateQueries({ queryKey: ['trackers'] });
        if (pending.provider === 'anilist') {
          const b = await api<{ series: number }>('/api/trackers/anilist/backfill', { json: {} }).catch(() => null);
          if (b?.series) toast(tr('Syncing {n} series you have already finished…', { n: b.series }), 'info', { busy: true });
        }
        router.replace(BACK);
      } catch (e: any) { fail(msgOf(e, tr('Could not finish connecting.'))); }
    })();
  }, [qc, router, toast]);

  return (
    <div className="mx-auto max-w-md px-4 pt-24 text-center">
      {failed ? (
        <>
          <p role="alert" className="text-sm text-red-300">{failed}</p>
          <button type="button" onClick={() => router.replace(BACK)} className="btn-accent mt-4 px-4 py-2 text-sm">{tr('Back to Connections')}</button>
        </>
      ) : (
        <p role="status" className="text-sm text-fog-300">{tr('Finishing the connection…')}</p>
      )}
    </div>
  );
}
