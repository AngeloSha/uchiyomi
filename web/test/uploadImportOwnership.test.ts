import test from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError, setCurrentUser } from '../lib/api';
import { uploadAll, uploadImageChapter } from '../lib/chapterUpload';
import { readImportBackup } from '../lib/importBatch';

const changed = (error: unknown) => error instanceof ApiError && error.status === 409 && /account_changed/.test(error.body);
const response = () => new Response(JSON.stringify({file:'x',seriesId:'owner-a-series',bookId:'b',number:1,indexed:true}), {headers:{'content-type':'application/json'}});

test('a slow first upload cannot send any queued archive after the active account changes', async () => {
  const original=globalThis.fetch, sent:Array<{url:string;authorization:string|null}>=[];
  let finish!:()=>void;
  setCurrentUser('upload-owner-a');
  globalThis.fetch=(async(url:any,init?:RequestInit)=>{
    sent.push({url:String(url),authorization:new Headers(init?.headers).get('authorization')});
    return new Promise<Response>(resolve=>{finish=()=>resolve(response());});
  }) as typeof fetch;
  try {
    const queued=['Chapter 1.cbz','Chapter 2.cbz','Chapter 3.cbz'].map(name=>new File(['chapter bytes'],name));
    const pending=uploadAll({title:'A private upload',fresh:true,visibility:'private'},queued,undefined,'upload-owner-a');
    assert.equal(sent.length,1);
    setCurrentUser('upload-owner-b');finish();
    const result=await pending;
    assert.equal(result.cancelled,true);assert.equal(result.done,0);
    assert.equal(result.seriesId,null,'a late response cannot attach subsequent files to its returned series');
    assert.equal(sent.length,1,'neither queued file was submitted as B');
  } finally {globalThis.fetch=original;setCurrentUser(null);}
});

test('an old image-upload callback refuses before exposing its multipart bytes to the new account', async () => {
  const original=globalThis.fetch;let posts=0;
  globalThis.fetch=(async()=>{posts++;return response();}) as typeof fetch;
  try {
    setCurrentUser('upload-owner-b');
    await assert.rejects(uploadImageChapter({title:'A private upload',fresh:true},'Chapter 1',[new File(['page bytes'],'page.png')],'upload-owner-a'),changed);
    assert.equal(posts,0);
  } finally {globalThis.fetch=original;setCurrentUser(null);}
});

test('a deferred backup read never submits its private payload after switching account', async () => {
  const originalFetch=globalThis.fetch,originalReader=globalThis.FileReader;
  let finish!:()=>void;const sent:RequestInit[]=[];
  globalThis.FileReader=class {
    result='data:application/octet-stream;base64,cHJpdmF0ZS1iYWNrdXA=';
    onload:(()=>void)|null=null;onerror:(()=>void)|null=null;
    readAsDataURL(){finish=()=>this.onload?.();}
  } as unknown as typeof FileReader;
  globalThis.fetch=(async(_url:any,init?:RequestInit)=>{sent.push(init!);return new Response('{"batchId":"a"}',{headers:{'content-type':'application/json'}});}) as typeof fetch;
  try {
    const owner='import-owner-a';setCurrentUser(owner);
    const pending=readImportBackup(new File(['private backup bytes'],'backup.tachibk'),owner)
      .then(dataUrl=>api('/api/admin/import/batches',{json:{dataUrl,visibility:'private'},expectedOwnerId:owner}));
    setCurrentUser('import-owner-b');finish();
    await assert.rejects(pending,changed);
    assert.equal(sent.length,0,'no backup bytes are posted under B');
    setCurrentUser(owner);
    const valid=readImportBackup(new File(['private backup bytes'],'backup.tachibk'),owner)
      .then(dataUrl=>api('/api/admin/import/batches',{json:{dataUrl,visibility:'private'},expectedOwnerId:owner}));
    finish();await valid;
    assert.equal(sent.length,1,'same-owner backup intake still succeeds');
    assert.deepEqual(JSON.parse(String(sent[0].body)),{dataUrl:'data:application/octet-stream;base64,cHJpdmF0ZS1iYWNrdXA=',visibility:'private'},'the owner binding is local API metadata, never a client-controlled server owner');
  } finally {globalThis.fetch=originalFetch;globalThis.FileReader=originalReader;setCurrentUser(null);}
});
