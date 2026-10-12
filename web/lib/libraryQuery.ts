// The Library's address as a smart list's query (v0.61.0), and back.
//
// A smart list is a saved Library search, and the server keeps it in the Library's own URL words (bff
// lib/smartLists.ts): "Save as list" writes what is on screen, "Edit filters" opens it again, and the server answers it
// with the Library's exact search. So the condition tree lives here, in one place, for the Library page and for the
// server's port of it -- both are held to the same fixtures (web/test/fixtures/smartQueries.json).
//
// Pure, so it is unit-tested (test/v610Lists.test.ts) rather than looked for in a browser.
import { t as tr } from './i18n';
import { SORTS, naturalDir, validDir, type SortDir } from './librarySort';
import { NO_SOURCE, READ_STATES, STATUSES } from '@/components/LibraryFilters';

/** A smart list's query: the Library URL's parameters (bff lib/smartLists.ts smartQuery, which refuses anything else). */
export interface SmartQuery {
  v: 1;
  q?: string;
  read?: 'UNREAD' | 'IN_PROGRESS' | 'READ';
  status?: string;
  genres?: string[];
  lib?: string;
  src?: string;
  anysrc?: string;
  sort: string;
  dir?: SortDir;
}

/** Build the condition tree from the URL. Empty means no condition at all, which needs no user context. */
export function conditionFrom(read: string, status: string, genres: string[], lib: string, src = '', anysrc = '') {
  const all: any[] = [];
  if (lib) all.push({ libraryId: { operator: 'is', value: lib } });
  // The two source filters (bff ownedCatalog condSql): the source a series was added from, and any source
  // it reads from -- added from it, or following it as a fallback. Main source's "No source" (#149) is a condition of its
  // own, never `mainSource` with the sentinel: an older server would answer that with an empty grid, not a 400.
  if (src === NO_SOURCE) all.push({ hasMainSource: { operator: 'isFalse' } });
  else if (src) all.push({ mainSource: { operator: 'is', value: src } });
  if (anysrc) all.push({ anySource: { operator: 'is', value: anysrc } });
  if (read) all.push({ readStatus: { operator: 'is', value: read } });
  if (status) all.push({ status: { operator: 'is', value: status } });
  for (const g of genres) all.push({ genre: { operator: 'is', value: g } });
  return all.length ? { allOf: all } : undefined;
}

/** The condition tree of a saved query: what the Library asked when it was saved. */
export const conditionOfQuery = (q: SmartQuery) =>
  conditionFrom(q.read ?? '', q.status ?? '', q.genres ?? [], q.lib ?? '', q.src ?? '', q.anysrc ?? '');

const READS = new Set(['UNREAD', 'IN_PROGRESS', 'READ']);
const validSort = (v: unknown): v is string => typeof v === 'string' && SORTS.some((s) => s.key === v);

/**
 * The shelf on screen as a query: the URL's filters and search, and the order in force -- `shown`, the page's own
 * order and direction, which may be the account's saved default rather than anything in the URL. A direction is kept
 * only when it runs against the order's own, as the Library's address keeps it.
 */
export function queryOfParams(params: URLSearchParams, shown?: { sort?: string; dir?: SortDir }): SmartQuery {
  const get = (k: string) => (params.get(k) || '').trim();
  const sort = validSort(shown?.sort) ? shown!.sort! : validSort(get('sort')) ? get('sort') : SORTS[0].key;
  const dir = shown?.dir ?? (validDir(get('dir')) ? (get('dir') as SortDir) : undefined);
  const natural = naturalDir(SORTS.find((s) => s.key === sort)!);
  const genres = get('genres').split(',').map((g) => g.trim()).filter(Boolean);
  const read = get('read');
  return {
    v: 1,
    ...(get('q') ? { q: get('q') } : {}),
    ...(READS.has(read) ? { read: read as SmartQuery['read'] } : {}),
    ...(get('status') ? { status: get('status') } : {}),
    ...(genres.length ? { genres } : {}),
    ...(get('lib') ? { lib: get('lib') } : {}),
    ...(get('src') ? { src: get('src') } : {}),
    ...(get('anysrc') ? { anysrc: get('anysrc') } : {}),
    sort,
    ...(dir && dir !== natural ? { dir } : {}),
  };
}

/** The Library showing a query, and -- for its owner's Edit filters -- which list it came from (`list`). */
export function libraryHref(q: SmartQuery, listId?: string): string {
  const p = new URLSearchParams();
  if (q.q) p.set('q', q.q);
  if (q.read) p.set('read', q.read);
  if (q.status) p.set('status', q.status);
  if (q.genres?.length) p.set('genres', q.genres.join(','));
  if (q.lib) p.set('lib', q.lib);
  if (q.src) p.set('src', q.src);
  if (q.anysrc) p.set('anysrc', q.anysrc);
  p.set('sort', q.sort);
  if (q.dir) p.set('dir', q.dir);
  if (listId) p.set('list', listId);
  return `/library?${p.toString()}`;
}

/** Two queries ask for the same shelf. */
export const sameQuery = (a: SmartQuery | null | undefined, b: SmartQuery | null | undefined): boolean =>
  !!a && !!b && JSON.stringify(normal(a)) === JSON.stringify(normal(b));
const normal = (q: SmartQuery) => [q.q ?? '', q.read ?? '', q.status ?? '', (q.genres ?? []).join(','), q.lib ?? '', q.src ?? '', q.anysrc ?? '', q.sort, q.dir ?? ''];

/**
 * A name for a new list, from what it narrows by: the search in quotes, the reading state, the status, the genres, the
 * library and the source, in the reader's words ("“solo”", "Not started · Romance"); with nothing narrowing, the order
 * itself ("Most popular"). The names of a library and a source are the page's to give, as its chips show them. At most
 * 120 characters, the server's limit for a name.
 */
export function suggestListName(q: SmartQuery, names: { lib?: (id: string) => string; source?: (id: string) => string } = {}): string {
  const parts: string[] = [];
  if (q.q) parts.push(`“${q.q}”`);
  const read = READ_STATES.find((r) => r.key === q.read);
  if (read) parts.push(tr(read.label));
  const status = STATUSES.find((s) => s.key === q.status);
  if (q.status) parts.push(status ? tr(status.label) : q.status);
  parts.push(...(q.genres ?? []));
  if (q.lib) parts.push(names.lib?.(q.lib) || q.lib);
  for (const id of [q.src, q.anysrc]) if (id) parts.push(id === NO_SOURCE ? tr('No source') : names.source?.(id) || id);
  const name = parts.length ? parts.join(' · ') : tr(SORTS.find((s) => s.key === q.sort)?.label ?? SORTS[0].label);
  return name.length > 120 ? `${name.slice(0, 119)}…` : name;
}
