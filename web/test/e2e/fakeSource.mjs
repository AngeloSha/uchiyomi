#!/usr/bin/env node
// Dependency-free HTTP source used only by the browser walks (v0.40 onwards).
//
//   node fakeSource.mjs --name fake-a --port 18150 [--extra v42,v49,v54] [--cloudflare yes]
//
// Control it with POST /__script {chapter,page,behaviour}; chapter may be a chapter id, a chapter number
// (shorthand for walk-tale-N), a SERIES id (for `omit:`), "search" with page 0, or "site" with page 0 (for
// `offline`). GET /__log returns every source request with start and finish timestamps. POST /__reset clears
// scripts, counters and the log.
//
// The behaviours, and which route reads each one:
//   ok, tiny-webp, 404, slow:<ms>, 429:after=<n>,retryAfter=<s>   /img (and slow: also /search)
//   429                                                           /img, EVERY request, forever
//   short:<n>                                                     /pages (n urls) AND /chapters (pages: n)
//   omit:<a>-<b>                                                  /chapters (those numbers are not listed)
//   error                                                         /search only ("search", page 0): HTTP 500, so
//                                                                 the adapter throws -- #115's failing Search stage
//   offline                                                       EVERY source route ("site", page 0): HTTP 200
//                                                                 text/html, the site's own small "Fake A is
//                                                                 temporarily offline" page, shaped like the one
//                                                                 aqua has served since 2026-09-23 (v0.49.1's
//                                                                 walk491). `ok` on "site" brings the site back.
//   pages-error                                                   /pages only ("site", page 0): HTTP 500 for every
//                                                                 chapter's page list while search and chapter lists
//                                                                 answer -- the owner's AllManga (v0.55.1), whose page
//                                                                 lists timed out in the engine's WebView for days.
//
// --cloudflare yes (v0.55.3, up.sh's E2E_SOLVERS=1, for the backup solver's walk): the site behind a fake Cloudflare.
// Every request without a solver's `cf_clearance` cookie gets the challenge page (403, logged as route `challenge`);
// with one, the site answers as it always does, its root (`/`, a small home page) included, and each log row carries
// the clearance it came with (`clearance`, the solver's name, and `ua`): the app's own image fetches must send the pair
// of the solver that solved this server (bff lib/sources/flaresolverr.ts cfSession).
//
// ⚠️ `offline` answers 200 on purpose, and in HTML: that is what made aqua hard to see. The adapter (bff
// lib/sources/fake.ts) hands such a page to the product's own offlineNotice, which accepts it only while it is
// small (under 8 KB), says so in its <title> or first <h1>, and carries none of the stub's JSON. The control
// routes (/__script, /__log, /__reset) keep answering, and the log records each request as route `offline`.
//
// ⚠️ `short:` has to change BOTH routes. The downloader takes `expected = max(urls.length, chapter.pages)`
// (lib/downloader.ts), so a listing that still declares twelve pages while /pages hands back two makes an
// incomplete chapter that is never written -- and the v0.41 walk needs a two-page chapter to actually land.
// ⚠️ `429` is bare on purpose, and separate from `429:after=…`: that one fires ONCE per (chapter, page) and
// then lets the resume through, which is what v0.40's "a 429 is survivable" step needs. A chapter that must
// be REFUSED across two whole sweeps -- v0.41's persistent-refusal hunt -- needs a source that keeps saying
// no however often it is asked, including after POST /__script has cleared the one-shot flags.
import http from 'node:http';
import { deflateSync } from 'node:zlib';

const argv = new Map();
for (let i = 2; i < process.argv.length; i += 2) argv.set(process.argv[i], process.argv[i + 1]);
const NAME = argv.get('--name') || 'fake-a';
const PORT = Number(argv.get('--port') || 18150);
const CLOUDFLARE = argv.get('--cloudflare') === 'yes';
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`bad --port ${PORT}`);

// ⚠️ "Walk Gap" runs to 14, not 12, and both fakes carry all fourteen: the walk punches its hole with
// `omit:6-8` on fake-a, which leaves ELEVEN listed numbers, and judgeCandidate (lib/autoFollow.ts) only
// judges an exact title one way once the primary lists ONE_WAY_MIN_LISTED = 10. At twelve chapters the
// same hole leaves nine, the judgement goes both ways, and 9 of the candidate's 12 numbers is 0.75 --
// under MIN_COVERAGE, so the source that can fill the gap is refused as `numbering_differs` and the gap
// step has nothing to follow. The failure looks exactly like a bug in `wants`, so the margin is here.
// ⚠️ `walk-quote` is opt-in (`--extra v42`) and its title is the point: a curly apostrophe and an en dash,
// neither of which a keyboard produces, which is what the v0.42.0 walk types a straight-quoted version of
// into Remove / Delete files / Forget (issue #66). Gated because the v0.40 walk folds search results by
// title and asserts the order of the wall, and neither earlier walk should grow a series it never asked for.
// ⚠️ `walk-istrevelia` is opt-in the same way (`--extra v49`; extras combine as `--extra v42,v49`): issue #116's
// shape, 226 posts on 13 numbers the way the Webtoons extension numbers Istrevelia, each carrying its posting
// `order`, and post ids (`walk-istrevelia-<k>`, k = the post's place) rather than number ids, because many
// posts share a number. The shape comes from the fake extension engine (bff/test/fixtures/fakeSuwayomiEngine.mjs)
// so both rigs serve ONE Istrevelia, and it is imported only when asked for: the walks before v0.49 load
// nothing new and see exactly the series they always did.
const EXTRA = new Set(String(argv.get('--extra') || '').split(',').map((e) => e.trim()).filter(Boolean));
async function istreveliaShaped() {
  const { istreveliaPosts, webtoonsNumbers } = await import('../../../bff/test/fixtures/fakeSuwayomiEngine.mjs');
  const posts = istreveliaPosts();
  const numbered = webtoonsNumbers(posts, false);
  return posts.map((p, i) => ({ k: i + 1, number: numbered[i].chapterNumber, title: numbered[i].name.trim(), publishedAt: new Date(p.uploadDate).toISOString() }));
}
const POSTS = EXTRA.has('v49') ? await istreveliaShaped() : null;
// ⚠️ The `swap-*` series are opt-in too (`--extra v54`, on BOTH fakes): replaceWalk.mjs's (v0.54.0, Replace a source).
// One set per pass (phone, wide, arabic), each of four series a pass moves off fake-a in its own way: one that follows
// fake-b (moved at once), one moved by hand from its Sources sheet (Make main), one numbered by posting order (left
// alone, and Make main refused), and one that follows nothing (searched for, and found on fake-b). Twelve chapters
// each, as Walk Tale has: a primary listing ten or more numbers is judged one way (lib/autoFollow.ts), so fake-b's
// copy lines up. Gated for the same reason as walk-quote: the older walks see exactly the series they always did.
const SWAPS = EXTRA.has('v54')
  ? ['phone', 'wide', 'arabic'].flatMap((pass) => ['follow', 'main', 'posting', 'search'].map((role) => ({
    sourceId: `swap-${role}-${pass}`, title: `Swap ${role[0].toUpperCase()}${role.slice(1)} ${pass[0].toUpperCase()}${pass.slice(1)}`, first: 1, last: 12,
  })))
  : [];
// ⚠️ The `fix-*` series are opt-in too (`--extra v55`, on BOTH fakes): autofixWalk.mjs's (v0.55.0, Health's Fix
// everything), one per thing the run is to fix or leave. Fix Backup and Fix Search are added from fake-a, which then
// goes offline (Replace moves one to the fake-b it follows, and finds the other on fake-b); the rest are fake-b's: two
// copies of one series under two titles (Twin Walk, Twin Walk Again), one series in two languages, the chapters a
// later split saves twice, the impossible numbers, two series numbered by posting order -- twelve posts on two numbers
// each, the smallest listing the detector calls strong (lib/postingOrder.ts SHARED_NUMBERING) -- a gap no source here
// lists (Gap Only: fake-b serves it, and the walk scripts `omit:6-7` on it; the fake engine's Gap Scans has all
// twelve), and two chapters that fail (one before the runs, one after). Twelve chapters where a search must judge them (a primary listing ten or more
// numbers is judged one way, lib/autoFollow.ts). Gated as the others are: the older walks see what they always did.
const FIX_POSTS = Array.from({ length: 12 }, (_, i) => ({
  k: i + 1, number: i < 6 ? 1 : 2, title: `E${i < 6 ? 1 : 2} - Page ${i + 1}`, publishedAt: new Date(Date.UTC(2025, 0, i + 1)).toISOString(),
}));
const FIXES = EXTRA.has('v55')
  ? [
    { sourceId: 'fix-backup', title: 'Fix Backup', first: 1, last: 12 },
    { sourceId: 'fix-search', title: 'Fix Search', first: 1, last: 12 },
    { sourceId: 'twin-walk', title: 'Twin Walk', first: 1, last: 12 },
    { sourceId: 'twin-again', title: 'Twin Walk Again', first: 1, last: 12 },
    { sourceId: 'edition-en', title: 'Edition Walk', first: 1, last: 12 },
    { sourceId: 'edition-es', title: 'Edición Walk', first: 1, last: 12 },
    { sourceId: 'twice-walk', title: 'Twice Walk', first: 1, last: 6 },
    { sourceId: 'twice-short', title: 'Twice Short', first: 1, last: 8 },
    { sourceId: 'odd-walk', title: 'Odd Walk', first: 1, last: 4 },
    { sourceId: 'odd-mark', title: 'Odd Mark', first: 1, last: 4 },
    { sourceId: 'num-clean', title: 'Number Clean', first: 1, last: FIX_POSTS.length, posts: FIX_POSTS },
    { sourceId: 'num-held', title: 'Number Held', first: 1, last: FIX_POSTS.length, posts: FIX_POSTS },
    { sourceId: 'gap-only', title: 'Gap Only', first: 1, last: 12 },
    { sourceId: 'fail-walk', title: 'Fail Walk', first: 1, last: 4 },
    // Added after the runs, its chapter 4 refused: the failure Let me choose's safe repair then retries.
    { sourceId: 'fail-late', title: 'Fail Late', first: 1, last: 4 },
  ]
  : [];
// ⚠️ v0.55.1: what the owner's first Fix everything run met, for autofixWalk.mjs, each series on the fakes that serve it
// alone (fake-c and fake-d are `--extra v551`, started by up.sh beside the v55 pair): fake-c answers searches and
// chapter lists and refuses Limit Walk's images with 429 (Mangakakalot); fake-d's page lists fail (AllManga), and Moved
// Walk -- on fake-c too -- is what an earlier run moved onto it; fake-d also lists Fix Search, which Replace must never
// move there. fake-b carries Limit Walk as well, and Pop Walk, which the walk then leaves with no source at all (only an
// extension carries it, the fifth by popularity). Twelve chapters each: a search judges them one way.
const OWNER = [
  ...(EXTRA.has('v55') && NAME === 'fake-b' ? [{ sourceId: 'limit-walk', title: 'Limit Walk', first: 1, last: 12 }, { sourceId: 'pop-walk', title: 'Pop Walk', first: 1, last: 12 }] : []),
  ...(EXTRA.has('v551') && NAME === 'fake-c' ? [{ sourceId: 'limit-walk', title: 'Limit Walk', first: 1, last: 12 }, { sourceId: 'moved-walk', title: 'Moved Walk', first: 1, last: 12 }] : []),
  ...(EXTRA.has('v551') && NAME === 'fake-d' ? [{ sourceId: 'moved-walk', title: 'Moved Walk', first: 1, last: 12 }, { sourceId: 'fix-search', title: 'Fix Search', first: 1, last: 12 }] : []),
];
// ⚠️ v0.56.0 (`--extra v56`, on BOTH fakes): v560Walk.mjs's Discover. One series the two fakes name differently (the fake
// AniList knows both names), and one the walk adds to the library and then expects to be gone from the wall.
const DISCOVER = EXTRA.has('v56')
  ? [
    NAME === 'fake-a' ? { sourceId: 'disc-solo', title: 'Disc Solo Leveling', first: 1, last: 12 } : { sourceId: 'disc-only', title: 'Disc Only I Level Up', first: 1, last: 12 },
    { sourceId: 'disc-held', title: 'Disc Held Tale', first: 1, last: 12 },
  ]
  : [];
const SERIES = [
  { sourceId: 'walk-tale', title: 'Walk Tale', first: 1, last: 12 },
  { sourceId: 'walk-gap', title: 'Walk Gap', first: 1, last: 14 },
  ...(NAME === 'fake-b' ? [{ sourceId: 'walk-tale-next', title: 'Walk Tale: Next', first: 13, last: 40 }] : []),
  ...(EXTRA.has('v42') ? [{ sourceId: 'walk-quote', title: 'Ren’s Walk – Notes', first: 1, last: 3 }] : []),
  // first/last count POSTS here, which is what chapterFromId checks a post id against.
  ...(POSTS ? [{ sourceId: 'walk-istrevelia', title: 'Walk Istrevelia', first: 1, last: POSTS.length, posts: POSTS }] : []),
  ...SWAPS,
  ...FIXES,
  ...OWNER,
  ...DISCOVER,
];
const byId = new Map(SERIES.map((s) => [s.sourceId, s]));

// A genuine lossy WebP slice, generated once from a nearly-white 800x25 image. It is intentionally 108 B:
// below the downloader's 256 B soft floor, yet decodable by sharp with non-zero dimensions.
const TINY_WEBP = Buffer.from('UklGRmQAAABXRUJQVlA4IFgAAABwCACdASogAxkAP3G42GW0rqsnIGgCkC4JaW7hdfAAO6HVUmyYh1VJsmIdVSbJiHVUmyYh1VJsmIdVSbJiHVUmyYh1VJsmIdVSbIIAAP7+/AAAAAAAAAAA', 'base64');

// PNG generation stays in this process: every normal page is a real, deterministic 24x24 RGB PNG and is
// comfortably over 300 B. The noisy pixels keep zlib from collapsing the fixture below the old body floor.
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const name = Buffer.from(type);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); name.copy(out, 4); data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return out;
};
function png(seed) {
  const width = 24, height = 24;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let x = (seed * 0x9e3779b1) >>> 0, at = 0;
  for (let y = 0; y < height; y++) {
    raw[at++] = 0;
    for (let col = 0; col < width; col++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      raw[at++] = 40 + (x & 0xbf);
      raw[at++] = 40 + ((x >>> 8) & 0xbf);
      raw[at++] = 40 + ((x >>> 16) & 0xbf);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const out = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  if (out.length < 300) throw new Error(`PNG fixture compressed below the body floor: ${out.length} B`);
  return out;
}
const pages = Array.from({ length: 12 }, (_, i) => png(i + (NAME === 'fake-b' ? 100 : 1)));

// The `offline` page: a notice and a card with a Discord link, no theme and no data -- a few hundred bytes, as aqua's
// is. "Fake A" is the stub's own name ("fake-a") the way a site names itself.
const SITE_NAME = NAME.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const OFFLINE_PAGE = Buffer.from(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${SITE_NAME} is temporarily offline</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111317;color:#e8e8e8;font:16px/1.5 system-ui,sans-serif}.card{max-width:26rem;margin:1rem;padding:2rem;border-radius:14px;background:#1b1e25;text-align:center}.card a{color:#8ab4ff}</style>
</head>
<body>
<div class="card">
<h1>${SITE_NAME} is temporarily offline</h1>
<p>We are working on the site. News and updates are on our Discord.</p>
<p><a href="https://discord.gg/${NAME}" rel="nofollow noopener">Join us on Discord</a></p>
</div>
</body>
</html>
`);

// The fake Cloudflare's challenge, as Cloudflare words it (--cloudflare yes): what a request with no clearance gets.
const CHALLENGE_PAGE = Buffer.from('<!doctype html><html><head><title>Just a moment...</title></head><body>'
  + '<h1>Checking your browser before accessing the site.</h1><div id="cf-chl-widget"></div></body></html>');

const scripts = new Map();
const requestCounts = new Map();
const log = [];
let sequence = 0;
const keyOf = (chapter, page) => `${chapter}|${page}`;
const normalChapter = (value) => /^\d+(?:\.\d+)?$/.test(String(value)) ? `walk-tale-${value}` : String(value);
const behaviourFor = (chapter, page) => scripts.get(keyOf(chapter, page)) ?? scripts.get(keyOf(chapter, 0)) ?? 'ok';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chapterFromId(id) {
  for (const s of SERIES) {
    const lead = `${s.sourceId}-`;
    if (!id.startsWith(lead)) continue;
    const number = Number(id.slice(lead.length));
    if (Number.isFinite(number) && number >= s.first && number <= s.last) return { series: s, number };
  }
  return null;
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}
function sendBytes(res, status, type, body, extra = {}) {
  res.writeHead(status, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-store', ...extra });
  res.end(body);
}
async function bodyOf(req) {
  const parts = [];
  for await (const part of req) parts.push(part);
  if (!parts.length) return {};
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
function begin(req, url, extra = {}) {
  const row = {
    seq: ++sequence, at: Date.now(), method: req.method, path: url.pathname,
    ...(req.clearance ? { clearance: req.clearance, ua: String(req.headers['user-agent'] || '') } : {}), ...extra,
  };
  log.push(row);
  return row;
}
function finish(row, status) { row.status = status; row.doneAt = Date.now(); row.ms = row.doneAt - row.at; }
async function delayFor(behaviour) {
  const m = /^slow:(\d+)$/.exec(behaviour);
  if (m) await sleep(Math.min(30_000, Number(m[1])));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);

    if (req.method === 'POST' && url.pathname === '/__reset') {
      scripts.clear(); requestCounts.clear(); log.length = 0; sequence = 0;
      return sendJson(res, 200, { ok: true, name: NAME });
    }
    if (req.method === 'GET' && url.pathname === '/__log') {
      return sendJson(res, 200, { name: NAME, content: log });
    }
    if (req.method === 'POST' && url.pathname === '/__script') {
      const body = await bodyOf(req);
      const chapter = normalChapter(body.chapter ?? '');
      const page = Number(body.page ?? 0);
      const behaviour = String(body.behaviour ?? body.behavior ?? '');
      if (!chapter || !Number.isInteger(page) || page < 0 || page > 12 ||
          !/^(?:ok|error|offline|pages-error|tiny-webp|404|short:(?:[1-9]|1[0-2])|omit:\d+-\d+|slow:\d+|429|429:after=\d+,retryAfter=\d+)$/.test(behaviour)) {
        return sendJson(res, 400, { error: 'bad_script' });
      }
      scripts.set(keyOf(chapter, page), behaviour);
      requestCounts.delete(chapter);
      scripts.delete(`${keyOf(chapter, page)}:fired`);
      return sendJson(res, 200, { ok: true, chapter, page, behaviour });
    }

    // Behind the fake Cloudflare (--cloudflare yes, see the header): nothing without a solver's clearance.
    if (CLOUDFLARE) {
      const clearance = /(?:^|;\s*)cf_clearance=([^;]+)/.exec(String(req.headers.cookie || ''))?.[1] ?? null;
      if (!clearance) {
        const row = begin(req, url, { route: 'challenge' });
        finish(row, 403);
        return sendBytes(res, 403, 'text/html; charset=utf-8', CHALLENGE_PAGE);
      }
      req.clearance = clearance;
      if (req.method === 'GET' && url.pathname === '/') {
        const row = begin(req, url, { route: 'home' });
        finish(row, 200);
        return sendBytes(res, 200, 'text/html; charset=utf-8', Buffer.from(`<!doctype html><title>${SITE_NAME}</title><h1>${SITE_NAME}</h1>`));
      }
    }

    // The whole site down behind its own notice (see the header): every source route, before any of them reads a
    // script of its own.
    if (behaviourFor('site', 0) === 'offline') {
      const row = begin(req, url, { route: 'offline' });
      finish(row, 200);
      return sendBytes(res, 200, 'text/html; charset=utf-8', OFFLINE_PAGE);
    }

    if (req.method === 'GET' && url.pathname === '/search') {
      const row = begin(req, url, { route: 'search', query: url.searchParams.get('q') || '' });
      const behaviour = behaviourFor('search', 0);
      await delayFor(behaviour);
      // #115: the site failing at the search step, as an extension's exception does -- a real error, not an empty page.
      if (behaviour === 'error') { finish(row, 500); return sendJson(res, 500, { error: 'the fake site failed while searching' }); }
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const found = SERIES.filter((s) => !q || s.title.toLowerCase().includes(q)).map((s) => ({
        sourceId: s.sourceId, source: NAME, title: s.title,
        summary: `${s.title}, served by ${NAME} for the v0.40 browser walk.`, status: 'ONGOING', genres: ['Test'],
      }));
      finish(row, 200); return sendJson(res, 200, found);
    }

    const seriesMatch = /^\/series\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && seriesMatch) {
      const id = decodeURIComponent(seriesMatch[1]);
      const row = begin(req, url, { route: 'series', series: id });
      const s = byId.get(id);
      finish(row, s ? 200 : 404);
      return sendJson(res, s ? 200 : 404, s ? {
        sourceId: s.sourceId, source: NAME, title: s.title,
        summary: `${s.title}, served by ${NAME} for the v0.40 browser walk.`, status: 'ONGOING', genres: ['Test'],
        url: `http://${req.headers.host || `127.0.0.1:${PORT}`}/title/${s.sourceId}`,
      } : { error: 'not_found' });
    }

    const chaptersMatch = /^\/chapters\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && chaptersMatch) {
      const id = decodeURIComponent(chaptersMatch[1]);
      const row = begin(req, url, { route: 'chapters', series: id });
      const s = byId.get(id);
      finish(row, s ? 200 : 404);
      // `omit:a-b` scripted on the SERIES id is this source not carrying those chapters at all: the hole
      // the v0.41 gap step goes looking for. `short:n` on a chapter id is declared here as well as served
      // by /pages, so the downloader's expected count agrees with what it is handed (see the header).
      const hole = /^omit:(\d+)-(\d+)$/.exec(behaviourFor(id, 0));
      // A posts series lists every post under the number the extension would give it; `omit:` still names numbers.
      if (s?.posts) {
        return sendJson(res, 200, s.posts
          .filter((p) => !hole || p.number < Number(hole[1]) || p.number > Number(hole[2]))
          .map((p) => {
            const short = /^short:(\d+)$/.exec(behaviourFor(`${s.sourceId}-${p.k}`, 0));
            return { sourceId: `${s.sourceId}-${p.k}`, number: p.number, title: p.title, order: p.k, publishedAt: p.publishedAt, pages: short ? Number(short[1]) : 12, lang: 'en' };
          }));
      }
      return sendJson(res, s ? 200 : 404, s ? Array.from({ length: s.last - s.first + 1 }, (_, i) => s.first + i)
        .filter((number) => !hole || number < Number(hole[1]) || number > Number(hole[2]))
        .map((number) => {
          const short = /^short:(\d+)$/.exec(behaviourFor(`${s.sourceId}-${number}`, 0));
          return { sourceId: `${s.sourceId}-${number}`, number, title: `Chapter ${number}`, pages: short ? Number(short[1]) : 12, lang: 'en' };
        }) : { error: 'not_found' });
    }

    const pagesMatch = /^\/pages\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && pagesMatch) {
      const chapter = decodeURIComponent(pagesMatch[1]);
      const row = begin(req, url, { route: 'pages', chapter });
      if (behaviourFor('site', 0) === 'pages-error') { finish(row, 500); return sendJson(res, 500, { error: 'the fake site failed while listing pages' }); }
      const found = chapterFromId(chapter);
      const host = req.headers.host || `127.0.0.1:${PORT}`;
      const short = /^short:(\d+)$/.exec(behaviourFor(chapter, 0));
      finish(row, found ? 200 : 404);
      return sendJson(res, found ? 200 : 404, found
        ? Array.from({ length: short ? Number(short[1]) : 12 }, (_, i) => `http://${host}/img/${encodeURIComponent(chapter)}/${i + 1}`)
        : { error: 'not_found' });
    }

    const imageMatch = /^\/img\/([^/]+)\/(\d+)$/.exec(url.pathname);
    if (req.method === 'GET' && imageMatch) {
      const chapter = decodeURIComponent(imageMatch[1]);
      const page = Number(imageMatch[2]);
      const count = (requestCounts.get(chapter) ?? 0) + 1;
      requestCounts.set(chapter, count);
      const row = begin(req, url, { route: 'image', chapter, page, chapterRequest: count });
      const behaviour = behaviourFor(chapter, page);
      await delayFor(behaviour);

      // The bare `429` never stops: no count to outgrow and no one-shot flag to clear. See the header.
      if (behaviour === '429') {
        finish(row, 429);
        return sendBytes(res, 429, 'text/plain', Buffer.from('slow down'), { 'retry-after': '1' });
      }
      const limited = /^429:after=(\d+),retryAfter=(\d+)$/.exec(behaviour);
      const fired = `${keyOf(chapter, page)}:fired`;
      if (limited && count > Number(limited[1]) && !scripts.has(fired)) {
        scripts.set(fired, 'yes');
        finish(row, 429);
        return sendBytes(res, 429, 'text/plain', Buffer.from('slow down'), { 'retry-after': limited[2] });
      }
      if (behaviour === '404') {
        finish(row, 404); return sendBytes(res, 404, 'text/plain', Buffer.from('not found'));
      }
      if (behaviour === 'tiny-webp') {
        finish(row, 200); return sendBytes(res, 200, 'image/webp', TINY_WEBP);
      }
      if (!chapterFromId(chapter) || page < 1 || page > 12) {
        finish(row, 404); return sendBytes(res, 404, 'text/plain', Buffer.from('not found'));
      }
      finish(row, 200); return sendBytes(res, 200, 'image/png', pages[page - 1]);
    }

    const row = begin(req, url, { route: 'unknown' });
    finish(row, 404); return sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    // The stub's own crash goes to its container log (`docker logs <net>-fake-a`), not into a response body:
    // nothing in the suite reads this message, and a 500 carrying an exception string is the shape CodeQL
    // flags as stack-trace exposure (alert #32). The status code is the assertion; the log is the debugging,
    // and it is reachable where the body was not.
    console.error('[fake-source] request failed', error);
    sendJson(res, 500, { error: 'stub_error' });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`[fake-source] ${NAME} listening on ${PORT}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
