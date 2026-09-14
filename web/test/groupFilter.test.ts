// The group filter on the chapter list, tested away from React.
//
// A chapter on disk names its group as one string, a ghost as a list, and a joint release names two groups
// in one string. Which rows a chosen group keeps is the rule here; getting it wrong hides the joint chapter
// from both of its groups' filters, which reads as "chapter missing" rather than as a filter bug.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_GROUPS, copySourceId, groupsOfRow, matchesGroup } from '../lib/groupFilter';

test('a book from a joint release matches each of its groups', () => {
  // Reintroduce by comparing `normGroup(row.scanlator) === normGroup(group)` on the whole string: the
  // "Asura & Reaper" chapter matches neither "Asura" nor "Reaper", only a group nobody can pick.
  for (const joint of ['Asura & Reaper', 'Asura / Reaper', 'Asura, Reaper']) {
    assert.equal(matchesGroup({ scanlator: joint }, 'Reaper'), true, `${JSON.stringify(joint)} does not match Reaper`);
    assert.equal(matchesGroup({ scanlator: joint }, 'Asura'), true, `${JSON.stringify(joint)} does not match Asura`);
  }
  assert.equal(matchesGroup({ scanlator: 'Asura & Reaper' }, 'Flame'), false);
});

test('a ghost matches by its groups list, which beats the display string', () => {
  // Reintroduce by reading `scanlator` before `groups` in groupsOfRow: a ghost whose chosen copy is Asura's
  // but which Reaper also released disappears from the Reaper filter, and the reader concludes Reaper
  // never did that chapter.
  const ghost = { scanlator: 'Asura', groups: ['Asura', 'Reaper'] };
  assert.equal(matchesGroup(ghost, 'Reaper'), true, 'groups beats scanlator');
  assert.deepEqual(groupsOfRow(ghost), ['Asura', 'Reaper']);
  // An empty list says nothing, so the display string stands in.
  assert.deepEqual(groupsOfRow({ scanlator: 'Asura', groups: [] }), ['Asura']);
});

test('"all" matches everything, including a row with no group', () => {
  assert.equal(matchesGroup({ scanlator: null }, ALL_GROUPS), true);
  assert.equal(matchesGroup({ scanlator: 'Asura' }, ALL_GROUPS), true);
  assert.equal(matchesGroup({ groups: [] }, ALL_GROUPS), true);
  // and a real group does not match a row that names none
  assert.equal(matchesGroup({ scanlator: null }, 'Asura'), false);
});

test('group equality is the server\'s, not string equality', () => {
  assert.equal(matchesGroup({ scanlator: 'Asura Scans' }, 'asura-scans'), true);
  assert.equal(matchesGroup({ groups: ['Ａsura'] }, 'asura'), true, 'full-width letters fold');
  assert.deepEqual(groupsOfRow({ scanlator: 'Asura & asura & Ａsura' }), ['Asura'], 'not deduped by the server equality');
});

test('a source id keeps the colons inside it', () => {
  // Reintroduce by returning `copy.key.split(':')[1]`: an extension copy keyed `ext:fake:12345` is sent to
  // the fetch route as sourceId "fake", which matches no stored copy and comes back `not_listed`.
  assert.equal(copySourceId({ key: 'ext:fake:12345', source: 'ext:fake' }), '12345', 'a source id keeps the colons inside it');
  assert.equal(copySourceId({ key: 'mangadex:https://x/y:z', source: 'mangadex' }), 'https://x/y:z');
  assert.equal(copySourceId({ key: 'odd', source: 'mangadex' }), 'odd', 'a key without its source prefix is returned whole');
});
