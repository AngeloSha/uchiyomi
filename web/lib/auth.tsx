'use client';
import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { api, refreshSession, setAccessToken, setCurrentUser } from './api';
import { readOfflineIdentity, writeOfflineIdentity, clearOfflineIdentity, OfflineIdentity } from './offlineIdentity';
import { deviceId, deviceName } from './device';
import { clearShownOnce } from './shownOnce';

export interface Avatar { emoji?: string; color?: string }
interface User {
  id: string;
  username: string | null;
  displayName: string;
  role: string;
  totpEnabled?: boolean;
  perms?: Record<string, boolean>;
  avatar?: Avatar;
  settings: Record<string, any>;
}
/**
 * ⚠️ `offline` is a distinct state, not `authed` with a flag beside it.
 *
 * `status` is compared against `'authed'` in several places that mean "the server is reachable and this
 * session is live" -- deciding whether to run the smart-offline downloader, whether the command palette is
 * armed. A boolean would silently widen every one of those, and the downloader would start firing at a dead
 * network. A separate member keeps each existing comparison meaning what it already meant, and makes the
 * type checker point at anything that now needs a decision.
 *
 * Only BOOT may enter `offline`. The keep-warm interval and the reconnect handler promote (`offline` ->
 * `authed`) or eject (-> `anon`); they never demote, or one failed ping on flaky Wi-Fi would swap the whole
 * chrome out from under someone mid-browse.
 */
type Status = 'loading' | 'authed' | 'offline' | 'anon';

interface AuthCtx {
  status: Status;
  user: User | null;
  isAdmin: boolean;
  login: (username: string, password: string, code?: string) => Promise<{ ok: boolean; totp?: boolean; error?: string }>;
  firstRunSetup: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  setSettings: (partial: Record<string, any>) => void;
  setAvatar: (avatar: Avatar) => void;
  /** Written the moment 2FA is enabled or disabled, see the note beside its definition. */
  setTotpEnabled: (v: boolean) => void;
}

const Ctx = createContext<AuthCtx>(null as any);
export const useAuth = () => useContext(Ctx);

/**
 * May this account add series from a source?
 *
 * One definition, because three places ask: both navs (whether to show Discover at all) and the page itself
 * (what to render if someone types the URL). Only the literal `false` denies and admins are exempt, matching
 * the server's rule exactly -- a UI that hid the tab on a looser rule would hide a working page.
 *
 * Loading counts as allowed so the tab does not flicker in on every navigation before /auth/me answers. The
 * server is the enforcement point; this only decides what is worth showing.
 */
export function canDownload(user: { role?: string; perms?: Record<string, boolean> } | null | undefined): boolean {
  if (!user) return true;
  return user.role === 'admin' || user.perms?.canDownload !== false;
}

function applyAccent(settings?: Record<string, any>) {
  const hex: string | undefined = settings?.accent;
  if (hex && /^#?[0-9a-fA-F]{6}$/.test(hex)) {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    document.documentElement.style.setProperty('--accent', `${r} ${g} ${b}`);
  }
}

/**
 * Tell the service worker to empty the caches that hold one account's answers.
 *
 * The SW's API and image caches are keyed by URL with no `Vary` and were only ever emptied on a VERSION
 * bump, so on a shared tablet the next person to sign in could be served the previous one's home screen,
 * history and covers the moment the network hiccuped. Sent on the way out AND on the way in, because signing
 * in as someone else without signing out first is the ordinary way a household device changes hands.
 */
/** Tell the worker who is signed in, so background sync files queued reading against the right account. */
async function tellWorkerUser(userId: string | null): Promise<void> {
  try {
    const reg = await Promise.race([
      navigator.serviceWorker?.ready,
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 1500)),
    ]);
    reg?.active?.postMessage({ type: 'yomi-user', userId });
  } catch { /* no worker: the foreground flush is the only one, and it knows */ }
}

async function purgeAccountCaches(): Promise<void> {
  try {
    // `serviceWorker.ready` resolves only once a worker is ACTIVE, and never at all if registration failed or
    // has not happened yet -- so awaiting it bare would hang sign-in on exactly the browsers where there is
    // nothing cached to purge. Bounded, and the purge is best-effort by nature.
    const reg = await Promise.race([
      navigator.serviceWorker?.ready,
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 1500)),
    ]);
    reg?.active?.postMessage({ type: 'yomi-signout' });
  } catch { /* no service worker (dev, or an unsupported browser) — nothing is cached to leak */ }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<User | null>(null);
  const timer = useRef<any>(null);

  /**
   * The server has confirmed who we are. One function, because four paths reach this state (boot, login,
   * first-run setup, reconnect) and a field added to one of them would otherwise be missing from the others.
   *
   * `setCurrentUser` comes FIRST, before `setUser` and before anything renders: the reader consults the
   * offline store without waiting for React, so the identity has to be in place the moment the session is.
   */
  const adoptAuthed = (u: User, exp?: number) => {
    setCurrentUser(u.id);
    void tellWorkerUser(u.id);
    writeOfflineIdentity(u, exp);
    setUser(u);
    applyAccent(u.settings);
    setStatus('authed');
  };

  /** No server, but this device remembers an unexpired session. Open the downloads rather than the sign-in. */
  const adoptOffline = (saved: OfflineIdentity) => {
    setCurrentUser(saved.id);
    // ⚠️ Not optional. The worker starts each launch with no idea who is signed in, and its background flush
    // skips every event stamped with an owner while that is true -- so without this line, reading queued
    // offline would be dropped silently by the one flush that runs after the app is closed.
    void tellWorkerUser(saved.id);
    setUser({
      id: saved.id, username: saved.username, displayName: saved.displayName,
      role: saved.role, perms: saved.perms, avatar: saved.avatar,
      settings: saved.accent ? { accent: saved.accent } : {},
    });
    applyAccent({ accent: saved.accent });
    setStatus('offline');
  };

  /**
   * Everything `logout` does locally, minus the server call.
   *
   * Shared so that the rejection path cannot drift from the sign-out path: if a future field needs clearing,
   * forgetting it in one of the two would leave the next person on a shared tablet holding the previous
   * person's identity -- and with it, the key to their downloads.
   */
  const clearLocalSession = async () => {
    setAccessToken(null);
    setCurrentUser(null);
    clearOfflineIdentity();
    setUser(null);
    setStatus('anon');
    // Secrets the server only ever sends once are held outside React so a remount cannot destroy them.
    // That store has to end with the session, or a shared machine hands the next person a live token.
    clearShownOnce();
    void tellWorkerUser(null);
    await purgeAccountCaches();
  };

  useEffect(() => {
    let alive = true;

    /**
     * Ask the server who we are, and act on which of the three answers came back.
     *
     * Used for the keep-warm interval, for `online`, and when an installed app is brought back to the
     * foreground -- which happens far more often than it is launched. It only ever promotes or ejects.
     */
    const revalidate = async () => {
      const r = await refreshSession();
      if (!alive) return;
      if (r.kind === 'authed') adoptAuthed(r.user, r.refreshExpiresAt);
      else if (r.kind === 'rejected') await clearLocalSession();
      // 'unreachable': stay exactly as we are. A flaky network is not a sign-out.
    };

    (async () => {
      const saved = readOfflineIdentity();
      // Before the first paint, and before any component can read IndexedDB.
      if (saved) setCurrentUser(saved.id);

      // A definitive negative. `navigator.onLine === false` cannot be wrong in this direction, and without
      // this short-circuit a captive portal or a DNS black hole holds the splash screen -- and therefore the
      // whole app -- for however long `fetch` takes to give up, which on a plane is most of a minute.
      if (saved && typeof navigator !== 'undefined' && navigator.onLine === false) {
        adoptOffline(saved);
        void revalidate(); // onLine can still lie the other way; harmless when it fails
        return;
      }

      const r = await refreshSession();
      if (!alive) return;
      if (r.kind === 'authed') adoptAuthed(r.user, r.refreshExpiresAt);
      else if (r.kind === 'rejected') await clearLocalSession();
      else if (saved) adoptOffline(saved);
      else { setCurrentUser(null); setStatus('anon'); }
    })();

    // keep the access token warm
    timer.current = setInterval(revalidate, 12 * 60 * 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') void revalidate(); };
    window.addEventListener('online', revalidate);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(timer.current);
      window.removeEventListener('online', revalidate);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const login = async (username: string, password: string, code?: string): Promise<{ ok: boolean; totp?: boolean; error?: string }> => {
    try {
      const res = await api<{ accessToken: string; user: User; refreshExpiresAt?: number }>('/auth/login', {
        json: { username, password, code, deviceId: deviceId(), deviceName: deviceName() },
      });
      await purgeAccountCaches(); // whoever used this device last does not get to answer this account's requests
      setAccessToken(res.accessToken);
      // After the purge, never before: the identity write must not be the thing the purge sweeps away.
      adoptAuthed(res.user, res.refreshExpiresAt);
      return { ok: true };
    } catch (e: any) {
      let body: any = {};
      try { body = JSON.parse(e?.body || '{}'); } catch {}
      if (body.error === 'totp_required') return { ok: false, totp: true };
      const msg =
        body.message ||
        (body.error === 'invalid_credentials' ? 'Incorrect username or password.'
          : body.error === 'totp_invalid' ? 'Incorrect authentication code.'
          : body.error === 'disabled' ? 'This account is disabled.'
          : body.error === 'locked' ? 'Account locked — too many attempts. Try again later.'
          : 'Login failed — please try again.');
      return { ok: false, error: msg };
    }
  };

  // First-run setup: create the very first admin (when the server has no users), then log straight in.
  const firstRunSetup = async (username: string, password: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await api<{ accessToken: string; user: User; refreshExpiresAt?: number }>('/api/setup', { json: { username, password } });
      setAccessToken(res.accessToken);
      adoptAuthed(res.user, res.refreshExpiresAt);
      return { ok: true };
    } catch (e: any) {
      let body: any = {};
      try { body = JSON.parse(e?.body || '{}'); } catch {}
      return { ok: false, error: body.message || 'Setup failed — please try again.' };
    }
  };

  const logout = async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {}
    // ⚠️ Signing out ENDS THE OFFLINE GRACE. `clearLocalSession` drops the saved identity, so the next cold
    // boot on this device -- online or not -- gets the sign-in screen, and the downloads in IndexedDB become
    // unaddressable again because nothing knows their owner. The chapters are deliberately left where they
    // are: they are scoped by owner, not secret, and signing back in makes them readable again without a
    // re-download. Reintroduce by clearing the session without the identity, and the next person to pick up
    // the tablet inherits the previous person's offline library.
    await clearLocalSession();
  };

  const setSettings = (partial: Record<string, any>) => {
    setUser((u) => (u ? { ...u, settings: { ...u.settings, ...partial } } : u));
    applyAccent({ ...(user?.settings || {}), ...partial });
  };

  const setAvatar = (avatar: Avatar) => setUser((u) => (u ? { ...u, avatar } : u));

  // ⚠️ `user` is otherwise re-read only by `revalidate` -- every 12 minutes and on visibilitychange -- and the
  // Account tab initialises its 2FA state from `user.totpEnabled` on every mount. Without this, enabling 2FA
  // and then leaving the tab and coming back showed "Set up 2FA" over a live secret, and pressing it ran a
  // setup that rotated that secret while the recovery codes were still on screen.
  const setTotpEnabled = (v: boolean) => setUser((u) => (u ? { ...u, totpEnabled: v } : u));

  return (
    <Ctx.Provider value={{ status, user, isAdmin: user?.role === 'admin', login, firstRunSetup, logout, setSettings, setAvatar, setTotpEnabled }}>
      {children}
    </Ctx.Provider>
  );
}
