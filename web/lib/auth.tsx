'use client';
import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { api, ApiError, refreshSession, setAccessToken, setCurrentUser } from './api';
import { readOfflineIdentity, writeOfflineIdentity, clearOfflineIdentity, OfflineIdentity } from './offlineIdentity';
import { deviceId, deviceName } from './device';
import { clearShownOnce } from './shownOnce';
import { applyReduceEffects, restoreReduceEffects } from './effects';
import { applyTone, restoreTone } from './tone';
import { flushOutbox } from './downloads';
import { setAdultShown } from './adult';
import { isDesktop, serverReachableHint, untilReachable } from './desktop';
import { t as tr } from './i18n';
import type { AvatarFrame } from './badges';

/** `frame` since v0.89.0 (#267): the frame one of the account's badges unlocked (lib/badges.ts). */
export interface Avatar { emoji?: string; color?: string; frame?: AvatarFrame }
interface User {
  id: string;
  username: string | null;
  displayName: string;
  role: string;
  totpEnabled?: boolean;
  /** Linked to an identity at the OIDC provider (v0.63.0): Profile → Account offers Link to … until it is. */
  sso?: boolean;
  /** What kind of profile this is (bff lib/profiles.ts): `desktop-owner` is Uchiyomi Desktop's own account. */
  kind?: string;
  perms?: Record<string, boolean>;
  avatar?: Avatar;
  settings: Record<string, any>;
  /** v0.90.0: whether this server has chapter comments at all (bff lib/comments.ts talkOn), for Comments and reactions. */
  talk?: boolean;
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
  /** `remember`: Remember on this device (bff lib/deviceRing.ts). */
  login: (username: string, password: string, code?: string, remember?: boolean) => Promise<{ ok: boolean; totp?: boolean; error?: string }>;
  firstRunSetup: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  /** Sign up while Open registration is on (v0.61.0). `closed`: it was switched off meanwhile. */
  register: (username: string, password: string) => Promise<{ ok: boolean; closed?: boolean; error?: string }>;
  logout: () => Promise<void>;
  setSettings: (partial: Record<string, any>) => void;
  setAvatar: (avatar: Avatar) => void;
  /** Written the moment 2FA is enabled or disabled, see the note beside its definition. */
  setTotpEnabled: (v: boolean) => void;
  /** Uchiyomi Desktop (lib/desktop.ts): one person, signed in by the app, nothing for other devices. */
  desktop: boolean;
  /** Try the session again -- DesktopReconnect's button. True when it came back. */
  reconnect: () => Promise<boolean>;
  /** Switch this device to a profile that opens at home, without its password (bff POST /auth/switch). */
  switchProfile: (profileId: string) => Promise<{ ok: boolean; error?: string }>;
  /** Take up an account this device remembers, without its password (bff POST /auth/resume). */
  resumeProfile: (profileId: string) => Promise<{ ok: boolean; error?: string }>;
  /** Sign in from the sign-in screen as a profile that opens at home, when an admin offers it (POST /auth/profile-login). */
  pickProfile: (profileId: string) => Promise<{ ok: boolean; error?: string }>;
  /** Sign in as someone else, keeping this account remembered on this device when it is (bff POST /auth/leave). */
  leave: () => Promise<void>;
  /** Uchiyomi Desktop: from a profile switched to on this PC back to its owner (the shell's POST /auth/desktop). */
  backToOwner: () => Promise<boolean>;
  /** Why the server last signed this device out, by its code: `local_only` is a profile that opens at home, from outside. */
  signedOutWhy: string | null;
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
  const [signedOutWhy, setSignedOutWhy] = useState<string | null>(null);
  // Who this tab shows, compared at every refresh: the refresh cookie is the browser's, and another tab may have switched
  // it to another profile (switchProfile). Not `user`, which the effect below holds as it was at mount, and not
  // getCurrentUser(), which refreshSession has already set to whoever answered.
  const shownUser = useRef<string | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  // Read from the context rather than with useQueryClient, which throws without a provider: tests mount AuthProvider
  // alone, and a provider-less AuthProvider simply has no query cache to clear.
  const qc = useContext(QueryClientContext);

  /**
   * Everything this tab holds for the account that was signed in: the service worker's caches, and the in-memory query
   * cache. The query cache outlives a sign-out (no reload, staleTime 30 s, kept 5 min unused), so the next person on a
   * shared device was shown the last one's Wrapped, history, stats and picks -- 18+ titles to an age-capped account
   * included -- until each query refetched. Run at sign-out and at every sign-in, whoever signed in before.
   */
  const forgetAccountData = async () => {
    qc?.clear();
    await purgeAccountCaches();
  };

  /**
   * The server has confirmed who we are. One function, because five paths reach this state (boot, login, sign-up,
   * first-run setup, reconnect) and a field added to one of them would otherwise be missing from the others.
   *
   * `setCurrentUser` comes FIRST, before `setUser` and before anything renders: the reader consults the
   * offline store without waiting for React, so the identity has to be in place the moment the session is.
   */
  const adoptAuthed = (u: User, exp?: number) => {
    setCurrentUser(u.id);
    shownUser.current = u.id;
    void tellWorkerUser(u.id);
    writeOfflineIdentity(u, exp);
    setUser(u);
    applyAccent(u.settings);
    // ⚠️ Before setStatus, never in an effect after it: `authed` is what mounts CinematicFX, and a class that
    // arrived one commit later would let the mesh, grain and vignette paint a frame on every reload with
    // Reduce effects on (#71). Both directions, so the next account on a shared device gets its own setting.
    applyReduceEffects(u.settings?.reduceEffects === true);
    // The background tone (lib/tone.ts), for the same reason: the shell's first frame is already in it.
    applyTone(u.settings?.tone);
    setStatus('authed');
  };

  /** No server, but this device remembers an unexpired session. Open the downloads rather than the sign-in. */
  const adoptOffline = (saved: OfflineIdentity) => {
    setCurrentUser(saved.id);
    shownUser.current = saved.id;
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
    // No server to ask, so the device's copy, which the last online sign-in of this same account wrote (the
    // mirror is cleared with the saved identity on sign-out). Before setStatus for the same reason as above.
    restoreReduceEffects();
    restoreTone();
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
    shownUser.current = null;
    clearOfflineIdentity();
    // The sign-in screen belongs to nobody, so it gets the app's default look -- and the mirror goes with the
    // saved identity it exists to serve, or the next person's offline launch would inherit this one's choice.
    //
    // This runs for an EXPIRED session too, and that is right rather than merely tolerable: the line above
    // has just cleared the offline identity, so `adoptOffline` -- the only reader of the mirror that belongs
    // to an account -- can no longer run, and a kept mirror would do nothing but render the splash and the
    // sign-in screen reduced for whoever's session happened to lapse. The account still holds the setting and
    // the next sign-in applies it, both ways.
    applyReduceEffects(false);
    // The tone likewise: the sign-in screen is OLED, and the next person's offline launch does not inherit this one's.
    applyTone(null);
    setUser(null);
    setStatus('anon');
    // Secrets the server only ever sends once are held outside React so a remount cannot destroy them.
    // That store has to end with the session, or a shared machine hands the next person a live token.
    clearShownOnce();
    void tellWorkerUser(null);
    await forgetAccountData();
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
      const before = shownUser.current;
      const r = await refreshSession();
      if (!alive) return;
      // Another tab switched this browser to another profile: nothing this tab holds is the new one's, so it starts over
      // as it. Reintroduce by adopting in place: "a profile switched in another tab starts this one over" in
      // web/test/profileSwitch.test.ts fails.
      if (r.kind === 'authed' && before && r.user.id !== before) {
        await forgetAccountData();
        window.location.reload();
        return;
      }
      if (r.kind === 'authed') adoptAuthed(r.user, r.refreshExpiresAt);
      else if (r.kind === 'rejected') { setSignedOutWhy(r.reason ?? null); await clearLocalSession(); }
      // 'unreachable': stay exactly as we are. A flaky network is not a sign-out.
    };

    (async () => {
      const saved = readOfflineIdentity();
      // Before the first paint, and before any component can read IndexedDB.
      if (saved) setCurrentUser(saved.id);

      // A definitive negative. `navigator.onLine === false` cannot be wrong in this direction, and without
      // this short-circuit a captive portal or a DNS black hole holds the splash screen -- and therefore the
      // whole app -- for however long `fetch` takes to give up, which on a plane is most of a minute.
      // Never taken on desktop, where the server is this computer (serverReachableHint, lib/desktop.ts).
      if (saved && !serverReachableHint()) {
        adoptOffline(saved);
        void revalidate(); // onLine can still lie the other way; harmless when it fails
        return;
      }

      // Desktop keeps the splash and asks again while its server starts (lib/desktop.ts); it is never
      // `offline`. Everywhere else this is one request, exactly as before.
      const r = await untilReachable(refreshSession, () => alive);
      if (!alive) return;
      if (r.kind === 'authed') adoptAuthed(r.user, r.refreshExpiresAt);
      else if (r.kind === 'rejected') { setSignedOutWhy(r.reason ?? null); await clearLocalSession(); }
      else if (saved) adoptOffline(saved);
      else { setCurrentUser(null); setStatus('anon'); }
    })();

    // keep the access token warm
    timer.current = setInterval(revalidate, 12 * 60 * 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') void revalidate(); };
    window.addEventListener('online', revalidate);
    document.addEventListener('visibilitychange', onVisible);
    // A switch in another tab of this browser says so at once, rather than at this tab's next refresh.
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel('yomi-auth');
      channel.current.onmessage = (e) => {
        if (e.data?.type === 'switched' && e.data.userId !== shownUser.current) window.location.reload();
      };
    }
    return () => {
      alive = false;
      channel.current?.close();
      channel.current = null;
      clearInterval(timer.current);
      window.removeEventListener('online', revalidate);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const login = async (username: string, password: string, code?: string, remember?: boolean): Promise<{ ok: boolean; totp?: boolean; error?: string }> => {
    try {
      const res = await api<{ accessToken: string; user: User; refreshExpiresAt?: number }>('/auth/login', {
        json: { username, password, code, deviceId: deviceId(), deviceName: deviceName(), ...(remember ? { remember: true } : {}) },
      });
      await forgetAccountData(); // whoever used this device last does not get to answer this account's requests
      setAccessToken(res.accessToken);
      // After the purge, never before: the identity write must not be the thing the purge sweeps away.
      adoptAuthed(res.user, res.refreshExpiresAt);
      return { ok: true };
    } catch (e: any) {
      let body: any = {};
      try { body = JSON.parse(e?.body || '{}'); } catch {}
      if (body.error === 'totp_required') return { ok: false, totp: true };
      // The reason by its code first, in the reader's words: the server's own sentence for three of these is English,
      // and the sign-in screen is translated before anyone signs in (lib/i18n.ts). Anything else as the server said it.
      const msg =
        body.error === 'invalid_credentials' ? tr('Incorrect username or password.')
          : body.error === 'totp_invalid' ? tr('Incorrect authentication code.')
          : body.error === 'disabled' ? tr('This account is disabled.')
          : body.error === 'locked' ? tr('Account locked — too many attempts. Try again later.')
          // The per-address limit and the per-name one both answer 429; the address limit's body is the plugin's English.
          : body.error === 'too_many_requests' || e?.status === 429 ? tr('Too many attempts. Wait a few minutes and try again.')
          : body.message || tr('Login failed — please try again.');
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
      // By its code first, as a sign-in's refusal is: the server's sentences are English.
      const error = body.error === 'bad_request' ? tr('Username: letters, numbers, . _ - (2–64 characters).')
        : body.error === 'already_configured' ? tr('This server is already set up.')
        : body.error === 'weak_password' ? tr('Password must be at least 8 characters.')
        : body.message || tr('Setup failed — please try again.');
      return { ok: false, error };
    }
  };

  /**
   * Sign up (v0.61.0): Admin → Settings → Open registration has a form on the sign-in screen at last. A sign-in like
   * `login`, step for step -- the caches of whoever used this device last are purged first, the session is adopted, and
   * the device names itself so the new session reads as this phone in the sessions list.
   *
   * The refusal by its code first, in the reader's words (the server's sentences are English): a name that is taken --
   * in any case, the server says -- the password and name rules setup already words, registration switched off since
   * the screen was drawn (`closed`: the screen goes back to signing in and drops its link), and the five-in-ten-minutes
   * limit, whose 429 carries no code of ours. Reintroduce `body.message ||` ahead of the codes: "a sign-up refusal is
   * said by its code first" in web/test/signUp.test.ts fails.
   */
  const register = async (username: string, password: string): Promise<{ ok: boolean; closed?: boolean; error?: string }> => {
    try {
      const res = await api<{ accessToken: string; user: User; refreshExpiresAt?: number }>('/auth/register', {
        json: { username, password, deviceId: deviceId(), deviceName: deviceName() },
      });
      await forgetAccountData();
      setAccessToken(res.accessToken);
      adoptAuthed(res.user, res.refreshExpiresAt);
      return { ok: true };
    } catch (e: any) {
      let body: any = {};
      try { body = JSON.parse(e?.body || '{}'); } catch {}
      const status = e instanceof ApiError ? e.status : 0;
      if (body.error === 'registration_disabled') {
        return { ok: false, closed: true, error: tr('Sign-up is turned off on this server. Ask whoever runs it for an account.') };
      }
      const error = body.error === 'username_taken' || status === 409 ? tr('That username is taken.')
        : body.error === 'weak_password' ? tr('Password must be at least 8 characters.')
        : body.error === 'bad_request' ? tr('Username: letters, numbers, . _ - (2–64 characters).')
        : status === 429 ? tr('Too many attempts. Wait a few minutes and try again.')
        : body.message || tr('Could not create account');
      return { ok: false, error };
    }
  };

  /**
   * Change the person on this device without a password: to a profile that opens at
   * home (bff POST /auth/switch), or to an account the device remembers (POST /auth/resume). A sign-in like `login`,
   * step for step, with what a change of person needs on top:
   * reading queued offline is sent first, while the session it was read in still answers (lib/downloads.ts flushOutbox
   * files it against whoever is signed in); the caches go only once the server has said yes, so a refused switch leaves
   * the screen as it was; the 18+ reveal, the browser's and not the account's (lib/adult.ts), is put away, so a child
   * does not inherit it; and the other tabs are told. Reintroduce a step out of order: web/test/profileSwitch.test.ts.
   */
  const changeProfile = async (path: '/auth/switch' | '/auth/resume' | '/auth/profile-login', profileId: string): Promise<{ ok: boolean; error?: string }> => {
    await flushOutbox().catch(() => 0);
    let res: { accessToken: string; user: User; refreshExpiresAt?: number };
    try {
      res = await api(path, { json: { profileId } });
    } catch (e: any) {
      let body: any = {};
      try { body = JSON.parse(e?.body || '{}'); } catch {}
      return {
        ok: false,
        error: body.error === 'local_only' ? tr('Profiles without a password open from home only.')
          : body.error === 'reauth' ? tr('Sign in again: an admin stays remembered for 12 hours.')
          : tr('Could not switch profile'),
      };
    }
    await forgetAccountData();
    setAdultShown(false);
    setAccessToken(res.accessToken);
    adoptAuthed(res.user, res.refreshExpiresAt);
    channel.current?.postMessage({ type: 'switched', userId: res.user.id });
    return { ok: true };
  };
  const switchProfile = (profileId: string) => changeProfile('/auth/switch', profileId);
  const resumeProfile = (profileId: string) => changeProfile('/auth/resume', profileId);
  const pickProfile = (profileId: string) => changeProfile('/auth/profile-login', profileId);

  /**
   * Uchiyomi Desktop: back to the owner from a profile switched to on this PC. The shell's own handshake signs the owner
   * in again (POST /auth/desktop, the header added below the page; lib/api.ts desktopExchange), taking up the session the
   * profile was opened from; then the app starts over as the owner, as after a switch in another tab. Queued reading
   * goes first, while the profile's session still answers.
   */
  const backToOwner = async (): Promise<boolean> => {
    await flushOutbox().catch(() => 0);
    const r = await fetch('/auth/desktop', { method: 'POST', credentials: 'include' }).catch(() => null);
    if (!r?.ok) return false;
    await forgetAccountData();
    setAdultShown(false);
    window.location.reload();
    return true;
  };

  /** Sign in as someone else: an account this device remembers is put aside rather than ended (bff POST /auth/leave). */
  const leave = async () => {
    try { await api('/auth/leave', { method: 'POST' }); } catch {}
    await clearLocalSession();
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
    // The Appearance switch applies the moment it is flipped, and again (reverted) if the save is refused.
    if ('reduceEffects' in partial) applyReduceEffects(partial.reduceEffects === true);
    if ('tone' in partial) applyTone(partial.tone);
  };

  const setAvatar = (avatar: Avatar) => setUser((u) => (u ? { ...u, avatar } : u));

  // ⚠️ `user` is otherwise re-read only by `revalidate` -- every 12 minutes and on visibilitychange -- and the
  // Account tab initialises its 2FA state from `user.totpEnabled` on every mount. Without this, enabling 2FA
  // and then leaving the tab and coming back showed "Set up 2FA" over a live secret, and pressing it ran a
  // setup that rotated that secret while the recovery codes were still on screen.
  const setTotpEnabled = (v: boolean) => setUser((u) => (u ? { ...u, totpEnabled: v } : u));

  // DesktopReconnect's Retry: the refresh, and on the desktop app the exchange behind it (lib/api.ts).
  const reconnect = async (): Promise<boolean> => {
    const r = await refreshSession();
    if (r.kind !== 'authed') return false;
    adoptAuthed(r.user, r.refreshExpiresAt);
    return true;
  };

  return (
    <Ctx.Provider value={{ status, user, isAdmin: user?.role === 'admin', login, firstRunSetup, register, logout, setSettings, setAvatar, setTotpEnabled, switchProfile, resumeProfile, pickProfile, leave, backToOwner, signedOutWhy, desktop: isDesktop(), reconnect }}>
      {children}
    </Ctx.Provider>
  );
}
