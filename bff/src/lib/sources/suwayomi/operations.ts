// Every GraphQL document Uchiyomi sends to the extension engine, in one registry.
//
// The engine is Suwayomi-Server, a project with its own releases, and its schema is the contract. Before this file the
// documents were spread over six modules as inline strings, and nothing could say which members of that schema
// Uchiyomi depends on: eight of them were deprecated, and one engine upgrade from being refused. Now:
//   * test/suwayomiOperations.test.ts validates every document here against the schema of every engine from
//     OLDEST_ENGINE up (test/fixtures/suwayomi-v*-schema.json, and SUWAYOMI_EXTRA_SCHEMA, which the weekly canary
//     points at a NEW engine's schema), with no deprecated member allowed;
//   * the same test drives every adapter function and holds the documents it sends to this list, both ways, and finds
//     any query written inline somewhere else;
//   * client.ts names a refused document by its operation here, which is what Health quotes.
//
// `optional`: asked apart on purpose, and allowed to be missing on an engine. Its refusal is an answer (an engine with
// no such setting, say), not a sign of an incompatible engine, so it is never recorded as one.
//
// Measured on v2.3.2243 and v2.4.2366 (throwaway engines, conformFakeSuwayomi.mjs): every document below is valid on
// both, and the deprecated members they replaced still answer on both.

export interface EngineOp {
  /** The name a refusal is recorded and reported under (client.ts engineRefusals, Health). One per document. */
  readonly name: string;
  readonly doc: string;
  readonly optional?: boolean;
}

const op = (name: string, doc: string, optional = false): EngineOp =>
  Object.freeze(optional ? { name, doc, optional } : { name, doc });

// `sourceId`: which extension source the manga belongs to. Engine manga ids are global, so an adapter checks it (v0.69.1).
const MANGA_FIELDS = 'id title thumbnailUrl realUrl url description author artist genre status sourceId';
/**
 * `sourceOrder url` (#116): non-null on ChapterType. sourceOrder is index + 1 over the extension's list reversed, so 1
 * is the OLDEST post, and the engine answers in sourceOrder ascending. `uploadDate` is epoch milliseconds as a string --
 * except on v2.3.2243 for a chapter the extension gave no date, which it stamps with the current time in SECONDS
 * (sources.ts toChapter reads both).
 */
const CHAPTER_FIELDS = 'id chapterNumber name scanlator uploadDate pageCount sourceOrder url';
/**
 * `contentWarning` (SAFE | MIXED | NSFW) replaced `isNsfw`, and `storeIndexUrl` replaced `repo`. ⚠️ An extension from a
 * legacy (index.min.json) store marked 18+ is MIXED, not NSFW (measured on both engines): only SAFE is safe.
 */
const EXTENSION_FIELDS = 'pkgName name lang versionName iconUrl isInstalled hasUpdate isObsolete contentWarning storeIndexUrl';

/**
 * A union selected with aliases. `currentValue` and `default` are Boolean on a switch, String on a list and [String!] on
 * a multi-select; graphql-java refuses two fields with one response name and different types in one selection
 * (OverlappingFieldsCanBeMerged holds even across the members of a union), so each shape gets its own name. The fake
 * engine does not model that rule (fakeSuwayomiEngine.mjs says so); the aliases are for the real one.
 */
const PREF_SHAPES = `__typename
  ... on SwitchPreference { key title summary visible enabled bool: currentValue boolDefault: default }
  ... on CheckBoxPreference { key title summary visible enabled bool: currentValue boolDefault: default }
  ... on EditTextPreference { key title summary visible enabled str: currentValue strDefault: default text dialogTitle dialogMessage }
  ... on ListPreference { key title summary visible enabled str: currentValue strDefault: default entries entryValues }
  ... on MultiSelectListPreference { key title summary visible enabled strs: currentValue strsDefault: default entries entryValues dialogTitle dialogMessage }`;

/** A preference write, for one kind: its position and that kind's one state field (prefs.ts says why one). */
const prefWrite = (field: string, type: string) => `mutation($source:LongString!,$position:Int!,$value:${type}){
  updateSourcePreference(input:{source:$source,change:{position:$position,${field}:$value}}){ preferences { ${PREF_SHAPES} } } }`;

// Filter unions keep every position, but only TextFilter names and bounded group nesting are needed here.
const creatorFilterShapes = (depth: number): string => `__typename ... on TextFilter { name }
  ${depth ? `... on GroupFilter { filters { ${creatorFilterShapes(depth - 1)} } }` : ''}`;

export const OPS = {
  // ---- the engine itself
  /** `buildType` replaced `revision`, which the version already carries as its patch number. */
  aboutServer: op('aboutServer', '{ aboutServer { name version buildType } }'),

  // ---- sources and their series (sources.ts)
  /**
   * `contentWarning` replaced `isNsfw`. `homeUrl` since v0.91.0: the page Open site and the quiet check visit open
   * (siteSessions.ts). Not `baseUrl`, which every supported engine marks deprecated ("replace with homeUrl").
   */
  sources: op('sources', '{ sources { totalCount nodes { id name displayName lang iconUrl homeUrl contentWarning supportsLatest extension { pkgName name } } } }'),
  // Read apart and after registration: one broken extension's getFilterList cannot hide ordinary sources.
  sourceCreatorFilters: op('sourceCreatorFilters', `query SourceCreatorFilters { sources { nodes { id filters { ${creatorFilterShapes(2)} } } } }`, true),
  fetchSourceManga: op('fetchSourceManga', `mutation($source:LongString!,$type:FetchSourceMangaType!,$query:String,$page:Int!,$filters:[FilterChangeInput!]){
  fetchSourceManga(input:{source:$source,type:$type,query:$query,page:$page,filters:$filters}){ mangas { ${MANGA_FIELDS} } }
}`),
  /**
   * The series, through `fetchMangaAndChapters`, which replaced `fetchManga` and runs the same engine code. ⚠️ It
   * catches a failure of the update and answers the STORED series with the error attached (`data` and `errors` both;
   * the error is the bare exception message, no path): client.ts throws on any error, so a failing extension still
   * fails here, as it did.
   */
  fetchManga: op('fetchManga', `mutation($id:Int!){ fetchMangaAndChapters(input:{id:$id,fetchManga:true,fetchChapters:false}){ manga { ${MANGA_FIELDS} } } }`),
  /** The chapter list, the same way (it replaced `fetchChapters`). Rows in sourceOrder ascending. */
  fetchChapters: op('fetchChapters', `mutation($id:Int!){ fetchMangaAndChapters(input:{id:$id,fetchManga:false,fetchChapters:true}){ manga { sourceId } chapters { ${CHAPTER_FIELDS} } } }`),
  fetchChapterPages: op('fetchChapterPages', 'mutation($chapterId:Int!){ fetchChapterPages(input:{chapterId:$chapterId}){ pages } }'),

  // ---- extensions (extensions.ts)
  extensions: op('extensions', `{ extensions { nodes { ${EXTENSION_FIELDS} } } }`),
  /**
   * Fix everything's ranking (lib/extensionRank.ts): asked apart from the catalogue so an engine without these fields
   * answers no facts, and the ranking falls back to names.
   */
  extensionFacts: op('extensionFacts', '{ extensions { nodes { pkgName versionCodeLong apkUrl jarUrl apkName storeIndexUrl } } }', true),
  fetchExtensions: op('fetchExtensions', 'mutation{ fetchExtensions(input:{}){ extensions { pkgName } } }'),
  /** Install, uninstall or update, by `$patch` ({install: true} and so on). */
  updateExtension: op('updateExtension', 'mutation($id:String!,$patch:UpdateExtensionPatchInput!){ updateExtension(input:{id:$id,patch:$patch}){ extension { pkgName isInstalled } } }'),
  sourcesOfExtension: op('sourcesOfExtension', '{ extensions { nodes { pkgName source { nodes { id name lang contentWarning } } } } }'),

  // ---- extension stores, which replaced the `extensionRepos` setting (extensions.ts)
  extensionStores: op('extensionStores', '{ extensionStores { nodes { indexUrl name } } }'),
  /** Fetches the index there and then, and answers the engine's own spelling of the address, or the error. */
  addExtensionStore: op('addExtensionStore', 'mutation($indexUrl:String!){ addExtensionStore(input:{indexUrl:$indexUrl}){ extensionStore { indexUrl name } } }'),
  /** Matches `indexUrl` exactly; an address it does not hold answers `extensionStore: null`, with no error. */
  removeExtensionStore: op('removeExtensionStore', 'mutation($indexUrl:String!){ removeExtensionStore(input:{indexUrl:$indexUrl}){ extensionStore { indexUrl } } }'),

  // ---- the engine's own Cloudflare helper (engineSolver.ts)
  /** An engine without these settings refuses this, and that is an answer: `supported: false`. */
  solverSettings: op('solverSettings', '{ settings { flareSolverrEnabled flareSolverrUrl } }', true),
  setSolverSettings: op('setSolverSettings', 'mutation($u:String!){ setSettings(input:{settings:{flareSolverrEnabled:true, flareSolverrUrl:$u}}){ settings { flareSolverrEnabled flareSolverrUrl } } }'),

  // ---- the page cache (cache.ts): pages only, ClearCachedImagesInput's own field
  clearCachedImages: op('clearCachedImages', 'mutation { clearCachedImages(input: { cachedPages: true }) { cachedPages } }'),

  // ---- an extension's own settings (prefs.ts)
  /** One source's preference screen, with the source and its extension's other sources. */
  sourcePreferences: op('sourcePreferences', `query($id:LongString!){ source(id:$id){ id name displayName lang
  extension { pkgName name source { nodes { id name displayName lang } } }
  preferences { ${PREF_SHAPES} } } }`),
  setSwitchPreference: op('setSwitchPreference', prefWrite('switchState', 'Boolean')),
  setCheckBoxPreference: op('setCheckBoxPreference', prefWrite('checkBoxState', 'Boolean')),
  setTextPreference: op('setTextPreference', prefWrite('editTextState', 'String')),
  setListPreference: op('setListPreference', prefWrite('listState', 'String')),
  setMultiSelectPreference: op('setMultiSelectPreference', prefWrite('multiSelectState', '[String!]')),
} as const satisfies Record<string, EngineOp>;

export type OpName = keyof typeof OPS;

/** Every document, once. */
export const ALL_OPS: readonly EngineOp[] = Object.freeze(Object.values(OPS));

const BY_DOC = new Map<string, EngineOp>(ALL_OPS.map((o) => [o.doc, o]));

/** The operation a document is, or undefined for one this registry does not hold (a test's own query). */
export const opOf = (doc: string): EngineOp | undefined => BY_DOC.get(doc);
