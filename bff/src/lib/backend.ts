// Selects the content backend: the real Komga client, or our owned CBZ-library backend.
// Flip with LIBRARY_BACKEND=owned. Until cutover the default keeps the live app on Komga.
import { komga } from './komga';
import { owned } from './ownedCatalog';
import type { ViewCtx } from './visibility';

export const OWNED = process.env.LIBRARY_BACKEND === 'owned';

// When false (owned mode) there is no native Komga progress store, so every account — including admin —
// is tracked via read_progress (catalog.ts gates its admin-native-progress branches on this).
export const NATIVE_PROGRESS = !OWNED;

/**
 * Every read of series or chapter data goes through here, and every one of them takes a viewer first.
 *
 * This used to be `export const content: any`, "typed as any so the existing call sites compile unchanged".
 * That convenience is exactly what made a missed visibility filter undetectable: adding an optional trailing
 * ctx to eleven methods produced zero compile errors at roughly forty call sites, which is how
 * searchSeries ended up being the only ctx-aware call in the codebase while every rail, the reader, OPDS and
 * the image server quietly kept seeing everything.
 *
 * So ctx is FIRST and it is REQUIRED. A call site that forgets it is an arity error, and the wall of
 * compile errors IS the audit of what still needs a viewer.
 */
export interface ContentBackend {
  libraries(ctx: ViewCtx): Promise<Array<{ id: string; name: string }>>;
  genres(ctx: ViewCtx): Promise<string[]>;
  series(ctx: ViewCtx, id: string): Promise<any>;
  seriesNew(ctx: ViewCtx, page?: number, size?: number): Promise<any>;
  seriesUpdated(ctx: ViewCtx, page?: number, size?: number): Promise<any>;
  booksOnDeck(ctx: ViewCtx, page?: number, size?: number): Promise<any>;
  searchSeries(ctx: ViewCtx, body: any, page?: number, size?: number, sort?: string): Promise<any>;
  seriesBooks(ctx: ViewCtx, id: string, page?: number, size?: number, sort?: string): Promise<any>;
  book(ctx: ViewCtx, id: string): Promise<any>;
  bookPages(ctx: ViewCtx, id: string): Promise<any[]>;
  bookNext(ctx: ViewCtx, id: string): Promise<any>;
  bookPrevious(ctx: ViewCtx, id: string): Promise<any>;
  setReadProgress(ctx: ViewCtx, ...args: any[]): Promise<any>;
  scanLibrary(ctx: ViewCtx, ...args: any[]): Promise<any>;
  seriesThumbPath?(id: string): string;
}

/**
 * Komga has its own libraries and its own per-user restrictions, enforced by Komga itself. It accepts the
 * viewer and ignores it rather than pretending to enforce a model it does not have, and viewCtxFor()
 * returns an unrestricted ctx outside owned mode for the same reason.
 */
const komgaAdapter = (k: any): ContentBackend => ({
  libraries: (_c) => k.libraries(),
  genres: (_c) => k.genres(),
  series: (_c, id) => k.series(id),
  seriesNew: (_c, p, s) => k.seriesNew(p, s),
  seriesUpdated: (_c, p, s) => k.seriesUpdated(p, s),
  booksOnDeck: (_c, p, s) => k.booksOnDeck(p, s),
  searchSeries: (_c, body, p, s, sort) => k.searchSeries(body, p, s, sort),
  seriesBooks: (_c, id, p, s, sort) => k.seriesBooks(id, p, s, sort),
  book: (_c, id) => k.book(id),
  bookPages: (_c, id) => k.bookPages(id),
  bookNext: (_c, id) => k.bookNext(id),
  bookPrevious: (_c, id) => k.bookPrevious(id),
  setReadProgress: (_c, ...a) => k.setReadProgress(...a),
  scanLibrary: (_c, ...a) => k.scanLibrary(...a),
  seriesThumbPath: (id: string) => k.seriesThumbPath?.(id),
});

export const content: ContentBackend = OWNED ? (owned as unknown as ContentBackend) : komgaAdapter(komga);
