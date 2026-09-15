// The supply line under a series' title -- "MangaDex · Translated by Asura Scans, Flame Comics (+1) · 4 not
// here yet · checked 2h ago" -- with no React in it.
//
// It replaces the "Who scanlates this" card and the "{n} behind" meta bit: one muted line that says where
// the chapters come from, who translates them and whether there is more to fetch, and opens the Sources &
// translations sheet for the rest. Which parts appear, in which order, and what each says when a fact is
// missing are decisions a person will argue with ("why does it say nothing on my series?"), so they live
// here where a test can reach every state.
//
// ⚠️ Two forms. The desktop line has room for two group names and the check time; at 390 px it does not
// (measured: the full sentence is ≈545 px of text on a 358 px column, and `truncate` on the names left
// "Translated by …" -- an ellipsis where the one useful word was). The phone form is the avatar stack, the
// busiest name and "+n", and drops "checked {ago}" (it is the first line of the sheet). `wide` picks.
//
// ⚠️ And the phone form drops the busiest NAME too when the source's name is long. Measured at 390 px with
// `Mangakakalot (Manganato)` as the source: the favicon, the three avatars, "+n", the separators and the
// chevron leave ≈220 px for the three pieces of text, and that name alone is 155 of them, so the group
// name was squeezed to 0 px and "+2" to a sliver -- `Mangakakalot (Manganato) · [RS FC AS] · · 4 not here
// yet`. The count never gives (it is the fact the line exists to carry), so what gives is the name: the
// stack stays, "+n" then counts past the stack, and the sheet has the names. PHONE_NAMES_BUDGET says when.

import type { SeriesSource } from './types';
import { keys } from './i18n';
import { relativeTime } from './format';

export interface SupplyInput {
  /** The series' followed sources, main first (`series.sources`); empty for a series scanned from disk. */
  sources: Pick<SeriesSource, 'sourceId' | 'name' | 'primary' | 'registered'>[];
  /** The translation groups, busiest first, by name. */
  groups: string[];
  /** Chapters the sources list that this server lacks and the sweep would take: ghosts whose `why` is not `floor`. */
  notHere: number;
  /** Every number the sources list, floor included -- what a 0-chapter series has to show for itself. */
  listedTotal: number;
  booksCount: number;
  /** When the sources were last asked; null when never. */
  checkedAt: string | null;
  autoUpdate: boolean;
  /** The groups route failed. Admins are told; members just get no group segment. */
  groupsError: boolean;
  isAdmin: boolean;
}

export type SupplyPart =
  /** The main source: its favicon and name, dimmed when the adapter is no longer installed. */
  | { kind: 'source'; sourceId: string; name: string; registered: boolean }
  /**
   * The groups: `names` to print (two on a desktop, one on a phone, NONE on a phone beside a long source
   * name), `all` for the avatar stack, `more` the rest -- past the printed names, or past the stack when
   * nothing is printed.
   */
  | { kind: 'groups'; names: string[]; all: string[]; more: number }
  /** A translated sentence, `tr(key, args)`. */
  | { kind: 'text'; key: string; args?: Record<string, string | number> };

// Declared through `keys()` because they reach `tr()` through the parts' `key`, which the string extractor
// cannot see (lib/i18n.ts says why that has shipped untranslated labels three times).
export const SUPPLY_LABELS = keys(
  'Translated by {names}', '{n} not here yet', 'checked {ago}', 'not checked yet', 'auto-update off',
  'Source not installed', 'not installed', 'translations unavailable', 'Added from disk', 'no source',
  '{n} chapters listed · none fetched yet',
);
const L = {
  translatedBy: SUPPLY_LABELS[0], notHere: SUPPLY_LABELS[1], checked: SUPPLY_LABELS[2], notChecked: SUPPLY_LABELS[3],
  autoOff: SUPPLY_LABELS[4], sourceNotInstalled: SUPPLY_LABELS[5], notInstalled: SUPPLY_LABELS[6],
  unavailable: SUPPLY_LABELS[7], fromDisk: SUPPLY_LABELS[8], noSource: SUPPLY_LABELS[9], noneFetched: SUPPLY_LABELS[10],
};

/**
 * Whether a source id belongs to an adapter that names the group behind each chapter: MangaDex and the
 * Mihon extensions do; a site added by URL is read by the built-in engine, which cannot. The sheet's empty
 * state says "this site does not name translation groups" only for the second kind, or a MangaDex series
 * that has simply not been checked yet would be told its site never says.
 */
export function namesGroups(sourceId: string): boolean {
  return sourceId === 'mangadex' || sourceId.startsWith('sw:');
}

/**
 * How many characters of NAMES -- the source's plus the busiest group's -- the phone line holds beside the
 * count with the group name still whole. Measured at 390 px (a 358 px line, text-xs): `MangaDex · [stack]
 * Reaper Scans +2 · 4 not here yet` (8 + 12) fits with 4 px to spare, `Weeb Central · [stack] Reaper
 * Scans` (12 + 12) was already an ellipsis. ⚠️ Characters, not pixels: the count is translated and the
 * font is the reader's, so this is a decision the test can reach, and the CSS (`min-w-0 truncate` on both
 * names, never the count) is the net under it for the languages and phones the constant did not see.
 */
export const PHONE_NAMES_BUDGET = 20;
/** What "not installed" costs in that budget, in characters; "Source not installed" is the sentence's own length. */
const NOT_INSTALLED_CHARS = 13;

/**
 * The parts of the line, in display order, or null when there is nothing to say (a member's series scanned
 * from disk with no group named in its files -- the chapters are the page and this would be an empty line).
 *
 *   * source: the main source (`primary`, else the first). ⚠️ An uninstalled extension arrives with its raw
 *     nineteen-digit id as the name (`seriesSources.ts` falls back to `getSource(id)?.name ?? id`), and a line
 *     that starts with "8683375824843625513 · not installed" tells nobody anything: when the name IS the id
 *     the part is the sentence "Source not installed" and no name. A known name that is not installed keeps
 *     the name, dimmed, plus "not installed";
 *   * groups: absent when none are known (an engine source, or a never-checked series); "translations
 *     unavailable" for an admin whose groups route failed (a member's segment is simply absent); on a
 *     phone, the stack alone when the source's name and the busiest group's together are past
 *     PHONE_NAMES_BUDGET (a sentence in the source's place -- "Source not installed" -- or "not installed"
 *     after the name spends the same room);
 *   * the count: "not checked yet" until the sources have been asked; then, for a series with no chapters
 *     at all (a "Nothing yet" add), "{n} chapters listed · none fetched yet", since every one of its listed
 *     numbers sits below the floor and "0 not here yet" would be a lie about a series that has 300 chapters
 *     waiting -- ⚠️ on a phone that sentence takes the room the group segment needs (measured: the name
 *     shrank to nothing and "+2" painted over the count), so the phone form of that one state has no group
 *     segment; the sheet lists them, and the count is the call to action; then "auto-update off" instead of
 *     a count that is no longer being maintained; then "{n} not here yet" when there is something to fetch,
 *     and nothing when there is not;
 *   * "checked {ago}" last, desktop only;
 *   * no source at all: admins read "Added from disk · no source" (with the groups between, when the files
 *     name any); members read the groups alone, or nothing.
 */
export function supplyLine(input: SupplyInput, wide: boolean): SupplyPart[] | null {
  const main = input.sources.find((s) => s.primary) ?? input.sources[0] ?? null;
  const parts: SupplyPart[] = [];

  // The room the source part spends on a phone, in characters: its name (plus "not installed" after a
  // known one) or the whole "Source not installed" sentence for an adapter known only by its id.
  const sourceChars = !main ? 0
    : !main.registered && main.name === main.sourceId ? L.sourceNotInstalled.length
    : main.name.length + (main.registered ? 0 : NOT_INSTALLED_CHARS);
  const groupsPart = (): SupplyPart | null => {
    if (input.groupsError) return input.isAdmin ? { kind: 'text', key: L.unavailable } : null;
    if (!input.groups.length) return null;
    const all = input.groups.slice(0, 3);
    const shown = wide ? 2 : sourceChars + input.groups[0].length <= PHONE_NAMES_BUDGET ? 1 : 0;
    return { kind: 'groups', names: input.groups.slice(0, shown), all, more: Math.max(0, input.groups.length - (shown || all.length)) };
  };

  if (!main) {
    const g = groupsPart();
    if (!input.isAdmin) return g ? [g] : null;
    parts.push({ kind: 'text', key: L.fromDisk });
    if (g) parts.push(g);
    parts.push({ kind: 'text', key: L.noSource });
    return parts;
  }

  if (!main.registered && main.name === main.sourceId) {
    parts.push({ kind: 'text', key: L.sourceNotInstalled });
  } else {
    parts.push({ kind: 'source', sourceId: main.sourceId, name: main.name, registered: main.registered });
    if (!main.registered) parts.push({ kind: 'text', key: L.notInstalled });
  }
  const noneFetched = !!input.checkedAt && input.booksCount === 0;
  const g = noneFetched && !wide ? null : groupsPart();
  if (g) parts.push(g);

  if (!input.checkedAt) {
    parts.push({ kind: 'text', key: L.notChecked });
    return parts;
  }
  if (noneFetched) parts.push({ kind: 'text', key: L.noneFetched, args: { n: input.listedTotal } });
  else if (!input.autoUpdate) parts.push({ kind: 'text', key: L.autoOff });
  else if (input.notHere > 0) parts.push({ kind: 'text', key: L.notHere, args: { n: input.notHere } });
  if (wide) parts.push({ kind: 'text', key: L.checked, args: { ago: relativeTime(input.checkedAt) } });
  return parts;
}

/**
 * The line as one plain string, parts joined with ` · `, through `tr`. What a test compares and what a
 * screen reader gets (the button's `aria-label`; the avatars are `aria-hidden`): the desktop groups part
 * reads "Translated by A, B (+1)", the phone one "A +2" -- or, when the phone prints no name, the stack's
 * names "A, B, C +1", since a reader who cannot see the avatars would otherwise hear no group at all.
 */
export function supplyText(parts: SupplyPart[] | null, tr: (key: string, args?: Record<string, string | number>) => string, wide: boolean): string {
  if (!parts) return '';
  return parts.map((p) => {
    if (p.kind === 'source') return p.name;
    if (p.kind === 'groups') {
      const names = (p.names.length ? p.names : p.all).join(', ') + (p.more > 0 ? (wide ? ` (+${p.more})` : ` +${p.more}`) : '');
      return wide ? tr(L.translatedBy, { names }) : names;
    }
    return tr(p.key, p.args);
  }).join(' · ');
}
