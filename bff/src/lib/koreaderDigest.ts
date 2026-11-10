import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// KOReader util.partialMD5, 01ccbd790d6269301ad523e75c45f62d022a6d7b.
// Lua's bit.lshift(1024,-2) produces zero, not 256. The remaining samples grow by four.
export const KOREADER_OFFSETS = [0,...Array.from({length:11},(_,i)=>1024*4**i)];
export const fileSignature = (s:{size:number;mtimeMs:number}) => `${s.size}:${s.mtimeMs}`;
export function partialBufferMd5(bytes:Buffer):string {
  const hash=createHash('md5');
  for(const offset of KOREADER_OFFSETS){if(offset>=bytes.length)break;hash.update(bytes.subarray(offset,offset+1024));}
  return hash.digest('hex');
}
export async function partialMd5(path:string): Promise<{digest:string;signature:string}> {
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const before=await f.stat();
    if(!before.isFile())throw new Error('Not a regular book file');
    const hash=createHash('md5'),buffer=Buffer.alloc(1024);
    for(const offset of KOREADER_OFFSETS){
      const {bytesRead}=await f.read(buffer,0,1024,offset);
      if(!bytesRead)break;
      hash.update(buffer.subarray(0,bytesRead));
    }
    const after=await f.stat();
    if(fileSignature(before)!==fileSignature(after))throw new Error('Book changed while hashing');
    return {digest:hash.digest('hex'),signature:fileSignature(after)};
  }finally{await f.close();}
}
