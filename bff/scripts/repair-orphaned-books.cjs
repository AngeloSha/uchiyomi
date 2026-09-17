#!/usr/bin/env node
/**
 * Repairs lib_books rows left behind by a backup restore that copied the database but not (all of) the
 * chapter files: a row exists, pruned_at is NULL, but the file is not on disk. The updater's "already have
 * this chapter" check (bff/src/lib/updater.ts) counts ANY row -- pruned or not -- as "do not refetch", by
 * design (it is what makes the read-chapter cleanup feature stick). So these rows silently block "Check
 * now" and "Download newest" for every affected chapter number, forever, with no code bug involved.
 *
 * This script does NOT touch the database directly. It drives the app's own, already-tested admin API:
 *   1. POST /api/admin/series/:id/chapters/delete   -- marks the stale rows pruned_at (honest bookkeeping;
 *      skips anything bookmarked, exactly like a manual delete would)
 *   2. POST /api/admin/series/:id/chapters/refetch  -- re-downloads those same chapters onto the same rows,
 *      bypassing the sweep's have/missing computation entirely (this route works on named chapters, not on
 *      "what's missing")
 *
 * Plain CommonJS, no build tools needed -- it only talks HTTP to your own running server, so it can be run
 * from ANYWHERE that can reach it (your laptop, inside the container, doesn't matter), unlike
 * find-orphaned-books.cjs which must run inside the container.
 *
 * Requires an admin API token (Settings > API tokens > new token, scope "admin") and your instance's base
 * URL. Step 1 only sets pruned_at (recoverable, same as the built-in Delete button); nothing is unlinked
 * from disk that wasn't already missing.
 *
 * Usage:
 *   node repair-orphaned-books.cjs --base http://localhost:8080 --token yomi_xxx --file orphans.json --dry-run
 *   node repair-orphaned-books.cjs --base http://localhost:8080 --token yomi_xxx --file orphans.json
 */
const { readFileSync } = require('fs');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);
const dryRun = process.argv.includes('--dry-run');
const BATCH = 300; // FILL_MAX_CHAPTERS, bff/src/routes/sources.ts

if (!args.base || !args.token || !args.file) {
  console.error('Usage: repair-orphaned-books.cjs --base <url> --token <admin API token> --file <orphans.json> [--dry-run]');
  process.exit(1);
}

async function main() {
  const orphans = JSON.parse(readFileSync(args.file, 'utf8'));
  const bySeries = new Map();
  for (const o of orphans) {
    if (!bySeries.has(o.series_id)) bySeries.set(o.series_id, { title: o.title, ids: [] });
    bySeries.get(o.series_id).ids.push(o.id);
  }

  console.log(`${orphans.length} row(s) across ${bySeries.size} series.${dryRun ? ' (dry run: no requests will be sent)' : ''}`);

  const call = async (path, body) => {
    if (dryRun) return { ok: true, dryRun: true };
    const res = await fetch(`${args.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${args.token}` },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`);
    return json;
  };

  for (const [seriesId, { title, ids }] of bySeries) {
    console.log(`\n${title} (${seriesId}) -- ${ids.length} chapter(s)`);
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      try {
        const del = await call(`/api/admin/series/${seriesId}/chapters/delete`, { bookIds: batch });
        console.log(`  delete: applied=${del.applied ?? '?'} skipped=${del.skipped?.length ?? 0}`);
      } catch (e) {
        console.error(`  delete FAILED: ${e.message}`);
        continue; // do not refetch a batch whose tombstone step failed
      }
      try {
        const ref = await call(`/api/admin/series/${seriesId}/chapters/refetch`, { bookIds: batch });
        console.log(`  refetch: skipped=${ref.skipped?.length ?? 0}${ref.skipped?.length ? ' (' + ref.skipped.map((s) => s.reason).join(', ') + ')' : ''}`);
      } catch (e) {
        console.error(`  refetch FAILED: ${e.message}`);
      }
    }
  }

  console.log(dryRun ? '\nDry run complete. Re-run without --dry-run to apply.' : '\nDone. Check the series pages -- a source that is slow or down leaves its chapters "skipped", to retry later.');
}

main().catch((e) => { console.error(e); process.exit(1); });
