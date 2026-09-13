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
  /**
   * The group that released this copy, as the source shows it. A display string, not an id: a joint
   * release is the names joined with ' & ', which is the spelling Mihon's scanlator column and the
   * ComicInfo Translator tag both use, so a file written by us reads the same as one written by them.
   */
  scanlator?: string;
  /**
   * The individual group names, only when the source is STRUCTURALLY multi-group (MangaDex relationships
   * carry one entry per group). Every other source hands over one free-text string, and lib/releases.ts
   * splits that on the usual separators instead -- so an adapter that has only the string must leave this
   * absent rather than wrapping it in an array, or a "Group A & Group B" release reads as one group named
   * that and never matches a block on either.
   */
  groups?: string[];
  /**
   * Adapter id the copy came from. Set ONLY by the updater's multi-source union, where one chapter list is
   * built from several sources and the chooser needs to rank primary over follower; every adapter leaves
   * it undefined, because inside one adapter it would only ever say what the caller already knows.
   */
  source?: string;
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
  /**
   * optional: browse what the source itself considers popular. `page` is 1-based.
   *
   * Deliberately the source's own ranking rather than one we compute. Every family here already publishes
   * this listing -- it is the same page `latest` reads with a different sort -- so the alternative would be
   * inventing a ranking out of data we do not have, and getting it wrong.
   */
  popular?(page?: number): Promise<SourceSeries[]>;
  // ---- optional, plugin-declared capabilities (the core consults these instead of hardcoding ids) ----
  /** page/cover images sit behind Cloudflare → fetch them with FlareSolverr session cookies. */
  requiresCloudflare?: boolean;
  /** Referer to send when fetching page/cover images (string, or derived from the chapter url). */
  imageReferer?: string | ((chapterUrl: string) => string);
  /** Extra headers for page/cover image fetches — e.g. auth for a source that proxies its own images. */
  imageHeaders?: Record<string, string> | ((imageUrl: string) => Record<string, string>);
  /**
   * How many pages of one chapter may be in flight at once. Default 1.
   *
   * Engines and pack sites are scraped from the site itself, and the sequential quarter-second pacing is
   * what stopped the 429s there -- the default stays 1 so they keep it. An extension source is proxied by
   * the engine, which has its own HTTP client and its own rate limits towards the site, so it may declare
   * more; the downloader then overlaps that many fetches and falls back to one the moment the engine
   * answers 429.
   */
  pageConcurrency?: number;
  /**
   * Minimum pause between one page request and the next for this source, overriding DOWNLOAD_PAGE_GAP_MS.
   * 0 = none. Measured from the later of the previous request's start and its reply, and across all
   * in-flight workers rather than per worker, so it is a floor on the request rate towards the source
   * however wide the pool is -- and a slow site is still not asked again until the gap after its reply.
   */
  pageGapMs?: number;
  /**
   * The source's own logo, when it has one it can name.
   *
   * Only Suwayomi extensions supply this; template sites carry `base` instead and their icon is resolved
   * from the site itself. Never handed to a browser as-is -- the extension server is not reachable from
   * one -- so it is proxied through /img/sources/icon/:id like every other remote image.
   */
  iconUrl?: string;

  /**
   * The site's own homepage, when the adapter is a template over a user-supplied URL.
   *
   * Only the diagnostics use this: probing the base directly, WITHOUT the Cloudflare solver, is what
   * separates "the site moved", "the CDN refuses this server" and "the solver is broken" from each other.
   * Those three look identical in `source_health` and had been doing so for months.
   *
   * Optional on purpose. Template engines set it from the URL the operator typed, so every custom site gets
   * it for free; hand-written pack adapters keep their base private and simply do not offer this, and the
   * diagnosis falls back to stored evidence alone.
   */
  base?: string;

  /** Lower = earlier in the cross-source "find" provider order (default: large). */
  preferredOrder?: number;
  /**
   * BCP-47-ish language this source publishes in, when it only publishes in one. Suwayomi reports it per
   * source; a built-in declares it only when its own requests pin a language (MangaDex asks for `en` and
   * nothing else). Absent means "no single language", which the language grouping reads as "belongs to
   * every group" -- so declaring it wrongly is worse than leaving it off.
   */
  lang?: string;
  /**
   * The source itself is adult, as opposed to carrying the odd adult title. Only Suwayomi supplies this
   * signal; everything else stays undefined and is treated as not-adult, matching `visible()`'s rule that
   * unrated content stays visible rather than vanishing the moment someone sets an age limit.
   */
  isNsfw?: boolean;
}

/** Host services the core injects into a source plugin's register(host) (so plugins never import core internals). */
export interface SourceHost {
  cfGet(url: string): Promise<string>;
  cfPost(url: string, postData: string): Promise<string>;
  cfSession(url: string): Promise<{ cookie: string; userAgent: string }>;
}
