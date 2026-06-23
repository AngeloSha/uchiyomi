// Stable per-install device id, used for refresh-token + download tracking.
export function deviceId(): string {
  if (typeof window === 'undefined') return 'ssr';
  let id = localStorage.getItem('yomi_device');
  if (!id) {
    id = (crypto.randomUUID?.() || `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    localStorage.setItem('yomi_device', id);
  }
  return id;
}

export function deviceName(): string {
  if (typeof navigator === 'undefined') return 'device';
  const ua = navigator.userAgent;
  if (/iphone/i.test(ua)) return 'iPhone';
  if (/ipad/i.test(ua)) return 'iPad';
  if (/android/i.test(ua)) return 'Android';
  if (/mac/i.test(ua)) return 'Mac';
  if (/windows/i.test(ua)) return 'Windows';
  return 'Browser';
}
