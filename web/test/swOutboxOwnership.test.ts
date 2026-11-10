import test from'node:test';
import assert from'node:assert/strict';
import {IDBFactory}from'fake-indexeddb';
import {readFileSync}from'node:fs';
import vm from'node:vm';

const source=readFileSync(new URL('../public/sw.js',import.meta.url),'utf8');
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};}
const req=<T>(request:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
async function fixture(rows:any[]){
  const factory=new IDBFactory(),opening=factory.open('yomi-offline',2);
  opening.onupgradeneeded=()=>opening.result.createObjectStore('outbox',{keyPath:'id',autoIncrement:true});
  const db=await req(opening),write=db.transaction('outbox','readwrite');for(const row of rows)write.objectStore('outbox').add(row);
  await new Promise<void>((resolve,reject)=>{write.oncomplete=()=>resolve();write.onerror=()=>reject(write.error);});
  const handlers:Record<string,Function>={},calls:Array<{url:string;token?:string}>=[];
  const cacheRows=new Map<string,Response>();
  const context:any={URL,Response,Request,Date,Math,JSON,Promise,TypeError,setTimeout,clearTimeout,indexedDB:factory,location:{origin:'https://fixture.test'},
    caches:{keys:async()=>[],delete:async()=>true,open:async()=>({match:async(key:string)=>cacheRows.get(key)?.clone(),delete:async(key:string)=>cacheRows.delete(key),put:async(key:string,value:Response)=>{cacheRows.set(key,value.clone());}})},
    self:{addEventListener:(name:string,handler:Function)=>{handlers[name]=handler;},clients:{claim:async()=>{}},skipWaiting(){},registration:{}}};
  context.fetch=async(url:any,options:any={})=>{calls.push({url:String(url),token:options.headers?.authorization});return String(url)==='/auth/refresh'
    ?new Response(JSON.stringify({accessToken:'synthetic-a',user:{id:'A'}}),{headers:{'content-type':'application/json'}}):new Response('{}',{headers:{'content-type':'application/json'}});};
  vm.createContext(context);vm.runInContext(source,context);context.testDB=db;
  const owner=async(value:string)=>{const waits:Promise<any>[]=[];handlers.message({data:{type:'yomi-user',userId:value},waitUntil:(p:Promise<any>)=>waits.push(p)});await Promise.all(waits);};
  await owner('A');
  return{db,context,calls,owner,handlers,flush:()=>vm.runInContext('flushOutboxWith(testDB)',context),rows:()=>req(db.transaction('outbox').objectStore('outbox').getAll())};
}
const events=()=>[{userId:'A',bookId:'first',page:1,completed:false,ts:1},{userId:'A',bookId:'second',page:2,completed:true,ts:2}];

test('SW verifies actual refreshed user instead of trusting a stale owner hint',async()=>{
  const f=await fixture(events());f.context.fetch=async()=>new Response(JSON.stringify({accessToken:'synthetic-b',user:{id:'B'}}));
  try{await f.flush();assert.equal((await f.rows()).length,2);}finally{f.db.close();}
});
test('SW stops a delayed refresh when its account epoch changes',async()=>{
  const f=await fixture(events()),started=deferred<void>(),response=deferred<Response>();
  f.context.fetch=async()=>{started.resolve();return response.promise;};
  try{const pending=f.flush();await started.promise;await f.owner('B');response.resolve(new Response(JSON.stringify({accessToken:'synthetic-a',user:{id:'A'}})));await pending;
    assert.equal((await f.rows()).length,2);
  }finally{f.db.close();}
});
test('SW never sends a second old-owner event after a delayed first response and preserves both',async()=>{
  const f=await fixture(events()),started=deferred<void>(),response=deferred<Response>(),network=f.context.fetch;
  f.context.fetch=async(url:any,options:any)=>{
    if(String(url).endsWith('/progress')){f.calls.push({url:String(url),token:options.headers.authorization});started.resolve();return response.promise;}
    return network(url,options);
  };
  try{const pending=f.flush();await started.promise;await f.owner('B');response.resolve(new Response('{}'));await pending;
    const writes=f.calls.filter(call=>call.url.endsWith('/progress'));assert.equal(writes.length,1);assert.equal(writes[0].token,'Bearer synthetic-a');assert.equal((await f.rows()).length,2);
  }finally{f.db.close();}
});
test('SW quarantines unattributed legacy progress without any replay or deletion',async()=>{
  const f=await fixture([{bookId:'legacy',page:4,completed:true,ts:1}]);try{await f.flush();assert.equal(f.calls.length,0);assert.equal((await f.rows()).length,1);}finally{f.db.close();}
});
test('SW acknowledgement removes only an event owned by the verified account',async()=>{
  const f=await fixture([events()[0],{userId:'B',bookId:'other',page:2,completed:true},{bookId:'legacy',page:3,completed:false}]);
  try{await f.flush();assert.deepEqual((await f.rows()).map((row:any)=>row.bookId),['other','legacy']);assert.equal(f.calls.filter(call=>call.url.endsWith('/progress')).length,1);}finally{f.db.close();}
});
test('SW rotated push registration uses the verified session token string',async()=>{
  const f=await fixture([]);f.context.self.registration.pushManager={subscribe:async()=>({toJSON:()=>({endpoint:'https://push.fixture.test/a',keys:{auth:'fixture'}})})};
  try{let pending!:Promise<any>;f.handlers.pushsubscriptionchange({oldSubscription:{options:{applicationServerKey:new Uint8Array([1])}},waitUntil:(promise:Promise<any>)=>{pending=promise;}});await pending;
    const write=f.calls.find(call=>call.url==='/api/push/subscribe');assert.ok(write);assert.equal(write.token,'Bearer synthetic-a');
  }finally{f.db.close();}
});
test('SW does not reassign a delayed push subscription after its owner changes',async()=>{
  const f=await fixture([]),started=deferred<void>(),subscription=deferred<any>();f.context.self.registration.pushManager={subscribe:()=>{started.resolve();return subscription.promise;}};
  try{let pending!:Promise<any>;f.handlers.pushsubscriptionchange({oldSubscription:{options:{applicationServerKey:new Uint8Array([1])}},waitUntil:(promise:Promise<any>)=>{pending=promise;}});
    await started.promise;await f.owner('B');subscription.resolve({toJSON:()=>({endpoint:'https://push.fixture.test/a',keys:{}})});await pending;assert.deepEqual(f.calls,[]);
  }finally{f.db.close();}
});
