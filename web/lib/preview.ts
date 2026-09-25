// Reading a chapter from a source before adding the series (#91): the addresses the viewer asks for, and the
// order it steps through. A chapter is named by its NUMBER and a page by its INDEX -- the server's own listing
// resolves both (bff routes/sources.ts previewChapters), so no URL from a site ever travels through here.

export interface PreviewChapter { number: number; title: string | null; scanlator: string | null }

const qs = (o: Record<string, string | number>) =>
  Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');

export const previewListUrl = (source: string, sourceId: string) => `/api/sources/preview?${qs({ source, sourceId })}`;
export const previewCountUrl = (source: string, sourceId: string, number: number) =>
  `/api/sources/preview/pages?${qs({ source, sourceId, number })}`;
/** One page's image: an <img> sends the image cookie, which is how /img/ routes know who is asking. */
export const previewPageUrl = (source: string, sourceId: string, number: number, i: number) =>
  `/img/sources/preview?${qs({ source, sourceId, number, i })}`;

/** The chapters in reading order, and the neighbours of one of them. */
export function inOrder(list: readonly PreviewChapter[]): PreviewChapter[] {
  return [...list].sort((a, b) => a.number - b.number);
}
export function neighbours(ordered: readonly PreviewChapter[], number: number): { prev?: number; next?: number } {
  const i = ordered.findIndex((c) => c.number === number);
  if (i < 0) return {};
  return { prev: ordered[i - 1]?.number, next: ordered[i + 1]?.number };
}
