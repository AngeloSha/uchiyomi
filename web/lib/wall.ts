// One card per title on the Discover wall, the way search-all already groups server-side.
//
// The wall is six sources' newest lists flattened in arrival order, and popular titles are on most of
// them, so the same series sat on the wall three or four times under slightly different spellings (issue
// #36). Search never had this problem: `/api/sources/search-all` folds its hits by normalised title into one
// card carrying every provider, and the card's badge says how many. The wall gets the same fold here, in
// the client, because its rows arrive one source at a time and nothing already on screen may move -- so the
// first source to land a title keeps the card, and later sources only join its provider list.
//
// Split out of the page so it can be tested without a browser, like sourceGroups.ts.
import { normTitle } from './normTitle';
import type { SourceItem } from '../components/cards';
import type { Provider } from '../components/AddSeriesDialog';

/** One place a title can be added from. The shape AddSeriesDialog's `group` seed takes. */
export type WallProvider = Provider;
/** One row on the wall. The shape SourceCard renders and the search path already produces. */
export type WallItem = SourceItem;

/**
 * Fold `items` to one card per title.
 *
 * - keyed by normTitle(title); a row that normalises to nothing (all punctuation, or empty) is passed through
 *   untouched rather than folded with every other such row
 * - the first arrival keeps the card, its `source:sourceId` key and its title, so nothing on screen reflows
 * - `inLibrary` is AND-ed (v0.52.0, #72): the server says it per source, in that source's language, so a card is
 *   owned only when every provider's language is held -- an English Blue Lock in the library and a Spanish
 *   provider on the wall make a card that is still addable, as a new edition. It was OR-ed: owned on any source
 *   was owned, and the Spanish provider was folded under an "In library" card that opened the English series.
 * - `libraryLangs` is the union of what the rows say the library holds the title in; `librarySeriesId` the first
 * - `coverUrl` comes from the first row that has one, as on the server
 * - one provider per source, in arrival order; `providerCount` is that list's length, which is what lights
 *   the badge on the card
 *
 * `groups` is what open() hands to the add dialog, keyed the same way search stores its groups -- and
 *   ordered by `rankOf`, not arrival, because the dialog labels its first provider "preferred": the fastest
 *   source to answer is not the one the page ranks first, and search-all orders its providers the same way.
 */
export function foldByTitle(
  items: WallItem[],
  nameOf: (source: string) => string | undefined,
  rankOf: (source: string) => number = () => 0,
): { items: WallItem[]; groups: Record<string, WallProvider[]> } {
  const out: WallItem[] = [];
  const groups: Record<string, WallProvider[]> = {};
  const slot = new Map<string, number>();
  for (const it of items) {
    const key = normTitle(it.title);
    if (!key) { out.push(it); continue; }
    const provider: WallProvider = {
      source: it.source, name: nameOf(it.source) ?? it.source, sourceId: it.sourceId, title: it.title, coverUrl: it.coverUrl,
      ...(it.lang !== undefined ? { lang: it.lang } : {}), ...(it.inLibrary !== undefined ? { inLibrary: it.inLibrary } : {}),
    };
    const i = slot.get(key);
    if (i === undefined) {
      slot.set(key, out.length);
      groups[key] = [provider];
      out.push({ ...it, providerCount: 1 });
      continue;
    }
    const providers = groups[key];
    // A source listing the same title twice (a re-listing after an update, two editions) is still one place
    // to add it from; the dialog would otherwise offer the same source as two rows.
    if (!providers.some((p) => p.source === it.source)) {
      providers.push(provider);
      providers.sort((a, b) => rankOf(a.source) - rankOf(b.source));
    }
    const card = out[i];
    // A new object, never a write into the row the page holds in state.
    // Reintroduce by OR-ing `inLibrary` again: "an English item in the library and a Spanish one not in it fold to a
    // card that is not owned" in wall.test.ts reads owned.
    const langs = [...new Set([...(card.libraryLangs ?? []), ...(it.libraryLangs ?? [])])];
    out[i] = {
      ...card,
      inLibrary: !!card.inLibrary && !!it.inLibrary,
      ...(langs.length ? { libraryLangs: langs } : {}),
      librarySeriesId: card.librarySeriesId || it.librarySeriesId,
      coverUrl: card.coverUrl || it.coverUrl,
      providerCount: providers.length,
    };
  }
  return { items: out, groups };
}
