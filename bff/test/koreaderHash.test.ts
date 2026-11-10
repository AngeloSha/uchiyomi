import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('partial MD5 matches the two independent upstream KOReader golden fixtures',async()=>{
  const {partialMd5,partialBufferMd5}=await import('../src/lib/koreaderDigest');
  const vectors=JSON.parse(await readFile(join(__dirname,'fixtures/koreader-partialmd5-vectors.json'),'utf8'));
  const dir=await mkdtemp(join(tmpdir(),'kosync-golden-'));
  try{for(const v of vectors.fixtures){
    const bytes=Buffer.alloc(v.size);
    for(const s of v.samples)Buffer.from(s.bytes,'base64').copy(bytes,s.offset);
    const file=join(dir,v.file);await writeFile(file,bytes);
    assert.equal((await partialMd5(file)).digest,v.expected);
    assert.equal(partialBufferMd5(bytes),v.expected);
  }}finally{await rm(dir,{recursive:true,force:true});}
});

test('short files hash only real bytes and a symlink cannot read outside the book path',async()=>{
  const {partialMd5}=await import('../src/lib/koreaderDigest');
  const dir=await mkdtemp(join(tmpdir(),'kosync-short-'));
  try{
    await writeFile(join(dir,'short'),'abc');
    assert.equal((await partialMd5(join(dir,'short'))).digest,'900150983cd24fb0d6963f7d28e17f72');
    await symlink(join(dir,'short'),join(dir,'link'));
    await assert.rejects(partialMd5(join(dir,'link')));
  }finally{await rm(dir,{recursive:true,force:true});}
});
