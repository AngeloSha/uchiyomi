// The supply line under a series' title, every state, away from React.
//
// The line is the one sentence a reader gets about where the chapters come from, and each state below is
// one a person will see: a raw id instead of a source name, "0 not here yet" on a series with three hundred
// chapters waiting, a line on a series that has nothing to say. The strings are compared through the
// identity `tr`, so what is asserted is what an English reader sees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { namesGroups, supplyLine, supplyText, PHONE_NAMES_BUDGET, type SupplyInput } from '../lib/supplyLine';

const tr = (key: string, args?: Record<string, string | number>) => {
  let out = key;
  if (args) for (const [k, v] of Object.entries(args)) out = out.split(`{${k}}`).join(String(v));
  return out;
};
const text = (input: SupplyInput, wide: boolean) => supplyText(supplyLine(input, wide), tr, wide);

const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
const mangadex = { sourceId: 'mangadex', name: 'MangaDex', primary: true, registered: true };
const base: SupplyInput = {
  sources: [mangadex], groups: ['Asura Scans', 'Flame Comics', 'Junk Group'], notHere: 4, listedTotal: 7,
  booksCount: 3, checkedAt: twoHoursAgo, autoUpdate: true, groupsError: false, isAdmin: false,
};

test('an extension source with groups reads the full sentence on a desktop and the short one on a phone', () => {
  // Reintroduce by dropping the `wide` test on the groups part (always two names): the phone line reads
  // "Asura Scans, Flame Comics +1" and "phone" fails.
  assert.equal(text(base, true), 'MangaDex · Translated by Asura Scans, Flame Comics (+1) · 4 not here yet · checked 2h ago', 'desktop');
  assert.equal(text(base, false), 'MangaDex · Asura Scans +2 · 4 not here yet', 'phone');
  const phone = supplyLine(base, false)!;
  const groups = phone.find((p) => p.kind === 'groups');
  assert.deepEqual(groups, { kind: 'groups', names: ['Asura Scans'], all: ['Asura Scans', 'Flame Comics', 'Junk Group'], more: 2 }, 'the stack gets three avatars, the text one name');
  assert.equal(phone.some((p) => p.kind === 'text' && p.key === 'checked {ago}'), false, 'the phone drops the check time');
  assert.equal(phone[0].kind, 'source', 'the favicon part leads');
});

test('a long source name costs the phone its group name, never its count', () => {
  // ⚠️ Measured at 390 px with this source: the line's three texts share ≈220 px, the name alone is 155,
  // and the group name was squeezed to 0 px with "+2" clipped to a sliver beside it. Reintroduce by making
  // `shown` 1 on every phone line (drop the budget test): "phone, long source" fails with "Reaper Scans +2"
  // in the line and "the stack stays, the name goes" with `names: ['Reaper Scans']`.
  const kakalot = { ...base, sources: [{ sourceId: 'ext:mk', name: 'Mangakakalot (Manganato)', primary: true, registered: true }], groups: ['Reaper Scans', 'Flame Comics', 'Asura Scans'] };
  const phone = supplyLine(kakalot, false)!;
  assert.deepEqual(phone.find((p) => p.kind === 'groups'), { kind: 'groups', names: [], all: ['Reaper Scans', 'Flame Comics', 'Asura Scans'], more: 0 }, 'the stack stays, the name goes');
  assert.equal(phone.some((p) => p.kind === 'text' && p.key === '{n} not here yet'), true, 'the count is untouched');
  // The text form names the stack, for the reader who cannot see it (the button's aria-label).
  assert.equal(text(kakalot, false), 'Mangakakalot (Manganato) · Reaper Scans, Flame Comics, Asura Scans · 4 not here yet', 'phone, long source');
  // "+n" then counts past the STACK, not past a name nobody sees: five groups, three avatars, "+2".
  const five = { ...kakalot, groups: [...kakalot.groups, 'LHT', 'Junk Group'] };
  assert.deepEqual((supplyLine(five, false)!.find((p) => p.kind === 'groups') as { more: number }).more, 2, 'past the stack');
  assert.equal(text(five, false), 'Mangakakalot (Manganato) · Reaper Scans, Flame Comics, Asura Scans +2 · 4 not here yet');
  // The desktop has the room and keeps the sentence whatever the source is called.
  assert.equal(text(kakalot, true), 'Mangakakalot (Manganato) · Translated by Reaper Scans, Flame Comics (+1) · 4 not here yet · checked 2h ago', 'desktop, long source');
  // The budget is the two names together: a short source keeps the name (the base case above), and a
  // source that is not installed spends "not installed" from the same room.
  assert.equal('MangaDex'.length + 'Reaper Scans'.length <= PHONE_NAMES_BUDGET, true, 'the measured fit is inside the budget');
  const uninstalled = { ...base, groups: ['LHT', 'Asura Scans'], sources: [{ ...mangadex, registered: false }] };
  assert.equal(text(uninstalled, false), 'MangaDex · not installed · LHT, Asura Scans · 4 not here yet', '"not installed" costs the name too');
  const raw = { ...uninstalled, sources: [{ sourceId: '8683375824843625513', name: '8683375824843625513', primary: true, registered: false }] };
  assert.equal(text(raw, false), 'Source not installed · LHT, Asura Scans · 4 not here yet', 'so does the sentence');
});

test('an engine source with no groups has no group segment', () => {
  const aqua = { ...base, sources: [{ sourceId: 'aqua', name: 'Aqua Manga', primary: true, registered: true }], groups: [] };
  assert.equal(text(aqua, true), 'Aqua Manga · 4 not here yet · checked 2h ago');
  assert.equal(text(aqua, false), 'Aqua Manga · 4 not here yet');
});

test('a series with no source says so to an admin and nothing to a member without groups', () => {
  // Reintroduce by returning the admin parts for everyone: "a member with no source and no groups sees no
  // line" fails with "Added from disk · no source".
  const none = { ...base, sources: [], groups: [] };
  assert.equal(supplyLine(none, true), null, 'a member with no source and no groups sees no line');
  assert.equal(text({ ...none, isAdmin: true }, true), 'Added from disk · no source');
  // File stamps name a group: a member sees just that, an admin gets it between the two facts.
  const stamped = { ...none, groups: ['Asura Scans'] };
  assert.equal(text(stamped, true), 'Translated by Asura Scans');
  assert.equal(text({ ...stamped, isAdmin: true }, true), 'Added from disk · Translated by Asura Scans · no source');
});

test('a source never checked says so instead of a count', () => {
  assert.equal(text({ ...base, checkedAt: null, groups: [], notHere: 0 }, true), 'MangaDex · not checked yet');
  assert.equal(text({ ...base, checkedAt: null }, true), 'MangaDex · Translated by Asura Scans, Flame Comics (+1) · not checked yet');
});

test('auto-update off replaces the count, which is no longer maintained', () => {
  assert.equal(text({ ...base, autoUpdate: false }, true), 'MangaDex · Translated by Asura Scans, Flame Comics (+1) · auto-update off · checked 2h ago');
});

test('an uninstalled source is named when its name is known and never shown as a raw id', () => {
  // ⚠️ The server falls back to the id as the name for an adapter it no longer loads, and an extension's
  // id is nineteen digits. Reintroduce by always pushing the source part (no `name === sourceId` branch):
  // "raw id" fails with "8683375824843625513 · not installed · …". The other way round -- dropping the
  // `main.name === main.sourceId` half of the test so every uninstalled source is the sentence -- fails
  // "a known name is kept, dimmed".
  const raw = { ...base, sources: [{ sourceId: '8683375824843625513', name: '8683375824843625513', primary: true, registered: false }], groups: [] };
  assert.equal(text(raw, true), 'Source not installed · 4 not here yet · checked 2h ago', 'raw id');
  assert.equal(supplyLine(raw, true)!.some((p) => p.kind === 'source'), false, 'no favicon part for an unknown adapter');
  const named = { ...raw, sources: [{ ...raw.sources[0], name: 'Asura Scans (EN)' }] };
  assert.equal(text(named, true), 'Asura Scans (EN) · not installed · 4 not here yet · checked 2h ago', 'a known name is kept, dimmed');
  assert.equal((supplyLine(named, true)![0] as { registered: boolean }).registered, false);
});

test('a failed groups route is said to an admin and silent for a member', () => {
  const failed = { ...base, groupsError: true };
  assert.equal(text({ ...failed, isAdmin: true }, true), 'MangaDex · translations unavailable · 4 not here yet · checked 2h ago');
  assert.equal(text(failed, true), 'MangaDex · 4 not here yet · checked 2h ago');
});

test('a series with no chapters says what is listed rather than "0 not here yet"', () => {
  // A "Nothing yet" add: every listed number is below the floor, so `notHere` is 0 while 300 chapters wait.
  // Reintroduce by dropping the `booksCount === 0` branch: "nothing yet" fails with no count at all.
  const nothing = { ...base, booksCount: 0, notHere: 0, listedTotal: 8 };
  assert.equal(text(nothing, true), 'MangaDex · Translated by Asura Scans, Flame Comics (+1) · 8 chapters listed · none fetched yet · checked 2h ago', 'nothing yet');
  // ⚠️ No group segment on the phone in this one state: measured at 390 px, the sentence left the name no
  // room and "+2" painted over the count. Reintroduce by always calling groupsPart(): "phone, nothing yet"
  // fails with "Asura Scans +2" in the line.
  assert.equal(text(nothing, false), 'MangaDex · 8 chapters listed · none fetched yet', 'phone, nothing yet');
  // Not checked yet is short enough to keep the groups on the phone.
  assert.equal(text({ ...nothing, checkedAt: null }, false), 'MangaDex · Asura Scans +2 · not checked yet');
  // Up to date: no count part at all, not "0 not here yet".
  assert.equal(text({ ...base, notHere: 0 }, true), 'MangaDex · Translated by Asura Scans, Flame Comics (+1) · checked 2h ago');
});

test('the main source is the primary one, wherever it sits in the list', () => {
  const two = { ...base, groups: [], sources: [{ sourceId: 'aqua', name: 'Aqua', primary: false, registered: true }, mangadex] };
  const parts = supplyLine(two, true)!;
  assert.deepEqual(parts[0], { kind: 'source', sourceId: 'mangadex', name: 'MangaDex', registered: true });
  assert.equal(parts.filter((p) => p.kind === 'source').length, 1, 'one source part: the main one');
});

test('only MangaDex and the extensions name translation groups', () => {
  // The sheet's "This site does not name translation groups." depends on this, and saying it about a
  // MangaDex series that has not been checked yet would be wrong. Reintroduce by returning true for every
  // id: "a site by URL" fails.
  assert.equal(namesGroups('mangadex'), true);
  assert.equal(namesGroups('sw:8683375824843625513'), true);
  assert.equal(namesGroups('aqua'), false, 'a site by URL');
  assert.equal(namesGroups('ext:fake'), false);
});
