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
 * later from Find missing chapters. `registered` is false when the adapter is no longer installed -- the row
 * is kept so the choice survives a reinstall, but nothing can be fetched from it meanwhile.
 */
export interface SeriesSource {
  sourceId: string;
  name: string;
  sourceSeriesId: string;
  primary: boolean;
  checkedAt: string | null;
  chapters: number | null;
  registered: boolean;
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
  };
  /** Every source the updater asks for this series, primary first. Sent to every viewer. */
  sources?: SeriesSource[];
  /** This series' own scanlator overrides, or null when it follows the server defaults. Admins only. */
  scanlatorPrefs?: StoredPrefs | null;
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
   * The file was deleted by the server's read-chapter cleanup. The chapter is still part of the series and
   * still carries everyone's progress -- there are simply no pages behind it any more, and there will not
   * be again. Nothing may offer to open or download it.
   */
  pruned?: boolean;
}

export interface PageInfo {
  number: number;
  /** Set by the server when this page recurs across chapters of the series -- a credit page, an advert. */
  junk?: boolean;
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
  pages: { number: number; url: string; width: number | null; height: number | null; bytes: number | null; junk?: boolean }[];
}

export function isWebtoon(dir?: string): boolean {
  return dir === 'WEBTOON' || dir === 'VERTICAL';
}
