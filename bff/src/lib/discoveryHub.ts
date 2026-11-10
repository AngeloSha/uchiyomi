// Discover choices belong to the signed-in account. Saved cards are snapshots of metadata already known to the
// server, never a client assertion that an unknown/adult work is safe. Feedback does not look anything up online.
import { q, one, tx } from './db';
import { normTitle } from './titleMatch';
import { viewerJudge } from './trackerRecs';
import type { ViewCtx } from './visibility';

export type DiscoverTab = 'for-you' | 'sources';
export interface DiscoveryItem {
  key: string;
  id: number | null;
  title: string;
  cover: string | null;
  coverXL?: string | null;
  banner?: string | null;
  description: string;
  genres: string[];
  score: number | null;
  chapters: number | null;
  status: string | null;
  country?: 'KR' | 'JP' | 'CN' | null;
}
interface Snapshot { item: DiscoveryItem; adult: boolean | null }
interface FeedbackRow { work_key: string; saved: boolean; hidden: boolean; snapshot: Snapshot | null }

const MAX_CHOICES = 1000;
export const validDiscoveryKey = (key: unknown): key is string => typeof key === 'string'
  && (/^al:[1-9][0-9]{0,9}$/.test(key) && Number(key.slice(3)) <= 2_147_483_647
    || /^t:[\p{L}\p{M}\p{N}]{1,600}$/u.test(key) && key.slice(2) === normTitle(key.slice(2)));

export function discoveryKey(item: { id?: unknown; key?: unknown; title?: unknown }): string {
  if (validDiscoveryKey(item.key)) return item.key;
  if (typeof item.id === 'number' && Number.isSafeInteger(item.id) && item.id > 0 && item.id <= 2_147_483_647) return `al:${item.id}`;
  return `t:${normTitle(typeof item.title === 'string' ? item.title : '')}`;
}

function aliases(row: FeedbackRow): string[] {
  const it = row.snapshot?.item;
  const keys = [row.work_key];
  if (it?.id) keys.push(`al:${it.id}`);
  if (it?.title) keys.push(`t:${normTitle(it.title)}`);
  return keys;
}

export async function hiddenDiscoveryKeys(userId: string): Promise<Set<string>> {
  const rows = await q<FeedbackRow>('SELECT work_key, saved, hidden, snapshot FROM discover_feedback WHERE user_id = $1 AND hidden', [userId]);
  return new Set(rows.flatMap(aliases));
}

/** Existing route shapes remain unchanged; only this person's explicit rejections leave their responses. */
export async function withoutHiddenDiscover<T extends { id?: unknown; title: string; altTitles?: string[]; sources?: Array<{ url?: string | null }> }>(
  userId: string, items: readonly T[],
): Promise<T[]> {
  const hidden = await hiddenDiscoveryKeys(userId);
  if (!hidden.size) return [...items];
  return items.filter((it) => {
    const keys = [discoveryKey(it), ...[it.title, ...(it.altTitles ?? [])].map((t) => `t:${normTitle(t)}`)];
    for (const source of it.sources ?? []) {
      const id = /^https:\/\/anilist\.co\/manga\/([1-9][0-9]*)\b/.exec(source.url ?? '')?.[1];
      if (id) keys.push(`al:${id}`);
    }
    return !keys.some((key) => hidden.has(key));
  });
}

const text = (v: unknown, max: number): string => typeof v === 'string' ? v.trim().replace(/[\p{Cc}]/gu, ' ').slice(0, max) : '';
function image(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 4096) return null;
  try { const u = new URL(v); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 10_000_000 ? v : null;

function anilistId(raw: any, source: string): number | null {
  const own = source === 'trending' || source === 'related' || source === 'anilist' ? Number(raw?.id) : null;
  const linked = /^https:\/\/anilist\.co\/manga\/([1-9][0-9]*)\b/.exec(typeof raw?.url === 'string' ? raw.url : '')?.[1];
  const id = own || (linked ? Number(linked) : null);
  return id && Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647 ? id : null;
}

function snapshotOf(raw: any, source: string, country: string | null, key: string): Snapshot | null {
  if (!raw || typeof raw !== 'object' || typeof raw.title !== 'string') return null;
  const title = text(raw.title, 600);
  if (!normTitle(title)) return null;
  const id = anilistId(raw, source);
  if (key.startsWith('al:') ? id !== Number(key.slice(3)) : normTitle(title) !== key.slice(2)) return null;
  const genres = [...new Set((Array.isArray(raw.genres) ? raw.genres : []).map((g: unknown) => text(g, 100)).filter(Boolean))] as string[];
  // The trending query explicitly asks isAdult:false. Related/tracker data has to carry its own rating.
  const adult = typeof raw.adult === 'boolean' ? raw.adult : source === 'trending' ? false : null;
  return {
    adult,
    item: { key, id, title, cover: image(raw.cover), coverXL: image(raw.coverXL), banner: image(raw.banner),
      description: text(raw.description, 12_000), genres: genres.slice(0, 50),
      score: typeof raw.score === 'number' && Number.isFinite(raw.score) && raw.score >= 0 && raw.score <= 100 ? raw.score : null,
      chapters: count(raw.chapters), status: text(raw.status, 60) || null,
      country: country === 'KR' || country === 'JP' || country === 'CN' ? country : null },
  };
}

/** Public work metadata only: no reading seed, tracker credential or other person's library title is returned. */
async function cachedSnapshots(refs: Array<{ key: string; title?: string }>): Promise<Map<string, Snapshot>> {
  const accepted = refs.filter(({ key, title }) => validDiscoveryKey(key)
    && (key.startsWith('al:') || !!title && normTitle(title) === key.slice(2)));
  const keys = new Set(accepted.map((ref) => ref.key));
  if (!keys.size) return new Map();
  const ids = accepted.filter((ref) => ref.key.startsWith('al:')).map((ref) => ref.key.slice(3));
  const titles = accepted.filter((ref) => ref.key.startsWith('t:')).map((ref) => ref.title!.toLowerCase());
  // One cache read for all saved choices, not one query per card. JSON caches are bounded by their existing fetchers;
  // jsonb_typeof also makes an old or malformed cache harmless. No refresh or external fetch can run here.
  const rows = await q<{ item: unknown; source: string; country: string | null; fetched_at: string }>(`
    SELECT it AS item, source, country, fetched_at FROM (
      SELECT e.value AS it, 'trending'::text AS source, c.country, c.fetched_at
        FROM anilist_trending c CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.items)='array' THEN c.items ELSE '[]'::jsonb END) e
      UNION ALL
      SELECT e.value, 'related', NULL, c.fetched_at
        FROM anilist_related c CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.recs)='array' THEN c.recs ELSE '[]'::jsonb END) e
      UNION ALL
      SELECT e.value, c.provider, NULL, c.fetched_at
        FROM tracker_rec_cache c CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.recs)='array' THEN c.recs ELSE '[]'::jsonb END) e
    ) candidates
    WHERE (source IN ('trending','related','anilist') AND it->>'id'=ANY($1::text[]))
       OR (it->>'url' ~ '^https://anilist[.]co/manga/[1-9][0-9]*(/|$)' AND split_part(it->>'url','/',5)=ANY($1::text[]))
       OR lower(it->>'title')=ANY($2::text[])
    ORDER BY fetched_at DESC`, [ids, titles]);
  const found = new Map<string, Snapshot>();
  for (const row of rows) {
    const raw = row.item as any;
    const id = anilistId(raw, row.source);
    const possible = [id ? `al:${id}` : '', `t:${normTitle(typeof raw?.title === 'string' ? raw.title : '')}`];
    for (const key of possible) {
      if (!keys.has(key)) continue;
      const next = snapshotOf(raw, row.source, row.country, key);
      if (!next) continue;
      const best = found.get(key);
      if (!best) { found.set(key, next); continue; }
      // A second trusted source calling the work adult must not be overridden by a less informative older copy.
      if (next.adult === true) best.adult = true;
      best.item.genres = [...new Set([...best.item.genres, ...next.item.genres])].slice(0, 50);
      best.item.country ??= next.item.country;
      best.item.banner ??= next.item.banner;
      best.item.cover ??= next.item.cover;
      best.item.coverXL ??= next.item.coverXL;
      best.item.description ||= next.item.description;
      best.item.status ??= next.item.status;
      best.item.chapters ??= next.item.chapters;
    }
  }
  return found;
}
async function cachedSnapshot(key: string, titleHint?: string): Promise<Snapshot | null> {
  return (await cachedSnapshots([{ key, title: titleHint }])).get(key) ?? null;
}

function canShow(snapshot: Snapshot, ctx: ViewCtx): boolean {
  return viewerJudge(ctx)({ adult: snapshot.adult, genres: snapshot.item.genres });
}

export async function discoveryState(userId: string, ctx: ViewCtx): Promise<{ tab: DiscoverTab; saved: DiscoveryItem[]; hidden: string[] }> {
  const [pref, rows] = await Promise.all([
    one<{ tab: unknown }>(`SELECT data->>'discoverTab' AS tab FROM app_settings WHERE user_id=$1`, [userId]),
    q<FeedbackRow>('SELECT work_key, saved, hidden, snapshot FROM discover_feedback WHERE user_id=$1 ORDER BY updated_at DESC, work_key', [userId]),
  ]);
  const current = await cachedSnapshots(rows.filter((row) => row.saved && row.snapshot)
    .map((row) => ({ key: row.work_key, title: row.snapshot!.item.title })));
  const refreshed: Array<{ key: string; before: Snapshot; after: Snapshot }> = [];
  for (const row of rows) {
    const fresh = current.get(row.work_key);
    if (!fresh || !row.snapshot) continue;
    if (JSON.stringify(fresh) !== JSON.stringify(row.snapshot)) refreshed.push({ key: row.work_key, before: row.snapshot, after: fresh });
    row.snapshot = fresh;
  }
  if (refreshed.length) {
    // Retain a newly learned rating even if the source cache is later pruned. Compare-and-set prevents this metadata
    // refresh from overwriting a concurrent user's edit; updated_at stays unchanged so saved cards do not jump.
    await q(`UPDATE discover_feedback f SET snapshot=changes.after
      FROM jsonb_to_recordset($2::jsonb) AS changes(key text,before jsonb,after jsonb)
      WHERE f.user_id=$1 AND f.work_key=changes.key AND f.snapshot=changes.before`, [userId, JSON.stringify(refreshed)]);
  }
  const saved: DiscoveryItem[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.saved || !row.snapshot || !canShow(row.snapshot, ctx)) continue;
    const keys = aliases(row);
    if (keys.some((key) => seen.has(key))) continue;
    keys.forEach((key) => seen.add(key));
    saved.push(row.snapshot.item);
  }
  return { tab: pref?.tab === 'sources' ? 'sources' : 'for-you', saved,
    hidden: [...new Set(rows.filter((r) => r.hidden).flatMap(aliases))] };
}

export async function setDiscoveryTab(userId: string, tab: DiscoverTab): Promise<void> {
  await q(`INSERT INTO app_settings(user_id,data) VALUES($1,jsonb_build_object('discoverTab',$2::text))
    ON CONFLICT(user_id) DO UPDATE SET data=app_settings.data || EXCLUDED.data`, [userId, tab]);
}

export class DiscoveryChoiceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function setDiscoveryChoice(userId: string, ctx: ViewCtx, key: string, change: { saved?: boolean; hidden?: boolean; title?: string }): Promise<{ key: string; saved: boolean; hidden: boolean }> {
  let fresh: Snapshot | null = null;
  if (change.saved === true || change.hidden === true) fresh = await cachedSnapshot(key, change.title);
  if (change.saved === true && (!fresh || !canShow(fresh, ctx))) {
    // Same error for a forbidden or unknown title: this endpoint is not a way to probe a restricted catalog.
    throw new DiscoveryChoiceError(404, 'This title is no longer available to save. Refresh Discover and try again.');
  }
  return tx(async (qq) => {
    // Serialize the bounded per-account collection, including two tabs saving their first choice concurrently.
    await qq('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`discover:${userId}`]);
    const rows = await qq<FeedbackRow>('SELECT work_key,saved,hidden,snapshot FROM discover_feedback WHERE user_id=$1 ORDER BY updated_at DESC', [userId]);
    const freshKeys = new Set([key, ...(fresh ? aliases({ work_key: key, saved: false, hidden: false, snapshot: fresh }) : [])]);
    const before = rows.filter((row) => aliases(row).some((alias) => freshKeys.has(alias)));
    const snapshot = fresh ?? before.find((row) => row.snapshot)?.snapshot ?? null;
    const canonicalKey = snapshot?.item.id ? `al:${snapshot.item.id}` : key;
    if (snapshot) snapshot.item.key = canonicalKey;
    const saved = change.saved ?? before.some((row) => row.saved);
    const hidden = change.hidden ?? before.some((row) => row.hidden);
    const replaced = [...new Set([canonicalKey, ...before.map((row) => row.work_key)])];
    if (!saved && !hidden) {
      await qq('DELETE FROM discover_feedback WHERE user_id=$1 AND work_key=ANY($2::text[])', [userId, replaced]);
      return { key: canonicalKey, saved, hidden };
    }
    if (!before.length && rows.length >= MAX_CHOICES) {
      throw new DiscoveryChoiceError(409, 'Your Discover list is full. Remove a saved or hidden title before adding another.');
    }
    await qq('DELETE FROM discover_feedback WHERE user_id=$1 AND work_key=ANY($2::text[])', [userId, replaced.filter((old) => old !== canonicalKey)]);
    await qq(`INSERT INTO discover_feedback(user_id,work_key,saved,hidden,snapshot) VALUES($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT(user_id,work_key) DO UPDATE SET saved=EXCLUDED.saved,hidden=EXCLUDED.hidden,
      snapshot=EXCLUDED.snapshot,updated_at=now()`, [userId, canonicalKey, saved, hidden, snapshot ? JSON.stringify(snapshot) : null]);
    return { key: canonicalKey, saved, hidden };
  });
}

export async function clearDiscoveryChoice(userId: string, key: string): Promise<void> {
  await tx(async (qq) => {
    await qq('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`discover:${userId}`]);
    const rows = await qq<FeedbackRow>('SELECT work_key,saved,hidden,snapshot FROM discover_feedback WHERE user_id=$1', [userId]);
    const keys = rows.filter((row) => aliases(row).includes(key)).map((row) => row.work_key);
    await qq('DELETE FROM discover_feedback WHERE user_id=$1 AND work_key=ANY($2::text[])', [userId, keys]);
  });
}
export async function resetHiddenDiscovery(userId: string): Promise<void> {
  await tx(async (qq) => {
    await qq('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`discover:${userId}`]);
    await qq('DELETE FROM discover_feedback WHERE user_id=$1 AND hidden AND NOT saved', [userId]);
    await qq('UPDATE discover_feedback SET hidden=false,updated_at=now() WHERE user_id=$1 AND hidden', [userId]);
  });
}
