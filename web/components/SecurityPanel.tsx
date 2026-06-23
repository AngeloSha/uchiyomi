'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/components/Toast';

interface Session { id: string; device_name: string | null; ip: string | null; user_agent: string | null; last_seen: string; created_at: string; current: boolean }

const msgOf = (e: any, fb: string) => { try { return JSON.parse(e?.body || '{}').message || fb; } catch { return fb; } };
const rel = (d?: string | null) => {
  if (!d) return '';
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export function SecurityPanel() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: () => api<{ content: Session[] }>('/auth/sessions') });

  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [totpOn, setTotpOn] = useState(!!user?.totpEnabled);
  const [setup, setSetup] = useState<{ qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [disPw, setDisPw] = useState('');

  const changePw = async () => {
    try {
      await api('/auth/password', { json: { current: cur, next } });
      toast('Password changed — other devices were signed out', 'success');
      setCur(''); setNext('');
      qc.invalidateQueries({ queryKey: ['sessions'] });
    } catch (e: any) { toast(msgOf(e, 'Could not change password'), 'error'); }
  };
  const startTotp = async () => { try { setSetup(await api('/auth/totp/setup', { method: 'POST' })); } catch { toast('Could not start setup', 'error'); } };
  const enableTotp = async () => {
    try {
      const r = await api<{ recoveryCodes: string[] }>('/auth/totp/enable', { json: { code: code.trim() } });
      setRecovery(r.recoveryCodes); setSetup(null); setCode(''); setTotpOn(true);
      toast('Two-factor enabled', 'success');
    } catch (e: any) { toast(msgOf(e, 'Incorrect code'), 'error'); }
  };
  const disableTotp = async () => {
    try { await api('/auth/totp/disable', { json: { password: disPw } }); setDisPw(''); setTotpOn(false); setRecovery(null); toast('Two-factor disabled', 'success'); }
    catch (e: any) { toast(msgOf(e, 'Wrong password'), 'error'); }
  };
  const revoke = async (id: string) => { await api(`/auth/sessions/${id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['sessions'] }); };
  const logoutAll = async () => { await api('/auth/logout-all', { method: 'POST' }); qc.invalidateQueries({ queryKey: ['sessions'] }); toast('Signed out everywhere else', 'success'); };

  const fld = 'w-full rounded-xl border border-ink-700 bg-ink-850 px-3 py-2.5 text-sm text-fog-100 outline-none focus:border-accent';

  return (
    <div className="space-y-6">
      {/* Change password */}
      <div className="card p-4">
        <h3 className="mb-3 text-sm font-semibold text-fog-100">Change password</h3>
        <div className="space-y-2">
          <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} placeholder="Current password" className={fld} />
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="New password (min 8 characters)" className={fld} />
          <button onClick={changePw} disabled={!cur || next.length < 8} className="btn-accent w-full py-2.5 text-sm disabled:opacity-50">Update password</button>
        </div>
      </div>

      {/* Two-factor */}
      <div className="card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-fog-100">Two-factor authentication</h3>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${totpOn ? 'bg-emerald-600/20 text-emerald-300' : 'bg-ink-700 text-fog-400'}`}>{totpOn ? 'On' : 'Off'}</span>
        </div>
        {recovery ? (
          <div>
            <p className="mb-2 text-sm text-fog-300">Save these recovery codes somewhere safe — each works once if you lose your authenticator:</p>
            <div className="grid grid-cols-2 gap-1.5 rounded-xl bg-ink-900 p-3 font-mono text-xs text-fog-100">{recovery.map((c) => <span key={c}>{c}</span>)}</div>
            <button onClick={() => setRecovery(null)} className="btn-accent mt-3 w-full py-2 text-sm">Done</button>
          </div>
        ) : totpOn ? (
          <div className="space-y-2">
            <p className="text-sm text-fog-400">Your account is protected with an authenticator app.</p>
            <input type="password" value={disPw} onChange={(e) => setDisPw(e.target.value)} placeholder="Confirm password to disable" className={fld} />
            <button onClick={disableTotp} disabled={!disPw} className="w-full rounded-xl border border-red-500/40 py-2.5 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-50">Disable 2FA</button>
          </div>
        ) : setup ? (
          <div className="space-y-3">
            <p className="text-sm text-fog-300">Scan with Google Authenticator, Authy, 1Password, etc.</p>
            {setup.qr && /* eslint-disable-next-line @next/next/no-img-element */ <img src={setup.qr} alt="2FA QR" className="mx-auto h-44 w-44 rounded-lg bg-white p-1" />}
            <p className="break-all text-center font-mono text-[11px] text-fog-500">or enter key: {setup.secret}</p>
            <input type="text" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" className={`${fld} text-center tracking-[0.3em]`} />
            <button onClick={enableTotp} disabled={code.trim().length < 6} className="btn-accent w-full py-2.5 text-sm disabled:opacity-50">Verify &amp; enable</button>
          </div>
        ) : (
          <div>
            <p className="mb-3 text-sm text-fog-400">Add a second step at login with an authenticator app.</p>
            <button onClick={startTotp} className="btn-accent w-full py-2.5 text-sm">Set up 2FA</button>
          </div>
        )}
      </div>

      {/* Sessions */}
      <div className="card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-fog-100">Active sessions</h3>
          {(sessions?.content.length || 0) > 1 && <button onClick={logoutAll} className="text-xs text-accent hover:underline">Log out others</button>}
        </div>
        <div className="space-y-2">
          {(sessions?.content || []).map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded-xl border border-ink-700/70 bg-ink-850/50 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm text-fog-100">{s.device_name || 'Device'}{s.current && <span className="ml-2 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-semibold text-accent">This device</span>}</p>
                <p className="truncate text-xs text-fog-500">{s.ip || 'unknown ip'} · active {rel(s.last_seen)}</p>
              </div>
              {!s.current && <button onClick={() => revoke(s.id)} className="shrink-0 text-xs text-red-300 hover:underline">Revoke</button>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
