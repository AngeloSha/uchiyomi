// Read the titles out of a PUBLIC MangaDex custom list.
//
// Only public lists work: MangaDex's own "follows" endpoint (/user/follows/manga) requires an OAuth session,
// and this app has no MangaDex account plumbing. Users who want their follows imported can make a list public
// and paste its URL, which needs no credentials from anyone.

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

export async function titlesFromMangadexList(input: string): Promise<string[]> {
  const id = listIdFrom(input);
  if (!id) throw new Error('That does not look like a MangaDex list link.');

  const listRes = await fetch(`https://api.mangadex.org/list/${id}`, { signal: AbortSignal.timeout(15000) });
  if (listRes.status === 404) throw new Error('List not found — is it public?');
  if (!listRes.ok) throw new Error(`MangaDex returned ${listRes.status}`);
  const list = (await listRes.json()) as any;
  const mangaIds: string[] = (list?.data?.relationships ?? [])
    .filter((r: any) => r?.type === 'manga')
    .map((r: any) => r.id);
  if (!mangaIds.length) throw new Error('That list has no manga in it.');

  // /manga accepts up to 100 ids per call
  const titles: string[] = [];
  for (let i = 0; i < mangaIds.length; i += 100) {
    const params = new URLSearchParams();
    params.set('limit', '100');
    for (const mid of mangaIds.slice(i, i + 100)) params.append('ids[]', mid);
    const r = await fetch(`https://api.mangadex.org/manga?${params}`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`MangaDex returned ${r.status}`);
    const body = (await r.json()) as any;
    for (const m of (body?.data ?? []) as MdManga[]) {
      const t = pickTitle(m);
      if (t) titles.push(t);
    }
    if (i + 100 < mangaIds.length) await new Promise((s) => setTimeout(s, 300)); // stay polite
  }
  if (!titles.length) throw new Error('Could not read any titles from that list.');
  return [...new Set(titles)];
}
