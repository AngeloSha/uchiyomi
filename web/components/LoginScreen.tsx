'use client';
import { Avatar } from './Avatar';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useAuth } from '@/lib/auth';
import { api, ApiError } from '@/lib/api';
import { noteServerDesktop } from '@/lib/desktop';
import { providerOnly, type AuthConfig } from '@/lib/authConfig';
import { ART } from '@/lib/art';
import { Mark, Wordmark } from './Brand';
import { t as tr } from '@/lib/i18n';

/**
 * Why the OIDC callback could not sign someone in, by the reason it sends back. A function, so each sentence is
 * translated when it is said: the screen is the first one anybody sees, and it is translated before sign-in
 * (lib/i18n.ts). It was a table of English sentences.
 */
const ssoError = (reason: string): string => {
  switch (reason) {
    // Said for both sign-in modes (v0.63.0): in SSO-only mode an admin cannot make the account, only let new people in.
    case 'no_account': return tr('You signed in, but there’s no account here for you yet. Ask the server’s admin to let you in.');
    // SSO-only mode on a new server: its first admin signs in first (bff routes/auth.ts firstAdmin).
    case 'not_set_up': return tr('This server isn’t set up yet: its admin signs in first.');
    case 'username_taken': return tr('An account with that username already exists here and is not linked to SSO.');
    case 'disabled': return tr('That account is disabled.');
    case 'expired': return tr('That sign-in took too long. Please try again.');
    case 'state_mismatch': return tr('That sign-in could not be verified. Please try again.');
    case 'exchange_failed': return tr('The login provider rejected the sign-in.');
    case 'oidc_unavailable': return tr('Could not reach the login provider.');
    case 'access_denied': return tr('Sign-in was cancelled.');
    default: return tr('Could not sign in with SSO.');
  }
};

export function LoginScreen() {
  const { login, firstRunSetup, register, signedOutWhy, resumeProfile, pickProfile } = useAuth();
  // `desktop`: this port is Uchiyomi Desktop's, reached from a browser tab -- see the effect below. `register` (v0.61.0):
  // signing up, reached only from `login` by "Create an account" while Open registration is on. `sso` (v0.63.0): the
  // server signs in through its provider only (lib/authConfig.ts providerOnly), so the screen is that button alone.
  const [mode, setMode] = useState<'checking' | 'login' | 'setup' | 'desktop' | 'register' | 'sso'>('checking');
  const [username, setUsername] = useState('');
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState('');
  // Remember on this device, and who it remembers (bff lib/deviceRing.ts): a tap each, no password.
  const [remember, setRemember] = useState(false);
  const [ring, setRing] = useState<{ id: string; displayName: string; avatar: Record<string, unknown> }[]>([]);
  const loadRing = () => api<{ content: typeof ring }>('/auth/ring').then((r) => setRing(r.content ?? []), () => {});
  // "Who is reading?" (bff /auth/pick): the profiles that open at home, offered here at home when an admin turned it on.
  const [readers, setReaders] = useState<typeof ring>([]);
  const [sso, setSso] = useState<{ enabled: boolean; name: string }>({ enabled: false, name: '' });
  // Admin → Settings → Open registration, as /auth/config says (v0.61.0). The switch existed and POST /auth/register
  // answered behind it, but this screen had no form, so turning it on did nothing anyone could see. Always false on
  // Uchiyomi Desktop, whose server says so whatever its settings hold.
  const [canRegister, setCanRegister] = useState(false);
  // /auth/config's answer (v0.63.0): read for `rescue`, the password form reopened for one admin in SSO-only mode.
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const err = !!errMsg;
  // globals.css kills CSS animation under prefers-reduced-motion, but it cannot reach framer-motion, so
  // this screen's backdrop ignored the setting until now.
  const still = useReducedMotion();

  // First-run detection: if the server has no users yet, show a create-admin form instead of login.
  useEffect(() => {
    (async () => {
      // ⚠️ A 404 here is Uchiyomi Desktop (it has no first-run setup route): stay on the spinner until
      // /auth/config has said so, rather than flash a sign-in form nobody can use. Any other failure still
      // falls back to the form at once, as it always has.
      let desktopMaybe = false;
      // What first-run setup says, kept until /auth/config has answered as well (v0.63.0): in SSO-only mode the screen
      // is the provider's button alone, and a password form shown in between would be a sign-in nobody can use.
      let first: 'setup' | 'login' | null = null;
      try {
        const s = await api<{ needsSetup: boolean }>('/api/setup/status');
        first = s.needsSetup ? 'setup' : 'login';
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) desktopMaybe = true;
        else setMode('login');
      }
      try {
        const c = await api<AuthConfig>('/auth/config');
        if (c.oidc?.enabled) setSso(c.oidc);
        setCanRegister(c.allowRegistration === true);
        setConfig(c);
        // A browser tab pointed at the desktop app's port: that library signs in only inside the app, and
        // this form could never succeed there (the server has no password sign-in to answer it).
        if (c.desktop === true) { noteServerDesktop(true); setMode('desktop'); }
        else if (desktopMaybe) setMode('login');
        else if (first) setMode(first === 'login' && providerOnly(c) ? 'sso' : first);
      } catch { /* SSO is optional; a failure here just means no button */ if (desktopMaybe) setMode('login'); else if (first) setMode(first); }
    })();
    // the OIDC callback sends people back here with a reason when it couldn't sign them in
    const reason = new URLSearchParams(window.location.search).get('sso_error');
    if (reason) {
      setErrMsg(ssoError(reason));
      window.history.replaceState({}, '', window.location.pathname);
    }
    // A profile that opens at home, used from outside it (bff lib/auth.ts authenticate): nothing was ended, and back home
    // it opens again. Said, so the sign-in form does not read as a sign-out nobody asked for.
    if (signedOutWhy === 'local_only') setErrMsg(tr('This profile opens from home only. Sign in with a password, or try again from home.'));
    void loadRing();
    void api<{ content: typeof ring }>('/auth/pick').then((r) => setReaders(r.content ?? []), () => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || (needTotp ? !code.trim() : !pw)) return;
    setBusy(true);
    setErrMsg('');
    const r = await login(username.trim() || 'admin', pw, needTotp ? code.trim() : undefined, remember);
    if (!r.ok) {
      if (r.totp) { setNeedTotp(true); setCode(''); }
      else { setErrMsg(r.error || tr('Login failed — please try again.')); setCode(''); if (!needTotp) setPw(''); }
    }
    setBusy(false);
  };

  /** Take up an account this device remembers; a refusal says why, and the list is asked again (an entry may be gone). */
  const resume = async (id: string, how: 'ring' | 'pick' = 'ring') => {
    if (busy) return;
    setBusy(true);
    setErrMsg('');
    const r = how === 'ring' ? await resumeProfile(id) : await pickProfile(id);
    if (!r.ok) { setErrMsg(r.error || tr('Login failed — please try again.')); void loadRing(); }
    setBusy(false);
  };

  /** What is wrong with the account form before anything is sent: setup's checks, which sign-up shares (v0.61.0). */
  const accountProblem = (): string => {
    if (username.trim().length < 2) return tr('Pick a username (at least 2 characters).');
    if (pw.length < 8) return tr('Password must be at least 8 characters.');
    if (pw !== confirm) return tr('Passwords do not match.');
    return '';
  };

  const submitSetup = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const problem = accountProblem();
    if (problem) { setErrMsg(problem); return; }
    setBusy(true);
    setErrMsg('');
    const r = await firstRunSetup(username.trim(), pw);
    if (!r.ok) setErrMsg(r.error || tr('Setup failed — please try again.'));
    setBusy(false);
  };

  // Between signing in and signing up: the password fields start empty and an old refusal goes, the name stays.
  const toMode = (next: 'login' | 'register') => { setMode(next); setErrMsg(''); setPw(''); setConfirm(''); };

  const submitRegister = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const problem = accountProblem();
    if (problem) { setErrMsg(problem); return; }
    setBusy(true);
    setErrMsg('');
    const r = await register(username.trim(), pw);
    if (!r.ok) {
      // Switched off since this screen asked: back to signing in, without the link, saying why.
      if (r.closed) { setCanRegister(false); toMode('login'); }
      setErrMsg(r.error || tr('Could not create account'));
    }
    setBusy(false);
  };

  const inputCls = `w-full rounded-2xl border bg-black/40 px-4 py-3.5 text-lg text-fog-50 outline-hidden transition placeholder:text-ink-500 ${err ? 'border-red-500/70' : 'border-white/10 focus:border-accent'}`;
  const labelCls = 'mb-2 block text-xs font-medium uppercase tracking-wider text-fog-500';

  return (
    <div className="relative flex min-h-screen-d flex-col items-center justify-center overflow-hidden px-6">
      {/* A wall of cover art, tilted. Built from this app's own key art (scripts/login-wall.py), never from
          the library: this screen is pre-auth, so anything here is visible to anyone who can reach the
          server. The scrims below are what carry the form's contrast -- the image itself is deliberately
          brighter than it looks here, because these layers darken it. */}
      <div className="absolute inset-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <motion.img
          src={ART.loginWall}
          // The browser picks by device pixel ratio: a 2K screen at DPR 2 needs 5120 device pixels, and
          // handing it the 2560 one produced exactly the softness this is here to fix.
          srcSet={`${ART.loginWall} 2560w, ${ART.loginWall2x} 5120w`}
          sizes="100vw"
          alt=""
          initial={still ? false : { scale: 1.1, opacity: 0 }}
          animate={still ? { opacity: 1 } : { scale: 1, opacity: 1 }}
          transition={still ? { duration: 0 } : { duration: 1.8, ease: [0.22, 1, 0.36, 1] }}
          className="h-full w-full object-cover"
        />
        {/* Heavier than the single key art needed: a busy wall takes more separating from the form. */}
        {/* ⚠️ No a `via` stop at 88% and a `to` stop at 62% here any more, and that is not a simplification: those two
            classes never rendered. Tailwind v3's opacity scale is multiples of 5, so 88% and 62% matched
            nothing and were dropped silently -- this scrim has always been the plain black-to-transparent
            fade it now says it is. Tailwind v4 accepts any integer, so leaving them in would have made a
            dependency bump quietly restyle the sign-in screen (the art goes muddy; see the comparison in
            CHANGELOG v0.23.0). Changing this look is a design decision, not a migration. */}
        <div className="absolute inset-0 bg-linear-to-t from-ink-950 to-transparent" />
        <div className="absolute inset-0" style={{ background: 'radial-gradient(58% 46% at 50% 42%, rgb(0 0 0 / 0.72), transparent 72%)' }} />
        <div className="absolute inset-0" style={{ background: 'radial-gradient(60% 50% at 50% 18%, rgb(var(--accent) / 0.18), transparent 70%)' }} />
      </div>
      <div className="fx-grain" />
      <div className="fx-vignette" />

      <motion.div
        initial={{ opacity: 0, y: 22 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}
        className="relative z-10 w-full max-w-sm"
      >
        <div className="mb-8 flex flex-col items-center text-center">
          <Mark size={56} />
          <Wordmark className="mt-5 text-5xl drop-shadow-[0_2px_20px_rgba(0,0,0,0.6)]" />
          <p className="mt-2 text-sm text-fog-300">{mode === 'setup' ? tr('Welcome — create your admin account.') : tr('Your library, your way.')}</p>
        </div>

        {mode === 'desktop' && (
          <div className="glass grad-border rounded-3xl p-6 text-center shadow-lift">
            <p className="text-sm text-fog-100">{tr('This library opens in the Uchiyomi app on this computer.')}</p>
            <p className="mt-2 text-xs text-fog-500">{tr('Open Uchiyomi from the Start menu or your Applications folder.')}</p>
          </div>
        )}

        {mode === 'checking' && (
          <div className="glass grad-border flex items-center justify-center rounded-3xl p-10 shadow-lift">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/15 border-t-accent" />
          </div>
        )}

        {/* First-run: create the admin account */}
        {mode === 'setup' && (
          <AccountForm onSubmit={submitSetup} nameLabel={tr('Admin username')} namePlaceholder={tr('admin')}
            submitLabel={tr('Create admin account & open Uchiyomi')}
            footer={<p className="mt-3 text-center text-xs text-fog-500">{tr('This first account becomes the server admin.')}</p>}
            {...{ username, setUsername, pw, setPw, confirm, setConfirm, busy, errMsg, inputCls, labelCls }} />
        )}

        {/* Signing up (v0.61.0): the same form, as a member. Setup always wins -- `register` is reached only from `login`. */}
        {mode === 'register' && (
          <AccountForm onSubmit={submitRegister} nameLabel={tr('Username')} submitLabel={tr('Create account')}
            footer={(
              <button type="button" onClick={() => toMode('login')} className="mt-3 w-full text-center text-xs text-fog-500 hover:text-fog-300">
                {tr('Already have an account? Sign in')}
              </button>
            )}
            {...{ username, setUsername, pw, setPw, confirm, setConfirm, busy, errMsg, inputCls, labelCls }} />
        )}

        {/* SSO-only (v0.63.0): the provider's button and nothing else -- this server takes no password. Reintroduce the
            form here and "an SSO-only server's screen is its provider's button alone" in web/test/ssoOnly.test.ts fails. */}
        {mode === 'sso' && (
          <div className="glass grad-border rounded-3xl p-5 shadow-lift" data-sso-only>
            <a href="/auth/oidc/start" className="btn-accent block w-full text-center">
              {tr('Continue with {name}', { name: `\u2068${sso.name}\u2069` })}
            </a>
            {errMsg && <p className="mt-3 text-sm text-red-400">{errMsg}</p>}
            <p className="mt-3 text-center text-xs text-fog-500">{tr('This server signs in through {name} only.', { name: `\u2068${sso.name}\u2069` })}</p>
          </div>
        )}

        {/* Normal sign-in */}
        {mode === 'login' && (
          <form onSubmit={submit} className="glass grad-border rounded-3xl p-5 shadow-lift">
            {(['ring', 'pick'] as const).map((how) => {
              const list = how === 'ring' ? ring : readers.filter((p) => !ring.some((r) => r.id === p.id));
              return list.length > 0 && !needTotp && (
              <div key={how} className="mb-4 space-y-2" data-device-ring={how}>
                <p className={labelCls}>{how === 'ring' ? tr('On this device') : tr('Who is reading?')}</p>
                {list.map((p) => (
                  <button key={p.id} type="button" disabled={busy} onClick={() => resume(p.id, how)}
                    className="flex w-full items-center gap-3 rounded-xl border border-ink-700 px-3 py-2 text-start text-sm text-fog-100 transition hover:border-accent disabled:opacity-60">
                    <Avatar avatar={p.avatar} size={28} />
                    <span className="min-w-0 flex-1 truncate">{p.displayName}</span>
                  </button>
                ))}
              </div>
              );
            })}
            {/* SSO-only mode with its rescue on (AUTH_RESCUE_ADMIN): the form is back for one admin, and says why. */}
            {config?.rescue && !needTotp && (
              <p className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200" data-sso-rescue>
                {tr('Password sign-in is open for one admin while the server’s rescue setting is on.')}
              </p>
            )}
            {!needTotp ? (
              <>
                <label className={labelCls}>{tr('Username')}</label>
                <input
                  type="text" autoCapitalize="none" autoCorrect="off" autoFocus
                  value={username} onChange={(e) => setUsername(e.target.value)} placeholder={tr('admin')}
                  className={`mb-4 ${inputCls}`}
                />
                <label className={labelCls}>{tr('Passcode')}</label>
                <input
                  type="password" inputMode="text"
                  value={pw} onChange={(e) => setPw(e.target.value)} placeholder="••••••••"
                  className={inputCls}
                />
                <label className="mt-3 flex items-center gap-2 text-xs text-fog-400">
                  <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} data-remember />
                  {tr('Remember on this device')}
                </label>
              </>
            ) : (
              <>
                <label className={labelCls}>{tr('Authentication code')}</label>
                <input
                  type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus
                  value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456"
                  className={`text-center text-2xl tracking-[0.3em] ${inputCls}`}
                />
                <p className="mt-2 text-xs text-fog-500">{tr('Enter the 6-digit code from your authenticator app, or a recovery code.')}</p>
              </>
            )}
            {errMsg && <p className="mt-2 text-sm text-red-400">{errMsg}</p>}
            <button type="submit" disabled={busy || (needTotp ? !code.trim() : !pw)} className="btn-accent mt-4 w-full disabled:opacity-50">
              {busy ? (needTotp ? tr('Verifying…') : tr('Opening…')) : needTotp ? tr('Verify') : tr('Open Uchiyomi')}
            </button>
            {needTotp && (
              <button type="button" onClick={() => { setNeedTotp(false); setErrMsg(''); setCode(''); }} className="mt-3 w-full text-center text-xs text-fog-500 hover:text-fog-300">‹ {tr('Back')}</button>
            )}
            {sso.enabled && !needTotp && (
              <>
                <div className="my-4 flex items-center gap-3">
                  <span className="h-px flex-1 bg-ink-700" />
                  <span className="text-[11px] uppercase tracking-wider text-fog-600 rtl:tracking-normal">{tr('or')}</span>
                  <span className="h-px flex-1 bg-ink-700" />
                </div>
                <a href="/auth/oidc/start" className="block w-full rounded-xl border border-ink-700 bg-ink-850/60 py-2.5 text-center text-sm text-fog-100 transition hover:border-accent hover:text-white">
                  {tr('Continue with {name}', { name: `\u2068${sso.name}\u2069` })}
                </a>
              </>
            )}
            {/* v0.61.0: only while Open registration is on, and never mid-way through a second step. Reintroduce the
                form-less screen by dropping this: "the sign-in form offers Create an account only while registration
                is open" in web/test/signUp.test.ts fails. */}
            {canRegister && !needTotp && (
              <button type="button" onClick={() => toMode('register')} className="mt-3 w-full text-center text-xs text-fog-500 hover:text-fog-300" data-create-account>
                {tr('Create an account')}
              </button>
            )}
          </form>
        )}

        <p className="mt-6 text-center text-xs text-fog-500">{mode === 'setup' ? tr('First-run setup') : tr('Private library · single sign-in')}</p>
      </motion.div>
    </div>
  );
}

/**
 * The form that makes an account (v0.61.0): first-run setup's admin, and a member signing up while Open registration is
 * on. One form so the two cannot drift -- setup passes exactly the words and classes its form always had. Each label
 * names its field, and autoComplete tells a password manager this is a new account: it offers to make the password
 * and saves it under the name typed. "signing up is first-run setup's form …" in web/test/signUp.test.ts holds setup's
 * words and classes to it; a second copy of the form fails it.
 */
function AccountForm({ onSubmit, nameLabel, namePlaceholder, submitLabel, footer, username, setUsername, pw, setPw, confirm, setConfirm,
  busy, errMsg, inputCls, labelCls }: {
  onSubmit: (e: FormEvent) => void;
  nameLabel: string;
  namePlaceholder?: string;
  submitLabel: string;
  footer: ReactNode;
  username: string;
  setUsername: (v: string) => void;
  pw: string;
  setPw: (v: string) => void;
  confirm: string;
  setConfirm: (v: string) => void;
  busy: boolean;
  errMsg: string;
  inputCls: string;
  labelCls: string;
}) {
  const id = useId();
  return (
    <form onSubmit={onSubmit} className="glass grad-border rounded-3xl p-5 shadow-lift">
      <label htmlFor={`${id}-name`} className={labelCls}>{nameLabel}</label>
      <input
        id={`${id}-name`} type="text" autoCapitalize="none" autoCorrect="off" autoComplete="username" autoFocus
        value={username} onChange={(e) => setUsername(e.target.value)} placeholder={namePlaceholder}
        className={`mb-4 ${inputCls}`}
      />
      <label htmlFor={`${id}-pw`} className={labelCls}>{tr('Password')}</label>
      <input
        id={`${id}-pw`} type="password" autoComplete="new-password"
        value={pw} onChange={(e) => setPw(e.target.value)} placeholder={tr('At least 8 characters')}
        className={`mb-4 ${inputCls}`}
      />
      <label htmlFor={`${id}-confirm`} className={labelCls}>{tr('Confirm password')}</label>
      <input
        id={`${id}-confirm`} type="password" autoComplete="new-password"
        value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••"
        className={inputCls}
      />
      {errMsg && <p className="mt-2 text-sm text-red-400">{errMsg}</p>}
      <button type="submit" disabled={busy} className="btn-accent mt-4 w-full disabled:opacity-50">
        {busy ? tr('Creating…') : submitLabel}
      </button>
      {footer}
    </form>
  );
}
