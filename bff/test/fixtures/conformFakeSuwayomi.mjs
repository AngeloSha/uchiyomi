#!/usr/bin/env node
// Hold the fake engine against a real one: the same requests to both, the answers compared.
//
//   node bff/test/fixtures/conformFakeSuwayomi.mjs http://127.0.0.1:4567
//
// ⚠️ A THROWAWAY engine of the pinned image only, started fresh (see captureSuwayomiSchema.mjs for the two
// docker commands). Nothing here changes anything that matters -- the writes are refused by validation, hit a
// missing id, or fail the engine's own checks -- but it is still not something to point at a library.
//
// The battery is the part of the engine that does not depend on what is installed: how every kind of bad query
// is refused (rule name, wording, location), how a failing fetcher and a null non-null field are reported, how
// variables are coerced, and the built-in Local source. Messages are compared up to the "\r\n\r\n" that starts
// the engine's stack trace; the frames themselves are the JVM's, and the fake only imitates their shape.
// Exits 1 when any answer differs. On v2.3.2243 (2026-09-27): every case identical.
import { startFakeEngine } from './fakeSuwayomiEngine.mjs';

const REAL = (process.argv[2] || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(REAL)) {
  console.error('usage: conformFakeSuwayomi.mjs <throwaway engine base url>');
  process.exit(2);
}

const BATTERY = [
  // validation: fields, arguments, input objects, enums, types, leaves, fragments, directives, operations
  { query: '{ sources { nodes { id name bogus } } }' },
  { query: '{ sources(bogusArg: 1) { nodes { id } } }' },
  { query: '{ aboutServer { name(x: 1) } }' },
  { query: 'query($x: NoSuchType){ sources { nodes { id } } }' },
  { query: '{ sources { nodes } }' },
  { query: '{ aboutServer }' },
  { query: '{ sources { nodes { id displayName { x } } } }' },
  { query: 'mutation { fetchSourceManga { mangas { id } } }' },
  { query: 'mutation { fetchSourceManga(input:{source:"0",type:SEARCH}) { mangas { id } } }' },
  { query: 'mutation { fetchSourceManga(input:{source:"999",type:BOGUS,page:1}) { mangas { id } } }' },
  { query: 'mutation { fetchSourceManga(input:{source:"999",type:SEARCH,page:1,bogus:1}) { mangas { id } } }' },
  { query: 'mutation { fetchSourceManga(input:{source:"0",type:POPULAR,page:"1"}) { mangas { id } } }' },
  { query: 'mutation { fetchSourceManga(input:{source:"0",type:POPULAR,page:1,query:5}) { mangas { id } } }' },
  { query: 'mutation { fetchSourceManga(input:{source:"0",type:POPULAR,page:1.5}) { mangas { id } } }' },
  { query: 'mutation { fetchSourceManga(input:5) { mangas { id } } }' },
  { query: '{ source(id: 0) { id } }' },
  { query: '{ source(id: null) { id } }' },
  { query: 'mutation($s:String!){ fetchSourceManga(input:{source:$s,type:POPULAR,page:1}) { mangas { id } } }', variables: { s: '0' } },
  { query: 'query($a: Int = "x") { aboutServer { name } }' },
  { query: 'query($v: [String!]) { aboutServer { name } }' },
  { query: '{ sources { nodes { id ...F } } } fragment F on SourceType { name bogus }' },
  { query: '{ sources { nodes { id ... on ExtensionType { pkgName } } } }' },
  { query: '{ sources { nodes { ...G } } }' },
  { query: '{ sources { nodes { id } } } fragment U on SourceType { id }' },
  { query: '{ source(id:"0") { preferences { ... on SwitchPreference { key bogus } } } }' },
  { query: '{ source(id:"0") { preferences { key } } }' },
  { query: '{ source(id: "0") { preferences { ... on NoSuch { key } } } }' },
  { query: '{ source(id: "0") { preferences { ... on String { key } } } }' },
  { query: '{ sources { nodes { id @bogus } } }' },
  { query: '{ sources { nodes { id } } } query Two { aboutServer { name } }' },
  { query: '{ sources { nodes { id } }' },
  // variables
  { query: 'mutation($s:LongString!){ fetchSourceManga(input:{source:$s,type:SEARCH,page:1}) { mangas { id } } }', variables: {} },
  { query: 'mutation($p:Int!){ fetchSourceManga(input:{source:"999",type:POPULAR,page:$p}) { mangas { id } } }', variables: { p: '1' } },
  { query: 'mutation($s:LongString!){ fetchSourceManga(input:{source:$s,type:POPULAR,page:1}) { mangas { id } } }', variables: { s: 0 } },
  { query: 'mutation($t:FetchSourceMangaType!){ fetchSourceManga(input:{source:"999",type:$t,page:1}) { mangas { id } } }', variables: { t: 'BOGUS' } },
  { query: 'mutation($i:FetchSourceMangaInput!){ fetchSourceManga(input:$i) { mangas { id } } }', variables: { i: { source: '0', type: 'POPULAR', page: 1, extra: 1 } } },
  // execution: failing fetchers, null non-null fields, operation choice, aliases, directives
  { query: 'mutation { fetchSourceManga(input:{source:"999",type:SEARCH,page:1}) { mangas { id } } }' },
  { query: 'mutation($id:Int!){ fetchManga(input:{id:$id}){ manga { id } } }', variables: { id: 999 } },
  { query: 'mutation($mangaId:Int!){ fetchChapters(input:{mangaId:$mangaId}){ chapters { id } } }', variables: { mangaId: 999 } },
  { query: 'mutation($chapterId:Int!){ fetchChapterPages(input:{chapterId:$chapterId}){ pages } }', variables: { chapterId: 999 } },
  { query: 'mutation($s:LongString!,$p:Int!){ updateSourcePreference(input:{source:$s,change:{position:$p,switchState:true}}){ preferences { __typename } source { id } } }', variables: { s: '0', p: 0 } },
  { query: 'mutation { setSettings(input:{settings:{maxSourcesInParallel: -5}}) { settings { maxSourcesInParallel } } }' },
  { query: '{ chapter(id: 999) { id } }' },
  { query: '{ manga(id: 999) { id } aboutServer { name } }' },
  { query: '{ source(id: "999") { id } }' },
  { query: '{ extension(pkgName: "nope.pkg") { pkgName } }' },
  { query: 'mutation{ updateExtension(input:{id:"nope.pkg",patch:{install:true}}){ extension { pkgName } } }' },
  { query: 'query Q1 { aboutServer { name } } query Q2 { aboutServer { version } }' },
  { query: 'query Q1 { aboutServer { name } } query Q2 { aboutServer { version } }', operationName: 'Q2' },
  { query: 'query Q1 { aboutServer { name } }', operationName: 'Nope' },
  { query: '{ a: aboutServer { name } b: aboutServer { version } }' },
  { query: '{ aboutServer { name @skip(if: true) version @include(if: false) revision } }' },
  { query: '{ ... on Query { aboutServer { name } } }' },
  { query: 'query { __typename sources { __typename } }' },
  { query: '{ aboutServer { __typename name version revision } }' },
  // clearCachedImages (the page-cache keeper, lib/sources/suwayomi/cache.ts): what it answers, and how it refuses
  { query: 'mutation { clearCachedImages(input:{cachedPages:true}) { cachedPages cachedThumbnails downloadedThumbnails clientMutationId } }' },
  { query: 'mutation { clearCachedImages(input:{cachedPages:true, clientMutationId:"u"}) { cachedPages clientMutationId } }' },
  { query: 'mutation { clearCachedImages(input:{cachedPages:false}) { cachedPages cachedThumbnails downloadedThumbnails } }' },
  { query: 'mutation { clearCachedImages(input:{}) { cachedPages cachedThumbnails downloadedThumbnails } }' },
  { query: 'mutation($i:ClearCachedImagesInput!){ clearCachedImages(input:$i) { cachedPages } }', variables: { i: { cachedPages: true } } },
  { query: 'mutation { clearCachedImages(input:{cachedPage:true}) { cachedPages } }' },
  { query: 'mutation { clearCachedImages { cachedPages } }' },
  { query: 'mutation { clearCachedImages(input:{cachedPages:true}) }' },
  { query: 'mutation { clearCachedImages(input:{cachedPages:"yes"}) { cachedPages } }' },
  // the built-in Local source, present on every engine
  { query: '{ source(id: "0") { id name displayName lang iconUrl isNsfw supportsLatest baseUrl isConfigurable contentWarning homeUrl preferences { __typename } extension { pkgName name } } }' },
  'not json',
];

const fake = await startFakeEngine();
const post = async (base, body) => {
  const r = await fetch(`${base}/api/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { return { status: r.status, body: text }; }
  const out = { status: r.status };
  if ('data' in j) out.data = j.data;
  if (j.errors) {
    out.errors = j.errors.map((e) => ({ message: e.message.split('\r\n')[0], locations: e.locations, path: e.path, extensions: e.extensions }));
  }
  return out;
};

let differ = 0;
for (const body of BATTERY) {
  const real = JSON.stringify(await post(REAL, body));
  const ours = JSON.stringify(await post(fake.url, body));
  if (real === ours) continue;
  differ++;
  console.log(`DIFFERS: ${typeof body === 'string' ? body : body.query}`);
  console.log(`  engine: ${real}`);
  console.log(`  fake:   ${ours}`);
}
await fake.close();
console.log(`${BATTERY.length - differ} of ${BATTERY.length} identical`);
process.exit(differ ? 1 : 0);
