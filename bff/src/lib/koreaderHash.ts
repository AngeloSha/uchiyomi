import { fileSignature, partialMd5 } from './koreaderDigest';
export { fileSignature, partialMd5, partialBufferMd5, KOREADER_OFFSETS } from './koreaderDigest';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { q } from './db';
import { LIBRARY_ROOT } from './library';
import { regularFiles } from './archiveCaps';

/** Signature of the bytes OPDS exports, including every page in a generated loose-image archive. */
export async function bookFileSignature(path:string):Promise<string>{
  const s=await stat(path);
  if(s.isFile())return fileSignature(s);
  if(!s.isDirectory())throw new Error('Not a book file');
  const names=(await regularFiles(path,n=>/\.(jpe?g|png|webp|gif|avif)$/i.test(n))).sort();
  const files=[];
  for(const name of names)files.push([name,fileSignature(await stat(join(path,name)))]);
  return 'dir:'+createHash('sha256').update(JSON.stringify(files)).digest('hex');
}
export async function rememberKoreaderHash(bookId:string,signature:string,digest:string):Promise<void>{
  await q(`INSERT INTO koreader_hashes(book_id,signature,digest,scan_mtime) SELECT id,$2,$3,mtime FROM lib_books WHERE id=$1
    ON CONFLICT(book_id) DO UPDATE SET signature=EXCLUDED.signature,digest=EXCLUDED.digest,scan_mtime=EXCLUDED.scan_mtime,checked_at=now()`,[bookId,signature,digest]);
}

let running:Promise<number>|null=null;
/** Small sequential pass, with no archive decompression or new model/worker. A new file is found by the next pass. */
export function backfillKoreaderHashes():Promise<number>{
  return running??=run().finally(()=>{running=null;});
}
async function run():Promise<number>{
  const rows=await q<{id:string;root:string|null;file:string}>(`SELECT b.id,b.root,b.file FROM lib_books b
    LEFT JOIN koreader_hashes h ON h.book_id=b.id
    WHERE b.pruned_at IS NULL AND (h.book_id IS NULL OR h.checked_at<now()-interval '1 hour' OR (h.scan_mtime IS DISTINCT FROM b.mtime AND h.checked_at<now()-interval '1 minute'))
    ORDER BY h.checked_at NULLS FIRST,b.id LIMIT 100`);
  for(const b of rows){
    const path=join(b.root||LIBRARY_ROOT,b.file);
    try{
      const st=await stat(path);
      if(st.isFile()){const result=await partialMd5(path);await rememberKoreaderHash(b.id,result.signature,result.digest);}
    }catch{/* Offline roots/partial writes remain retryable. No paths or book metadata are logged. */}
    // An unavailable file or loose folder cannot monopolize the first batch forever.
    await q(`INSERT INTO koreader_hashes(book_id,signature,digest) VALUES($1,'unavailable','')
      ON CONFLICT(book_id) DO UPDATE SET checked_at=now()`,[b.id]);
  }
  return rows.length;
}
