// Admin → Settings → 18+ filter, and the per-series "Always show" beside it.
//
// Read from source, like settingsConsole.test.ts. The server half (what the lists hide, the exemption, the
// sanitiser) is bff/test/adultFilter*.test.ts; this pins the three ways the page itself went wrong or could:
// a picker that hides what it configures, a double click that loses a toggle, and an edit dialog that
// clears an exemption it never showed. Every guard names the edit that makes it fail again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const section = (): string => {
  const src = code(read('components/AdminSettings.tsx'));
  const s = src.slice(src.indexOf('function AdultFilterSection('), src.indexOf('function SwitchWithMore('));
  assert.ok(s.length > 0, 'no AdultFilterSection');
  return s;
};

test('the section comes after Notifications, so the pinned order of the others is untouched', () => {
  // Reintroduce by rendering it anywhere above <NotificationsSection />: the four-section order that
  // settingsConsole.test.ts and run.mjs rely on would shift.
  const src = code(read('components/AdminSettings.tsx'));
  const grid = src.slice(src.indexOf('<div className={SETTINGS_GRID}>\n      <ServerSection'));
  assert.ok(grid.indexOf('<NotificationsSection />') > 0, 'PREMISE: no Notifications section');
  assert.ok(grid.indexOf('<AdultFilterSection data={data} save={save} />') > grid.indexOf('<NotificationsSection />'),
    'the 18+ filter is not after Notifications');
});

test('both pickers ask with the reveal on, so ticking an entry cannot hide its own chip', () => {
  // With "Show 18+" off, a genre or source ticked here is exactly what the listings stop returning, so a
  // picker built from them loses the chip the moment it is lit and it can never be unticked. Reintroduce by
  // asking `/api/genres/overview` or `/api/sources` as they are: both matches below fail. And never an
  // unconditional `?adult=1` (lib/api.ts adds its own when the reveal is on; two copies read as hidden).
  const s = section();
  assert.match(s, /const revealed = \(path: string\) => \(adultShown\(\) \? path : `\$\{path\}\$\{path\.includes\('\?'\) \? '&' : '\?'\}adult=1`\);/,
    'the reveal-aware URL rule is gone');
  assert.match(s, /revealed\('\/api\/genres\/overview\?covers=1'\)/, 'the genre picker is built from the filtered list');
  assert.match(s, /revealed\('\/api\/sources'\)/, 'the source picker is built from the filtered list');
  assert.doesNotMatch(s, /\('\/api\/(?:sources|genres\/overview)[^']*adult=1'\)/, 'adult=1 is hard-coded');
  // Its own keys: a revealed answer under a browsing screen's key is replayed to that screen.
  assert.match(s, /queryKey: \['genres-overview', 'all'\]/);
  assert.match(s, /queryKey: \['sources', 'all'\]/);
});

test('a toggle is saved from local state, and a failed save puts the chip back', () => {
  // Toggled against `data` directly, two quick clicks each started from the list as it was before either
  // PATCH landed, and the second quietly undid the first. Reintroduce by
  // `onClick={() => save({ adultGenres: toggle(genres, g.key) })}` over `data.adult_genres`: fails.
  const s = section();
  assert.match(s, /const \[genres, setGenres\] = useState<string\[\]>/, 'the genre list is not held locally');
  assert.match(s, /const \[sources, setSources\] = useState<string\[\]>/, 'the source list is not held locally');
  assert.match(s, /onClick=\{\(\) => flip\('adultGenres', genres, setGenres, g\.key\)\}/);
  assert.match(s, /onClick=\{\(\) => flip\('adultSources', sources, setSources, src\.id\)\}/);
  assert.match(s, /\.catch\(\(\) => \{ set\(list\); toast\(tr\('Could not save'\), 'error'\); \}\);/,
    'a failed save leaves the chip lit over a list that was not stored');
});

test('the edit dialog seeds "Always show" from the override and sends it on save', () => {
  // The route leaves the flag alone when the field is absent, so a dialog that did not know about it would
  // be harmless -- but one that sent `false` without seeding it would clear every exemption on a retitle.
  // Reintroduce by `useState(false)`: "the checkbox is not seeded" fails.
  // Raw, not `code()`: this page has `/*` inside string literals, which the comment stripper would eat.
  const src = read('app/series/page.tsx');
  assert.match(src, /const \[adultExempt, setAdultExempt\] = useState\(series\.overrides\?\.adultExempt === true\);/, 'the checkbox is not seeded from the override');
  // `adultExempt` then whatever follows it (readingDirection since v0.48.0): what matters is that it is sent.
  assert.match(src, /ageRating: ageRating === '' \? null : Number\(ageRating\), adultExempt[,} ]/, 'the save does not send the flag');
  assert.match(src, /checked=\{adultExempt\} onChange=\{\(e\) => setAdultExempt\(e\.target\.checked\)\}/);
});

test('every new string is in all eight locale files', () => {
  // settingsConsole.test.ts already scans AdminSettings.tsx; the dialog's two strings live in the series
  // page, which no locale test reads. Reintroduce by deleting "Always show" from public/locales/ar.json.
  const keys = [
    '18+ filter', 'No genres yet.', 'Always show',
    'Sources to treat as adult, on top of the ones their extension already declares.',
    'One series can be let through on its own page — Edit details ▸ “Always show”.',
    'Keep this series on the shelf while “Show 18+” is off, even if one of its genres is on the 18+ filter.',
  ];
  for (const k of keys) {
    assert.ok(read('components/AdminSettings.tsx').includes(`tr('${k}')`) || read('app/series/page.tsx').includes(`tr('${k}')`),
      `"${k}" is no longer rendered -- update this list`);
  }
  const files = readdirSync(join(ROOT, 'public/locales')).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 8);
  for (const f of files) {
    const d = JSON.parse(read(`public/locales/${f}`));
    const missing = keys.filter((k) => !(k in d) || !String(d[k]).trim() || d[k] === k);
    assert.deepEqual(missing, [], `${f} lacks (or copies the English of) ${missing.join(' | ')}`);
  }
});

test('the 18+ reveal still renders on Library and Home when only the 18+ filter has something to hide', () => {
  // AdultToggle renders on its own only when the account holds an 18+ LIBRARY. With genres or sources on the
  // 18+ filter and no such library, those series were hidden with no off switch on either page -- the
  // failure `alsoWhen` exists for (see discoverAdult.test.ts). Reintroduce by dropping
  // `alsoWhen={adultFilter}` from either page: "has no second reason" fails for it; by reading the flag from
  // anything but `/api/adult-filter`: "the hook" fails.
  const hook = code(read('components/AdultToggle.tsx'));
  assert.match(hook, /export function useAdultFilterConfigured\(\): boolean \{[\s\S]*?queryKey: \['adult-filter'\][\s\S]*?api<\{ configured: boolean \}>\('\/api\/adult-filter'\)[\s\S]*?return data\?\.configured === true;/,
    'the hook no longer asks /api/adult-filter');
  for (const [file, tag] of [['app/page.tsx', '<AdultToggle className="shrink-0" alsoWhen={adultFilter} />'], ['app/library/page.tsx', '<AdultToggle alsoWhen={adultFilter} />']]) {
    const src = code(read(file));
    assert.ok(src.includes('const adultFilter = useAdultFilterConfigured();'), `${file} does not ask whether the filter is configured`);
    assert.ok(src.includes(tag), `${file}'s reveal has no second reason, so a genre-only filter has no off switch there`);
  }
  // A save that changes the lists must refresh the answer, or the switch appears (or goes) only after
  // five minutes.
  assert.match(section(), /qc\.invalidateQueries\(\{ queryKey: \['adult-filter'\] \}\)/, 'a save does not refresh the reveal');
});
