#!/usr/bin/env node
/**
 * Read-only diagnostic. Lists every lib_books row whose file does not actually exist on disk right now,
 * but whose row is NOT already marked pruned_at -- i.e. a chapter the database claims you have, that the
 * updater's "already have this chapter" check (bff/src/lib/updater.ts) will therefore never re-download,
 * but that has no real bytes behind it (a backup restore that copied the database without the files is
 * the usual cause).
 *
 * Nothing is changed. Run this first to see the size of the problem before running repair-orphaned-books.mjs.
 *
 * Usage (from bff/, with the same env the server runs with -- DATABASE_URL, DL_ROOT, LIBRARY_ROOT):
 *   node --import tsx scripts/find-orphaned-books.mjs
 *   node --import tsx scripts/find-orphaned-books.mjs --json   # machine-readable, for repair-orphaned-books.mjs
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

const asJson = process.argv.includes('--json');

const { q } = await import('../src/lib/db.ts');
const { LIBRARY_ROOT, DL_ROOT } = await import('../src/lib/library.ts');

const rows = await q(
  `SELECT b.id, b.series_id, s.title, s.folder, b.root, b.file, b.number
     FROM lib_books b JOIN lib_series s ON s.id = b.series_id
    WHERE b.pruned_at IS NULL AND s.deleted_at IS NULL
    ORDER BY s.title, b.number`,
);

const orphans = [];
for (const r of rows) {
  const root = r.root || LIBRARY_ROOT;
  const abs = join(root, r.file);
  const ok = await stat(abs).then(() => true).catch(() => false);
  if (!ok) orphans.push({ ...r, root, abs });
}

if (asJson) {
  process.stdout.write(JSON.stringify(orphans, null, 2) + '\n');
} else {
  const bySeries = new Map();
  for (const o of orphans) {
    if (!bySeries.has(o.series_id)) bySeries.set(o.series_id, { title: o.title, chapters: [] });
    bySeries.get(o.series_id).chapters.push(o.number);
  }
  console.log(`${orphans.length} orphaned lib_books row(s) across ${bySeries.size} series (row exists, file does not, not already pruned):\n`);
  for (const [seriesId, v] of bySeries) {
    console.log(`  ${v.title}  (${seriesId})  -- ${v.chapters.length} chapter(s): ${v.chapters.sort((a, b) => a - b).join(', ')}`);
  }
  if (orphans.length) {
    console.log(`\nRun with --json to feed this list into repair-orphaned-books.mjs, or run that script directly.`);
  }
}
process.exit(0);
