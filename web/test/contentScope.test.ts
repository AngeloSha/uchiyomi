import test from 'node:test';
import assert from 'node:assert/strict';
import { additionVisibility, contentPrivacyOf } from '../lib/contentScope';

test('an unavailable privacy setting cannot authorize an implicit shared addition', () => {
  assert.equal(additionVisibility('alice', undefined, null), null);
  assert.equal(additionVisibility(null, { supported: true, defaultPrivate: true, privateLibraryId: null }, null), null);
  assert.throws(() => contentPrivacyOf({ supported: true }));
});

test('account switches discard the previous account’s addition choice', () => {
  const preferences = { supported: true, defaultPrivate: true, privateLibraryId: null };
  assert.equal(additionVisibility('bob', preferences, { ownerId: 'alice', visibility: 'shared' }), 'private');
  assert.equal(additionVisibility('bob', preferences, { ownerId: 'bob', visibility: 'shared' }), 'shared');
});

test('unsupported storage never advertises private creation', () => {
  assert.equal(additionVisibility('alice', { supported: false, defaultPrivate: true, privateLibraryId: null },
    { ownerId: 'alice', visibility: 'private' }), 'shared');
});
