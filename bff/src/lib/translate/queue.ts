import { one } from '../db';
import { installedSize, stopEngine } from './engine';
import { PIPELINE_VERSION, recordFailure, translatePage } from './pages';

/**
 * The pages waiting to be translated, one at a time: a page is a CPU's worth of work for several seconds, and two at
 * once would only make both slower. The reader asks for a chapter from the page it is on (POST
 * /api/books/:id/translations); the newest ask goes first, so whatever is open now is what gets done.
 */

interface Want { bookId: string; lang: string; pages: number[]; at: number }
const wants = new Map<string, Want>();
/** The worker, while it runs: one at a time. */
let loop: Promise<void> | null = null;
/** Asks in order: the newest goes first. */
let seq = 0;
/** The chapter (book:lang) whose page is being translated right now. */
let working: string | null = null;
/** Why the queue stopped short of its pages (no free memory, engine missing): shown in the reader and in Settings. */
let problem: string | null = null;

export async function translateOn(): Promise<boolean> {
  const r = await one<{ on: boolean }>('SELECT translate_pages AS "on" FROM server_settings WHERE id = 1').catch(() => null);
  return !!r?.on;
}

/** What each stored translation is keyed by: the model it was made with and the pipeline's version. */
export async function engineKey(): Promise<string | null> {
  const size = await installedSize();
  if (size === undefined) return null;
  return `${size ?? 'ext'}-v${PIPELINE_VERSION}`;
}

export const queueProblem = () => problem;
/** The pages of a chapter still to come, the one being translated now included (the reader keeps asking until it is in). */
export const pagesWanted = (bookId: string, lang: string) =>
  (wants.get(`${bookId}:${lang}`)?.pages.length ?? 0) + (working === `${bookId}:${lang}` ? 1 : 0);

/** Asks for a chapter's pages (in the order given), ahead of anything asked before. */
export function requestPages(bookId: string, lang: string, pages: number[]): void {
  if (!pages.length) { wants.delete(`${bookId}:${lang}`); return; }
  wants.set(`${bookId}:${lang}`, { bookId, lang, pages: [...pages], at: ++seq });
  problem = null;
  // Never an unhandled rejection (the process would exit): a failure the loop did not expect (the database gone, say)
  // stops it, and says so where an admin looks.
  loop ??= run().catch((e: unknown) => { problem = (e as Error).message; wants.clear(); }).finally(() => { loop = null; });
}

/** Tests: resolves once the worker has nothing left to do. */
export async function _queueSettled(): Promise<void> {
  while (loop) await loop;
}

/** Forgets every request (the switch was turned off, the engine removed). */
export function clearQueue(): void { wants.clear(); }

/** An error that no other page would avoid: stop here and say so, rather than failing every page in turn. */
const engineWide = (m: string) => /not installed|not enough free memory|stopped while loading|took too long to load|OCR worker/i.test(m);

async function run(): Promise<void> {
  for (;;) {
    if (!(await translateOn())) { wants.clear(); stopEngine(); break; }
    const key = await engineKey();
    if (!key) { wants.clear(); break; }
    const w = [...wants.values()].sort((a, b) => b.at - a.at)[0];
    if (!w) break;
    const page = w.pages.shift();
    if (page == null) { wants.delete(`${w.bookId}:${w.lang}`); continue; }
    const have = await one(`SELECT 1 FROM page_translations WHERE book_id = $1 AND page = $2 AND lang = $3 AND engine = $4 AND status = 'done'`,
      [w.bookId, page, w.lang, key]);
    if (have) continue;
    working = `${w.bookId}:${w.lang}`;
    try {
      await translatePage(w.bookId, page, w.lang, key);
    } catch (e) {
      const msg = (e as Error).message;
      if (engineWide(msg)) { problem = msg; wants.clear(); stopEngine(); break; }
      await recordFailure(w.bookId, page, w.lang, key, msg).catch(() => {});
    } finally {
      working = null;
    }
  }
}
