// The visibility predicate must live in exactly one place.
//
// This test exists because centralising it once was not enough. `deleted_at IS NULL AND merged_into IS NULL`
// was already supposed to live in SERIES_SRC, and it still ended up hand-written into 23 query strings
// across 10 files -- and never reached the image server at all, so a hidden series' pages stayed readable by
// anyone with the book id.
//
// Per-library access is enforced by the same predicate. A 24th copy is not a style problem, it is a viewer
// seeing a library they were not granted, in a route nobody remembered to update. So: one copy, enforced by
// a test, and a new query that needs the rule has to go through visible() to get it.
//
// Pure static check. No database, no environment, runs everywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', 'src');

/** Where the predicate is allowed to appear, and why. */
const ALLOWED = new Map<string, string>([
  ['lib/visibility.ts', 'the one definition'],
  ['lib/migrate.ts', 'schema DDL and the orphan-quarantine migration, not a read path'],
]);

/**
 * Exact reviewed expressions, never whole route/module exemptions. Lifecycle
 * collision checks and scoped propagation are not catalog reads. Discover's
 * legacy shared held/count facts intentionally span shared grants; these two
 * callers retain the actual userId so visible() still excludes other owners'
 * private data, and nameableFor separately gates any disclosed IDs or names.
 *
 * Every entry must occur exactly once. A new query, broader viewer, removed
 * scopeSql clause or duplicated copy therefore still fails this contract.
 */
const REVIEWED = [
  {
    file:'routes/admin.ts', kind:'predicate',
    source:'WHERE s.id=${sid} AND s.work_id IS NOT NULL AND o.merged_into IS NULL AND o.deleted_at IS NULL AND ${scoped}',
    why:'linkImportedSeries: exact scopeSql(o,authoritative AddScope) constrains sibling tracker propagation; active-row lifecycle check, not a viewer catalog',
  },
  {
    file:'routes/privateLibrary.ts', kind:'predicate',
    source:'AND (folder=$3 OR (source_id=$4 AND source_series_id=$5 AND merged_into IS NULL AND deleted_at IS NULL)) LIMIT 1',
    why:'owner-only, leased transactional privacy move rejects occupied destinations, including rows the caller cannot browse; visible() would miss conflicts',
  },
  {
    file:'routes/admin.ts', kind:'predicate',
    source:'WHERE t.provider = ${providerParam} AND t.external_id = ANY(${ids}) AND (t.linked_by IS NOT NULL OR t.checked_at IS NOT NULL) AND s.deleted_at IS NULL AND s.merged_into IS NULL AND ${scoped}',
    why:'seriesLinkedTo: import identity matching is confined by exact authoritative scopeSql; lifecycle excludes removed/absorbed matches',
  },
  {
    file:'routes/admin.ts', kind:'predicate',
    source:'WHERE ${linkedScope} AND s.deleted_at IS NULL AND s.merged_into IS NULL AND',
    why:'owned import batch linked flag uses explicit per-candidate owner/private-or-shared library scope; no title/ID content is returned by this EXISTS',
  },
  {
    file:'routes/admin.ts', kind:'predicate',
    source:'SELECT s.id FROM lib_series s WHERE s.folder=${folder} AND ${scoped} AND s.deleted_at IS NULL AND s.merged_into IS NULL LIMIT 1',
    why:'seriesIdOf: internal add result is resolved only in its exact AddScope before attaching tracker/floor provenance',
  },
  {
    file:'routes/admin.ts', kind:'predicate',
    source:'SELECT s.id FROM lib_series s WHERE s.title=${title} AND s.source=${source} AND ${scoped} AND s.deleted_at IS NULL AND s.merged_into IS NULL LIMIT 1',
    why:'seriesIdOf duplicate fallback retains exact AddScope and excludes removed/absorbed rows; no global title-based merge is allowed',
  },
  {
    file:'lib/discoverIdentity.ts', kind:'viewer',
    source:'visibleIds(ids, {...ctx,libraryIds:null,maxAgeRating:null,hideAdultLibraries:false})',
    why:'shared duplicate facts keep legacy scope while real caller identity remains mandatory for private ownership; disclosed IDs/names still use request nameability',
  },
  {
    file:'routes/sources.ts', kind:'viewer',
    source:"visible('s',{...vc(req),libraryIds:null,maxAgeRating:null},usedParams)",
    why:'shared source usage counts retain legacy ranking facts while visible() uses the actual request user for private ownership',
  },
];

function reviewedBody(rel:string, body:string, kind:'predicate'|'viewer'):string {
  for (const reviewed of REVIEWED.filter(r=>r.file===rel && r.kind===kind)) {
    const first=body.indexOf(reviewed.source);
    assert.ok(first>=0,`stale reviewed exception (${reviewed.why})`);
    assert.equal(body.indexOf(reviewed.source,first+reviewed.source.length),-1,`duplicated reviewed expression (${reviewed.why})`);
    body=body.replace(reviewed.source,'/* exact reviewed lifecycle/facts expression */');
  }
  return body;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('the visibility predicate is written in exactly one place', () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const rel = file.slice(SRC.length + 1);
    if (ALLOWED.has(rel)) continue;
    const body = reviewedBody(rel,readFileSync(file, 'utf8'),'predicate');
    // Match the shape rather than one exact spelling, so a reformatted copy is still caught.
    if (/deleted_at\s+IS\s+NULL/i.test(body)) {
      const line = body.split('\n').findIndex((l) => /deleted_at\s+IS\s+NULL/i.test(l)) + 1;
      offenders.push(`${rel}:${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'These files write the visibility predicate by hand instead of calling visible() from lib/visibility.\n' +
      'That is how a hidden series kept rendering its cover, and it is how a restricted library would leak.\n' +
      'Offenders:\n  ' + offenders.join('\n  '),
  );
});

test('nothing outside visibility.ts fabricates a viewer that sees everything', () => {
  // SYSTEM_CTX is legitimate for the scanner and the pre-warmer, but an inline `{ libraryIds: null }`
  // written at a call site is how a route quietly opts itself out of the rule.
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const rel = file.slice(SRC.length + 1);
    if (rel === 'lib/visibility.ts') continue;
    const body = reviewedBody(rel,readFileSync(file, 'utf8'),'viewer');
    if (/libraryIds\s*:\s*null/.test(body)) {
      const line = body.split('\n').findIndex((l) => /libraryIds\s*:\s*null/.test(l)) + 1;
      offenders.push(`${rel}:${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'Build a viewer with viewCtxFor(), or use SYSTEM_CTX and say why. Offenders:\n  ' + offenders.join('\n  '),
  );
});

/**
 * Every route that serves library bytes must be accounted for.
 *
 * The image server and OPDS are the two places that hand out actual content, and both were completely
 * unguarded: /img/lib/books/:id/page/:n returned raw page bytes from a bare book id, and /opds/book/:id/file
 * streamed a whole CBZ the same way. Neither had ever had a visibility check, and nothing would have
 * noticed a new sibling route arriving in the same state.
 *
 * So each one is listed here with a note saying how it is gated. Adding a route without touching this list
 * fails the build, which forces the question to be answered at review time rather than discovered later.
 */
const GATED: Record<string, string> = {
  // images.ts
  '/img/series/:id/thumb': 'komga-mode passthrough; owned ids dispatch to serveLibSeriesThumb',
  '/img/books/:id/thumb': 'komga-mode passthrough; owned ids dispatch to serveLibBookThumb',
  '/img/books/:id/page/:n': 'komga-mode passthrough; owned ids dispatch to serveLibBookPage',
  // This note used to read "backdropRecipe takes the request viewer", and that was not a gate. The ctx is
  // consulted only inside backdropRecipe's FALLBACK path, so whenever series_art holds a banner -- the normal
  // state, since AniList art is fetched lazily for every series -- the image was produced from that URL with
  // no series join at all, and an age-capped account could render key art for a series it cannot open.
  '/img/series/:id/backdrop': 'seriesVisible check at the top of the route, like its thumb sibling',
  '/img/series/:id/logo': 'standard image authentication and seriesVisible before reading the selected local logo',
  // v0.51.0: the banner made from a series' own pages. The cover's gate first, then the series' own eligibility
  // (no real banner, not 18+ by any rule, autoHeroFor) -- both before the cache, which would answer a warm key alone.
  '/img/series/:id/hero': 'seriesVisible check at the top of the route, like its thumb sibling; then autoHeroFor',
  '/img/lib/series/:id/thumb': 'seriesVisible check at the top of serveLibSeriesThumb',
  '/img/lib/books/:id/thumb': 'bookFileAbs -> visibleBookFile',
  '/img/lib/books/:id/page/:n': 'bookFileAbs -> visibleBookFile',
  '/img/series/:id/copy-page': 'admin-only (role read at the top of the route); the copy must be in the series\' own listing (copyPageList)',
  '/img/extensions/icon/:pkgName': 'n/a: extension icon from the engine, not library content',
  '/img/sources/cover': 'n/a: remote source cover, not library content',
  '/img/sources/preview': 'no library content; mayDownload + previewPageList (no age limit, disabled/cooldown refused, chapter by number from the server\'s own listing, page by index) and the guarded fetcher (preview.int.test.ts)',
  // The id is looked up in the source registry before anything is fetched, so the outbound URL comes from
  // the operator's own configured sources and never from the request -- a caller cannot point this at an
  // address of their choosing. No library content is involved either way.
  '/img/sources/icon/:id': 'n/a: source icon, resolved only from a registered source; not library content',
  // opds.ts
  // v0.61.0: no longer static -- the reader's own root, with an entry per List they may read.
  '/opds': "listsFor(uid, vc(req), 'all'): the reader's own Lists and shared ones that show this token a series; names and counts only",
  '/opds/search': 'seriesSrc(vc(req)) via seriesFeed, the same handler as /opds/series',
  '/opds/opensearch.xml': 'n/a: OpenSearch descriptor document, no library data',
  '/opds/series': 'seriesSrc(vc(req))',
  '/opds/series/:id': 'seriesSrc(vc(req)) for the series, booksSrc join for its chapters',
  '/opds/book/:id/file': 'visibleBookFile(vc(req))',
  '/opds/book/:id/page/:n': 'visibleBookFile(vc(req)); zero-based page for OPDS-PSE readers',
  // v0.61.0, the reader's own shelves (opdsShelves.int.test.ts).
  '/opds/continue': "onDeckPicks(uid, vc(req)), browsable() in its SQL; the chapter rows through a visible('s', vc(req)) join",
  '/opds/favorites': "seriesSrc(vc(req)) joined to this reader's favorites",
  '/opds/lists/:id': 'listFor (own or shared, uuid-checked; 404 when it shows this token nothing), listItems through vc(req), rows through seriesSrc(vc(req))',
};

test('every image and OPDS route says how it is gated', () => {
  const found = new Set<string>();
  for (const file of ['routes/images.ts', 'routes/opds.ts']) {
    const body = readFileSync(join(SRC, file), 'utf8');
    for (const m of body.matchAll(/app\.(?:get|post)\(\s*'(\/(?:img|opds)[^']*)'/g)) found.add(m[1]);
  }
  const ungated = [...found].filter((r) => !(r in GATED)).sort();
  assert.deepEqual(
    ungated,
    [],
    'These routes serve library content and are not listed in GATED. Say how each is gated (or why it does\n' +
      'not need to be) in test/predicateHygiene.test.ts. Unlisted:\n  ' + ungated.join('\n  '),
  );

  const stale = Object.keys(GATED).filter((r) => !found.has(r)).sort();
  assert.deepEqual(stale, [], 'GATED lists routes that no longer exist:\n  ' + stale.join('\n  '));
});
