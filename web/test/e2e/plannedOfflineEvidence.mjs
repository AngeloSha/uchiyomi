// Browser console events can arrive after a planned network cut has ended. Match each one to one
// actual failed request, never to the current global offline flag or a URL alone.
export function takePlannedOfflineFailure(entry,failures){
  const match=/^Failed to load resource:\s+(net::ERR_(?:INTERNET_DISCONNECTED|FAILED)) (.+)$/.exec(entry);
  if(!match)return false;
  const failure=failures.find(row=>!row.classified&&(row.startedOffline===true||row.failedDuringPlannedCut===true)&&row.url===match[2]&&row.errorText===match[1]);
  if(!failure)return false;
  failure.classified=true;return true;
}
/** @param {() => string} [connectivity] Diagnostic phase only; request/cut booleans decide classification. */
export function plannedOfflineEvidence(page,isOffline,phase=()=> 'browser walk',connectivity=()=>isOffline()?'cut':'online'){
  const requests=new WeakMap(),failures=[];
  page.on('request',request=>requests.set(request,{url:request.url(),method:request.method(),startedOffline:isOffline(),phase:phase(),connectivity:connectivity()}));
  page.on('requestfailed',request=>{
    const started=requests.get(request),errorText=request.failure()?.errorText;
    if(started&&/^net::ERR_(?:INTERNET_DISCONNECTED|FAILED)$/.test(errorText||''))failures.push({...started,errorText,failedDuringPlannedCut:isOffline(),failurePhase:phase(),failureConnectivity:connectivity(),classified:false});
  });
  return{failures,take:entry=>takePlannedOfflineFailure(entry,failures)};
}

// Restoring CDP's emulation can release a queued online event before Chromium's network has recovered.
// End the explicit cut only after a fresh, uncached server response proves connectivity. Request events
// from before that boundary retain their own evidence; failures started afterward remain unexpected.
export async function restorePlannedOnline(page,onVerified,{origin,phase='browser walk'}){
  const probe=new URL('/livez',origin);
  probe.searchParams.set('e2e-reconnect',`${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const startedAtEpoch=Date.now();
  await page.setOfflineMode(false);
  const response=await page.evaluate(async address=>{
    const response=await fetch(address,{cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(5000)});
    const json=response.headers.get('content-type')?.includes('application/json')?await response.json():null;
    return{status:response.status,ok:json?.ok===true,online:navigator.onLine};
  },probe.href);
  if(response.status!==200||!response.ok||!response.online)throw new Error(`Reconnect probe failed: ${JSON.stringify(response)}`);
  const proof={state:'verified-online',phase,url:probe.href,startedAtEpoch,verifiedAtEpoch:Date.now(),...response};
  // No await here: all requests emitted after this verified response are ONLINE. The app may keep
  // background requests active, so waiting for global network-idle would add an unrelated failure gate.
  onVerified(proof);
  return proof;
}
