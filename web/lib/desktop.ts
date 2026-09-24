/**
 * Uchiyomi Desktop: the ONE place the web app asks whether it is running inside the desktop app.
 *
 * One web bundle serves both builds, so the answer is decided at run time from two signals:
 *
 *   * the preload marker `window.uchiyomiDesktop`, which only the desktop shell's own window carries
 *     (`desktopShell()`) -- page JavaScript cannot fake it for another window, and a browser tab pointed at
 *     the same port never has it;
 *   * `desktop: true` in an auth answer (`/auth/refresh`, `/auth/desktop`, `/auth/config`), which the server
 *     sends only when its own desktop switch is on (`noteServerDesktop`).
 *
 * `isDesktop()` is either. With both absent -- every Docker install -- each function here answers exactly
 * what the code it replaced answered, so the server build behaves and looks the same byte for byte.
 *
 * ⚠️ Dependency-free on purpose: `lib/api.ts` imports this, and this must never import `api` back.
 */

/** What the shell's engine download reports (contract 3). `progress` is 0..1. */
export interface EngineStatus {
  state: 'absent' | 'downloading' | 'installing' | 'starting' | 'running' | 'failed';
  progress?: number;
  bytes?: number;
  total?: number;
  error?: string;
}

/** A newer release, as the shell sees it: Windows downloads it itself (`ready`), macOS can only link to it. */
export interface UpdateStatus { available: boolean; version?: string; url?: string; ready?: boolean }

/**
 * The preload bridge (contract 3). Every member is treated as possibly missing: the web must keep working
 * in a browser, and in a shell a release older or newer than this bundle.
 */
export interface DesktopBridge {
  version: string;
  platform: 'win32' | 'darwin';
  engine: {
    status(): Promise<EngineStatus>;
    install(): Promise<void>;
    onStatus(cb: (s: EngineStatus) => void): () => void;
  };
  revealLibrary(): void;
  revealBackups(): void;
  restoreBackup(): Promise<void>;
  update: { status(): Promise<UpdateStatus>; installNow(): void };
}

/** The bridge, or null anywhere but the desktop app's own window (a browser, the static prerender, a test). */
export function bridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const b = (window as unknown as { uchiyomiDesktop?: DesktopBridge }).uchiyomiDesktop;
  return b && typeof b === 'object' ? b : null;
}

/** Is this page inside the desktop app's window? Only this one may trigger the silent sign-in. */
export function desktopShell(): boolean {
  return bridge() !== null;
}

let serverSaid = false;

/**
 * Record what an auth answer said. Sticky: a server that has once said it is the desktop app is that for
 * the life of the page -- it cannot become a Docker server without a new process on a new origin.
 */
export function noteServerDesktop(v: unknown): void {
  if (v === true) serverSaid = true;
}

/** The desktop app, by either signal. Gates every surface that is hidden there (see DESKTOP_HIDDEN). */
export function isDesktop(): boolean {
  return desktopShell() || serverSaid;
}

/**
 * May the app assume its server can be reached? The only home of `navigator.onLine` in the web app.
 *
 * ⚠️ On a phone, `navigator.onLine === false` is a definitive "no server", and five places short-circuit on
 * it rather than wait most of a minute for fetch to give up. On desktop the server is THIS computer: no
 * Wi-Fi is not no library, and reading the flag there would send someone with a full local library to an
 * offline screen. Server build: exactly `navigator.onLine !== false`, as each call site read it.
 * Reintroduce by dropping `isDesktop() ||`: desktopSession.test.ts "no Wi-Fi is not no server" fails.
 */
export function serverReachableHint(): boolean {
  return isDesktop() || typeof navigator === 'undefined' || navigator.onLine !== false;
}

/** 1, 2, 4, 8, 16, then every 30 seconds: how long the desktop splash waits between tries. */
export function desktopRetryDelay(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Ask until there is an answer, on desktop only.
 *
 * ⚠️ On a phone, "unreachable" means offline and the app opens the downloads (`adoptOffline`). On desktop
 * the server is a process on this computer that is starting, or restarting after the extension engine
 * installed: the answer is "not yet", never "offline", so the splash stays up and asks again. Returns the
 * first answer anywhere else -- the server build takes the loop zero times. Stops when `alive()` turns false
 * (the provider unmounted) and returns what it last had.
 */
export async function untilReachable<R extends { kind: string }>(
  ask: () => Promise<R>,
  alive: () => boolean,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<R> {
  let r = await ask();
  for (let n = 0; r.kind === 'unreachable' && isDesktop() && alive(); n++) {
    await wait(desktopRetryDelay(n));
    if (!alive()) break;
    r = await ask();
  }
  return r;
}

/**
 * What the desktop app hides, and why each is gone rather than broken.
 *
 * One person on one computer, signed in by the app itself: nothing that exists for other people, other
 * devices, or signing in. The server answers 404 for the matching routes (bff/src/lib/desktop.ts), so a
 * surface left showing here would be a button that fails. Everything else is the same app.
 */
export const DESKTOP_HIDDEN = {
  /** Other people (Members: accounts, roles, age caps) and everyone's sessions. */
  adminTabs: ['Members', 'Sessions'],
  /** Password, 2FA, sessions, sign out: the app signs itself in. */
  profileTabs: ['Account'],
  /** "Save offline" copies files that are already on this disk into the window's storage. */
  navHrefs: ['/downloads'],
  paletteKeys: ['downloads'],
} as const;

/** Is `item` in one of the lists above, on desktop? Always false on the server build. */
export function hiddenOnDesktop(list: readonly string[], item: string): boolean {
  return isDesktop() && list.includes(item);
}

/**
 * The console groups with the hidden tabs taken out, and a group left empty dropped. The caller keeps its
 * own constant untouched (the tab lists are pinned and read by `useTabParam`); only what the rail gets is
 * filtered.
 */
export function visibleGroups<T extends string>(
  groups: ReadonlyArray<{ id: string; label: string; tabs: readonly T[] }>,
  hidden: readonly string[],
): { id: string; label: string; tabs: T[] }[] {
  return groups
    .map((g) => ({ id: g.id, label: g.label, tabs: g.tabs.filter((t) => !hidden.includes(t)) }))
    .filter((g) => g.tabs.length > 0);
}
