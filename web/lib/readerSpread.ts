/**
 * Which pages share a slide in double-page mode.
 *
 * Lifted out of an inline `useMemo` in the reader so the rules can be tested without mounting an 800-line
 * component and faking a scroll container.
 *
 * The rules, in the order they are applied:
 *
 *  1. **Not in spread mode** — one page per slide. Nothing else applies.
 *  2. **The first page of a chapter is solo unless shifted.** The manga convention: page 1 is a cover, and pairing it
 *     with page 2 puts every later pair off by one. `shift` instead pairs from page 1 when it is a story page.
 *  3. **Pages never pair across chapters.** Continuous reading loads the next chapter into the same flat
 *     list, and a slide holding the last page of one chapter and the first of the next belongs to neither.
 *  4. **A wide page is solo**, and so is the page *before* it. A double-page spread scanned as one landscape
 *     image is already two pages wide; putting it beside a portrait page halves it. Giving the page before it
 *     its own slide is what keeps the rest of the chapter paired the way it was drawn -- without that, every
 *     pair after the first spread is off by one, which is the whole reason this rule exists.
 *  4b. **A joined pair is one slide** (#229, Join split double pages, `joinSplit`): two portrait pages the server found
 *     to be the halves of one spread a source served as two files (bff lib/spreadJoin.ts), next to each other in one
 *     chapter. Out of spread mode too -- they are one drawing -- and even as page 1 of a chapter; and the page before
 *     them is solo, for the reason a wide page's neighbour is. A pair is a wide page in all but its files: with Wide
 *     pages -> Split (`split`, a screen held upright) it is not joined, since its two halves ARE the two pages, and the
 *     reader turns it on its side under Rotate. A placeholder page never joins.
 *  5. **Unknown dimensions pair as portrait.** `page_dims` is populated by a backfill that has not
 *     necessarily reached every book, and Komga-backed chapters may carry none at all. Treating unknown as
 *     wide would silently drop those chapters to single-page, which is the more visible wrong answer; it also
 *     matches the reader's own `colW * 1.4` fallback height, which assumes portrait for the same reason.
 */
export interface SpreadItem {
  /** Chapter index in the flat list; pages only pair within one chapter. */
  ci: number;
  firstOfChapter: boolean;
  width?: number | null;
  height?: number | null;
  /** The page's number in its chapter: a join holds only between consecutive numbers (a page hidden between breaks it). */
  number?: number;
  /** #229: the server's finding that this page and the next are one spread, and which side the next one is on. */
  join?: 'rtl' | 'ltr' | null;
  /** A placeholder for a page the source never served: never half of a joined pair. */
  missing?: boolean;
}

/** A page wider than it is tall. Unknown or nonsensical dimensions are portrait -- see rule 5. */
export function isWide(it: Partial<SpreadItem> | undefined): boolean {
  if (!it) return false;
  const { width: w, height: h } = it;
  return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 && w > h;
}

/** Which half of a wide page a slide shows (v0.61.0): `null` for a slide that shows its pages whole. */
export type Half = 'left' | 'right' | null;

/**
 * The slides of paged mode, and which slide each page starts on.
 *
 * v0.61.0, Wide pages → Split: with `split`, and only out of spread mode (a spread already shows a wide page whole,
 * rule 4), a wide page is TWO slides, its two halves, in reading order -- the right half first when `rightFirst` (a
 * right-to-left track, or a right-to-left series read either way: a spread is one drawing, and it reads from the
 * right). Both slides hold the SAME page: progress, the counter, the server, OPDS and the trackers count pages and
 * never see a half. `slideOf` points a page at its first half. A page whose size is not known is never split (rule 5).
 */
export function pairSlides(
  items: SpreadItem[],
  spread: boolean,
  opts: { split?: boolean; rightFirst?: boolean; shift?: boolean; joinSplit?: boolean } = {},
): { slides: number[][]; slideOf: number[]; half: Half[]; joined: boolean[] } {
  const slides: number[][] = [];
  const half: Half[] = [];
  /** Per slide: the two pages of a spread a source served as two files (rule 4b), drawn as one picture. */
  const joined: boolean[] = [];

  // Rule 4b: pages `i` and `i + 1` are one spread to join -- portrait, next to each other in one chapter, both real pages.
  // Never under Split, which shows a spread's halves one by one: for a joined pair those halves are its two pages.
  const joinAt = (i: number): boolean => {
    const a = items[i], b = items[i + 1];
    if (!opts.joinSplit || (opts.split && !spread) || !a?.join || !b || b.ci !== a.ci) return false;
    if (a.number !== undefined && b.number !== undefined && b.number !== a.number + 1) return false;
    return !a.missing && !b.missing && !isWide(a) && !isWide(b);
  };

  if (!spread) {
    for (let k = 0; k < items.length; k++) {
      if (joinAt(k)) { slides.push([k, k + 1]); half.push(null); joined.push(true); k += 1; continue; }
      joined.push(false);
      if (opts.split && isWide(items[k])) {
        const order: Half[] = opts.rightFirst ? ['right', 'left'] : ['left', 'right'];
        for (const h of order) { slides.push([k]); half.push(h); }
        joined.push(false); // the second half's slide
      } else {
        slides.push([k]);
        half.push(null);
      }
    }
  } else {
    let k = 0;
    while (k < items.length) {
      const it = items[k];
      const nxt = items[k + 1];
      if (joinAt(k)) { slides.push([k, k + 1]); half.push(null); joined.push(true); k += 2; continue; }
      // `shift`: a chapter file's page 1 is usually a story page, not a cover, and keeping it solo put
      // every later pair one off from how the book was drawn. Shifted, rule 2 is off and page 1 pairs with page 2.
      const soloed =
        (it.firstOfChapter && !opts.shift) ||  // rule 2
        !nxt || nxt.ci !== it.ci ||   // rule 3
        isWide(it) ||                 // rule 4, the wide page itself
        isWide(nxt) ||                // rule 4, the page before a wide one
        joinAt(k + 1);                // rule 4b, the page before a joined pair
      if (soloed) { slides.push([k]); k += 1; }
      else { slides.push([k, k + 1]); k += 2; }
      half.push(null);
      joined.push(false);
    }
  }

  const slideOf: number[] = new Array(items.length);
  // The FIRST slide that holds a page, so a jump, a resume and a re-anchor land on a split page's first half.
  for (let s = slides.length - 1; s >= 0; s--) for (const k of slides[s]) slideOf[k] = s;
  return { slides, slideOf, half, joined };
}

/**
 * A joined pair's two pages as they sit in the spread, left then right (#229): the detected side, never the track's
 * direction. `join` on the first page says where the second one is -- 'rtl' on its left, the way a right-to-left book
 * runs on -- so a spread read against its book's direction still reassembles as it was drawn.
 */
export function joinedOrder(first: number, second: number, join: 'rtl' | 'ltr' | null | undefined): [number, number] {
  return join === 'rtl' ? [second, first] : [first, second];
}

/** What a wide page becomes on screen (v0.61.0, Reader → Wide pages): itself, its two halves, or turned on its side. */
export type WidePages = 'whole' | 'split' | 'rotate';

/**
 * How tall a page stands in the webtoon column at `colW` wide (v0.61.0). Split, a wide page is its two halves one above
 * the other, each `colW` wide: 4 x colW x h / w in all. Turned on its side, it is `colW` wide and colW x w / h tall.
 * Anything else -- a page that is not wide, or whose size is not known -- is itself, colW x h / w, or the reader's
 * portrait guess of 1.4 when its size is not known.
 */
export function pageHeight(item: Partial<SpreadItem>, colW: number, wide: WidePages = 'whole'): number {
  const { width: w, height: h } = item;
  if (!(typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0)) return colW * 1.4;
  if (wide !== 'whole' && isWide(item)) return wide === 'split' ? 4 * colW * (h / w) : colW * (w / h);
  return colW * (h / w);
}
