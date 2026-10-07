#!/usr/bin/env node
// Dependency-free fake AniList for the browser walks (v0.55.7, #168): AniList's GraphQL endpoint as the app asks it by
// title and by id, answering from a table of its own, so a walk never asks the real AniList anything.
//
//   node web/test/e2e/fakeAniList.mjs --port 28330 --host uchi-i557-anilist:28330
//
// In the rig it runs like the fake sources, with the repository mounted, on the instance's network (up.sh
// E2E_ANILIST=1), and the app gets ANILIST_API_URL=http://<container>:<port>/ -- the one address every AniList call
// goes to, the title lookups (bff lib/anilist.ts) and the tracker calls (lib/trackerProviders.ts) alike.
//
//   POST /   GraphQL, told apart by the query the app sends:
//            Media(search, type:MANGA)   the art lookup: the entry the table holds under that title, else 404 as
//                                        AniList answers a search with no match;
//            Media(search, type:ANIME)   the anime banner lookup: always 404;
//            Page(...) search            the Art picker's candidates: the table's entry for the title, if any;
//            Page(...) TRENDING_DESC     Discover's Trending rail: nothing;
//            Page(...) id_in             the online-match check (lib/matchCheck.ts) and the direction backfill: the
//                                        entries the table holds under those ids.
//            Anything else is AniList's 400.
// Control (never part of AniList's API):
//   GET /__log    every request answered: { kind, s?, ids?, status }
//   POST /__reset the log cleared
//   GET /media/…  the pictures the entries name: a small PNG. The app never fetches them -- they are on the rig's private
//                 network, which its cover fetch refuses (lib/ssrfGuard.ts) -- but a browser could.
import http from 'node:http';

const argv = new Map();
for (let i = 2; i < process.argv.length; i += 2) argv.set(process.argv[i], process.argv[i + 1]);
const PORT = Number(argv.get('--port') || 28140);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`bad --port ${PORT}`);
// Where the app reaches this server: the address the entries' pictures are named under.
const HOST = argv.get('--host') || `127.0.0.1:${PORT}`;

const picture = (kind, id) => `http://${HOST}/media/manga/${kind}/${kind === 'cover' ? 'large/bx' : ''}${id}-walk.png`;
/**
 * The entries, by the title the app asks for (folded: case and spaces aside). The walk's own folders (v557Walk.mjs
 * matches) name them: one that AniList's search answers with ANOTHER work -- @Kedryn's Morgan Lost, a comic with no
 * online source, given a manga's cover -- and one AniList knows by that very name.
 */
const ENTRIES = [
  {
    asked: ['walk morgan lost'],
    media: { id: 970001, title: { romaji: 'Dear Green: Hitomi no Ounowa', english: 'Dear Green', native: 'ディア・グリーン 瞳の追うは' },
      synonyms: [], countryOfOrigin: 'JP', type: 'MANGA' },
  },
  {
    asked: ['walk nightfall'],
    media: { id: 970002, title: { romaji: 'Walk Nightfall', english: 'Walk Nightfall', native: null },
      synonyms: ['Nightfall (Walk)'], countryOfOrigin: 'KR', type: 'MANGA' },
  },
];
const fold = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const bySearch = (s) => ENTRIES.find((e) => e.asked.includes(fold(s)))?.media ?? null;
const byId = (id) => ENTRIES.find((e) => e.media.id === Number(id))?.media ?? null;
/** An entry as the art lookup's query selects it (bff lib/anilist.ts QUERY). */
const asSearched = (m) => ({
  id: m.id, title: m.title, synonyms: m.synonyms, countryOfOrigin: m.countryOfOrigin,
  coverImage: { extraLarge: picture('cover', m.id), large: picture('cover', m.id) },
  bannerImage: picture('banner', m.id), relations: { edges: [] },
});
/** An entry as the by-id queries select it (ENTRIES and COUNTRIES in lib/anilist.ts). */
const asListed = (m) => ({ id: m.id, type: m.type, title: m.title, synonyms: m.synonyms, countryOfOrigin: m.countryOfOrigin, relations: { edges: [] } });

const log = [];
// A 1x1 PNG: the pictures, for a browser that asks.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}
async function bodyOf(req) {
  const parts = [];
  for await (const part of req) parts.push(part);
  return parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {};
}
const notFound = { errors: [{ message: 'Not Found.', status: 404, locations: [{ line: 1, column: 16 }] }], data: { Media: null } };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://anilist');
    if (url.pathname === '/__log') return sendJson(res, 200, log);
    if (url.pathname === '/__reset' && req.method === 'POST') { log.length = 0; return sendJson(res, 200, { ok: true }); }
    if (url.pathname.startsWith('/media/')) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
      return res.end(PNG);
    }
    if (req.method !== 'POST') return sendJson(res, 405, { errors: [{ message: 'POST only', status: 405 }] });
    const { query = '', variables = {} } = await bodyOf(req);
    const q = String(query);
    const answer = (kind, status, value, extra = {}) => { log.push({ kind, status, ...extra }); return sendJson(res, status, value); };
    if (/\bid_in\b/.test(q)) {
      const ids = Array.isArray(variables.ids) ? variables.ids : [];
      return answer('ids', 200, { data: { Page: { media: ids.map(byId).filter(Boolean).map(asListed) } } }, { ids });
    }
    if (/TRENDING_DESC/.test(q)) return answer('trending', 200, { data: { Page: { media: [] } } });
    if (/Page\(/.test(q) && /search:\$s/.test(q)) {
      const m = bySearch(variables.s);
      return answer('candidates', 200, { data: { Page: { media: m ? [{ title: m.title, coverImage: { extraLarge: picture('cover', m.id) }, bannerImage: picture('banner', m.id) }] : [] } } }, { s: variables.s });
    }
    if (/Media\(search:\$s,type:ANIME/.test(q)) return answer('anime', 404, notFound, { s: variables.s });
    if (/Media\(search:\$s,type:MANGA/.test(q)) {
      const m = bySearch(variables.s);
      return m ? answer('search', 200, { data: { Media: asSearched(m) } }, { s: variables.s }) : answer('search', 404, notFound, { s: variables.s });
    }
    return answer('other', 400, { errors: [{ message: 'The fake AniList does not answer this query', status: 400 }] });
  } catch (e) {
    sendJson(res, 500, { errors: [{ message: String(e?.message || e), status: 500 }] });
  }
});
server.listen(PORT, '0.0.0.0', () => console.log(`fake AniList on :${PORT} (pictures under ${HOST})`));
