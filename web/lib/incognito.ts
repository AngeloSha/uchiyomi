// Incognito reading (v0.61.0), the web's half. The switch is the account's -- app_settings `incognito`, enforced by the
// server on every progress write and tracker push (bff lib/incognito.ts) -- so this only has to say it and carry it:
// the reader's progress payload and the offline outbox send `incognito: true` with a page read while it was on, so a
// chapter read offline under it and sent after it went off still leaves no trace.
import { keys } from './i18n';

/** Its name and what it does, said alike on Profile → Settings → Reading and in the reader's own sheet. */
export const INCOGNITO_TEXT = keys(
  'Incognito reading',
  'Your place is kept, but what you read stays out of your history, stats and the household’s rails, and nothing is sent to your trackers. For every device on this account.',
);

/** Whether the account's Incognito reading is on, as its settings say. Anything but `true` is off. */
export const incognitoOf = (settings: Record<string, unknown> | null | undefined): boolean => settings?.incognito === true;

/**
 * The switch as the shell last saw it, for code outside React's render: the reader's progress payload reads it at the
 * moment of each write. Kept by useIncognito() (components/IncognitoBanner.tsx), which the app shell calls on every
 * page, the reader's included.
 */
export const incognitoRef = { current: false };
