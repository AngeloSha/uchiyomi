#!/usr/bin/env node
/**
 * Read-only diagnostic. Lists every lib_books row whose file does not actually exist on disk right now,
 * but whose row is NOT already marked pruned_at -- i.e. a chapter the database claims you have, that the
 * updater's "already have this chapter" check (bff/src/lib/updater.ts) will therefore never re-download,
 * but that has no real bytes behind it (a backup restore that copied the database without the files is
 * the usual cause).
 *
 * Nothing is changed. Run this first to see the size of the problem before running repair-orphaned-books.cjs.
 *
 * Plain CommonJS against the COMPILED server (dist/), not the TypeScript source: the shipped image never
 * has src/ or a dev copy of tsx, only dist/. Run it from the same directory as dist/ -- inside the
 * container that is /app, so:
 *
 *   docker cp bff/scripts/find-orphaned-books.cjs uchiyomi:/app/find-orphaned-books.cjs
 *   docker exec -it uchiyomi node /app/find-orphaned-books.cjs
 *   docker exec -it uchiyomi node /app/find-orphaned-books.cjs --json > orphans.json   # (see below for getting the file out)
 *
 * DATABASE_URL, DL_ROOT, LIBRARY_ROOT etc. are already set in that shell -- it's the running server's own
 * environment -- so nothing extra needs to be passed.
 */
const { stat } = require('fs/promises');
const { join } = require('path');

const asJson = process.argv.includes('--json');
const APP_ROOT = process.cwd(); // run this from the same directory dist/ lives in

const { q } = require(join(APP_ROOT, 'dist/lib/db.js'));
const { LIBRARY_ROOT } = require(join(APP_ROOT, 'dist/lib/library.js'));

async function main() {
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
      console.log(`\nRun with --json > orphans.json to feed this list into repair-orphaned-books.cjs.`);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
