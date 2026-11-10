// Browser console events can arrive after a planned network cut has ended. Match each one to one
// actual failed request, never to the current global offline flag or a URL alone.
export function takePlannedOfflineFailure(entry,failures){
  const match=/^Failed to load resource:\s+(net::ERR_(?:INTERNET_DISCONNECTED|FAILED)) (.+)$/.exec(entry);
  if(!match)return false;
  const failure=failures.find(row=>!row.classified&&(row.startedOffline===true||row.failedDuringPlannedCut===true)&&row.url===match[2]&&row.errorText===match[1]);
  if(!failure)return false;
  failure.classified=true;return true;
}
export function plannedOfflineEvidence(page,isOffline,phase=()=> 'browser walk'){
  const requests=new WeakMap(),failures=[];
  page.on('request',request=>requests.set(request,{url:request.url(),method:request.method(),startedOffline:isOffline(),phase:phase()}));
  page.on('requestfailed',request=>{
    const started=requests.get(request),errorText=request.failure()?.errorText;
    if(started&&/^net::ERR_(?:INTERNET_DISCONNECTED|FAILED)$/.test(errorText||''))failures.push({...started,errorText,failedDuringPlannedCut:isOffline(),failurePhase:phase(),classified:false});
  });
  return{failures,take:entry=>takePlannedOfflineFailure(entry,failures)};
}
