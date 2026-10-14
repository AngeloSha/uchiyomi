// Browsing and installing Mihon/Tachiyomi extensions on the connected Suwayomi server.
//
// Uchiyomi is a remote control here, not a store: the catalogue comes from repositories the OPERATOR has
// configured on their own server, and Suwayomi does the fetching and installing. No repository URL ships in
// this codebase, and nothing is fetched until someone adds one.
//
// A "repository" is what the engine calls an extension STORE since v2.3.2243: added and removed one at a time
// (addExtensionStore / removeExtensionStore), listed by extensionStores. The documents are in operations.ts.
import { gql as defaultGql, type Gql } from './client';
import { adultOf } from './sources';
import { OPS } from './operations';

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
  /** The store it was offered by, as the engine spells it (`storeIndexUrl`; it replaced `repo`). */
  repo: string | null;
}

interface RawExtension {
  pkgName: string; name?: string | null; lang?: string | null; versionName?: string | null;
  iconUrl?: string | null; isInstalled?: boolean | null; hasUpdate?: boolean | null;
  isObsolete?: boolean | null; contentWarning?: string | null; storeIndexUrl?: string | null;
}

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
        // SAFE, MIXED or NSFW; anything but SAFE is 18+, and a value we do not know is too (sources.ts adultOf).
        nsfw: adultOf(e.contentWarning),
        repo: e.storeIndexUrl || null,
      }
    : null;

/**
 * Moved on by everything here that can change which extensions have an update waiting -- an install, an update or a
 * removal, a re-read of the repositories, a new list of them -- once it has asked the engine, whatever the answer. A
 * copy of the engine's answer kept for half a minute (lib/sourcesOverview.ts updatesWaiting) is not read past it:
 * Needs attention's "1 extension has an update" stayed up to 45 s after its own Update had applied it.
 */
let generation = 0;
export const extensionsGeneration = (): number => generation;
const moved = async <T>(work: Promise<T>): Promise<T> => {
  try { return await work; } finally { generation++; }
};

/** Everything the configured repositories offer, plus what is already installed. */
export async function listExtensions(run: Gql = defaultGql): Promise<ExtensionInfo[]> {
  const d = await run<{ extensions: { nodes: RawExtension[] } }>(OPS.extensions.doc, {}, 30000);
  const nodes = d?.extensions?.nodes;
  return Array.isArray(nodes) ? nodes.map(toInfo).filter((e): e is ExtensionInfo => !!e) : [];
}

/** What ranks a catalogue package for Fix everything (v0.55.1, lib/extensionRank.ts). */
export interface ExtensionFacts {
  versionCode: number | null;
  /** Its apk and jar, where its repository's index points (GitHub release files for Keiyoushi's). */
  apkUrl: string | null;
  jarUrl: string | null;
  /** The apk's file name, and the index it was read from: what finds its files when the engine gives no address. */
  apkName: string | null;
  index: string | null;
}

/**
 * Each catalogue package's version code and its files -- the addresses of its apk and jar, the apk's name and its
 * repository's index -- by package. Asked apart from listExtensions on purpose: these are the v2.3 engine's fields, and
 * an engine that lacks them must not take the catalogue down with it -- it answers no facts, and the ranking falls back
 * to names.
 */
export async function extensionFacts(run: Gql = defaultGql): Promise<Map<string, ExtensionFacts>> {
  try {
    const d = await run<{ extensions: { nodes: Array<{
      pkgName: string; versionCodeLong?: string | null; apkUrl?: string | null; jarUrl?: string | null; apkName?: string | null; storeIndexUrl?: string | null;
    }> } }>(OPS.extensionFacts.doc, {}, 30000);
    const out = new Map<string, ExtensionFacts>();
    for (const e of d?.extensions?.nodes ?? []) {
      if (!e?.pkgName) continue;
      const v = Number(e.versionCodeLong);
      out.set(e.pkgName, {
        versionCode: Number.isFinite(v) ? v : null, apkUrl: e.apkUrl || null, jarUrl: e.jarUrl || null,
        apkName: e.apkName || null, index: e.storeIndexUrl || null,
      });
    }
    return out;
  } catch {
    return new Map();
  }
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
  const d = await moved(run<{ fetchExtensions: { extensions: RawExtension[] } }>(OPS.fetchExtensions.doc, {}, timeoutMs));
  return d?.fetchExtensions?.extensions?.length ?? 0;
}

export type ExtensionAction = 'install' | 'uninstall' | 'update';

export async function setExtensionState(pkgName: string, action: ExtensionAction, run: Gql = defaultGql): Promise<boolean> {
  const d = await moved(run<{ updateExtension: { extension: RawExtension | null } }>(
    OPS.updateExtension.doc,
    { id: pkgName, patch: { [action]: true } },
    180000, // installing downloads an APK and converts its bytecode; it is genuinely slow
  ));
  return !!d?.updateExtension?.extension;
}

/** The source ids one installed extension provides — an extension can carry several (one per language). */
export async function sourcesOfExtension(pkgName: string, run: Gql = defaultGql): Promise<Array<{ id: string; name: string; lang: string | null; nsfw: boolean }>> {
  const d = await run<{ extensions: { nodes: Array<{ pkgName: string; source?: { nodes?: Array<{ id: string; name?: string; lang?: string; contentWarning?: string }> } }> } }>(
    OPS.sourcesOfExtension.doc, {}, 30000,
  );
  const hit = (d?.extensions?.nodes || []).find((e) => e.pkgName === pkgName);
  return (hit?.source?.nodes || [])
    .filter((s) => s && s.id != null)
    .map((s) => ({ id: String(s.id), name: s.name || pkgName, lang: s.lang ?? null, nsfw: adultOf(s.contentWarning) }));
}

// ---- extension repositories (the engine's extension stores) ---------------------------------------------------
//
// Measured on throwaway v2.3.2243 and v2.4.2366 engines, with a fixture store on a network of their own, and the same
// on both (2026-10-14):
//   * an add fetches the index there and then and answers in tens of milliseconds -- the store, or the engine's error
//     ("Provided legacy store url is not valid" for a list-shaped index anywhere but at …/index.min.json, "HTTP error
//     404", a decoding error for a web page, a DNS failure). Nothing is applied later: the catalogue's next
//     fetchExtensions lists its extensions at once;
//   * it stores its OWN spelling and answers it: the repo.json beside a pasted index.min.json (or the index that
//     repo.json names), so the address to remove by is the one the add answered;
//   * adding a store it holds again is no error and changes nothing; a remove matches the address exactly, and one it
//     does not hold answers null, with no error;
//   * stores outlive a restart, and the deprecated `settings { extensionRepos }` -- what Uchiyomi read and wrote until
//     then -- shows a store added this way only after one.

/** The stores the engine holds, by its own spelling of each address. */
export async function getRepos(run: Gql = defaultGql): Promise<string[]> {
  const d = await run<{ extensionStores: { nodes: Array<{ indexUrl?: string | null }> | null } }>(OPS.extensionStores.doc, {}, 15000);
  return (d?.extensionStores?.nodes ?? []).map((n) => n?.indexUrl).filter((u): u is string => typeof u === 'string' && !!u);
}

/**
 * Add one store. Throws with the engine's reason when it cannot read the address -- a refusal of the ADDRESS, which the
 * route counts as nothing found there -- and answers the address the engine stored it under.
 */
export async function addRepo(url: string, run: Gql = defaultGql): Promise<{ indexUrl: string; name: string | null }> {
  const d = await moved(run<{ addExtensionStore: { extensionStore: { indexUrl?: string | null; name?: string | null } | null } | null }>(
    OPS.addExtensionStore.doc, { indexUrl: url }, 60000,
  ));
  const store = d?.addExtensionStore?.extensionStore;
  // The engine answered no store and no error: not a shape it has, so not taken as an add.
  if (!store?.indexUrl) throw new Error('suwayomi: the engine did not say which store it added');
  return { indexUrl: store.indexUrl, name: store.name ?? null };
}

/** Remove one store by the engine's own spelling of its address. False when it held none under that address. */
export async function removeRepo(indexUrl: string, run: Gql = defaultGql): Promise<boolean> {
  const d = await moved(run<{ removeExtensionStore: { extensionStore: { indexUrl?: string | null } | null } | null }>(
    OPS.removeExtensionStore.doc, { indexUrl }, 20000,
  ));
  return !!d?.removeExtensionStore?.extensionStore;
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
 * Judged by the engine's own per-extension store field (`storeIndexUrl`, read into `repo`):
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

/**
 * The engine's own words for a failure: without our transport's `suwayomi:` prefix, graphql-java's "Exception while
 * fetching data (/addExtensionStore) : " in front, or the Java stack trace after the first line -- which is all an
 * add refusal carries now that the engine reads a store's address there and then ("Provided legacy store url is not
 * valid", "HTTP error 404"). Reintroduce the prefix strip alone: "a refused add says why in the engine's words" in
 * extensionRepos.int.test.ts reads the stack trace.
 */
export function engineReason(e: unknown): string {
  const m = String((e as Error)?.message ?? e ?? '').replace(/^suwayomi:?\s*/i, '')
    .replace(/^Exception while fetching data \([^)]*\) : /, '').split(/\r?\n/)[0].trim();
  return (m || 'no reason given').slice(0, 300);
}

/**
 * A second URL worth trying when a repository yields nothing at all, or the engine cannot read the one typed.
 *
 * This is insurance, not a rule. Repository layouts vary, so when what was typed produced nothing, this offers one
 * more thing to try:
 *
 * - `…/index.json` → the `…/index.min.json` beside it;
 * - a bare folder (`…/repo` or `…/repo/`) → `…/repo/index.min.json`, the file Mihon itself reads.
 *
 * Both point AT index.min.json because Suwayomi (v2.3.2243 and v2.4.2366, measured) refuses a legacy (list-shaped)
 * index at any address that does not end in `/index.min.json` ("Provided legacy store url is not valid", the add's
 * own error since stores replaced the setting; before, only in the engine's log).
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
