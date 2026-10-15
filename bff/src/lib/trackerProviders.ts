// One adapter per tracker.
//
// `trackers.ts` was written with a note saying provider is carried everywhere "so MAL/Kitsu can be added
// without a migration", and that turned out to be true: the schema keys on (user_id, provider) and nothing
// needed changing. What was NOT abstracted was the calls that actually talk to a service -- prove a token,
// push progress and, since v0.36.0, read the account's list -- so those live here and the sync path and the
// import intake pick an adapter instead of hardcoding AniList.
//
// Every tracker connects by PASTING A TOKEN, which is the same honest, dependency-free path AniList already used:
// no client registration, no redirect URLs to configure, nothing to keep secret server-side. A full OAuth
// dance would need every self-hoster to register an application with each service and put the secret in
// their compose file, which is a worse trade for a household app than copying a token once. Since v0.61.0
// the AniList token comes from the project's own public client, whose page shows it (ANILIST_CLIENT_ID below):
// still a paste, and still nothing secret anywhere. MangaUpdates (#244) shows no token either: its login API answers
// one, which the person asks for themself and pastes, as for MyAnimeList and Kitsu.

import { createHash } from 'crypto';
import { muTurn } from './mangaupdates';

export type Provider = 'anilist' | 'myanimelist' | 'kitsu' | 'mangaupdates';

/** The reading-list buckets every tracker has, in the app's own words; each adapter maps its service's names. */
export const LIST_STATUSES = ['reading', 'plan_to_read', 'completed', 'on_hold', 'dropped'] as const;
export type ListStatus = (typeof LIST_STATUSES)[number];

/** An entry's bucket as a push reads it (v0.61.2, #201): the five above, or `rereading` for a re-read in progress. */
export type EntryStatus = ListStatus | 'rereading';
/**
 * What a push may set, as trackers.ts pushStatus decides it: reading, completed, or a re-read kept as one -- and
 * `planning`, which only an add sets (v0.68.0, #223, trackers.ts planSeriesOnAdd), on a series not on the list yet.
 */
export type PushStatus = 'reading' | 'completed' | 'rereading' | 'planning';

/**
 * What the service says before a push (v0.61.2, #201): whether the series has ENDED there -- finished, or cancelled or
 * discontinued, no more chapters coming either way -- how many chapters it has (null while unknown, which it always is
 * while a series runs), and this account's own entry, null when the series is not on its list yet. `ref` is the
 * adapter's own note for its setProgress (Kitsu's entry), read nowhere else.
 */
export interface SeriesState {
  ended: boolean;
  total: number | null;
  entry: { status: EntryStatus; progress: number } | null;
  ref?: unknown;
}

/** A count the service gave, or null: MAL says 0 and AniList and Kitsu say null for "not known yet". */
const positiveInt = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const progressOf = (v: unknown): number => Math.max(0, Math.floor(Number(v) || 0));

/**
 * One entry of a person's list, as the import intake wants it: a search title (English first, the way the
 * add dialog searches), the other spellings for a second try, the bucket it sits in, how far the person got
 * there (the floor a first push must never go under), and whether it is a manga at all -- tracker "manga"
 * lists carry light novels, which would otherwise resolve to their adaptation and be linked to the wrong work.
 */
export interface LibraryEntry {
  externalId: string;
  title: string;
  altTitles: string[];
  status: ListStatus;
  progress: number;
  format: 'manga' | 'novel' | 'other';
  /** The person's own rating on a 0-10 scale; absent when they have not rated it (both services use 0 for that). */
  score?: number;
  /** Chapters in the library for this series, when Uchiyomi holds it: lets a few chapters of a long series count for little. */
  total?: number;
  /** When the person last read a chapter of it in Uchiyomi (epoch ms); absent when never read here. */
  lastRead?: number;
}
/** How many entries one intake reads at most: the review batch keeps 500, one more says "truncated". */
export const TRACKER_LIST_MAX = 501;

/**
 * The server's canonical title key, byte-for-byte the `norm` of routes/sources.ts. Not imported from there
 * because a lib module must not pull a route in (routes load `env`, which a unit test without a database
 * cannot satisfy), and duplicated on purpose so the intake's dedupe and the matcher's scoring agree on what
 * "the same title" means. ⚠️ Change one and the other must follow.
 */
export const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** A title field is only a title when something is left after trimming: MAL sends `""` for a missing English
 *  title and Kitsu sends `null`, and either would otherwise become the search term. */
const nonEmpty = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
};

/**
 * An alternate whose `normTitle` key is shorter than this is an abbreviation, not a title: AniList's synonyms
 * are full of `AoT`, `SnK`, `MHA`, `BNHA`, and Kitsu's abbreviatedTitles are the same list upper-cased. Such
 * a key never matches a result exactly, only by `contains`, and three letters are contained in almost any
 * title -- 'AoT' resolved 'Attack on Titan' to 'Chaotic Love Story' on the first source that lacked the
 * series, before the exact hit one source later was ever asked for. (The search TITLE is exempt: 'Ajin' is
 * a real four-letter title, and it is searched exactly, not by containment.)
 */
const MIN_ALT_KEY = 5;

/**
 * Pick the search title and the alternates from a provider's title fields, in order of preference: the first
 * non-empty one is the title, the rest are alternates deduped by `normTitle` (an English and a romaji field
 * that spell the same thing are one search) and capped at 3 — every alternate is one more outbound search
 * per source that misses. An alternate whose key normalises to nothing (a kana or hangul spelling) or to an
 * abbreviation (see MIN_ALT_KEY) is dropped: the matcher scores by that key, and a short or empty key
 * "contains"-matches every result. ⚠️ Reintroduce by dropping the `key.length < MIN_ALT_KEY` check: 'AoT'
 * is offered as a search term again and matches by containment on whichever source answers first.
 */
function titlesOf(fields: unknown[]): { title: string; altTitles: string[] } | null {
  const seen = new Set<string>();
  let title: string | null = null;
  const altTitles: string[] = [];
  for (const f of fields) {
    const s = nonEmpty(f);
    if (!s) continue;
    const key = normTitle(s);
    if (!title) { title = s; seen.add(key); continue; }
    if (!key || key.length < MIN_ALT_KEY || seen.has(key) || altTitles.length >= 3) continue;
    seen.add(key);
    altTitles.push(s);
  }
  return title ? { title, altTitles } : null;
}

/**
 * Where each service lives, overridable from the environment so the e2e instance can point an adapter at a
 * stub — the hosts were hardcoded, and there was no other way to drive a tracker import in a browser without
 * a real account. Read once at module load like the SCAN_* knobs; documented as test knobs.
 */
const apiUrl = (name: string, fallback: string): string => (process.env[name] || fallback).replace(/\/+$/, '');

export interface TrackerAdapter {
  readonly id: Provider;
  readonly label: string;
  /**
   * Where a user gets a token, in English. Since v0.61.0 the web app says this itself, translated
   * (web/lib/trackerHelp.ts); this stays for API clients and for a provider the web does not know yet.
   */
  readonly tokenHelp: string;
  /**
   * A page that shows the person a token to copy, when the service has one (v0.61.0, #190): AniList's authorize link
   * for the project's public client. Sent as `authorizeUrl` in GET /api/trackers so API clients see it too.
   */
  readonly authorizeUrl?: string;
  /** How long a token lasts, or null when the service does not say. Used to warn before it lapses. */
  readonly tokenDays: number | null;
  /** Prove the token works and name the account it belongs to. Throws or returns null when rejected. */
  whoAmI(token: string): Promise<{ id: string; name: string } | null>;
  /**
   * Read the series and this account's entry on the service (v0.61.2, #201), which is what pushStatus (trackers.ts)
   * decides the status from. Throws exactly as setProgress does.
   */
  seriesState(token: string, externalId: string): Promise<SeriesState>;
  /**
   * Push progress with the status pushStatus chose. `externalId` is whatever linkSeries stored for this provider, and
   * `state` the seriesState this push read, when there is one.
   */
  setProgress(token: string, externalId: string, chapters: number, status: PushStatus, state?: SeriesState): Promise<void>;
  /**
   * Read the account's own manga list, paged by our own offsets (never by following a URL the service hands
   * back) and capped at `max` entries. Throws `authFailed` on a rejected token exactly as setProgress does;
   * any other failure is a plain error and must not disable the connection.
   */
  listLibrary(token: string, opts: { statuses: ListStatus[]; max: number }): Promise<LibraryEntry[]>;
}

/**
 * Errors from a service carry the HTTP status it answered (v0.61.0), messages unchanged: `lastError` shows the message,
 * and verdictOf below reads the status to tell a refusal from a verdict on the token.
 */
const authFail = (msg: string, status?: number) => Object.assign(new Error(msg), { authFailed: true, ...(status ? { status } : {}) });
const httpFail = (msg: string, status: number) => Object.assign(new Error(msg), { status });

/** What a failed call says about the token: nothing (`unreachable`, `refused`), or that it is bad (`rejected`). */
export type CallVerdict = 'rejected' | 'unreachable' | 'refused';
/** The codes Node puts on a connection that never got an answer, on the error or its `cause` (undici). */
const NO_ANSWER = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
]);

/**
 * Read a failed call to a tracker (v0.61.0, #190). Connect answered EVERY failure "AniList did not accept that token":
 * a DNS failure, Cloudflare's 403 in front of AniList, the service being down -- and the person went back for a new
 * token that was never the problem. Only an `authFailed` error is the service's verdict on the token: `rejected`. No
 * answer at all -- a timeout (AbortSignal.timeout's TimeoutError, an AbortError), undici's `TypeError: fetch failed`, a
 * connection refused or a name that did not resolve -- is `unreachable`. An answer that turned the request down for
 * another reason -- a 403 from the edge, a 429, a 5xx, a 400 that is not "Invalid token" -- is `refused`, with the
 * status when there was one (a GraphQL error inside a 200, or a body that is not JSON, has none).
 * Reintroduce the old reading by answering `rejected` for every error that carries no status: "every adapter: a
 * network throw is unreachable, …" and "verdictOf: only the service's word on the token is …" in
 * trackerVerdicts.int.test.ts fail.
 */
export function verdictOf(e: unknown): { verdict: CallVerdict; status?: number } {
  const err = (e ?? {}) as { authFailed?: unknown; status?: unknown; name?: unknown; message?: unknown; code?: unknown; cause?: { code?: unknown } };
  if (err.authFailed) return { verdict: 'rejected' };
  if (typeof err.status === 'number' && err.status > 0) return { verdict: 'refused', status: err.status };
  const name = String(err.name ?? '');
  const code = String(err.code ?? err.cause?.code ?? '');
  if (name === 'TimeoutError' || name === 'AbortError' || NO_ANSWER.has(code)
    || (name === 'TypeError' && /fetch failed/i.test(String(err.message ?? '')))) return { verdict: 'unreachable' };
  return { verdict: 'refused' };
}

// ---------------------------------------------------------------------------- AniList

/**
 * The project's public AniList API client (v0.61.0, #190), registered by the owner with AniList's own pin page
 * (https://anilist.co/api/v2/oauth/pin) as its redirect URL. Its implicit-grant link asks the person to approve
 * Uchiyomi and then SHOWS the access token to copy: still paste-a-token, nothing is redirected back to this server,
 * and no client secret exists here or is needed -- the implicit grant uses none; never add one. A token lasts a year
 * with no refresh, which is `tokenDays` below. web/lib/trackerHelp.ts builds the same link, and
 * web/test/trackerHelp.test.ts holds the two to one address.
 */
export const ANILIST_CLIENT_ID = 53603;
export const ANILIST_TOKEN_URL = `https://anilist.co/api/v2/oauth/authorize?client_id=${ANILIST_CLIENT_ID}&response_type=token`;

const ANILIST_API = apiUrl('ANILIST_API_URL', 'https://graphql.anilist.co');
/** AniList says "Invalid token" (HTTP 400) for a bad token and "Unauthorized" for a missing one. */
const ANILIST_BAD_TOKEN = /invalid token|unauthorized/i;

async function anilistCall(token: string, query: string, variables: Record<string, unknown>): Promise<any> {
  const r = await fetch(ANILIST_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  // Only a 401 is the token's verdict. ⚠️ A 403 from graphql.anilist.co is Cloudflare's, not AniList's: the
  // edge answers `403 error code: 1010/1020` (text/plain) to a client signature it dislikes, and mapping that
  // to authFail disabled every AniList connection with "rejected the saved token" the moment one push met
  // the edge -- the person had to paste a new token for a block that was never about the token. A 403 falls
  // through to the plain-error branch below: the message is recorded, the connection kept, the next chapter
  // retries. Reintroduce by adding `|| r.status === 403` back here.
  if (r.status === 401) throw authFail('tracker rejected the token', 401);
  // A rejected token is an HTTP 400 on AniList, but so is every validation error -- a variable the schema
  // stopped accepting, a clamp that changed. Every 400 used to count as a bad token, which disables the
  // person's connection with "rejected the saved token"; the list query has far more ways to earn a 400 than
  // the two mutations had, so only the message decides now. ⚠️ Reintroduce by mapping every 400 to authFail.
  if (r.status === 400) {
    const j: any = await r.json().catch(() => null);
    const msg = j?.errors?.[0]?.message || 'anilist 400';
    if (ANILIST_BAD_TOKEN.test(msg)) throw authFail('tracker rejected the token', 400);
    throw httpFail(`anilist 400: ${msg}`, 400);
  }
  if (!r.ok) throw httpFail(`anilist ${r.status}`, r.status);
  const j: any = await r.json();
  if (j?.errors?.length) {
    const msg = j.errors[0]?.message || 'anilist error';
    throw Object.assign(new Error(msg), { authFailed: ANILIST_BAD_TOKEN.test(msg) });
  }
  return j.data;
}

/**
 * The list query: one chunk of the account's manga list, restricted to the statuses asked for. `chunk` and
 * `perChunk` page it (500 answered live; the loop is bounded by `hasNextChunk` and our cap either way), and
 * `forceSingleCompletedList` keeps a completed list that the person split by format from arriving as several
 * groups. `format` is read because a MANGA-type list carries NOVEL entries too.
 */
const ANILIST_LIST = `query($userId:Int,$statuses:[MediaListStatus],$chunk:Int,$perChunk:Int){
  MediaListCollection(userId:$userId,type:MANGA,status_in:$statuses,chunk:$chunk,perChunk:$perChunk,forceSingleCompletedList:true){
    hasNextChunk
    lists{ isCustomList entries{ mediaId status progress score(format:POINT_10_DECIMAL) media{ id format title{ romaji english } synonyms } } }
  }
}`;
const ANILIST_PER_CHUNK = 500;
/** AniList's list statuses per bucket: a re-read (REPEATING) is still being read, and PAUSED is on hold. */
const ANILIST_STATUS: Record<ListStatus, string[]> = {
  reading: ['CURRENT', 'REPEATING'],
  plan_to_read: ['PLANNING'],
  completed: ['COMPLETED'],
  on_hold: ['PAUSED'],
  dropped: ['DROPPED'],
};
function fromAnilistStatus(s: unknown): ListStatus | null {
  for (const st of LIST_STATUSES) if (ANILIST_STATUS[st].includes(String(s))) return st;
  return null;
}
const anilistFormat = (f: unknown): LibraryEntry['format'] =>
  f === 'MANGA' || f === 'ONE_SHOT' ? 'manga' : f === 'NOVEL' || f === 'LIGHT_NOVEL' ? 'novel' : 'other';

const ANILIST_SAVE = `mutation($mediaId:Int,$progress:Int,$status:MediaListStatus){
  SaveMediaListEntry(mediaId:$mediaId, progress:$progress, status:$status){ id progress status }
}`;
/** The series and this account's entry in one query (v0.61.2, #201): `mediaListEntry` is the token's own, null when the
 *  series is not on its list. `chapters` is null while AniList does not know the count, as for every running series. */
const ANILIST_STATE = `query($id:Int){Media(id:$id,type:MANGA){status chapters mediaListEntry{status progress}}}`;
/** FINISHED and CANCELLED have ended; RELEASING, HIATUS and NOT_YET_RELEASED have more chapters to come. */
const ANILIST_ENDED = new Set(['FINISHED', 'CANCELLED']);
const ANILIST_PUSH: Record<PushStatus, string> = { reading: 'CURRENT', completed: 'COMPLETED', rereading: 'REPEATING', planning: 'PLANNING' };

export const anilistAdapter: TrackerAdapter = {
  id: 'anilist',
  label: 'AniList',
  // It said "anilist.co → Settings → Developer → create a client, then copy the access token" until v0.61.0 (#190):
  // that page shows a client ID and a secret, never a token, so the one instruction led to a paste AniList refused.
  // Reintroduce it: "the AniList adapter offers the token page …" in trackerVerdicts.int.test.ts fails.
  tokenHelp: `Open ${ANILIST_TOKEN_URL}, approve Uchiyomi, and paste the token AniList shows.`,
  authorizeUrl: ANILIST_TOKEN_URL,
  tokenDays: 365,
  async whoAmI(token) {
    const d = await anilistCall(token, 'query{Viewer{id name}}', {});
    return d?.Viewer ? { id: String(d.Viewer.id), name: d.Viewer.name } : null;
  },
  async listLibrary(token, { statuses, max }) {
    if (!statuses.length || !(max > 0)) return []; // nothing asked for: no call, no paging through a whole list
    // Called through the adapter object, never `this`: a destructured method would lose it.
    const me = await anilistAdapter.whoAmI(token);
    if (!me) throw authFail('tracker rejected the token');
    const wanted = new Set(statuses);
    const anilistStatuses = statuses.flatMap((s) => ANILIST_STATUS[s]);
    // Custom lists repeat the entries of the status lists they were built from, and an entry hidden from its
    // status list (`hiddenFromStatusLists`) lives ONLY on a custom list -- so every group is read and the
    // mediaId decides, rather than skipping custom groups. ⚠️ Reintroduce by dropping the `seen` check: an
    // entry on a custom list arrives twice and the intake adds it twice.
    const seen = new Set<string>();
    const out: LibraryEntry[] = [];
    for (let chunk = 1; ; chunk++) {
      const d = await anilistCall(token, ANILIST_LIST, {
        userId: Number(me.id), statuses: anilistStatuses, chunk, perChunk: ANILIST_PER_CHUNK,
      });
      const col = d?.MediaListCollection;
      for (const group of col?.lists ?? []) {
        for (const e of group?.entries ?? []) {
          const mediaId = e?.mediaId ?? e?.media?.id;
          if (mediaId == null || seen.has(String(mediaId))) continue;
          const status = fromAnilistStatus(e.status);
          if (!status || !wanted.has(status)) continue;
          const t = titlesOf([e.media?.title?.english, e.media?.title?.romaji, ...(e.media?.synonyms ?? [])]);
          if (!t) continue;
          seen.add(String(mediaId));
          out.push({
            externalId: String(mediaId), ...t, status,
            progress: Math.max(0, Math.floor(Number(e.progress) || 0)),
            format: anilistFormat(e.media?.format),
            ...(Number(e.score) > 0 ? { score: Number(e.score) } : {}),
          });
          if (out.length >= max) return out;
        }
      }
      if (!col?.hasNextChunk) return out;
    }
  },
  async seriesState(token, externalId) {
    const d = await anilistCall(token, ANILIST_STATE, { id: Number(externalId) });
    const m = d?.Media;
    const e = m?.mediaListEntry;
    // A re-read is REPEATING, which the list import reads as reading; a push keeps it apart so it can stay one.
    const status = e ? (e.status === 'REPEATING' ? 'rereading' : fromAnilistStatus(e.status)) : null;
    return {
      ended: ANILIST_ENDED.has(String(m?.status)),
      total: positiveInt(m?.chapters),
      entry: status ? { status, progress: progressOf(e.progress) } : null,
    };
  },
  async setProgress(token, externalId, chapters, status) {
    await anilistCall(token, ANILIST_SAVE, {
      mediaId: Number(externalId),
      progress: chapters,
      status: ANILIST_PUSH[status],
    });
  },
};

// ---------------------------------------------------------------------------- MyAnimeList

const MAL_API = apiUrl('MYANIMELIST_API_URL', 'https://api.myanimelist.net/v2');
/** The spec's ceiling for `limit` on the list endpoint (the default is 100). */
const MAL_PAGE = 1000;
/** MAL's list statuses are the app's own words already; a re-read (`is_rereading`) comes back under reading. */
const MAL_STATUS: Record<ListStatus, string> = {
  reading: 'reading', plan_to_read: 'plan_to_read', completed: 'completed', on_hold: 'on_hold', dropped: 'dropped',
};
/** MAL's publishing states that have ended: `finished`, `discontinued`. The others have more chapters to come. */
const MAL_ENDED = new Set(['finished', 'discontinued']);
const fromMalStatus = (s: unknown): ListStatus | null =>
  (LIST_STATUSES as readonly string[]).includes(String(s)) ? (s as ListStatus) : null;
const malFormat = (t: unknown): LibraryEntry['format'] => {
  const s = String(t ?? '');
  if (s === 'novel' || s === 'light_novel') return 'novel';
  return ['manga', 'one_shot', 'doujinshi', 'manhwa', 'manhua', 'oel'].includes(s) ? 'manga' : 'other';
};

async function malCall(token: string, path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${MAL_API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init?.headers as any) },
    signal: AbortSignal.timeout(15000),
  });
  // A 401 is a bad token. A 403 on MAL is its DoS block (too many requests from one address), which a token
  // paste cannot fix; treating it as authFail disabled the connection for a rate limit. Reintroduce by
  // adding `|| r.status === 403` back.
  if (r.status === 401) throw authFail('MyAnimeList rejected the token', 401);
  if (!r.ok) throw httpFail(`myanimelist ${r.status}`, r.status);
  return r.status === 204 ? null : r.json();
}

export const malAdapter: TrackerAdapter = {
  id: 'myanimelist',
  label: 'MyAnimeList',
  // MAL issues tokens through OAuth2 with PKCE (`plain` only) and no page shows one, so the practical path for a
  // self-hoster is to obtain one once with an app of their own and paste it. docs/USAGE.md has the recipe (v0.61.0).
  tokenHelp: 'MyAnimeList shows no token on any page: create an API app at https://myanimelist.net/apiconfig and '
    + 'exchange a code for a token (docs/USAGE.md, "Getting a MyAnimeList token"), then paste its access_token.',
  tokenDays: 31,   // MAL access tokens are short-lived; surfacing that is the whole point of storing it
  async listLibrary(token, { statuses, max }) {
    if (!statuses.length || !(max > 0)) return [];
    const out: LibraryEntry[] = [];
    const seen = new Set<string>();
    // `status` takes ONE value ("to return all manga, don't specify"), so a subset is one paged loop per bucket.
    // `nsfw=true` is not optional: without it the gray and black entries are silently left out of the
    // answer, and a list that "imported fine" is missing titles nobody can account for.
    // Every bucket asked for is ONE paged read with no `status` (the row says which bucket it is in), not
    // five: a full-list read for recommendations costs a call per thousand entries instead of a call per bucket.
    const everything = LIST_STATUSES.every((s) => statuses.includes(s));
    const wanted = new Set<string>(statuses);
    for (const pass of everything ? [null] : statuses) {
      for (let offset = 0, more = true; more; ) {
        const qs = new URLSearchParams({
          fields: 'list_status,alternative_titles,media_type',
          limit: String(MAL_PAGE), offset: String(offset), nsfw: 'true',
        });
        if (pass) qs.set('status', MAL_STATUS[pass]);
        const d = await malCall(token, `/users/@me/mangalist?${qs}`);
        const rows: any[] = Array.isArray(d?.data) ? d.data : [];
        // `paging.next` is only a signal that there is more. It is a URL the service composed, and this
        // server fetches nothing it did not compose itself; the next page is our own offset, advanced by
        // what was actually served so a clamped page size cannot skip entries. An empty page ends the loop
        // whatever `next` says. ⚠️ Reintroduce by `fetch(d.paging.next)`.
        more = !!d?.paging?.next && rows.length > 0;
        offset += rows.length;
        for (const row of rows) {
          const node = row?.node;
          if (node?.id == null || seen.has(String(node.id))) continue;
          const st = (pass ?? row?.list_status?.status) as ListStatus | undefined;
          if (!st || !wanted.has(st) || !(LIST_STATUSES as readonly string[]).includes(st)) continue;
          // `title` is the romaji; the English title lives under alternative_titles.en and is "" when there
          // is none, so the trim rule in titlesOf is what makes the romaji the search title in that case.
          const alt = node.alternative_titles ?? {};
          const t = titlesOf([alt.en, node.title, ...(Array.isArray(alt.synonyms) ? alt.synonyms : [])]);
          if (!t) continue;
          seen.add(String(node.id));
          out.push({
            externalId: String(node.id), ...t, status: st,
            progress: Math.max(0, Math.floor(Number(row?.list_status?.num_chapters_read) || 0)),
            format: malFormat(node.media_type),
            ...(Number(row?.list_status?.score) > 0 ? { score: Number(row.list_status.score) } : {}),
          });
          if (out.length >= max) return out;
        }
      }
    }
    return out;
  },
  async whoAmI(token) {
    const d = await malCall(token, '/users/@me?fields=name');
    return d?.name ? { id: String(d.id ?? d.name), name: d.name } : null;
  },
  async seriesState(token, externalId) {
    // `num_chapters` is 0 while MAL does not know the count; `my_list_status` is absent when the series is not on the
    // account's list. A re-read is `is_rereading` on whatever status the entry has.
    const qs = new URLSearchParams({ fields: 'status,num_chapters,my_list_status' });
    const d = await malCall(token, `/manga/${encodeURIComponent(externalId)}?${qs}`);
    const ls = d?.my_list_status;
    const status = ls ? (ls.is_rereading ? 'rereading' : fromMalStatus(ls.status)) : null;
    return {
      ended: MAL_ENDED.has(String(d?.status)),
      total: positiveInt(d?.num_chapters),
      entry: status ? { status, progress: progressOf(ls.num_chapters_read) } : null,
    };
  },
  async setProgress(token, externalId, chapters, status) {
    // MAL takes a form body, not JSON, and calls the field num_chapters_read. A re-read sends its flag and leaves the
    // status as the person has it: MAL keeps a re-read under whichever status it was started from.
    const body = new URLSearchParams({ num_chapters_read: String(chapters) });
    if (status === 'rereading') body.set('is_rereading', 'true');
    else body.set('status', status === 'planning' ? 'plan_to_read' : status);
    await malCall(token, `/manga/${encodeURIComponent(externalId)}/my_list_status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  },
};

// ---------------------------------------------------------------------------- Kitsu

// kitsu.app is the host the service itself links to now (`links.next` comes back on it); kitsu.io still answers.
const KITSU_API = apiUrl('KITSU_API_URL', 'https://kitsu.app/api/edge');
const KITSU_JSON = 'application/vnd.api+json';
/** `page[limit]=501` is a 400 on Kitsu, so 500 is the ceiling. */
const KITSU_PAGE = 500;
/** Kitsu calls reading `current` and plan-to-read `planned`; the other three are the app's own words. */
const KITSU_STATUS: Record<ListStatus, string> = {
  reading: 'current', plan_to_read: 'planned', completed: 'completed', on_hold: 'on_hold', dropped: 'dropped',
};
function fromKitsuStatus(s: unknown): ListStatus | null {
  for (const st of LIST_STATUSES) if (KITSU_STATUS[st] === s) return st;
  return null;
}
const kitsuFormat = (t: unknown): LibraryEntry['format'] => {
  const s = String(t ?? '');
  if (s === 'novel') return 'novel';
  return ['manga', 'manhwa', 'manhua', 'oel', 'oneshot', 'doujin'].includes(s) ? 'manga' : 'other';
};

async function kitsuCall(token: string, path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${KITSU_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`, accept: KITSU_JSON, ...(init?.headers as any),
    },
    signal: AbortSignal.timeout(15000),
  });
  // A 401 is a bad token. A 403 on Kitsu is a forbidden ACTION -- writing an entry that belongs to another
  // account, say -- and the token that earned it is still good for everything else, so it is a plain error
  // that keeps the connection. Reintroduce by adding `|| r.status === 403` back.
  if (r.status === 401) throw authFail('Kitsu rejected the token', 401);
  if (!r.ok) throw httpFail(`kitsu ${r.status}`, r.status);
  return r.status === 204 ? null : r.json();
}

export const kitsuAdapter: TrackerAdapter = {
  id: 'kitsu',
  label: 'Kitsu',
  // Kitsu's documented way (its API docs, "Password Grant") is a POST to https://kitsu.io/api/oauth/token with your
  // email or slug and password; no page shows a token. docs/USAGE.md has the command (v0.61.0).
  tokenHelp: 'Kitsu shows no token on any page: ask https://kitsu.io/api/oauth/token for one with your email and '
    + 'password (docs/USAGE.md, "Getting a Kitsu token"), then paste its access_token.',
  tokenDays: 30,
  async listLibrary(token, { statuses, max }) {
    if (!statuses.length || !(max > 0)) return []; // an empty filter[status] would page the whole library
    const me = await kitsuAdapter.whoAmI(token);
    if (!me) throw authFail('Kitsu rejected the token');
    const wanted = new Set(statuses);
    const out: LibraryEntry[] = [];
    const seen = new Set<string>();
    for (let offset = 0, more = true; more; ) {
      // JSON:API: the entries carry status and progress, the manga they point at rides in `included` and is
      // joined by id -- `included` is not in the entries' order. `filter[status]` takes a comma list.
      const qs = new URLSearchParams({
        'filter[userId]': me.id, 'filter[kind]': 'manga',
        'filter[status]': statuses.map((s) => KITSU_STATUS[s]).join(','),
        include: 'manga',
        'fields[libraryEntries]': 'status,progress,manga',
        'fields[manga]': 'canonicalTitle,titles,abbreviatedTitles,subtype',
        'page[limit]': String(KITSU_PAGE), 'page[offset]': String(offset),
      });
      const d = await kitsuCall(token, `/library-entries?${qs}`);
      const rows: any[] = Array.isArray(d?.data) ? d.data : [];
      const manga = new Map<string, any>();
      for (const inc of d?.included ?? []) if (inc?.type === 'manga' && inc.id != null) manga.set(String(inc.id), inc.attributes ?? {});
      // `links.next` is the signal, never the address: the next page is our own offset (see the MAL adapter).
      more = !!d?.links?.next && rows.length > 0;
      offset += rows.length;
      for (const row of rows) {
        // ⚠️ The external id is the MANGA id, not this entry's id. An entry belongs to ONE account, while
        // series_trackers is keyed per series: an entry id stored here would send every other member's push
        // at the importer's entry and get a 403 on every chapter, so THEIR progress never arrives and their
        // card shows a sync error they cannot fix. Reintroduce by storing `row.id`.
        const mangaId = row?.relationships?.manga?.data?.id;
        if (mangaId == null || seen.has(String(mangaId))) continue;
        const status = fromKitsuStatus(row?.attributes?.status);
        if (!status || !wanted.has(status)) continue;
        const m = manga.get(String(mangaId));
        if (!m) continue; // an entry whose manga was not included cannot be searched for
        const titles = m.titles ?? {};
        const t = titlesOf([
          titles.en, titles.en_us, m.canonicalTitle, titles.en_jp,
          ...(Array.isArray(m.abbreviatedTitles) ? m.abbreviatedTitles : []),
        ]);
        if (!t) continue;
        seen.add(String(mangaId));
        out.push({
          externalId: String(mangaId), ...t, status,
          progress: Math.max(0, Math.floor(Number(row?.attributes?.progress) || 0)),
          format: kitsuFormat(m.subtype),
        });
        if (out.length >= max) return out;
      }
    }
    return out;
  },
  async whoAmI(token) {
    const d = await kitsuCall(token, '/users?filter[self]=true');
    const u = d?.data?.[0];
    return u ? { id: String(u.id), name: u.attributes?.name ?? u.attributes?.slug ?? 'kitsu' } : null;
  },
  async seriesState(token, externalId) {
    // `externalId` is the Kitsu MANGA id, the one thing about a series that is the same for every account; the entry
    // is the CALLER's own, found by user and manga (setProgress below says why). The manga rides along with the entry;
    // with no entry on this account it is asked for on its own.
    const me = await kitsuAdapter.whoAmI(token);
    if (!me) throw authFail('Kitsu rejected the token');
    const qs = new URLSearchParams({
      'filter[userId]': me.id, 'filter[mangaId]': String(externalId), include: 'manga',
      'fields[libraryEntries]': 'status,progress,reconsuming,manga', 'fields[manga]': 'status,chapterCount',
      'page[limit]': '1',
    });
    const found = await kitsuCall(token, `/library-entries?${qs}`);
    const row = found?.data?.[0];
    let manga = (found?.included ?? []).find((i: any) => i?.type === 'manga' && String(i.id) === String(externalId))?.attributes;
    if (!manga) {
      const mq = new URLSearchParams({ 'fields[manga]': 'status,chapterCount' });
      manga = (await kitsuCall(token, `/manga/${encodeURIComponent(String(externalId))}?${mq}`))?.data?.attributes;
    }
    // A re-read is `reconsuming` on the entry; `finished` is the only manga state that has ended.
    const status = row ? (row.attributes?.reconsuming ? 'rereading' : fromKitsuStatus(row.attributes?.status)) : null;
    return {
      ended: manga?.status === 'finished',
      total: positiveInt(manga?.chapterCount),
      entry: status ? { status, progress: progressOf(row.attributes?.progress) } : null,
      ref: { userId: me.id, entryId: row?.id != null ? String(row.id) : null },
    };
  },
  async setProgress(token, externalId, chapters, status, state) {
    // `externalId` is the Kitsu MANGA id, the one thing about a series that is the same for every account.
    // The entry to write is the CALLER's own, resolved by user and manga: it used to be a stored
    // library-entry id, which belongs to one account, so after an admin's import every other member's push
    // would have PATCHed the admin's entry, got a 403 on every chapter, and never synced a thing.
    // ⚠️ Reintroduce by PATCHing `/library-entries/${externalId}` directly.
    // The entry the push's seriesState found, or found here when there is no state to go on.
    let ref = state?.ref as { userId: string; entryId: string | null } | undefined;
    if (!ref) {
      const me = await kitsuAdapter.whoAmI(token);
      if (!me) throw authFail('Kitsu rejected the token');
      const qs = new URLSearchParams({
        'filter[userId]': me.id, 'filter[mangaId]': String(externalId),
        'fields[libraryEntries]': 'status', 'page[limit]': '1',
      });
      const found = await kitsuCall(token, `/library-entries?${qs}`);
      ref = { userId: me.id, entryId: found?.data?.[0]?.id != null ? String(found.data[0].id) : null };
    }
    const me = { id: ref.userId };
    const entryId = ref.entryId;
    // A re-read is the entry's `reconsuming` flag under the status it already has, so it moves only the progress.
    const attributes = status === 'rereading'
      ? { progress: chapters, reconsuming: true }
      : { progress: chapters, status: status === 'completed' ? 'completed' : status === 'planning' ? 'planned' : 'current' };
    if (entryId != null) {
      await kitsuCall(token, `/library-entries/${encodeURIComponent(String(entryId))}`, {
        method: 'PATCH',
        headers: { 'content-type': KITSU_JSON },
        body: JSON.stringify({ data: { id: String(entryId), type: 'libraryEntries', attributes } }),
      });
      return;
    }
    // No entry yet on this account: create one, the way the Kitsu clients do (user + media relationships).
    await kitsuCall(token, '/library-entries', {
      method: 'POST',
      headers: { 'content-type': KITSU_JSON },
      body: JSON.stringify({
        data: {
          type: 'libraryEntries',
          attributes,
          relationships: {
            user: { data: { type: 'users', id: me.id } },
            media: { data: { type: 'manga', id: String(externalId) } },
          },
        },
      }),
    });
  },
};

// ---------------------------------------------------------------------------- MangaUpdates
//
// #244 (@Squeaks72). MangaUpdates shows no token on any page, so it connects like MyAnimeList and Kitsu: a token the
// person gets themself -- here the session token its login API answers for their username and password (docs/USAGE.md
// "Getting a MangaUpdates token") -- pasted into the row. Their password goes to MangaUpdates only, never to this
// server: a sign-in form here made the server a password relay with no rate limit, and taught browsers to save a
// MangaUpdates password over the Uchiyomi one.
//
// Polite by construction. Every call waits its turn at lib/mangaupdates.ts's one-a-second gate, which Discover's name
// lookups use too: a list import or a burst of pushes cannot get this server's address throttled for everyone. The
// account's list ids are kept for ten minutes, and a push writes from what seriesState just read (`ref`), so it is
// three calls -- the series, the entry, the write -- and the first of a session four.

const MU_API = apiUrl('MANGAUPDATES_API_URL', 'https://api.mangaupdates.com/v1');
const MU_PAGE = 100;
/** MangaUpdates' five standard lists, by the `type` /lists names them with; a custom list has none of these. */
const MU_LIST_TYPE: Record<ListStatus, string> = {
  reading: 'read', plan_to_read: 'wish', completed: 'complete', on_hold: 'hold', dropped: 'unfinished',
};
/** The standard lists' fixed ids, used when /lists does not answer for one (a brand-new account lists them all). */
const MU_LIST_ID: Record<ListStatus, number> = { reading: 0, plan_to_read: 1, completed: 2, dropped: 3, on_hold: 4 };
const muFormat = (t: unknown): LibraryEntry['format'] => {
  const s = String(t ?? '');
  if (s === 'Novel') return 'novel';
  return ['Manga', 'Manhwa', 'Manhua', 'OEL', 'Doujinshi', 'Filipino', 'Indonesian', 'Thai', 'Vietnamese', 'Malaysian', 'Nordic', 'French', 'Spanish', 'German'].includes(s) ? 'manga' : 'other';
};

async function muCall(token: string, path: string, init?: RequestInit): Promise<any> {
  await muTurn();
  const r = await fetch(`${MU_API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': 'Uchiyomi/1.0 (self-hosted personal reader)', ...(init?.headers as any) },
    signal: AbortSignal.timeout(15000),
  });
  // A 401 is a session that is gone or never was ("This action requires a user account"). Writes are refused with a
  // 412 when two come within five seconds of each other; that is the service asking us to wait, not a verdict on the
  // token, so it travels as a plain error (`throttled`) for the caller to wait out.
  if (r.status === 401) throw authFail('MangaUpdates rejected the token', 401);
  if (r.status === 412) throw Object.assign(httpFail('mangaupdates 412', 412), { throttled: true });
  if (r.status === 404) throw Object.assign(httpFail('mangaupdates 404', 404), { notFound: true });
  if (!r.ok) throw httpFail(`mangaupdates ${r.status}`, r.status);
  return r.json().catch(() => null);
}

/** The account's list ids, kept a while per token (by its hash: no token is kept as a key). */
const MU_LISTS_MS = 10 * 60_000;
const muLists = new Map<string, { at: number; ids: Record<ListStatus, number> }>();
const tokenKey = (token: string) => createHash('sha256').update(token).digest('hex');

/** The id each standard list has on this account, by bucket; falls back to the fixed ids. */
async function muListIds(token: string): Promise<Record<ListStatus, number>> {
  const key = tokenKey(token);
  const kept = muLists.get(key);
  if (kept && Date.now() - kept.at < MU_LISTS_MS) return kept.ids;
  const out = { ...MU_LIST_ID };
  let answered = false;
  const lists = await muCall(token, '/lists').then((l) => { answered = true; return l; })
    .catch((e) => { if ((e as any).authFailed) throw e; return null; });
  for (const l of Array.isArray(lists) ? lists : []) {
    if (l?.custom || l?.list_id == null) continue;
    for (const st of LIST_STATUSES) if (MU_LIST_TYPE[st] === l.type) out[st] = Number(l.list_id);
  }
  // Only an answer is kept: a failed read falls back to the fixed ids this once, and asks again next time.
  if (answered) {
    if (muLists.size > 200) muLists.clear();
    muLists.set(key, { at: Date.now(), ids: out });
  }
  return out;
}

/** What seriesState read, for setProgress to write from (`ref`): the account's list ids and the list the entry is on. */
interface MuRef { ids: Record<ListStatus, number>; onList: number | null }

/** This account's entry for a series: its list and chapter, or null when it is on no list (MangaUpdates answers 404). */
async function muEntry(token: string, sid: number): Promise<{ list_id?: number; status?: { chapter?: number } } | null> {
  try { return await muCall(token, `/lists/series/${sid}`); }
  catch (e) { if ((e as any).notFound) return null; throw e; }
}

export const mangaupdatesAdapter: TrackerAdapter = {
  id: 'mangaupdates',
  label: 'MangaUpdates',
  tokenHelp: 'MangaUpdates shows no token on any page: its login API answers a session token for your username and password (see "Getting a MangaUpdates token" in the guide). Paste the session_token, or the whole answer.',
  tokenDays: null,
  async whoAmI(token) {
    const d = await muCall(token, '/account/profile');
    return d?.user_id != null ? { id: String(d.user_id), name: String(d.username ?? d.user_id) } : null;
  },
  async listLibrary(token, { statuses, max }) {
    if (!statuses.length || !(max > 0)) return [];
    const ids = await muListIds(token);
    const out: LibraryEntry[] = [];
    const seen = new Set<string>();
    // One paged read per bucket asked for: a list is its own endpoint, and the page is our own number.
    for (const status of statuses) {
      for (let page = 1; ; page++) {
        const d = await muCall(token, `/lists/${ids[status]}/search`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ page, perpage: MU_PAGE }),
        });
        const rows: any[] = Array.isArray(d?.results) ? d.results : [];
        for (const row of rows) {
          const sid = row?.record?.series?.id ?? row?.metadata?.series?.series_id;
          if (sid == null || seen.has(String(sid))) continue;
          const t = titlesOf([row?.record?.series?.title, row?.metadata?.series?.title]);
          if (!t) continue;
          seen.add(String(sid));
          out.push({
            externalId: String(sid), ...t, status,
            progress: progressOf(row?.record?.status?.chapter),
            format: muFormat(row?.metadata?.series?.type),
          });
          if (out.length >= max) return out;
        }
        const total = Number(d?.total_hits) || 0;
        if (!rows.length || page * MU_PAGE >= total) break;
      }
    }
    return out;
  },
  async seriesState(token, externalId) {
    const sid = Number(externalId);
    if (!Number.isInteger(sid)) throw new Error('mangaupdates: not a series id');
    // The series is public; the entry is this account's own, and is simply absent (404) until it is on a list.
    const series = await muCall(token, `/series/${sid}`).catch((e) => { if ((e as any).notFound) return null; throw e; });
    const ids = await muListIds(token);
    const current = await muEntry(token, sid);
    // `completed` is the one thing MangaUpdates states outright, and it covers both ways a series stops --
    // finished or cancelled. Its `status` is free prose ("17 Volumes (Ongoing)"), so only the flag is read.
    const ended = series?.completed === true;
    // `latest_chapter` is the newest chapter seen, not a total; it is only the total once nothing more is coming.
    const total = ended ? positiveInt(series?.latest_chapter) : null;
    // The bucket is the list the entry sits on. A custom list is none of the five and counts as reading, which is
    // where setProgress below leaves it; MangaUpdates has no re-read flag, so a re-read cannot be told apart here.
    const onList = current?.list_id != null ? Number(current.list_id) : null;
    const status = onList == null ? null : (LIST_STATUSES.find((st) => ids[st] === onList) ?? 'reading');
    const ref: MuRef = { ids, onList };
    return {
      ended,
      total,
      entry: status ? { status, progress: progressOf(current?.status?.chapter) } : null,
      ref,
    };
  },
  async setProgress(token, externalId, chapters, status, state) {
    const sid = Number(externalId);
    if (!Number.isInteger(sid)) throw new Error('mangaupdates: not a series id');
    // What seriesState just read, when this push read it (the usual case); else asked now.
    const known = state?.ref as MuRef | undefined;
    const ids = known?.ids ?? await muListIds(token);
    const onList = known ? known.onList : ((e) => (e?.list_id != null ? Number(e.list_id) : null))(await muEntry(token, sid));
    // A completed push moves it to the complete list; a plan (an add, #223, on a series on no list) puts it on the wish
    // list. Otherwise it stays where it is, except that a wish, hold or unfinished entry being read goes to reading; an
    // entry on a custom list is left on it. MangaUpdates has no re-read mark, so a re-read is reading.
    const standard = Object.values(ids);
    const target = status === 'completed' ? ids.completed
      : status === 'planning' ? (onList ?? ids.plan_to_read)
      : onList != null && !standard.includes(onList) ? onList
      : ids.reading;
    const item = { series: { id: sid }, list_id: target, status: { chapter: chapters } };
    const write = () => muCall(token, onList != null ? '/lists/series/update' : '/lists/series', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([item]),
    });
    try { await write(); }
    catch (e) {
      if (!(e as any).throttled) throw e;
      await new Promise((r) => setTimeout(r, 5500));
      await write();
    }
  },
};

// ---------------------------------------------------------------------------- Recommendations

/**
 * One title another reader suggested, in the shape lib/trackerRecs.ts caches. `votes` is how strongly the
 * community stands behind the pairing (AniList's net rating, MyAnimeList's `num_recommendations`).
 * `adult` is null when the service did not say, which only MyAnimeList's own answer ever leaves.
 */
export interface RecItem {
  id: string;
  title: string;
  altTitles: string[];
  cover: string | null;
  url: string | null;
  /** 0-100, the community's score; null when there is none. */
  score: number | null;
  adult: boolean | null;
  format: LibraryEntry['format'];
  votes: number;
  /** AniList genre names; absent on answers cached before genres were asked for. */
  genres?: string[];
}

const ANILIST_MEDIA = 'id idMal type format isAdult averageScore siteUrl genres title{ romaji english } synonyms coverImage{ large medium }';

function anilistItem(m: any, votes: number): RecItem | null {
  if (!m || m.id == null || (m.type && m.type !== 'MANGA')) return null;
  const t = titlesOf([m.title?.english, m.title?.romaji, ...(Array.isArray(m.synonyms) ? m.synonyms : [])]);
  if (!t) return null;
  return {
    id: String(m.id), ...t,
    cover: nonEmpty(m.coverImage?.large) ?? nonEmpty(m.coverImage?.medium),
    url: nonEmpty(m.siteUrl),
    score: Number(m.averageScore) > 0 ? Math.round(Number(m.averageScore)) : null,
    adult: typeof m.isAdult === 'boolean' ? m.isAdult : null,
    format: anilistFormat(m.format),
    votes,
    genres: Array.isArray(m.genres) ? m.genres.filter((g: unknown) => typeof g === 'string') : [],
  };
}

/**
 * What AniList readers recommend after each of these series, as ONE request: the ids are aliases of a single
 * query rather than a call each. The query is public, so no token is sent -- a recommendation is the same
 * for everyone and need not carry anyone's credentials. Only pairings the community voted up (net rating
 * above zero) are kept, best first. An id AniList does not know simply has no entry in the answer.
 */
export async function anilistRecommendations(ids: string[], perSeed = 12): Promise<Map<string, RecItem[]>> {
  const out = new Map<string, RecItem[]>();
  const wanted = ids.filter((i) => /^\d+$/.test(i));
  if (!wanted.length) return out;
  const body = wanted.map((id, n) =>
    `m${n}: Media(id:${Number(id)}, type:MANGA){ id recommendations(sort:RATING_DESC, perPage:${perSeed}){ nodes{ rating mediaRecommendation{ ${ANILIST_MEDIA} } } } }`,
  ).join('\n');
  const r = await fetch(ANILIST_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: `query{ ${body} }` }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok && r.status !== 404) throw new Error(`anilist ${r.status}`);
  const j: any = await r.json().catch(() => null);
  // A seed that no longer exists answers a per-alias "Not Found" error next to the aliases that worked; only
  // an answer with no data at all is a failure.
  if (!j?.data) throw new Error(`anilist ${j?.errors?.[0]?.message || 'no data'}`);
  wanted.forEach((id, n) => {
    const nodes: any[] = j.data[`m${n}`]?.recommendations?.nodes ?? [];
    const items: RecItem[] = [];
    for (const node of nodes) {
      const votes = Number(node?.rating) || 0;
      if (votes <= 0) continue;
      const item = anilistItem(node?.mediaRecommendation, votes);
      if (item) items.push(item);
    }
    out.set(id, items);
  });
  return out;
}

/**
 * What MyAnimeList readers recommend after one series. One call, the person's own token (the endpoint needs
 * a client id or a bearer and the token is the one already held). MyAnimeList says nothing about age rating
 * here, so `adult` is null until lib/trackerRecs.ts asks AniList about the whole batch at once.
 */
export async function malRecommendations(token: string, malId: string): Promise<RecItem[]> {
  if (!/^\d+$/.test(malId)) return [];
  let d: any;
  try {
    d = await malCall(token, `/manga/${malId}?fields=recommendations`);
  } catch (e) {
    if (/ 404$/.test((e as Error).message)) return []; // gone from MyAnimeList: nothing to recommend, and no use asking again
    throw e;
  }
  const out: RecItem[] = [];
  for (const rec of Array.isArray(d?.recommendations) ? d.recommendations : []) {
    const node = rec?.node;
    const title = nonEmpty(node?.title);
    if (node?.id == null || !title) continue;
    out.push({
      id: String(node.id), title, altTitles: [],
      cover: nonEmpty(node.main_picture?.large) ?? nonEmpty(node.main_picture?.medium),
      url: `https://myanimelist.net/manga/${node.id}`,
      score: null, adult: null, format: 'other',
      votes: Math.max(1, Math.floor(Number(rec?.num_recommendations) || 1)),
    });
  }
  return out;
}

/**
 * AniList's record for a batch of MyAnimeList ids, in one request (`idMal_in`): the age rating, format,
 * English title and score MyAnimeList's recommendations lack. Up to 50 ids, which is one page. Public, no token.
 */
export async function anilistByMalIds(malIds: string[]): Promise<Map<string, RecItem>> {
  const out = new Map<string, RecItem>();
  const ids = malIds.filter((i) => /^\d+$/.test(i)).slice(0, 50).map(Number);
  if (!ids.length) return out;
  const r = await fetch(ANILIST_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      query: `query($ids:[Int]){ Page(perPage:50){ media(idMal_in:$ids, type:MANGA){ ${ANILIST_MEDIA} } } }`,
      variables: { ids },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`anilist ${r.status}`);
  const j: any = await r.json().catch(() => null);
  for (const m of j?.data?.Page?.media ?? []) {
    const item = anilistItem(m, 0);
    if (item && m.idMal != null) out.set(String(m.idMal), item);
  }
  return out;
}

// ----------------------------------------------------------------------------

export const ADAPTERS: Record<Provider, TrackerAdapter> = {
  anilist: anilistAdapter,
  myanimelist: malAdapter,
  kitsu: kitsuAdapter,
  mangaupdates: mangaupdatesAdapter,
};

export const PROVIDERS = Object.keys(ADAPTERS) as Provider[];

export const isProvider = (v: unknown): v is Provider =>
  typeof v === 'string' && (PROVIDERS as string[]).includes(v);
