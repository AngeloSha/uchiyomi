// Home's rails, the reader's way round (Look settings, UI refresh phase 3): which of them Home shows, and in what order.
//
// HOME_RAILS is the owner's order -- the order Home has always drawn its rails in, and the one a reader who never opens
// Customize keeps. A reader's own arrangement is `settings.homeRails` on the account ({ order, hidden }, through GET/PUT
// /api/settings, which keeps any key a newer client writes), so it follows them to another device like the accent does.
//
// Lists are one rail here, "Your lists": WHICH lists Home shows, and their order among themselves, stay the Lists page's
// choice (`settings.homeCollections`, lib/lists.ts homeIdsOf). The Customize sheet places the lists among the other
// rails and sends the reader to that page to choose them; it is never a second place to pick lists.
//
// ⚠️ The keys are stored. Rename one and every reader who moved or hid that rail loses the choice for it, silently, as
// if they had never chosen. A new rail gets a new key: `orderRails` puts a key the saved order has never heard of where
// HOME_RAILS puts it, so a rail added in a later release turns up on everyone's Home, shown, in its own place.
//
// Pure, so the rules are unit-tested (test/homeRails.test.ts) rather than looked for in a browser.
import { keys } from './i18n';

const LABELS = keys('Keep reading', 'For you', 'Because you read…', 'New episodes', 'Your favorites', 'Your lists',
  'Pick back up', 'Recently added', 'Most popular in your library', 'Hidden gems', 'Top 10 in your library');

/** Every rail Home can draw, in the owner's order. `label` is a keys() entry: rendered as tr(label). */
export const HOME_RAILS = [
  { key: 'continue', label: LABELS[0] },
  { key: 'forYou', label: LABELS[1] },
  { key: 'because', label: LABELS[2] },
  { key: 'newEpisodes', label: LABELS[3] },
  { key: 'favorites', label: LABELS[4] },
  { key: 'lists', label: LABELS[5] },
  { key: 'pickUp', label: LABELS[6] },
  { key: 'recentlyAdded', label: LABELS[7] },
  { key: 'popular', label: LABELS[8] },
  { key: 'gems', label: LABELS[9] },
  { key: 'top10', label: LABELS[10] },
] as const;

export type HomeRailKey = (typeof HOME_RAILS)[number]['key'];

export const HOME_RAIL_KEYS: ReadonlyArray<HomeRailKey> = HOME_RAILS.map((r) => r.key);

/** The rail Customize does not hide: the Lists page's choice of lists is what shows it or not (see above). */
export const LISTS_RAIL: HomeRailKey = 'lists';

/** One rail in a reader's arrangement. */
export interface RailSlot<K extends string = HomeRailKey> { key: K; hidden: boolean }

/** `settings.homeRails` as it is stored. */
export interface HomeRailsSetting { order: string[]; hidden: string[] }

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * A reader's arrangement: every default rail exactly once, in the saved order, each saying whether it is hidden.
 *
 * Tolerant of whatever the account holds, because it is free-form JSON that an older or a newer app may have written:
 *  - nothing saved, or something that is not an object: the defaults, all shown;
 *  - a key the defaults do not have (a rail since removed, a typo, a number): dropped, and so is a second copy of one;
 *  - a default the saved order does not have (a rail added since the reader chose): put back after the nearest rail that
 *    comes before it in the defaults and is placed already -- at the front when none is -- and shown.
 */
export function orderRails<K extends string>(saved: unknown, defaults: ReadonlyArray<K>): RailSlot<K>[] {
  const known = new Set<string>(defaults);
  const obj = saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
  const order: K[] = [];
  for (const k of strings(obj.order)) if (known.has(k) && !order.includes(k as K)) order.push(k as K);
  defaults.forEach((k, i) => {
    if (order.includes(k)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const p = order.indexOf(defaults[j]);
      if (p >= 0) { at = p + 1; break; }
    }
    order.splice(at, 0, k);
  });
  const hidden = new Set(strings(obj.hidden).filter((k) => known.has(k)));
  return order.map((key) => ({ key, hidden: hidden.has(key) }));
}

/** The keys Home draws, in order: the arrangement without its hidden rails. */
export function shownRails<K extends string>(saved: unknown, defaults: ReadonlyArray<K>): K[] {
  return orderRails(saved, defaults).filter((s) => !s.hidden).map((s) => s.key);
}

/** One rail a place earlier (`-1`) or later (`1`); the same arrangement at either end. */
export function moveRail<K extends string>(slots: ReadonlyArray<RailSlot<K>>, key: K, by: -1 | 1): RailSlot<K>[] {
  const next = [...slots];
  const from = next.findIndex((s) => s.key === key);
  const to = from + by;
  if (from < 0 || to < 0 || to >= next.length) return next;
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** One rail shown or hidden. */
export function setRailHidden<K extends string>(slots: ReadonlyArray<RailSlot<K>>, key: K, hidden: boolean): RailSlot<K>[] {
  return slots.map((s) => (s.key === key ? { ...s, hidden } : s));
}

/**
 * What to store for an arrangement: its whole order and its hidden rails, or `null` when it is exactly the defaults --
 * so a reader who puts everything back is a reader who never chose, and a rail added later lands in its own place
 * rather than wherever an old saved order would leave it.
 */
export function railsSetting<K extends string>(slots: ReadonlyArray<RailSlot<K>>, defaults: ReadonlyArray<K>): HomeRailsSetting | null {
  const plain = slots.length === defaults.length && slots.every((s, i) => s.key === defaults[i] && !s.hidden);
  if (plain) return null;
  return { order: slots.map((s) => s.key), hidden: slots.filter((s) => s.hidden).map((s) => s.key) };
}
