/** Read-only metadata refresh for an image's chapter, used only after a person asks to retry. */
export type ReaderImageRetry = (bookId: string) => Promise<void>;

/** A versioned server image may be stale after another device edited/refetched the archive. */
export function versionedImageBook(src: string): string | null {
  if (/^(?:blob|data):/i.test(src)) return null;
  try {
    const url = new URL(src, 'http://reader.invalid');
    const match = /^\/img\/books\/([^/]+)\/page\/\d+$/.exec(url.pathname);
    return match && url.searchParams.has('cv') ? decodeURIComponent(match[1]) : null;
  } catch { return null; }
}

/**
 * Refresh first, then keep the normal image retry. A failed metadata request must leave a retry available;
 * offline blobs and unversioned images never need a server round trip.
 */
export async function retryReaderImage(src: string, refresh: ReaderImageRetry | undefined, retry: () => void): Promise<void> {
  const bookId = versionedImageBook(src);
  if (bookId && refresh) {
    try { await refresh(bookId); } catch { /* the ordinary retry remains useful during a transient outage */ }
  }
  retry();
}
