import 'fake-indexeddb/auto';
import test,{before,beforeEach}from'node:test';
import assert from'node:assert/strict';
import {openDB}from'idb';
import {IDBObjectStore}from'fake-indexeddb';
import * as client from'../lib/api';
import * as offline from'../lib/downloads';

const A='async-reader-a',B='async-reader-b';
type Deferred<T>={promise:Promise<T>;resolve:(value:T)=>void};
function deferred<T>():Deferred<T>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};}
let calls:Array<{url:string;token:string|null}>=[];
let pendingPage:Deferred<Response>|undefined,pageStarted:Deferred<void>|undefined;
let pendingProgress:Deferred<Response>|undefined,progressStarted:Deferred<void>|undefined;
const originalFetch=globalThis.fetch;
before(async()=>{client.setCurrentUser(A);await offline.flushOutbox();});
beforeEach(async()=>{
  client.setCurrentUser(A);client.setAccessToken('synthetic-a');calls=[];pendingPage=undefined;pendingProgress=undefined;pageStarted=undefined;progressStarted=undefined;
  const db=await openDB('yomi-offline');for(const store of ['chapters','pages','outbox'])await db.clear(store);db.close();offline.invalidateDownloadedSeries();
  globalThis.fetch=(async(input:any,options:any={})=>{
    const url=String(input);calls.push({url,token:new Headers(options.headers).get('authorization')});
    if(url.includes('/download-manifest')){
      const book=url.split('/')[3];return new Response(JSON.stringify({seriesId:'series-'+book,seriesTitle:'Private '+book,title:'Chapter',number:'1',pageCount:2,totalBytes:12,
        pages:[1,2].map(number=>({number,url:`/page/${book}/${number}`,width:1,height:1}))}),{headers:{'content-type':'application/json'}});
    }
    if(url==='/page/private/2'&&pendingPage){pageStarted!.resolve();return pendingPage.promise;}
    if(url.endsWith('/progress')&&pendingProgress){progressStarted!.resolve();return pendingProgress.promise;}
    if(url.startsWith('/page/'))return new Response('private-a-bytes');
    return new Response('{}',{headers:{'content-type':'application/json'}});
  })as any;
});
test.after(()=>{globalThis.fetch=originalFetch;});
async function stored(){const db=await openDB('yomi-offline');try{return{chapters:await db.getAll('chapters'),pageKeys:await db.getAllKeys('pages'),outbox:await db.getAll('outbox')};}finally{db.close();}}

test('a deferred private page cannot cross account keys and cleanup preserves completed owner chapters',async()=>{
  await offline.downloadChapter('completed');
  pendingPage=deferred<Response>();pageStarted=deferred<void>();
  const downloading=offline.downloadChapter('private');
  const rejected=assert.rejects(downloading,error=>offline.offlineAccountChanged(error));
  await pageStarted.promise;client.setCurrentUser(B);client.setAccessToken('synthetic-b');pendingPage.resolve(new Response('private-a-last-page'));
  await rejected;
  const rows=await stored();assert.deepEqual(rows.chapters.map(row=>row.key),[A+':completed']);
  assert.ok(rows.pageKeys.every(key=>String(key).startsWith(A+':completed:')),'partial A pages are cleaned only under A; nothing was stored under B');
  assert.equal(await offline.getOfflineChapter('private'),undefined);
  client.setCurrentUser(A);assert.equal((await offline.getOfflineChapter('completed'))?.userId,A);
  assert.ok(await offline.getPageBlob('completed',1),'completed A bytes survive');
});

test('a page BODY finishing after account switch is refused before writing any bytes',async()=>{
  const body=deferred<void>(),started=deferred<void>();
  const baseFetch=globalThis.fetch;
  globalThis.fetch=(async(input:any,options:any)=>{
    if(String(input)==='/page/private/1'){
      const stream=new ReadableStream({start(controller){started.resolve();void body.promise.then(()=>{controller.enqueue(new TextEncoder().encode('private body'));controller.close();});}});
      return new Response(stream);
    }return baseFetch(input,options);
  })as any;
  const downloading=offline.downloadChapter('private'),rejected=assert.rejects(downloading,error=>offline.offlineAccountChanged(error));
  await started.promise;client.setCurrentUser(B);body.resolve();await rejected;
  const rows=await stored();assert.deepEqual(rows.chapters,[]);assert.deepEqual(rows.pageKeys,[]);
});

test('an interrupted refresh of an already completed download preserves its original bytes and metadata',async()=>{
  await offline.downloadChapter('private');
  const original=await offline.getOfflineChapter('private'),page=await offline.getPageBlob('private',1);
  pendingPage=deferred<Response>();pageStarted=deferred<void>();const retry=offline.downloadChapter('private'),rejected=assert.rejects(retry,error=>offline.offlineAccountChanged(error));
  await pageStarted.promise;client.setCurrentUser(B);pendingPage.resolve(new Response('new private page'));await rejected;
  client.setCurrentUser(A);assert.deepEqual(await offline.getOfflineChapter('private'),original);assert.equal(await(await offline.getPageBlob('private',1))!.text(),await page!.text());
  assert.ok((await stored()).pageKeys.every(key=>!String(key).includes(':pending:')),'only this attempt’s staging blobs were cleaned');
});

test('queue opening and explicit old-owner callbacks never stamp a new owner',async()=>{
  const queued=offline.queueProgress({bookId:'queued-a',page:1,completed:false});client.setCurrentUser(B);await queued;
  await offline.queueProgress({bookId:'stale-a',page:2,completed:false},A);
  assert.deepEqual((await stored()).outbox,[]);
});

test('a delayed first flush cannot replay the second A event with B token or drop either A event',async()=>{
  await offline.queueProgress({bookId:'first',page:1,completed:false});await offline.queueProgress({bookId:'second',page:2,completed:true});
  pendingProgress=deferred<Response>();progressStarted=deferred<void>();const flushing=offline.flushOutbox();
  await progressStarted.promise;client.setCurrentUser(B);client.setAccessToken('synthetic-b');pendingProgress.resolve(new Response('{}',{headers:{'content-type':'application/json'}}));
  assert.equal(await flushing,0);
  const writes=calls.filter(call=>call.url.endsWith('/progress'));assert.equal(writes.length,1);assert.equal(writes[0].token,'Bearer synthetic-a');
  assert.deepEqual((await stored()).outbox.map(row=>[row.userId,row.bookId]),[[A,'first'],[A,'second']]);
  client.setCurrentUser(A);client.setAccessToken('synthetic-a');pendingProgress=undefined;assert.equal(await offline.flushOutbox(),2);assert.deepEqual((await stored()).outbox,[]);
});

test('unknown legacy ownership is retained without guessed replay or deletion',async()=>{
  const db=await openDB('yomi-offline');await db.add('outbox',{bookId:'legacy',page:1,completed:true,ts:1});db.close();
  assert.equal(await offline.flushOutbox(),0);assert.equal(calls.length,0);assert.equal((await stored()).outbox.length,1);
});

test('saved-series cache and deletion are bound to the actor before any await',async()=>{
  await offline.downloadChapter('completed');assert.deepEqual([...await offline.downloadedSeriesIds()],['series-completed']);
  const deleting=offline.deleteDownload('completed',A),rejected=assert.rejects(deleting,error=>offline.offlineAccountChanged(error));client.setCurrentUser(B);await rejected;
  assert.deepEqual([...await offline.downloadedSeriesIds()],[]);
  client.setCurrentUser(A);assert.ok(await offline.getOfflineChapter('completed'));assert.ok(await offline.getPageBlob('completed',1));
});
test('an account switch halfway through deletion rolls back both pages and completed metadata',async()=>{
  await offline.downloadChapter('completed');const before=await stored(),original=IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.delete=function(key:IDBValidKey){
    const request=original.call(this,key);
    if(this.name==='pages'&&String(key)===A+':completed:1')request.addEventListener('success',()=>{client.setCurrentUser(B);},{once:true});
    return request;
  };
  try{await assert.rejects(offline.deleteDownload('completed',A),error=>offline.offlineAccountChanged(error));}
  finally{IDBObjectStore.prototype.delete=original;}
  const after=await stored();assert.deepEqual(after.chapters,before.chapters);assert.deepEqual(after.pageKeys,before.pageKeys);
  client.setCurrentUser(A);assert.ok(await offline.getPageBlob('completed',1));assert.ok(await offline.getPageBlob('completed',2));
});
