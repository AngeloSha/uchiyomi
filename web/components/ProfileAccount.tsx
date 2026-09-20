'use client';
import { FormEvent, useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { relativeTime } from '@/lib/format';
import { readShownOnce, writeShownOnce } from '@/lib/shownOnce';
import { Avatar } from '@/components/Avatar';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';
import { IcCheck, IcGrid, IcLogOut, IcUser } from '@/components/icons';
import { t as tr } from '@/lib/i18n';
import { SETTINGS_GRID, Section, Row, useAutosave } from '@/components/settings';

/**
 * The profile's Account tab: Signed in as · Two-factor authentication · Active sessions · Sign out.
 *
 * Before v0.39.0 this tab held eight cards, showed the identity three times and hid 2FA behind a collapsed
 * "Manage" chip that looked exactly like the one over API tokens and the one over OPDS. Four sections now,
 * each with one job; the secrets (a password, a 2FA enrolment) keep an explicit button because a secret is
 * the one thing that must not save as you type, and everything else here is an action with a toast.
 */
export function ProfileAccount() {
  return (
    <div className={SETTINGS_GRID}>
      <IdentitySection />
      <TwoFactorSection />
      <SessionsSection />
      <SignOutSection />
    </div>
  );
}

/**
 * `useAutosave` reads the server's sentence out of an ApiError and otherwise says "Could not save"; a bare
 * `401 wrong_password` carries no sentence, so the row would blame the save rather than the password.
 * Re-thrown with the sentence the old toast used, in the shape `msgOf` reads.
 */
function explain(e: unknown, fallback: string): never {
  if (e instanceof ApiError && !msgOf(e, '')) throw new ApiError(e.status, JSON.stringify({ message: fallback }));
  throw e;
}

/* ============================== Signed in as ============================== */

function IdentitySection() {
  const { user, isAdmin } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { status, run } = useAutosave();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const curId = useId();
  const nextId = useId();
  const valid = !!cur && next.length >= 8;

  const changePw = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const ok = await run(async () => {
      try { await api('/auth/password', { json: { current: cur, next } }); }
      catch (err) { explain(err, err instanceof ApiError && err.status === 401 ? tr('Wrong password') : tr('Could not change password')); }
      qc.invalidateQueries({ queryKey: ['sessions'] });
    });
    if (!ok) return;
    setCur(''); setNext('');
    // A toast as well as the tick: signing every other device out is a side effect worth a sentence.
    toast(tr('Password changed. Other devices were signed out.'), 'success');
  };

  return (
    <Section id="signed-in" title={tr('Signed in as')} icon={<IcUser width={18} height={18} />}>
      <div className="flex items-center gap-3 py-3 first:pt-1 last:pb-0">
        <Avatar avatar={user?.avatar} size={44} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fog-50">{user?.displayName}</p>
          {user?.username && <p className="truncate text-xs text-fog-500">@{user.username}</p>}
        </div>
        {isAdmin && (
          <span className="ms-auto shrink-0 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-semibold text-accent">{tr('Admin')}</span>
        )}
      </div>

      {/* The one explicit Save on this tab that is not an action: a password must never save as you type. */}
      <Row stacked label={tr('Change password')} status={status}>
        <form onSubmit={changePw} className="space-y-2">
          <label htmlFor={curId} className="sr-only">{tr('Current password')}</label>
          <input id={curId} type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)}
            placeholder={tr('Current password')} className="field" />
          <label htmlFor={nextId} className="sr-only">{tr('New password (min 8 characters)')}</label>
          <input id={nextId} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)}
            placeholder={tr('New password (min 8 characters)')} className="field" />
          <button type="submit" disabled={!valid || status.kind === 'saving'} className="btn-accent px-4 py-2 text-sm disabled:opacity-50">
            {tr('Update password')}
          </button>
        </form>
      </Row>
    </Section>
  );
}

/* ========================= Two-factor authentication ========================= */

/**
 * The status is a sentence, the action sits in the section header, and every box -- setup, disable,
 * recovery codes -- renders inline under the sentence. ⚠️ Never behind a collapse: the recovery codes are
 * shown exactly once, survive a language-change remount only through `shownOnce`, and a collapsed card
 * would hide them for good.
 *
 * ⚠️ Whether 2FA is on is READ from the auth context, never copied into local state. A copy seeded from
 * `user.totpEnabled` at mount was re-seeded from the stale context on every remount -- Settings and back,
 * a language change -- so after enabling, the section offered "Set up 2FA" again beside the recovery codes
 * it had just shown, and pressing it rotated the live secret. Enable and disable write the truth back with
 * `setTotpEnabled`, and the context (revalidated every 12 minutes) is the one source.
 */
function TwoFactorSection() {
  const { user, setTotpEnabled } = useAuth();
  const toast = useToast();
  const totpOn = !!user?.totpEnabled;
  const [setup, setSetup] = useState<{ qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  // Held outside React as well as in it: changing the language remounts this whole subtree, and these codes
  // are shown exactly once. See lib/shownOnce.ts.
  const [recovery, setRecoveryState] = useState<string[] | null>(() => readShownOnce<string[]>('totp.recovery'));
  const setRecovery = (v: string[] | null) => { writeShownOnce('totp.recovery', v); setRecoveryState(v); };
  const [disabling, setDisabling] = useState(false);
  const [disPw, setDisPw] = useState('');
  const [busy, setBusy] = useState(false);
  const codeId = useId();
  const pwId = useId();
  // The setup form and the disable form are one box to the header button: only one of them is ever
  // rendered, so they share the id it announces.
  const boxId = useId();

  const startTotp = async () => {
    setBusy(true);
    try { setSetup(await api('/auth/totp/setup', { method: 'POST' })); } catch { toast(tr('Could not start setup'), 'error'); }
    setBusy(false);
  };
  const enableTotp = async () => {
    try {
      const r = await api<{ recoveryCodes: string[] }>('/auth/totp/enable', { json: { code: code.trim() } });
      setRecovery(r.recoveryCodes); setSetup(null); setCode(''); setTotpEnabled(true);
      toast(tr('Two-factor enabled'), 'success');
    } catch (e: any) { toast(msgOf(e, tr('Incorrect code')), 'error'); }
  };
  const disableTotp = async () => {
    try {
      await api('/auth/totp/disable', { json: { password: disPw } });
      setDisPw(''); setDisabling(false); setTotpEnabled(false); setRecovery(null);
      toast(tr('Two-factor disabled'), 'success');
    } catch (e: any) { toast(msgOf(e, tr('Wrong password')), 'error'); }
  };
  const cancel = () => { setSetup(null); setCode(''); setDisabling(false); setDisPw(''); };

  // One DOM button in three states, and `aria-expanded` follows the box on all three: a static `false` on
  // Set up / Disable that vanished once pressed meant a screen reader heard "collapsed" and never "expanded".
  const open = !!setup || disabling;
  const action = open ? (
    <button type="button" onClick={cancel} aria-expanded={open} aria-controls={boxId} className="chip text-xs">{tr('Cancel')}</button>
  ) : totpOn ? (
    <button type="button" onClick={() => setDisabling(true)} aria-expanded={open} aria-controls={boxId}
      className="chip text-xs hover:border-rose-500/50 hover:text-rose-400">{tr('Disable 2FA')}</button>
  ) : (
    <button type="button" onClick={startTotp} disabled={busy} aria-expanded={open} aria-controls={boxId} className="chip text-xs disabled:opacity-50">
      {tr('Set up 2FA')}
    </button>
  );

  return (
    <Section id="two-factor" title={tr('Two-factor authentication')} icon={<IcCheck width={18} height={18} />} action={action}>
      <Row label={totpOn ? tr('Your account is protected with an authenticator app.') : tr('Add a second step at login with an authenticator app.')} />

      {recovery && (
        <div className="py-3 last:pb-0">
          <p className="mb-2 max-w-prose text-sm text-fog-300">{tr('Save these recovery codes somewhere safe. Each works once if you lose your authenticator.')}</p>
          <div className="grid grid-cols-2 gap-1.5 rounded-xl bg-ink-900 p-3 font-mono text-xs text-fog-100">{recovery.map((c) => <span key={c}>{c}</span>)}</div>
          <button type="button" onClick={() => setRecovery(null)} className="btn-accent mt-3 px-4 py-2 text-sm">{tr('Done')}</button>
        </div>
      )}

      {setup && !totpOn && (
        <form id={boxId} onSubmit={(e) => { e.preventDefault(); if (code.trim().length >= 6) void enableTotp(); }} className="space-y-3 py-3 last:pb-0">
          <p className="text-sm text-fog-300">{tr('Scan with Google Authenticator, Authy, 1Password, etc.')}</p>
          {setup.qr && /* eslint-disable-next-line @next/next/no-img-element */ <img src={setup.qr} alt={tr('QR code')} className="mx-auto h-44 w-44 rounded-lg bg-white p-1" />}
          <p className="break-all text-center font-mono text-[11px] text-fog-500">{tr('or enter key: {key}', { key: setup.secret })}</p>
          <label htmlFor={codeId} className="sr-only">{tr('6-digit code')}</label>
          <input id={codeId} type="text" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)}
            placeholder={tr('6-digit code')} className="field text-center tracking-[0.3em]" />
          <button type="submit" disabled={code.trim().length < 6} className="btn-accent px-4 py-2 text-sm disabled:opacity-50">{tr('Verify and enable')}</button>
        </form>
      )}

      {disabling && totpOn && (
        <form id={boxId} onSubmit={(e) => { e.preventDefault(); if (disPw) void disableTotp(); }} className="space-y-2 py-3 last:pb-0">
          <label htmlFor={pwId} className="sr-only">{tr('Confirm password to disable')}</label>
          <input id={pwId} type="password" autoComplete="current-password" value={disPw} onChange={(e) => setDisPw(e.target.value)}
            placeholder={tr('Confirm password to disable')} className="field" />
          <button type="submit" disabled={!disPw}
            className="rounded-full border border-red-500/40 px-4 py-2 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-50">{tr('Disable 2FA')}</button>
        </form>
      )}
    </Section>
  );
}

/* ============================== Active sessions ============================== */

interface Session { id: string; device_name: string | null; ip: string | null; user_agent: string | null; last_seen: string; created_at: string; current: boolean }

function SessionsSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: sessions, isPending } = useQuery({ queryKey: ['sessions'], queryFn: () => api<{ content: Session[] }>('/auth/sessions') });
  const rows = sessions?.content ?? [];

  const revoke = async (id: string) => {
    try { await api(`/auth/sessions/${id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['sessions'] }); }
    catch (e: any) { toast(msgOf(e, tr('Could not change that')), 'error'); }
  };
  const logoutAll = async () => {
    try { await api('/auth/logout-all', { method: 'POST' }); qc.invalidateQueries({ queryKey: ['sessions'] }); toast(tr('Signed out everywhere else'), 'success'); }
    catch (e: any) { toast(msgOf(e, tr('Could not change that')), 'error'); }
  };

  return (
    <Section id="sessions" title={tr('Active sessions')} icon={<IcGrid width={18} height={18} />}
      action={rows.length > 1 ? <button type="button" onClick={logoutAll} className="chip text-xs">{tr('Log out others')}</button> : undefined}>
      {rows.map((s) => (
        <Row key={s.id}
          label={<>
            {s.device_name || tr('Device')}
            {s.current && <span className="ms-2 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-semibold text-accent">{tr('This device')}</span>}
          </>}
          help={`${s.ip || tr('unknown ip')} · ${tr('active {when}', { when: relativeTime(s.last_seen) })}`}>
          {!s.current && (
            <button type="button" onClick={() => revoke(s.id)} className="chip text-xs hover:border-rose-500/50 hover:text-rose-400">{tr('Revoke')}</button>
          )}
        </Row>
      ))}
      {!isPending && !rows.length && <p className="py-3 text-xs text-fog-600">{tr('No active sessions.')}</p>}
    </Section>
  );
}

/* ================================= Sign out ================================= */

/**
 * ⚠️ A `<button>` whose text matches /sign out/i: the e2e signs out through the UI, because it is the app's
 * own `logout()` that clears the saved identity, and that is the half being tested.
 */
function SignOutSection() {
  const { logout } = useAuth();
  return (
    <Section id="sign-out" title={tr('Sign out')} icon={<IcLogOut width={18} height={18} />}>
      <Row label={tr('Sign out of this device')} help={tr('Other devices stay signed in.')}>
        <button type="button" onClick={logout} className="rounded-full border border-red-500/40 px-4 py-1.5 text-sm text-red-300 hover:bg-red-500/10">
          {tr('Sign out')}
        </button>
      </Row>
    </Section>
  );
}
