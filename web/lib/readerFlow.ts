/**
 * The reading flow: the list of pages the reader actually walks, and how a repeated page sits in it.
 *
 * This lives outside the reader component for the same reason `readerSpread.ts` and `readerState.ts` do —
 * it is arithmetic that decides what you see, and inside an 800-line component it could only be checked by
 * opening a chapter and counting. Three shipped bugs came from exactly this arithmetic being unreachable:
 * a resume that landed a page late, a chapter divider that disappeared, and a page-grid tile that jumped to
 * the top of the library. All three are now one function with tests.
 *
 * ⚠️ THE CENTRAL RULE: a page being skipped is a property of HOW IT RENDERS, not of whether it exists. The
 * flow holds every page in `show` and `collapse` mode; only `hide` removes anything. Filtering was what made
 * "flat index" and "page number" two different things, and every one of those bugs was a place that quietly
 * assumed they were the same.
 */

/** What the reader does with a page that repeats across chapters. Mirrors `ReaderPrefs['junkPages']`. */
export type JunkMode = 'show' | 'collapse' | 'hide';

export interface FlowPage {
  number: number;
  width: number | null;
  height: number | null;
  junk?: boolean;
  /**
   * A placeholder the server saved in place of a page the source never served (v0.40.0). Carried, never
   * acted on: a missing page is drawn at full height with a caption over it, in every mode. It is not
   * furniture -- it is the one page the reader most needs to know is not there -- so `collapse` and `hide`
   * leave it exactly where it is.
   */
  missing?: boolean;
}

export interface FlowChapter {
  id: string;
  pages: FlowPage[];
}

export interface FlowItem {
  /** Index into the chapter list the flow was built from. */
  ci: number;
  number: number;
  width: number | null;
  height: number | null;
  /** `${chapterId}:${pageNumber}` — the identity used for blobs, expansion and grid tiles alike. */
  key: string;
  firstOfChapter: boolean;
  junk?: boolean;
  /** The page is a placeholder for one the source never served; the renderer draws the caption. See FlowPage. */
  missing?: boolean;
  /** Drawn as a thin band of itself rather than at full height. Derived, never stored. */
  collapsed?: boolean;
}

/**
 * Build the reading flow.
 *
 * ⚠️ `firstOfChapter` is computed ON THE OUTPUT, not on the source chapter. Computing it as "page index 0 of
 * the chapter" and then consuming it on a list that had pages removed means that when page 1 is the repeated
 * one, NOTHING in the flow carries the flag: the "Up Next / chapter title" divider silently disappears, and
 * because `pairSlides` uses the same flag to keep the first page of a chapter solo, every double-page spread
 * in that chapter shifts by one. Deriving it here makes it true by construction in all three modes.
 * Reintroduce by setting it from the source index instead: in `hide` mode a chapter whose first page is
 * repeated loses its divider and re-phases its spreads.
 *
 * ⚠️ The "never leave a chapter empty" guard is PER CHAPTER. It used to be a single check over the whole
 * list — `out.length ? out : all` — which is a different claim entirely: with two chapters loaded, one of
 * them entirely furniture, the list is non-empty, so that chapter was dropped from the flow completely and
 * continuous reading walked straight past it. Reintroduce by testing the total length instead of each
 * chapter's: a fully-flagged chapter vanishes between its neighbours.
 */
export function buildFlow(
  chapters: FlowChapter[],
  mode: JunkMode,
  expanded: ReadonlySet<string> = new Set(),
): FlowItem[] {
  const out: FlowItem[] = [];
  chapters.forEach((ch, ci) => {
    // `expanded` means "the reader asked for this page" in both modes: collapse draws it full height, hide
    // puts it back in the flow. One state axis, so a page can never be expanded-but-absent.
    const keep = mode === 'hide'
      ? ch.pages.filter((p) => p.missing || !p.junk || expanded.has(`${ch.id}:${p.number}`))
      : ch.pages;
    // A chapter that is nothing but furniture is a chapter we have got wrong. Showing it empty would read as
    // a broken download, so it is shown whole instead.
    const pages = keep.length ? keep : ch.pages;
    pages.forEach((p) => {
      const key = `${ch.id}:${p.number}`;
      out.push({
        ci,
        number: p.number,
        width: p.width,
        height: p.height,
        key,
        firstOfChapter: false,
        junk: p.junk,
        // ⚠️ Passed through untouched and never a reason to collapse or drop the page. The flow's job is
        // to keep "flat index" and "page number" the same thing, and a missing page is still a page --
        // the archive holds a real placeholder at that index, the server counts it, progress lands on it.
        // Reintroduce by leaving `missing` off this object: the reader's caption has nothing to key on and
        // the placeholder renders as a blank grey page that reads as a broken image.
        missing: p.missing,
        collapsed: mode === 'collapse' && !!p.junk && !p.missing && !expanded.has(key),
      });
    });
  });
  for (let i = 0; i < out.length; i++) {
    out[i].firstOfChapter = i === 0 || out[i - 1].ci !== out[i].ci;
  }
  return out;
}

/**
 * Where a PAGE NUMBER lands in the flow.
 *
 * ⚠️ Resume, `?page=` and a saved Moment all name a page number, and the reader needs an index. Subtracting
 * one is only correct while the flow holds every page of every preceding chapter — which stopped being true
 * the moment anything was filtered out, and nobody noticed because the drift is silent: you simply resume a
 * little further on than you left off, by exactly the number of pages skipped before you.
 * Reintroduce by using `pageNumber - 1` as the index: with one repeated page earlier in the chapter, opening
 * a Moment saved on page 3 lands you on page 4.
 */
export function startIndex(flow: FlowItem[], ci: number, pageNumber: number): number {
  const exact = flow.findIndex((f) => f.ci === ci && f.number === pageNumber);
  if (exact >= 0) return exact;
  // The page was removed (`hide`), so land on the nearest one that survived rather than nowhere.
  const after = flow.findIndex((f) => f.ci === ci && f.number > pageNumber);
  if (after >= 0) return after;
  const firstOfChapter = flow.findIndex((f) => f.ci === ci);
  return firstOfChapter >= 0 ? firstOfChapter : 0;
}

/**
 * Which items should hold a decoded image right now.
 *
 * ⚠️ A collapsed page does not spend the budget. It is drawn from a thumbnail, so counting it would quietly
 * shorten the real lookahead by one page for every repeated page in range — leaving the reader waiting on a
 * decode that used to be ready, which is a regression against simply removing the page.
 * Reintroduce by counting every index in the window: with a strip at `current + 1`, the last page of the
 * lookahead falls out of the set.
 */
export function renderWindow(flow: FlowItem[], current: number, behind: number, ahead: number): Set<number> {
  const s = new Set<number>();
  if (current >= 0 && current < flow.length && !flow[current]?.collapsed) s.add(current);
  let spent = 0;
  for (let i = current + 1; i < flow.length && spent < ahead; i++) {
    if (flow[i].collapsed) continue;
    s.add(i);
    spent++;
  }
  spent = 0;
  for (let i = current - 1; i >= 0 && spent < behind; i--) {
    if (flow[i].collapsed) continue;
    s.add(i);
    spent++;
  }
  return s;
}
