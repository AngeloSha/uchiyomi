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

export interface Series {
  /** Whether the scheduled updater fetches new chapters for this series. */
  autoUpdate?: boolean;
  id: string;
  libraryId: string;
  name: string;
  created?: string | null; // when the series entered the library
  booksCount: number;
  booksReadCount: number;
  booksUnreadCount: number;
  booksInProgressCount: number;
  metadata: SeriesMetadata;
  booksMetadata?: { summary?: string; genres?: string[]; tags?: string[] };
  color?: string | null;
  yomi?: UchiyomiFlags;
  artVersion?: number; // bumps when an admin edits the cover/banner → cache-busts the image URLs
  overrides?: {
    title: string | null; summary: string | null; cover: string | null; banner: string | null;
    author: string | null; status: string | null; genres: string[] | null;
  };
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
}

export interface PageInfo {
  number: number;
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
  pages: { number: number; url: string; width: number | null; height: number | null; bytes: number | null }[];
}

export function isWebtoon(dir?: string): boolean {
  return dir === 'WEBTOON' || dir === 'VERTICAL';
}
