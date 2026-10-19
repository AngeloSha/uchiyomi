/**
 * Translated pages (v0.85.0): what the reader needs from the server's translations, kept pure for the tests.
 *
 * The server translates a chapter one page at a time once the reader asks (POST /api/books/:id/translations) and keeps
 * each page's translation; the reader asks which pages are done (their stamps) and shows a done page by adding `tl` and
 * `tv` to its address. A page not done yet is the original, so nothing waits for the engine.
 */

/** A chapter's translations into the reader's language, as GET /api/books/:id/translations answers. */
export interface TranslateStatus {
  available: boolean;
  /** Why the server stopped translating (not enough free memory, say), or null. */
  problem: string | null;
  /** Each translated page (1-based) and its stamp. */
  pages: Record<string, string>;
  failed: number[];
  /** Pages of this chapter the server still has to do. */
  pending: number;
}

/** The page's address with its translation, when the server has one; the address as it was otherwise. */
export function translatedSrc(src: string, lang: string, stamp: string | undefined): string {
  if (!stamp) return src;
  return `${src}${src.includes('?') ? '&' : '?'}tl=${encodeURIComponent(lang)}&tv=${encodeURIComponent(stamp)}`;
}

/** How many of a chapter's pages are translated, while the server is still at it; null once it has finished or stopped. */
export function translating(s: TranslateStatus | undefined, total: number): { done: number; total: number } | null {
  if (!s?.available || s.pending <= 0 || total <= 0) return null;
  const done = Object.keys(s.pages).length;
  return done >= total ? null : { done, total };
}
