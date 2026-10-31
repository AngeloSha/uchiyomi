import test from'node:test';
import assert from'node:assert/strict';
import{projectTitleAlpha,sourceRgba}from'../src/lib/titleMaskProjection';
test('alpha projection uses global pixel centers across a fractional crop boundary',()=>{
  const result=projectTitleAlpha(new Uint8Array([255]),1,1,{left:3/12,top:2/8,width:1/12,height:1/8},12,8,18,12);
  const pixels=Array.from(result.entries()).filter(([,a])=>a).map(([n])=>[n%18,Math.floor(n/18)]);
  assert.deepEqual(pixels,[[4,3],[5,3]]); // Rounding crop-left 4.5 to 5 would lose the first source pixel.
});
test('projection rejects guessed noninteger placements and mismatched raw candidate dimensions',()=>{
  for(const region of[{left:.01,top:0,width:.1,height:.1},{left:0,top:0,width:.2,height:.1},{left:.95,top:0,width:.1,height:.1}])
    assert.throws(()=>projectTitleAlpha(new Uint8Array([255]),1,1,region,10,10,20,20));
});
test('compositing preserves every source RGB byte and accepts only alpha edits',()=>{
  const rgb=new Uint8Array([15,27,201,55,99,3]);
  assert.deepEqual(sourceRgba(rgb,new Uint8Array([0,255])),Buffer.from([15,27,201,0,55,99,3,255]));
  assert.throws(()=>sourceRgba(rgb,new Uint8Array([0])));
});
