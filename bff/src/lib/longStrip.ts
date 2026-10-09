// A chapter of one or two images: a failed download, or a whole chapter stitched into long strips? Its pages' shape says
// which, and nothing else in the database does (a byte count cannot: an ad banner and a strip can weigh the same).
// Dependency-free, so it is unit-tested without booting the app's environment.

/** One page's measured size, as lib/library.ts cbzPageDims reads it and lib_books.page_dims caches it. */
export interface PageDim {
  width: number | null;
  height: number | null;
}

/**
 * How many screen-widths tall the pages must stand, together, to be a long strip: the sum of each page's height over its
 * width, which is how tall the reader lays them out on a screen of any width. What a failed download leaves is a
 * placeholder, an ad or a credits banner, about one width tall or less; a notice runs up to about six; a webtoon chapter
 * stitched into one or two images is tens (Eleceed 215 on the live server: two 689 × 54,000 strips, 155).
 */
export const STRIP_HEIGHT = 10;

/** Do these pages, together, stand at least STRIP_HEIGHT screen-widths tall? Any page not measured answers no. */
export function longStrip(dims: readonly PageDim[] | null | undefined): boolean {
  if (!dims?.length) return false;
  let tall = 0;
  for (const d of dims) {
    if (!d.width || !d.height || d.width < 0 || d.height < 0) return false;
    tall += d.height / d.width;
  }
  return tall >= STRIP_HEIGHT;
}
