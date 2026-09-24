// Every chapter of a series, however many there are. The books route pages, and the series page and the
// reader used to ask for one page of 1000 -- so One Piece stopped at chapter 1000 in the list, and the
// reader's prev/next/jump list ended there too, although chapters 1001+ were on disk.
// Reintroduce by going back to one `?size=1000` request: "walks past the first 1000" in seriesBooks.test.ts
// gets 1000 chapters of 1193.
import { api } from './api';
import type { Book, Page } from './types';

export const BATCH = 1000;
/** Backstop against a route that never reports a short page: 50 × 1000 is more chapters than exist. */
const MAX_BATCHES = 50;

/** `get` is the fetcher, `api` in the app; a test hands it a fake so no network is involved. */
export async function fetchAllBooks(seriesId: string, get: (url: string) => Promise<Page<Book>> = api): Promise<Page<Book>> {
  const url = (p: number) => `/api/series/${seriesId}/books?page=${p}&size=${BATCH}&sort=metadata.numberSort,asc`;
  const first = await get(url(0));
  const content = [...(first.content ?? [])];
  const total = first.totalElements ?? content.length;
  for (let p = 1; content.length < total && p < MAX_BATCHES; p++) {
    const next = await get(url(p));
    // An empty page ends it even short of `total`: the route may hide rows from this viewer after counting.
    if (!next.content?.length) break;
    content.push(...next.content);
  }
  return { ...first, content, size: content.length, totalPages: 1, first: true, last: true };
}
