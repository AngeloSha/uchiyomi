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

test('repository urls keep their meaning and only lose stray whitespace', async () => {
  const { normalizeRepoUrl } = await load();
  const u = 'https://example.org/repo/index.min.json';
  // the server resolves the real index itself, so the URL must be passed through unchanged
  assert.equal(normalizeRepoUrl(`  ${u}  `), u);
  assert.equal(normalizeRepoUrl('https://example.org/re po/index.json'), 'https://example.org/repo/index.json');
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

test('a repository that yields nothing gets one alternative url to try', async () => {
  const { altRepoUrl } = await load();
  // insurance for varying repository layouts; the caller only keeps it if it actually returns more
  assert.equal(altRepoUrl('https://example.org/repo/index.min.json'), 'https://example.org/repo/index.json');
  assert.equal(altRepoUrl('https://example.org/repo/'), 'https://example.org/repo/index.json');
  assert.equal(altRepoUrl('https://example.org/repo'), 'https://example.org/repo/index.json');
});

test('a url that is already a full index has no alternative to try', async () => {
  const { altRepoUrl } = await load();
  // returning a "better" URL here would send a second pointless request on every add
  assert.equal(altRepoUrl('https://example.org/repo/index.json'), null);
  assert.equal(altRepoUrl('https://example.org/repo/index.pb'), null);
});
