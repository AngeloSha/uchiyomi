// Browsing and installing Mihon/Tachiyomi extensions on the connected Suwayomi server.
//
// Uchiyomi is a remote control here, not a store: the catalogue comes from repositories the OPERATOR has
// configured on their own server, and Suwayomi does the fetching and installing. No repository URL ships in
// this codebase, and nothing is fetched until someone adds one.
//
// Operation names and shapes verified live against Suwayomi-Server v2.3.2243.
import { gql as defaultGql, type Gql } from './client';

export interface ExtensionInfo {
  pkgName: string;
  name: string;
  lang: string | null;
  versionName: string | null;
  iconUrl: string | null;
  installed: boolean;
  hasUpdate: boolean;
  obsolete: boolean;
  nsfw: boolean;
  repo: string | null;
}

interface RawExtension {
  pkgName: string; name?: string | null; lang?: string | null; versionName?: string | null;
  iconUrl?: string | null; isInstalled?: boolean | null; hasUpdate?: boolean | null;
  isObsolete?: boolean | null; isNsfw?: boolean | null; repo?: string | null;
}

const EXT_FIELDS = 'pkgName name lang versionName iconUrl isInstalled hasUpdate isObsolete isNsfw repo';

const toInfo = (e: RawExtension): ExtensionInfo | null =>
  e?.pkgName
    ? {
        pkgName: e.pkgName,
        name: e.name?.trim() || e.pkgName,
        lang: e.lang || null,
        versionName: e.versionName || null,
        iconUrl: e.iconUrl || null,
        installed: !!e.isInstalled,
        hasUpdate: !!e.hasUpdate,
        obsolete: !!e.isObsolete,
        nsfw: !!e.isNsfw,
        repo: e.repo || null,
      }
    : null;

/** Everything the configured repositories offer, plus what is already installed. */
export async function listExtensions(run: Gql = defaultGql): Promise<ExtensionInfo[]> {
  const d = await run<{ extensions: { nodes: RawExtension[] } }>(`{ extensions { nodes { ${EXT_FIELDS} } } }`, {}, 30000);
  const nodes = d?.extensions?.nodes;
  return Array.isArray(nodes) ? nodes.map(toInfo).filter((e): e is ExtensionInfo => !!e) : [];
}

/**
 * Re-read the repositories. Slow (it downloads each repo index), so it runs when someone asks for it or on
 * the scheduled extension check -- never on every catalogue read.
 *
 * This is the ONLY thing that makes the engine recompute "update available". Its previous one-line comment
 * said "only ever explicit", and that sentence was the bug: the nightly auto-updater read the catalogue
 * without ever calling this, so it compared against whatever an admin had last refreshed by hand and found
 * nothing to do, indefinitely.
 */
export async function refreshExtensions(run: Gql = defaultGql, timeoutMs = 120000): Promise<number> {
  const d = await run<{ fetchExtensions: { extensions: RawExtension[] } }>(
    `mutation{ fetchExtensions(input:{}){ extensions { pkgName } } }`, {}, timeoutMs,
  );
  return d?.fetchExtensions?.extensions?.length ?? 0;
}

export type ExtensionAction = 'install' | 'uninstall' | 'update';

export async function setExtensionState(pkgName: string, action: ExtensionAction, run: Gql = defaultGql): Promise<boolean> {
  const patch = action === 'install' ? 'install:true' : action === 'uninstall' ? 'uninstall:true' : 'update:true';
  const d = await run<{ updateExtension: { extension: RawExtension | null } }>(
    `mutation($id:String!){ updateExtension(input:{id:$id,patch:{${patch}}}){ extension { pkgName isInstalled } } }`,
    { id: pkgName },
    180000, // installing downloads an APK and converts its bytecode; it is genuinely slow
  );
  return !!d?.updateExtension?.extension;
}

/** The source ids one installed extension provides — an extension can carry several (one per language). */
export async function sourcesOfExtension(pkgName: string, run: Gql = defaultGql): Promise<Array<{ id: string; name: string; lang: string | null; nsfw: boolean }>> {
  const d = await run<{ extensions: { nodes: Array<{ pkgName: string; source?: { nodes?: Array<{ id: string; name?: string; lang?: string; isNsfw?: boolean }> } }> } }>(
    `{ extensions { nodes { pkgName source { nodes { id name lang isNsfw } } } } }`, {}, 30000,
  );
  const hit = (d?.extensions?.nodes || []).find((e) => e.pkgName === pkgName);
  return (hit?.source?.nodes || [])
    .filter((s) => s && s.id != null)
    .map((s) => ({ id: String(s.id), name: s.name || pkgName, lang: s.lang ?? null, nsfw: !!s.isNsfw }));
}

// ---- extension repositories -------------------------------------------------

export async function getRepos(run: Gql = defaultGql): Promise<string[]> {
  const d = await run<{ settings: { extensionRepos: string[] | null } }>(`{ settings { extensionRepos } }`, {}, 15000);
  return d?.settings?.extensionRepos ?? [];
}

export async function setRepos(urls: string[], run: Gql = defaultGql): Promise<string[]> {
  const d = await run<{ setSettings: { settings: { extensionRepos: string[] | null } } }>(
    `mutation($r:[String!]){ setSettings(input:{settings:{extensionRepos:$r}}){ settings { extensionRepos } } }`,
    { r: urls },
    20000,
  );
  return d?.setSettings?.settings?.extensionRepos ?? [];
}

// ---- what someone pastes into "Add a repository" ----------------------------------------------------------
//
// People paste what they have, and what they have is rarely the bare index URL: Mihon's "Add to Mihon" buttons
// are `mihon://add-repo?url=…` / `tachiyomi://add-repo?url=…` links (or a web page that forwards to one), a
// copied address loses its `https://`, and the repository's GitHub PAGE is the easiest thing to find. Before
// v0.45.0 every one of those passed a bare `z.string().url()` (or failed it for the missing scheme) and was
// handed to the engine verbatim, which then yielded nothing -- and the route kept it and reported the whole
// catalogue's size as a success.

export type RepoInput =
  | { ok: true; url: string; unwrapped: boolean; schemeAdded: boolean }
  | { ok: false; error: 'bad_url' | 'github_page'; message: string };

/** What the engine and the admin panel say for each refusal; the panel maps `error` to its own translation. */
export const REPO_MESSAGES = {
  bad_url: 'That doesn’t look like a repository address. It usually ends in index.min.json.',
  github_page: 'That is a GitHub page, not the repository itself. Paste the repository’s index.min.json link instead.',
} as const;

/** The longest address kept. The engine stores it in its settings and it is shown in the panel. */
const MAX_REPO_URL = 500;

/**
 * The `url=` inside an add-repo link, or null when `s` is not one. `mihon://add-repo?url=…` parses with the
 * host "add-repo" and an empty path; a web page that forwards to it has `add-repo` as its last path segment.
 * The scheme is not checked, so the forks' own `…://add-repo` links unwrap the same way.
 */
function addRepoTarget(s: string): string | null {
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  const isAddRepo = u.hostname.toLowerCase() === 'add-repo' || /(^|\/)add-repo\/?$/i.test(u.pathname);
  if (!isAddRepo) return null;
  const inner = (u.searchParams.get('url') ?? '').trim();
  return inner || null;
}

/**
 * Turn a paste into the address to hand the engine, or say plainly why it is not one.
 *
 * - trims, and drops the quotes or angle brackets a copy out of a chat or a README can carry;
 * - unwraps one level of add-repo link (`mihon://`, `tachiyomi://`, or a web `…/add-repo?url=`);
 * - adds `https://` when there is no scheme (`example.org/repo/index.min.json`);
 * - accepts http(s) only;
 * - a GitHub repository PAGE is refused with advice rather than guessed at: turning `github.com/owner/name`
 *   into a raw URL means picking a branch, and a wrong guess yields an empty catalogue that looks exactly like
 *   a broken repository. A link to one FILE on GitHub (`…/blob/<ref>/index.min.json`) names its branch, so
 *   that one becomes the raw file address; a release download (`…/releases/download/…/x.json`) is a file too
 *   and is kept.
 *
 * The result keeps the path's case (raw file hosts are case-sensitive); only `repoKey` folds case.
 *
 * ⚠️ A control character INSIDE the paste (CR, LF, tab, NUL -- typed, or %0D%0A-encoded in an add-repo link's
 * url=) is refused, never deleted: deleting it quietly turned the input into a different address
 * (`…/repo\r\nX-Injected: 1/…` became `…/repoX-Injected:1/…`). It is checked BEFORE the add-repo link is
 * parsed too, because the URL parser itself drops tabs and newlines. Ordinary spaces are still squeezed out,
 * as they always were.
 */
export function parseRepoInput(raw: string): RepoInput {
  const bad = { ok: false as const, error: 'bad_url' as const, message: REPO_MESSAGES.bad_url };
  const control = /[\u0000-\u001f\u007f]/;
  let s = String(raw ?? '').trim().replace(/^[<"'`“‘]+|[>"'`”’]+$/g, '').trim();
  if (control.test(s)) return bad;
  let unwrapped = false;
  const inner = addRepoTarget(s);
  if (inner !== null) { s = inner; unwrapped = true; }
  if (control.test(s)) return bad;
  s = s.replace(/\s+/g, '');
  if (!s) return bad;
  let schemeAdded = false;
  if (s.startsWith('//')) { s = `https:${s}`; schemeAdded = true; }
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) { s = `https://${s}`; schemeAdded = true; }
  let u: URL;
  try { u = new URL(s); } catch { return bad; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname) return bad;
  // A bare word ("myrepo") is not an address someone meant, but `http://nas:8080/…` on a LAN is: a host with
  // no dot is refused only when WE supplied the scheme and nothing else marks it as a server.
  if (schemeAdded && !u.hostname.includes('.') && u.hostname !== 'localhost' && !u.port) return bad;
  u.hash = '';
  const host = u.hostname.toLowerCase();
  if (host === 'github.com' || host === 'www.github.com') {
    const file = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+\.(?:json|pb))$/i);
    if (file) {
      // The same length limit as every other address (this branch returned before it did).
      const rawUrl = `https://raw.githubusercontent.com/${file[1]}/${file[2]}/${file[3]}`;
      return rawUrl.length > MAX_REPO_URL ? bad : { ok: true, url: rawUrl, unwrapped, schemeAdded };
    }
    if (!/\.(?:json|pb)$/i.test(u.pathname)) return { ok: false, error: 'github_page', message: REPO_MESSAGES.github_page };
  }
  const url = u.href;
  if (url.length > MAX_REPO_URL) return bad;
  return { ok: true, url, unwrapped, schemeAdded };
}

/**
 * One repository, however it is spelled: case, scheme, trailing slashes and the index file's name all fold
 * away, so `HTTPS://Example.org/repo/`, `https://example.org/repo/index.min.json` and the engine's own
 * spelling of it compare equal.
 *
 * ⚠️ The index file names matter, not only case: Suwayomi v2.3.2243 swaps an `index.min.json` it is given for
 * the `repo.json` beside it (and that for the `index_v2` it names, usually `index.pb` in the same folder) and
 * stores THAT in its list. Without folding those, adding the same repository a second time was not a
 * duplicate, and the monitor's copy never matched the engine's.
 */
export function repoKey(url: string): string {
  let s = String(url ?? '').trim().toLowerCase().replace(/#.*$/, '');
  const qAt = s.indexOf('?');
  const query = qAt >= 0 ? s.slice(qAt) : '';
  if (qAt >= 0) s = s.slice(0, qAt);
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/\/+$/, '');
  s = s.replace(/\/(?:index\.min\.json|index\.json|repo\.json|index\.pb)$/, '').replace(/\/+$/, '');
  return s + query;
}

/**
 * How many extensions THIS repository put in the catalogue.
 *
 * Judged by the engine's own per-extension repository field (`repo`, which is `storeIndexUrl` at v2.3.2243):
 * an extension counts when the repository it came from is none of the ones configured before the add, and it
 * was not already in the catalogue under that repository. That second clause is what keeps an installed
 * extension whose repository was removed long ago -- the engine keeps its row and its old address -- from
 * being credited to whatever is added next. Matching the address the user typed would not do: the engine
 * stores its own spelling of it (see repoKey), which is why the check is "none of the old ones" rather than
 * "this one".
 *
 * ⚠️ That orphan is OBSOLETE (the engine flags an installed extension no configured repository offers), and
 * obsolete is what is skipped -- on both sides. Skipping it in `before` only by "already seen" refused the one
 * add that brings it back: remove a repository, add it again, and every extension it offers that is still
 * installed was "already there", so a repository whose extensions were all installed yielded 0, was taken
 * back out with a 422, and its extensions stayed obsolete (no updates) for good. The engine re-attaches them
 * on the re-add (isObsolete true before, false after), so a row obsolete BEFORE is not "seen", and a row
 * still obsolete AFTER was not brought by this repository.
 *
 * An engine that names no repository per extension is judged by the catalogue growing instead. ⚠️ Never by
 * the catalogue's SIZE: until v0.45.0 a broken second repository toasted "Added — 1396 extensions" because
 * that was the first repository's count.
 */
export function contributedBy(all: ExtensionInfo[], before: ExtensionInfo[], existingRepos: string[]): number {
  if (!all.some((e) => e.repo)) return Math.max(0, all.length - before.length);
  const old = new Set(existingRepos.map(repoKey));
  const seen = new Set(before.filter((e) => e.repo && !e.obsolete).map((e) => `${e.pkgName}\n${repoKey(e.repo!)}`));
  return all.filter((e) => {
    if (!e.repo || e.obsolete) return false;
    const k = repoKey(e.repo);
    return !old.has(k) && !seen.has(`${e.pkgName}\n${k}`);
  }).length;
}

/** The engine's own words for a failure, without our transport's `suwayomi:` prefix. */
export function engineReason(e: unknown): string {
  const m = String((e as Error)?.message ?? e ?? '').replace(/^suwayomi:?\s*/i, '').trim();
  return (m || 'no reason given').slice(0, 300);
}

/**
 * A second URL worth trying when a repository yields nothing at all.
 *
 * This is insurance, not a rule. The usual cause of an empty result is timing, not the URL: the server
 * applies a settings change asynchronously, so a repository read immediately after being added comes back
 * empty and needs a retry (the caller does that first). But repository layouts do vary, so when retries have
 * genuinely produced nothing, this offers one more thing to try:
 *
 * - `…/index.json` → the `…/index.min.json` beside it;
 * - a bare folder (`…/repo` or `…/repo/`) → `…/repo/index.min.json`, the file Mihon itself reads.
 *
 * Both point AT index.min.json because Suwayomi v2.3.2243 refuses a legacy (list-shaped) index at any address
 * that does not end in `/index.min.json` ("Provided legacy store url is not valid", only in the engine's log).
 * ⚠️ Until v0.45.0's review the alternative ran the other way, `…/index.min.json` → `…/index.json`, which that
 * rule makes impossible: every refused add spent ~2 s and two engine writes on it, and a pasted `index.json`
 * -- the one case where an alternative helps -- got none and was refused, though the index.min.json in the
 * same folder works. An index.min.json that yields nothing has no alternative.
 *
 * The caller must verify: try what the user typed, and keep this alternative ONLY if it produced something.
 * Rewriting a URL blindly would break repositories where the original form is the correct one.
 */
export function altRepoUrl(raw: string): string | null {
  const u = raw.trim().replace(/\s+/g, '');
  const qAt = u.search(/[?#]/);
  const path = qAt >= 0 ? u.slice(0, qAt) : u;
  const rest = qAt >= 0 ? u.slice(qAt) : '';
  if (/\/index\.json$/i.test(path)) return path.replace(/\/index\.json$/i, '/index.min.json') + rest;
  if (/\/$/.test(path)) return `${path}index.min.json${rest}`;
  if (!/\.(json|pb)$/i.test(path)) return `${path}/index.min.json${rest}`;
  return null;
}
