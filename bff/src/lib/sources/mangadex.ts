// MangaDex built-in source — official public API (no key, no scraping, no Cloudflare). The most defensible
// source, so it's bundled in the core and always on. Docs: https://api.mangadex.org/docs/
import { SourceAdapter, SourceSeries, SourceChapter } from './types';

const API = 'https://api.mangadex.org';
const HEADERS = { 'user-agent': 'Yomi/1.0 (self-hosted personal reader)' };
const RATINGS = ['safe', 'suggestive', 'erotica'].map((r) => `contentRating[]=${r}`).join('&');

async function jget(url: string): Promise<any> {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`mangadex ${r.status}`);
  return r.json();
}

function firstLang(obj: any): string {
  if (!obj) return '';
  return obj.en || obj['ja-ro'] || (Object.values(obj)[0] as string) || '';
}

function toSeries(m: any): SourceSeries {
  const a = m.attributes || {};
  const cover = (m.relationships || []).find((r: any) => r.type === 'cover_art');
  const author = (m.relationships || []).find((r: any) => r.type === 'author' || r.type === 'artist');
  const genres = (a.tags || [])
    .filter((t: any) => ['genre', 'theme'].includes(t.attributes?.group))
    .map((t: any) => firstLang(t.attributes?.name))
    .filter(Boolean);
  return {
    sourceId: m.id,
    source: 'mangadex',
    title: firstLang(a.title) || (a.altTitles || []).map((t: any) => firstLang(t)).find(Boolean) || 'Untitled',
    summary: firstLang(a.description),
    status: a.status ? String(a.status).toUpperCase() : undefined,
    genres,
    author: author?.attributes?.name,
    coverUrl: cover?.attributes?.fileName ? `https://uploads.mangadex.org/covers/${m.id}/${cover.attributes.fileName}` : undefined,
    url: `https://mangadex.org/title/${m.id}`,
  };
}

export const mangadex: SourceAdapter = {
  id: 'mangadex',
  name: 'MangaDex',
  imageReferer: 'https://mangadex.org/', // CDN rejects image fetches without the mangadex referer
  preferredOrder: 10,

  async search(query) {
    const j = await jget(`${API}/manga?title=${encodeURIComponent(query)}&limit=12&${RATINGS}&includes[]=cover_art&includes[]=author&order[relevance]=desc`);
    return (j.data || []).map(toSeries);
  },

  async getSeries(id) {
    const j = await jget(`${API}/manga/${id}?includes[]=cover_art&includes[]=author`);
    return j.data ? toSeries(j.data) : null;
  },

  async listChapters(seriesId) {
    const all: SourceChapter[] = [];
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const j = await jget(`${API}/manga/${seriesId}/feed?translatedLanguage[]=en&order[chapter]=asc&order[volume]=asc&limit=500&offset=${offset}&${RATINGS}`);
      total = j.total ?? 0;
      for (const c of j.data || []) {
        const num = parseFloat(c.attributes?.chapter);
        if (Number.isNaN(num)) continue;
        all.push({ sourceId: c.id, number: num, title: c.attributes?.title || undefined, lang: c.attributes?.translatedLanguage, pages: c.attributes?.pages });
      }
      offset += 500;
      if (!j.data?.length) break;
    }
    // one entry per chapter number, preferring hosted chapters (pages>0) over external/licensed (pages=0)
    const byNum = new Map<number, SourceChapter>();
    for (const c of all) {
      const ex = byNum.get(c.number);
      if (!ex || ((c.pages || 0) > 0 && (ex.pages || 0) === 0)) byNum.set(c.number, c);
    }
    return [...byNum.values()].sort((a, b) => a.number - b.number);
  },

  async getPageUrls(chapterId) {
    const j = await jget(`${API}/at-home/server/${chapterId}`);
    const base = j.baseUrl;
    const hash = j.chapter?.hash;
    const files: string[] = j.chapter?.data || [];
    return files.map((f) => `${base}/data/${hash}/${f}`);
  },
};
