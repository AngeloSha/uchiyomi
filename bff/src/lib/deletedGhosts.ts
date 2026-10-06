// "Show deleted chapters as ghosts": an admin opt-in, off by default (server_settings.deleted_as_ghosts).
//
// A chapter whose file was deleted never leaves the list: its lib_books row stays as a tombstone (pruned_at) so its
// read progress and its place in the series survive, and the series page draws it with a "Deleted from the server"
// chip. With this switch on, a chapter deleted ON PURPOSE is drawn like a chapter this server never fetched instead --
// a ghost row on the series page, with its read tick and Fetch, and "not downloaded" on Mihon (komgaCompat's books
// route) -- so a library that deletes what it has read looks like a library that simply has not got it.
//
// ⚠️ DISPLAY ONLY. The tombstone stays a tombstone everywhere else: the updater keeps treating it as held (it is never
// fetched back by itself, lib/chapterCleanup.ts heldBooks), the counts and the progress endpoints read it as before.
//
// Deliberate means every reason but 'missing' -- Verify chapter files' mark for a file that vanished, which the sweep
// fetches back -- and but a chapter of a library built by hand that Rescan everything found gone (`deleted` and not
// owned: nothing deleted it, the file is simply not there; the web says "File no longer on disk").
import { one } from './db';

/** Re-read per request and never cached, like every other switch here; off on an unreadable row. */
export async function deletedAsGhostsOn(): Promise<boolean> {
  const row = await one<{ on: boolean }>('SELECT deleted_as_ghosts AS on FROM server_settings WHERE id = 1').catch(() => null);
  return row?.on === true;
}

/** Was this book's file deleted on purpose (see above)? False for a chapter that has its file. */
export function deliberatelyDeleted(b: { pruned?: boolean; prunedReason?: string | null; owned?: boolean }): boolean {
  if (!b.pruned) return false;
  if (b.prunedReason === 'missing') return false;
  if (b.prunedReason === 'deleted' && b.owned === false) return false;
  return true;
}
