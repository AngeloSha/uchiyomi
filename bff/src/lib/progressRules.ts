// Pure reading-progress rules. Kept free of the db/env imports so they can be unit-tested on their own.

/** True when a page ping has reached the end of a book, i.e. it counts as finished even if the client never
 *  sent an explicit completion (fast scrolling blows past the last page). `pagesCount` is 0/unknown for some
 *  books, so only a real count is trusted — otherwise every first page would mark a book read. */
export function reachedEnd(page: number, pagesCount: number): boolean {
  return pagesCount > 1 && page >= pagesCount - 1;
}
