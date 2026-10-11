// The Library's orders (v0.60.0): one Sort menu in the toolbar where nine sort chips used to sit in the filter panel.
//
// The owner's ask was "think how we can make the library look better UX-wise", and nine capsules above the filters --
// four orders from before v0.58.0 and the five it added -- were the loudest thing on the shelf while saying nothing about
// which way each one ran. So the orders are grouped the way a reader thinks of them (what happened lately, what people
// think of it, how big it is, its name), one key shows the one in force, and every order can run the other way: the
// server has always read `field,asc|desc` for each of them (bff lib/ownedCatalog.ts sortSql), with a series that has no
// value -- no AniList link, never rated, never read -- after the rest in either direction.
//
// Pure, so the precedence and the flipping are unit-tested (test/v600Library.test.ts) rather than looked for in a browser.
import { keys } from './i18n';

export type SortDir = 'asc' | 'desc';

const SORT_LABELS = keys('Updated', 'Newest', 'A–Z', 'Most unread', 'Most popular', 'Top rated', 'My rating', 'Most chapters', 'Recently read');
const GROUP_LABELS = keys('Activity', 'Ratings', 'Size', 'Name');
/**
 * What the Order switch says, per kind of value: a time runs newest to oldest, a score high to low, an amount most to
 * fewest, a name A to Z. Words that say which end comes first, never "ascending", which nobody outside a database says.
 */
const DIR_LABELS = keys('Newest first', 'Oldest first', 'High to low', 'Low to high', 'Most first', 'Fewest first', 'A–Z', 'Z–A');
const WORDS = {
  time: { desc: DIR_LABELS[0], asc: DIR_LABELS[1] },
  score: { desc: DIR_LABELS[2], asc: DIR_LABELS[3] },
  amount: { desc: DIR_LABELS[4], asc: DIR_LABELS[5] },
  name: { asc: DIR_LABELS[6], desc: DIR_LABELS[7] },
} as const;

export interface LibrarySort {
  /** The URL's `sort` and the account's `librarySort`. */
  key: string;
  /** A keys() entry: rendered as tr(label). */
  label: string;
  /** The server's sort string, in the order's natural direction. */
  sort: string;
  /** Its group in the menu: an index into SORT_GROUPS. */
  group: number;
  /** Which words its two directions go by. */
  words: keyof typeof WORDS;
}

/**
 * The nine orders, in the menu's order: Activity (Updated, Recently read, Newest), Ratings (Most popular, Top rated, My
 * rating), Size (Most chapters, Most unread), Name (A–Z). Updated stays first: it is the default, and `SORTS[0]` the
 * page's fallback for anything it does not know.
 */
export const SORTS: ReadonlyArray<LibrarySort> = [
  { key: 'updated', label: SORT_LABELS[0], sort: 'lastModified,desc', group: 0, words: 'time' },
  // v0.58.0: AniList's popularity (how many people there have it on a list) and average score, the reader's own stars,
  // the chapter count and their last read -- each card then says the value it is sorted by (lib/sortValue.ts), and a
  // series without one sorts after the rest. A server older than v0.58.0 sorts an order it does not know by title.
  { key: 'read', label: SORT_LABELS[8], sort: 'lastRead,desc', group: 0, words: 'time' },
  { key: 'new', label: SORT_LABELS[1], sort: 'createdDate,desc', group: 0, words: 'time' },
  { key: 'popular', label: SORT_LABELS[4], sort: 'popularity,desc', group: 1, words: 'score' },
  { key: 'score', label: SORT_LABELS[5], sort: 'score,desc', group: 1, words: 'score' },
  { key: 'rating', label: SORT_LABELS[6], sort: 'rating,desc', group: 1, words: 'score' },
  { key: 'chapters', label: SORT_LABELS[7], sort: 'chapters,desc', group: 2, words: 'amount' },
  // per-user unread is expressible server-side, so the label can say what it does
  { key: 'unread', label: SORT_LABELS[3], sort: 'unread,desc', group: 2, words: 'amount' },
  { key: 'az', label: SORT_LABELS[2], sort: 'metadata.titleSort,asc', group: 3, words: 'name' },
];
// ⚠️ NO "RANDOM" ORDER, EVEN THOUGH THE SERVER HAS ONE. `sortSql()` maps it to `ORDER BY random()` (ownedCatalog.ts),
// and the grid pages through `LIMIT/OFFSET` with `useInfiniteQuery` APPENDING each page. A fresh shuffle per page means
// page 2 re-draws series already scrolled past and silently omits others, and it looks like it works -- you would have
// to count to notice. Randomness that belongs to a whole shelf cannot be served one window at a time. "Surprise me" in
// the toolbar is the honest version: one series, one request, no pagination. See library.test.ts, which fails if this
// comes back.

/** The menu's groups, each with its orders, in order. */
export const SORT_GROUPS: ReadonlyArray<{ label: string; sorts: LibrarySort[] }> =
  GROUP_LABELS.map((label, i) => ({ label, sorts: SORTS.filter((s) => s.group === i) }));

export const validDir = (v: unknown): v is SortDir => v === 'asc' || v === 'desc';

/** The direction an order runs in by itself: its sort string's suffix. */
export const naturalDir = (s: Pick<LibrarySort, 'sort'>): SortDir => (/,desc$/i.test(s.sort) ? 'desc' : 'asc');

/** The server's sort string for `s` run in `dir`: its field, with the direction the reader chose. */
export const sortString = (s: Pick<LibrarySort, 'sort'>, dir: SortDir): string => `${s.sort.split(',')[0]},${dir}`;

/**
 * The direction the shelf runs in, by the same precedence as the order itself: the URL's `dir` for this visit; else the
 * direction the account saved; else the order's natural one. `account` is the saved direction only while the order IS
 * the account's -- the page passes nothing when the URL names an order, because a shared `?sort=popular` with no `dir`
 * means Most popular as it reads, not in whichever direction the reader last ran their own default.
 */
export function sortDirOf(s: Pick<LibrarySort, 'sort'>, url: unknown, account: unknown): SortDir {
  if (validDir(url)) return url;
  if (validDir(account)) return account;
  return naturalDir(s);
}

/** The Order switch's two choices for `s`, its natural direction first: [direction, keys() label]. */
export function dirChoices(s: Pick<LibrarySort, 'sort' | 'words'>): [SortDir, string][] {
  const w = WORDS[s.words];
  const first = naturalDir(s);
  const other: SortDir = first === 'desc' ? 'asc' : 'desc';
  return [[first, w[first]], [other, w[other]]];
}

/** What `dir` is called for `s` ("Low to high", "Z–A", "Oldest first"): the active chip's and the key's name for it. */
export const dirLabel = (s: Pick<LibrarySort, 'sort' | 'words'>, dir: SortDir): string => WORDS[s.words][dir];
