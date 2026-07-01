'use client';
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { ART } from '@/lib/art';
import { Mark, Wordmark } from './Brand';

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
  const err = !!errMsg;

  // First-run detection: if the server has no users yet, show a create-admin form instead of login.
  useEffect(() => {
    (async () => {
      try {
        const s = await api<{ needsSetup: boolean }>('/api/setup/status');
        setMode(s.needsSetup ? 'setup' : 'login');
      } catch {
        setMode('login');
      }
    })();
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
      {/* cinematic key-art backdrop */}
      <div className="absolute inset-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <motion.img
          src={ART.login}
          alt=""
          initial={{ scale: 1.12, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 1.6, ease: [0.22, 1, 0.36, 1] }}
          className="h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/72 to-ink-950/35" />
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
            <label className={labelCls}>Admin username</label>
            <input
              type="text" autoCapitalize="none" autoCorrect="off" autoFocus
              value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin"
              className={`mb-4 ${inputCls}`}
            />
            <label className={labelCls}>Password</label>
            <input
              type="password"
              value={pw} onChange={(e) => setPw(e.target.value)} placeholder="At least 8 characters"
              className={`mb-4 ${inputCls}`}
            />
            <label className={labelCls}>Confirm password</label>
            <input
              type="password"
              value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••"
              className={inputCls}
            />
            {errMsg && <p className="mt-2 text-sm text-red-400">{errMsg}</p>}
            <button type="submit" disabled={busy} className="btn-accent mt-4 w-full disabled:opacity-50">
              {busy ? 'Creating…' : 'Create admin & open Koryomi'}
            </button>
            <p className="mt-3 text-center text-xs text-fog-500">This first account becomes the server admin.</p>
          </form>
        )}

        {/* Normal sign-in */}
        {mode === 'login' && (
          <form onSubmit={submit} className="glass grad-border rounded-3xl p-5 shadow-lift">
            {!needTotp ? (
              <>
                <label className={labelCls}>Username</label>
                <input
                  type="text" autoCapitalize="none" autoCorrect="off" autoFocus
                  value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin"
                  className={`mb-4 ${inputCls}`}
                />
                <label className={labelCls}>Passcode</label>
                <input
                  type="password" inputMode="text"
                  value={pw} onChange={(e) => setPw(e.target.value)} placeholder="••••••••"
                  className={inputCls}
                />
              </>
            ) : (
              <>
                <label className={labelCls}>Authentication code</label>
                <input
                  type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus
                  value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456"
                  className={`text-center text-2xl tracking-[0.3em] ${inputCls}`}
                />
                <p className="mt-2 text-xs text-fog-500">Enter the 6-digit code from your authenticator app, or a recovery code.</p>
              </>
            )}
            {errMsg && <p className="mt-2 text-sm text-red-400">{errMsg}</p>}
            <button type="submit" disabled={busy || (needTotp ? !code.trim() : !pw)} className="btn-accent mt-4 w-full disabled:opacity-50">
              {busy ? (needTotp ? 'Verifying…' : 'Opening…') : needTotp ? 'Verify' : 'Open Koryomi'}
            </button>
            {needTotp && (
              <button type="button" onClick={() => { setNeedTotp(false); setErrMsg(''); setCode(''); }} className="mt-3 w-full text-center text-xs text-fog-500 hover:text-fog-300">‹ Back</button>
            )}
          </form>
        )}

        <p className="mt-6 text-center text-xs text-fog-500">{mode === 'setup' ? 'First-run setup' : 'Private library · single sign-in'}</p>
      </motion.div>
    </div>
  );
}
