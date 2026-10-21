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
 * manages, each a tap away (lib/auth.tsx switchProfile, bff POST /auth/switch), and a sign-in as anyone else, which is
 * a sign-out first. From outside the home network the server lists none and says why, and so it is said here.
 */
export function ProfileSwitcher({ onClose }: { onClose: () => void }) {
  const { switchProfile, logout } = useAuth();
  const router = useRouter();
  const { data } = useQuery({
    queryKey: ['switchable-profiles'],
    queryFn: () => api<{ zone: 'local' | 'remote'; content: Switchable[] }>('/auth/profiles'),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const to = async (id: string) => {
    if (busy) return;
    setBusy(id);
    setErr('');
    const r = await switchProfile(id);
    setBusy(null);
    if (!r.ok) { setErr(r.error ?? ''); return; }
    onClose();
    router.push('/');
  };

  return (
    <Sheet title={tr('Switch profile')} onClose={onClose} overBottomNav>
      <div data-lenis-prevent className="min-h-0 space-y-2 overflow-y-auto px-4 pb-4">
        {(data?.content ?? []).map((p) => (
          <button key={p.id} type="button" onClick={() => to(p.id)} disabled={!!busy} data-switch-profile
            className="flex w-full items-center gap-3 rounded-xl border border-ink-700 px-3 py-2.5 text-start transition hover:border-accent disabled:opacity-60">
            <Avatar avatar={p.avatar} size={36} />
            <span className="min-w-0 flex-1 truncate text-sm text-fog-100">{p.displayName}</span>
          </button>
        ))}
        {data?.zone === 'remote' && <p className="text-xs leading-relaxed text-fog-500">{tr('Profiles without a password open from home only.')}</p>}
        {err && <p role="alert" className="text-xs text-red-300">{err}</p>}
        <button type="button" onClick={() => { onClose(); void logout(); }} className="btn-key w-full">{tr('Sign in with another account')}</button>
      </div>
    </Sheet>
  );
}
