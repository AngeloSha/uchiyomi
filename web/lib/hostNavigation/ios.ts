import type { NavigationTransport, WebNavigationMessage } from './controller';

interface IOSNavigationCapability {
  version: 2;
  send: (message: WebNavigationMessage) => void;
  subscribe: (receive: (message: unknown) => void) => () => void;
}

/** Discovery is isolated here. A future Android adapter implements NavigationTransport too. */
export function iosNavigationTransport(scope: unknown, root: HTMLElement | undefined = typeof document === 'undefined' ? undefined : document.documentElement): NavigationTransport | null {
  const marker = (scope as { uchiyomiNative?: { platform?: unknown; protocolVersion?: unknown; navigation?: IOSNavigationCapability } } | null)?.uchiyomiNative;
  const capability = marker?.navigation;
  if (marker?.platform !== 'ios' || marker.protocolVersion !== 2 || capability?.version !== 2 ||
      typeof capability.send !== 'function' || typeof capability.subscribe !== 'function') return null;
  return {
    // Reuse the wrapper's existing live layout hint. Width is not a device/rail detector.
    available: () => root?.getAttribute('data-native-navigation-layout') === 'side',
    observeAvailability: changed => {
      if (!root || typeof MutationObserver === 'undefined') return () => {};
      const observer = new MutationObserver(changed);
      observer.observe(root, { attributes: true, attributeFilter: ['data-native-navigation-layout'] });
      return () => observer.disconnect();
    },
    send: message => capability.send(message), subscribe: receive => capability.subscribe(receive),
  };
}

export function navigationTransport(): NavigationTransport | null {
  return typeof window === 'undefined' ? null : iosNavigationTransport(window);
}
