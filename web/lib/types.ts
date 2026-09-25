// Loose shapes for the Komga DTOs we consume (only the fields Uchiyomi uses).

export interface UchiyomiFlags {
  favorite: boolean;
  rating: number | null;
  unread?: number;
  newCount?: number;
}

export interface SeriesMetadata {
  title?: string;
  status?: string;
  summary?: string;
  readingDirection?: 'LEFT_TO_RIGHT' | 'RIGHT_TO_LEFT' | 'VERTICAL' | 'WEBTOON';
  author?: string;
  publisher?: string;
  genres?: string[];
  tags?: string[];
  ageRating?: number | null;
  language?: string;
}

/**
 * One place the updater asks about a series. The row it was added from is `primary`; the rest were followed
 * later from Find missing chapters, or by the add itself (`auto`, v0.36.0: the dialog's "Also check the
 * other sources" switch, judged server-side by the same 90 % rule). `registered` is false when the adapter
 * is no longer installed -- the row is kept so the choice survives a reinstall, but nothing can be fetched
 * from it meanwhile.
 */
export interface SeriesSource {
  sourceId: string;
  name: string;
  sourceSeriesId: string;
  primary: boolean;
  checkedAt: string | null;
  chapters: number | null;
  registered: boolean;
  /** Followed by the add, not by a person (`added_by IS NULL`). Absent from an older server. */
  auto?: boolean;
}

/**
 * One row of `GET /api/trackers` (bff/src/lib/trackers.ts `statusFor`): every provider the server knows,
 * connected or not, for the requesting person. `label` / `tokenHelp` come from the server so the UI never
 * hardcodes the provider list. The import page reads this to offer a tracker list; app/profile/page.tsx
 * keeps its own local copy of the same shape (its card predates this file's) -- left as it is rather than
 * widen the v0.36.0 change, and worth folding into this one when that page is next edited.
 */
export interface TrackerStatus {
  label?: string;
  tokenHelp?: string;
  provider: string;
  connected: boolean;
  accountName: string | null;
  expiresAt: string | null;
  expiringSoon: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
}

/**
 * Why a candidate source was or was not followed at add time. `followed` is the one good answer; the rest
 * are the server's reasons, each of which the dialog turns into a sentence (`autoFollowWhy` in
 * AddSeriesDialog.tsx) -- a code this list does not know is printed as-is so it is at least visible.
 */
export type FollowWhy = 'followed' | 'numbering_differs' | 'title_differs' | 'unreachable' | 'too_few_listed' | 'not_tried' | 'cap' | 'unavailable';

export interface AutoFollowResult {
  source: string;
  name: string;
  /** How the candidate source titles it, so a person can see the two sides of the match. */
  theirTitle: string | null;
  followed: boolean;
  /** Share of the primary listing's numbers the candidate also lists, 0..1; null when it was never compared. */
  coverage: number | null;
  why: FollowWhy;
}

/**
 * The add-time auto-follow, as it lands on the download job card (`GET /api/sources/jobs`). `done` flips once
 * every candidate has an answer; the dialog polls the card every 2 s anyway, and a closed dialog loses
 * nothing because the Sources & translations sheet shows whatever was followed.
 */
export interface AutoFollow {
  done: boolean;
  results: AutoFollowResult[];
}

/**
 * Which scanlation groups to prefer, which to refuse, and how long to hold a chapter for a preferred group.
 * `patienceDays: null` means "whatever the server default is"; 0 means take the best copy available now.
 * Stored per series as an override, or on the server as the default; the same shape in both places.
 */
export interface StoredPrefs {
  priority: string[];
  blocked: string[];
  patienceDays: number | null;
}

export interface Series {
  /** Whether the scheduled updater fetches new chapters for this series. */
  autoUpdate?: boolean;
  /** The folder on disk, relative to the library root. Only sent to admins, for the rename control. */
  folder?: string;
  id: string;
  libraryId: string;
  /** Whether an admin filed this series into that library by hand, rather than the folder rule doing it. */
  libraryPinned?: boolean;
  name: string;
  created?: string | null; // when the series entered the library
  booksCount: number;
  booksReadCount: number;
  booksUnreadCount: number;
  booksInProgressCount: number;
  metadata: SeriesMetadata;
  booksMetadata?: { summary?: string; genres?: string[]; tags?: string[] };
  color?: string | null;
  /**
   * What the updater's source said when it last asked. `null` means never asked, which is a different
   * thing from asked-and-nothing-new -- and `missing: null` inside it means asked and the source did not
   * answer, which is a third. The UI has to tell all three apart or it invents news.
   */
  source?: { missing: number | null; chapters: number | null; checkedAt: string } | null;
  yomi?: UchiyomiFlags;
  artVersion?: number; // bumps when an admin edits the cover/banner → cache-busts the image URLs
  overrides?: {
    title: string | null; summary: string | null; cover: string | null; banner: string | null;
    author: string | null; status: string | null; genres: string[] | null; ageRating: number | null;
    /** Let through the 18+ filter's genre rule (Admin → Settings → 18+ filter). Absent on older servers. */
    adultExempt?: boolean;
    /** The admin's reading direction for this series; null follows `detectedDirection`. Absent before v0.48.0. */
    readingDirection?: SeriesMetadata['readingDirection'] | null;
  };
  /**
   * Admins only (v0.48.0): what the evidence alone says about the reading direction, and which evidence --
   * the chapter's ComicInfo, the followed source, or AniList. null when nothing has said.
   */
  detectedDirection?: { direction: NonNullable<SeriesMetadata['readingDirection']>; from: 'comicinfo' | 'source' | 'anilist' | null } | null;
  /** Every source the updater asks for this series, primary first. Sent to every viewer. */
  sources?: SeriesSource[];
  /** This series' own scanlator overrides, or null when it follows the server defaults. Admins only. */
  scanlatorPrefs?: StoredPrefs | null;
  /** This series' own source order, most preferred first; null when the server-wide order applies. Admins only. */
  sourcePrefs?: { priority?: string[] } | null;
  /** Admins only: this series' own chapter-name borrowing switch; null follows the server setting. */
  borrowNames?: boolean | null;
  /** Admins only: whether names are borrowed for this series once the server setting is applied. */
  borrowNamesEffective?: boolean;
}

export interface ReadProgress {
  page: number;
  completed: boolean;
  readDate?: string;
  lastModified?: string;
}

export interface BookMetadata {
  title?: string;
  number?: string;
  numberSort?: number;
  summary?: string;
  releaseDate?: string;
}

export interface Book {
  id: string;
  /** where this book was last read, when that was another device (see /api/home) */
  lastDevice?: { id: string; name: string | null; at: string } | null;
  seriesId: string;
  seriesTitle: string;
  name: string;
  number: number;
  media: { pagesCount: number; mediaType?: string; status?: string };
  metadata: BookMetadata;
  readProgress?: ReadProgress | null;
  /** The group that released the copy on disk, as the source showed it. Null when the source did not say. */
  scanlator?: string | null;
  /** The adapter this copy was fetched from. Null for files that arrived any other way. */
  sourceId?: string | null;
  /**
   * The chapter's own name, as its source gave it ("The Return"), or null when it gave none. Never derived from
   * the filename: `name` and `metadata.title` are that, and on a library built by hand they are the file.
   */
  chapterName?: string | null;
  /**
   * The file was deleted by the server's read-chapter cleanup. The chapter is still part of the series and
   * still carries everyone's progress -- there are simply no pages behind it any more, and there will not
   * be again. Nothing may offer to open or download it.
   */
  pruned?: boolean;
  /**
   * The file lives under the downloads root, i.e. Uchiyomi fetched it and can fetch it again. Only these
   * may be deleted from the server or fetched again: a chapter in a library somebody assembled by hand is
   * theirs, not the updater's, and no button here may touch it.
   */
  owned?: boolean;
  /**
   * The 1-based numbers of the pages the source never served, when the chapter was saved short (v0.40.0:
   * at least 80 % of its pages arrived, so the file holds a flat placeholder at each of these). Null or
   * absent means the chapter is whole. The page COUNT is unchanged by construction -- a placeholder is a
   * real page in the archive -- so progress and bookmarks keep meaning what they meant; the sweep refills
   * the holes and clears this when the last one lands.
   */
  missingPages?: number[] | null;
}

/**
 * Why a chapter the sources list is not on this server.
 *   missing  nobody has asked for it yet (or the updater has not reached it)
 *   held     a preferred group has not released it and the patience window is still open
 *   blocked  every copy on offer is from a blocked group -- unblock first, it cannot be fetched
 *   failed   the downloader gave up on it (`attempts` says how many times)
 *   floor    below the series' Latest-N floor; Find missing chapters is the way to reach it
 */
export type GhostWhy = 'missing' | 'held' | 'blocked' | 'failed' | 'floor';

/** A chapter the sources list that has no row in the library: what the updater knows about it, as of its last check. */
export interface Ghost {
  number: number;
  title: string | null;
  publishedAt: string | null;
  /** The group of the copy the scanlator rules would take. Null when the source did not say. */
  scanlator: string | null;
  /** Every group that released this number, across every followed source. */
  groups: string[];
  sourceId: string;
  sourceName: string;
  why: GhostWhy;
  attempts?: number;
  /** The downloader's last error text. Admins only; absent for everyone else. */
  reason?: string;
  /**
   * Only on `held`: the preferred group the chapter is waiting for, and whole days of patience left. Absent
   * when no preferred group survives the blocklist (the caption then says "a preferred group") and on a
   * server older than v0.34.0.
   */
  waitingFor?: string;
  waitDaysLeft?: number;
  /**
   * The viewer marked this number read although the server does not hold it (#69). Only ever `true`; absent
   * for everyone with no mark on it, and on a server older than v0.43.0.
   */
  read?: boolean;
}

export interface Listing {
  /** When the updater last wrote this list, or null when it never has. Stale beats empty, so the age is shown. */
  checkedAt: string | null;
  content: Ghost[];
}

/** How often a group ships, read off the median gap of its last dated releases. `unknown` with fewer than two dates. */
export type CadenceKind = 'daily' | 'weekly' | 'monthly' | 'irregular' | 'unknown';
export interface Cadence {
  kind: CadenceKind;
  /** The median gap in days, or null when there were not enough dates to take one. */
  intervalDays: number | null;
  /** Days since the newest dated release, or null when none was dated. */
  daysSince: number | null;
  /** The group has gone quiet by its own standard: longer than three intervals (at least a fortnight), or 45 days. */
  quiet: boolean;
}

/**
 * One scanlation group's record on a series: what it released, how fast, and how much of it this server
 * holds. `chapters` is the group's numbers ascending; `first`/`last` are null when it released nothing dated
 * or numbered. Served by `GET /api/series/:id/groups` to any viewer, and by the admin scanlators route with
 * the prefs alongside.
 */
export interface GroupStat {
  name: string;
  releases: number;
  first: number | null;
  last: number | null;
  lastReleaseAt: string | null;
  cadence: Cadence;
  onDisk: number;
  chapters: number[];
  langs: string[];
  /**
   * Twelve flags, oldest week first, newest (this week) last: true when the group released in that week.
   * The activity strip is drawn from it. Absent from a server older than v0.34.0, in which case no strip.
   */
  weeks?: boolean[];
}

export interface SeriesGroups {
  checkedAt: string | null;
  content: GroupStat[];
}

/**
 * One copy of a chapter number as a source lists it. ⚠️ There is no `sourceId` field: `key` is
 * `${source}:${sourceId}` and a source id can itself contain `:` (`ext:fake`), so the id is recovered by
 * stripping the known `source` prefix (`copySourceId` in lib/groupFilter.ts), never by splitting on `:`.
 */
export interface VersionCopy {
  key: string;
  source: string;
  sourceName: string;
  groups: string[];
  scanlator: string | null;
  lang: string | null;
  pages: number | null;
  publishedAt: string | null;
  /** The copy the scanlator rules would take. */
  chosen: boolean;
  /** Every group of this copy is blocked by the effective prefs. Still fetchable by an explicit pick. */
  blocked: boolean;
  /** The file on this server for the number came from this copy. */
  onDisk: boolean;
}

export interface Versions {
  checkedAt: string | null;
  content: { number: number; copies: VersionCopy[] }[];
}

/** A group name the server has seen anywhere, with how busy it is: chapters on disk and numbers listed by the sources. */
export interface KnownGroup {
  name: string;
  onDisk: number;
  listed: number;
  series: number;
}

export interface PageInfo {
  number: number;
  /** Set by the server when this page recurs across chapters of the series -- a credit page, an advert. */
  junk?: boolean;
  /**
   * Set by the server when this page is a placeholder: the source never served it and the chapter was
   * saved short (`Book.missingPages`). The bytes behind it are a flat panel, so the reader draws the
   * explanation over it rather than letting a blank page read as a broken image.
   */
  missing?: true;
  fileName: string;
  mediaType: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
}

export interface Page<T> {
  content: T[];
  totalElements: number;
  totalPages: number;
  number: number;
  size: number;
  first: boolean;
  last: boolean;
}

/**
 * Admin -> Health (`GET /api/admin/health`), mirroring `bff/src/lib/health.ts`.
 *
 * These live here rather than in app/admin/page.tsx because HealthActions.tsx renders the chips and the
 * page mounts them: with the shapes declared in the page, the component would have had to import from a
 * Next route file that imports the component back, which is a cycle.
 */
export type HealthAction =
  | 'fix_short' | 'confirm_short' | 'delete' | 'fill' | 'retry'
  | 'test' | 'unblock' | 'disable' | 'merge' | 'solver_reset';

/** One step of the nightly repair (`bff/src/lib/repair.ts`), as `POST /api/admin/tasks/repair/run` takes it. */
export type RepairStep = 'solver' | 'count' | 'failures' | 'short' | 'gaps' | 'groups';

export interface HealthItem {
  seriesId?: string;
  /** Every series this item is about. The duplicates check needs both, so a merge can act on them. */
  seriesIds?: string[];
  titles?: string[];
  title: string;
  detail: string;
  /**
   * Listed for reference, never a reason to warn -- a source switched off, a short chapter the admin has
   * already confirmed. A check's status is decided by the items WITHOUT this flag, and they render dimmed.
   */
  info?: boolean;
  /** What an action acts ON: one chapter (short), several (impossible numbers), a source, a gap run. */
  bookId?: string;
  bookIds?: string[];
  number?: number;
  numbers?: number[];
  sourceId?: string;
  /** The duplicate pair's suggested survivor: the id inside `seriesIds` a merge should keep. */
  keep?: string;
  /** Which chips this item offers. Absent or empty means the item is a statement, not a task. */
  actions?: HealthAction[];
  /** Already dealt with, and when -- a confirmed-short chapter, a gap nobody lists. */
  fixed?: { at: string; what: string };
}

export interface HealthCheck {
  id: string;
  title: string;
  status: 'ok' | 'warn' | 'problem';
  /** one-line human summary, already pluralised */
  summary: string;
  /** what this check cannot see -- shown so nobody reads more into a green result than it deserves */
  note?: string;
  items: HealthItem[];
}

export interface HomePayload {
  onDeck: Book[];
  updated: Series[];
  new: Series[];
  favorites: Series[];
  updatesCount?: number;
}

export interface DownloadManifest {
  bookId: string;
  seriesId: string;
  seriesTitle: string;
  title: string;
  number: string;
  pageCount: number;
  readingDirection: SeriesMetadata['readingDirection'];
  mediaType: string | null;
  coverUrl: string;
  totalBytes: number;
  /** `missing` rides along like `junk`: the placeholder bytes download like any page, and the caption is drawn offline too. */
  pages: { number: number; url: string; width: number | null; height: number | null; bytes: number | null; junk?: boolean; missing?: true }[];
}

export function isWebtoon(dir?: string): boolean {
  return dir === 'WEBTOON' || dir === 'VERTICAL';
}
