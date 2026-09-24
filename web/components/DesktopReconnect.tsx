'use client';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Mark } from './Brand';
import { t as tr } from '@/lib/i18n';

/**
 * Uchiyomi Desktop's only fallback when it cannot open its own library.
 *
 * The desktop app has no sign-in screen: the window is signed in by the shell (`POST /auth/desktop`, see
 * lib/api.ts), and a lapsed session is exchanged again without anyone seeing it. So `anon` inside the app's
 * window means the exchange ITSELF was refused -- the shell did not hand the page its header, or the server
 * running is not the one this window was opened for. A password form would be a dead end (there is no
 * password), so this says what happened and offers the two things that can fix it: ask again, then restart.
 *
 * Shown only when the preload marker is present (AppShell); a browser tab on the same port gets
 * LoginScreen's "opens in the Uchiyomi app" line instead.
 */
export function DesktopReconnect() {
  const { reconnect } = useAuth();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const retry = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await reconnect().catch(() => false);
    // On success the provider flips to `authed` and this screen unmounts; only a second refusal lands here.
    if (!ok) { setFailed(true); setBusy(false); }
  };

  return (
    <div className="flex min-h-screen-d flex-col items-center justify-center gap-4 px-6 text-center">
      <Mark size={56} />
      <h1 className="font-display text-xl font-semibold text-fog-50">{tr('Uchiyomi couldn’t open your library')}</h1>
      <p className="max-w-sm text-sm text-fog-400">{tr('The app could not sign itself in to the library on this computer.')}</p>
      <button type="button" onClick={retry} disabled={busy} className="btn-accent px-5 py-2.5 text-sm disabled:opacity-50">
        {busy ? tr('Trying…') : tr('Try again')}
      </button>
      {failed && (
        <p role="status" className="max-w-sm text-xs text-fog-500">
          {tr('Still no luck. Restart Uchiyomi: choose Quit from its icon in the taskbar tray or menu bar, then open it again.')}
        </p>
      )}
    </div>
  );
}
