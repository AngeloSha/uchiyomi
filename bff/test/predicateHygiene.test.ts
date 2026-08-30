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
    const body = readFileSync(file, 'utf8');
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
    const body = readFileSync(file, 'utf8');
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
  '/img/lib/series/:id/thumb': 'seriesVisible check at the top of serveLibSeriesThumb',
  '/img/lib/books/:id/thumb': 'bookFileAbs -> visibleBookFile',
  '/img/lib/books/:id/page/:n': 'bookFileAbs -> visibleBookFile',
  '/img/extensions/icon/:pkgName': 'n/a: extension icon from the engine, not library content',
  '/img/sources/cover': 'n/a: remote source cover, not library content',
  // The id is looked up in the source registry before anything is fetched, so the outbound URL comes from
  // the operator's own configured sources and never from the request -- a caller cannot point this at an
  // address of their choosing. No library content is involved either way.
  '/img/sources/icon/:id': 'n/a: source icon, resolved only from a registered source; not library content',
  // opds.ts
  '/opds': 'n/a: static navigation feed, no library data',
  '/opds/search': 'seriesSrc(vc(req)) via opdsSeriesSearch',
  '/opds/opensearch.xml': 'n/a: OpenSearch descriptor document, no library data',
  '/opds/series': 'seriesSrc(vc(req))',
  '/opds/series/:id': 'seriesSrc(vc(req)) for the series, booksSrc join for its chapters',
  '/opds/book/:id/file': 'visibleBookFile(vc(req))',
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
