// New-chapter updater: for each owned series, ask its source for chapters we don't have yet and download
// them via the downloader. Replaces Suwayomi's update loop. Source routing comes straight from the
// lib_series.source_id / source_series_id columns stamped at add time (backfilled once for older rows) —
// no display-name keyword matching or <Web>-url reverse-parsing.
import { q, one } from './db';
import { getSource } from './sources';
import { downloadChapter } from './downloader';
import { persistScan } from './library';
import { blockedNow } from './sourceHealth';
import { notifyNewChapter } from './push';

export async function updateSeries(seriesId: string, maxNew = 10): Promise<{ title: string; added: number; available: number }> {
  const s = await one<any>('SELECT id,title,source_id,source_series_id,web,folder,summary,author,genres,status FROM lib_series WHERE id=$1', [seriesId]);
  if (!s) return { title: '', added: 0, available: 0 };
  const src = s.source_id ? getSource(s.source_id) : null;
  const ref = s.source_series_id;
  if (!src || !ref) return { title: s.title, added: 0, available: 0 }; // source not installed / row not routed → skip
  if (await blockedNow(s.source_id)) return { title: s.title, added: 0, available: 0 }; // back off a blocked source

  const chapters = await src.listChapters(ref).catch(() => []);
  if (!chapters.length) return { title: s.title, added: 0, available: 0 };

  const have = new Set((await q<{ number: number }>('SELECT number FROM lib_books WHERE series_id=$1', [seriesId])).map((r) => Number(r.number)));
  const missing = chapters.filter((c) => !have.has(c.number)).sort((a, b) => a.number - b.number);

  let added = 0;
  // oldest-missing-first: a partial "first N" add fills forward coherently, and new releases (all > our max)
  // are still the only gap once a series is fully downloaded.
  for (const ch of missing.slice(0, maxNew)) {
    try {
      const res = await downloadChapter({
        sourceId: s.source_id,
        seriesFolder: s.folder,
        chapter: ch,
        meta: { series: s.title, summary: s.summary, author: s.author, genres: s.genres, url: s.web, status: s.status },
      });
      if (!res.skipped) added++;
    } catch {
      // a failed chapter shouldn't abort the rest
    }
  }
  if (added) notifyNewChapter(seriesId, s.title, added).catch(() => {});
  return { title: s.title, added, available: chapters.length };
}

/** Sweep the library for new chapters. onlyFavorites keeps a manual run quick; throttled for politeness. */
export async function runUpdateAll(opts: { onlyFavorites?: boolean; maxNew?: number } = {}): Promise<{ series: number; added: number }> {
  const ids = opts.onlyFavorites
    ? (await q<{ series_id: string }>('SELECT DISTINCT f.series_id FROM favorites f JOIN lib_series s ON s.id = f.series_id WHERE s.auto_update')).map((r) => r.series_id)
    : (await q<{ id: string }>('SELECT id FROM lib_series WHERE auto_update ORDER BY latest_mtime DESC')).map((r) => r.id);
  let added = 0;
  for (const id of ids) {
    const r = await updateSeries(id, opts.maxNew ?? 10).catch(() => ({ added: 0 }));
    added += r.added;
    await new Promise((res) => setTimeout(res, 1500));
  }
  if (added) await persistScan();
  return { series: ids.length, added };
}
