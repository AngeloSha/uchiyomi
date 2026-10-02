// Read the titles out of a PUBLIC MangaDex custom list.
//
// Only public lists work: MangaDex's own "follows" endpoint (/user/follows/manga) requires an OAuth session,
// and this app has no MangaDex account plumbing. Users who want their follows imported can make a list public
// and paste its URL, which needs no credentials from anyone.
//
// Through the MangaDex adapters' own limiter (sources/mangadex.ts mdGet), so a long list read while the sweep or
// Discover is asking MangaDex counts against the one rate limit they share, and waits out a pause they earned.
import { mdGet } from './sources/mangadex';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Accept a full URL (https://mangadex.org/list/<uuid>/name) or a bare list id. */
export function listIdFrom(input: string): string | null {
  return input.match(UUID)?.[0] ?? null;
}

interface MdManga {
  id: string;
  attributes?: { title?: Record<string, string>; altTitles?: Record<string, string>[] };
}

/** Prefer English, then romanized Japanese, then whatever the list gives us. */
function pickTitle(m: MdManga): string {
  const t = m.attributes?.title ?? {};
  const alts = m.attributes?.altTitles ?? [];
  const en = t.en || alts.find((a) => a.en)?.en;
  const ja = t['ja-ro'] || alts.find((a) => a['ja-ro'])?.['ja-ro'];
  return (en || ja || Object.values(t)[0] || '').trim();
}

/**
 * One request, with the answers a person importing a list can act on: a list that is not there (or not public),
 * MangaDex asking to slow down (a 429, or the shared pause the limiter refused to wait out), anything else by status.
 */
async function ask(url: string, isList = false): Promise<any> {
  try {
    return await mdGet(url);
  } catch (e) {
    const err = e as { status?: number; selfTimeout?: boolean; message?: string };
    if (isList && err.status === 404) throw new Error('List not found — is it public?');
    if (err.status === 429 || err.selfTimeout) throw new Error('MangaDex asked Uchiyomi to slow down. Try again in a minute.');
    throw new Error(err.status ? `MangaDex returned ${err.status}` : err.message || 'MangaDex did not answer.');
  }
}

export async function titlesFromMangadexList(input: string): Promise<string[]> {
  const id = listIdFrom(input);
  if (!id) throw new Error('That does not look like a MangaDex list link.');

  const list = await ask(`https://api.mangadex.org/list/${id}`, true);
  const mangaIds: string[] = (list?.data?.relationships ?? [])
    .filter((r: any) => r?.type === 'manga')
    .map((r: any) => r.id);
  if (!mangaIds.length) throw new Error('That list has no manga in it.');

  // /manga accepts up to 100 ids per call. No pause between pages of our own: the limiter spaces them.
  const titles: string[] = [];
  for (let i = 0; i < mangaIds.length; i += 100) {
    const params = new URLSearchParams();
    params.set('limit', '100');
    for (const mid of mangaIds.slice(i, i + 100)) params.append('ids[]', mid);
    const body = await ask(`https://api.mangadex.org/manga?${params}`);
    for (const m of (body?.data ?? []) as MdManga[]) {
      const t = pickTitle(m);
      if (t) titles.push(t);
    }
  }
  if (!titles.length) throw new Error('Could not read any titles from that list.');
  return [...new Set(titles)];
}

/**
 * Same list, shaped like `BackupEntry` (title only — MangaDex ids don't map onto anyone else's source
 * registry) so the import-batch intake in routes/admin.ts can treat every origin identically. This is also
 * the shape a future tracker-list intake (AniList/MAL) should return.
 */
export async function entriesFromMangadexList(input: string): Promise<Array<{ title: string }>> {
  return (await titlesFromMangadexList(input)).map((title) => ({ title }));
}
