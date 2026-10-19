// The Profile or Admin console on screen (components/ConsoleLayout.tsx, v0.88.0), for the links that go to one of its
// pages or rows: the search palette's picks, a summary row's link to another page, the quick settings' Profile settings.
// The console opens those in place -- the page, the More options or editor that holds the row, the row brought into view
// and flashed -- instead of a navigation that would leave the row unfound (it reads `?section=` once, on arrival).
// Here rather than in the layout, so components/settings.tsx can ask without importing the layout that imports it.

interface OnScreen {
  /** The console's path, with its trailing slash. */
  path: string;
  /** Whether `href` names one of its pages or rows. */
  know: (href: URL) => boolean;
  go: (href: URL) => void;
}

let onScreen: OnScreen | null = null;

/** The layout says it is on screen, and when it is not any more (`null`). */
export function setConsoleOnScreen(c: OnScreen | null): void { onScreen = c; }

const slashed = (p: string): string => (p.endsWith('/') ? p : `${p}/`);

/** Whether the console on screen opens `href` itself: its path, and a page or a row it has. */
export function consoleKnows(href: string): boolean {
  if (!onScreen || typeof window === 'undefined') return false;
  const u = new URL(href, window.location.href);
  return slashed(u.pathname) === onScreen.path && onScreen.know(u);
}

/** Open `href` in the console on screen when it is one of its pages or rows. False: go there some other way. */
export function openInConsole(href: string): boolean {
  if (!onScreen || !consoleKnows(href)) return false;
  onScreen.go(new URL(href, window.location.href));
  return true;
}
