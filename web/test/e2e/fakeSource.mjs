#!/usr/bin/env node
// Dependency-free HTTP source used only by the v0.40 and v0.41 browser walks.
//
//   node fakeSource.mjs --name fake-a --port 18150
//
// Control it with POST /__script {chapter,page,behaviour}; chapter may be a chapter id, a chapter number
// (shorthand for walk-tale-N), a SERIES id (for `omit:`), or "search" with page 0. GET /__log returns every
// source request with start and finish timestamps. POST /__reset clears scripts, counters and the log.
//
// The behaviours, and which route reads each one:
//   ok, tiny-webp, 404, slow:<ms>, 429:after=<n>,retryAfter=<s>   /img (and slow: also /search)
//   429                                                           /img, EVERY request, forever
//   short:<n>                                                     /pages (n urls) AND /chapters (pages: n)
//   omit:<a>-<b>                                                  /chapters (those numbers are not listed)
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
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`bad --port ${PORT}`);

// ⚠️ "Walk Gap" runs to 14, not 12, and both fakes carry all fourteen: the walk punches its hole with
// `omit:6-8` on fake-a, which leaves ELEVEN listed numbers, and judgeCandidate (lib/autoFollow.ts) only
// judges an exact title one way once the primary lists ONE_WAY_MIN_LISTED = 10. At twelve chapters the
// same hole leaves nine, the judgement goes both ways, and 9 of the candidate's 12 numbers is 0.75 --
// under MIN_COVERAGE, so the source that can fill the gap is refused as `numbering_differs` and the gap
// step has nothing to follow. The failure looks exactly like a bug in `wants`, so the margin is here.
const SERIES = [
  { sourceId: 'walk-tale', title: 'Walk Tale', first: 1, last: 12 },
  { sourceId: 'walk-gap', title: 'Walk Gap', first: 1, last: 14 },
  ...(NAME === 'fake-b' ? [{ sourceId: 'walk-tale-next', title: 'Walk Tale: Next', first: 13, last: 40 }] : []),
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
  const row = { seq: ++sequence, at: Date.now(), method: req.method, path: url.pathname, ...extra };
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
          !/^(?:ok|tiny-webp|404|short:(?:[1-9]|1[0-2])|omit:\d+-\d+|slow:\d+|429|429:after=\d+,retryAfter=\d+)$/.test(behaviour)) {
        return sendJson(res, 400, { error: 'bad_script' });
      }
      scripts.set(keyOf(chapter, page), behaviour);
      requestCounts.delete(chapter);
      scripts.delete(`${keyOf(chapter, page)}:fired`);
      return sendJson(res, 200, { ok: true, chapter, page, behaviour });
    }

    if (req.method === 'GET' && url.pathname === '/search') {
      const row = begin(req, url, { route: 'search', query: url.searchParams.get('q') || '' });
      const behaviour = behaviourFor('search', 0);
      await delayFor(behaviour);
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
    sendJson(res, 500, { error: 'stub_error', message: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`[fake-source] ${NAME} listening on ${PORT}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
