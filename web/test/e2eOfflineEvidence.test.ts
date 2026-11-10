// Execute the browser harness's actual classifier, including negative cases that must stay failures.
import test from'node:test';
import assert from'node:assert/strict';
import {takePlannedOfflineFailure as classify,plannedOfflineEvidence}from'./e2e/plannedOfflineEvidence.mjs';
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
