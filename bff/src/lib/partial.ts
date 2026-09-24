// A chapter saved with some of its pages missing, and the pass that fills them in later.
//
// The owner's report: "a missing page, like 149 of 155, causes the chapter not to be downloaded". It did --
// deliberately (partialChapter.test.ts: a truncated file skipped forever is worse than no file), and then
// the same chapter failed the same way every night until the retry cap stopped it, and the person had
// 154 readable pages they could not open. Live, 153 ledger rows were that shape, none of them a block.
//
// The answer is a file that is honest about its holes. Every page keeps the name its INDEX gives it, a
// missing page is a flat placeholder image under that same name, and a manifest at the archive root says
// which indices are placeholders. So every consumer -- the scanner, the reader's page count, page_dims,
// OPDS, the Komga-compatible API, offline manifests, thumbnails, fingerprints -- sees an ordinary chapter of
// the right length and needs no change; only /api/books/:id/pages learns to say `missing: true`, from the
// lib_books.missing_pages column, and the web draws the caption. The sweep's completion pass then asks the
// source for exactly the missing indices, merges them into the file, and clears the column when it is whole.
//
// ⚠️ The manifest carries no page URLs. They expire, and an exported CBZ would leak the source host into a
// file that travels; the completion pass re-runs getPageUrls instead.
import { stat } from 'fs/promises';
import { join } from 'path';
import { dirnameRel } from './relPath';
import sharp from 'sharp';
import { q, one } from './db';
import { getSource, SourceChapter } from './sources';
import { classify, reportFail, blockedNow, isDisabled } from './sourceHealth';
import { writeAtomic } from './fsAtomic';
import { downloadChapter, fetchPages, underGate, type DownloadInput } from './downloader';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');
// Existing chapter archives are untrusted source bytes. Keep adm-zip on its write-only path (the security
// invariant pinned by zipExtractionGuard.test.ts) and use the streaming reader for manifests/entries.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const StreamZip = require('node-stream-zip');

/** The manifest's entry name at the archive root. Not an image extension, so the scanner never counts it. */
export const PARTIAL_MANIFEST = 'uchiyomi-partial.json';

export interface PartialManifest {
  version: 1;
  /** Adapter id and chapter id of the copy the real pages came from: what the completion pass asks again. */
  source: string;
  chapterSourceId: string;
  /** How many pages the chapter has, placeholders included. */
  expected: number;
  /** 0-based indices that are placeholders. */
  missing: number[];
  /** The size of the first placeholder written (each takes the nearest real page's size). */
  placeholder: { width: number; height: number };
  writtenAt: string;
}

/** How many partial chapters one sweep tries to complete. Each costs the source only its missing pages. */
export const PARTIAL_COMPLETE_MAX = process.env.PARTIAL_COMPLETE_MAX === undefined ? 10 : Math.max(0, Number(process.env.PARTIAL_COMPLETE_MAX) || 0);

/**
 * The entry name of page `i` (0-based) in a chapter archive: `0001.png` for index 0.
 *
 * By INDEX, not by count of pages present, so a placeholder occupies exactly the slot its page will take
 * when it is fetched later and the merge is a rename of one entry. For a complete chapter this is what the
 * downloader has always written (pageConcurrency.test.ts pins `0001…0008.png`).
 */
export function pageName(i: number, ext: string): string {
  return `${String(i + 1).padStart(4, '0')}.${ext}`;
}

const placeholders = new Map<string, Promise<Buffer>>();
/**
 * A flat, near-black PNG of the given size: what stands in for a page that could not be fetched.
 *
 * Flat on purpose, and no baked-in text: the web draws the caption in the viewer's language, and a flat
 * image has no horizontal variation, so the junk skipper's pageHash returns null for it and it can never be
 * flagged as a repeated credit page (pageHash.test.ts proves that). Memoised per size: a chapter with ten
 * holes renders the image once.
 */
export function placeholderPng(width: number, height: number): Promise<Buffer> {
  const w = Math.max(1, Math.floor(width) || 800);
  const h = Math.max(1, Math.floor(height) || 1200);
  const key = `${w}x${h}`;
  let p = placeholders.get(key);
  if (!p) {
    p = sharp({ create: { width: w, height: h, channels: 3, background: '#26262b' } }).png().toBuffer();
    // A rejected render must not be cached as a permanent failure for that size.
    p.catch(() => placeholders.delete(key));
    if (placeholders.size >= 64) placeholders.delete(placeholders.keys().next().value!);
    placeholders.set(key, p);
  }
  return p;
}

/**
 * The manifest inside a readable chapter archive, or null only when that valid archive has no manifest.
 * Corrupt ZIPs, malformed manifests and I/O failures throw: callers must not turn uncertainty into
 * "complete" and hide placeholders permanently.
 */
export async function readPartialManifest(abs: string): Promise<PartialManifest | null> {
  let zip: any = null;
  try {
    zip = new StreamZip.async({ file: abs });
    const entries = await zip.entries();
    if (!entries[PARTIAL_MANIFEST] || entries[PARTIAL_MANIFEST].isDirectory) return null;
    let m: any;
    try { m = JSON.parse((await zip.entryData(PARTIAL_MANIFEST)).toString('utf8')); }
    catch { throw new Error(`invalid ${PARTIAL_MANIFEST}: malformed JSON`); }
    if (m?.version !== 1 || typeof m.source !== 'string' || typeof m.chapterSourceId !== 'string' ||
        !Number.isInteger(m.expected) || m.expected < 1 || !Array.isArray(m.missing) ||
        !m.missing.every((i: unknown) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < m.expected)) {
      throw new Error(`invalid ${PARTIAL_MANIFEST}: schema`);
    }
    return m as PartialManifest;
  } finally {
    await zip?.close().catch(() => {});
  }
}

const IMG = /\.(jpe?g|png|webp|gif|avif)$/i;

/**
 * Stamp the row after the file on disk changed: what the reader counts, what the jobs must redo.
 *
 * Exported since v0.41.0 because the repair's short step (lib/repair.ts) replaces a truncated chapter with
 * a longer copy and owes the row exactly this treatment. It is deliberately the only writer of
 * `lib_books.pages` after a download in that job: a count taken from the source's page list is what
 * decided to download, and the count that gets stored has to come from the bytes that actually landed.
 * (The repair's count step stamps `pages` as well, but only into a row that never had a count, from a
 * file on our own disk that nothing downloaded.)
 */
export async function restampBook(bookId: string, abs: string, missing0: number[], via?: { source: string; scanlator?: string }): Promise<void> {
  const zip = new StreamZip.async({ file: abs });
  let pages = 0;
  try {
    const entries = await zip.entries();
    pages = Object.keys(entries).filter((name) => !entries[name].isDirectory && IMG.test(name)).length;
  } finally {
    await zip.close();
  }
  const size = (await stat(abs)).size;
  // page_dims is a cache of the old file's pages and page_hashes were computed from its placeholders; both
  // are recomputed lazily (the reader, the nightly hash job) once cleared. fp_at too: the fingerprint is
  // of the bytes, and the bytes changed. updated_at moves the row to the back of the completion queue, so
  // ten partials the source cannot complete do not hold the same ten slots every sweep.
  //
  // short_confirmed_at goes for the same reason, and it is the one field here that is about a JUDGEMENT
  // rather than a measurement: "this chapter really is two pages, every source says so" was proven about
  // the file that was on disk, and this is a different file. Leaving it would hide a chapter that came
  // back two pages long a second time -- the Health page would stay quiet about a download that failed
  // again. Reintroduce by removing it: "replacing a confirmed-short chapter un-confirms it" in
  // partialComplete.int.test.ts finds the stamp still there.
  const set = ['missing_pages = $2', 'page_dims = NULL', 'pages = $3', 'size = $4', 'fp_at = NULL', 'short_confirmed_at = NULL', 'updated_at = now()'];
  const params: any[] = [bookId, missing0.length ? missing0.map((i) => i + 1) : null, pages, size];
  if (via) {
    params.push(via.source, via.scanlator ?? null);
    set.push(`source_id = $${params.length - 1}`, `scanlator = $${params.length}`);
  }
  await q(`UPDATE lib_books SET ${set.join(', ')} WHERE id = $1`, params);
  // Every row, overrides included: an override made on a placeholder ("always skip this page") would hide
  // the real page that replaced it, and that is the one failure the junk skipper must never have.
  await q('DELETE FROM page_hashes WHERE book_id = $1', [bookId]);
}

type Completion = 'completed' | 'improved' | 'unchanged' | 'gone';

/**
 * Try to fill the holes in one partial chapter. Returns what became of it:
 *   completed  every page is real now; the column is NULL
 *   improved   fewer placeholders than before (the column says which remain)
 *   unchanged  nothing could be fetched; the file was not touched
 *   gone       the file has no manifest (rewritten whole by a refetch, or deleted) -- the column is cleared
 *
 * Order: the SAME copy first, asking only for the missing indices (the source sees as many requests as
 * there are holes, and no more); if the source re-sliced the chapter (a different page count) the old
 * indices mean nothing and it is fetched whole; whatever is still missing after that goes through the
 * fallback chain (other followed sources, then the hunt) with `replace` set, and its result is accepted
 * only when it has FEWER holes than what is on disk -- a worse copy from elsewhere never overwrites a
 * better one. A `diskFull` error is rethrown so the caller can stop the pass.
 *
 * ⚠️ The fallback helper is builder 4's chapterFallback.ts and is imported lazily: this file compiles and
 * the same-copy pass works before it lands, and a missing module simply ends the attempt at 'unchanged'.
 */
export async function completePartial(
  book: { id: string; series_id: string; root: string; file: string; number: number; missing_pages: number[]; source_id: string | null },
  ctx: {
    alternates: () => Promise<SourceChapter[]>;
    /** The sweep's age rule. It applies to the old copy as well as every fallback copy. */
    allowed?: (source: string) => boolean;
    hunt?: (why: string) => Promise<SourceChapter | null>;
  },
): Promise<Completion> {
  const abs = join(book.root, book.file);
  let manifest: PartialManifest | null;
  try {
    manifest = await readPartialManifest(abs);
  } catch (e: any) {
    // ENOENT proves the chapter itself is gone; any other read/ZIP/manifest failure is uncertainty, so
    // leave the marker in place for the next pass instead of hiding placeholders forever.
    if (e?.code !== 'ENOENT') {
      console.warn(`[partial] ${book.file}: cannot read ${PARTIAL_MANIFEST}; keeping missing-page marker (${e?.message || e})`);
      return 'unchanged';
    }
    manifest = null;
  }
  if (!manifest) {
    await q('UPDATE lib_books SET missing_pages = NULL WHERE id = $1', [book.id]).catch(() => {});
    return 'gone';
  }
  // The FILE is the truth about which pages are placeholders; the column is a copy of it for the DTO.
  let missing = [...manifest.missing].sort((a, b) => a - b);
  if (!missing.length) {
    await q('UPDATE lib_books SET missing_pages = NULL WHERE id = $1', [book.id]).catch(() => {});
    return 'gone';
  }
  const s = await one<{ title: string; summary: string | null; author: string | null; genres: string[]; web: string | null; status: string | null }>(
    'SELECT title, summary, author, genres, web, status FROM lib_series WHERE id = $1', [book.series_id],
  );
  const title = s?.title ?? dirnameRel(book.file).split('/').pop() ?? '';
  const meta: DownloadInput['meta'] = { series: title, summary: s?.summary ?? undefined, author: s?.author ?? undefined, genres: s?.genres ?? undefined, url: s?.web ?? undefined, status: s?.status ?? undefined };
  // dirnameRel, not dirname: book.file is the stored `/` form (lib/relPath.ts), and this folder is handed
  // back to the downloader, whose chapterFileRel must land on the same row.
  const seriesFolder = dirnameRel(book.file);
  const chapter: SourceChapter = { sourceId: manifest.chapterSourceId, number: book.number };
  const label = `[partial] "${title}" ch ${book.number}`;
  let result: Completion = 'unchanged';
  const before = (await stat(abs)).size;

  // ── 1. the same copy, only the holes ──────────────────────────────────────────────────────────────
  const src = getSource(manifest.source);
  const askable = src && (!ctx.allowed || ctx.allowed(src.id))
    && !(await isDisabled(src.id).catch(() => false))
    && !(await blockedNow(src.id).catch(() => null));
  if (src && askable) {
    let urls: string[] | null = null;
    try {
      urls = await src.getPageUrls(manifest.chapterSourceId);
    } catch (e) {
      const st = classify(e);
      if (st) await reportFail(src.id, st, (e as Error)?.message || 'getPageUrls failed');
    }
    if (urls && urls.length === manifest.expected) {
      // `retry: false`: the source sees exactly one request per hole, tonight and again tomorrow.
      const got = await underGate(src.id, () => fetchPages(src, urls!, missing, { chapterSourceId: manifest.chapterSourceId, retry: false }));
      const filled = missing.filter((i) => got.page[i]);
      if (filled.length) {
        const still = missing.filter((i) => !got.page[i]);
        // Merge by index name: the placeholder entry for a filled index goes, the real page takes its slot
        // (possibly under another extension), every other entry keeps its bytes exactly.
        const out = new AdmZip();
        const replaced = new Set(filled.map((i) => pageName(i, 'png')));
        const keep: Array<[string, Buffer]> = [];
        const old = new StreamZip.async({ file: abs });
        try {
          const entries = await old.entries();
          for (const name of Object.keys(entries)) {
            if (entries[name].isDirectory || name === PARTIAL_MANIFEST || replaced.has(name)) continue;
            keep.push([name, await old.entryData(name)]);
          }
        } finally {
          await old.close();
        }
        for (const i of filled) keep.push([pageName(i, got.ext[i]), got.page[i]!]);
        // Stored in page order, pages before the ComicInfo, as the downloader writes a fresh chapter: our
        // readers sort by name, but an exported file should not depend on that.
        keep.sort(([a], [b]) => Number(IMG.test(b)) - Number(IMG.test(a)) || a.localeCompare(b));
        for (const [name, data] of keep) out.addFile(name, data);
        if (still.length) {
          const next: PartialManifest = { ...manifest, missing: still, writtenAt: new Date().toISOString() };
          out.addFile(PARTIAL_MANIFEST, Buffer.from(JSON.stringify(next, null, 2)));
        }
        await writeAtomic(abs, out.toBuffer());
        await restampBook(book.id, abs, still);
        console.log(`${label}: ${filled.length} of ${missing.length} missing page${missing.length === 1 ? '' : 's'} fetched from ${src.id}${still.length ? `, ${still.length} still missing` : ''}`);
        if (!still.length) return 'completed';
        missing = still;
        result = 'improved';
      }
    } else if (urls && urls.length !== manifest.expected) {
      // The source re-sliced the chapter since the partial was written: index 149 of 155 is not index
      // 149 of 150. Fetch it whole, and keep the new copy only when it is complete or has fewer holes.
      try {
        const r = await downloadChapter({ sourceId: src.id, seriesFolder, chapter, meta }, { replace: true });
        if (r) {
          await restampBook(book.id, abs, []);
          console.warn(`${label}: re-sliced on ${src.id} (${manifest.expected} → ${urls.length} pages), fetched whole`);
          return 'completed';
        }
      } catch (e: any) {
        if (e?.diskFull) throw e;
        const hold = e?.partial;
        if (hold && hold.missing.length < missing.length) {
          await hold.write();
          await restampBook(book.id, abs, hold.missing);
          console.warn(`${label}: re-sliced on ${src.id} (${manifest.expected} → ${urls.length} pages), saved with ${hold.missing.length} missing`);
          missing = [...hold.missing];
          result = 'improved';
        }
      }
    }
  }

  // ── 2. another source, through the fallback chain ─────────────────────────────────────────────────
  // A computed specifier, so tsc does not resolve the module at build time: the helper lands with the
  // fallback work, and until it does the completion pass is the same-copy step alone.
  const helper = './chapterFallback';
  let fb: { downloadWithFallback: (f: any) => Promise<any> } | null = null;
  try { fb = await import(helper); } catch { fb = null; }
  if (typeof fb?.downloadWithFallback !== 'function') return result;
  const out = await fb.downloadWithFallback({
    seriesId: book.series_id, title, folder: seriesFolder, meta,
    chapter: { ...chapter, source: manifest.source },
    alternates: ctx.alternates,
    // The same copy was just asked above; the chain starts at the alternates.
    refusing: new Set([manifest.source]),
    allowed: ctx.allowed,
    hunt: ctx.hunt,
    replace: true,
    // Decide before `PartialHold.write()` replaces the canonical archive. The old write-then-restore
    // sequence had a crash window in which a worse copy could become permanent while the DB still
    // described the better one.
    acceptPartial: (hold: { missing: number[] }) => hold.missing.length < missing.length,
  });
  if (out.kind === 'landed') {
    await restampBook(book.id, abs, [], { source: out.via, scanlator: out.chapterUsed?.scanlator });
    const after = (await stat(abs)).size;
    // Another source's copy is not the same file: say so when its page count differs, because every
    // reader's position in this chapter was measured against the old count.
    console.warn(`${label}: completed from ${out.via}${out.pages !== manifest.expected ? ` -- ${manifest.expected} → ${out.pages} pages, reading positions may shift` : ''} (${before} → ${after} B)`);
    return 'completed';
  }
  if (out.kind === 'partial') {
    await restampBook(book.id, abs, out.missing, { source: out.via, scanlator: out.chapterUsed?.scanlator });
    console.warn(`${label}: ${out.via}'s copy has ${out.missing.length} missing against ${missing.length}, kept it${out.pages !== manifest.expected ? ` (${manifest.expected} → ${out.pages} pages)` : ''}`);
    return 'improved';
  }
  return result;
}
