import type { NavigationTransport, WebNavigationMessage } from './controller';

interface IOSNavigationCapability {
  version: 1;
  send: (message: WebNavigationMessage) => void;
  subscribe: (receive: (message: unknown) => void) => () => void;
}

/** Discovery is isolated here. A future Android adapter implements NavigationTransport too. */
export function iosNavigationTransport(scope: unknown): NavigationTransport | null {
  const marker = (scope as { uchiyomiNative?: { platform?: unknown; protocolVersion?: unknown; navigation?: IOSNavigationCapability } } | null)?.uchiyomiNative;
  const capability = marker?.navigation;
  if (marker?.platform !== 'ios' || marker.protocolVersion !== 2 || capability?.version !== 1 ||
      typeof capability.send !== 'function' || typeof capability.subscribe !== 'function') return null;
  return { send: message => capability.send(message), subscribe: receive => capability.subscribe(receive) };
}

export function navigationTransport(): NavigationTransport | null {
  return typeof window === 'undefined' ? null : iosNavigationTransport(window);
}
