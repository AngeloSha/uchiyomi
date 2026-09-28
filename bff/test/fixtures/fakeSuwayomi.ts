// The fake extension engine for bff tests: a real HTTP server on loopback that speaks Suwayomi-Server v2.3.2243's
// GraphQL and REST, refuses anything the real schema does not have, and can be switched down, slow or into an
// extension failure. The engine itself lives in fakeSuwayomiEngine.mjs (dependency-free, so the browser rig
// runs the same file); this module gives it types and the handful of handles tests reach for.
//
//   const fake = await startFakeSuwayomi();
//   process.env.SUWAYOMI_URL = fake.url;   // ⚠️ BEFORE importing anything from src: env.ts parses it once
//   const { gql } = await import('../src/lib/sources/suwayomi/client');
//
// ⚠️ Drive it through the product's own transport (`gql` from suwayomi/client.ts, the adapters, the routes),
// not through `fake.query`: the point is that the REAL query strings meet the REAL schema. `fake.query` is for
// setting up state and for asserting what the engine now holds.
//
// Whatever the real engine serves and this fake does not is answered "FAKE ENGINE: ... not implemented". Add it
// to fakeSuwayomiEngine.mjs, measured against a throwaway engine of the pinned image (conformFakeSuwayomi.mjs
// runs the comparison), rather than loosening the check.
import {
  startFakeEngine, checkQuery, defaultSeed, istreveliaPosts, webtoonsNumbers, f32,
  SOURCE_IDS, PKG, SEQUENTIAL_KEY, STAGES, MODES,
} from './fakeSuwayomiEngine.mjs';

export { defaultSeed, istreveliaPosts, webtoonsNumbers, f32, SOURCE_IDS, PKG, SEQUENTIAL_KEY, STAGES, MODES };

export type FakeMode = 'up' | 'down' | 'slow' | 'extension_error';
/** Where an extension can fail: fetchSourceManga, fetchManga, fetchChapters, fetchChapterPages, a page image. */
export type FakeStage = 'search' | 'manga' | 'chapters' | 'pages' | 'images';
export interface FakeModeSpec {
  mode: FakeMode;
  /** `slow` only: how long each engine request waits before it is answered. Default 15 000. */
  ms?: number;
  /** `extension_error` only: fail this source id alone (default: every source). */
  source?: string;
  /** `extension_error` only: fail this stage alone (default: every stage). */
  stage?: FakeStage;
  /** `extension_error` only: the exception message. Default 'java.lang.Exception', as in issue #115. */
  message?: string;
}

export type FakePrefKind = 'switch' | 'checkbox' | 'edittext' | 'list' | 'multiselect';
export interface FakePref {
  kind: FakePrefKind;
  key: string;
  title?: string;
  summary?: string | null;
  default: unknown;
  entries?: string[];
  entryValues?: string[];
  /** A disabled preference is left alone by updateSourcePreference, silently, as on the engine. */
  enabled?: boolean;
  /**
   * The extension's own change listener refuses every value (returns false): updateSourcePreference answers as usual
   * and nothing is stored -- a write the engine "took" that did not happen (modelled).
   */
  keeps?: boolean;
  visible?: boolean;
  dialogTitle?: string | null;
  dialogMessage?: string | null;
}
export interface FakeChapter {
  name: string;
  url: string;
  /**
   * -1 (or absent) is the engine's "no number" -- for a name with no digits in it. The engine parses a number
   * out of a name like "Ch.10 Finale" when the extension gives none, and the fake does not, so such a seed is
   * refused: give the number. Ignored on a `numbering: 'webtoons'` source.
   */
  chapterNumber?: number;
  scanlator?: string | null;
  /** Epoch milliseconds. */
  uploadDate?: number;
  pages?: number;
  realUrl?: string | null;
}
export interface FakeManga {
  /** The engine's manga id: what the adapter stores as a series' sourceId. */
  id: number;
  sourceId: string;
  title: string;
  url: string;
  realUrl?: string | null;
  description?: string | null;
  author?: string | null;
  artist?: string | null;
  genre?: string[];
  status?: string;
  /** As the EXTENSION lists them: newest first. sourceOrder is computed from this order on each fetchChapters. */
  chapters: FakeChapter[];
}
export interface FakeSource {
  id: string;
  name: string;
  lang: string;
  displayName?: string;
  pkgName: string;
  supportsLatest?: boolean;
  isNsfw?: boolean;
  baseUrl?: string | null;
  numbering?: 'webtoons';
  /** The preference screen, in order. Reorder or edit it to model an extension update; see `readPreferences`. */
  preferences: FakePref[];
  /** What updateSourcePreference stored, by key. */
  prefValues: Record<string, unknown>;
  /**
   * Stages that always fail for this source, whatever the mode (a string is the exception message). `preferences`:
   * its preference screen (setupPreferenceScreen) throws, only when named here, never by a mode.
   */
  fail: Partial<Record<FakeStage | 'preferences', true | string>>;
  /** How many times a preference write made the engine rebuild the source. */
  reloads: number;
  mangas: FakeManga[];
}
export interface FakeExtension {
  pkgName: string;
  name: string;
  lang: string;
  versionName: string;
  installed: boolean;
  isNsfw: boolean;
  repo?: string | null;
  hasUpdate: boolean;
  obsolete: boolean;
  versionCode: number;
}
export interface FakeSeed {
  sources: Array<Partial<FakeSource> & Pick<FakeSource, 'id' | 'name' | 'lang' | 'pkgName'> & {
    mangas?: Array<Omit<FakeManga, 'id' | 'sourceId'>>;
  }>;
  extensions: Array<Partial<FakeExtension> & Pick<FakeExtension, 'pkgName' | 'name' | 'lang' | 'versionName' | 'installed'>>;
  settings?: Record<string, unknown>;
}
export interface FakeCall {
  seq: number;
  at: string;
  method: string;
  path: string;
  kind: 'graphql' | 'rest' | 'control';
  mode: FakeMode;
  /** ok | error (the engine answered with errors) | rejected (validation) | unimplemented | dropped | abandoned | missing | unauthorized | refused */
  status?: string;
  operation?: 'query' | 'mutation' | 'subscription';
  /** The root fields the operation selected. */
  fields?: string[];
  variables?: Record<string, unknown>;
  /** Deprecated members the query used: accepted by the engine, and worth knowing about before an upgrade. */
  deprecated?: string[];
  error?: string;
}
export interface FakeCacheClear {
  cachedPages: boolean | null;
  cachedThumbnails: boolean | null;
  downloadedThumbnails: boolean | null;
}
export interface GqlResponse<T = any> {
  data?: T;
  errors?: Array<{ message: string; locations?: Array<{ line: number; column: number }>; path?: Array<string | number>; extensions?: object }>;
}

export interface FakeSuwayomi {
  url: string;
  port: number;
  /** Every request, oldest first (the last 2 000). */
  calls: FakeCall[];
  /** GraphQL requests, optionally only those selecting `field` at the root. */
  graphqlCalls(field?: string): FakeCall[];
  setMode(mode: FakeMode | FakeModeSpec): FakeModeSpec;
  readonly mode: FakeModeSpec;
  source(id: string): FakeSource;
  /** A series by title, from any source. */
  manga(title: string): FakeManga;
  extension(pkgName: string): FakeExtension;
  /** The engine's settings as stored (setSettings writes here). */
  readonly settings: Record<string, unknown>;
  /** Every preference write that took effect: the position asked for and the key it landed on. */
  readonly prefWrites: Array<{ source: string; position: number; key: string; value: unknown }>;
  /** The pages the engine keeps on disk because it served them (its manga-cache), by request path. */
  readonly pageCache: Set<string>;
  /** The covers it keeps the same way (its thumbnail cache). */
  readonly thumbnailCache: Set<string>;
  /** Every clearCachedImages that ran, as asked: `null` for a kind not given. */
  readonly cacheClears: FakeCacheClear[];
  /**
   * Run a GraphQL request in-process, with the engine's validation and errors. No HTTP, so `down` and `slow` do
   * not apply here (an extension_error does).
   */
  query<T = any>(query: string, variables?: Record<string, unknown>): Promise<GqlResponse<T>>;
  /** Back to a fresh copy of `seed` (default: the one it started with), mode `up`, an empty log. */
  reset(seed?: FakeSeed): void;
  /** Close the port for real (connection refused) ... */
  stop(): Promise<void>;
  /** ... and reopen the same one. */
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface FakeSuwayomiOptions {
  seed?: FakeSeed;
  /** Require HTTP Basic credentials on every engine route, as an engine with SUWAYOMI_USERNAME set does. */
  auth?: { username: string; password: string };
  /** Default 0: any free port. */
  port?: number;
}

export async function startFakeSuwayomi(opts: FakeSuwayomiOptions = {}): Promise<FakeSuwayomi> {
  const h = await startFakeEngine(opts);
  const e = h.engine;
  const find = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`the fake engine has no ${what}`);
    return v;
  };
  return {
    url: h.url,
    port: h.port,
    calls: e.log,
    graphqlCalls: (field) => e.log.filter((c: FakeCall) => c.kind === 'graphql' && (!field || c.fields?.includes(field))),
    setMode: (m) => e.setMode(m),
    get mode() { return e.mode; },
    source: (id) => find(e.state.sources.get(id), `source ${id}`),
    manga: (title) => find([...e.state.mangas.values()].find((m: FakeManga) => m.title === title), `series "${title}"`),
    extension: (pkg) => find(e.state.extensions.get(pkg), `extension ${pkg}`),
    get settings() { return e.state.settings; },
    get prefWrites() { return e.state.prefWrites; },
    get pageCache() { return e.state.pageCache; },
    get thumbnailCache() { return e.state.thumbnailCache; },
    get cacheClears() { return e.state.cacheClears; },
    query: (query, variables = {}) => e.graphql({ query, variables }),
    reset: (seed) => e.reset(seed),
    stop: () => h.stop(),
    start: () => h.start(),
    close: () => h.close(),
  };
}

/**
 * What the engine would refuse `query` with, as its own messages; [] when it would run it. No server needed:
 * a unit test can hold a product query string to the pinned schema in one line.
 */
export function suwayomiQueryErrors(query: string): string[] {
  return checkQuery(query);
}
