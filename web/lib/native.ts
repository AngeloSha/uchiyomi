/** The iOS shell owns its local UI cache. Ordinary browsers keep their service worker. */
export interface NativeHost {
  platform: 'ios';
  protocolVersion: 2;
  serverOrigin: string;
  ready?: () => void;
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
