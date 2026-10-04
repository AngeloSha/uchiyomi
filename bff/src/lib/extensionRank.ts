// Which extension Fix everything tries first (v0.55.1), for the series no source carries and the gaps nobody had.
//
// v0.55.0 tried at most three a run, and when no translation group named one, the first three in the catalogue by name:
// the owner's first run installed en.akaicomic, all.akuma and en.alandal, found nothing, and spent two minutes on it.
// The owner: "searching other extensions unlimited and not 3 in the fix everything so it eventually find one with the
// series also … make sure it tries popular extensions first". So the order is what the library itself says, then what
// people use, then what is kept up:
//   1. a translation group of the series is the extension's name (lib/autofix.ts counts the series that name it);
//   2. how often the extension is downloaded: its release files -- the apk and the jar the repository's index points
//      at, which Keiyoushi's index puts on GitHub Releases -- per day since their release was published, over at most
//      a week (v0.55.3, MAX_DAYS), read at most once a day (lib/githubRelease.ts releaseAssets), the last answer kept
//      while GitHub cannot be reached;
//   3. the rest: the most updated first (versionCode), then by name.
// An 18+ package comes after every other of its rank, and is tried only for a series rated 18+ (lib/autofix.ts).
// No site is named here: the counts are the repository's own.
// The order only: every package is still tried, the least downloaded last (v0.55.3, the owner's choice). A floor was
// weighed and not built: an extension for every language -- xkcd, League of Legends, Cubari -- is downloaded by the
// readers of every language, and no number of downloads a day skips those without skipping sites people read through.
import { releaseAssets, type ReleaseAsset } from './githubRelease';

/** What ranks a package: its own facts (lib/sources/suwayomi/extensions.ts) and how many targets' groups name it. */
export interface Ranked {
  pkgName: string;
  name: string;
  nsfw: boolean;
  /** Targets whose translation groups name it: 0 when none does. */
  named: number;
  /** Downloads a day (downloadsPerDay); null when nothing is known. */
  perDay: number | null;
  versionCode: number | null;
}

/**
 * The repository (`owner/name`) of a GitHub release download address, or null for any other address. Only GitHub's own
 * characters for an owner and a repository: nothing else reaches the API's path.
 */
export function releaseRepo(url: string | null | undefined): string | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/releases\/download\/[^/]+\/[^/]+$/i.exec(url ?? '');
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The GitHub repository (`owner/name`) an extension repository's index is served from, or null. */
export function indexRepo(url: string | null | undefined): string | null {
  const m = /^https:\/\/(?:raw\.githubusercontent\.com|github\.com)\/([\w.-]+)\/([\w.-]+)\//i.exec(url ?? '');
  return m ? `${m[1]}/${m[2]}` : null;
}

/** What a package's files are known by: their addresses, else the apk's name and where its repository's index is. */
export interface PackageFiles {
  pkgName: string;
  apkUrl: string | null;
  jarUrl: string | null;
  apkName?: string | null;
  index?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * The most days a release's downloads are spread over (v0.55.3). A release is downloaded mostly in its first days --
 * every reader who has the extension takes the update -- and then hardly at all: Keiyoushi's releases of 2026-10-04
 * held a median of ~2,800 downloads at under six days old and ~3,700 at a month. Divided by every day since, the same
 * extension read five times less popular rebuilt a month ago than last week: Manganato's 41,167 over 29.5 days read
 * 1,395 a day, below xkcd's 10,323 over 5.6 days (1,836), and MangaDex, Mangakakalot and Weeb Central were tried
 * after webcomics rebuilt that week. Over at most a week, each reads its readership: Manganato 5,881, xkcd 1,843.
 */
const MAX_DAYS = 7;
const fileName = (url: string): string => decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));

/**
 * Each package's downloads a day: its apk's and its jar's download counts together, over the days since their release
 * was published -- at least one, so a release an hour old is not counted twenty-four times over, and at most MAX_DAYS,
 * so a release a month old is not counted thirty times under. Its files are found by
 * their addresses when the engine gives them as GitHub release files, else by the apk's name (and the jar beside it) in
 * the releases of the GitHub repository its index is served from: an engine that gives no addresses still names the
 * apk. A package found neither way, or whose repository GitHub has never told us about, is left out, and the ranking
 * falls back to its version code. Never throws.
 */
export async function downloadsPerDay(list: readonly PackageFiles[], now = Date.now()): Promise<Map<string, number>> {
  const wanted = list.map((c) => {
    const byUrl = [c.apkUrl, c.jarUrl].flatMap((u) => (u && releaseRepo(u) ? [{ repo: releaseRepo(u)!, name: fileName(u) }] : []));
    if (byUrl.length) return { pkg: c.pkgName, files: byUrl };
    const repo = indexRepo(c.index);
    const names = c.apkName ? [c.apkName, c.apkName.replace(/\.apk$/i, '.jar')] : [];
    return { pkg: c.pkgName, files: repo ? names.map((name) => ({ repo, name })) : [] };
  });
  // Every file of each repository, by its name: an address names its file last.
  const repos = new Map<string, Map<string, ReleaseAsset>>();
  for (const w of wanted) {
    for (const f of w.files) {
      if (repos.has(f.repo)) continue;
      const assets = await releaseAssets(f.repo, now).catch(() => null);
      repos.set(f.repo, new Map([...(assets ?? new Map<string, ReleaseAsset>())].map(([u, a]) => [fileName(u), a])));
    }
  }
  const out = new Map<string, number>();
  for (const w of wanted) {
    let downloads = 0;
    let published = Infinity;
    let seen = false;
    for (const f of w.files) {
      const a = repos.get(f.repo)?.get(f.name);
      if (!a) continue;
      seen = true;
      downloads += a.downloads;
      const t = a.publishedAt ? Date.parse(a.publishedAt) : NaN;
      if (Number.isFinite(t)) published = Math.min(published, t);
    }
    // Reintroduce the uncapped days (drop the Math.min): "a release a month old is counted over a week" in
    // extensionRank.test.ts reads Manganato below xkcd.
    if (seen) out.set(w.pkg, downloads / Math.min(MAX_DAYS, Math.max(1, Number.isFinite(published) ? (now - published) / DAY_MS : 1)));
  }
  return out;
}

/**
 * The order the packages are tried in (the top of the file): named by the targets' groups first, the most targets
 * first; then, in each rank, a package that is not 18+ before one that is; then the most downloaded a day, a package
 * with no count after every one with a count; then the most updated; then by name.
 * Reintroduce v0.55.0's order (named, then by name): "the order is the groups' match, then downloads a day, then the
 * version" in extensionRank.test.ts fails.
 */
export function rankPackages<T extends Ranked>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => b.named - a.named
    || Number(a.nsfw) - Number(b.nsfw)
    || (b.perDay ?? -1) - (a.perDay ?? -1)
    || (b.versionCode ?? -1) - (a.versionCode ?? -1)
    || a.name.localeCompare(b.name));
}
