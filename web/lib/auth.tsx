'use client';
import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { api, refreshSession, setAccessToken, setCurrentUser } from './api';
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
type Status = 'loading' | 'authed' | 'anon';

interface AuthCtx {
  status: Status;
  user: User | null;
  isAdmin: boolean;
  login: (username: string, password: string, code?: string) => Promise<{ ok: boolean; totp?: boolean; error?: string }>;
  firstRunSetup: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  setSettings: (partial: Record<string, any>) => void;
  setAvatar: (avatar: Avatar) => void;
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

  useEffect(() => {
    let alive = true;
    (async () => {
      const ok = await refreshSession();
      if (!alive) return;
      if (ok) {
        try {
          const me = await api<User>('/auth/me');
          // Before setUser, and before anything renders: the reader reads the offline store without waiting
          // for React, so the identity has to be in place the moment the session is known. This is the path
          // that runs on every page load, which makes it the one that matters most.
          setCurrentUser(me.id);
          setUser(me);
          applyAccent(me.settings);
          setStatus('authed');
        } catch {
          setCurrentUser(null);
          setStatus('anon');
        }
      } else {
        setCurrentUser(null);
        setStatus('anon');
      }
    })();
    // keep the access token warm
    timer.current = setInterval(() => refreshSession(), 12 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(timer.current);
    };
  }, []);

  const login = async (username: string, password: string, code?: string): Promise<{ ok: boolean; totp?: boolean; error?: string }> => {
    try {
      const res = await api<{ accessToken: string; user: User }>('/auth/login', {
        json: { username, password, code, deviceId: deviceId(), deviceName: deviceName() },
      });
      await purgeAccountCaches(); // whoever used this device last does not get to answer this account's requests
      setAccessToken(res.accessToken);
      setCurrentUser(res.user.id);
      setUser(res.user);
      applyAccent(res.user.settings);
      setStatus('authed');
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
      const res = await api<{ accessToken: string; user: User }>('/api/setup', { json: { username, password } });
      setAccessToken(res.accessToken);
      setCurrentUser(res.user.id);
      setUser(res.user);
      applyAccent(res.user.settings);
      setStatus('authed');
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
    setAccessToken(null);
    setCurrentUser(null);
    setUser(null);
    setStatus('anon');
    // Secrets the server only ever sends once are held outside React so a remount cannot destroy them.
    // That store has to end with the session, or a shared machine hands the next person a live token.
    clearShownOnce();
    await purgeAccountCaches();
  };

  const setSettings = (partial: Record<string, any>) => {
    setUser((u) => (u ? { ...u, settings: { ...u.settings, ...partial } } : u));
    applyAccent({ ...(user?.settings || {}), ...partial });
  };

  const setAvatar = (avatar: Avatar) => setUser((u) => (u ? { ...u, avatar } : u));

  return (
    <Ctx.Provider value={{ status, user, isAdmin: user?.role === 'admin', login, firstRunSetup, logout, setSettings, setAvatar }}>
      {children}
    </Ctx.Provider>
  );
}
