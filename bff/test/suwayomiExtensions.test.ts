// The extension catalogue: browsing, installing, and the repositories it comes from.
//
// The GraphQL client is injected, so nothing here touches the network. Shapes are the ones a live
// Suwayomi-Server v2.3.2243 actually returns.
//
// The assertions that matter are the mapping ones. An extension row that comes back half-formed must not
// become a clickable "Add" button for something that cannot be installed, and an empty answer must stay
// empty rather than turning into a list of ghosts.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUWAYOMI_URL ||= 'http://suwayomi.test:4567';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.DATABASE_URL ||= 'postgres://unused/unused';

const load = () => import('../src/lib/sources/suwayomi/extensions');
const answer = (payload: unknown, seen: string[] = []) =>
  (async (query: string, variables: Record<string, unknown> = {}) => {
    seen.push(`${/mutation/.test(query) ? 'mutation' : 'query'}:${JSON.stringify(variables)}`);
    return payload;
  }) as never;

const EXT = {
  pkgName: 'eu.kanade.tachiyomi.extension.all.mangaup',
  name: 'Manga UP!', lang: 'en', versionName: '1.4.8',
  iconUrl: '/api/v1/extension/icon/eu.kanade.tachiyomi.extension.all.mangaup',
  isInstalled: true, hasUpdate: false, isObsolete: false, isNsfw: false,
  repo: 'https://example.org/repo/',
};

test('an extension row maps to what the catalogue shows', async () => {
  const { listExtensions } = await load();
  const [e] = await listExtensions(answer({ extensions: { nodes: [EXT] } }));
  assert.equal(e.pkgName, EXT.pkgName);
  assert.equal(e.name, 'Manga UP!');
  assert.equal(e.lang, 'en');
  assert.equal(e.versionName, '1.4.8');
  assert.equal(e.installed, true);
  assert.equal(e.hasUpdate, false);
  assert.equal(e.nsfw, false);
});

test('a nameless extension falls back to its package name rather than rendering blank', async () => {
  const { listExtensions } = await load();
  const [e] = await listExtensions(answer({ extensions: { nodes: [{ pkgName: 'a.b.c' }] } }));
  assert.equal(e.name, 'a.b.c');
  assert.equal(e.installed, false);
  assert.equal(e.lang, null);
});

test('rows with no package name are dropped — they could not be installed anyway', async () => {
  const { listExtensions } = await load();
  const out = await listExtensions(answer({ extensions: { nodes: [{ name: 'ghost' }, null, EXT] } }));
  assert.deepEqual(out.map((e) => e.pkgName), [EXT.pkgName]);
});

test('an empty or shapeless answer produces an empty catalogue', async () => {
  const { listExtensions } = await load();
  for (const payload of [{}, { extensions: {} }, { extensions: { nodes: null } }, { extensions: { nodes: [] } }]) {
    assert.deepEqual(await listExtensions(answer(payload)), []);
  }
});

test('install, update and uninstall each send the right patch', async () => {
  const { setExtensionState } = await load();
  for (const action of ['install', 'uninstall', 'update'] as const) {
    let sent = '';
    const run = (async (query: string, variables: Record<string, unknown>) => {
      sent = query;
      assert.equal(variables.id, 'pkg.name');
      return { updateExtension: { extension: { pkgName: 'pkg.name' } } };
    }) as never;
    assert.equal(await setExtensionState('pkg.name', action, run), true);
    assert.match(sent, new RegExp(`${action}:true`), `${action} did not send its own patch`);
  }
});

test('a refused install reports failure rather than pretending', async () => {
  const { setExtensionState } = await load();
  assert.equal(await setExtensionState('x', 'install', answer({ updateExtension: { extension: null } })), false);
});

test('the sources an extension provides are found by package name', async () => {
  const { sourcesOfExtension } = await load();
  const payload = { extensions: { nodes: [
    { pkgName: 'other.ext', source: { nodes: [{ id: '111', name: 'Other', lang: 'fr' }] } },
    { pkgName: 'mine', source: { nodes: [{ id: '222', name: 'Mine EN', lang: 'en' }, { id: '333', name: 'Mine JA', lang: 'ja' }] } },
  ] } };
  // an extension commonly carries one source per language, and enabling it must catch all of them
  assert.deepEqual((await sourcesOfExtension('mine', answer(payload))).map((s) => s.id), ['222', '333']);
  assert.deepEqual(await sourcesOfExtension('missing', answer(payload)), []);
});

test('an extension that provides no sources yields none, not a crash', async () => {
  const { sourcesOfExtension } = await load();
  assert.deepEqual(await sourcesOfExtension('mine', answer({ extensions: { nodes: [{ pkgName: 'mine' }] } })), []);
  assert.deepEqual(await sourcesOfExtension('mine', answer({})), []);
});

test('reading and writing repositories round-trips', async () => {
  const { getRepos, setRepos } = await load();
  assert.deepEqual(await getRepos(answer({ settings: { extensionRepos: ['https://example.org/a.json'] } })), ['https://example.org/a.json']);
  assert.deepEqual(await getRepos(answer({ settings: { extensionRepos: null } })), []);
  assert.deepEqual(await getRepos(answer({})), []);
  const seen: string[] = [];
  await setRepos(['https://example.org/b.json'], answer({ setSettings: { settings: { extensionRepos: ['https://example.org/b.json'] } } }, seen));
  assert.ok(seen[0].includes('example.org/b.json'), seen[0]);
});

test('refreshing the repositories passes its timeout through to the transport', async () => {
  // The scheduled extension check needs a longer budget than an admin pressing Refresh: it downloads every
  // configured repository index, and the default 120s was chosen for one person waiting on one button.
  // A parameter that is accepted and then ignored looks exactly like one that works, right up until a slow
  // repository makes the scheduled check time out and report the engine as broken.
  //
  // Reintroduce by dropping the timeoutMs parameter, or by not forwarding it to run(): the recorded
  // timeout falls back to 120000 and the assertion below fails.
  const { refreshExtensions } = await load();
  const timeouts: (number | undefined)[] = [];
  const rec = (async (_q: string, _v: Record<string, unknown> = {}, timeoutMs?: number) => {
    timeouts.push(timeoutMs);
    return { fetchExtensions: { extensions: [{ pkgName: 'a.b.c' }] } };
  }) as never;

  assert.equal(await refreshExtensions(rec), 1);
  assert.equal(timeouts[0], 120000, 'the default budget changed without this test being updated');

  await refreshExtensions(rec, 300000);
  assert.equal(timeouts[1], 300000, 'refreshExtensions ignored the timeout it was given');
});

test('a repository that yields nothing gets one alternative url to try, always the index.min.json', async () => {
  const { altRepoUrl } = await load();
  // Suwayomi v2.3.2243 refuses a list-shaped index at any address not ending in /index.min.json ("Provided
  // legacy store url is not valid"), so the only alternative that can ever work is that file.
  // Reintroduce by mapping index.json to nothing (or index.min.json to index.json) again: the first assertion
  // fails -- a pasted index.json of a working repository was refused with a 422.
  assert.equal(altRepoUrl('https://example.org/repo/index.json'), 'https://example.org/repo/index.min.json');
  // A folder gets the file Mihon reads. Reintroduce by returning `${u}index.json` for a folder again:
  // both assertions below fail.
  assert.equal(altRepoUrl('https://example.org/repo/'), 'https://example.org/repo/index.min.json');
  assert.equal(altRepoUrl('https://example.org/repo'), 'https://example.org/repo/index.min.json');
  // a query (a token some hosts need) stays at the end, not in the middle of the file name
  assert.equal(altRepoUrl('https://example.org/repo/index.json?t=1'), 'https://example.org/repo/index.min.json?t=1');
});

test('an index.min.json, or any other index file, has no alternative to try', async () => {
  const { altRepoUrl } = await load();
  // Reintroduce by returning `…/index.json` for an index.min.json again: this fails, and on the real engine
  // every refused add spent ~2 s and two more engine writes on an address it could never accept.
  assert.equal(altRepoUrl('https://example.org/repo/index.min.json'), null);
  assert.equal(altRepoUrl('https://example.org/repo/index.min.json?t=1'), null);
  assert.equal(altRepoUrl('https://example.org/repo/repo.json'), null);
  assert.equal(altRepoUrl('https://example.org/repo/index.pb'), null);
});

// ---- v0.45.0: what a paste becomes ------------------------------------------------------------------------

test('an add-repo link is unwrapped to the address inside it, whatever the app', async () => {
  // Reintroduce by deleting the addRepoTarget() call in parseRepoInput: the deep links come back as
  // `bad_url` (not http) and the web link as itself, and every assertion here fails.
  const { parseRepoInput } = await load();
  const inner = 'https://example.org/repo/index.min.json';
  for (const raw of [
    `mihon://add-repo?url=${encodeURIComponent(inner)}`,
    `tachiyomi://add-repo?url=${inner}`,
    `  tachiyomi://add-repo?url=${encodeURIComponent(inner)}  `,
    `https://example.net/add-repo?url=${encodeURIComponent(inner)}`,
  ]) {
    const r = parseRepoInput(raw);
    assert.ok(r.ok, `${raw} was refused`);
    assert.equal(r.url, inner, raw);
    assert.equal(r.unwrapped, true, raw);
  }
  // no url= inside: not a repository address at all
  assert.deepEqual(parseRepoInput('mihon://add-repo').ok, false);
});

test('a missing scheme is added, and only http(s) is accepted', async () => {
  // Reintroduce by dropping the `https://` prefixing: "example.org/…" is refused as bad_url and the first
  // assertion fails.
  const { parseRepoInput } = await load();
  const r = parseRepoInput('example.org/repo/index.min.json');
  assert.ok(r.ok);
  assert.equal(r.url, 'https://example.org/repo/index.min.json');
  assert.equal(r.schemeAdded, true);
  assert.equal((parseRepoInput('http://192.168.1.10:8080/repo/index.min.json') as any).url, 'http://192.168.1.10:8080/repo/index.min.json');
  // a LAN host with no dot is fine when the scheme or a port says it is a server; a bare word is not
  assert.ok(parseRepoInput('http://nas/repo/index.min.json').ok);
  assert.ok(parseRepoInput('nas:8080/repo/index.min.json').ok);
  for (const raw of ['', '   ', 'myrepo', 'ftp://example.org/index.min.json', 'javascript:alert(1)', 'file:///etc/passwd']) {
    const x = parseRepoInput(raw);
    assert.equal(x.ok, false, `${JSON.stringify(raw)} was accepted`);
    assert.equal((x as any).error, 'bad_url');
  }
  // quotes and angle brackets from a chat or a README go; the fragment goes; the path keeps its case
  assert.equal((parseRepoInput('<https://Example.org/Repo/index.min.json#top>') as any).url, 'https://example.org/Repo/index.min.json');
  assert.equal((parseRepoInput('"https://example.org/repo/index.min.json"') as any).url, 'https://example.org/repo/index.min.json');
});

test('a GitHub repository page is refused with advice, never guessed into a branch', async () => {
  // Reintroduce by removing the github_page branch in parseRepoInput: the page URLs come back ok and the
  // `github_page` assertions fail.
  const { parseRepoInput, REPO_MESSAGES } = await load();
  for (const raw of ['https://github.com/owner/name', 'github.com/owner/name', 'https://www.github.com/owner/name/tree/repo', 'https://github.com/owner/name/blob/main/README.md']) {
    const r = parseRepoInput(raw);
    assert.equal(r.ok, false, raw);
    assert.equal((r as any).error, 'github_page', raw);
    assert.match((r as any).message, /index\.min\.json/, 'the refusal says what to paste instead');
  }
  assert.equal(REPO_MESSAGES.github_page, (parseRepoInput('https://github.com/o/n') as any).message);
  // a link to one FILE names its branch, so it becomes that file's raw address
  assert.equal((parseRepoInput('https://github.com/owner/name/blob/repo/index.min.json') as any).url,
    'https://raw.githubusercontent.com/owner/name/repo/index.min.json');
  assert.equal((parseRepoInput('https://github.com/owner/name/raw/some/branch/index.min.json') as any).url,
    'https://raw.githubusercontent.com/owner/name/some/branch/index.min.json');
  // a release download is a file, and is kept as it is
  assert.equal((parseRepoInput('https://github.com/owner/name/releases/download/v1/index.min.json') as any).url,
    'https://github.com/owner/name/releases/download/v1/index.min.json');
});

test('a control character inside a paste is refused, never deleted into another address; GitHub links obey the length limit', async () => {
  // Reintroduce by deleting the two `control.test(s)` lines in parseRepoInput: the CR/LF is squeezed out and
  // `…/repoX-Injected:1/index.min.json` -- an address nobody typed -- comes back ok.
  const { parseRepoInput } = await load();
  for (const raw of [
    'https://example.org/repo\r\nX-Injected: 1/index.min.json',
    'https://example.org/re\tpo/index.min.json',
    'https://example.org/repo\u0000/index.min.json',
    `mihon://add-repo?url=${encodeURIComponent('https://example.org/repo\r\nX-Injected: 1/index.min.json')}`,
    'mihon://add-repo?url=https://example.org/repo\r\nX/index.min.json',
  ]) {
    const r = parseRepoInput(raw);
    assert.equal(r.ok, false, `${JSON.stringify(raw)} was accepted as ${(r as any).url}`);
    assert.equal((r as any).error, 'bad_url');
  }
  // what a paste carries at its ENDS is still trimmed away, and a space inside is still squeezed out
  assert.equal((parseRepoInput('\r\n  https://example.org/repo/index.min.json \n') as any).url, 'https://example.org/repo/index.min.json');
  assert.equal((parseRepoInput('https://example.org/repo/ index.min.json') as any).url, 'https://example.org/repo/index.min.json');
  // Reintroduce by returning the raw.githubusercontent.com address before the MAX_REPO_URL check: 1,948
  // characters were accepted (and stored in the engine's settings, and shown in the panel).
  const long = parseRepoInput(`https://github.com/o/r/blob/main/${'a'.repeat(1900)}.json`);
  assert.equal(long.ok, false, 'a 1,948-character raw address was accepted');
  assert.equal((long as any).error, 'bad_url');
  assert.ok(parseRepoInput(`https://github.com/o/r/blob/main/${'a'.repeat(400)}.json`).ok, 'under the limit is fine');
});

test('one repository, however it is spelled, has one key', async () => {
  // Reintroduce by dropping the index-file stripping from repoKey: the engine's repo.json / index.pb
  // spelling no longer matches the index.min.json that was pasted, and the first group fails.
  const { repoKey } = await load();
  const k = repoKey('https://example.org/repo/index.min.json');
  for (const u of [
    'https://example.org/repo/repo.json', 'https://example.org/repo/index.pb', 'https://example.org/repo/index.json',
    'HTTPS://Example.org/Repo/', 'http://example.org/repo', 'https://example.org/repo//', 'https://example.org/repo/index.min.json#x',
  ]) assert.equal(repoKey(u), k, u);
  assert.notEqual(repoKey('https://example.org/other/index.min.json'), k);
  assert.notEqual(repoKey('https://example.org/repo/index.min.json?t=2'), k, 'a query is part of the address');
});

test('a repository is credited only with the extensions it brought', async () => {
  // Reintroduce by returning `all.length` (the catalogue's size) from contributedBy: the broken-second-repo
  // assertion reads 3 instead of 0 -- the "Added — 1396 extensions" bug.
  const { contributedBy } = await load();
  const ext = (pkgName: string, repo: string | null) => ({
    pkgName, name: pkgName, lang: 'en', versionName: '1', iconUrl: null, installed: false, hasUpdate: false, obsolete: false, nsfw: false, repo,
  });
  const A = 'https://example.org/a/index.min.json';
  const before = [ext('a1', 'https://example.org/a/repo.json'), ext('a2', 'https://example.org/a/repo.json'), ext('old', 'https://example.org/gone/repo.json')];
  // nothing new: a broken second repository
  assert.equal(contributedBy(before, before, [A]), 0);
  // the new one arrived under the engine's own spelling of its address
  const after = [...before, ext('b1', 'https://example.net/b/index.pb'), ext('b2', 'https://example.net/b/index.pb')];
  assert.equal(contributedBy(after, before, [A]), 2);
  // an extension that moved to the new repository (a newer version there) counts; one still under A does not
  const moved = [ext('a1', 'https://example.net/b/index.pb'), before[1], before[2]];
  assert.equal(contributedBy(moved, before, [A]), 1);
  // an engine with no per-extension repository is judged by the catalogue growing, never by its size
  const bare = (xs: ReturnType<typeof ext>[]) => xs.map((e) => ({ ...e, repo: null }));
  assert.equal(contributedBy(bare(before), bare(before), [A]), 0);
  assert.equal(contributedBy(bare(after), bare(before), [A]), 2);
});

test('a repository removed and added back is credited with the installed extensions it re-attaches', async () => {
  // Measured on Suwayomi v2.3.2243: remove a repository and its installed extension stays listed, installed,
  // isObsolete true, under the old address; add the repository back and the same row turns isObsolete false.
  // Reintroduce by letting obsolete rows into `seen` again (`before.filter((e) => e.repo)`): the re-add counts 0,
  // the route takes the repository back out with a 422, and the extension never gets another update.
  const { contributedBy } = await load();
  const row = (obsolete: boolean) => ({
    pkgName: 'x', name: 'x', lang: 'en', versionName: '1', iconUrl: null, installed: true, hasUpdate: false, obsolete, nsfw: false,
    repo: 'https://example.org/a/repo.json',
  });
  assert.equal(contributedBy([row(false)], [row(true)], []), 1, 'the re-added repository brought its installed extension back');
  // ...and an orphan that STAYS obsolete is never credited to whatever else is added (a broken address).
  // Reintroduce by dropping `e.obsolete` from the count: this reads 1.
  assert.equal(contributedBy([row(true)], [row(true)], []), 0, 'an orphan was credited to a broken repository');
});

test('the engine\'s reason loses our transport prefix and nothing else', async () => {
  const { engineReason } = await load();
  assert.equal(engineReason(new Error('suwayomi: Validation errors: bad url')), 'Validation errors: bad url');
  assert.equal(engineReason(new Error('suwayomi 500')), '500');
  assert.equal(engineReason(new Error('')), 'no reason given');
  assert.equal(engineReason('x'.repeat(400)).length, 300);
});
