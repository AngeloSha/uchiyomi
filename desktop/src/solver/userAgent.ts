// The solver's one process-wide User-Agent (design-shell.md §3.4).
//
// Mode A ("native") is Electron's own UA, untouched:
//   Mozilla/5.0 (…) AppleWebKit/537.36 (KHTML, like Gecko) Uchiyomi/0.43.0 Chrome/152.0.7977.75 Electron/44.4.5 Safari/537.36
// Mode B ("chrome") drops the app token and the Electron token and keeps the rest:
//   Mozilla/5.0 (…) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.75 Safari/537.36
//
// Set ONCE through app.userAgentFallback before any session exists: a per-session UA leaked the native one on
// the challenge frame's own requests (sim#8192), and Cloudflare ties cf_clearance to the UA it saw. Client
// hints (Sec-CH-UA, navigator.userAgentData) are left alone in both modes.
export type UaMode = 'native' | 'chrome';

export function parseUaMode(v: string | undefined, fallback: UaMode = 'chrome'): UaMode {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'a' || s === 'native') return 'native';
  if (s === 'b' || s === 'chrome') return 'chrome';
  return fallback;
}

/**
 * Chrome-shaped: after "(KHTML, like Gecko)" keep only the tokens a Chrome UA has (Chrome/…, Mobile/…,
 * Safari/…). Everything else there -- `Electron/x`, the app's `Name/version` -- is dropped. The platform
 * block in parentheses is kept exactly, so it still agrees with the client hints the browser sends.
 */
export function chromeShaped(native: string): string {
  const m = native.match(/^(.*\(KHTML, like Gecko\))\s+(.*)$/);
  if (!m) return native;
  const kept = m[2].split(/\s+/).filter((t) => /^(Chrome|Mobile|Safari)\//.test(t));
  return kept.length ? `${m[1]} ${kept.join(' ')}` : native;
}

export function userAgentFor(mode: UaMode, native: string): string {
  return mode === 'chrome' ? chromeShaped(native) : native;
}

// ---- Client hints ---------------------------------------------------------------------------------------
//
// Measured in the spike (httpbin.org/headers through the solver, Electron 44.4.5): Electron sends NO
// Sec-CH-UA / Sec-CH-UA-Mobile / Sec-CH-UA-Platform request headers, although navigator.userAgentData in the
// same page reports brands. Chrome 152 sends all three on every HTTPS request. A UA that says Chrome with no
// client hints behind it is exactly the inconsistency bot checks look for, so the solver adds them, built
// from the same brand list the page's JavaScript sees.
export interface Brand { brand: string; version: string }

/** Chromium's GREASE brand for a major version (components/embedder_support/user_agent_utils.cc). */
export function greaseBrands(major: number): Brand[] {
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const versions = ['8', '99', '24'];
  const grease = { brand: `Not${chars[major % chars.length]}A${chars[(major + 1) % chars.length]}Brand`, version: versions[major % versions.length] };
  const chromium = { brand: 'Chromium', version: String(major) };
  return major % 2 === 0 ? [grease, chromium] : [chromium, grease];
}

/** `"Not?A_Brand";v="24", "Chromium";v="152"` */
export function secChUa(brands: Brand[]): string {
  return brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
}

/** navigator.userAgentData.platform's value for this OS, which Sec-CH-UA-Platform must repeat. */
export function chPlatform(platform: string = process.platform): string {
  return platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : 'Unknown';
}
