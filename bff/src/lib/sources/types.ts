// A source adapter knows how to talk to one content provider (MangaDex API, Aqua Manga site, ...).
// The downloader/updater are written against this interface, so adding a source = adding one adapter.
export interface SourceSeries {
  sourceId: string; // id within the source
  source: string; // adapter id, e.g. 'mangadex'
  title: string;
  summary?: string;
  status?: string;
  genres?: string[];
  author?: string;
  coverUrl?: string; // remote cover image
  url?: string; // canonical web url
  updatedAt?: string; // ISO timestamp of the source's last update to this series (when the source exposes it)
}

export interface SourceChapter {
  sourceId: string; // chapter id within the source
  number: number;
  title?: string;
  lang?: string;
  pages?: number;
  publishedAt?: string; // ISO release date of the chapter on the source (best-effort for scraped sites)
}

export interface SourceAdapter {
  id: string; // 'mangadex'
  name: string; // 'MangaDex'
  search(query: string): Promise<SourceSeries[]>;
  getSeries(id: string): Promise<SourceSeries | null>;
  listChapters(seriesId: string): Promise<SourceChapter[]>;
  getPageUrls(chapterId: string): Promise<string[]>;
  /** optional: browse the source's newest / recently-updated series (no search query). `page` is 1-based. */
  latest?(page?: number): Promise<SourceSeries[]>;
  // ---- optional, plugin-declared capabilities (the core consults these instead of hardcoding ids) ----
  /** page/cover images sit behind Cloudflare → fetch them with FlareSolverr session cookies. */
  requiresCloudflare?: boolean;
  /** Referer to send when fetching page/cover images (string, or derived from the chapter url). */
  imageReferer?: string | ((chapterUrl: string) => string);
  /** Extra headers for page/cover image fetches — e.g. auth for a source that proxies its own images. */
  imageHeaders?: Record<string, string> | ((imageUrl: string) => Record<string, string>);
  /** Lower = earlier in the cross-source "find" provider order (default: large). */
  preferredOrder?: number;
}

/** Host services the core injects into a source plugin's register(host) (so plugins never import core internals). */
export interface SourceHost {
  cfGet(url: string): Promise<string>;
  cfPost(url: string, postData: string): Promise<string>;
  cfSession(url: string): Promise<{ cookie: string; userAgent: string }>;
}
