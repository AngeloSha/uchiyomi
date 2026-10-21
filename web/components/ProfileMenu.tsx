'use client';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { t as tr } from '@/lib/i18n';
import { INCOGNITO_TEXT } from '@/lib/incognito';
import { adultShown, setAdultShown } from '@/lib/adult';
import { isDesktop } from '@/lib/desktop';
import { arrival } from '@/lib/destinations';
import { openInConsole } from '@/lib/consoleOnScreen';
import { useReduceEffects } from '@/lib/useReduceEffects';
import { Avatar } from './Avatar';
import { ProfileSwitcher } from './ProfileSwitcher';
import { useIncognito } from './IncognitoBanner';
import { useLibraries, useAdultShown, useAdultFilterConfigured } from './AdultToggle';
import { Row, SwitchRow } from './settings';
import { Switch } from './Switch';
import { OnBody, Sheet, useRtl } from './ui';

/**
 * The quick settings behind the profile photo: the switches reached for most, each one the SAME state as its row in
 * Profile -> Settings (the same hooks and the same endpoint), so flipping one here moves the other there.
 * Show 18+ is the session's reveal (lib/adult.ts) and, as AdultToggle does, renders nothing for an account
 * with no 18+ library or filter to reveal.
 */
export function QuickSettings({ onClose, onSwitch }: { onClose: () => void; onSwitch?: () => void }) {
  const { user, logout } = useAuth();
  const qc = useQueryClient();
  const incognito = useIncognito();
  const [reduceEffects, saveReduceEffects] = useReduceEffects();
  const { data: libs } = useLibraries();
  const filterConfigured = useAdultFilterConfigured();
  const adultOn = useAdultShown();
  const showAdult = filterConfigured || (libs ?? []).some((l) => l.adult);
  const link = 'rounded-lg px-2 py-1.5 text-sm text-fog-200 hover:bg-ink-800/70 hover:text-fog-50';
  const router = useRouter();
  /**
   * Profile and Profile settings arrive as the search palette's destinations do: opened in place when the profile is on
   * screen (lib/consoleOnScreen.ts), a push from another page (lib/destinations.ts arrival). Still real links, so a middle
   * click or Ctrl+click opens a tab.
   */
  const go = (href: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onClose();
    if (openInConsole(href)) return;
    const how = arrival(href, window.location, () => false);
    if (how === 'push') router.push(href);
    else if (how === 'load') window.location.assign(href);
  };
  return (
    <div>
      <div className="flex items-center gap-3 pb-3">
        <Avatar avatar={user?.avatar} size={44} />
        <p className="min-w-0 flex-1 truncate font-medium text-fog-50">{user?.displayName}</p>
        <a href="/profile/" onClick={go('/profile/')} data-profile-link className={`${link} shrink-0 border border-ink-700`}>{tr('Profile')}</a>
      </div>
      {/* Each switch says Saving…, Saved or why it could not, as its row in Settings does: a refused save is never silent. */}
      <div className="divide-y divide-ink-800/70 border-t border-ink-800/70 [&>*]:py-2.5">
        <SwitchRow label={tr(INCOGNITO_TEXT[0])} on={incognito.on} onChange={incognito.set} />
        {showAdult && (
          <Row label={tr('Show 18+')}>
            <Switch on={adultOn} label={tr('Show 18+')} onChange={() => { setAdultShown(!adultShown()); qc.invalidateQueries(); }} />
          </Row>
        )}
        <SwitchRow label={tr('Reduce effects')} on={reduceEffects} onChange={saveReduceEffects} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-ink-800/70 pt-3">
        <a href="/profile/?tab=general" onClick={go('/profile/?tab=general')} data-profile-settings-link className={link}>{tr('Profile settings')}</a>
        {/* Another profile on this device (components/ProfileSwitcher.tsx), on desktop too: this PC's people take turns. */}
        {onSwitch && <button type="button" onClick={onSwitch} className={link}>{tr('Switch profile')}</button>}
        {/* Not on desktop: the app signs itself back in at once, so "Sign out" there would do nothing visible (as on the profile rail). */}
        {!isDesktop() && <button type="button" onClick={() => { onClose(); void logout(); }} className="rounded-lg px-2 py-1.5 text-sm text-red-300 hover:bg-red-500/10">{tr('Sign out')}</button>}
      </div>
    </div>
  );
}

/** The avatar button and its popover (desktop header). Escape, an outside press and tabbing out close it; Escape gives focus back. */
export function ProfileMenu({ active }: { active: boolean }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  // Outside the popover, which closes on any press outside it -- the switcher's sheet included.
  const [switching, setSwitching] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const rtl = useRtl();
  const id = useId();
  const [pos, setPos] = useState<{ top: number; edge: number }>({ top: 0, edge: 0 });
  const close = useCallback((refocus = true) => { setOpen(false); if (refocus) btn.current?.focus({ preventScroll: true }); }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btn.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 8, edge: rtl ? r.left : window.innerWidth - r.right });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, rtl]);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onDown = (e: PointerEvent) => {
      const el = e.target as Node;
      if (!panel.current?.contains(el) && !btn.current?.contains(el)) close(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown); };
  }, [open, close]);

  return (
    <>
      <button ref={btn} type="button" aria-label={tr('You')} title={user?.displayName} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        className={`shrink-0 grid h-10 w-10 place-items-center rounded-full transition hover:opacity-80 ${active ? 'ring-2 ring-accent ring-offset-2 ring-offset-ink-950' : ''}`}>
        <Avatar avatar={user?.avatar} size={40} />
      </button>
      {open && (
        <OnBody>
          <div id={id} ref={panel} role="dialog" aria-label={tr('Quick settings')} tabIndex={-1}
            onBlur={(e) => { const to = e.relatedTarget as Node | null; if (to && !panel.current?.contains(to) && !btn.current?.contains(to)) close(false); }}
            style={{ top: pos.top, ...(rtl ? { left: pos.edge } : { right: pos.edge }) }}
            className="glass fixed z-50 w-80 max-w-[calc(100vw-1rem)] rounded-2xl border border-ink-700 p-4 shadow-2xl outline-none">
            <div data-lenis-prevent className="max-h-[calc(100vh-6rem)] overflow-y-auto">
              <QuickSettings onClose={() => close(false)} onSwitch={() => { close(false); setSwitching(true); }} />
            </div>
          </div>
        </OnBody>
      )}
      {switching && <ProfileSwitcher onClose={() => setSwitching(false)} />}
    </>
  );
}

/** The phone's version: the same body in a bottom sheet, opened from Home's avatar. */
export function QuickSettingsSheet({ onClose }: { onClose: () => void }) {
  const [switching, setSwitching] = useState(false);
  if (switching) return <ProfileSwitcher onClose={onClose} />;
  return (
    <Sheet title={tr('Quick settings')} onClose={onClose} overBottomNav>
      <div data-lenis-prevent className="min-h-0 overflow-y-auto px-4"><QuickSettings onClose={onClose} onSwitch={() => setSwitching(true)} /></div>
    </Sheet>
  );
}
