// One adapter per tracker.
//
// `trackers.ts` was written with a note saying provider is carried everywhere "so MAL/Kitsu can be added
// without a migration", and that turned out to be true: the schema keys on (user_id, provider) and nothing
// needed changing. What was NOT abstracted was the two calls that actually talk to a service, so those live
// here and the sync path picks an adapter instead of hardcoding AniList.
//
// All three connect by PASTING A TOKEN, which is the same honest, dependency-free path AniList already used:
// no client registration, no redirect URLs to configure, nothing to keep secret server-side. A full OAuth
// dance would need every self-hoster to register an application with each service and put the secret in
// their compose file, which is a worse trade for a household app than copying a token once.

export type Provider = 'anilist' | 'myanimelist' | 'kitsu';

export interface TrackerAdapter {
  readonly id: Provider;
  readonly label: string;
  /** Where a user gets a token, shown in the UI next to the paste box. */
  readonly tokenHelp: string;
  /** How long a token lasts, or null when the service does not say. Used to warn before it lapses. */
  readonly tokenDays: number | null;
  /** Prove the token works and name the account it belongs to. Throws or returns null when rejected. */
  whoAmI(token: string): Promise<{ id: string; name: string } | null>;
  /** Push progress. `externalId` is whatever linkSeries stored for this provider. */
  setProgress(token: string, externalId: string, chapters: number, finished: boolean): Promise<void>;
}

const authFail = (msg: string) => Object.assign(new Error(msg), { authFailed: true });

// ---------------------------------------------------------------------------- AniList

const ANILIST_API = 'https://graphql.anilist.co';

async function anilistCall(token: string, query: string, variables: Record<string, unknown>): Promise<any> {
  const r = await fetch(ANILIST_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 401 || r.status === 400) throw authFail('tracker rejected the token');
  if (!r.ok) throw new Error(`anilist ${r.status}`);
  const j: any = await r.json();
  if (j?.errors?.length) {
    const msg = j.errors[0]?.message || 'anilist error';
    throw Object.assign(new Error(msg), { authFailed: /invalid token|unauthorized/i.test(msg) });
  }
  return j.data;
}

const ANILIST_SAVE = `mutation($mediaId:Int,$progress:Int,$status:MediaListStatus){
  SaveMediaListEntry(mediaId:$mediaId, progress:$progress, status:$status){ id progress status }
}`;

export const anilistAdapter: TrackerAdapter = {
  id: 'anilist',
  label: 'AniList',
  tokenHelp: 'anilist.co → Settings → Developer → create a client, then copy the access token.',
  tokenDays: 365,
  async whoAmI(token) {
    const d = await anilistCall(token, 'query{Viewer{id name}}', {});
    return d?.Viewer ? { id: String(d.Viewer.id), name: d.Viewer.name } : null;
  },
  async setProgress(token, externalId, chapters, finished) {
    await anilistCall(token, ANILIST_SAVE, {
      mediaId: Number(externalId),
      progress: chapters,
      status: finished ? 'COMPLETED' : 'CURRENT',
    });
  },
};

// ---------------------------------------------------------------------------- MyAnimeList

const MAL_API = 'https://api.myanimelist.net/v2';

async function malCall(token: string, path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${MAL_API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init?.headers as any) },
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 401 || r.status === 403) throw authFail('MyAnimeList rejected the token');
  if (!r.ok) throw new Error(`myanimelist ${r.status}`);
  return r.status === 204 ? null : r.json();
}

export const malAdapter: TrackerAdapter = {
  id: 'myanimelist',
  label: 'MyAnimeList',
  // MAL issues tokens through OAuth2 with PKCE; the practical path for a self-hoster is to obtain one once
  // and paste it, exactly as with AniList.
  tokenHelp: 'myanimelist.net → Account settings → API, create an app and obtain an access token.',
  tokenDays: 31,   // MAL access tokens are short-lived; surfacing that is the whole point of storing it
  async whoAmI(token) {
    const d = await malCall(token, '/users/@me?fields=name');
    return d?.name ? { id: String(d.id ?? d.name), name: d.name } : null;
  },
  async setProgress(token, externalId, chapters, finished) {
    // MAL takes a form body, not JSON, and calls the field num_chapters_read.
    const body = new URLSearchParams({
      num_chapters_read: String(chapters),
      status: finished ? 'completed' : 'reading',
    });
    await malCall(token, `/manga/${encodeURIComponent(externalId)}/my_list_status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  },
};

// ---------------------------------------------------------------------------- Kitsu

const KITSU_API = 'https://kitsu.io/api/edge';
const KITSU_JSON = 'application/vnd.api+json';

async function kitsuCall(token: string, path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${KITSU_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`, accept: KITSU_JSON, ...(init?.headers as any),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 401 || r.status === 403) throw authFail('Kitsu rejected the token');
  if (!r.ok) throw new Error(`kitsu ${r.status}`);
  return r.status === 204 ? null : r.json();
}

export const kitsuAdapter: TrackerAdapter = {
  id: 'kitsu',
  label: 'Kitsu',
  tokenHelp: 'Kitsu issues a token from its OAuth endpoint with your username and password; paste it here.',
  tokenDays: 30,
  async whoAmI(token) {
    const d = await kitsuCall(token, '/users?filter[self]=true');
    const u = d?.data?.[0];
    return u ? { id: String(u.id), name: u.attributes?.name ?? u.attributes?.slug ?? 'kitsu' } : null;
  },
  async setProgress(token, externalId, chapters, finished) {
    // externalId is the library-entry id for this user and manga, which is what linkSeries stores.
    await kitsuCall(token, `/library-entries/${encodeURIComponent(externalId)}`, {
      method: 'PATCH',
      headers: { 'content-type': KITSU_JSON },
      body: JSON.stringify({
        data: {
          id: String(externalId),
          type: 'libraryEntries',
          attributes: { progress: chapters, status: finished ? 'completed' : 'current' },
        },
      }),
    });
  },
};

// ----------------------------------------------------------------------------

export const ADAPTERS: Record<Provider, TrackerAdapter> = {
  anilist: anilistAdapter,
  myanimelist: malAdapter,
  kitsu: kitsuAdapter,
};

export const PROVIDERS = Object.keys(ADAPTERS) as Provider[];

export const isProvider = (v: unknown): v is Provider =>
  typeof v === 'string' && (PROVIDERS as string[]).includes(v);
