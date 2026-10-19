// The console registry (v0.86.0, every page since v0.88.0): every page of Profile and Admin, the group it is listed under,
// and every row of their settings pages with the words it is found by.
//
// v0.88.0 (the owner, after v0.86.0: "I still have to go to a tab under a tab"): Profile and Admin are each ONE grouped
// list (components/ConsoleLayout.tsx) -- their pages, the settings categories among them, no tab rows inside tabs.
//
// The owner, 2026-10-19: "a million toggle in setting and a million section … easier to find, understand what it does".
// The two settings pages became a few categories with a search over every row (v0.86.0). This is what that search reads, what a `?section=` arrival resolves through (the category to open, the More options or editor to
// unfold, the row to flash), and what the search palette's settings destinations are generated from
// (lib/destinations.ts consoleDestinations), so a setting added here is findable everywhere at once.
//
// Each entry's `id` is its row's DOM id and its `label` is the row's own English label, the key its `tr()` shows, so the
// search matches what the screen says, in the reader's language. test/settingsIndex.test.ts holds every id to a row in
// the source and every row id back to an entry.

/** Lower case with the accents off, so "parametres" finds "Paramètres" and "u" finds "ü". */
export const fold = (s: string): string => s.normalize('NFKD').replace(/\p{M}+/gu, '').toLocaleLowerCase();

/** What a row needs to be drawn at all: search never offers a row the page does not draw. */
export type SettingsCondition =
  /** Not on Uchiyomi Desktop, which has no such page or setting (lib/desktop.ts). */
  | 'web'
  /** Not in SSO-only mode (v0.63.0), which has no sign-up at all. */
  | 'local-accounts'
  /** An extension engine is configured (the extension rows). */
  | 'extensions'
  /** A pointer that can hover: a computer, not a phone or tablet held alone (the rows that do nothing on touch). */
  | 'pointer';

export interface SettingsCategory {
  /** The page's `?tab=` (lower case; an older capitalised tab name is read case-blind). */
  id: string;
  /** Its name, an English key shown through tr(). */
  label: string;
  /** The heading it is listed under, an English key; none for the first rows. */
  group?: string;
  /** A settings page: its groups are laid out in the pane's columns, and its rows are entries below. */
  settings?: boolean;
  /** English words someone might type for the page besides its name. */
  keywords?: readonly string[];
  when?: readonly SettingsCondition[];
}

export interface SettingsEntry {
  /** The row's DOM id, and its `?section=`. */
  id: string;
  /** The category it is in. */
  cat: string;
  /** What the row says, an English key shown through tr(). */
  label: string;
  /** The row's help, an English key: searched too, below the label and the keywords. */
  help?: string;
  /** English words someone might type for it besides its label. */
  keywords?: readonly string[];
  /** In a More options fold: that fold's id (components/settings.tsx MoreOptions). */
  more?: string;
  /**
   * Inside an editor: the editor's id, which is also its summary row's id. The summary row itself has none -- search and
   * links land on it, and a tap opens the editor; a row inside the editor opens it on arrival.
   */
  editor?: string;
  when?: readonly SettingsCondition[];
}

export interface SettingsIndex {
  page: 'profile' | 'admin';
  categories: readonly SettingsCategory[];
  entries: readonly SettingsEntry[];
  /**
   * `?section=` ids from before v0.86.0, when each page was a grid of cards: the links people saved, other pages' links
   * and older docs keep landing where that card's rows are now.
   */
  legacy: Readonly<Record<string, { cat: string; row?: string }>>;
  /** A section's or a row's name before v0.86.0 → the name it has now: searching the old name finds where it went. */
  aliases?: Readonly<Record<string, string>>;
  /**
   * `?tab=` values from before v0.88.0 that name no page any more → the page (`settings`: the `?cat=` beside it, else
   * this). Matched case-blind, as every tab is.
   */
  tabAliases?: Readonly<Record<string, string>>;
}

/** Where an arrival lands: the category, and the row with whatever folds it (More options, an editor). */
export interface SettingsPlace { cat: string; row?: string; more?: string; editor?: string }

export const shown = (when: readonly SettingsCondition[] | undefined, conds: Readonly<Record<SettingsCondition, boolean>>): boolean =>
  !when || when.every((c) => conds[c]);

/**
 * Where `?section=<id>` (or a search pick) lands on this page, or null for an id this page does not know -- another
 * card of the same page (Connections, Account) answers it as it always has (lib/useSectionArrival.ts). A row first, then
 * a category by its own id, then a section id from before the redesign.
 */
export function resolveSection(index: SettingsIndex, id: string | null): SettingsPlace | null {
  if (!id) return null;
  const e = index.entries.find((x) => x.id === id);
  if (e) return { cat: e.cat, row: e.id, more: e.more, editor: e.editor };
  if (index.categories.some((c) => c.id === id)) return { cat: id };
  const old = Object.prototype.hasOwnProperty.call(index.legacy, id) ? index.legacy[id] : undefined;
  if (old) {
    const row = old.row ? index.entries.find((x) => x.id === old.row) : undefined;
    return row ? { cat: row.cat, row: row.id, more: row.more, editor: row.editor } : { cat: old.cat };
  }
  return null;
}

/**
 * The page an address names (v0.88.0): `?tab=` case-blind -- `Health` and `health` are one page -- then a tab from
 * before v0.88.0 by `tabAliases` (`Tasks` is Maintenance; `Settings` is the category its `?cat=` named, or the first
 * settings page), or null for none of this page's (`shownIds`: the pages drawn here).
 */
export function readPage(index: SettingsIndex, tab: string | null, cat: string | null, shownIds: readonly string[]): string | null {
  if (!tab) return null;
  const t = tab.toLowerCase();
  const direct = shownIds.find((id) => id === t);
  if (direct) return direct;
  const alias = Object.entries(index.tabAliases ?? {}).find(([from]) => from.toLowerCase() === t)?.[1];
  if (!alias) return null;
  if (alias === 'settings') {
    const c = cat ? cat.toLowerCase() : null;
    return (c && shownIds.find((id) => id === c)) || shownIds.find((id) => index.categories.find((x) => x.id === id)?.settings) || null;
  }
  return shownIds.includes(alias) ? alias : null;
}

/**
 * `href` on page `id` (or on none, for the list): `?tab=` set or dropped, and the `?cat=` of the v0.86.0 settings tab
 * dropped with it, every other parameter untouched. Path + query + hash, for `history.pushState` / `replaceState`.
 */
export function withPage(href: string, id: string | null): string {
  const u = new URL(href, 'http://localhost');
  u.searchParams.delete('tab');
  u.searchParams.delete('cat');
  if (id) u.searchParams.set('tab', id);
  return `${u.pathname}${u.search}${u.hash}`;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const atWordStart = (text: string, word: string): boolean => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(word)}`, 'u').test(text);

/**
 * How well `query` names something with these names and keywords, best 0, or -1 for no match: the search palette's
 * ranking (lib/destinations.ts findDestinations), shared so a setting is found the same way in both places. Its label
 * whole, at its start, every word at a word's start, anywhere in it (from three characters, or in Chinese and Japanese,
 * written without spaces), then its keywords the same way. `extra` -- a row's help -- ranks below all of those, and only
 * on whole words: "page" inside twenty helps would bury what was asked for.
 */
export function rankMatch(query: string, names: readonly string[], keywords: readonly string[] = [], extra: readonly string[] = []): number {
  const q = fold(query.trim()).replace(/\s+/g, ' ');
  if (q.length < 2) return -1;
  const words = q.split(' ');
  const inside = q.length >= 3 || CJK.test(q);
  const ns = names.map(fold);
  if (ns.includes(q)) return 0;
  if (ns.some((n) => n.startsWith(q))) return 1;
  if (ns.some((n) => words.every((w) => atWordStart(n, w)))) return 2;
  if (inside && ns.some((n) => n.includes(q))) return 3;
  const kws = keywords.map(fold);
  if (kws.some((k) => k === q || k.startsWith(q))) return 4;
  const all = [...ns, ...kws].join('\n');
  if (words.every((w) => atWordStart(all, w))) return 5;
  if (inside && words.every((w) => all.includes(w))) return 6;
  const more = extra.map(fold).join('\n');
  if (more && words.every((w) => atWordStart(more, w)) && (inside || words.length > 1)) return 7;
  return -1;
}

/** A page found by the console's search: its own name, the words it is known by. */
export function searchPages(index: SettingsIndex, query: string, conds: Readonly<Record<SettingsCondition, boolean>>,
  label: (k: string) => string, drawn: (id: string) => boolean): SettingsCategory[] {
  return index.categories
    .filter((c) => shown(c.when, conds) && drawn(c.id))
    .map((c, i) => {
      const was = Object.entries(index.aliases ?? {}).filter(([, to]) => to === c.label).map(([from]) => from);
      return { c, i, r: rankMatch(query, [label(c.label), c.label], [...(c.keywords ?? []), ...was]) };
    })
    .filter((x) => x.r >= 0 && x.r <= 4)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, 3)
    .map((x) => x.c);
}

/**
 * The rows a query finds on this page, best first, among those drawn here (`conds`): by the row's label in the reader's
 * language and in English, its keywords, the name it or its category had before v0.86.0, its category's name, then its
 * help. `label` is tr(), passed in so a test can read another language.
 */
export function searchSettings(index: SettingsIndex, query: string, conds: Readonly<Record<SettingsCondition, boolean>>,
  label: (k: string) => string, limit = 8): SettingsEntry[] {
  const cats = new Map(index.categories.map((c) => [c.id, c]));
  return index.entries
    .filter((e) => shown(e.when, conds) && shown(cats.get(e.cat)?.when, conds))
    .map((e, i) => {
      const cat = cats.get(e.cat);
      const was = Object.entries(index.aliases ?? {}).filter(([, to]) => to === e.label || to === cat?.label).map(([from]) => from);
      const kws = [...(e.keywords ?? []), ...was, ...(cat ? [label(cat.label), cat.label] : [])];
      const extra = e.help ? [label(e.help), e.help] : [];
      return { e, i, r: rankMatch(query, [label(e.label), e.label], kws, extra) };
    })
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.e);
}
