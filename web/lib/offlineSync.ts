import { api } from './api';
import { downloadChapter, listDownloads } from './downloads';

let running = false;

/** Keep the latest N unread chapters of favorites downloaded. Runs foreground/online. */
export async function runSmartOffline(perSeries: number, onProgress?: (done: number, total: number) => void): Promise<number> {
  if (running || typeof navigator === 'undefined' || !navigator.onLine) return 0;
  running = true;
  try {
    const plan = await api<{ content: { bookId: string; seriesId: string }[] }>('/api/offline/plan?perSeries=' + perSeries);
    const have = new Set((await listDownloads()).map((c) => c.bookId));
    const todo = plan.content.filter((p) => !have.has(p.bookId));
    let done = 0;
    for (const p of todo) {
      try {
        await downloadChapter(p.bookId);
        done++;
        onProgress?.(done, todo.length);
      } catch {
        break; // quota or network — stop quietly
      }
    }
    return done;
  } catch {
    return 0;
  } finally {
    running = false;
  }
}
