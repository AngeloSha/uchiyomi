'use client';
import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { ART } from '@/lib/art';
import { Mark, Wordmark } from './Brand';
import { t as tr } from '@/lib/i18n';

const SSO_ERRORS: Record<string, string> = {
  no_account: "You signed in successfully, but there's no account here for you yet. Ask the admin to create one.",
  username_taken: 'An account with that username already exists here and is not linked to SSO.',
  disabled: 'That account is disabled.',
  expired: 'That sign-in took too long. Please try again.',
  state_mismatch: 'That sign-in could not be verified. Please try again.',
  exchange_failed: 'The login provider rejected the sign-in.',
  oidc_unavailable: 'Could not reach the login provider.',
  access_denied: 'Sign-in was cancelled.',
};

export function LoginScreen() {
  const { login, firstRunSetup } = useAuth();
  const [mode, setMode] = useState<'checking' | 'login' | 'setup'>('checking');
  const [username, setUsername] = useState('');
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState('');
  const [sso, setSso] = useState<{ enabled: boolean; name: string }>({ enabled: false, name: '' });
  const err = !!errMsg;
  // globals.css kills CSS animation under prefers-reduced-motion, but it cannot reach framer-motion, so
  // this screen's backdrop ignored the setting until now.
  const still = useReducedMotion();

  // First-run detection: if the server has no users yet, show a create-admin form instead of login.
  useEffect(() => {
    (async () => {
      try {
        const s = await api<{ needsSetup: boolean }>('/api/setup/status');
        setMode(s.needsSetup ? 'setup' : 'login');
      } catch {
        setMode('login');
      }
      try {
        const c = await api<{ oidc?: { enabled: boolean; name: string } }>('/auth/config');
        if (c.oidc?.enabled) setSso(c.oidc);
      } catch { /* SSO is optional; a failure here just means no button */ }
    })();
    // the OIDC callback sends people back here with a reason when it couldn't sign them in
    const reason = new URLSearchParams(window.location.search).get('sso_error');
    if (reason) {
      setErrMsg(SSO_ERRORS[reason] || 'Could not sign in with SSO.');
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || (needTotp ? !code.trim() : !pw)) return;
    setBusy(true);
    setErrMsg('');
    const r = await login(username.trim() || 'admin', pw, needTotp ? code.trim() : undefined);
    if (!r.ok) {
      if (r.totp) { setNeedTotp(true); setCode(''); }
      else { setErrMsg(r.error || 'Login failed.'); setCode(''); if (!needTotp) setPw(''); }
    }
    setBusy(false);
  };

  const submitSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (username.trim().length < 2) { setErrMsg('Pick a username (at least 2 characters).'); return; }
    if (pw.length < 8) { setErrMsg('Password must be at least 8 characters.'); return; }
    if (pw !== confirm) { setErrMsg('Passwords do not match.'); return; }
    setBusy(true);
    setErrMsg('');
    const r = await firstRunSetup(username.trim(), pw);
    if (!r.ok) setErrMsg(r.error || 'Setup failed.');
    setBusy(false);
  };

  const inputCls = `w-full rounded-2xl border bg-black/40 px-4 py-3.5 text-lg text-fog-50 outline-none transition placeholder:text-ink-500 ${err ? 'border-red-500/70' : 'border-white/10 focus:border-accent'}`;
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
        <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/88 to-ink-950/62" />
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
          <p className="mt-2 text-sm text-fog-300">{mode === 'setup' ? 'Welcome — create your admin account.' : 'Your library, your way.'}</p>
        </div>

        {mode === 'checking' && (
          <div className="glass grad-border flex items-center justify-center rounded-3xl p-10 shadow-lift">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/15 border-t-accent" />
          </div>
        )}

        {/* First-run: create the admin account */}
        {mode === 'setup' && (
          <form onSubmit={submitSetup} className="glass grad-border rounded-3xl p-5 shadow-lift">
            <label className={labelCls}>{tr('Admin username')}</label>
            <input
              type="text" autoCapitalize="none" autoCorrect="off" autoFocus
              value={username} onChange={(e) => setUsername(e.target.value)} placeholder={tr('admin')}
              className={`mb-4 ${inputCls}`}
            />
            <label className={labelCls}>{tr('Password')}</label>
            <input
              type="password"
              value={pw} onChange={(e) => setPw(e.target.value)} placeholder={tr('At least 8 characters')}
              className={`mb-4 ${inputCls}`}
            />
            <label className={labelCls}>{tr('Confirm password')}</label>
            <input
              type="password"
              value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••"
              className={inputCls}
            />
            {errMsg && <p className="mt-2 text-sm text-red-400">{errMsg}</p>}
            <button type="submit" disabled={busy} className="btn-accent mt-4 w-full disabled:opacity-50">
              {busy ? 'Creating…' : 'Create admin & open Uchiyomi'}
            </button>
            <p className="mt-3 text-center text-xs text-fog-500">{tr('This first account becomes the server admin.')}</p>
          </form>
        )}

        {/* Normal sign-in */}
        {mode === 'login' && (
          <form onSubmit={submit} className="glass grad-border rounded-3xl p-5 shadow-lift">
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
              {busy ? (needTotp ? 'Verifying…' : 'Opening…') : needTotp ? 'Verify' : 'Open Uchiyomi'}
            </button>
            {needTotp && (
              <button type="button" onClick={() => { setNeedTotp(false); setErrMsg(''); setCode(''); }} className="mt-3 w-full text-center text-xs text-fog-500 hover:text-fog-300">‹ Back</button>
            )}
            {sso.enabled && !needTotp && (
              <>
                <div className="my-4 flex items-center gap-3">
                  <span className="h-px flex-1 bg-ink-700" />
                  <span className="text-[11px] uppercase tracking-wider text-fog-600">or</span>
                  <span className="h-px flex-1 bg-ink-700" />
                </div>
                <a href="/auth/oidc/start" className="block w-full rounded-xl border border-ink-700 bg-ink-850/60 py-2.5 text-center text-sm text-fog-100 transition hover:border-accent hover:text-white">
                  Continue with {sso.name}
                </a>
              </>
            )}
          </form>
        )}

        <p className="mt-6 text-center text-xs text-fog-500">{mode === 'setup' ? 'First-run setup' : 'Private library · single sign-in'}</p>
      </motion.div>
    </div>
  );
}
