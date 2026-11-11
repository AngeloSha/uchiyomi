// Execute the browser harness's actual classifier, including negative cases that must stay failures.
import test from'node:test';
import assert from'node:assert/strict';
import {takePlannedOfflineFailure as classify,plannedOfflineEvidence,restorePlannedOnline}from'./e2e/plannedOfflineEvidence.mjs';
const url='http://127.0.0.1:18360/auth/refresh',entry='Failed to load resource: net::ERR_INTERNET_DISCONNECTED '+url;
const failed=(overrides:any={})=>({url,method:'POST',startedOffline:true,errorText:'net::ERR_INTERNET_DISCONNECTED',classified:false,...overrides});
test('a late console event can match its exact failed request that started in a planned cut',()=>{const rows=[failed()];assert.equal(classify(entry,rows),true);assert.equal(rows[0].classified,true);});
test('an online-started request interrupted while the explicit cut is active has concrete planned-cut evidence',()=>{const rows=[failed({startedOffline:false,failedDuringPlannedCut:true})];assert.equal(classify(entry,rows),true);assert.equal(rows[0].classified,true);});
test('an online request with the same URL/error is never classified as a planned cut',()=>{assert.equal(classify(entry,[failed({startedOffline:false})]),false);assert.equal(classify(entry,[]),false);});
test('different URLs/error kinds and HTTP/script failures stay unexpected',()=>{for(const value of [entry+'-other',entry.replace('INTERNET_DISCONNECTED','FAILED'),'Failed to load resource: the server responded with a status of 500 '+url,'Uncaught net::ERR_INTERNET_DISCONNECTED '+url])assert.equal(classify(value,[failed()]),false);});
test('one planned failed request cannot hide a second unrelated console failure at the same URL',()=>{const rows=[failed()];assert.equal(classify(entry,rows),true);assert.equal(classify(entry,rows),false);});
test('actual event hooks retain start and failure evidence after connectivity is restored',()=>{
  const handlers:Record<string,Function>={};let offline=false;
  const evidence=plannedOfflineEvidence({on:(name:string,fn:Function)=>{handlers[name]=fn;}},()=>offline);
  const request={url:()=>url,method:()=> 'POST',failure:()=>({errorText:'net::ERR_INTERNET_DISCONNECTED'})};
  handlers.request(request);offline=true;handlers.requestfailed(request);offline=false;
  assert.equal(evidence.failures[0].startedOffline,false);assert.equal(evidence.failures[0].failedDuringPlannedCut,true);assert.equal(evidence.take(entry),true);
});
test('actual event hooks never approve an online failure or a non-network abort',()=>{
  const handlers:Record<string,Function>={};let offline=false;
  const evidence=plannedOfflineEvidence({on:(name:string,fn:Function)=>{handlers[name]=fn;}},()=>offline);
  const online={url:()=>url,method:()=> 'POST',failure:()=>({errorText:'net::ERR_INTERNET_DISCONNECTED'})};
  handlers.request(online);handlers.requestfailed(online);assert.equal(evidence.take(entry),false);
  offline=true;const aborted={...online,failure:()=>({errorText:'net::ERR_ABORTED'})};handlers.request(aborted);handlers.requestfailed(aborted);
  assert.equal(evidence.failures.length,1);assert.equal(evidence.take(entry),false);
});
test('reconnect waits for an uncached server probe and keeps late pre-probe requests distinguishable from new online failures',async()=>{
  const handlers:Record<string,Function>={};let offline=true,connectivity='reconnecting',probeAddress='',probeOptions:any;
  const events:string[]=[];
  const evidence=plannedOfflineEvidence({on:(name:string,fn:Function)=>{handlers[name]=fn;}},()=>offline,()=> 'offline return',()=>connectivity);
  const request=()=>({url:()=>url,method:()=> 'POST',failure:()=>({errorText:'net::ERR_INTERNET_DISCONNECTED'})});
  const beforeProbe=request();
  const page={
    async setOfflineMode(value:boolean){assert.equal(value,false);events.push('restore-emulation');},
    async evaluate(probe:Function,address:string){
      probeAddress=address;assert.equal(offline,true,'restoring the emulation is not proof of connectivity');
      handlers.request(beforeProbe);
      const oldFetch=globalThis.fetch,oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
      try{
        Object.defineProperty(globalThis,'navigator',{value:{onLine:true},configurable:true});
        globalThis.fetch=(async(_address:string,options:any)=>{assert.equal(_address,address);probeOptions=options;return new Response('{"ok":true}',{status:200,headers:{'content-type':'application/json'}});}) as any;
        const result=await probe(address);events.push('probe-verified');return result;
      }finally{globalThis.fetch=oldFetch;if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else delete (globalThis as any).navigator;}
    },
  };
  const proof=await restorePlannedOnline(page,()=>{offline=false;connectivity='online';events.push('online-boundary');},{origin:'http://127.0.0.1:18360',phase:'offline return'});
  assert.equal(offline,false,'requests become online immediately after the probe');
  handlers.requestfailed(beforeProbe);
  const afterProbe=request();handlers.request(afterProbe);handlers.requestfailed(afterProbe);
  assert.deepEqual(events,['restore-emulation','probe-verified','online-boundary']);
  assert.equal(new URL(probeAddress).pathname,'/livez');assert.ok(new URL(probeAddress).searchParams.get('e2e-reconnect'));
  assert.equal(probeOptions.cache,'no-store');assert.equal(probeOptions.credentials,'omit');assert.equal(probeOptions.redirect,'error');
  assert.equal(proof.status,200);assert.equal(proof.phase,'offline return');assert.ok(proof.verifiedAtEpoch>=proof.startedAtEpoch);
  assert.equal(evidence.failures[0].connectivity,'reconnecting');assert.equal(evidence.failures[0].failureConnectivity,'online');
  assert.equal(evidence.take(entry),true,'late failure of pre-probe request has concrete cut evidence');
  assert.equal(evidence.take(entry),false,'identical failure of post-probe online request stays unexpected');
});
test('a rejected reconnect probe never declares the browser online or silently retries',async()=>{
  let online=false,attempts=0,drained=false;
  const page={async setOfflineMode(){},async evaluate(){attempts++;return{status:503,ok:false,online:true};},async waitForNetworkIdle(){drained=true;}};
  await assert.rejects(restorePlannedOnline(page,()=>{online=true;},{origin:'http://127.0.0.1:18360'}),/Reconnect probe failed/);
  assert.equal(online,false);assert.equal(drained,false);assert.equal(attempts,1);
});
