// Real loopback app regression: account-owned locale, auth lifetime and delayed dictionary completion.
// Core APIs are never mocked. The race step holds and then forwards a real static dictionary request.
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID}from'node:crypto';
import {mkdirSync,writeFileSync}from'node:fs';
import {fixtureLogin,waitForLoginCooldown}from'./loginCooldown.mjs';

const base=process.env.BASE||'http://127.0.0.1:18330';
const parsed=new URL(base);
assert.ok(parsed.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(parsed.hostname),'disposable loopback preview required');
const out=process.env.OUT||'/tmp/uchiyomi-locale-session';mkdirSync(out,{recursive:true});
const nonce=randomUUID().replaceAll('-',''),password=`Locale-${randomBytes(24).toString('base64url')}-A9`;
const accounts=[],checks=[],failures=[],consoleErrors=[],serverErrors=[],expectedNetwork=[],settingsRequests=[],authRequests=[];
const held=[],dictionaryDeliveries=[];let holdDictionary=false,browser,page,adminToken,first,second,tokenA,tokenB,offline=false,loginAttempt=-1,step=0;
const check=(name,pass,detail='')=>{checks.push({name,pass:!!pass,...(!pass?{detail}:{})});console.log(`[${pass?'PASS':'FAIL'}] ${name}${!pass?' '+detail:''}`);if(!pass)failures.push(name);};
const shot=name=>page.screenshot({path:`${out}/${String(++step).padStart(2,'0')}-${name}.png`,waitForFonts:false});
async function api(path,{method='GET',body,token=adminToken}={}){
  const response=await fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}return{status:response.status,data};
}
async function clickText(text,selector='button'){
  await page.waitForFunction((text,selector)=>[...document.querySelectorAll(selector)].some(node=>node.getClientRects().length>0&&!node.disabled&&
    (node.textContent?.trim()===text||[...node.querySelectorAll('span')].some(span=>span.textContent?.trim()===text))),{timeout:30000},text,selector);
  for(const button of await page.$$(selector))if(await button.isVisible()&&await button.evaluate((node,text)=>node.textContent?.trim()===text||[...node.querySelectorAll('span')].some(span=>span.textContent?.trim()===text),text)){
    await button.asLocator().click();return;
  }
  throw new Error('No visible button '+text);
}
async function locale(lang,dir=lang==='ar'?'rtl':'ltr'){
  await page.waitForFunction((lang,dir)=>document.documentElement.lang===lang&&document.documentElement.dir===dir,{timeout:30000},lang,dir);
}
async function login(account){
  await page.waitForSelector('form input[type=password]',{visible:true});
  for(let attempt=0;attempt<2;attempt++){
    loginAttempt=attempt;await page.locator('form input[type=text]').fill(account.username);await page.locator('form input[type=password]').fill(password);
    const pending=page.waitForResponse(response=>new URL(response.url()).pathname==='/auth/login'&&response.request().method()==='POST');
    await page.locator('form button[type=submit]').click();const response=await pending;
    if(response.status()===429&&attempt===0){await waitForLoginCooldown(response.headers()['retry-after']);continue;}
    assert.equal(response.status(),200,'fixture browser sign-in');assert.equal((await response.json()).user.id,account.id);break;
  }
  loginAttempt=-1;await page.waitForSelector('[data-topbar]',{visible:true});await page.waitForSelector('form input[type=password]',{hidden:true});
}
function subject(request){
  const value=request.headers().authorization||'';
  try{return JSON.parse(Buffer.from(value.replace(/^Bearer /,'').split('.')[1],'base64url')).sub||null;}catch{return null;}
}
async function selectLanguage(code){await page.waitForSelector('#language select');await page.select('#language select',code);}
try{
  adminToken=(await(await fixtureLogin(base,{username:process.env.E2E_USER||'e2e',password:process.env.E2E_PASS||'e2e-passw0rd-123'})).json()).accessToken;
  const a=await api('/api/admin/users',{method:'POST',body:{username:`ls_a_${nonce}`,displayName:`Locale owner ${nonce}`,password,role:'admin'}});
  assert.equal(a.status,200,JSON.stringify(a.data));first=a.data;accounts.push(first);
  const b=await api('/api/admin/users',{method:'POST',body:{username:`ls_b_${nonce}`,displayName:`Locale profile ${nonce}`,password,role:'user',localOpen:true,managedBy:first.id}});
  assert.equal(b.status,200,JSON.stringify(b.data));second=b.data;accounts.push(second);
  tokenA=(await(await fixtureLogin(base,{username:first.username,password})).json()).accessToken;
  tokenB=(await(await fixtureLogin(base,{username:second.username,password})).json()).accessToken;
  assert.equal((await api('/api/settings',{token:tokenA,method:'PUT',body:{lang:'ar'}})).status,200);
  assert.equal((await api('/api/settings',{token:tokenB,method:'PUT',body:{lang:'de'}})).status,200);
  browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
  page=await browser.newPage();await page.setViewport({width:1280,height:900});
  page.on('pageerror',error=>consoleErrors.push(error.message));
  page.on('console',message=>{if(message.type()!=='error')return;const text=message.text(),url=message.location()?.url||'';
    if(/401/.test(text)&&[base+'/auth/refresh',base+'/auth/me'].includes(url)){expectedNetwork.push('anonymous auth refusal: '+url);return;}
    if(loginAttempt===0&&/429/.test(text)&&url===base+'/auth/login'){expectedNetwork.push('advertised sign-in cooldown');return;}
    if(offline&&/net::ERR_(?:INTERNET_DISCONNECTED|FAILED)/.test(text)&&url.startsWith(base+'/')){expectedNetwork.push('deliberate offline: '+url);return;}
    consoleErrors.push(text+' '+url);
  });
  page.on('response',response=>{if(response.status()>=500)serverErrors.push(response.status()+' '+response.url());});
  page.on('request',request=>{
    const path=new URL(request.url()).pathname;
    if(['/auth/refresh','/auth/login','/auth/switch'].includes(path))authRequests.push({path,method:request.method()});
    if(path==='/api/settings'){
      let body;try{body=JSON.parse(request.postData()||'null');}catch{}
      settingsRequests.push({method:request.method(),subject:subject(request),lang:body?.lang??null,offline});
    }
  });
  await page.goto(base,{waitUntil:'networkidle2'});await page.waitForSelector('form input[type=password]',{visible:true});
  await page.evaluate(()=>localStorage.setItem('uchiyomi.lang','fr'));await page.reload({waitUntil:'networkidle2'});await locale('fr');
  check('anonymous device locale renders without account settings traffic',settingsRequests.length===0);
  check('anonymous locale choice never writes server preferences',settingsRequests.every(request=>request.method!=='PUT'));
  await shot('anonymous-french');
  await login(first);await locale('ar');
  check('fresh password login adopts the account saved Arabic language',await page.evaluate(()=>/[؀-ۿ]/.test(document.body.innerText)));
  check('fresh password login sets RTL',await page.evaluate(()=>document.documentElement.dir==='rtl'));
  check('authenticated locale fetch belongs to the signed-in account',settingsRequests.some(request=>request.method==='GET'&&request.subject===first.id));
  await shot('password-login-arabic');
  const beforeCold=authRequests.filter(request=>request.path==='/auth/refresh').length;
  const coldSession=page.waitForResponse(response=>new URL(response.url()).pathname==='/auth/refresh'&&response.status()===200);
  await page.evaluate(()=>{localStorage.clear();sessionStorage.clear();});await page.reload({waitUntil:'networkidle2'});await page.waitForSelector('[data-topbar]');await locale('ar');
  check('cold boot with fresh storage and retained cookie restores saved language',authRequests.filter(request=>request.path==='/auth/refresh').length>beforeCold);
  check('cold boot restored the correct account',(await(await coldSession).json()).user.id===first.id);
  await page.goto(base+'/profile/?tab=settings',{waitUntil:'networkidle2'});await locale('ar');await page.waitForSelector('#language select');
  const beforeTap=authRequests.length,documents=[];const documentListener=request=>{if(request.isNavigationRequest()&&request.frame()===page.mainFrame())documents.push(request.url());};page.on('request',documentListener);
  const savedEnglish=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/settings'&&response.request().method()==='PUT');
  await selectLanguage('en');assert.equal((await savedEnglish).status(),200);await locale('en');await page.waitForSelector('#language select');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  check('language tap preserves the auth session without another login or refresh',authRequests.length===beforeTap);
  check('language tap does not navigate or reload the document',documents.length===0);page.off('request',documentListener);
  check('language tap writes only the current account',(await api('/api/settings',{token:tokenA})).data.lang==='en'&&(await api('/api/settings',{token:tokenB})).data.lang==='de');

  // To delay only this asset reliably, bypass the worker during the race step. All APIs still reach the
  // real app; no response body is mocked, and the worker is restored before the actual offline launch.
  await page.setBypassServiceWorker(true);await page.setRequestInterception(true);holdDictionary=true;
  const intercept=request=>{
    if(holdDictionary&&new URL(request.url()).pathname==='/locales/ja.json'){held.push(request);return;}
    void request.continue().catch(()=>{});
  };page.on('request',intercept);
  const savedJapanese=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/settings'&&response.request().method()==='PUT');
  await selectLanguage('ja');assert.equal((await savedJapanese).status(),200);
  for(let attempt=0;attempt<100&&held.length===0;attempt++)await new Promise(resolve=>setTimeout(resolve,25));
  assert.ok(held.length,'the race must hold an actual uncached dictionary request');
  const documentMarker=randomUUID();await page.evaluate(value=>{window.__localeSessionDocument=value;},documentMarker);
  const savedFrench=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/settings'&&response.request().method()==='PUT');
  await selectLanguage('fr');assert.equal((await savedFrench).status(),200);await locale('fr');
  check('a newer same-account language choice applies while the older dictionary is held',true);
  holdDictionary=false;
  for(const request of held){
    const delivered=page.waitForResponse(response=>response.request()===request,{timeout:30000});void delivered.catch(()=>{});
    await request.continue();const response=await delivered;assert.equal(response.status(),200);await response.buffer();
    dictionaryDeliveries.push({outcome:'real earlier dictionary response completed in the same document'});
  }
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  check('the real late dictionary cannot overwrite a newer same-account choice',await page.evaluate(value=>window.__localeSessionDocument===value&&document.documentElement.lang==='fr'&&document.documentElement.dir==='ltr'&&localStorage.getItem('uchiyomi.lang')==='fr',documentMarker));
  page.off('request',intercept);await page.setRequestInterception(false);await page.setBypassServiceWorker(false);
  const savedEnglishAgain=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/settings'&&response.request().method()==='PUT');
  await selectLanguage('en');assert.equal((await savedEnglishAgain).status(),200);await locale('en');
  const switched=page.waitForResponse(response=>new URL(response.url()).pathname==='/auth/switch'&&response.request().method()==='POST');void switched.catch(()=>{});
  await page.locator('[data-topbar] [aria-label="You"]').click();await clickText('Switch profile');await clickText(second.display_name||second.displayName||`Locale profile ${nonce}`,'[data-switch-profile]');
  const switchResponse=await switched;assert.equal(switchResponse.status(),200);assert.equal((await switchResponse.json()).user.id,second.id);
  await page.waitForFunction(()=>window.__localeSessionDocument===undefined,{timeout:30000});
  check('account switch replaces the previous JavaScript document',true);await locale('de');
  check('profile switch adopts the second account saved language and direction',await page.evaluate(()=>document.documentElement.dir==='ltr'&&localStorage.getItem('uchiyomi.lang')==='de'));
  check('previous-account language choices were never submitted as the next account',(await api('/api/settings',{token:tokenA})).data.lang==='en'&&(await api('/api/settings',{token:tokenB})).data.lang==='de');
  await shot('profile-switch-owned-language');
  await page.goto(base+'/profile/?tab=settings',{waitUntil:'networkidle2'});await locale('de');await page.waitForSelector('#language select');await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  const beforeOffline=settingsRequests.filter(request=>request.method==='PUT').length;
  offline=true;await page.setOfflineMode(true);await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('[data-topbar]');await locale('de');
  // Offline accounts intentionally enter Downloads; Settings is not an offline editing surface.
  check('offline cold boot retains B saved locale on the supported Downloads surface',new URL(page.url()).pathname==='/downloads/'&&await page.evaluate(id=>JSON.parse(localStorage.getItem('uchiyomi.offlineUser')||'null')?.id===id,second.id));
  check('offline boot never submits a preference change',settingsRequests.filter(request=>request.method==='PUT').length===beforeOffline);
  await shot('offline-owned-language');
  await page.setOfflineMode(false);offline=false;await locale('de');
  check('same-account offline-to-online transition reloads the saved account language',true);
  check('online settings and every preference write have an authenticated owner',settingsRequests.filter(request=>!request.offline||request.method==='PUT').every(request=>request.subject===first.id||request.subject===second.id));
}catch(error){failures.push(error.stack||error.message);console.error(error.stack||error.message);if(page&&!page.isClosed()){await shot('failure').catch(()=>{});writeFileSync(`${out}/failure-page.txt`,page.url()+'\n'+await page.$eval('body',node=>node.innerText).catch(()=>''));}}
finally{
  holdDictionary=false;for(const request of held)if(!request.isInterceptResolutionHandled())await request.continue().catch(()=>{});
  await browser?.close();
  for(const account of [...accounts].reverse())try{const response=await api('/api/admin/users/'+account.id,{method:'DELETE'});assert.equal(response.status,200,JSON.stringify(response.data));}catch(error){failures.push('fixture-only cleanup '+account.id+': '+error.message);}
  const result={base,image:process.env.E2E_IMAGE||null,checks,failures,consoleErrors,serverErrors,expectedNetwork,settingsRequests,authRequests,
    dictionaryDelay:{actualRequests:held.length,deliveries:dictionaryDeliveries,responsesMocked:false,serviceWorkerBypassedOnlyForDelay:true},fixtures:{first:first?.id,second:second?.id}};
  writeFileSync(`${out}/result.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({checks:checks.length,passed:checks.filter(check=>check.pass).length,failures,consoleErrors,serverErrors}));
  process.exitCode=failures.length||consoleErrors.length||serverErrors.length?1:0;
}
