// The wire shapes of the Komga-compatible API (routes/komgaCompat.ts): what a Kotlin client REQUIRES.
//
// Both clients decode with kotlinx.serialization under `Json { ignoreUnknownKeys = true; explicitNulls = false }`
// (upstream mihon/app/src/main/java/mihon/app/di/AppBindings.kt @424bbc53), and `coerceInputValues` is off. The
// consequence that shapes this whole file: an extra key is ignored, but a MISSING non-nullable field, or a JSON
// `null` where the Kotlin type is not nullable, throws -- and one bad row fails the decode of the entire list
// it sits in. There is no partial page. So every DTO here is padded with every field the Kotlin classes
// declare without a default, whether or not either client reads it, and every string that could be null
// upstream of us is coalesced.
//
// The authorities, quoted by line where a shape matters (re-derived with `cat -n` on the clones):
//   keiyoushi extension  src/all/komga/.../dto/Dto.kt, dto/PageWrapperDto.kt      @9137b65d (versionCode 70)
//   Mihon tracker        app/.../data/track/komga/KomgaModels.kt                   @424bbc53
//   Komga itself         komga/.../interfaces/api/rest/dto/{SeriesDto,BookDto}.kt  @7f718087 (date patterns)
//
// Pure: no database, no env. komgaContract.test.ts pins the required-field lists against this module directly,
// and the padders take the DTOs `owned.*` in lib/ownedCatalog already produces rather than raw rows, so the
// override-aware title/number/visibility rules stay in the one place they live.

// ---- dates -------------------------------------------------------------------------------------------------

/**
 * `yyyy-MM-ddTHH:mm:ss`, UTC, no zone letter, no millis. Never null.
 *
 * Since extension versionCode 69 the chapter date is parsed STRICTLY: `DateTimeFormatter.ofPattern
 * ("yyyy-MM-dd'T'HH:mm:ss")` through `LocalDateTime.parse` (KomgaUtils.kt L14, L18; core Date.kt L59-71
 * returns 0 on any failure). A trailing `Z` or a `.123` millisecond part is unparsed trailing text, so the
 * ISO string `Date#toISOString` produces would silently make every chapter "uploaded" at the epoch. Real Komga
 * emits `yyyy-MM-dd'T'HH:mm:ss'Z'` (Komga SeriesDto.kt L12-17, BookDto.kt L18-23) and pays exactly that price
 * with the new parser; we drop the Z so the date survives.
 *
 * The epoch fallback is for the REQUIRED fields (`fileLastModified`, `booksMetadata.created`): a Kotlin
 * `String` may not be null, and "we do not know when" has to be spelled as some date. The nullable fields go
 * through `komgaDateOrNull` instead.
 */
export function komgaDate(d: Date | string | number | null | undefined): string {
  return komgaDateOrNull(d) ?? '1970-01-01T00:00:00';
}

export function komgaDateOrNull(d: Date | string | number | null | undefined): string | null {
  const t = instant(d);
  if (t === null) return null;
  // Slice rather than format by hand: toISOString is always `YYYY-MM-DDTHH:mm:ss.sssZ` for years 0..9999.
  return new Date(t).toISOString().slice(0, 19);
}

/**
 * `yyyy-MM-dd` (UTC) or null, for `releaseDate`. Parsed with `LocalDate.parse` under `ofPattern("yyyy-MM-dd")`
 * (KomgaUtils.kt L13, L16), so a time part is trailing text and would zero the date. Nullable in both Kotlin
 * DTOs (Dto.kt L78, L161), and the extension prefers it over `created` when present (Komga.kt L289-298), so a
 * chapter with no known date must say null here rather than an epoch day.
 */
export function komgaDay(d: Date | string | number | null | undefined): string | null {
  const t = instant(d);
  return t === null ? null : new Date(t).toISOString().slice(0, 10);
}

/** Epoch ms, or null for nothing/unparseable/0 (0 is what lib_books.mtime holds when nobody stamped it). */
function instant(d: Date | string | number | null | undefined): number | null {
  if (d === null || d === undefined || d === '') return null;
  const t = d instanceof Date ? d.getTime() : typeof d === 'number' ? d : new Date(d).getTime();
  if (!Number.isFinite(t) || t <= 0) return null;
  // Beyond what toISOString can print (year > 9999) is a corrupt stamp, not a date.
  if (Math.abs(t) > 8.64e15) return null;
  return t;
}

// ---- the Spring page envelope ------------------------------------------------------------------------------

export interface SpringPage<T> {
  content: T[];
  empty: boolean;
  first: boolean;
  last: boolean;
  number: number;
  numberOfElements: number;
  size: number;
  totalElements: number;
  totalPages: number;
}

/** Komga (Spring) refuses pages larger than this; the same cap keeps `size=999999` from being a full scan. */
export const PAGE_SIZE_MAX = 500;
export const PAGE_SIZE_DEFAULT = 20;

/**
 * All NINE keys of the extension's `PageWrapperDto` (PageWrapperDto.kt L8-19), every one required.
 * lib/ownedCatalog's own `page()` lacks `empty` and `numberOfElements`, which is why it is not reused.
 *
 * `page` is clamped to >= 0 and `size` to 1..PAGE_SIZE_MAX here as well as at parse time, because the
 * arithmetic below is what turns a bad input into a crash on the phone: `unpaged=true` on a series with no
 * books gave `size = total = 0`, `Math.ceil(0 / 0)` is NaN, JSON.stringify writes `null`, and a required
 * `Long` decoded from null fails the whole response. The extension reads only `content` and `last`
 * (Komga.kt L211), and `last` is what paginates -- so it must be true on the final page and on an empty one.
 *
 * `opts.unpaged` is the ONE answer that is not a page: the chapter list the extension asks for with
 * `unpaged=true` (Komga.kt L251). Komga builds it as `PageRequest.of(0, maxOf(count, 20))` over every row
 * (BookDtoDao.kt L200-207), so the envelope is one page whose `size` is the row count, number 0, first and
 * last both true. ⚠️ It must NOT go through the clamp: a series with more than PAGE_SIZE_MAX chapters (8 in
 * the live library, the largest 3,871) otherwise answers `size 500, numberOfElements 600, last false,
 * totalPages 2` with all 600 rows in `content` -- a shape Spring never emits, and a client that pages until
 * `last` (Komga's own UI, a Tachimanga that does not send unpaged) asks for page 1 and gets the same 600 rows
 * again. The extension reads only `content`, which is why nobody saw it on a phone.
 */
export function springPage<T>(content: T[], total: number, page: number, size: number, opts?: { unpaged?: boolean }): SpringPage<T> {
  const totalElements = Math.max(0, Math.trunc(Number(total)) || 0);
  if (opts?.unpaged) {
    // At least 1, never the count: `Math.ceil(0 / 0)` is the NaN this whole function exists to keep out.
    const s = Math.max(1, content.length);
    return {
      content,
      empty: content.length === 0,
      first: true,
      last: true,
      number: 0,
      numberOfElements: content.length,
      size: s,
      totalElements,
      totalPages: totalElements > 0 ? 1 : 0,
    };
  }
  const p = clampPage(page);
  const s = clampSize(size);
  // Spring's PageImpl: zero pages for zero elements; `last` = !(number + 1 < totalPages).
  const totalPages = Math.ceil(totalElements / s);
  return {
    content,
    empty: content.length === 0,
    first: p === 0,
    last: p + 1 >= totalPages,
    number: p,
    numberOfElements: content.length,
    size: s,
    totalElements,
    totalPages,
  };
}

export function clampPage(page: unknown): number {
  const n = Math.trunc(Number(page));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function clampSize(size: unknown, dflt = PAGE_SIZE_DEFAULT): number {
  const n = Math.trunc(Number(size));
  if (!Number.isFinite(n) || n < 1) return dflt;
  return Math.min(PAGE_SIZE_MAX, n);
}

// ---- enums -------------------------------------------------------------------------------------------------

/** Komga's SeriesMetadata.ReadingDirection (komga SeriesMetadata.kt L121-126). Neither client reads it, but it is a non-null String. */
export const READING_DIRECTIONS = ['LEFT_TO_RIGHT', 'RIGHT_TO_LEFT', 'VERTICAL', 'WEBTOON'] as const;
export type ReadingDirection = (typeof READING_DIRECTIONS)[number];

export function komgaReadingDirection(v: unknown): ReadingDirection {
  const s = String(v ?? '').toUpperCase().replace(/[\s-]+/g, '_');
  if ((READING_DIRECTIONS as readonly string[]).includes(s)) return s as ReadingDirection;
  if (s === 'LTR') return 'LEFT_TO_RIGHT';
  if (s === 'RTL' || s === 'MANGA') return 'RIGHT_TO_LEFT';
  if (s === 'LONGSTRIP' || s === 'LONG_STRIP' || s === 'CONTINUOUS') return 'WEBTOON';
  // What lib/ownedCatalog's seriesDto says for everything today; a reader for scraped manhwa/manga.
  return 'WEBTOON';
}

/**
 * Komga's status vocabulary is ENDED | ONGOING | ABANDONED | HIATUS (komga SeriesMetadata.kt L114-119) and the
 * extension maps anything else to UNKNOWN itself (Dto.kt L33-40). Our column holds whatever the source page
 * said -- "Ongoing", "Completed", "Hiatus" -- so the plain synonyms are translated and everything else goes
 * out upper-cased AS IS. Deliberately no "unknown -> ONGOING": that would tell every reader a finished or
 * dropped series is still running, and UNKNOWN on the phone is the honest answer for a status we never had.
 */
export function komgaStatus(v: unknown): string {
  const s = String(v ?? '').trim().toUpperCase().replace(/[\s_-]+/g, ' ');
  if (s === 'COMPLETED' || s === 'COMPLETE' || s === 'FINISHED' || s === 'PUBLISHING FINISHED' || s === 'ENDED') return 'ENDED';
  if (s === 'CANCELLED' || s === 'CANCELED' || s === 'DROPPED' || s === 'ABANDONED') return 'ABANDONED';
  if (s === 'ON HIATUS' || s === 'HIATUS' || s === 'PAUSED') return 'HIATUS';
  if (s === 'ONGOING' || s === 'PUBLISHING' || s === 'RELEASING') return 'ONGOING';
  return s.replace(/ /g, '_');
}

// ---- padders -----------------------------------------------------------------------------------------------

/** What `owned.series` / `owned.searchSeries` hand back (lib/ownedCatalog seriesDto). Only what we read. */
export interface OwnedSeriesDto {
  id: string;
  libraryId: string;
  name: string;
  created: string | null;
  booksCount: number;
  metadata: {
    title: string;
    status: string;
    summary: string;
    readingDirection?: string;
    author?: string;
    publisher?: string;
    genres: string[];
    tags?: string[];
    ageRating: number | null;
    language?: string;
  };
  booksMetadata?: { summary?: string; genres?: string[]; tags?: string[] };
  [extra: string]: unknown;
}

export interface KomgaAuthor { name: string; role: string }

/** Per-user counts for the three fields Mihon's tracker requires (KomgaModels.kt L14-16). */
export interface ReadCounts { read: number; unread: number; inProgress: number }

/**
 * A Komga `SeriesDto` the extension (Dto.kt L17-72, L74-84) AND the tracker (KomgaModels.kt L6-53) both decode.
 *
 * The tracker's copy additionally requires `booksReadCount`, `booksUnreadCount` and `booksInProgressCount`
 * as non-null Ints; the route passes real counts for the by-id read Mihon binds through, and a listing can
 * pass none -- then unread = booksCount, which is what lib/ownedCatalog says today and is only ever wrong in
 * the harmless direction (the tracker reads the progress endpoint for the truth).
 *
 * `fileLastModified` and `booksMetadata.created/lastModified` are required Strings in both clients, and
 * `created` is the only date the DTO from ownedCatalog carries; `opts.lastModified` (lib_series.latest_mtime
 * where the route has it) is what "Date updated" sorts by on the phone, so it is worth passing when known.
 */
export function komgaSeries(dto: OwnedSeriesDto, counts?: ReadCounts | null, opts?: { lastModified?: Date | string | number | null }) {
  const title = str(dto.metadata?.title ?? dto.name);
  const summary = str(dto.metadata?.summary);
  const genres = strs(dto.metadata?.genres);
  const tags = strs(dto.metadata?.tags);
  const author = str(dto.metadata?.author);
  const booksCount = int(dto.booksCount);
  const read = counts ? int(counts.read) : 0;
  const inProgress = counts ? int(counts.inProgress) : 0;
  const unread = counts ? int(counts.unread) : Math.max(0, booksCount - read - inProgress);
  const created = komgaDateOrNull(dto.created);
  const lastModified = komgaDateOrNull(opts?.lastModified) ?? created;
  // The extension groups `booksMetadata.authors` by role and reads "writer" as the author and "penciller"
  // as the artist (Dto.kt L43-46). Our one free-text author field is the writer.
  const authors: KomgaAuthor[] = author ? [{ name: author, role: 'writer' }] : [];
  return {
    id: str(dto.id),
    libraryId: str(dto.libraryId) || 'lib',
    name: title,
    // Komga's own extras, so a client that reads them (none of ours) sees the shape it expects.
    url: '',
    created,
    lastModified,
    fileLastModified: lastModified ?? komgaDate(null),
    booksCount,
    booksReadCount: read,
    booksUnreadCount: unread,
    booksInProgressCount: inProgress,
    deleted: false,
    oneshot: false,
    metadata: {
      status: komgaStatus(dto.metadata?.status),
      statusLock: false,
      created,
      lastModified,
      title,
      titleLock: false,
      titleSort: title,
      titleSortLock: false,
      summary,
      summaryLock: false,
      readingDirection: komgaReadingDirection(dto.metadata?.readingDirection),
      readingDirectionLock: false,
      publisher: str(dto.metadata?.publisher),
      publisherLock: false,
      ageRating: dto.metadata?.ageRating == null ? null : int(dto.metadata.ageRating),
      ageRatingLock: false,
      language: str(dto.metadata?.language) || 'en',
      languageLock: false,
      genres,
      genresLock: false,
      tags,
      tagsLock: false,
      totalBookCount: null,
      totalBookCountLock: false,
    },
    booksMetadata: {
      authors,
      authorsLock: false,
      tags: strs(dto.booksMetadata?.tags),
      tagsLock: false,
      releaseDate: null,
      // The extension falls back to this when `metadata.summary` is blank (Dto.kt L42).
      summary: str(dto.booksMetadata?.summary) || summary,
      summaryNumber: '',
      created: created ?? komgaDate(null),
      lastModified: lastModified ?? komgaDate(null),
    },
  };
}

/** What `owned.book` / `owned.seriesBooks` hand back (lib/ownedCatalog bookDto). Only what we read. */
export interface OwnedBookDto {
  id: string;
  seriesId: string;
  seriesTitle: string;
  name: string | null;
  number: number;
  media: { pagesCount: number; mediaType?: string; status?: string };
  metadata: { title: string | null; number: string; numberSort: number; summary?: string; releaseDate: string | null };
  scanlator?: string | null;
  /** lib_books.size (bigint on the wire, so a string from pg until bookDto numbers it); null when never stamped. */
  sizeBytes?: number | null;
  pruned?: boolean;
  [extra: string]: unknown;
}

/**
 * A Komga `BookDto` the extension decodes (Dto.kt L86-99, L135-142, L151-167).
 *
 * ⚠️ `number`, `metadata.numberSort` and the progress endpoint's numbers are ONE quantity. The extension sets
 * `chapter_number = metadata.numberSort` (Komga.kt L283); Mihon marks local chapters read where
 * `chapterNumber <= lastReadContinuousNumberSort` and PUTs the same unit back as `lastBookNumberSortRead`
 * (SyncChapterProgressWithTrack.kt L36-46). All three read the override-aware number that lib/ownedCatalog's
 * booksSrc already resolved into `dto.number`; nothing here may round or renumber it. `metadata.number`
 * (a String) is display only -- the chapter-name template `{number} - {title} ({size})` (Komga.kt L619).
 *
 * `name`/`metadata.title` are coalesced to '': lib_books.title is nullable, and one null in a series would
 * fail the decode of every chapter in it. The scanlator rides as an author with role "translator", which is
 * exactly the role the extension turns back into `scanlator` (Komga.kt L286-288).
 *
 * The file size is `dto.sizeBytes` (lib/ownedCatalog's bookDto carries lib_books.size since v0.38.0; an
 * explicit `opts.sizeBytes` wins when a caller knows better). It is shown, not decoded: the extension's
 * default chapter-name template is `{number} - {title} ({size})` (Komga.kt L619), so a size of 0 rendered
 * every chapter as "(0 B)" on the phone -- cosmetic, but on every row of every series. `size` is Komga's
 * `BinaryByteUnit.format` text ("1.5 KiB"), which is what the template pastes in verbatim.
 *
 * `opts.absent` is the opt-in ghost mode (lib/komgaGhosts, server_settings.komga_ghost_chapters): a pruned
 * tombstone is LISTED rather than hidden, so a library that deletes what it has read still tells the trackers
 * how many chapters the series has. It reports READY because the extension asks for `media_status=READY` and
 * filters nothing itself, and carries the same "not downloaded" size text as a ghost so the row says what it
 * is in the list. Off, a tombstone keeps its ERROR status and the route keeps filtering it out.
 */
export function komgaBook(dto: OwnedBookDto, opts?: { sizeBytes?: number | null; created?: Date | string | number | null; absent?: boolean }) {
  const title = str(dto.metadata?.title ?? dto.name);
  const number = Number(dto.number);
  const numberSort = Number.isFinite(number) ? number : 0;
  // What ownedCatalog calls releaseDate is the source's chapter date, else the file's mtime: the best "when"
  // we have for this chapter, and the one instant that feeds all three date fields below.
  const when = dto.metadata?.releaseDate ?? null;
  const created = komgaDateOrNull(opts?.created) ?? komgaDateOrNull(when);
  const sizeBytes = Math.max(0, Math.trunc(Number(opts?.sizeBytes ?? dto.sizeBytes ?? 0)) || 0);
  const scanlator = str(dto.scanlator);
  const authors: KomgaAuthor[] = scanlator ? [{ name: scanlator, role: 'translator' }] : [];
  // A tombstone listed under the ghost opt-in: there are no bytes behind it, so the size text says so rather
  // than reporting the size the file had before the cleanup took it.
  const absent = !!(opts?.absent && dto.pruned);
  return {
    id: str(dto.id),
    seriesId: str(dto.seriesId),
    seriesTitle: str(dto.seriesTitle),
    name: title,
    url: '',
    number: numberSort,
    created,
    lastModified: created,
    fileLastModified: created ?? komgaDate(null),
    sizeBytes,
    size: absent ? NOT_DOWNLOADED : humanSize(sizeBytes),
    media: {
      // A tombstone (lib/chapterCleanup: the file is gone, the row stays for everyone's progress) is not
      // READY: the extension asks for `media_status=READY` and would otherwise list a chapter whose page list
      // is empty and whose every image is a 404. Under the ghost opt-in it is READY on purpose -- being
      // listed is the point, and the "not downloaded" size text is what warns instead.
      status: dto.pruned && !absent ? 'ERROR' : 'READY',
      mediaType: str(dto.media?.mediaType) || 'application/zip',
      pagesCount: int(dto.media?.pagesCount),
      mediaProfile: 'DIVINA',
      epubDivinaCompatible: false,
      comment: '',
    },
    metadata: {
      title,
      titleLock: false,
      summary: str(dto.metadata?.summary),
      summaryLock: false,
      number: str(dto.metadata?.number) || String(numberSort),
      numberLock: false,
      numberSort,
      numberSortLock: false,
      releaseDate: komgaDay(when),
      releaseDateLock: false,
      authors,
      authorsLock: false,
      tags: [] as string[],
      tagsLock: false,
      isbn: '',
      isbnLock: false,
      links: [] as unknown[],
      linksLock: false,
    },
    deleted: false,
    oneshot: false,
  };
}

/**
 * The size text of a chapter with no file behind it.
 *
 * ⚠️ This string is the whole user-facing warning. The extension's default chapter-name template is
 * `{number} - {title} ({size})` (Komga.kt L619) and pastes `size` in verbatim, so a ghost reads
 * "1041 - Chapter 1041 (not downloaded)" in the list -- before anyone taps it. Deliberately not a byte
 * count: `humanSize(0)` is "0 B", which reads as a broken file rather than an absent one.
 *
 * Not translated. It is generated inside a Kotlin client's chapter name, on a device whose language this
 * server does not know and cannot ask; every other string on this API is English for the same reason.
 */
export const NOT_DOWNLOADED = 'not downloaded';

/**
 * A chapter the sources list that this server does not hold, as a `BookDto` (lib/komgaGhosts).
 *
 * Every field `komgaBook` emits, because the Kotlin decode requires them all and one short row fails the
 * whole list it sits in -- komgaContract.test.ts pins the two against each other for exactly that reason.
 * The differences are the three that make it a ghost:
 *
 *   media.status  READY, not ERROR. The extension requests `media_status=READY` (parseBooksQuery) and does
 *                 no client-side filtering, so ERROR would simply hide it and the feature would do nothing.
 *   pagesCount    0, which is true, and what makes a reader open to nothing rather than to a broken page.
 *   size          NOT_DOWNLOADED, the label described above.
 *
 * `number`/`numberSort` is series_listing.number -- the source's number, the same quantity lib_books.number
 * holds and the same one the progress endpoint compares, so a ghost sorts into its right place among the
 * downloaded chapters and is marked read by the tracker's `chapterNumber <= lastRead` sweep.
 */
export function komgaGhostBook(g: {
  id: string;
  seriesId: string;
  seriesTitle: string;
  number: number;
  title: string | null;
  releaseDate: string | null;
  scanlator: string | null;
}) {
  const number = Number(g.number);
  const numberSort = Number.isFinite(number) ? number : 0;
  const title = str(g.title) || `Chapter ${numberSort}`;
  const created = komgaDateOrNull(g.releaseDate);
  const scanlator = str(g.scanlator);
  const authors: KomgaAuthor[] = scanlator ? [{ name: scanlator, role: 'translator' }] : [];
  return {
    id: str(g.id),
    seriesId: str(g.seriesId),
    seriesTitle: str(g.seriesTitle),
    name: title,
    url: '',
    number: numberSort,
    created,
    lastModified: created,
    fileLastModified: created ?? komgaDate(null),
    sizeBytes: 0,
    size: NOT_DOWNLOADED,
    media: {
      status: 'READY',
      mediaType: 'application/vnd.comicbook+zip',
      pagesCount: 0,
      mediaProfile: 'DIVINA',
      epubDivinaCompatible: false,
      comment: '',
    },
    metadata: {
      title,
      titleLock: false,
      summary: '',
      summaryLock: false,
      number: String(numberSort),
      numberLock: false,
      numberSort,
      numberSortLock: false,
      releaseDate: komgaDay(g.releaseDate),
      releaseDateLock: false,
      authors,
      authorsLock: false,
      tags: [] as string[],
      tagsLock: false,
      isbn: '',
      isbnLock: false,
      links: [] as unknown[],
      linksLock: false,
    },
    deleted: false,
    oneshot: false,
  };
}

/** A Komga `PageDto` (Dto.kt L144-149): 1-based `number`, as `owned.bookPages` already numbers them. */
export function komgaPage(p: { fileName: string; mediaType: string; width?: number | null; height?: number | null }, index: number) {
  return {
    // 1-based: Komga's BookController emits `index + 1` and the extension requests `/pages/${it.number}`
    // verbatim (Komga.kt L308-315), so a 0 here would fetch every image one page early and 404 on the last.
    number: index + 1,
    fileName: str(p.fileName),
    mediaType: str(p.mediaType) || 'image/jpeg',
    width: p.width ?? null,
    height: p.height ?? null,
  };
}

/** Komga's `BinaryByteUnit.format` shape (BookDto.kt L25): "1.2 MiB". */
export function humanSize(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = Math.max(0, bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => x != null).map(String) : []);
const int = (v: unknown): number => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : 0; };

// ---- query parameters --------------------------------------------------------------------------------------

/** `{ genre: { operator: 'is', value } }` and friends: the subset of Komga's condition tree lib/ownedCatalog's condSql speaks. */
export type Condition = Record<string, unknown>;

export interface SeriesQuery {
  /** For `owned.searchSeries(ctx, { condition, fullTextSearch }, page, size, sort)`. Null when nothing was asked. */
  condition: Condition | null;
  fullTextSearch: string | null;
  page: number;
  size: number;
  /** In lib/ownedCatalog's `sortSql` vocabulary: `title,asc` | `added,desc` | `updated,desc` | `random`. */
  sort: string;
  unpaged: boolean;
  /** Whether a per-user predicate is present (read_status). condSql throws without a user for these. */
  needsUser: boolean;
}

/**
 * Every value a list parameter arrived with, flattened.
 *
 * The extension sends multi-select filters COMMA-JOINED in ONE parameter (`library_id=a,b`, `status=`, `genre=`,
 * `tag=`, `publisher=`: KomgaFilters.kt L87-93) but REPEATS `read_status` (L37-38: Unread = `UNREAD` +
 * `IN_PROGRESS`) and `author` (L106-108, one `name,role` per author). Real Komga's Spring binding accepts both
 * forms, so a compatible server does too: fastify hands a repeated key over as an array, a single one as a
 * string, and both are split on commas. A value that itself contains a comma is ambiguous on the wire; Komga
 * has the same limitation.
 */
export function listParam(v: unknown): string[] {
  return ([] as unknown[]).concat(v ?? [])
    .flatMap((x) => String(x).split(','))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function oneParam(v: unknown): string | null {
  const arr = ([] as unknown[]).concat(v ?? []);
  return arr.length ? String(arr[arr.length - 1]) : null;
}

const truthy = (v: unknown) => /^(true|1|yes)$/i.test(String(oneParam(v) ?? ''));

/**
 * The extension's sort strings (Komga.kt L178-185: relevance | metadata.titleSort | name | createdDate |
 * lastModifiedDate | random, then `,asc|desc`) into what lib/ownedCatalog's sortSql understands. A whitelist,
 * not a pass-through: sortSql also knows `unread` and `favourites`, which join per-user CTEs a Komga client
 * never asked for, and anything unknown must fall to the same order Komga uses with no term -- title.
 * `relevance` is title too: there is no ranking behind our ILIKE search.
 */
export function komgaSort(v: unknown, dflt = 'title,asc'): string {
  const raw = oneParam(v);
  if (!raw) return dflt;
  const [field0, dir0] = raw.split(',');
  const field = (field0 ?? '').trim().toLowerCase();
  const dir = (dir0 ?? '').trim().toLowerCase() === 'desc' ? 'desc' : 'asc';
  if (field === 'random') return 'random';
  if (field === 'createddate' || field === 'created') return `added,${dir}`;
  if (field === 'lastmodifieddate' || field === 'lastmodified') return `updated,${dir}`;
  if (field === 'metadata.titlesort' || field === 'name' || field === 'title' || field === 'metadata.title') return `title,${dir}`;
  return dflt;
}

const anyOf = (key: string, values: string[]): Condition | null =>
  values.length === 0 ? null
  : values.length === 1 ? { [key]: { operator: 'is', value: values[0] } }
  : { anyOf: values.map((value) => ({ [key]: { operator: 'is', value } })) };

/**
 * `GET /api/v1/series?...` (and `/collections/:id/series`) as the extension builds it (Komga.kt L146-195):
 * `search` always present (possibly empty -- an empty term is no filter), 0-based `page`, `deleted=false`
 * (always; we never list tombstoned series anyway), and the filters of KomgaFilters.kt.
 *
 * Unknown filters are DROPPED here on purpose only when they cannot name anything: `tag` and `publisher` map
 * onto the columns our series DTO already presents them as (tags ride with genres; publisher is the author
 * field), so a phone that picked one of them gets exactly the rows it saw the value on. Anything else that
 * condSql cannot express stays out of the tree, and condSql itself refuses (400) rather than widening.
 */
export function parseSeriesQuery(q: Record<string, unknown> | undefined | null): SeriesQuery {
  const qs = q ?? {};
  const parts: Condition[] = [];
  const libraryIds = listParam(qs.library_id);
  const statuses = listParam(qs.status).map((s) => s.toUpperCase());
  // Our own vocabulary, so `status=ENDED` from the phone finds a series stored as "Completed".
  const ourStatuses = statuses.flatMap(statusSynonyms);
  const genres = [...listParam(qs.genre), ...listParam(qs.tag)];
  const publishers = listParam(qs.publisher);
  // `author=<name>,<role>`: the role is the extension's own grouping, not a column we have. Split on the
  // LAST comma so a name that contains one survives; a bare name (no role) is taken as is.
  const authors = ([] as unknown[]).concat(qs.author ?? []).map(String).map((a) => {
    const i = a.lastIndexOf(',');
    return (i > 0 ? a.slice(0, i) : a).trim();
  }).filter(Boolean);
  const readStatuses = listParam(qs.read_status).map((s) => s.toUpperCase());

  for (const c of [
    anyOf('libraryId', libraryIds),
    anyOf('status', ourStatuses),
    anyOf('genre', genres),
    anyOf('author', [...authors, ...publishers]),
    anyOf('readStatus', readStatuses),
  ]) if (c) parts.push(c);

  const search = (oneParam(qs.search) ?? '').trim();
  return {
    condition: parts.length === 0 ? null : parts.length === 1 ? parts[0] : { allOf: parts },
    fullTextSearch: search || null,
    page: clampPage(oneParam(qs.page)),
    size: clampSize(oneParam(qs.size)),
    sort: komgaSort(qs.sort),
    unpaged: truthy(qs.unpaged),
    needsUser: readStatuses.length > 0,
  };
}

/** The stored spellings a Komga status value stands for; condSql compares case-insensitively. */
function statusSynonyms(s: string): string[] {
  switch (s) {
    case 'ENDED': return ['ENDED', 'COMPLETED', 'COMPLETE', 'FINISHED', 'PUBLISHING FINISHED'];
    case 'ABANDONED': return ['ABANDONED', 'CANCELLED', 'CANCELED', 'DROPPED'];
    case 'HIATUS': return ['HIATUS', 'ON HIATUS', 'PAUSED'];
    case 'ONGOING': return ['ONGOING', 'PUBLISHING', 'RELEASING'];
    default: return [s];
  }
}

export interface BooksQuery {
  page: number;
  size: number;
  unpaged: boolean;
  /** `metadata.numberSort,asc|desc` -- the only order `owned.seriesBooks` honours (direction). */
  sort: string;
  /** `media_status=READY` was asked: the route leaves tombstoned chapters out of the LIST (never out of progress). */
  readyOnly: boolean;
  /** `read_status` values, upper-cased, for the route to apply per user if it lists books at all. */
  readStatus: string[];
  libraryIds: string[];
  fullTextSearch: string | null;
  deleted: boolean;
}

/**
 * `GET /api/v1/series/:id/books?unpaged=true&media_status=READY&deleted=false` (Komga.kt L251) and
 * `GET /api/v1/books?search=&page=&deleted=false...` (L154). `unpaged` means "everything": the route answers
 * every row on one page through `springPage(..., { unpaged })`, which sizes the envelope to the row count and
 * skips the cap; a client that says `media_status=READY` gets no tombstones. `size` is capped here like every
 * other list, which is why a route must hand `unpaged` to springPage rather than pass the count as `size`.
 */
export function parseBooksQuery(q: Record<string, unknown> | undefined | null): BooksQuery {
  const qs = q ?? {};
  const statuses = listParam(qs.media_status).map((s) => s.toUpperCase());
  const search = (oneParam(qs.search) ?? '').trim();
  const sortRaw = oneParam(qs.sort) ?? '';
  const dir = /,\s*desc\s*$/i.test(sortRaw) ? 'desc' : 'asc';
  return {
    page: clampPage(oneParam(qs.page)),
    size: clampSize(oneParam(qs.size)),
    unpaged: truthy(qs.unpaged),
    sort: `metadata.numberSort,${dir}`,
    readyOnly: statuses.length > 0 && statuses.every((s) => s === 'READY'),
    readStatus: listParam(qs.read_status).map((s) => s.toUpperCase()),
    libraryIds: listParam(qs.library_id),
    fullTextSearch: search || null,
    deleted: truthy(qs.deleted),
  };
}
