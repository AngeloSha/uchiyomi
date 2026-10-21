'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth, type Avatar as AvatarShape } from '@/lib/auth';
import { t as tr } from '@/lib/i18n';
import { Avatar } from './Avatar';
import { Sheet } from './ui';

interface Switchable { id: string; displayName: string; avatar: AvatarShape }

/**
 * Switch this device to another profile: the profiles that open at home this account
 * manages (lib/auth.tsx switchProfile, bff POST /auth/switch) and the accounts this device remembers (resumeProfile,
 * POST /auth/resume), each a tap away, and a sign-in as anyone else -- which puts this account aside when the device
 * remembers it, and signs it out otherwise. From outside the home network the server lists no profile without a
 * password and says why, and so it is said here.
 */
export function ProfileSwitcher({ onClose }: { onClose: () => void }) {
  const { user, switchProfile, resumeProfile, leave, backToOwner, desktop } = useAuth();
  const router = useRouter();
  const { data } = useQuery({
    queryKey: ['switchable-profiles'],
    queryFn: () => api<{ zone: 'local' | 'remote'; content: Switchable[] }>('/auth/profiles'),
  });
  const { data: ring } = useQuery({ queryKey: ['device-ring'], queryFn: () => api<{ content: Switchable[] }>('/auth/ring') });
  const managed = data?.content ?? [];
  // Remembered here, other than whoever is signed in and the profiles already listed above.
  const remembered = (ring?.content ?? []).filter((p) => p.id !== user?.id && !managed.some((m) => m.id === p.id));
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const to = async (id: string, how: 'switch' | 'resume') => {
    if (busy) return;
    setBusy(id);
    setErr('');
    const r = how === 'switch' ? await switchProfile(id) : await resumeProfile(id);
    setBusy(null);
    if (!r.ok) { setErr(r.error ?? ''); return; }
    onClose();
    router.push('/');
  };

  return (
    <Sheet title={tr('Switch profile')} onClose={onClose} overBottomNav>
      <div data-lenis-prevent className="min-h-0 space-y-2 overflow-y-auto px-4 pb-4">
        {[...managed.map((p) => ({ p, how: 'switch' as const })), ...remembered.map((p) => ({ p, how: 'resume' as const }))].map(({ p, how }) => (
          <button key={p.id} type="button" onClick={() => to(p.id, how)} disabled={!!busy} data-switch-profile={how}
            className="flex w-full items-center gap-3 rounded-xl border border-ink-700 px-3 py-2.5 text-start transition hover:border-accent disabled:opacity-60">
            <Avatar avatar={p.avatar} size={36} />
            <span className="min-w-0 flex-1 truncate text-sm text-fog-100">{p.displayName}</span>
          </button>
        ))}
        {data?.zone === 'remote' && <p className="text-xs leading-relaxed text-fog-500">{tr('Profiles without a password open from home only.')}</p>}
        {err && <p role="alert" className="text-xs text-red-300">{err}</p>}
        {/* Uchiyomi Desktop has no sign-in screen: from a profile, back to the PC's owner instead. */}
        {desktop ? (
          user?.kind !== 'desktop-owner' && (
            <button type="button" onClick={async () => { if (!(await backToOwner())) setErr(tr('Could not switch profile')); }} className="btn-key w-full">{tr('Back to my account')}</button>
          )
        ) : (
          <button type="button" onClick={() => { onClose(); void leave(); }} className="btn-key w-full">{tr('Sign in with another account')}</button>
        )}
      </div>
    </Sheet>
  );
}
