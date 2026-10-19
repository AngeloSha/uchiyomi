// The settings registry (v0.86.0): every row of Profile → Settings and Admin → Settings, the category it is in, and the
// words it is found by.
//
// The owner, 2026-10-19: "a million toggle in setting and a million section … easier to find, understand what it does".
// The two pages became a few categories with a search over every row (components/SettingsLayout.tsx). This is what
// that search reads, what a `?section=` arrival resolves through (the category to open, the More options or editor to
// unfold, the row to flash), and what the search palette's settings destinations are generated from
// (lib/destinations.ts settingsDestinations), so a setting added here is findable everywhere at once.
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
  /** `?cat=`. */
  id: string;
  /** Its name, an English key shown through tr(). */
  label: string;
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

/** The category `?cat=` names, or null for anything that is not one drawn here. */
export const readCat = (v: string | null, cats: readonly SettingsCategory[]): string | null =>
  typeof v === 'string' && cats.some((c) => c.id === v) ? v : null;

/**
 * `href` with its `cat` set (or dropped, for null), every other parameter untouched -- the tab beside it above all. Path +
 * query + hash, for `history.replaceState` (lib/tabParam.ts withTab says why).
 */
export function withCat(href: string, cat: string | null): string {
  const u = new URL(href, 'http://localhost');
  u.searchParams.delete('cat');
  if (cat) u.searchParams.append('cat', cat);
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

/**
 * The rows a query finds on this page, best first, among those drawn here (`conds`): by the row's label in the reader's
 * language and in English, its keywords, the name it or its category had before v0.86.0, its category's name, then its
 * help. `label` is tr(), passed in so a test can
 * read another language.
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
