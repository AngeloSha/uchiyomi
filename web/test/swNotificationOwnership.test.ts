import test from'node:test';
import assert from'node:assert/strict';
import {readFileSync}from'node:fs';
import vm from'node:vm';

const source=readFileSync(new URL('../public/sw.js',import.meta.url),'utf8');
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};};
function fixture(store=new Map<string,Map<string,Response>>()){
  const handlers:Record<string,Function>={},notifications:any[]=[],navigated:string[]=[],state:any={matchWait:null,showWait:null,getWait:null,failPut:false,claimed:0,timers:null};
  const caches={
    keys:async()=>[...store.keys()],delete:async(name:string)=>store.delete(name),
    open:async(name:string)=>{if(!store.has(name))store.set(name,new Map());const entries=store.get(name)!;return{
      match:async(key:any)=>{if(name==='yomi-notification-owner-v1'&&state.matchWait)await state.matchWait.promise;return entries.get(typeof key==='string'?key:key.url)?.clone();},
      put:async(key:any,response:Response)=>{if(state.failPut)throw new Error('fixture quota');entries.set(typeof key==='string'?key:key.url,response.clone());},
      delete:async(key:any)=>entries.delete(typeof key==='string'?key:key.url),
      keys:async()=>[...entries.keys()].map(url=>({url})),
    };},
  };
  const registration={
    getNotifications:async()=>{if(state.getWait)await state.getWait.promise;return notifications.filter(notification=>!notification.closed);},
    showNotification:async(title:string,options:any)=>{if(state.showWait)await state.showWait.promise;notifications.push({title,...options,closed:false,close(){this.closed=true;}});},
  };
  const clients={matchAll:async()=>[],openWindow:async(url:string)=>{navigated.push(url);},claim:async()=>{state.claimed++;}};
  const context:any={URL,Response,Request,Date,Math,JSON,Promise,TypeError,
    setTimeout:(callback:Function,ms:number)=>state.timers ? state.timers.push(callback) : setTimeout(callback as ()=>void,ms),
    clearTimeout:(timer:any)=>{if(!state.timers)clearTimeout(timer);},location:{origin:'https://fixture.test'},caches,clients,
    self:{addEventListener:(name:string,handler:Function)=>{handlers[name]=handler;},registration,clients,skipWaiting(){}},fetch:async()=>new Response('{}')};
  vm.createContext(context);vm.runInContext(source,context);
  async function event(name:string,event:any){let pending:Promise<any>|undefined;handlers[name]({...event,waitUntil:(promise:Promise<any>)=>{pending=promise;}});await pending;}
  return{store,state,context,notifications,navigated,event,
    cleanup:()=>vm.runInContext('closeOtherNotifications()',context) as Promise<void>,
    owner:(userId:string|null)=>event('message',{data:userId?{type:'yomi-user',userId}:{type:'yomi-signout'}}),
    push:(data:any)=>event('push',{data:{json:()=>({title:'Uchiyomi',body:'Open Uchiyomi to check your updates.',url:'/',tag:'uchiyomi-update',recipientId:data.recipientId,
      recipientContent:{title:data.title||'Fixture update',body:data.body||'A new chapter is available',url:data.url||'/',tag:data.tag}})}}),
  };
}

test('push shows only a labeled payload for the announced account',async()=>{
  const f=fixture();await f.owner('A');
  await f.push({recipientId:'B',title:'B private title'});await f.push({title:'unlabeled legacy title'});assert.equal(f.notifications.length,0);
  await f.push({recipientId:'A',title:'A private title',url:'/series/?id=private-a'});assert.equal(f.notifications.length,1);assert.equal(f.notifications[0].data.recipientId,'A');assert.equal(f.notifications[0].title,'A private title');
});
test('addressed top-only and malformed nested payloads never display or fall back to legacy fields',async()=>{
  const f=fixture();await f.owner('A');
  for(const recipientContent of [undefined,null,[],{},'private detail',{title:'private',body:'detail',url:5},{title:'private',body:'detail',url:'/',tag:{}}])
    await f.event('push',{data:{json:()=>({title:'TOP SECRET',body:'top fallback forbidden',url:'/private',recipientId:'A',recipientContent})}});
  await f.event('push',{data:{json:()=>null}});assert.equal(f.notifications.length,0);
});
test('account switch and signout close previous and unlabeled notifications',async()=>{
  const f=fixture();await f.owner('A');await f.push({recipientId:'A',title:'A private'});
  f.notifications.push({data:{},closed:false,close(){this.closed=true;}});await f.owner('B');await f.cleanup();assert.ok(f.notifications.every(notification=>notification.closed));
  await f.push({recipientId:'A',title:'queued A private'});assert.equal(f.notifications.length,2);
  await f.push({recipientId:'B',title:'B private'});await f.owner(null);await f.cleanup();assert.ok(f.notifications.every(notification=>notification.closed));await f.push({recipientId:'B',title:'late B'});assert.equal(f.notifications.length,3);
});

async function promptly<T>(promise:Promise<T>,label:string):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),100);})]);}
  finally{clearTimeout(timer);}
}
test('a stalled native notification API cannot hold worker activation, owner reset or API responses',async()=>{
  const f=fixture();f.state.getWait=deferred<void>();f.state.timers=[];
  await promptly(f.event('activate',{}),'native notifications blocked activation');assert.equal(f.state.claimed,1);
  await promptly(f.owner('A'),'native notifications blocked the account cache barrier');
  const response=await promptly(vm.runInContext("networkFirst(new Request('https://fixture.test/api/history'),API,300)",f.context) as Promise<Response>,'native notifications blocked an API response');
  assert.equal(await response.text(),'{}');assert.equal(vm.runInContext('ownerHint',f.context),'A');
});
test('OS cleanup has a deadline and a late old query preserves current-owner notifications',async()=>{
  const f=fixture();await f.owner('A');await f.push({recipientId:'A',title:'A private'});await f.cleanup();
  f.state.getWait=deferred<void>();f.state.timers=[];
  const oldCleanup=f.cleanup();await new Promise(resolve=>setImmediate(resolve));
  assert.ok(f.state.timers.length>0,'cleanup installs a deadline');
  for(const expire of f.state.timers.splice(0))expire();
  await promptly(oldCleanup,'cleanup did not stop awaiting its stalled native query');
  await promptly(f.owner('B'),'late cleanup retained the old account barrier');await f.push({recipientId:'B',title:'B current'});
  f.state.getWait.resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.notifications[0].closed,true,'the previous owner is removed when the OS finally answers');
  assert.equal(f.notifications[1].closed,false,'a late query must not close the newly selected owner’s legitimate notification');
});
test('worker restart restores notification recipient without authorizing runtime caches',async()=>{
  const first=fixture();await first.owner('A');const restarted=fixture(first.store);
  await restarted.event('activate',{});await restarted.push({recipientId:'A',title:'A background'});assert.equal(restarted.notifications.length,1);
  assert.equal(vm.runInContext('ownerHint',restarted.context),null);assert.equal(vm.runInContext('mayReadAccountCache(accountEpoch)',restarted.context),false);
  assert.ok(restarted.store.has('yomi-notification-owner-v1'),'activation preserves only the dedicated recipient metadata');
});
test('fresh or signed-out worker fails closed for labeled and old unlabeled pushes',async()=>{
  const fresh=fixture();await fresh.push({recipientId:'A',title:'unknown recipient'});await fresh.push({title:'legacy'});assert.equal(fresh.notifications.length,0);
  await fresh.owner('A');await fresh.owner(null);const restarted=fixture(fresh.store);await restarted.push({recipientId:'A',title:'after signout'});assert.equal(restarted.notifications.length,0);
});
test('a delayed owner lookup cannot deliver old-account notification after a switch',async()=>{
  const first=fixture();await first.owner('A');const restarted=fixture(first.store);restarted.state.matchWait=deferred<void>();
  const pending=restarted.push({recipientId:'A',title:'A private'});await new Promise(resolve=>setImmediate(resolve));await restarted.owner('B');restarted.state.matchWait.resolve();await pending;assert.equal(restarted.notifications.length,0);
});
test('a notification created late by the browser is closed after account reset',async()=>{
  const f=fixture();await f.owner('A');f.state.showWait=deferred<void>();const pending=f.push({recipientId:'A',title:'late A'});
  await new Promise(resolve=>setImmediate(resolve));await f.owner('B');f.state.showWait.resolve();await pending;assert.equal(f.notifications.length,1);assert.equal(f.notifications[0].closed,true);
});
test('notification clicks must still belong to the current recipient',async()=>{
  const f=fixture();await f.owner('A');await f.push({recipientId:'A',title:'A private',url:'/series/?id=private-a'});await f.owner('B');
  await f.event('notificationclick',{notification:f.notifications[0]});assert.deepEqual(f.navigated,[]);
  await f.push({recipientId:'B',title:'B private',url:'/series/?id=private-b'});await f.event('notificationclick',{notification:f.notifications[1]});assert.deepEqual(f.navigated,['/series/?id=private-b']);
});
test('a failed metadata replacement removes the prior durable recipient',async()=>{
  const f=fixture();await f.owner('A');f.state.failPut=true;await f.owner('B');await f.push({recipientId:'B',title:'fail closed while storage unavailable'});assert.equal(f.notifications.length,0);
  const restarted=fixture(f.store);await restarted.push({recipientId:'A',title:'old owner must not return'});assert.equal(restarted.notifications.length,0);
});
test('a cold worker rotates its subscription only for a verified durable notification recipient',async()=>{
  const first=fixture();await first.owner('A');const restarted=fixture(first.store),writes:any[]=[];
  restarted.context.self.registration.pushManager={subscribe:async()=>({toJSON:()=>({endpoint:'https://push.fixture.test/rotated',keys:{auth:'fixture'}})})};
  restarted.context.fetch=async(url:string,options:any)=>{if(url==='/auth/refresh')return new Response(JSON.stringify({accessToken:'verified-a',user:{id:'A'}}));writes.push({url,token:options.headers.authorization});return new Response('{}');};
  await restarted.event('pushsubscriptionchange',{oldSubscription:{options:{applicationServerKey:new Uint8Array([1])}}});
  assert.deepEqual(writes,[{url:'/api/push/subscribe',token:'Bearer verified-a'}]);assert.equal(vm.runInContext('ownerHint',restarted.context),null);
});
test('a cold worker never assigns its old subscription to a different refreshed account',async()=>{
  const first=fixture();await first.owner('A');const restarted=fixture(first.store),writes:string[]=[];
  restarted.context.self.registration.pushManager={subscribe:async()=>({toJSON:()=>({endpoint:'https://push.fixture.test/rotated',keys:{}})})};
  restarted.context.fetch=async(url:string)=>{if(url==='/auth/refresh')return new Response(JSON.stringify({accessToken:'verified-b',user:{id:'B'}}));writes.push(url);return new Response('{}');};
  await restarted.event('pushsubscriptionchange',{oldSubscription:{options:{applicationServerKey:new Uint8Array([1])}}});assert.deepEqual(writes,[]);
});
