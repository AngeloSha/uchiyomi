// Posting-order numbering (#116): when one source gives many DIFFERENT posts the same chapter number.
//
// The Webtoons extension numbers a post from the leftmost e / ep / episode / ch token in its title, and gives a
// title with no such token the previous number + 0.01f. Istrevelia's 226 posts ("Episode 1 - Page1 ", "EP 1 -
// 29-31", "E2 - 54-56", "Ee7 - 443-444") land on 13 numbers, 73 of them on 7; Apocalyptic Horseplay's 211
// ("CH1-EP1: Bible Study") land on 19, because the token it finds is the ARC. Uchiyomi identifies a chapter by
// its number -- one series_listing row, one `Chapter N.cbz`, one pick per number -- so every post after the
// first of each number became an interchangeable "version", and 226 posts read as 13 chapters.
//
// Sub-numbering the parts (N + p/100) was rejected on the real lists: the extension's own +0.01 rule already
// occupies N.01..N.0k, "E2 - 102-104" would parse to 3.02 and land inside episode 3, and a 73-post episode
// reaches N.5+, which trackers and floors read as the next episode. So a series this module flags is numbered
// by POSTING ORDER, 1..K -- what the extension's own "sequential chapter numbering" switch gives -- but STABLY:
// a number, once given, is persisted (series_post_numbers) and never recomputed, so a creator deleting post 50
// leaves a hole at 50 instead of renaming every file after it.
//
// Four pieces, each pure: no database, no clock, no adapter. The numbering service feeds them listings and
// stored rows and persists what they return.
//   * detectSharedNumbering: does this ONE source's listing number many distinct posts the same?
//   * postingSequence:       the posts, oldest first.
//   * assignPostingNumbers:  the stable numbers (first run 1..K; then tail max+1, inserts a midpoint, holes).
//   * planRenumber:          which file on disk is which post, and where each one moves.
import type { SourceChapter } from './sources/types';
import { groupsOf, normGroup } from './releases';
import { chapterName } from './naming';

/**
 * The detector's thresholds, measured against the real lists (test/fixtures/webtoons-posts.json) and against
 * the shapes it must NOT fire on. "Extras" are posts beyond the first on a number within one group: posts
 * minus stacks, where a stack is the posts sharing (number, group).
 *   Istrevelia: 226 posts, 13 stacks, 94 % extras, 73 posts under 73 names on 7.
 *   Apocalyptic Horseplay: 211 posts, 19 stacks, 91 % extras, 42 under 42 names on 7.
 *   MangaDex, three groups on every number: one stack per group, ~0 % extras.
 *   Uncredited 'Chapter 5' beside 'Chapter 5: The Return', or '[Server 1]' / '[Server 2]' mirrors posted the
 *   same day: stacks of two, which never reach STRONG and fail HINT's names or days.
 */
export const SHARED_NUMBERING = Object.freeze({
  /** Below this many posts nothing is judged: a short listing cannot tell a pattern from a coincidence. */
  MIN_POSTS: 12,
  /** STRONG: at least this share of the posts are extras... */
  STRONG_EXTRAS: 0.5,
  /** ...and one number carries at least this many posts... */
  STRONG_STACK: 5,
  /** ...under at least this many different names: re-uploads under one name are one post seen again. */
  STRONG_NAMES: 3,
  /** HINT (a warning, never a renumbering): at least this share of extras... */
  HINT_EXTRAS: 0.2,
  /** ...on at least this many numbers, each stack's posts all named apart... */
  HINT_STACKS: 3,
  /** ...and posted on at least this many different days: mirrors of one chapter go up together. */
  HINT_DAYS: 2,
});

/**
 * The comparison key for a chapter number: rounded to 1/1000. The extension adds 0.01 in float32, so its
 * chains come back as 7.01, 7.0200005, 7.0300007; an exact comparison would put 7.02 and 7.0200005 in two
 * stacks. No source numbers finer than a thousandth, and lib_books.number is a real that holds this exactly
 * enough to round-trip.
 */
export const numKey = (n: number): number => Math.round(n * 1000) / 1000;

// The extension appends " (ch. N)" to every post's name, and a note when the post has background music.
const CH_SUFFIX = /\s*\(ch\.\s*-?\d+(?:\.\d+)?\)\s*$/iu;
const MUSIC = /\s*♫\s*$/u;

/**
 * The title as a reader should see it once the post has its own number: without the extension's trailing
 * " (ch. N)" (which would contradict the new number, "Page 5-7 (ch. 1)" on chapter 5) and without '♫'.
 */
export function displayTitle(title: string | undefined | null): string {
  let t = (title ?? '').trim();
  // Either may come last, so strip twice.
  for (let i = 0; i < 2; i++) t = t.replace(MUSIC, '').replace(CH_SUFFIX, '');
  return t.trim();
}

const norm = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * What names a post apart from the other posts on its number: its title with the volume, chapter word and
 * number taken off (lib/naming.ts chapterName) and the extension's suffix stripped, NFKC and lower case. ''
 * when the title only said the number again -- and '' never counts as a distinct name, so 'Chapter 5' beside
 * 'Chapter 5: The Return' is one named post and one unnamed, not two chapters.
 */
export function nameKey(c: { title?: string; number: number }): string {
  return norm(chapterName(displayTitle(c.title), numKey(c.number)) ?? '');
}

/** The groups on a copy, as one key: sorted normGroup names, '' when the source names none. */
export const groupKey = (c: { scanlator?: string; groups?: string[] }): string =>
  groupsOf(c).map(normGroup).sort().join(',');

const isOrder = (o: unknown): o is number => typeof o === 'number' && Number.isFinite(o);
const timeOf = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const dayOf = (iso: string | null | undefined): string | null => {
  const t = timeOf(iso);
  return t == null ? null : new Date(t).toISOString().slice(0, 10);
};

export type SharedVerdict = 'strong' | 'hint' | 'none';

export interface SharedNumbering {
  /**
   * strong: number this series by posting order. hint: warn, and offer it. none: nothing to say. STRONG is
   * only ever given to a listing that says in what order its posts came (`ordered`); one that looks strong
   * but cannot say is a hint with reason 'no_order', because an inferred order is not something to rename
   * files by.
   */
  verdict: SharedVerdict;
  reason?: 'no_order';
  /** Every post carries the source's own posting position (`order`). */
  ordered: boolean;
  posts: number;
  /** Distinct numbers (numKey). */
  numbers: number;
  /** Distinct (number, group) pairs. */
  stacks: number;
  /** posts - stacks: the posts a one-number-one-chapter reading turns into versions. */
  extras: number;
  /** The number carrying the most posts, when any number carries more than one. */
  biggest: { number: number; posts: number } | null;
  /** Up to three titles from that number, oldest first, for the warning's "for example". */
  examples: string[];
}

/** Judge ONE source's listing. Never a union of sources: two sites both listing an unnamed 'Chapter 5' are versions. */
export function detectSharedNumbering(list: readonly SourceChapter[]): SharedNumbering {
  const posts = list.filter((c) => Number.isFinite(c.number));
  const stacks = new Map<string, SourceChapter[]>();
  for (const c of posts) {
    const key = `${numKey(c.number)}|${groupKey(c)}`;
    const s = stacks.get(key);
    if (s) s.push(c);
    else stacks.set(key, [c]);
  }
  const numbers = new Set(posts.map((c) => numKey(c.number))).size;
  const extras = posts.length - stacks.size;
  const ordered = posts.length > 0 && posts.every((c) => isOrder(c.order));
  const share = posts.length ? extras / posts.length : 0;
  const T = SHARED_NUMBERING;
  const all = [...stacks.values()];
  // Distinct NON-EMPTY names: an unnamed post never proves itself different from a named one.
  const names = (s: SourceChapter[]): number => new Set(s.map(nameKey).filter(Boolean)).size;
  // Mirrors of one chapter go up together; posts of one episode do not. Undated stacks cannot be judged by
  // day, and a hint only warns, so they are let through.
  const spread = (s: SourceChapter[]): boolean => {
    const days = new Set(s.map((c) => dayOf(c.publishedAt)).filter((d): d is string => d != null));
    return days.size >= T.HINT_DAYS || s.every((c) => timeOf(c.publishedAt) == null);
  };
  const enough = posts.length >= T.MIN_POSTS;
  const strongShape = enough && share >= T.STRONG_EXTRAS
    && all.some((s) => s.length >= T.STRONG_STACK && names(s) >= T.STRONG_NAMES);
  const hintShape = enough && share >= T.HINT_EXTRAS
    && all.filter((s) => s.length >= 2 && names(s) === s.length && spread(s)).length >= T.HINT_STACKS;

  let big: SourceChapter[] | null = null;
  for (const s of all) {
    if (!big || s.length > big.length || (s.length === big.length && numKey(s[0].number) < numKey(big[0].number))) big = s;
  }
  const biggest = big && big.length > 1 ? { number: numKey(big[0].number), posts: big.length } : null;
  const examples = biggest && big ? postingSequence(big).slice(0, 3).map((c) => displayTitle(c.title)) : [];

  const base = { ordered, posts: posts.length, numbers, stacks: stacks.size, extras, biggest, examples };
  if (strongShape) return ordered ? { verdict: 'strong', ...base } : { verdict: 'hint', reason: 'no_order', ...base };
  return { verdict: hintShape ? 'hint' : 'none', ...base };
}

/**
 * The posts oldest first. By the source's `order` when every post has one -- Suwayomi's sourceOrder, 1 = the
 * oldest -- turned round if the dates say the source counted from the newest. Otherwise by date, then number,
 * then the order the listing gave (undated posts after dated ones).
 */
export function postingSequence<T extends SourceChapter>(list: readonly T[]): T[] {
  const rows = list.map((c, i) => ({ c, i, t: timeOf(c.publishedAt) }));
  if (rows.length && rows.every((r) => isOrder(r.c.order))) {
    rows.sort((a, b) => (a.c.order as number) - (b.c.order as number) || a.i - b.i);
    // The direction guard: an engine whose order counts from the newest post would otherwise number the
    // latest post 1. Judged on the two ends that carry a date.
    const dated = rows.filter((r) => r.t != null);
    if (dated.length >= 2 && (dated[0].t as number) > (dated[dated.length - 1].t as number)) rows.reverse();
    return rows.map((r) => r.c);
  }
  rows.sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity) || a.c.number - b.c.number || a.i - b.i);
  return rows.map((r) => r.c);
}

/** A pseudo-post that reserves the slot of a book no post could be matched to (planRenumber's parked books). */
export const EXTRA_PREFIX = 'extra:';

/** One row of a stored assignment: series_post_numbers for one series and source. */
export interface PostNumber {
  postId: string;
  url?: string | null;
  /** The number Uchiyomi gave the post. */
  number: number;
  /** The number the source gives it. */
  sourceNumber?: number | null;
  title?: string | null;
  publishedAt?: string | null;
  /** No longer listed. The number stays reserved: a hole, never handed to another post (gone_at). */
  gone?: boolean;
}

export interface PostingAssignment<T> {
  /** The listing renumbered: number = the assigned one, sourceNumber = the source's, title = displayTitle. Ascending. */
  numbered: T[];
  /** The whole assignment to persist: every listed post, every hole and every reserved slot. */
  rows: PostNumber[];
  /** Posts numbered for the first time. */
  added: PostNumber[];
  /** Posts listed before and not now. */
  gone: PostNumber[];
  /** Posts found again by url or by title and day under a NEW id: the stored row's key moves to the new id. */
  rekeyed: Array<{ from: string; to: string }>;
  /** Inserted posts with no free number between their neighbours, appended at the end instead. */
  conflict?: Array<{ postId: string; after: number; before: number; number: number }>;
}

/** The first free number strictly between a and b: a + 0.5, then finer, to a thousandth. */
function freeBetween(a: number, b: number, taken: ReadonlySet<number>): number | undefined {
  for (let step = 0.5; step >= 0.001; step /= 2) {
    const n = numKey(a + step);
    if (n > a && n < b && !taken.has(n)) return n;
  }
  const last = numKey(a + 0.001);
  return last > a && last < b && !taken.has(last) ? last : undefined;
}

const titleDayKey = (title: string | null | undefined, publishedAt: string | null | undefined): string | null => {
  const day = dayOf(publishedAt);
  const t = norm(displayTitle(title));
  // No date, no match: two undated posts called "Q&A" are not provably the same post.
  return day && t ? `${t}|${day}` : null;
};

/**
 * Number a posting sequence, keeping every number already given.
 *
 * A post is the stored post it was before when it has the same id; failing that the same url (an engine that
 * re-created its rows hands out new ids); failing that the same title on the same day, when that pairs exactly
 * one stored post with one listed post. Then, walking the sequence oldest first:
 *   * a post seen before keeps its number;
 *   * a post with the same number and name as an EARLIER post but from a different group is a copy of it (a
 *     version) and shares its number; the same group always means a different post;
 *   * a new post after the last known one gets max + 1 (above every hole and reserved slot);
 *   * a new post between two known ones gets a free number between them (41.5, then 41.25, ...);
 *   * a stored post not listed any more keeps its number as a hole (`gone`), so nothing after it moves.
 * With nothing stored, that is simply 1..K.
 */
export function assignPostingNumbers<T extends SourceChapter>(seq: readonly T[], stored: readonly PostNumber[] = []): PostingAssignment<T> {
  const reserved = stored.filter((r) => r.postId.startsWith(EXTRA_PREFIX));
  const known = stored.filter((r) => !r.postId.startsWith(EXTRA_PREFIX));
  const matched: Array<PostNumber | undefined> = new Array(seq.length);
  const claimed = new Set<PostNumber>();
  const rekeyed: Array<{ from: string; to: string }> = [];
  const claim = (i: number, r: PostNumber) => {
    matched[i] = r;
    claimed.add(r);
    if (r.postId !== seq[i].sourceId) rekeyed.push({ from: r.postId, to: seq[i].sourceId });
  };

  const byId = new Map(known.map((r) => [r.postId, r]));
  seq.forEach((c, i) => {
    const r = byId.get(c.sourceId);
    if (r && !claimed.has(r)) claim(i, r);
  });
  // A url shared by two stored posts identifies neither.
  const byUrl = new Map<string, PostNumber | null>();
  for (const r of known) if (r.url) byUrl.set(r.url, byUrl.has(r.url) ? null : r);
  seq.forEach((c, i) => {
    if (matched[i] || !c.url) return;
    const r = byUrl.get(c.url);
    if (r && !claimed.has(r)) claim(i, r);
  });
  const storedByTitle = new Map<string, PostNumber[]>();
  for (const r of known) {
    if (claimed.has(r)) continue;
    const k = titleDayKey(r.title, r.publishedAt);
    if (k) storedByTitle.set(k, [...(storedByTitle.get(k) ?? []), r]);
  }
  const listedByTitle = new Map<string, number[]>();
  seq.forEach((c, i) => {
    if (matched[i]) return;
    const k = titleDayKey(c.title, c.publishedAt);
    if (k) listedByTitle.set(k, [...(listedByTitle.get(k) ?? []), i]);
  });
  for (const [k, idx] of listedByTitle) {
    const rs = storedByTitle.get(k);
    if (idx.length === 1 && rs?.length === 1) claim(idx[0], rs[0]);
  }

  const taken = new Set<number>(stored.map((r) => numKey(r.number)));
  let top = Math.max(0, ...stored.map((r) => numKey(r.number)));
  // The nearest KNOWN number after each position: the upper bound for a post inserted there.
  const nextKnown: Array<number | undefined> = new Array(seq.length);
  for (let i = seq.length - 1, next: number | undefined; i >= 0; i--) {
    nextKnown[i] = next;
    if (matched[i]) next = numKey(matched[i]!.number);
  }
  const slots = new Map<string, { number: number; groups: Set<string> }>();
  const numbers: number[] = new Array(seq.length);
  const added: PostNumber[] = [];
  const conflict: Array<{ postId: string; after: number; before: number; number: number }> = [];
  let prev = 0;
  seq.forEach((c, i) => {
    const slotKey = `${numKey(c.number)}|${nameKey(c)}`;
    const g = groupKey(c);
    const slot = slots.get(slotKey);
    let n: number;
    // A copy of an earlier post (a version) shares that post's number wherever it turns up in the walk.
    let version = false;
    if (matched[i]) {
      n = numKey(matched[i]!.number);
      if (!slot) slots.set(slotKey, { number: n, groups: new Set([g]) });
      else if (slot.number === n) { slot.groups.add(g); version = true; }
    } else {
      if (slot && !slot.groups.has(g)) {
        n = slot.number;
        slot.groups.add(g);
        version = true;
      } else {
        const before = nextKnown[i];
        let at = before === undefined ? Math.floor(top) + 1 : freeBetween(prev, before, taken);
        if (at === undefined) {
          at = Math.floor(top) + 1;
          conflict.push({ postId: c.sourceId, after: prev, before: before as number, number: at });
        }
        n = at;
        if (!slot) slots.set(slotKey, { number: n, groups: new Set([g]) });
      }
      added.push(rowOf(c, n));
    }
    taken.add(n);
    top = Math.max(top, n);
    numbers[i] = n;
    // A version says nothing about where the next new post goes: it joined an EARLIER post's number, wherever it
    // was posted. Moving `prev` back to it put a post inserted after a late copy just above the old number (2.5
    // beside chapter 2, not 9.5 between 9 and 10), for good, since numbers are never recomputed. ⚠️ Only a
    // version: a known post of its own that the listing now shows earlier (a6 re-dated between a2 and a3) does
    // say where the posts after it go. `prev = max(prev, n)` kept prev at 6 there, so a post inserted after a3
    // found no room below a4 and took the conflict path to the end of the series (11, not 3.5).
    if (!version) prev = n;
  });

  const rows: PostNumber[] = seq.map((c, i) => rowOf(c, numbers[i]));
  const gone: PostNumber[] = [];
  for (const r of known) {
    if (claimed.has(r)) continue;
    if (!r.gone) gone.push({ ...r, gone: true });
    rows.push({ ...r, gone: true });
  }
  rows.push(...reserved);
  const numbered = seq
    .map((c, i) => ({ c: { ...c, number: numbers[i], sourceNumber: c.number, title: displayTitle(c.title) || c.title } as T, i }))
    .sort((a, b) => a.c.number - b.c.number || a.i - b.i)
    .map((x) => x.c);
  return { numbered, rows, added, gone, rekeyed, ...(conflict.length ? { conflict } : {}) };
}

function rowOf(c: SourceChapter, n: number): PostNumber {
  return {
    postId: c.sourceId,
    url: c.url ?? null,
    number: n,
    sourceNumber: c.number,
    title: displayTitle(c.title) || c.title || null,
    publishedAt: c.publishedAt ?? null,
    gone: false,
  };
}

// ---- planRenumber ------------------------------------------------------------------------------------------

/**
 * posting_order: the files are at the source's numbers and move to posting numbers.
 * source:        the undo; the files are at posting numbers and go back to the source's.
 * remap:         the source changed its own numbers under the files (an extension preference flipped).
 */
export type RenumberMode = 'posting_order' | 'source' | 'remap';

/**
 * How a book was matched to its post, strongest first. id: the file's own stamp (lib_books.source_chapter_id).
 * pick: the audited Replace… that wrote it. stored: the exact stored mapping (the undo). name: its chapter
 * name, filename or title against the post's. date: its release date. listing: only that the old
 * series_listing chose that post for its number.
 *
 * date and listing are guesses, so a plan that needs either is not applied unattended (reason 'listing_only').
 * ⚠️ A date is the listing's pick again, not the file's: every sweep re-stamps lib_books.published_at with the
 * date of whichever copy the listing picks for that number (updater.ts -> library.ts setBookDates), and that
 * pick can move while the file does not. It may still CHOOSE a post -- it is right more often than not -- but
 * it is no better evidence than the listing it came from.
 */
export type MatchHow = 'id' | 'pick' | 'stored' | 'name' | 'date' | 'listing';
const EXACT: ReadonlySet<MatchHow> = new Set(['id', 'pick', 'stored', 'name']);

/** A lib_books row, as far as matching it needs. */
export interface PlanBook {
  id: string;
  /** lib_books.root: the library root the file lives in. */
  root: string;
  /** lib_books.file: where it is now. */
  file: string;
  /** lib_books.number: the RAW number, the filename's -- never the override. */
  number: number;
  title?: string | null;
  chapterName?: string | null;
  /**
   * lib_books.chapter_name_source: set when `chapterName` was BORROWED from another source (lib/borrowNames.ts).
   * A borrowed name was matched to that source's chapter by number alone, so it says nothing about which of
   * this source's posts the file is, and the name pass does not read it.
   */
  chapterNameSource?: string | null;
  publishedAt?: string | null;
  /** The post the file was downloaded from, when the landing stamped it. */
  sourceChapterId?: string | null;
  /** A Replace… wrote another copy's pages under this number's title and date, so neither says which post it is. */
  pickedAt?: string | null;
  /** A tombstone: the file is gone, the row (and its read history) stays and moves with the numbering. */
  pruned?: boolean;
}

/** A post in the numbering the books move TO. */
export interface PlanPost {
  postId: string;
  /** The number the post has in the target numbering. */
  number: number;
  /**
   * The post's number in the numbering the books are in NOW: the source's for 'posting_order', the posting
   * number for 'source'. Unknown for 'remap', where the old listing (ctx.listing) supplies it where it can.
   */
  from?: number | null;
  title?: string | null;
  publishedAt?: string | null;
}

/** Where the books go: the mode, and every post of the numbering they move to -- holes and reserved slots included. */
export interface RenumberTarget {
  mode: RenumberMode;
  posts: readonly PlanPost[];
}

export interface PlanContext {
  /** Audited Replace… picks (audit_log 'series.chapters_refetch' detail.picks): book id -> post id. */
  picks?: ReadonlyMap<string, string>;
  /** The series_listing as it is: numKey(number) -> the chosen copy's post id. */
  listing?: ReadonlyMap<number, string>;
  /** Several posts landing on one number: numKey(number) -> the post the chooser keeps at `Chapter N.cbz`. */
  keep?: ReadonlyMap<number, string>;
  /** chapter_floor now; null or absent for none. */
  floor?: number | null;
  /** Can the server rename in this root? A book in a root it cannot is moved by book_overrides instead. */
  writable?: (root: string) => boolean;
  /** The series is linked to a tracker: a renumber would push numbers to it, which cannot be taken back. */
  tracker?: boolean;
  /** A download is running for the folder. */
  busy?: boolean;
}

export interface PlanMove {
  bookId: string;
  root: string;
  from: number;
  to: number;
  fromFile: string;
  /** The file after the move (unchanged for 'override' and 'none'). */
  file: string;
  /** rename: on disk and in lib_books. row: a tombstone, lib_books only. override: book_overrides.number. none: nothing changes. */
  via: 'rename' | 'row' | 'override' | 'none';
  /** Absent on a parked book. */
  how?: MatchHow;
  postId?: string;
  /** The post's title, for the plan's "Chapter 2 → Chapter 20 · E2 - 54-56". */
  title?: string | null;
}

/**
 * Why a plan waits for an admin. unmatched: a book no post could be matched to is parked. listing_only: a book
 * was matched only by a guess, its date or the old listing's pick (MatchHow). collision: books share a number
 * in one root. tracker: the renumber would push numbers to a tracker. busy: a download is running for it.
 */
export type PlanReason = 'unmatched' | 'listing_only' | 'collision' | 'tracker' | 'busy';

export interface RenumberPlan {
  mode: RenumberMode;
  moves: PlanMove[];
  /** Books no post could be matched to, each put at a free number just after its nearest matched predecessor. */
  parked: PlanMove[];
  /** Books that land on one number in one root. Each keeps its file: the chooser's post plainly, the rest `(2)`, `(3)`. */
  collisions: Array<{ root: string; number: number; bookIds: string[] }>;
  /** Safe to apply with nobody watching. */
  clean: boolean;
  reasons: PlanReason[];
  /** chapter_floor in the new numbering, so 'Latest N' and 'Nothing yet' keep meaning the same posts. */
  newFloor: number | null;
  /** Old number -> new number, for listing_progress marks (a mark with no entry cannot be mapped). */
  markMap: Array<[number, number]>;
  /** posting_order only: the pseudo-posts that reserve the parked books' numbers. */
  extras: PostNumber[];
}

/**
 * The file a book is renamed to: `Chapter <n>.cbz` beside where it is now -- downloader.ts chapterFileRel's
 * name, so the scanner reads the same number back -- keeping its own extension (a .cbr stays a .cbr). `k` > 1
 * is the second, third... book on one number: `Chapter 7 (2).cbz`, whose first number is still 7.
 */
export function renumberedFile(file: string, n: number, k = 1): string {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  const dir = file.slice(0, cut + 1);
  const base = file.slice(cut + 1);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot) : '';
  return `${dir}Chapter ${n}${k > 1 ? ` (${k})` : ''}${ext}`;
}

const baseName = (file: string): string => {
  const b = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
  const dot = b.lastIndexOf('.');
  return dot > 0 ? b.slice(0, dot) : b;
};

/**
 * A file's own name for itself: its base name without renumberedFile's collision rank. `Chapter 5 (2)` is the
 * second book on 5, and '(2)' is Uchiyomi's count, not something the file or its post says -- read as a name,
 * it matched a post titled 'Chapter 5 (2)' (a two-part episode on Webtoons) by 'name', and the plan read clean.
 */
const ownName = (file: string): string => baseName(file).replace(/ \(\d+\)$/, '');

/** A name, as written and with its number taken off, both normalised; '' dropped. */
function forms(name: string | null | undefined, n: number): string[] {
  const t = displayTitle(name);
  if (!t) return [];
  return [...new Set([norm(t), norm(chapterName(t, numKey(n)) ?? '')])].filter(Boolean);
}

/**
 * forms(), but only for a name that says more than the number. The downloader names every file `Chapter N`
 * and the scanner's title is the filename's, so for a book with no chapter name both only repeat its number
 * -- and a post literally titled 'Chapter N' would match them by 'name' when all that agreed was the number.
 */
function namedForms(name: string | null | undefined, n: number): string[] {
  return chapterName(displayTitle(name), numKey(n)) == null ? [] : forms(name, n);
}

/**
 * Match every book on disk to its post and say where each moves. Evidence is taken strongest first across
 * all books -- every stamp before any name, every name before any date -- so a weak guess never takes a post
 * that a stronger one needed. A post goes to at most one book per root.
 *
 * Candidates: for 'posting_order' the posts whose SOURCE number is the book's number (only they can be the
 * file written for it); for 'source' the posts at the book's posting number; for 'remap' every post, since
 * the source renumbered them all.
 *
 * A book an admin replaced with Replace… (`pickedAt` with no audited pick) carries the number's title and date
 * over another copy's pages, so its name and date are not evidence; it falls through to the listing.
 */
export function planRenumber(books: readonly PlanBook[], target: RenumberTarget, ctx: PlanContext = {}): RenumberPlan {
  const { mode, posts } = target;
  const byId = new Map(posts.map((p) => [p.postId, p]));
  const bookById = new Map(books.map((b) => [b.id, b]));
  const oldOf = new Map<string, number>();
  for (const p of posts) if (p.from != null && Number.isFinite(p.from)) oldOf.set(p.postId, numKey(p.from));
  if (ctx.listing) for (const [n, id] of ctx.listing) if (!oldOf.has(id) && byId.has(id)) oldOf.set(id, numKey(n));

  const order = [...books].sort((a, b) => a.number - b.number || a.file.localeCompare(b.file));
  const candidates = (b: PlanBook): PlanPost[] =>
    mode === 'remap' ? [...posts] : posts.filter((p) => p.from != null && numKey(p.from) === numKey(b.number));
  const taken = new Map<string, Set<string>>(); // root -> post ids claimed there
  const free = (b: PlanBook, p: PlanPost | undefined): p is PlanPost => !!p && !taken.get(b.root)?.has(p.postId);
  const found = new Map<string, { post: PlanPost; how: MatchHow }>();
  const take = (b: PlanBook, post: PlanPost, how: MatchHow) => {
    found.set(b.id, { post, how });
    if (!taken.has(b.root)) taken.set(b.root, new Set());
    taken.get(b.root)!.add(post.postId);
  };
  const pass = (how: MatchHow, pick: (b: PlanBook) => PlanPost | undefined) => {
    for (const b of order) {
      if (found.has(b.id)) continue;
      const p = pick(b);
      if (free(b, p)) take(b, p, how);
    }
  };
  const unique = (list: PlanPost[]): PlanPost | undefined => (list.length === 1 ? list[0] : undefined);
  const untrusted = (b: PlanBook) => !!b.pickedAt && !ctx.picks?.has(b.id);
  // A post's name forms depend on the post alone; a remap compares every book with every post.
  const formCache = new Map<PlanPost, string[]>();
  const formsOf = (p: PlanPost): string[] => {
    let f = formCache.get(p);
    if (!f) formCache.set(p, (f = forms(p.title, p.from ?? oldOf.get(p.postId) ?? p.number)));
    return f;
  };

  pass('id', (b) => byId.get(EXTRA_PREFIX + b.id) ?? (b.sourceChapterId ? byId.get(b.sourceChapterId) : undefined));
  pass('pick', (b) => { const id = ctx.picks?.get(b.id); return id ? byId.get(id) : undefined; });
  // The undo's mapping is exact. Two candidates on one posting number are two groups' copies of one post
  // (assignPostingNumbers joined them), so they go back to the same source number whichever the book is.
  if (mode === 'source') pass('stored', (b) => {
    const open = candidates(b).filter((p) => free(b, p));
    if (!open.length || new Set(open.map((p) => numKey(p.number))).size !== 1) return undefined;
    const chosen = ctx.listing?.get(numKey(b.number));
    return open.find((p) => p.postId === chosen) ?? open[0];
  });
  pass('name', (b) => {
    if (untrusted(b)) return undefined;
    const open = candidates(b).filter((p) => free(b, p));
    const hits = (mine: string[]) => open.filter((p) => formsOf(p).some((f) => mine.includes(f)));
    // Its own chapter name first (never a borrowed one); the filename and title only when the name found
    // nothing, and only when they name more than the number. Two hits is an ambiguity, not a license to try
    // a weaker spelling.
    const byName = hits(b.chapterNameSource ? [] : forms(b.chapterName, b.number));
    if (byName.length) return unique(byName);
    // The scanner's title is the filename's, collision rank and all, so a title that IS the file name loses it too.
    const file = ownName(b.file);
    const title = b.title?.trim() === baseName(b.file) ? file : b.title;
    return unique(hits([...namedForms(title, b.number), ...namedForms(file, b.number)]));
  });
  pass('date', (b) => {
    if (untrusted(b)) return undefined;
    const t = timeOf(b.publishedAt);
    if (t == null) return undefined;
    const open = candidates(b).filter((p) => free(b, p));
    const same = open.filter((p) => timeOf(p.publishedAt) === t);
    if (same.length) return unique(same);
    return unique(open.filter((p) => dayOf(p.publishedAt) === dayOf(b.publishedAt)));
  });
  pass('listing', (b) => {
    const id = ctx.listing?.get(numKey(b.number));
    const p = id ? byId.get(id) : undefined;
    return p && candidates(b).includes(p) ? p : undefined;
  });

  // Park what is left just after the nearest matched book below it, at a number no post and no other
  // parked book holds.
  const slots = new Set<number>(posts.map((p) => numKey(p.number)));
  let top = Math.max(0, ...posts.map((p) => numKey(p.number)));
  const parkedAt = new Map<string, number>();
  let lastTo = 0;
  for (const b of order) {
    const f = found.get(b.id);
    if (f) { lastTo = numKey(f.post.number); continue; }
    const above = [...slots].filter((n) => n > lastTo).sort((x, y) => x - y)[0] ?? Infinity;
    const at = freeBetween(lastTo, above, slots) ?? Math.floor(top) + 1;
    parkedAt.set(b.id, at);
    slots.add(at);
    top = Math.max(top, at);
    lastTo = at;
  }

  const writable = ctx.writable ?? (() => true);
  const moveOf = (b: PlanBook, to: number, how?: MatchHow, post?: PlanPost): PlanMove => {
    const from = numKey(b.number);
    const override = !writable(b.root) && !b.pruned;
    // An unchanged number leaves the file alone, whatever it is called.
    const via: PlanMove['via'] = to === from ? 'none' : override ? 'override' : b.pruned ? 'row' : 'rename';
    return {
      bookId: b.id, root: b.root, from, to, fromFile: b.file,
      file: via === 'rename' || via === 'row' ? renumberedFile(b.file, to) : b.file,
      via, ...(how ? { how, postId: post!.postId, title: post!.title ?? null } : {}),
    };
  };
  const moves: PlanMove[] = [];
  const parked: PlanMove[] = [];
  for (const b of order) {
    const f = found.get(b.id);
    if (f) moves.push(moveOf(b, numKey(f.post.number), f.how, f.post));
    else parked.push(moveOf(b, parkedAt.get(b.id)!));
  }

  // Books landing on one number in one root: the chooser's post keeps the plain name, the rest take (2),
  // (3)... in posting order, so every file is kept and each still reads back as N.
  const collisions: RenumberPlan['collisions'] = [];
  const groups = new Map<string, PlanMove[]>();
  for (const m of [...moves, ...parked]) {
    if (m.via === 'override') continue;
    const key = `${m.root}\u0000${m.to}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keep = ctx.keep?.get(group[0].to);
    const rank = (m: PlanMove) => (m.postId && m.postId === keep ? -Infinity : m.postId ? (oldOf.get(m.postId) ?? byId.get(m.postId)?.number ?? Infinity) : Infinity);
    group.sort((a, b) => rank(a) - rank(b) || a.from - b.from || a.fromFile.localeCompare(b.fromFile));
    group.forEach((m, k) => {
      if (k === 0) return;
      m.file = renumberedFile(m.fromFile, m.to, k + 1);
      if (m.via === 'none') m.via = bookById.get(m.bookId)?.pruned ? 'row' : 'rename';
    });
    collisions.push({ root: group[0].root, number: group[0].to, bookIds: group.map((m) => m.bookId) });
  }
  // Whatever still shares a path (an override keeps its old file) cannot be applied as planned.
  const paths = new Map<string, string[]>();
  for (const m of [...moves, ...parked]) {
    const key = `${m.root}\u0000${m.file}`;
    paths.set(key, [...(paths.get(key) ?? []), m.bookId]);
  }
  for (const [key, ids] of paths) {
    if (ids.length < 2) continue;
    const [root] = key.split('\u0000');
    const m = [...moves, ...parked].find((x) => x.bookId === ids[0])!;
    if (!collisions.some((c) => c.root === root && c.number === m.to)) collisions.push({ root, number: m.to, bookIds: ids });
  }

  // chapter_floor: the first post at or above the old floor. Above everything ('Nothing yet', max + 0.001)
  // stays above everything.
  let newFloor: number | null = null;
  if (ctx.floor != null && Number.isFinite(ctx.floor)) {
    const f = numKey(ctx.floor);
    const at = posts.filter((p) => oldOf.has(p.postId) && oldOf.get(p.postId)! >= f).map((p) => numKey(p.number));
    newFloor = at.length ? Math.min(...at) : numKey(Math.max(0, ...posts.map((p) => numKey(p.number)), ...parked.map((m) => m.to)) + 0.001);
  }

  // Marks: a book's own move first, then the post the listing chose for that number, then the first post
  // that had it.
  const marks = new Map<number, number>();
  for (const m of [...moves, ...parked]) if (!marks.has(m.from)) marks.set(m.from, m.to);
  if (ctx.listing) {
    for (const [n, id] of ctx.listing) {
      const p = byId.get(id);
      if (p && !marks.has(numKey(n))) marks.set(numKey(n), numKey(p.number));
    }
  }
  for (const p of [...posts].sort((a, b) => a.number - b.number)) {
    const old = oldOf.get(p.postId);
    if (old != null && !marks.has(old)) marks.set(old, numKey(p.number));
  }

  const reasons: PlanReason[] = [];
  if (parked.length) reasons.push('unmatched');
  if (moves.some((m) => !EXACT.has(m.how!))) reasons.push('listing_only');
  if (collisions.length) reasons.push('collision');
  if (ctx.tracker) reasons.push('tracker');
  if (ctx.busy) reasons.push('busy');

  const extras: PostNumber[] = mode !== 'posting_order' ? [] : parked.map((m) => {
    const b = bookById.get(m.bookId)!;
    return {
      postId: EXTRA_PREFIX + b.id, url: null, number: m.to, sourceNumber: numKey(b.number),
      title: displayTitle(b.chapterName ?? b.title) || null, publishedAt: b.publishedAt ?? null, gone: false,
    };
  });

  return {
    mode, moves, parked, collisions, clean: reasons.length === 0, reasons, newFloor,
    markMap: [...marks].sort((a, b) => a[0] - b[0]), extras,
  };
}
