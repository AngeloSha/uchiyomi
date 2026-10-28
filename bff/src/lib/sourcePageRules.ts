// Explicit, skip-only source rules. Book provenance decides, never a series' mutable primary source.
import path from 'node:path';
import { one } from './db';
import { cbzPages, LIBRARY_ROOT } from './library';
export async function sourceGifPages(bookId: string): Promise<Set<number>> {
  const b = await one<{ file: string; root: string; skip_gif: boolean }>(
    `SELECT b.file, b.root, r.skip_gif FROM lib_books b
       JOIN LATERAL (SELECT skip_gif FROM source_page_rules
         WHERE source_id = b.source_id AND series_scope IN ('', b.series_id)
         ORDER BY (series_scope <> '') DESC LIMIT 1) r ON true
      WHERE b.id = $1 AND b.pruned_at IS NULL`, [bookId]);
  if (!b?.skip_gif) return new Set();
  const names = await cbzPages(path.join(b.root || LIBRARY_ROOT, b.file));
  return new Set(names.flatMap((name, i) => /\.gif$/i.test(name) ? [i + 1] : []));
}
