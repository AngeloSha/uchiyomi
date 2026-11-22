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
// Deliberate means every reason but `missing` (Verify; the sweep fetches it back) and `rescan_missing` (Rescan found
// somebody's own file absent).  Provenance, rather than its current root, is the authority: a deliberate operation
// can leave a tombstone after the folder moves, and that must not silently change what the row means.
import { q, one } from './db';

/** Re-read per request and never cached, like every other switch here; off on an unreadable row. */
export async function deletedAsGhostsOn(): Promise<boolean> {
  const row = await one<{ on: boolean }>('SELECT deleted_as_ghosts AS on FROM server_settings WHERE id = 1').catch(() => null);
  return row?.on === true;
}

/**
 * The deleted chapters a block takes off the chapter lists (#396): a tombstone of one chapter whose listed number
 * is `blocked`, i.e. only blocked groups released it (lib/seriesListing.ts reapplyBlocklist keeps the status current).
 * A group blocked is a group the reader does not want to see, and a ghost of its chapter is already left out
 * (listingFor, komgaGhosts NOT_COVERED); its deleted chapter must go with it, on every list that shows tombstones --
 * the series page (listingFor's `blockedDeletedBookIds`) and the Komga chapter list Mihon reads (routes/komgaCompat.ts).
 *
 * ⚠️ DISPLAY ONLY, like the switch above: the row, its read progress and its anti-redownload hold stay, so unblocking
 * the group shows it again at once. A range file and a number the listing does not have stay visible rather than
 * guessed at. The number is override-aware, as every listing join is.
 * Reintroduce the Komga gap by listing tombstones unfiltered: "a deleted chapter only a blocked group released leaves
 * the Komga list too" in blockedGroups.int.test.ts finds it on Mihon.
 */
export async function blockedDeletedBookIds(seriesId: string): Promise<string[]> {
  const rows = await q<{ id: string }>(
    `SELECT b.id FROM lib_books b LEFT JOIN book_overrides ov ON ov.book_id = b.id
       JOIN series_listing l ON l.series_id = b.series_id AND l.number = COALESCE(ov.number, b.number)
      WHERE b.series_id = $1 AND b.pruned_at IS NOT NULL AND b.number_end IS NULL AND l.status = 'blocked'`,
    [seriesId],
  );
  return rows.map((r) => r.id);
}

/** Was this book's file deleted on purpose (see above)? False for a chapter that has its file. */
export function deliberatelyDeleted(b: { pruned?: boolean; prunedReason?: string | null; owned?: boolean }): boolean {
  if (!b.pruned) return false;
  return b.prunedReason !== 'missing' && b.prunedReason !== 'rescan_missing';
}
