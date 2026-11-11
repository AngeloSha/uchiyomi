/** The iOS shell owns its local UI cache. Ordinary browsers keep their service worker. */
export interface NativeHost {
  platform: 'ios';
  protocolVersion: 2;
  serverOrigin: string;
  ready?: () => void;
  appActions?: { version: 1; request: (action: NativeAppAction | 'controls-ready' | 'controls-unavailable') => void };
}

export type NativeAppAction = 'servers' | 'reload';

/** Optional controls: an older protocol-2 wrapper keeps working without showing unusable buttons. */
export function hasNativeAppActions(): boolean {
  const controls = nativeHost()?.appActions;
  return controls?.version === 1 && typeof controls.request === 'function';
}

export function requestNativeAppAction(action: NativeAppAction): boolean {
  if ((action !== 'servers' && action !== 'reload') || !hasNativeAppActions()) return false;
  try { nativeHost()!.appActions!.request(action); return true; }
  catch { return false; }
}

/** Acknowledges this frontend's Profile/login controls; older saved UIs retain native fallback access. */
export function acknowledgeNativeAppControls(available = true): boolean {
  if (!hasNativeAppActions()) return false;
  try { nativeHost()!.appActions!.request(available ? 'controls-ready' : 'controls-unavailable'); return true; }
  catch { return false; }
}

export function nativeHost(): NativeHost | null {
  if (typeof window === 'undefined') return null;
  const host = (window as unknown as { uchiyomiNative?: NativeHost }).uchiyomiNative;
  // Protocol 2 requires the v0.107 account fence and private-response contract. Older shells/UI
  // must not silently become the fallback for a server whose content can now be private.
  return host?.platform === 'ios' && host.protocolVersion === 2 ? host : null;
}

export function usesNativeCache(): boolean {
  return nativeHost() !== null;
}

/** Copy/share links must leave the phone with the public server origin. */
export function publicServerURL(href: string, base: string): string {
  const url = new URL(href, base);
  const host = nativeHost();
  if (!host || url.origin !== new URL(base).origin) return url.toString();
  return new URL(url.pathname + url.search + url.hash, host.serverOrigin).toString();
}
