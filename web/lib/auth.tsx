'use client';
import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { api, refreshSession, setAccessToken } from './api';
import { deviceId, deviceName } from './device';

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
          setUser(me);
          applyAccent(me.settings);
          setStatus('authed');
        } catch {
          setStatus('anon');
        }
      } else {
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
      setAccessToken(res.accessToken);
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
    setUser(null);
    setStatus('anon');
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
