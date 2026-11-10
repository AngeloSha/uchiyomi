'use client';
import { useEffect, useRef } from 'react';
import { getCurrentUser } from '../api';
import { NavigationController } from './controller';
import { navigationTransport } from './ios';
import { actionAllowed, navigationTarget, type NavigationAction, type NavigationPresentation } from './model';
import { setHostNavigationActive, useHostNavigationActive } from './chrome';

/** AppShell owns the router/account state. Transport details never reach components. */
export function useHostNavigation(state: NavigationPresentation, options: {
  account: string | null; path: string; navigate: (href: string) => void; quickSettings: () => void;
}): boolean {
  const active = useHostNavigationActive();
  const controller = useRef<NavigationController | null>(null);
  const current = useRef({ state, options });
  current.current = { state, options };
  useEffect(() => {
    const transport = navigationTransport();
    if (!transport) return;
    const onAction = (action: NavigationAction) => {
      const { options, state } = current.current;
      // The protocol-2 account fence closes synchronously, before React publishes
      // loading/new-account state. Retained native actions cannot cross that gap.
      if (getCurrentUser() !== options.account) throw new Error('Navigation account changed');
      // Rendered permissions can change before the publication effect runs.
      if (!actionAllowed(state, action)) throw new Error('Navigation is no longer available');
      if (action === 'quick-settings') options.quickSettings();
      else {
        const href = navigationTarget(action);
        if (href && options.path.replace(/\/$/, '') !== href.replace(/\/$/, '')) options.navigate(href);
      }
    };
    const next = new NavigationController(transport, crypto.randomUUID(), current.current.state, onAction, setHostNavigationActive);
    controller.current = next;
    next.start();
    return () => { next.dispose(); if (controller.current === next) controller.current = null; };
  }, [options.account]);
  useEffect(() => { controller.current?.update(state); }, [state]);
  return active;
}
