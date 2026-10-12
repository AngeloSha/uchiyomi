// Getting a tracker token, and saying why a Connect or a Test went wrong (v0.61.0, #190).
//
// "AniList did not accept that token" (Kedryn, #190): the paste box told people to create an AniList client and copy
// "the access token", and AniList's client page shows a client ID and a secret, never a token. lib/trackerHelp.ts is
// the web's own, translated help -- AniList's token page for the project's public client 53603, honest words for
// MyAnimeList and Kitsu -- and the reasons a Connect or a Test failed, by the server's code first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ANILIST_CLIENT_ID, anilistTokenUrl, connectProblem, testProblem, testSaid, tokenFromPaste, tokenShape, tokenSource,
} from '../lib/trackerHelp';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed -- several comments quote the code they forbid. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

/** What an ApiError carries: the status and the body as text. */
const apiError = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });
/** A JWT's shape: what AniList and MyAnimeList hand out. */
const JWT = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiI1MzYwMyIsImp0aSI6ImFiYyJ9.c2lnbmF0dXJlLXBhcnQtb2YtdGhlLXRva2Vu';

test('the AniList link is the implicit grant for the project\'s public client, and the server sends the same one', () => {
  // Reintroduce a different client id, or `response_type=code` (a flow that needs a secret this app never holds):
  // this fails. The server's copy is held to the same address, so the web and API clients cannot drift apart.
  assert.equal(ANILIST_CLIENT_ID, 53603);
  const url = anilistTokenUrl();
  assert.equal(url, 'https://anilist.co/api/v2/oauth/authorize?client_id=53603&response_type=token');
  assert.ok(url.includes('client_id=53603&response_type=token'));
  assert.deepEqual(tokenSource('anilist'), { url, shows: true });
  const server = readFileSync(join(ROOT, '..', 'bff', 'src', 'lib', 'trackerProviders.ts'), 'utf8');
  assert.match(server, /export const ANILIST_CLIENT_ID = 53603;/, 'the server uses another AniList client');
  assert.ok(server.includes('`https://anilist.co/api/v2/oauth/authorize?client_id=${ANILIST_CLIENT_ID}&response_type=token`'),
    'the server builds another AniList link');
  // No secret, anywhere: the implicit grant uses none, and the owner's rule is that none is ever stored. A secret would
  // be sent as client_secret=, or sit in the source as a literal of its shape (AniList's are 40 letters and digits).
  for (const src of [read('lib/trackerHelp.ts'), server]) {
    assert.doesNotMatch(src, /client_secret=/, 'a client secret is sent somewhere');
    assert.doesNotMatch(code(src), /['"`][A-Za-z0-9]{32,64}['"`]/, 'a secret-shaped literal is in the source');
  }
});

test('MyAnimeList and Kitsu link to the guide\'s recipes, which exist', () => {
  const mal = tokenSource('myanimelist');
  const kitsu = tokenSource('kitsu');
  assert.equal(mal?.shows, false, 'no MyAnimeList page shows a token');
  assert.equal(kitsu?.shows, false, 'no Kitsu page shows a token');
  assert.match(mal!.url, /docs\/USAGE\.md#getting-a-myanimelist-token$/);
  assert.match(kitsu!.url, /docs\/USAGE\.md#getting-a-kitsu-token$/);
  // The anchors are GitHub's for these headings: rename one and the link lands at the top of a 3,000-line page.
  const usage = readFileSync(join(ROOT, '..', 'docs', 'USAGE.md'), 'utf8');
  assert.match(usage, /^### Getting a MyAnimeList token$/m);
  assert.match(usage, /^### Getting a Kitsu token$/m);
  assert.match(usage, /code_challenge_method=plain/, 'the MyAnimeList recipe lost its PKCE method (plain is the only one MyAnimeList takes)');
  assert.match(usage, /https:\/\/kitsu\.io\/api\/oauth\/token/, 'the Kitsu recipe lost its token endpoint');
  assert.equal(tokenSource('goodreads'), null, 'a provider the web does not know keeps the server\'s help');
});

test('tokenFromPaste takes the token out of a link, a fragment or a JSON answer, and leaves anything else alone', () => {
  // Reintroduce sending the paste as it is: AniList's pin-page address goes to AniList whole and is refused.
  assert.equal(tokenFromPaste(`https://anilist.co/api/v2/oauth/pin#access_token=${JWT}&token_type=Bearer&expires_in=31536000`), JWT);
  assert.equal(tokenFromPaste(`#access_token=${JWT}&token_type=Bearer`), JWT);
  assert.equal(tokenFromPaste(`access_token=${JWT}`), JWT);
  assert.equal(tokenFromPaste(`  ${JWT}\n`), JWT, 'a pasted token is trimmed');
  // What the guide's curl prints for MyAnimeList (compact) and a pretty-printed one.
  assert.equal(tokenFromPaste(`{"token_type":"Bearer","expires_in":2678400,"access_token":"${JWT}","refresh_token":"def502"}`), JWT);
  assert.equal(tokenFromPaste(`{\n  "access_token": "abc123kitsu",\n  "created_at": 1518235801\n}`), 'abc123kitsu');
  assert.equal(tokenFromPaste('https://anilist.co/api/v2/oauth/authorize?client_id=53603&response_type=token'),
    'https://anilist.co/api/v2/oauth/authorize?client_id=53603&response_type=token', 'a link with no token in it is sent as pasted');
  assert.equal(tokenFromPaste('my_access_token=nope'), 'my_access_token=nope', 'a longer name is not access_token');
  assert.equal(tokenFromPaste('   '), '');
});

test('tokenShape: a client ID, a client secret, a fragment, or a token', () => {
  assert.equal(tokenShape('53603'), 'client_id');
  assert.equal(tokenShape(' 53603 '), 'client_id');
  assert.equal(tokenShape('a'.repeat(20) + '0123456789ABCDEFGHIJ'), 'client_secret', 'AniList\'s secret: 40 letters and digits');
  assert.equal(tokenShape('6114d00ca681b7701d1e15fe11a4987e'), 'client_secret', 'MyAnimeList\'s client ID: 32 hex');
  assert.equal(tokenShape('f'.repeat(64)), 'client_secret');
  assert.equal(tokenShape('f'.repeat(31)), 'token', 'too short to be a secret');
  assert.equal(tokenShape('f'.repeat(65)), 'token', 'too long to be a secret');
  assert.equal(tokenShape(JWT), 'token', 'a JWT has dots');
  assert.equal(tokenShape(`#access_token=${JWT}`), 'fragment');
  assert.equal(tokenShape(''), 'empty');
});

test('Connect says why, by code first', () => {
  // Reintroduce the old toast -- "{name} did not accept that token" for every failure -- and the unreachable and
  // refused lines below read as a verdict on the token.
  assert.equal(connectProblem(apiError(502, { error: 'tracker_unreachable', message: 'Could not reach AniList.' }), 'anilist', 'AniList', JWT),
    'Could not reach AniList from this server. Check its internet connection and try again.');
  assert.equal(connectProblem(apiError(502, { error: 'tracker_refused', status: 403 }), 'anilist', 'AniList', JWT),
    'AniList refused the request (HTTP 403). That is not about your token: try again later.');
  assert.equal(connectProblem(apiError(502, { error: 'tracker_refused' }), 'kitsu', 'Kitsu', 'tok'),
    'Kitsu refused the request. That is not about your token: try again later.');
  assert.equal(connectProblem(apiError(400, { error: 'rejected' }), 'anilist', 'AniList', JWT), 'AniList did not accept that token');
  // What the paste was, when the service refused it and the shape can tell.
  assert.equal(connectProblem(apiError(400, { error: 'bad_request' }), 'anilist', 'AniList', '53603'), 'That is a client ID, not the token.');
  assert.equal(connectProblem(apiError(400, { error: 'rejected' }), 'anilist', 'AniList', 'Ab'.repeat(20)),
    'That looks like an app’s client ID or secret, not the token.');
  assert.equal(connectProblem(apiError(400, { error: 'rejected' }), 'myanimelist', 'MyAnimeList', '6114d00ca681b7701d1e15fe11a4987e'),
    'That looks like an app’s client ID or secret, not the token.');
  // Not for Kitsu, whose real tokens can look exactly like that.
  assert.equal(connectProblem(apiError(400, { error: 'rejected' }), 'kitsu', 'Kitsu', 'f'.repeat(64)), 'Kitsu did not accept that token');
  // Not a refusal of ours at all: the server's sentence, else that it did not answer.
  assert.equal(connectProblem(apiError(500, { message: 'Internal Server Error' }), 'anilist', 'AniList', JWT), 'Internal Server Error');
  assert.equal(connectProblem(new TypeError('Failed to fetch'), 'anilist', 'AniList', JWT), 'The server did not answer. Try again in a moment.');
});

test('Test connection says what the service answered', () => {
  assert.equal(testSaid({ ok: true, verdict: 'connected', account: 'Kedryn' }, 'AniList'), 'It works: AniList answers as Kedryn.');
  assert.equal(testSaid({ ok: false, verdict: 'rejected' }, 'AniList'), 'AniList no longer accepts this token. Disconnect, then connect again with a new one.');
  assert.equal(testSaid({ ok: false, verdict: 'unreachable' }, 'AniList'), 'Could not reach AniList from this server. Check its internet connection and try again.');
  assert.equal(testSaid({ ok: false, verdict: 'refused', status: 429 }, 'MyAnimeList'), 'MyAnimeList refused the request (HTTP 429). That is not about your token: try again later.');
  assert.equal(testSaid({ ok: false, verdict: 'expired' }, 'Kitsu'), 'This token has expired. Disconnect, then connect again with a new one.');
  assert.equal(testSaid({ ok: false, verdict: 'not_connected' }, 'Kitsu'), 'Not connected');
  assert.equal(testProblem(apiError(429, { statusCode: 429, error: 'Too Many Requests', message: 'Rate limit exceeded, retry in 1 minute' })),
    'Six tests a minute at most — try again shortly', 'the limiter\'s English sentence is not shown');
  assert.equal(testProblem(new TypeError('Failed to fetch')), 'The server did not answer. Try again in a moment.');
});

test('the Connections row: the web\'s help, the token taken out of the paste, the reason inline, and Test connection', () => {
  // Reintroduce `{t.tokenHelp && <p …>{t.tokenHelp}</p>}` for every provider, `json: { token: token.trim() }`, the error
  // toast, or drop the Test key: the matching assertion names it.
  const src = code(read('components/ProfileConnections.tsx'));
  const start = src.indexOf('function TrackerRow(');
  const row = src.slice(start, src.indexOf('function OpdsSection('));
  assert.ok(start >= 0 && row.length > 0, 'TrackerRow is not where this test looks');
  assert.match(row, /<TokenHelp provider=\{t\.provider\} name=\{label\} fallback=\{t\.tokenHelp\} \/>/, 'the paste box shows the server\'s English help again');
  assert.match(row, /const src = tokenSource\(provider\);\s*if \(!src\) return fallback \?/, 'the server\'s help is not only the fallback');
  assert.match(row, /const sent = tokenFromPaste\(token\);/, 'the token is not taken out of a pasted link or answer');
  assert.match(row, /json: \{ token: sent \}/, 'the paste is sent as it is');
  assert.match(row, /catch \(e\) \{ setProblem\(connectProblem\(e, t\.provider, label, sent\)\); \}/, 'a failed Connect is not said inline by its code');
  assert.doesNotMatch(row, /did not accept that token/, 'the toast that blamed the token for every failure is back');
  assert.match(row, /<p role="status" aria-live="polite" data-tracker-problem/, 'the reason is not a status line');
  assert.match(row, /api<TestResult>\(`\/api\/trackers\/\$\{t\.provider\}\/test`, \{ method: 'POST' \}\)/, 'Test connection does not call the test route');
  assert.match(row, /onClick=\{test\} disabled=\{testing\} className="btn-key"/, 'Test connection is not a key');
  assert.match(row, /tr\('Test connection'\)/);
  assert.match(row, /<span role="status" aria-live="polite" data-tracker-test/, 'the test\'s answer is not a status line');
  assert.match(row, /className="btn-key btn-key-accent" data-token-page/, 'AniList\'s token page is not a key');
});
