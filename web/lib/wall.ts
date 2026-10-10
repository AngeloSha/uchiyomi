// One card per work on the Discover wall, the way search-all already groups server-side.
//
// The wall is its sources' newest lists flattened in arrival order, and popular titles are on most of
// them, so the same series sat on the wall three or four times under slightly different spellings (issue
// #36). Search never had this problem: `/api/sources/search-all` folds its hits into one card carrying every
// provider. The wall gets the same fold here, in the client, because its rows arrive one source at a time and
// nothing already on screen may move -- so the first source to land a title keeps the card, and later sources
// only join its provider list.
//
// Since v0.56.0 the fold is by WORK rather than by spelling. The server names each row's work -- `lib:` a series the
// library holds, `al:` / `mu:` / `md:` what AniList, MangaUpdates or MangaDex say the name is, `n:` a name it has not
// placed yet -- so two sources that title one series differently make one card once a service says so. And the wall
// hides every work the library holds, in any language: the owner's call, browsing is for what you do not have yet.
// Search keeps those, under its "In library" ribbon. A name the server had not placed when it answered is asked about
// again while the page is open (lib/useLiveWorks.ts); `applyWorks` lays the answers over the rows as they came.
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
 * Which work a row or a search group is: the server's `work`, or -- from an older server, which sends none -- the
 * normalised title the wall folded by before v0.56.0. '' for a title that normalises to nothing and has no work.
 */
export const workKey = (it: { work?: string; title: string }): string => it.work || normTitle(it.title);

/**
 * Whether the wall shows a row at all (v0.56.0): never one whose work the library holds in any language, nor one added
 * on this visit. `added` is keyed by work, like everything else here.
 */
export const shownOnWall = (it: { work?: string; title: string; owned?: boolean }, added: ReadonlySet<string>): boolean =>
  !it.owned && !added.has(workKey(it));

/**
 * Fold `items` to one card per work, leaving out what the wall does not show (`shownOnWall`).
 *
 * - keyed by workKey(); a row with no key (an older server's title that normalises to nothing) is passed through
 *   untouched rather than folded with every other such row
 * - the first arrival keeps the card, its `source:sourceId` key and its title, so nothing on screen reflows as sources
 *   land. Only an answer about a work moves a card: into the earlier card of its work, or off the wall.
 * - `inLibrary` is AND-ed (v0.52.0, #72): the server says it per source, in that source's language, so a card is
 *   held only when every provider's language is held. It was OR-ed: held on any source was held, and a Spanish
 *   provider was folded under an "In library" card that opened the English series.
 * - `libraryLangs` is the union of what the rows say the library holds the title in; `librarySeriesId` the first
 * - `coverUrl` comes from the first row that has one, as on the server
 * - one provider per source, in arrival order
 *
 * `groups` is what the card's icons and open() read, keyed by work the way search's groups are -- and ordered by
 *   `rankOf`, not arrival, because the add dialog labels its first provider "preferred": the fastest source to
 *   answer is not the one the page ranks first, and search-all orders its providers the same way.
 */
export function foldByWork(
  items: WallItem[],
  nameOf: (source: string) => string | undefined,
  rankOf: (source: string) => number = () => 0,
  added: ReadonlySet<string> = new Set(),
): { items: WallItem[]; groups: Record<string, WallProvider[]> } {
  const out: WallItem[] = [];
  const groups: Record<string, WallProvider[]> = {};
  const slot = new Map<string, number>();
  for (const it of items) {
    // Held in some language, or added on this visit: not a card at all, rather than a dimmed one to scroll past.
    // Reintroduce by dropping this line: "an owned row is on the wall" in wall.test.ts fails.
    if (!shownOnWall(it, added)) continue;
    const key = workKey(it);
    if (!key) { out.push(it); continue; }
    const provider: WallProvider = {
      source: it.source, name: nameOf(it.source) ?? it.source, sourceId: it.sourceId, title: it.title, coverUrl: it.coverUrl,
      ...(it.lang !== undefined ? { lang: it.lang } : {}), ...(it.inLibrary !== undefined ? { inLibrary: it.inLibrary } : {}),
    };
    const i = slot.get(key);
    if (i === undefined) {
      slot.set(key, out.length);
      groups[key] = [provider];
      out.push(it);
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
    };
  }
  return { items: out, groups };
}

/** What GET /api/discover/works says a key is now (v0.56.0): its current work, and whether the library holds it. */
export interface WorkNow { work: string; owned: boolean }

/**
 * The rows with what the server has said about their works since they came (v0.56.0): an `n:` name it has placed since
 * comes back as `al:…`, or as `lib:…` and owned, and the row takes the answer's work and `owned` -- so the fold puts it
 * on the card that work already has, or the wall drops it. Rows with no new answer are the same objects; a changed one
 * is a new object, never a write into the row the page holds in state.
 */
export function applyWorks<T extends { work?: string; owned?: boolean }>(rows: T[], works: Readonly<Record<string, WorkNow>>): T[] {
  return rows.map((it) => {
    const now = it.work ? works[it.work] : undefined;
    return now && (now.work !== it.work || now.owned !== !!it.owned) ? { ...it, work: now.work, owned: now.owned } : it;
  });
}

/**
 * The works added on this visit, with what the server has placed each as since (v0.56.0): a card added while its name
 * was `n:…` is still the card that was added once the answers make it `al:…`.
 */
export function followWorks(keys: ReadonlySet<string>, works: Readonly<Record<string, WorkNow>>): Set<string> {
  const out = new Set(keys);
  for (const k of keys) if (works[k]) out.add(works[k].work);
  return out;
}

/** The works the server had not placed when it answered (`n:…`), each once: what the page asks about again. */
export function unknownWorks(rows: Array<{ work?: string }>): string[] {
  return [...new Set(rows.map((it) => it.work ?? '').filter((w) => w.startsWith('n:')))];
}

/** What a merge reads of search-all's groups (the Discover page's SearchGroup). */
interface GroupLike {
  title: string; coverUrl?: string; inLibrary?: boolean; librarySeriesId?: string; libraryLangs?: string[];
  rating?: 'adult' | 'safe'; work?: string; owned?: boolean; providers: Array<{ source: string }>;
}

/**
 * Search's groups, one per work (v0.56.0).
 *
 * The server merges its groups by work as it answers, so this changes nothing until a name it had not placed is placed
 * while the results are on screen and two groups turn out to be one work. They merge the way the wall's fold merges
 * rows: the first keeps its place, title and cover; the other's providers join it, one per source; held only when both
 * are (the per-language rule), the library's languages the union, owned when either is, 18+ when either is.
 */
export function mergeGroups<G extends GroupLike>(groups: G[]): G[] {
  const out: G[] = [];
  const slot = new Map<string, number>();
  for (const g of groups) {
    const key = workKey(g);
    const i = key ? slot.get(key) : undefined;
    if (i === undefined) {
      if (key) slot.set(key, out.length);
      out.push(g);
      continue;
    }
    const card = out[i];
    const langs = [...new Set([...(card.libraryLangs ?? []), ...(g.libraryLangs ?? [])])];
    const rating = card.rating === 'adult' || g.rating === 'adult' ? 'adult' : card.rating ?? g.rating;
    out[i] = {
      ...card,
      providers: [...card.providers, ...g.providers.filter((p) => !card.providers.some((q) => q.source === p.source))],
      inLibrary: !!card.inLibrary && !!g.inLibrary,
      ...(langs.length ? { libraryLangs: langs } : {}),
      librarySeriesId: card.librarySeriesId || g.librarySeriesId,
      coverUrl: card.coverUrl || g.coverUrl,
      owned: !!card.owned || !!g.owned,
      ...(rating ? { rating } : {}),
    } as G;
  }
  return out;
}
