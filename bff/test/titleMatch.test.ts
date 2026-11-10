import test from 'node:test';
import assert from 'node:assert/strict';
import { normTitle, pickBestScored } from '../src/lib/titleMatch';
test('native-script identities never collapse into an empty exact or containment match',()=> {
  for(const term of ['대마도사','大魔導士','進撃の巨人','!!!']) {
    assert.equal(pickBestScored([{title:'Naruto'}],term),null);
    assert.equal(pickBestScored([{title:'別の漫画'}],term),null);
  }
  assert.equal(pickBestScored([{title:'대마도사'}],'대마도사')?.confidence,'exact');
  assert.notEqual(normTitle('だいまどうし'),normTitle('たいまとうし'),'voicing marks carry identity');
});
test('Unicode width and composed spellings normalize, while existing ASCII confidence tiers remain',()=> {
  assert.equal(pickBestScored([{title:'Solo Leveling'}],'Ｓｏｌｏ　Ｌｅｖｅｌｉｎｇ')?.confidence,'exact');
  assert.equal(normTitle('Cafe\u0301'),normTitle('Café'));
  assert.equal(pickBestScored([{title:'Naruto (Official Colored)'}],'Naruto')?.confidence,'contains');
  assert.equal(pickBestScored([{title:'World Strongest Dungeon Hunter'}],'Strongest Dungeon Hunter')?.confidence,'contains');
  assert.equal(pickBestScored([{title:'The Hidden Dungeon Only I Can Enter'}],'Unrelated Chronicle'),null);
});
