// Commands the docs tell people to run, held to the shape that works.
//
// The extension engine's data lives in a Compose volume, and Compose puts the project's name in front of every
// volume a file declares: deploy/docker-compose.yml's `uchiyomi_suwayomi` is `<project>_uchiyomi_suwayomi` on disk
// (`uchiyomi_uchiyomi_suwayomi` in a folder called uchiyomi). A recipe that mounts the bare name -- `docker run --rm
// -v uchiyomi_suwayomi:/d ... tar czf ...` -- does not fail: Docker creates a new, EMPTY volume of that name without
// a word, and the backup is an archive of nothing that restores nothing. docs/extensions.md shipped exactly that
// until the s11 review. The docs now borrow the stopped container's own mount (`--volumes-from uchiyomi-suwayomi`),
// or name the volume with its project. The web's setup steps are held the same way by web/test/engineSetup.test.ts;
// their `docker run` for an engine outside Compose names a volume of its own, which is right there.
//
// Reintroduce by putting the old recipe back in docs/extensions.md (`docker run --rm -v uchiyomi_suwayomi:/d -v
// "$PWD":/b alpine tar czf /b/engine.tgz -C /d .`): the first test names the file and the line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '..', '..');
/** Every page a self-hoster reads: docs/*.md and the README. */
const PAGES = [...readdirSync(join(REPO, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`), 'README.md'];
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');

test("no doc mounts the engine's Compose volume by its bare name, which Docker would create empty", () => {
  // `-v uchiyomi_suwayomi:`, `--volume uchiyomi_suwayomi:` or `--volume=...`, quoted or not; `<project>_uchiyomi_suwayomi`
  // is the right name and does not match.
  const bare = /(?:^|\s)(?:-v|--volume)(?:\s+|=)["']?uchiyomi_suwayomi:/;
  const found = PAGES.flatMap((p) => read(p).split('\n').flatMap((line, i) => (bare.test(line) ? [`${p}:${i + 1}: ${line.trim()}`] : [])));
  assert.deepEqual(found, [], "a doc mounts `uchiyomi_suwayomi` bare. Under Compose the volume is `<project>_uchiyomi_suwayomi`, and Docker "
    + 'creates the bare name empty, so the command backs up (or restores into) nothing. Borrow the container\'s mount with '
    + '`--volumes-from uchiyomi-suwayomi`, or name the volume with its project (docs/extensions.md#your-engines-data)');
});

test("the engine's data section still gives the recipe that works", () => {
  // The rule above passes on a page with no recipe at all: this is the half that says the recipe is still there.
  // Reintroduce by deleting the backup block from docs/extensions.md: this test reads no recipe.
  const doc = read('docs/extensions.md');
  assert.match(doc, /^## Your engine's data$/m, 'docs/extensions.md lost its "Your engine\'s data" section, which USAGE, MIGRATING and the CHANGELOG link to');
  assert.match(doc, /docker run --rm --volumes-from uchiyomi-suwayomi -v "\$PWD":\/b alpine tar czf \/b\/engine\.tgz -C \/home\/suwayomi\/\.local\/share\/Tachidesk \./,
    'docs/extensions.md no longer backs the engine up through the stopped container\'s own mount');
});
