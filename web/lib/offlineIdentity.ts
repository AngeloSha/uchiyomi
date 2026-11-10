/**
 * Who this device was last signed in as, so the app can open with no network.
 *
 * Launching the installed app in airplane mode used to show the sign-in screen even with chapters sitting
 * in IndexedDB, because two facts were destroyed on every cold boot. The first is in `api.ts`: a 401 and a
 * dead network both came back as `false`, so "the server said no" and "there was no server" were the same
 * answer. The second is this file's reason to exist: `currentUserId` lived only in memory, and
 * `downloads.ts` keys EVERY offline record `${userId}:${bookId}` -- so with nobody signed in, `owner()`
 * returns `'anon'` and every lookup misses. Removing the sign-in screen alone would have produced an empty
 * reader, which is worse than the sign-in screen because it looks like the downloads are gone.
 *
 * ⚠️ THIS RECORD IS NOT A CREDENTIAL, and nothing here should ever make it one. The access token stays in
 * memory (`api.ts`), the refresh token stays in an httpOnly cookie the page cannot read, and every `api()`
 * call still carries the in-memory token or fails. What this grants is exactly one thing: an IndexedDB key
 * prefix -- useful only to somebody who already has that account's blobs on the device, which is to say
 * somebody who already has IndexedDB. It is written only after the SERVER has confirmed who you are, and it
 * is cleared on sign-out and on any rejection.
 *
 * ⚠️ `exp` is advisory. localStorage is editable, so this is not a defence against someone with the device
 * and a debugger; the threat model here is the next person in the household picking the tablet up, and the
 * server remains the enforcement point for everything that touches data. Its job is to stop the grace
 * outliving the session the server would have honoured.
 *
 * WHY localStorage rather than IndexedDB, where the downloads themselves live:
 *   1. It has to be SYNCHRONOUS. `api.ts` explains that `currentUserId` must be answerable without awaiting
 *      anything, because `loadChapter` consults the offline store before any request is in flight. An async
 *      identity leaves a window where `owner()` is `'anon'` -- and an `'anon'` stamp on a queued progress
 *      event is unattributable: `downloads.ts` and `sw.js` retain unknown-owner events without replaying them
 *      and send known-owner events only for that same authenticated account.
 *   2. It has to be synchronously CLEARABLE on sign-out. Deleting from IndexedDB can block indefinitely --
 *      that is the entire subject of `offlineBlocked.test.ts` -- and an identity that might not be
 *      deletable on a shared tablet is the leak this file is supposed to prevent.
 *   3. Separate stores fail separately. If identity lived in `yomi-offline`, a blocked upgrade would take
 *      it down too and show the sign-in screen with the downloads sitting right there, unreachable.
 * `i18n.ts`, `device.ts` and `readerPrefs.ts` already mirror server state here for the same first-paint
 * reason, so this is the established pattern rather than a new one.
 */

const KEY = 'uchiyomi.offlineUser';

export interface OfflineIdentity {
  /** Bumped when the shape changes; an unrecognised version is discarded rather than guessed at. */
  v: 1;
  /** The load-bearing field: this is `owner()` for every IndexedDB key. */
  id: string;
  username: string | null;
  displayName: string;
  /** `role` and `perms` together are what `canDownload()` reads, which decides what the navs show. */
  role: string;
  perms?: Record<string, boolean>;
  avatar?: { emoji?: string; color?: string };
  /**
   * ⚠️ The ONLY field carried over from `settings`, deliberately. `app_settings.data` is free-form JSONB
   * that anything may write to, and this record sits in cleartext on the device -- so it is a whitelist of
   * one, not a copy. `applyAccent` reads `settings.accent` and nothing else.
   */
  accent?: string;
  /** Refresh-token expiry in ms since the epoch, as reported by the server. */
  exp: number;
}

interface UserLike {
  id: string;
  username: string | null;
  displayName: string;
  role: string;
  perms?: Record<string, boolean>;
  avatar?: { emoji?: string; color?: string };
  settings?: Record<string, any>;
}

/** Guarded because this module is imported at load: the static export prerenders in Node, as do the tests. */
const store = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // Safari in private mode throws on access rather than returning null
  }
};

/**
 * The saved identity, or null — and an expired or unreadable one is DELETED on the way past rather than
 * merely reported, so a device that has aged out cannot keep answering with it after a clock change.
 */
export function readOfflineIdentity(): OfflineIdentity | null {
  const ls = store();
  if (!ls) return null;
  let raw: string | null = null;
  try {
    raw = ls.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as OfflineIdentity;
    if (p?.v !== 1 || typeof p.id !== 'string' || !p.id || typeof p.exp !== 'number') {
      clearOfflineIdentity();
      return null;
    }
    if (p.exp <= Date.now()) {
      clearOfflineIdentity();
      return null;
    }
    return p;
  } catch {
    clearOfflineIdentity();
    return null;
  }
}

/**
 * Save who just signed in.
 *
 * ⚠️ With no `exp` this writes NOTHING and clears what was there. The expiry comes from the server, and a
 * client that invented one -- a default of thirty days, say -- would be granting itself an offline grace the
 * server never agreed to. An old server that does not send the field simply gets the old behaviour: online
 * works, and a cold boot with no network asks you to sign in.
 */
export function writeOfflineIdentity(u: UserLike, exp: number | undefined): void {
  const ls = store();
  if (!ls) return;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= Date.now()) {
    clearOfflineIdentity();
    return;
  }
  const rec: OfflineIdentity = {
    v: 1,
    id: u.id,
    username: u.username ?? null,
    displayName: u.displayName,
    role: u.role,
    perms: u.perms,
    avatar: u.avatar,
    accent: typeof u.settings?.accent === 'string' ? u.settings.accent : undefined,
    exp,
  };
  try {
    ls.setItem(KEY, JSON.stringify(rec));
  } catch { /* quota or private mode: the app still works online, it just will not open offline */ }
}

/** Synchronous by contract — see the note above on why sign-out cannot afford to await this. */
export function clearOfflineIdentity(): void {
  const ls = store();
  if (!ls) return;
  try {
    ls.removeItem(KEY);
  } catch { /* nothing to do: if it cannot be removed it could not have been written */ }
}
