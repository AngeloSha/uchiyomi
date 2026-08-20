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

/** Re-read the repositories. Slow (it downloads each repo index), so it is only ever explicit. */
export async function refreshExtensions(run: Gql = defaultGql): Promise<number> {
  const d = await run<{ fetchExtensions: { extensions: RawExtension[] } }>(
    `mutation{ fetchExtensions(input:{}){ extensions { pkgName } } }`, {}, 120000,
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
export async function sourcesOfExtension(pkgName: string, run: Gql = defaultGql): Promise<Array<{ id: string; name: string; lang: string | null }>> {
  const d = await run<{ extensions: { nodes: Array<{ pkgName: string; source?: { nodes?: Array<{ id: string; name?: string; lang?: string }> } }> } }>(
    `{ extensions { nodes { pkgName source { nodes { id name lang } } } } }`, {}, 30000,
  );
  const hit = (d?.extensions?.nodes || []).find((e) => e.pkgName === pkgName);
  return (hit?.source?.nodes || [])
    .filter((s) => s && s.id != null)
    .map((s) => ({ id: String(s.id), name: s.name || pkgName, lang: s.lang ?? null }));
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

/** Trim whitespace a paste can carry. Nothing semantic — see altRepoUrl for that. */
export function normalizeRepoUrl(raw: string): string {
  return raw.trim().replace(/\s+/g, '');
}

/**
 * A second URL worth trying when a repository yields nothing at all.
 *
 * This is insurance, not a rule. The usual cause of an empty result is timing, not the URL: the server
 * applies a settings change asynchronously, so a repository read immediately after being added comes back
 * empty and needs a retry (the caller does that first). But repository layouts do vary -- some serve their
 * catalogue only at a full index path, and a bare directory URL is a reasonable thing for someone to paste --
 * so when retries have genuinely produced nothing, this offers one more thing to try.
 *
 * The caller must verify: try what the user typed, and keep this alternative ONLY if it produced more.
 * Rewriting a URL blindly would break repositories where the original form is the correct one.
 */
export function altRepoUrl(raw: string): string | null {
  const u = raw.trim().replace(/\s+/g, '');
  if (/\/index\.min\.json$/i.test(u)) return u.replace(/\/index\.min\.json$/i, '/index.json');
  if (/\/$/.test(u)) return `${u}index.json`;
  if (!/\.(json|pb)$/i.test(u)) return `${u}/index.json`;
  return null;
}
