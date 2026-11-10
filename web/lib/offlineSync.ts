import { api,getCurrentUser } from './api';
import { downloadChapter, listDownloads } from './downloads';
import { serverReachableHint } from './desktop';

let running = false;

/** Keep the latest N unread chapters of favorites downloaded. Runs foreground/online. */
export async function runSmartOffline(perSeries: number, onProgress?: (done: number, total: number) => void): Promise<number> {
  const actor=getCurrentUser();if(!actor)return 0;
  if (running || typeof navigator === 'undefined' || !serverReachableHint()) return 0;
  running = true;
  try {
    const plan = await api<{ content: { bookId: string; seriesId: string }[] }>('/api/offline/plan?perSeries=' + perSeries,{expectedOwnerId:actor});
    if(getCurrentUser()!==actor)return 0;
    const have = new Set((await listDownloads(actor)).map((c) => c.bookId));
    const todo = plan.content.filter((p) => !have.has(p.bookId));
    let done = 0;
    for (const p of todo) {
      try {
        await downloadChapter(p.bookId,undefined,actor);
        if(getCurrentUser()!==actor)break;
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
