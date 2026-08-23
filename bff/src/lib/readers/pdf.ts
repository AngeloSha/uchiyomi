// PDF chapters.
//
// Some scanlation groups ship PDF rather than CBZ, and a PDF of a comic is the same thing a CBZ is: an
// ordered run of full-page images in a container. So it is read as one, and the rest of the app never learns
// the difference -- the reader, the thumbnailer, the offline manifest and OPDS all take page bytes.
//
// mupdf is a pure-wasm build with no native compilation, chosen for the same reason node-unrar-js was: this
// image has to build on amd64 and arm64 without a toolchain.
//
// Pages are RASTERISED rather than having their embedded image pulled out. Extracting would be sharper for
// the common "one full-page scan per page" case, but it is wrong for any PDF whose page is more than one
// image, and it silently drops vector text. Rendering is correct for every PDF; the cost is choosing a
// resolution, which RENDER_WIDTH does.
import { readFile } from 'fs/promises';

/**
 * mupdf is ESM-only and uses top-level await, and this package compiles to CommonJS -- so `require` fails
 * outright and a plain `await import()` is downlevelled by tsc back into `require`. Building the import
 * through `new Function` is the one form tsc leaves alone, so it stays a real dynamic import at runtime.
 *
 * The module is cached: it instantiates a wasm binary, which is far too expensive to repeat per page.
 */
const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
let mupdfPromise: Promise<any> | null = null;
const loadMupdf = () => (mupdfPromise ??= esmImport('mupdf'));

/** Target width in pixels. 1600 is a retina-ish read on a phone and a sane one on a desktop, and keeps a
 *  200-page volume from turning into hundreds of megabytes of cache. */
const RENDER_WIDTH = 1600;
const MAX_SCALE = 4;      // never upscale a small page into a huge one
const MIN_SCALE = 0.5;

/** Zero-padded so the natural sort the rest of the app uses keeps them in order past page 9. */
export const pdfPageName = (i: number) => `page-${String(i + 1).padStart(4, '0')}.png`;

/** The index a pdfPageName refers to, or -1 if the name is not one of ours. */
export function pdfPageIndex(name: string): number {
  const m = /^page-(\d+)\.png$/.exec(name);
  return m ? Number(m[1]) - 1 : -1;
}

async function open(path: string): Promise<{ mupdf: any; doc: any }> {
  const mupdf = await loadMupdf();
  return { mupdf, doc: mupdf.Document.openDocument(await readFile(path), 'application/pdf') };
}

/** How many pages, without rendering any of them. */
export async function pdfPageCount(path: string): Promise<number> {
  try {
    return (await open(path)).doc.countPages();
  } catch {
    return 0;
  }
}

/** Every page name, in order. */
export async function pdfPages(path: string): Promise<string[]> {
  const n = await pdfPageCount(path);
  return Array.from({ length: n }, (_, i) => pdfPageName(i));
}

/** One page, rendered to PNG. Throws if the index is out of range, like the archive readers do. */
export async function pdfPageBytes(path: string, index: number): Promise<Buffer> {
  const { mupdf, doc } = await open(path);
  if (index < 0 || index >= doc.countPages()) throw new Error('pdf page out of range');
  const page = doc.loadPage(index);
  const box = page.getBounds();                    // [x0, y0, x1, y1] in points
  const w = Math.abs(box[2] - box[0]) || RENDER_WIDTH;
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, RENDER_WIDTH / w));
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
  return Buffer.from(pix.asPNG());
}

/**
 * Page dimensions without rendering.
 *
 * cbzPageDims exists so the reader can reserve the right height per page before the image arrives, and it
 * runs over every page of a chapter. Rendering a whole volume to measure it would be absurd, so the size is
 * computed from the page box and the same scale the renderer will use. The numbers match what
 * pdfPageBytes produces.
 */
export async function pdfPageDims(path: string): Promise<Array<{ name: string; width: number | null; height: number | null }>> {
  const opened = await open(path).catch(() => null);
  if (!opened) return [];
  const { doc } = opened;
  const out: Array<{ name: string; width: number | null; height: number | null }> = [];
  for (let i = 0; i < doc.countPages(); i++) {
    try {
      const box = doc.loadPage(i).getBounds();
      const w = Math.abs(box[2] - box[0]);
      const h = Math.abs(box[3] - box[1]);
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, RENDER_WIDTH / (w || RENDER_WIDTH)));
      out.push({ name: pdfPageName(i), width: Math.round(w * scale) || null, height: Math.round(h * scale) || null });
    } catch {
      out.push({ name: pdfPageName(i), width: null, height: null });
    }
  }
  return out;
}
