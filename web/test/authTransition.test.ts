// Execute the actual AuthProvider callbacks with a small hook/context shim and
// the real API client. A deferred service-worker purge creates the scheduling
// window that source-order assertions cannot exercise. No React DOM dependency,
// server, real account, credential or network is used.
import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import vm from 'node:vm';
import {transformSync} from 'esbuild'; // already supplied by the test runner (tsx)

const storage=new Map<string,string>();
(globalThis as any).localStorage={getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,String(value)),removeItem:(key:string)=>storage.delete(key)};
let client:typeof import('../lib/api');
before(async()=>{client=await import('../lib/api');});
const source=transformSync(readFileSync(join(__dirname,'../lib/auth.tsx'),'utf8'),{
  format:'cjs',loader:'tsx',jsx:'automatic',target:'es2022',
}).code;
const A={id:'transition-owner-a',username:'a',displayName:'A',role:'user',settings:{}};
const B={id:'transition-owner-b',username:'b',displayName:'B',role:'user',settings:{}};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
function provider(options:{flush?:()=>Promise<number>;previous?:typeof A|null;purgeFailure?:boolean;native?:boolean}={}){
  const previous=options.previous===undefined?A:options.previous;
  const ready=deferred<any>(),purging=deferred<void>(),events:string[]=[],state:any[]=[previous?'authed':'anon',previous,null];
  const leases:Array<()=>void>=[];
  let stateIndex=0,refIndex=0,reloads=0,releases=0;
  const queryContext={};
  const jsx=(type:any,props:any)=>({type,props});
  const modules:Record<string,any>={
    react:{createContext:()=>({Provider:'provider'}),useContext:(ctx:any)=>ctx===queryContext?{clear(){events.push('purge');purging.resolve();if(options.purgeFailure)throw Error('fixture cache clear failed');}}:undefined,
      useState:(initial:any)=>{const i=stateIndex++;if(!(i in state))state[i]=initial;return[state[i],(value:any)=>{state[i]=typeof value==='function'?value(state[i]):value;}];},
      useRef:(initial:any)=>({current:refIndex++===1?previous?.id??null:initial}),useEffect:()=>{},Fragment:'fragment'},
    'react/jsx-runtime':{jsx,jsxs:jsx},'@tanstack/react-query':{QueryClientContext:queryContext},
    './api':{...client,beginAccountTransition:()=>{const release=client.beginAccountTransition();leases.push(release);return()=>{releases++;release();};},
      setAccessToken:(value:string|null)=>{events.push(`token:${value}`);client.setAccessToken(value);},
      setCurrentUser:(value:string|null)=>{events.push(`identity:${value}`);client.setCurrentUser(value);}},
    './offlineIdentity':{readOfflineIdentity:()=>null,clearOfflineIdentity:()=>events.push('clear-offline'),
      writeOfflineIdentity:(u:any)=>events.push(`persist:${u.id}:${client.getCurrentUser()}:${client.getAccessToken()}`)},
    './device':{deviceId:()=> 'fixture-device',deviceName:()=> 'Fixture'},
    './shownOnce':{clearShownOnce:()=>events.push('clear-secrets')},
    './effects':{applyReduceEffects:()=>{},restoreReduceEffects:()=>{}},'./tone':{applyTone:()=>{},restoreTone:()=>{}},
    './downloads':{flushOutbox:async()=>{events.push(`flush:${client.getCurrentUser()}:${client.getAccessToken()}`);return options.flush?options.flush():0;}},
    './adult':{setAdultShown:()=>events.push('adult-hidden')},
    './native':{usesNativeCache:()=>options.native===true},
    './desktop':{isDesktop:()=>false,serverReachableHint:()=>true,untilReachable:(fn:any)=>fn()},'./i18n':{t:(text:string)=>text},
  };
  const module={exports:{} as any};
  vm.runInNewContext(source,{exports:module.exports,module,require:(name:string)=>{assert.ok(name in modules,`unexpected Auth dependency ${name}`);return modules[name];},
    navigator:{serviceWorker:{ready:ready.promise}},document:{documentElement:{style:{setProperty(){}}}},
    window:{location:{reload(){reloads++;events.push('reload');}}},fetch:(...args:any[])=>(globalThis.fetch as any)(...args),
    setTimeout:(fn:any,ms:number)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;},clearTimeout,setInterval,clearInterval,console,
  },{filename:'actual-auth-provider.cjs'});
  const element=module.exports.AuthProvider({children:null});
  return {auth:element.props.value,events,state,ready,purging,reloads:()=>reloads,releases:()=>releases,
    // A real reload destroys the API module. Test teardown releases held leases
    // only to simulate that document destruction between independent fixtures.
    destroyDocument:()=>leases.forEach(release=>release())};
}
const response=(status=200)=>new Response(JSON.stringify({accessToken:'credential-b',user:B}),{status,headers:{'content-type':'application/json'}});

for(const [method,args,path] of [
  ['login',['b','fixture-password'],'/auth/login'],['register',['b','fixture-password'],'/auth/register'],
  ['firstRunSetup',['b','fixture-password'],'/api/setup'],['switchProfile',[B.id],'/auth/switch'],
  ['resumeProfile',[B.id],'/auth/resume'],['pickProfile',[B.id],'/auth/profile-login'],
] as const){
  test(`${method}: known A-to-B change keeps B credentials out of A's document until reload`,async()=>{
    client.setCurrentUser(A.id);client.setAccessToken('credential-a');
    const harness=provider(),oldFetch=globalThis.fetch,sent:string[]=[];
    globalThis.fetch=(async(input:any)=>{const url=String(input).split('?')[0];sent.push(url);harness.events.push(`request:${url}`);return response();}) as typeof fetch;
    try{
      const moving=harness.auth[method](...args);
      await harness.purging.promise;
      assert.equal(client.getCurrentUser(),null,'old offline identity is gone before the asynchronous purge');
      assert.equal(client.getAccessToken(),null);
      assert.equal(harness.state[0],'loading');assert.equal(harness.state[1],null,'old React account is removed before yielding');
      await assert.rejects(()=>client.api('/api/retained-old-form',{json:{title:'old private draft'}}),
        (error:any)=>error instanceof client.ApiError&&error.status===409);
      assert.equal((await client.refreshSession()).kind,'unreachable');
      assert.deepEqual(sent,[path],'retained work and refresh do not issue requests during the account transition');
      harness.ready.resolve({active:{postMessage(){}}});
      assert.equal((await moving).ok,true);
      assert.equal(client.getCurrentUser(),null);assert.equal(client.getAccessToken(),null);
      assert.equal(harness.state[0],'loading');assert.equal(harness.state[1],null);
      assert.equal(harness.reloads(),1);assert.equal(harness.releases(),0,'production never releases the old document to act as B');
      assert.ok(harness.events.includes(`persist:${B.id}:null:null`),'only the trusted offline identity is saved for the replacement document');
      assert.ok(!harness.events.includes('token:credential-b')&&!harness.events.includes(`identity:${B.id}`));
      await assert.rejects(()=>client.api('/api/unreviewed-late-callback',{json:{oldPrivateNote:'A'}}),(error:any)=>error instanceof client.ApiError&&error.status===409);
      const clears=harness.events.filter(event=>event==='clear-offline').length;
      await harness.auth.logout();await harness.auth.leave();
      assert.equal(harness.events.filter(event=>event==='clear-offline').length,clears,'an old sign-out callback cannot erase the replacement owner’s offline identity');
      assert.equal(harness.reloads(),1);
      if(method==='switchProfile'||method==='resumeProfile'||method==='pickProfile'){
        assert.ok(harness.events.indexOf(`flush:${A.id}:credential-a`)<harness.events.indexOf(`request:${path}`),'outbox flush still belongs to the previous account');
      }
    }finally{harness.destroyDocument();globalThis.fetch=oldFetch;}
  });
}

for(const [method,args] of [
  ['login',['b','fixture-password']],['register',['b','fixture-password']],['firstRunSetup',['b','fixture-password']],
  ['resumeProfile',[B.id]],['pickProfile',[B.id]],
] as const){
  test(`${method}: an anonymous document may adopt its first authenticated owner without reload`,async()=>{
    client.setCurrentUser(null);client.setAccessToken(null);const harness=provider({previous:null}),oldFetch=globalThis.fetch;
    globalThis.fetch=(async()=>response()) as typeof fetch;
    try{
      const moving=harness.auth[method](...args);await harness.purging.promise;
      harness.ready.resolve({active:{postMessage(){}}});assert.equal((await moving).ok,true);
      assert.equal(client.getCurrentUser(),B.id);assert.equal(client.getAccessToken(),'credential-b');
      assert.equal(harness.reloads(),0);assert.equal(harness.releases(),1);
      assert.equal(harness.state[0],'authed');assert.equal((harness.state[1] as any)?.id,B.id);
    }finally{harness.destroyDocument();globalThis.fetch=oldFetch;}
  });
}

test('accepting the same owner keeps the document and adopts the confirmed token',async()=>{
  client.setCurrentUser(A.id);client.setAccessToken('credential-a');const harness=provider(),oldFetch=globalThis.fetch;
  globalThis.fetch=(async()=>new Response(JSON.stringify({accessToken:'credential-a-new',user:A}),{headers:{'content-type':'application/json'}})) as typeof fetch;
  try{
    const moving=harness.auth.login('a','fixture-password');await harness.purging.promise;
    harness.ready.resolve({active:{postMessage(){}}});assert.equal((await moving).ok,true);
    assert.equal(client.getCurrentUser(),A.id);assert.equal(client.getAccessToken(),'credential-a-new');
    assert.equal(harness.reloads(),0);assert.equal(harness.releases(),1);
  }finally{harness.destroyDocument();globalThis.fetch=oldFetch;}
});

test('a failed cache purge after accepted A-to-B change cannot reopen A’s document as B',async()=>{
  client.setCurrentUser(A.id);client.setAccessToken('credential-a');const harness=provider({purgeFailure:true}),oldFetch=globalThis.fetch;
  globalThis.fetch=(async()=>response()) as typeof fetch;
  try{
    assert.equal((await harness.auth.login('b','fixture-password')).ok,false);
    assert.equal(client.getCurrentUser(),null);assert.equal(client.getAccessToken(),null);assert.equal(harness.releases(),0);
    assert.ok(!harness.events.includes('token:credential-b')&&!harness.events.includes(`identity:${B.id}`));
    await assert.rejects(()=>client.api('/api/old-callback-after-failure'),(error:any)=>error instanceof client.ApiError&&error.status===409);
  }finally{harness.ready.resolve({active:{postMessage(){}}});harness.destroyDocument();globalThis.fetch=oldFetch;}
});

test('a rejected profile change retains the previous account and never purges it',async()=>{
  client.setCurrentUser(A.id);client.setAccessToken('credential-a');const harness=provider(),oldFetch=globalThis.fetch;
  globalThis.fetch=(async()=>new Response('{"error":"forbidden"}',{status:403,headers:{'content-type':'application/json'}})) as typeof fetch;
  try{
    assert.equal((await harness.auth.switchProfile(B.id)).ok,false);
    assert.equal(client.getCurrentUser(),A.id);assert.equal(client.getAccessToken(),'credential-a');
    assert.equal(harness.state[1].id,A.id);assert.ok(!harness.events.includes('purge'));
  }finally{harness.destroyDocument();globalThis.fetch=oldFetch;}
});

for(const method of ['switchProfile','backToOwner'] as const){
  test(`${method}: an old outbox continuation cannot switch the next account`,async()=>{
    client.setCurrentUser(A.id);client.setAccessToken('credential-a');
    const flush=deferred<number>(),harness=provider({flush:()=>flush.promise}),oldFetch=globalThis.fetch,sent:string[]=[];
    globalThis.fetch=(async(input:any)=>{sent.push(String(input));return response();}) as typeof fetch;
    try{
      const moving=harness.auth[method](B.id);
      client.setCurrentUser(B.id);client.setAccessToken('credential-b');
      flush.resolve(0);
      const result=await moving;
      assert.equal(method==='backToOwner'?result:result.ok,false);
      assert.deepEqual(sent,[],'the obsolete account intent never reaches the server as the next owner');
      assert.equal(client.getCurrentUser(),B.id);assert.equal(client.getAccessToken(),'credential-b');
      assert.ok(!harness.events.includes('purge'));
    }finally{harness.destroyDocument();globalThis.fetch=oldFetch;}
  });
}

test('backToOwner flushes the profile first and remains fenced until document replacement',async()=>{
  client.setCurrentUser(A.id);client.setAccessToken('credential-a');const harness=provider(),oldFetch=globalThis.fetch,sent:string[]=[];
  globalThis.fetch=(async(input:any)=>{sent.push(String(input));return response();}) as typeof fetch;
  try{
    const moving=harness.auth.backToOwner();await harness.purging.promise;
    assert.equal(client.getCurrentUser(),null);assert.equal(client.getAccessToken(),null);
    assert.ok(harness.events.includes(`flush:${A.id}:credential-a`));
    harness.ready.resolve({active:{postMessage(){}}});assert.equal(await moving,true);assert.equal(harness.reloads(),1);
    await assert.rejects(()=>client.api('/api/retained-profile-action',{json:{old:true}}),(error:any)=>error instanceof client.ApiError&&error.status===409);
    assert.deepEqual(sent,['/auth/desktop']);
  }finally{harness.destroyDocument();globalThis.fetch=oldFetch;}
});

for(const method of ['logout','leave'] as const){
  test(`${method}: clearing an account keeps the document fenced through reload`,async()=>{
    client.setCurrentUser(A.id);client.setAccessToken('credential-a');const harness=provider(),oldFetch=globalThis.fetch;
    globalThis.fetch=(async()=>new Response('{}',{headers:{'content-type':'application/json'}})) as typeof fetch;
    try{
      const leaving=harness.auth[method]();await harness.purging.promise;
      assert.equal(client.getCurrentUser(),null);assert.equal(client.getAccessToken(),null);assert.equal(harness.state[0],'loading');
      harness.ready.resolve({active:{postMessage(){}}});await leaving;
      assert.equal(harness.reloads(),1);assert.equal(harness.releases(),0);
      await assert.rejects(()=>client.api('/auth/login',{json:{username:'b',password:'fixture-password'}}),(error:any)=>error instanceof client.ApiError&&error.status===409);
    }finally{harness.destroyDocument();globalThis.fetch=oldFetch;}
  });
  test(`${method}: an obsolete sign-out response cannot clear the next account`,async()=>{
    client.setCurrentUser(A.id);client.setAccessToken('credential-a');const harness=provider(),oldFetch=globalThis.fetch,reply=deferred<Response>();
    globalThis.fetch=(()=>reply.promise) as typeof fetch;
    try{
      const leaving=harness.auth[method]();client.setCurrentUser(B.id);client.setAccessToken('credential-b');
      reply.resolve(new Response('{}',{headers:{'content-type':'application/json'}}));await leaving;
      assert.equal(client.getCurrentUser(),B.id);assert.equal(client.getAccessToken(),'credential-b');
      assert.equal(harness.reloads(),0);assert.ok(!harness.events.includes('purge'));
    }finally{harness.destroyDocument();globalThis.fetch=oldFetch;}
  });
}

for(const method of ['login','switchProfile'] as const){
  test(`${method}: native account replacement preserves the owner fence without a service worker`,async()=>{
    client.setCurrentUser(A.id);client.setAccessToken('credential-a');
    const harness=provider({native:true}),oldFetch=globalThis.fetch;
    globalThis.fetch=(async()=>response()) as typeof fetch;
    try{
      const result=method==='login'?await harness.auth.login('b','fixture-password'):await harness.auth.switchProfile(B.id);
      assert.equal(result.ok,true);
      assert.equal(harness.reloads(),1);
      assert.equal(client.getCurrentUser(),null);assert.equal(client.getAccessToken(),null);
      assert.equal(harness.state[0],'loading');assert.equal(harness.state[1],null);
      assert.ok(harness.events.includes(`persist:${B.id}:null:null`),'trusted offline identity is saved only for the new document');
      assert.ok(!harness.events.includes('token:credential-b')&&!harness.events.includes(`identity:${B.id}`));
      await assert.rejects(()=>client.api('/api/stale-native-form',{json:{old:true}}),(error:any)=>error instanceof client.ApiError&&error.status===409);
    }finally{harness.destroyDocument();globalThis.fetch=oldFetch;}
  });
}
