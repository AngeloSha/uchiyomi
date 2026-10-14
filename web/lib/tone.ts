// The page's background tone (Look settings, UI refresh phase 3): OLED black, Graphite or Midnight.
//
// OLED is the app's look and stays the default for everyone: true black, the surfaces app/globals.css's @theme block
// has always defined. The other two are curated, not generated -- a softer charcoal and a deep blue for a reader who
// finds true black harsh on an LCD -- and each is one `html[data-tone]` block in app/globals.css that re-defines the
// --color-ink-* scale. Every `bg-ink-*`, `border-ink-*` and page fade reads those variables, so a tone reaches the
// whole app without a component knowing it exists. OLED has no block and no attribute: its CSS is exactly what it was.
//
// Like Reduce effects (lib/effects.ts), three places hold it, each for a reason:
//  - the ACCOUNT (`tone` in /api/settings), so it follows the reader to another device, like the accent;
//  - `<html data-tone>`, which is what the CSS keys on, and the `theme-color` meta, which colours a phone's browser bar;
//  - a localStorage mirror, read before the first paint (TONE_BOOT, in app/layout.tsx's <head>) so a reload does not
//    flash black before the reader's tone arrives, and for the one start that cannot ask the server: an offline launch.
//
// ⚠️ `page`, `surface` and `line` restate the tone's --color-ink-950, -800 and -600 for what cannot read a variable: the
// theme-color meta and the swatches that show each tone side by side whatever tone is on. test/tokens.test.ts holds them
// to app/globals.css, and checks every tone's text contrast and the order of its surfaces.
import { keys } from './i18n';

const TONE_LABELS = keys('OLED black', 'Graphite', 'Midnight');

export const TONES = [
  { key: 'oled', label: TONE_LABELS[0], page: '#000000', surface: '#111116', line: '#26262f' },
  { key: 'graphite', label: TONE_LABELS[1], page: '#131316', surface: '#232329', line: '#3a3a44' },
  { key: 'midnight', label: TONE_LABELS[2], page: '#090d18', surface: '#161d30', line: '#2a3452' },
] as const;

export type Tone = (typeof TONES)[number]['key'];

export const DEFAULT_TONE: Tone = 'oled';

const KEY = 'uchiyomi.tone';

/** The account's value as a tone: anything this app does not know -- nothing, a typo, a newer app's tone -- is OLED. */
export function toneOf(v: unknown): Tone {
  return TONES.find((t) => t.key === v)?.key ?? DEFAULT_TONE;
}

/** The colour the browser's own bar should take under a tone: the page's. */
export const themeColorOf = (tone: Tone): string => TONES.find((t) => t.key === tone)!.page;

/**
 * Put the device's copy on <html> and make the browser bar's theme-color meta in its colour, before anything paints:
 * inlined into app/layout.tsx's <head>, so it runs while the page is still being parsed. Only a known tone that is not
 * OLED is ever applied (a lookup that is not a string -- `constructor`, a typo -- is none); a broken or unreadable mirror
 * is OLED, and the bar is still made, black.
 *
 * ⚠️ The meta is made HERE, never rendered by React (app/layout.tsx says why), so this is the page's only one.
 */
export const TONE_BOOT =
  `try{var d=document,t=null;try{t=localStorage.getItem(${JSON.stringify(KEY)})}catch(e){}` +
  `var p=${JSON.stringify(Object.fromEntries(TONES.filter((t) => t.key !== DEFAULT_TONE).map((t) => [t.key, t.page])))}[t];` +
  `if(typeof p=='string')d.documentElement.setAttribute('data-tone',t);else p=${JSON.stringify(themeColorOf(DEFAULT_TONE))};` +
  `var m=d.createElement('meta');m.name='theme-color';m.content=p;d.head.appendChild(m)}catch(e){}`;

/** The device's copy. Unreadable storage (a private window, a blocked origin) reads as OLED. */
export function readToneMirror(): Tone {
  try { return toneOf(localStorage.getItem(KEY)); } catch { return DEFAULT_TONE; }
}

/**
 * Use a tone NOW: the attribute, the browser bar's colour and the mirror.
 *
 * Called with the account's value on every sign-in and session refresh, so a device follows the account both ways,
 * and with nothing on sign-out: the sign-in screen belongs to nobody, so it gets the app's own look.
 */
export function applyTone(v: unknown): void {
  const tone = toneOf(v);
  try {
    const el = document.documentElement;
    if (tone === DEFAULT_TONE) el.removeAttribute('data-tone');
    else el.setAttribute('data-tone', tone);
    // The one TONE_BOOT made; made here if that script never ran.
    const metas = document.querySelectorAll('meta[name="theme-color"]');
    if (metas.length) metas.forEach((m) => m.setAttribute('content', themeColorOf(tone)));
    else {
      const m = document.createElement('meta');
      m.setAttribute('name', 'theme-color');
      m.setAttribute('content', themeColorOf(tone));
      document.head.appendChild(m);
    }
  } catch { /* no document: nothing to colour */ }
  try {
    if (tone === DEFAULT_TONE) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, tone);
  } catch { /* storage refused: the account still holds it, only the next cold start shows black first */ }
}

/** Re-apply the device's copy: an offline launch, and the first render before the server has answered. */
export function restoreTone(): void {
  applyTone(readToneMirror());
}
