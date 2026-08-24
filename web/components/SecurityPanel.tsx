'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/components/Toast';
import { ConfirmDialog, msgOf } from '@/components/ConfirmDialog';
import { SettingsCard } from '@/components/SettingsCard';
import { relativeTime } from '@/lib/format';
import { t as tr } from '@/lib/i18n';
import { readShownOnce, writeShownOnce } from '@/lib/shownOnce';

/**
 * Account security, as four cards rather than one column.
 *
 * It used to be a single 868px monolith, which is fine in a 672px ribbon and absurd on a board that answers
 * extra width with more columns. Each card is exported on its own so the page can place it, and the two
 * whose bodies are forms nobody opens twice a year (2FA, tokens) collapse behind the one fact worth
 * checking. `msgOf`, the field style and `relativeTime` are the app's, not this file's: three private copies
 * of the same three helpers is how they drifted apart in the first place.
 */

interface Session { id: string; device_name: string | null; ip: string | null; user_agent: string | null; last_seen: string; created_at: string; current: boolean }

export function PasswordCard({ span = '' }: { span?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');

  const changePw = async () => {
    try {
      await api('/auth/password', { json: { current: cur, next } });
      toast(tr('Password changed. Other devices were signed out.'), 'success');
      setCur(''); setNext('');
      qc.invalidateQueries({ queryKey: ['sessions'] });
    } catch (e: any) { toast(msgOf(e, tr('Could not change password')), 'error'); }
  };

  return (
    <SettingsCard title={tr('Change password')} span={span}>
      <div className="space-y-2">
        <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} placeholder={tr('Current password')} className="field" />
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder={tr('New password (min 8 characters)')} className="field" />
        <button onClick={changePw} disabled={!cur || next.length < 8} className="btn-accent w-full py-2.5 text-sm disabled:opacity-50">{tr('Update password')}</button>
      </div>
    </SettingsCard>
  );
}

export function TotpCard({ span = '' }: { span?: string }) {
  const { user } = useAuth();
  const toast = useToast();
  const [totpOn, setTotpOn] = useState(!!user?.totpEnabled);
  const [setup, setSetup] = useState<{ qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  // Held outside React as well as in it: changing the language remounts this whole subtree, and these codes
  // are shown exactly once. See lib/shownOnce.ts.
  const [recovery, setRecoveryState] = useState<string[] | null>(() => readShownOnce<string[]>('totp.recovery'));
  const setRecovery = (v: string[] | null) => { writeShownOnce('totp.recovery', v); setRecoveryState(v); };
  const [disPw, setDisPw] = useState('');

  const startTotp = async () => { try { setSetup(await api('/auth/totp/setup', { method: 'POST' })); } catch { toast(tr('Could not start setup'), 'error'); } };
  const enableTotp = async () => {
    try {
      const r = await api<{ recoveryCodes: string[] }>('/auth/totp/enable', { json: { code: code.trim() } });
      setRecovery(r.recoveryCodes); setSetup(null); setCode(''); setTotpOn(true);
      toast(tr('Two-factor enabled'), 'success');
    } catch (e: any) { toast(msgOf(e, tr('Incorrect code')), 'error'); }
  };
  const disableTotp = async () => {
    try { await api('/auth/totp/disable', { json: { password: disPw } }); setDisPw(''); setTotpOn(false); setRecovery(null); toast(tr('Two-factor disabled'), 'success'); }
    catch (e: any) { toast(msgOf(e, tr('Wrong password')), 'error'); }
  };

  return (
    <SettingsCard
      title={tr('Two-factor authentication')}
      summary={totpOn ? tr('Your account is protected with an authenticator app.') : tr('Add a second step at login with an authenticator app.')}
      // Recovery codes survive a remount but are shown once: a collapsed card would hide them for good.
      defaultOpen={!!recovery}
      span={span}
    >
      {recovery ? (
        <div>
          <p className="mb-2 text-sm text-fog-300">{tr('Save these recovery codes somewhere safe. Each works once if you lose your authenticator.')}</p>
          <div className="grid grid-cols-2 gap-1.5 rounded-xl bg-ink-900 p-3 font-mono text-xs text-fog-100">{recovery.map((c) => <span key={c}>{c}</span>)}</div>
          <button onClick={() => setRecovery(null)} className="btn-accent mt-3 w-full py-2 text-sm">{tr('Done')}</button>
        </div>
      ) : totpOn ? (
        <div className="space-y-2">
          <input type="password" value={disPw} onChange={(e) => setDisPw(e.target.value)} placeholder={tr('Confirm password to disable')} className="field" />
          <button onClick={disableTotp} disabled={!disPw} className="w-full rounded-xl border border-red-500/40 py-2.5 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-50">{tr('Disable 2FA')}</button>
        </div>
      ) : setup ? (
        <div className="space-y-3">
          <p className="text-sm text-fog-300">{tr('Scan with Google Authenticator, Authy, 1Password, etc.')}</p>
          {setup.qr && /* eslint-disable-next-line @next/next/no-img-element */ <img src={setup.qr} alt={tr('QR code')} className="mx-auto h-44 w-44 rounded-lg bg-white p-1" />}
          <p className="break-all text-center font-mono text-[11px] text-fog-500">{tr('or enter key: {key}', { key: setup.secret })}</p>
          <input type="text" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder={tr('6-digit code')} className="field text-center tracking-[0.3em]" />
          <button onClick={enableTotp} disabled={code.trim().length < 6} className="btn-accent w-full py-2.5 text-sm disabled:opacity-50">{tr('Verify and enable')}</button>
        </div>
      ) : (
        <button onClick={startTotp} className="btn-accent w-full py-2.5 text-sm">{tr('Set up 2FA')}</button>
      )}
    </SettingsCard>
  );
}

export function SessionsCard({ span = '' }: { span?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: () => api<{ content: Session[] }>('/auth/sessions') });

  const revoke = async (id: string) => { await api(`/auth/sessions/${id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['sessions'] }); };
  const logoutAll = async () => { await api('/auth/logout-all', { method: 'POST' }); qc.invalidateQueries({ queryKey: ['sessions'] }); toast(tr('Signed out everywhere else'), 'success'); };

  return (
    <SettingsCard title={tr('Active sessions')} span={span}>
      {(sessions?.content.length || 0) > 1 && (
        <button onClick={logoutAll} className="mb-2 text-xs text-accent hover:underline">{tr('Log out others')}</button>
      )}
      <div className="space-y-2">
        {(sessions?.content || []).map((s) => (
          <div key={s.id} className="flex items-center justify-between rounded-xl border border-ink-700/70 bg-ink-850/50 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm text-fog-100">{s.device_name || tr('Device')}{s.current && <span className="ms-2 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-semibold text-accent">{tr('This device')}</span>}</p>
              <p className="truncate text-xs text-fog-500">{s.ip || tr('unknown ip')} · {tr('active {when}', { when: relativeTime(s.last_seen) })}</p>
            </div>
            {!s.current && <button onClick={() => revoke(s.id)} className="shrink-0 text-xs text-red-300 hover:underline">{tr('Revoke')}</button>}
          </div>
        ))}
        {!sessions?.content.length && <p className="text-xs text-fog-600">{tr('No active sessions.')}</p>}
      </div>
    </SettingsCard>
  );
}

interface ApiToken { id: string; name: string; scopes: string[]; createdAt: string; lastSeen: string | null; expiresAt: string | null; expired: boolean }

/** Long-lived tokens for scripts and integrations. Shown once on creation, revocable at any time. */
export function TokensCard({ span = '' }: { span?: string }) {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [write, setWrite] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [confirmAdmin, setConfirmAdmin] = useState(false);
  // Same as the recovery codes: the server sends this token once and stores only a hash of it.
  const [fresh, setFreshState] = useState<string | null>(() => readShownOnce<string>('apiToken.fresh'));
  const setFresh = (v: string | null) => { writeShownOnce('apiToken.fresh', v); setFreshState(v); };

  const { data } = useQuery({ queryKey: ['api-tokens'], queryFn: () => api<{ content: ApiToken[] }>('/api/tokens') });
  const tokens = data?.content || [];

  const create = async () => {
    const scopes = ['read', ...(write ? ['write'] : []), ...(admin ? ['admin'] : [])];
    try {
      const r = await api<{ token: string }>('/api/tokens', { json: { name: name.trim(), scopes } });
      setFresh(r.token);
      setName(''); setWrite(false); setAdmin(false); setOpen(false);
      qc.invalidateQueries({ queryKey: ['api-tokens'] });
    } catch (e: any) { toast(msgOf(e, tr('Could not create the token')), 'error'); }
  };
  const revoke = async (id: string) => {
    try { await api(`/api/tokens/${id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['api-tokens'] }); toast(tr('Token revoked'), 'success'); }
    catch { toast(tr('Could not revoke'), 'error'); }
  };

  return (
    <SettingsCard
      title={tr('API tokens')}
      summary={tokens.length === 1 ? tr('1 token') : tokens.length ? tr('{n} tokens', { n: tokens.length }) : tr('No tokens yet.')}
      // A token is shown once; if it survived a remount the card must not hide it behind Manage.
      defaultOpen={!!fresh}
      span={span}
    >
      <p className="text-xs text-fog-500">{tr('For scripts and integrations. A normal login expires every 15 minutes; these do not, so treat one like a password.')}</p>
      {!open && <button onClick={() => setOpen(true)} className="mb-3 mt-2 text-xs text-accent hover:underline">{tr('New token')}</button>}

      {fresh && (
        <div className="mb-3 rounded-xl border border-accent/40 bg-accent/10 p-3">
          <p className="text-xs text-fog-100">{tr('Copy this now. It will not be shown again.')}</p>
          <p className="mt-1.5 break-all rounded-lg border border-ink-700 bg-ink-900/60 px-2 py-1.5 font-mono text-xs text-accent">{fresh}</p>
          <button onClick={() => setFresh(null)} className="mt-2 text-xs text-fog-400 hover:underline">{tr('Done')}</button>
        </div>
      )}

      {open && (
        <div className="mb-3 space-y-2 rounded-xl border border-ink-700/70 bg-ink-850/50 p-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('What is it for? e.g. backup script')} className="field" />
          <label className="flex items-center gap-2 text-xs text-fog-300">
            <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} className="accent-accent" />{tr('Allow changes (without this the token can only read)')}</label>
          {user?.role === 'admin' && (
            <label className="flex items-center gap-2 text-xs text-fog-300">
              <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} className="accent-accent" />{tr('Allow server administration')}</label>
          )}
          <div className="flex gap-2 pt-1">
            {/* An admin-scoped token never expires and can do anything its owner can, so it costs one more
                deliberate step. The rest of the form is unchanged. */}
            <button onClick={() => (admin ? setConfirmAdmin(true) : create())} disabled={!name.trim()} className="btn-accent flex-1 py-2 text-sm disabled:opacity-50">{tr('Create')}</button>
            <button onClick={() => { setOpen(false); setName(''); }} className="chip text-xs">{tr('Cancel')}</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {tokens.map((t) => (
          <div key={t.id} className="flex items-center justify-between rounded-xl border border-ink-700/70 bg-ink-850/50 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm text-fog-100">{t.name}
                {t.expired && <span className="ms-2 rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">{tr('Expired')}</span>}
              </p>
              <p className="truncate text-xs text-fog-500">
                {t.scopes.includes('admin') ? tr('admin') : t.scopes.includes('write') ? tr('read + write') : tr('read only')}
                {' · '}{t.lastSeen ? tr('last used {when}', { when: relativeTime(t.lastSeen) }) : tr('never used')}
              </p>
            </div>
            <button onClick={() => revoke(t.id)} className="shrink-0 text-xs text-red-300 hover:underline">{tr('Revoke')}</button>
          </div>
        ))}
        {!tokens.length && !open && <p className="text-xs text-fog-600">{tr('No tokens yet.')}</p>}
      </div>

      {confirmAdmin && (
        <ConfirmDialog
          title={tr('Allow server administration')}
          body={tr('An admin token never expires and can change server settings and other accounts. Treat it like your password.')}
          confirmLabel={tr('Create')}
          confirmText={name.trim()}
          danger
          onConfirm={() => { setConfirmAdmin(false); create(); }}
          onClose={() => setConfirmAdmin(false)}
        />
      )}
    </SettingsCard>
  );
}

/** Kept while `/profile` still renders security as one block; the board places the four cards itself. */
export function SecurityPanel() {
  return (
    <div className="space-y-6">
      <PasswordCard />
      <TotpCard />
      <SessionsCard />
      <TokensCard />
    </div>
  );
}
