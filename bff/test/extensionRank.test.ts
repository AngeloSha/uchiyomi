// Which extension Fix everything tries first (lib/extensionRank.ts, v0.55.1), pure but for GitHub, which is stubbed.
//
// v0.55.0 tried three a run and, when no translation group named one, the first three by name: the owner's first run
// installed en.akaicomic, all.akuma and en.alandal and found nothing. The owner asked for no cap and the popular first.
// These pin the order -- the series' groups, then downloads a day from the repository's GitHub releases, then the
// version code, then the name, an 18+ package after the others of its rank -- and what the counts are when GitHub
// answers, when it fails after answering once (the last answer), and when it never has (nothing: the version decides).
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';

const realFetch = globalThis.fetch;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const REPO = 'keiyoushi/extensions';
const url = (file: string, tag = '8ef06cd-0') => `https://github.com/${REPO}/releases/download/${tag}/${file}`;

/** GitHub's releases list, as GET /repos/{owner}/{repo}/releases answers it: each release with its assets. */
const releases = () => [
  {
    published_at: new Date(NOW - 2 * DAY).toISOString(),
    assets: [
      { browser_download_url: url('tachiyomi-all.webtoons-v1.4.1.apk'), download_count: 60_000 },
      { browser_download_url: url('tachiyomi-all.webtoons-v1.4.1.jar'), download_count: 9_518 },
      { browser_download_url: url('tachiyomi-en.mangahere-v1.4.2.apk'), download_count: 21_174 },
    ],
  },
  {
    // An hour old: counted over one day, never 24 times over.
    published_at: new Date(NOW - 60 * 60 * 1000).toISOString(),
    assets: [{ browser_download_url: url('tachiyomi-en.comix-v1.0.0.apk', 'aa11bb2-0'), download_count: 9_073 }],
  },
];

let calls = 0;
let answer: 'ok' | 'fail' = 'ok';
function stubGitHub() {
  globalThis.fetch = (async (u: any) => {
    calls++;
    assert.equal(String(u), `https://api.github.com/repos/${REPO}/releases?per_page=100`, 'the releases list, one page');
    if (answer === 'fail') throw new Error('getaddrinfo ENOTFOUND api.github.com');
    return new Response(JSON.stringify(releases()), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
afterEach(async () => {
  globalThis.fetch = realFetch;
  (await import('../src/lib/githubRelease')).resetReleaseCache();
  calls = 0;
  answer = 'ok';
});

const pkgs = [
  { pkgName: 'all.webtoons', apkUrl: url('tachiyomi-all.webtoons-v1.4.1.apk'), jarUrl: url('tachiyomi-all.webtoons-v1.4.1.jar') },
  { pkgName: 'en.mangahere', apkUrl: url('tachiyomi-en.mangahere-v1.4.2.apk'), jarUrl: null },
  { pkgName: 'en.comix', apkUrl: url('tachiyomi-en.comix-v1.0.0.apk', 'aa11bb2-0'), jarUrl: null },
  // Not a GitHub release file: nothing to count, the version decides for it.
  { pkgName: 'en.elsewhere', apkUrl: 'https://repo.example/apk/tachiyomi-en.elsewhere-v1.apk', jarUrl: null },
  // An engine that gives no address still names the apk, and the index says which repository it is in.
  { pkgName: 'en.named', apkUrl: null, jarUrl: null, apkName: 'tachiyomi-en.mangahere-v1.4.2.apk',
    index: `https://raw.githubusercontent.com/${REPO}/repo/index.min.json` },
];

test('downloads a day: the apk and the jar together, over the days since their release, from one request a day', async () => {
  // Reintroduce by counting the apk alone: webtoons reads 30000. By dividing by an hour-old release's fraction of a day:
  // comix reads 217752.
  const { downloadsPerDay, releaseRepo } = await import('../src/lib/extensionRank');
  assert.equal(releaseRepo(pkgs[0].apkUrl), REPO);
  assert.equal(releaseRepo(pkgs[3].apkUrl), null, 'only a GitHub release file names a repository');
  stubGitHub();
  const per = await downloadsPerDay(pkgs, NOW);
  assert.equal(per.get('all.webtoons'), (60_000 + 9_518) / 2, 'the apk and the jar, over two days');
  assert.equal(per.get('en.mangahere'), 21_174 / 2);
  assert.equal(per.get('en.comix'), 9_073, 'a release an hour old counts as one day');
  assert.equal(per.has('en.elsewhere'), false, 'nothing known: left to the version');
  // Reintroduce by matching addresses alone: an engine that gives none counts nothing.
  assert.equal(per.get('en.named'), 21_174 / 2, 'found by its apk\'s name in the releases of its index\'s repository');
  await downloadsPerDay(pkgs, NOW + 60_000);
  assert.equal(calls, 1, 'asked at most once a day');
});

test('GitHub failing: the last answer stands; never answered: nothing, and the version decides', async () => {
  // Reintroduce by forgetting the last answer on a failure (releaseAssets keeping `null`): the second read is empty.
  const { downloadsPerDay } = await import('../src/lib/extensionRank');
  stubGitHub();
  await downloadsPerDay(pkgs, NOW);
  answer = 'fail';
  const later = await downloadsPerDay(pkgs, NOW + 2 * DAY);
  assert.equal(calls, 2, 'PREMISE: a day later it asked again, and GitHub failed');
  assert.equal(later.get('en.mangahere'), 21_174 / 4, 'the cached counts, over the days since their release');
  const { resetReleaseCache } = await import('../src/lib/githubRelease');
  resetReleaseCache();
  assert.equal((await downloadsPerDay(pkgs, NOW)).size, 0, 'never answered: no counts at all');
});

test('the order is the groups\' match, then downloads a day, then the version, then the name; 18+ last in its rank', async () => {
  // Reintroduce v0.55.0's order (named, then by name): Akai Comic, the alphabetical first, is tried before the popular.
  const { rankPackages } = await import('../src/lib/extensionRank');
  const p = (name: string, o: { named?: number; nsfw?: boolean; perDay?: number | null; versionCode?: number | null } = {}) =>
    ({ pkgName: name, name, named: o.named ?? 0, nsfw: !!o.nsfw, perDay: o.perDay ?? null, versionCode: o.versionCode ?? null });
  const order = rankPackages([
    p('Akai Comic', { versionCode: 3 }),
    p('Alandal', { versionCode: 9 }),
    p('Webtoons', { perDay: 34_759 }),
    p('Rose Velvet', { nsfw: true, perDay: 90_000 }),
    p('Comix', { perDay: 9_073, versionCode: 1 }),
    p('Group Scans', { named: 1, versionCode: 1 }),
    p('Adult Group', { named: 1, nsfw: true, perDay: 50_000 }),
    p('Two Groups', { named: 2 }),
    p('Akuma', { versionCode: 9 }),
  ]).map((x) => x.name);
  assert.deepEqual(order, [
    'Two Groups', 'Group Scans', 'Adult Group', // named by the series' groups, the most first; 18+ after the others
    'Webtoons', 'Comix', // the most downloaded a day
    'Akuma', 'Alandal', 'Akai Comic', // no count: the most updated, then the name
    'Rose Velvet', // 18+: after every other of its rank, however popular
  ]);
});
