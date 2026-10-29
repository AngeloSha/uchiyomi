import path from 'node:path';
import { stat } from 'node:fs/promises';
import sharp from 'sharp';
import { one, q } from '../db';
import { cbzPageAt, LIBRARY_ROOT } from '../library';
import { seriesLanguage } from '../seriesLang';
import { bubblesOf, ocrLooksUnreliable } from './bubbles';
import { acquireEngine, translateDir } from './engine';
import { answerSchema, pageText, parseAnswer, systemPrompt, type Name } from './prompt';
import { renderPage, type Region } from './render';

/**
 * One page translated: read (OCR), grouped into bubbles, translated with what the chapter and the series already know,
 * and stored as regions (`page_translations`). The picture is drawn from the regions when it is asked for (render.ts),
 * so a translation is paid for once per page and language, and a copy evicted from the image cache costs no model call.
 */

/** Bumped when the prompt or the pipeline changes enough that old translations should not be served as current. */
export const PIPELINE_VERSION = 1;
/** How many bubbles from the chapter's earlier pages go along as context. */
const CONTEXT_LINES = 12;

const base = (lang: string) => lang.toLowerCase().split(/[-_]/)[0];

/** A reader's language as the app's UI codes it (`en`, `pt-BR`, …): letters and one hyphen, nothing else. */
export const readerLang = (v: unknown): string | null =>
  (typeof v === 'string' && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(v) ? v : null);
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[s.length >> 1] ?? 12; };

async function previousLines(bookId: string, pageNo: number, lang: string, engine: string): Promise<Name[]> {
  const rows = await q<{ regions: Region[] | null }>(
    `SELECT regions FROM page_translations WHERE book_id = $1 AND lang = $2 AND engine = $3 AND page < $4 AND status = 'done'
      ORDER BY page DESC LIMIT 3`, [bookId, lang, engine, pageNo]);
  const lines: Name[] = [];
  for (const r of rows.reverse()) for (const g of r.regions ?? []) if (g.text) lines.push({ source: g.source, target: g.text });
  return lines.slice(-CONTEXT_LINES);
}

/** Translates one page into `lang` and stores it. Throws on failure (the queue records it). */
export async function translatePage(bookId: string, pageNo: number, lang: string, engine: string): Promise<void> {
  const b = await one<{ file: string; root: string | null; series_id: string; title: string }>(
    `SELECT b.file, b.root, b.series_id, s.title FROM lib_books b JOIN lib_series s ON s.id = b.series_id WHERE b.id = $1`, [bookId]);
  if (!b) throw new Error('the chapter is gone');
  const file = path.join(b.root || LIBRARY_ROOT, b.file);
  const before = await stat(file);
  const page = await cbzPageAt(file, pageNo - 1);
  if (!page) throw new Error('the page is gone');
  const src = (await seriesLanguage(b.series_id)).lang;
  const t0 = Date.now();
  const e = await acquireEngine();
  const text = await e.ocr.read(page.bytes, base(src));
  const bubbles = bubblesOf(text.lines, base(src));
  let regions: Region[] = [];
  if (bubbles.length) {
    const names = await q<Name>('SELECT source, target FROM translate_names WHERE series_id = $1 AND lang = $2 ORDER BY at LIMIT 60', [b.series_id, lang]);
    const previous = await previousLines(bookId, pageNo, lang, engine);
    // The model looks at the page itself only when the OCR text looks unreliable: a third of the time per page.
    const look = e.model.vision && ocrLooksUnreliable(bubbles, base(src));
    const msg = pageText(bubbles, { title: b.title, sourceLang: src, names, previous }, look);
    const content = look
      ? [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${(await sharp(page.bytes).resize({ width: 640, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()).toString('base64')}` } },
        { type: 'text', text: msg }]
      : msg;
    const ans = await e.model.chat(systemPrompt(lang), content, answerSchema(bubbles.length));
    const parsed = parseAnswer(ans.text, bubbles.length);
    regions = bubbles.map((bb, i) => ({ box: bb.box, source: bb.text, text: parsed.lines[i], letter: median(bb.lines.map((l) => Math.min(l[2] - l[0], l[3] - l[1]))) }));
    // A name keeps the spelling it was first given in this series: the next pages are told it.
    for (const n of parsed.names) {
      await q(`INSERT INTO translate_names (series_id, lang, source, target) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [b.series_id, lang, n.source, n.target]);
    }
  }
  // OCR/model work can outlive a physical page edit. Never publish an old page's translation onto its
  // replacement (a cleanup placeholder or restored original); the next request can translate that copy.
  const after = await stat(file);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino)
    throw new Error('the chapter changed while its page was being translated');
  await q(
    `INSERT INTO page_translations (book_id, page, lang, engine, status, regions, error, ms, created_at)
     VALUES ($1, $2, $3, $4, 'done', $5, NULL, $6, now())
     ON CONFLICT (book_id, page, lang, engine) DO UPDATE SET status = 'done', regions = EXCLUDED.regions, error = NULL,
       ms = EXCLUDED.ms, created_at = now()`,
    [bookId, pageNo, lang, engine, JSON.stringify(regions), Date.now() - t0]);
}

/** A failed page, kept so the reader stops waiting for it. The next request for the chapter tries it again. */
export async function recordFailure(bookId: string, pageNo: number, lang: string, engine: string, error: string): Promise<void> {
  await q(
    `INSERT INTO page_translations (book_id, page, lang, engine, status, regions, error, ms, created_at)
     VALUES ($1, $2, $3, $4, 'failed', NULL, $5, NULL, now())
     ON CONFLICT (book_id, page, lang, engine) DO UPDATE SET status = 'failed', error = EXCLUDED.error, created_at = now()`,
    [bookId, pageNo, lang, engine, error.slice(0, 300)]);
}

/** A page's done translation into `lang` by `engine`, with its stamp (ms, for the image URL), or null. */
export async function doneTranslation(bookId: string, pageNo: number, lang: string, engine: string): Promise<{ at: string; regions: Region[] } | null> {
  return one<{ at: string; regions: Region[] }>(
    `SELECT (extract(epoch FROM created_at) * 1000)::bigint::text AS at, regions FROM page_translations
      WHERE book_id = $1 AND page = $2 AND lang = $3 AND engine = $4 AND status = 'done'`, [bookId, pageNo, lang, engine]);
}

/** The translated picture of a done page: its stored regions drawn over the page as stored. */
export async function drawPage(pageBytes: Buffer, regions: Region[], lang: string): Promise<{ buffer: Buffer; contentType: string }> {
  return renderPage(pageBytes, regions, lang, path.join(translateDir(), 'pack', 'fonts'));
}
