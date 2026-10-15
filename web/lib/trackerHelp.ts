// Getting a tracker token, and why a Connect or a Test went the way it did -- in the reader's words (v0.61.0, #190).
//
// The paste box showed the server's sentence, "anilist.co → Settings → Developer → create a client, then copy the access
// token", in English in every language -- and AniList's client page shows a client ID and a secret, never a token, so the
// one instruction on screen led to a paste AniList could only refuse. Kedryn's report (#190) was that refusal: "AniList
// did not accept that token". The owner registered a public AniList client for the project, id 53603, whose redirect is
// AniList's own pin page: its authorize link asks the person to approve Uchiyomi and then SHOWS the token (AniList's
// implicit grant). Nothing secret is involved -- a client id is public by design, and no client secret exists anywhere
// in this app -- and it is still paste-a-token, not a sign-in: nothing comes back to this server. MyAnimeList, Kitsu and
// MangaUpdates (#244) show no token on any page, so their help says so and links to the guide's recipes (docs/USAGE.md,
// section 10): a person's password goes to the service, never through this server.
//
// The server sends the same AniList link as `authorizeUrl` in GET /api/trackers, for API clients
// (bff/src/lib/trackerProviders.ts); web/test/trackerHelp.test.ts holds the two to one address.
import { t as tr } from './i18n';

/** The project's public AniList API client (redirect: https://anilist.co/api/v2/oauth/pin). Public by design. */
export const ANILIST_CLIENT_ID = 53603;

/**
 * AniList's implicit grant for a client: approve, and AniList's pin page shows the access token to copy. Reintroduce
 * `response_type=code` (a flow that needs the client secret this app never holds): "the AniList link is the implicit
 * grant …" in web/test/trackerHelp.test.ts fails.
 */
export const anilistTokenUrl = (clientId: number = ANILIST_CLIENT_ID): string =>
  `https://anilist.co/api/v2/oauth/authorize?client_id=${clientId}&response_type=token`;

const GUIDE = 'https://github.com/AngeloSha/uchiyomi/blob/main/docs/USAGE.md';

/**
 * Where a service's token comes from: a page that shows one (`shows`), or the guide's steps for getting one. Null for
 * a provider the web does not know yet, which keeps the server's English `tokenHelp`.
 */
export function tokenSource(provider: string): { url: string; shows: boolean } | null {
  switch (provider) {
    case 'anilist': return { url: anilistTokenUrl(), shows: true };
    case 'myanimelist': return { url: `${GUIDE}#getting-a-myanimelist-token`, shows: false };
    case 'kitsu': return { url: `${GUIDE}#getting-a-kitsu-token`, shows: false };
    case 'mangaupdates': return { url: `${GUIDE}#getting-a-mangaupdates-token`, shows: false };
    default: return null;
  }
}

/**
 * `access_token` as a link or a fragment carries it (`#access_token=…&token_type=…`, the address of AniList's pin page),
 * or as a token endpoint's JSON answer does (`"access_token":"…"`, what the guide's curl prints for MyAnimeList and
 * Kitsu) -- or `session_token`, as MangaUpdates' login answers it (`"context":{"session_token":"…"}`, #244). What
 * follows is the token, up to the next `&`, quote, `#` or space.
 */
const ACCESS_TOKEN = /(?:^|[#?&\s"'{,])(?:access_token|session_token)(?:=|"\s*:\s*")([^&\s"'#]+)/;

/**
 * The token in a paste: out of a link, a fragment or a JSON answer when the paste carries `access_token`, otherwise the
 * paste itself, trimmed. Only ever narrows what was pasted; a paste with no `access_token` in it is sent as it is.
 * Reintroduce sending every paste as it is: "tokenFromPaste takes the token out of a link …" in
 * web/test/trackerHelp.test.ts fails.
 */
export function tokenFromPaste(raw: string): string {
  const s = raw.trim();
  const m = ACCESS_TOKEN.exec(s);
  if (!m) return s;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

export type TokenShape = 'empty' | 'fragment' | 'client_id' | 'client_secret' | 'token';

/**
 * What a paste looks like, to say precisely what went wrong when the service refuses it -- never to refuse it here: a
 * shape only chooses a message (connectProblem), and Connect sends whatever was pasted. A client ID is digits only
 * (AniList's are); a client secret is 32 to 64 letters and digits with no dot (AniList's is 40, MyAnimeList's client ID
 * 32 and its secret 64). AniList's and MyAnimeList's access tokens are JWTs -- long, with dots -- so neither shape can be
 * one of theirs. `fragment` is a paste that carries `access_token=` (tokenFromPaste takes the token out of it).
 */
export function tokenShape(raw: string): TokenShape {
  const s = raw.trim();
  if (!s) return 'empty';
  if (ACCESS_TOKEN.test(s)) return 'fragment';
  if (/^\d+$/.test(s)) return 'client_id';
  if (/^[A-Za-z0-9]{32,64}$/.test(s)) return 'client_secret';
  return 'token';
}

/**
 * The providers whose tokens a shape can rule out. Not Kitsu: its access tokens are opaque strings that can be exactly
 * 32 to 64 letters and digits, so "that looks like a client secret" would be said of a real token Kitsu had expired.
 * Reintroduce the hint for Kitsu: "Connect says why, by code first" in web/test/trackerHelp.test.ts fails.
 */
const JWT_TOKENS = new Set(['anilist', 'myanimelist']);

/** The sentence for a paste the service refused that was not a token at all, or null when the shape says nothing. */
function shapeHint(provider: string, sent: string): string | null {
  if (!JWT_TOKENS.has(provider)) return null;
  const shape = tokenShape(sent);
  if (shape === 'client_id') return tr('That is a client ID, not the token.');
  if (shape === 'client_secret') return tr('That looks like an app’s client ID or secret, not the token.');
  return null;
}

/** An ApiError's status and JSON body, read without importing lib/api (this file stays pure for its tests). */
function answerOf(e: unknown): { status: number; body: { error?: string; status?: number; message?: string } } {
  const err = e as { status?: unknown; body?: unknown } | null;
  let body = {};
  try { body = JSON.parse(typeof err?.body === 'string' && err.body ? err.body : '{}') ?? {}; } catch { /* not JSON */ }
  return { status: typeof err?.status === 'number' ? err.status : 0, body };
}

const unreachable = (name: string) => tr('Could not reach {name} from this server. Check its internet connection and try again.', { name });
const refused = (name: string, status?: number) => (status
  ? tr('{name} refused the request (HTTP {status}). That is not about your token: try again later.', { name, status })
  : tr('{name} refused the request. That is not about your token: try again later.', { name }));

/**
 * Why a Connect failed, by the server's code first (v0.61.0): `tracker_unreachable` and `tracker_refused` are not about
 * the token, and say so; `rejected` (and a paste too short to send, `bad_request`) is, and names a client ID or secret
 * when that is what `sent` was. Anything else is the server's own sentence, else that it did not answer.
 * Reintroduce by saying "did not accept that token" for every failure: "Connect says why, by code first" in
 * web/test/trackerHelp.test.ts fails.
 */
export function connectProblem(e: unknown, provider: string, name: string, sent: string): string {
  const { body } = answerOf(e);
  switch (body.error) {
    case 'tracker_unreachable': return unreachable(name);
    case 'tracker_refused': return refused(name, typeof body.status === 'number' ? body.status : undefined);
    case 'rejected':
    case 'bad_request':
      return shapeHint(provider, sent) ?? tr('{name} did not accept that token', { name });
  }
  return body.message || tr('The server did not answer. Try again in a moment.');
}

export type TestVerdict = 'connected' | 'rejected' | 'unreachable' | 'refused' | 'expired' | 'not_connected';
export interface TestResult { ok: boolean; verdict: TestVerdict; account?: string; status?: number }

/** What Test connection found, as one sentence (POST /api/trackers/:provider/test). */
export function testSaid(r: TestResult, name: string): string {
  switch (r.verdict) {
    case 'connected': return tr('It works: {name} answers as {account}.', { name, account: r.account ?? '' });
    case 'rejected': return tr('{name} no longer accepts this token. Disconnect, then connect again with a new one.', { name });
    case 'unreachable': return unreachable(name);
    case 'refused': return refused(name, r.status);
    case 'expired': return tr('This token has expired. Disconnect, then connect again with a new one.');
    case 'not_connected': return tr('Not connected');
  }
  return tr('The server did not answer. Try again in a moment.');
}

/** Why a Test could not be made at all: the limit (six a minute), else the server's sentence, else no answer. */
export function testProblem(e: unknown): string {
  const { status, body } = answerOf(e);
  if (status === 429) return tr('Six tests a minute at most — try again shortly');
  return body.message || tr('The server did not answer. Try again in a moment.');
}
