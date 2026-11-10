// Real server/browser acceptance. Creates only uniquely named fixture accounts/content and removes them.
// No response interception: service workers, image upload, permissions and offline IndexedDB are real.
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { randomBytes, randomUUID } from 'node:crypto';
import { fixtureLogin, waitForLoginCooldown } from './loginCooldown.mjs';
import { plannedOfflineEvidence } from './plannedOfflineEvidence.mjs';

const base=process.env.BASE||'http://127.0.0.1:18310';
const url=new URL(base);
assert.ok(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname),'disposable loopback preview required');
const out=process.env.OUT||'/tmp/uchiyomi-private-library-walk';mkdirSync(out,{recursive:true});
const nonce=randomUUID().replaceAll('-','');
const nativeProbeCache='uchi-private-native-cache-'+nonce;
const title=`Private browser fixture ${nonce}`,password=`Fixture-${randomBytes(24).toString('base64url')}-A9`;
const accounts=[],checks=[],failures=[],consoleErrors=[],serverErrors=[],expectedNetworkResponses=[],authResponses=[],expectedErrors=new Set();
let browser,page,adminToken,ownerToken,otherToken,owner,other,seriesId,bookId,loginAttempt=-1,offline=false,step=0,authTransition=true,nativeOwnerProbe,nativeOtherProbe,offlineEvidence;
const check=(name,condition,detail='')=>{checks.push({name,pass:!!condition,...(!condition?{detail}:{} )});console.log(`[${condition?'PASS':'FAIL'}] ${name}${!condition?' '+detail:''}`);if(!condition)failures.push(name);};
const shot=async name=>page.screenshot({path:`${out}/${String(++step).padStart(2,'0')}-${name}.png`,waitForFonts:false});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function raw(path,{token=adminToken,method='GET',body,headers={}}={}){
  const response=await fetch(base+path,{method,headers:{...(token?{authorization:`Bearer ${token}`}:{ } ),...(body&&!(body instanceof FormData)?{'content-type':'application/json'}:{}),...headers},
    ...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:response.status,data,headers:Object.fromEntries(response.headers)};
}
async function uiRequest(path,{token=ownerToken,method='GET',body,expected}={}){
  if(expected>=400)expectedErrors.add(base+path);
  return page.evaluate(async({path,token,method,body})=>{
    try{const response=await fetch(path,{method,headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
      const type=response.headers.get('content-type')||'';return{status:response.status,data:type.includes('json')?await response.json():null,headers:Object.fromEntries(response.headers)};
    }catch{return{status:0,data:null,headers:{}};}
  },{path,token,method,body});
}
async function clickText(text,scope='button'){
  const candidates=await page.$$(scope);
  for(const candidate of candidates)if(await candidate.evaluate((el,text)=>el.textContent?.trim()===text,text)){
    await page.waitForFunction(el=>!el.disabled,{timeout:60000},candidate);await candidate.click();return;
  }
  throw new Error(`Missing visible ${scope}: ${text}`);
}
async function signIn(account){
  authTransition=true;
  await page.goto(base,{waitUntil:'networkidle2'});await page.waitForSelector('form input[type=password]',{visible:true});
  let token;
  for(let attempt=0;attempt<2;attempt++){
    loginAttempt=attempt;
    await page.locator('form input[type=text]').fill(account.username);await page.locator('form input[type=password]').fill(password);
    const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/auth/login'&&r.request().method()==='POST');
    await page.locator('form button[type=submit]').click();const response=await pending;
    if(response.status()===429&&attempt===0){await waitForLoginCooldown(response.headers()['retry-after']);continue;}
    assert.equal(response.status(),200,'fixture browser login');token=(await response.json()).accessToken;break;
  }
  loginAttempt=-1;await page.waitForSelector('[data-topbar]',{visible:true});await page.waitForSelector('form input[type=password]',{hidden:true});authTransition=false;return token;
}
async function signOut(){
  authTransition=true;
  await page.goto(base+'/profile/?tab=account',{waitUntil:'networkidle2'});await page.waitForSelector('#sign-out');
  await clickText('Sign out','#sign-out button');await page.waitForSelector('form input[type=password]',{visible:true});
}
async function dbChapters(){return page.evaluate(()=>new Promise((resolve,reject)=>{
  const request=indexedDB.open('yomi-offline');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;
    if(!db.objectStoreNames.contains('chapters')){db.close();return resolve([]);}
    const read=db.transaction('chapters').objectStore('chapters').getAll();read.onsuccess=()=>{const rows=read.result.map(r=>({key:r.key,userId:r.userId,bookId:r.bookId,seriesTitle:r.seriesTitle}));db.close();resolve(rows);};read.onerror=()=>{db.close();reject(read.error);};
  };}));}
async function privateCacheEntries(){return page.evaluate(async({seriesId,bookId})=>{
  const found=[];for(const name of await caches.keys())for(const request of await(await caches.open(name)).keys())
    if(request.url.includes(seriesId)||request.url.includes(bookId))found.push({cache:name,url:request.url});return found;
},{seriesId,bookId});}
// A real 320x480 RGB PNG, enough to exercise decoding, image upload, thumbnails and offline byte storage.
function png(){
  const crc=buffer=>{let value=0xffffffff;for(const byte of buffer){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};
  const chunk=(name,data)=>{const kind=Buffer.from(name),length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([kind,data])));return Buffer.concat([length,kind,data,sum]);};
  const width=320,height=480,header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const pixels=Buffer.alloc((width*3+1)*height);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*(width*3+1)+1+x*3;pixels[i]=(x+y)%256;pixels[i+1]=(2*x+y)%256;pixels[i+2]=(x+2*y)%256;}
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
try{
  adminToken=(await(await fixtureLogin(base,{username:process.env.E2E_USER||'e2e',password:process.env.E2E_PASS||'e2e-passw0rd-123'})).json()).accessToken;
  for(const kind of ['owner','other']){
    const response=await raw('/api/admin/users',{method:'POST',body:{username:`pw_${kind}_${nonce}`,password,role:'user',perms:{canUploadManually:true}}});
    assert.equal(response.status,200,'create isolated fixture account');accounts.push(response.data);
  }
  [owner,other]=accounts;
  browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});page=await browser.newPage();await page.setViewport({width:1280,height:900});
  offlineEvidence=plannedOfflineEvidence(page,()=>offline,()=>checks.at(-1)?.name||'setup');
  page.on('pageerror',error=>consoleErrors.push(error.message));
  page.on('console',message=>{if(message.type()!=='error')return;const location=message.location()?.url||'',text=message.text();
    if(/401/.test(text)&&[base+'/auth/me',base+'/auth/refresh'].includes(location))return;
    if(authTransition&&/401/.test(text)&&location===base+'/api/settings'){expectedNetworkResponses.push('anonymous settings401 during auth transition');return;}
    if(loginAttempt===0&&/429/.test(text)&&location===base+'/auth/login')return;
    if(expectedErrors.has(location)&&/Failed to load resource/.test(text))return;
    consoleErrors.push(`${text} ${location}`);
  });
  page.on('response',response=>{if(response.status()>=500)serverErrors.push(`${response.status()} ${response.url()}`);
    if(response.status()===401&&response.url().startsWith(base+'/api/'))authResponses.push({url:response.url(),method:response.request().method(),authTransition,hadAuthorization:!!response.request().headers().authorization,phase:checks.at(-1)?.name||'bootstrap'});
  });
  ownerToken=await signIn(owner);
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});await page.reload({waitUntil:'networkidle2'});
  check('service worker remains enabled and controls the page',await page.evaluate(()=>!!navigator.serviceWorker.controller));
  await page.goto(base+'/profile/?tab=settings',{waitUntil:'networkidle2'});await page.waitForSelector('#private-additions');
  const toggle=await page.$('#private-additions [role=switch],#private-additions[role=switch]');assert.ok(toggle,'private-default switch');
  check('new accounts default to shared additions',await toggle.evaluate(el=>el.getAttribute('aria-checked')==='false'));
  await toggle.click();await page.waitForFunction(()=>document.querySelector('#private-additions [role=switch],#private-additions[role=switch]')?.getAttribute('aria-checked')==='true');
  await page.reload({waitUntil:'networkidle2'});await page.waitForFunction(()=>document.querySelector('#private-additions [role=switch],#private-additions[role=switch]')?.getAttribute('aria-checked')==='true');
  check('default-private preference survives reload',(await uiRequest('/api/personal/privacy')).data.defaultPrivate===true);
  const image=png(),form=new FormData();form.append('pages',new Blob([image],{type:'image/png'}),'001.png');
  const upload=await raw('/api/library/upload?'+new URLSearchParams({title,name:'Chapter 1.cbz',fresh:'1',images:'1'}),{token:ownerToken,method:'POST',body:form});
  assert.equal(upload.status,200,JSON.stringify(upload.data));assert.equal(upload.data.indexed,true);seriesId=upload.data.seriesId;bookId=upload.data.bookId;
  check('real PNG upload obeys account default without a visibility override',!!seriesId&&!!bookId&&upload.data.file.startsWith(`_private/${owner.id}/`));
  for(const path of [`/api/series/${seriesId}`,`/api/books/${bookId}/download-manifest`,`/img/books/${bookId}/page/1`]){
    const response=await uiRequest(path);check('owner receives private, uncached '+path.split('/').slice(1,3).join('/'),response.status===200&&response.headers['x-uchiyomi-private']==='1'&&/no-store/.test(response.headers['cache-control']||''));
  }
  // Native Cache.put is exactly what older workers call without checking Cache-Control. Keep SW
  // enabled: this separate fixture cache probes browser enforcement, not the new worker's own filter.
  nativeOwnerProbe=await page.evaluate(async({bookId,name})=>{
    const request=new Request(`/img/books/${bookId}/page/1`,{credentials:'include'}),response=await fetch(request),cache=await caches.open(name);
    let rejected=false,error='';try{await cache.put(request,response.clone());}catch(cause){rejected=true;error=cause.name;}
    return{status:response.status,vary:response.headers.get('vary'),privateHeader:response.headers.get('x-uchiyomi-private'),cookie:request.headers.get('cookie'),authorization:request.headers.get('authorization'),rejected,error,entries:(await cache.keys()).length};
  },{bookId,name:nativeProbeCache});
  check('private cookie-only images reject native Cache.put even in legacy workers',nativeOwnerProbe.status===200&&nativeOwnerProbe.privateHeader==='1'&&nativeOwnerProbe.vary?.split(',').some(value=>value.trim()==='*')&&nativeOwnerProbe.cookie===null&&nativeOwnerProbe.authorization===null&&nativeOwnerProbe.rejected&&nativeOwnerProbe.error==='TypeError'&&nativeOwnerProbe.entries===0);
  await page.goto(`${base}/series/?id=${seriesId}`,{waitUntil:'networkidle2'});await page.waitForSelector('[data-series-privacy]');
  check('member owner sees private controls',(await page.$eval('[data-series-privacy]',el=>el.innerText)).includes('Private library'));
  await clickText('Manage private copy');await page.waitForSelector(`[data-private-copy="${seriesId}"]`);
  const card=`[data-private-copy="${seriesId}"]`;
  if((await page.$eval(card,el=>el.innerText)).includes('Resume updates'))await clickText('Resume updates',card+' button');
  await page.waitForFunction(selector=>document.querySelector(selector)?.textContent.includes('Pause updates'),{},card);
  await clickText('Pause updates',card+' button');await page.waitForFunction(selector=>document.querySelector(selector)?.textContent.includes('Automatic updates paused'),{},card);
  check('member owner pauses updates through real manager',(await uiRequest('/api/personal/private-series')).data.content.find(r=>r.id===seriesId)?.autoUpdate===false);await shot('owner-manager');
  for(const path of [`/api/series/${seriesId}`,`/api/series/${seriesId}/privacy`])expectedErrors.add(base+path);
  await clickText('Remove private copy',card+' button');await clickText('Remove private copy','[role=dialog] button');
  await page.waitForFunction(selector=>document.querySelector(selector)?.textContent.includes('Restore'),{},card);
  check('removed private copy stays recoverable',(await uiRequest('/api/personal/private-series')).data.content.find(r=>r.id===seriesId)?.deleted===true);
  await clickText('Restore',card+' button');await page.waitForFunction(selector=>document.querySelector(selector)?.textContent.includes('Remove private copy'),{},card);
  check('member owner restores private copy',(await uiRequest('/api/personal/private-series')).data.content.find(r=>r.id===seriesId)?.deleted===false);
  for(const path of [`/api/series/${seriesId}`,`/api/series/${seriesId}/privacy`])expectedErrors.delete(base+path);
  await page.goto(`${base}/series/?id=${seriesId}`,{waitUntil:'networkidle2'});await clickText('Change visibility');await page.waitForSelector('#privacy-destination');
  await clickText('Share this copy','[role=dialog] button');await page.waitForFunction(()=>document.querySelector('[data-series-privacy]')?.textContent.includes('Shared library'));
  check('owner explicitly publishes the same server identity',(await uiRequest(`/api/series/${seriesId}/privacy`)).data.isPrivate===false);
  await clickText('Change visibility');await clickText('Make private','[role=dialog] button');await page.waitForFunction(()=>document.querySelector('[data-series-privacy]')?.textContent.includes('Private library'));
  check('owner makes the same copy private again',(await uiRequest(`/api/series/${seriesId}/privacy`)).data.isPrivate===true);
  await page.locator('::-p-aria(Save all offline)').click();
  for(let i=0;i<40&&!((await dbChapters()).some(row=>row.userId===owner.id&&row.bookId===bookId));i++)await sleep(250);
  check('explicit offline copy is stored under the owner identity',(await dbChapters()).some(row=>row.key===`${owner.id}:${bookId}`));
  check('private API and image replies never enter implicit service-worker caches',(await privateCacheEntries()).length===0);
  await page.goto(`${base}/reader/?book=${bookId}&page=1`,{waitUntil:'networkidle2'});await page.waitForSelector('img');
  offline=true;await page.setOfflineMode(true);await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>[...document.images].some(image=>image.src.startsWith('blob:')&&image.complete&&image.naturalWidth>0),{timeout:25000});
  check('owner can read the explicitly saved private page offline',true);await shot('owner-offline');
  await page.setOfflineMode(false);offline=false;await signOut();otherToken=await signIn(other);
  check('other account has independent shared-default preference',(await uiRequest('/api/personal/privacy',{token:otherToken})).data.defaultPrivate===false);
  for(const path of [`/api/series/${seriesId}`,`/api/series/${seriesId}/privacy`,`/api/books/${bookId}/download-manifest`,`/img/books/${bookId}/page/1`]){
    const response=await uiRequest(path,{token:otherToken,expected:404});check('other account cannot open '+path.split('/').slice(1,3).join('/'),response.status===404);
  }
  nativeOtherProbe=await page.evaluate(async({bookId,name})=>{
    const request=new Request(`/img/books/${bookId}/page/1`,{credentials:'include'}),response=await fetch(request),cached=await(await caches.open(name)).match(request);
    return{status:response.status,cookie:request.headers.get('cookie'),authorization:request.headers.get('authorization'),cachedBytes:cached?(await cached.arrayBuffer()).byteLength:0};
  },{bookId,name:nativeProbeCache});
  check('other real account cookies cannot recover private bytes through native Cache.match',nativeOtherProbe.status===404&&nativeOtherProbe.cookie===null&&nativeOtherProbe.authorization===null&&nativeOtherProbe.cachedBytes===0);
  check('other account does not receive owner management rows',!(await uiRequest('/api/personal/private-series',{token:otherToken})).data.content.some(row=>row.id===seriesId));
  await page.goto(base+'/library/?view=downloads',{waitUntil:'networkidle2'});
  check('account switch keeps private title out of offline library UI',!(await page.$eval('body',el=>el.innerText)).includes(title));
  check('owner offline bytes survive account switch with their owner key',(await dbChapters()).some(row=>row.key===`${owner.id}:${bookId}`));
  check('switch leaves no private response in implicit caches',(await privateCacheEntries()).length===0);await shot('other-account');
  offline=true;await page.setOfflineMode(true);
  check('other account receives no old private page from network or service-worker cache',(await uiRequest(`/img/books/${bookId}/page/1`,{token:otherToken,expected:404})).status!==200);
  await page.goto(`${base}/reader/?book=${bookId}&page=1`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.body.innerText.toLowerCase().includes('chapter unavailable'),{timeout:25000});
  check('other account cannot render the owner offline chapter',!(await page.$eval('body',el=>el.innerText)).includes(title)
    &&!(await page.evaluate(()=>[...document.images].some(image=>image.src.startsWith('blob:')&&image.naturalWidth>0))));await shot('other-offline-denied');
  await page.setOfflineMode(false);offline=false;await signOut();ownerToken=await signIn(owner);
  await page.goto(`${base}/reader/?book=${bookId}&page=1`,{waitUntil:'networkidle2'});offline=true;await page.setOfflineMode(true);await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>[...document.images].some(image=>image.src.startsWith('blob:')&&image.complete&&image.naturalWidth>0),{timeout:25000});
  check('returning owner retains access to their explicit offline bytes',true);await shot('returned-owner-offline');
}catch(error){failures.push(error.stack||error.message);console.error(error.stack||error.message);if(page&&!page.isClosed()){await shot('failure').catch(()=>{});writeFileSync(`${out}/failure-page.txt`,`${page.url()}\n${await page.$eval('body',el=>el.innerText).catch(()=> '')}`);}}
finally{
  if(page&&offline)await page.setOfflineMode(false).catch(()=>{});
  if(page&&!page.isClosed())await page.evaluate(name=>caches.delete(name),nativeProbeCache).catch(()=>{});
  // Stop the app's ordinary authenticated polling before deleting its fixture account. A deliberate
  // account deletion is cleanup, not evidence of an unexpected runtime authorization failure.
  await browser?.close();
  // Published fixture copies cannot use the member's never-published deletion shortcut. Temporarily grant
  // this fixture owner admin to use their own typed-confirmation cleanup; never act on another owner's data.
  if(seriesId&&owner&&adminToken)try{
    assert.equal((await raw(`/api/admin/users/${owner.id}`,{method:'PATCH',body:{role:'admin'}})).status,200);
    const token=(await(await fixtureLogin(base,{username:owner.username,password})).json()).accessToken;
    const removed=await raw(`/api/series/${seriesId}/private-management`,{token,method:'POST',body:{action:'remove'}});assert.equal(removed.status,200,JSON.stringify(removed.data));
    for(const action of ['delete-files','forget']){const response=await raw(`/api/admin/series/${seriesId}/${action}`,{token,method:'POST',body:{confirm:title}});assert.equal(response.status,200,`fixture-only ${action}: ${JSON.stringify(response.data)}`);}
  }catch(error){failures.push('fixture content cleanup: '+error.message);}
  for(const account of accounts)try{const response=await raw(`/api/admin/users/${account.id}`,{method:'DELETE'});assert.equal(response.status,200,JSON.stringify(response.data));}catch(error){failures.push('fixture account cleanup '+account.id+': '+error.message);}
  // Full document boots ask for settings before the in-memory access token is restored. Keep the raw
  // evidence, and classify only a matching real 401 response whose request had NO Authorization header.
  // A refused authenticated request, runtime exception or server error always remains a failure.
  const observedConsoleErrors=[...consoleErrors];
  for(let i=consoleErrors.length-1;i>=0;i--){const message=consoleErrors[i],url=message.split(' ').at(-1);
    if(offlineEvidence?.take(message)){
      expectedNetworkResponses.push('correlated planned offline request: '+message);consoleErrors.splice(i,1);continue;
    }
    if(/status of 401/.test(message)&&authResponses.some(response=>response.url===url&&!response.hadAuthorization)){
      expectedNetworkResponses.push('unauthenticated document bootstrap401: '+url);consoleErrors.splice(i,1);
    }
  }
  const result={base,image:process.env.E2E_IMAGE||null,checks,failures,consoleErrors,observedConsoleErrors,serverErrors,expectedNetworkResponses,authResponses,plannedOfflineFailures:offlineEvidence?.failures||[],nativeCache:{owner:nativeOwnerProbe,other:nativeOtherProbe},fixtures:{owner:owner?.id,other:other?.id,seriesId,bookId},serviceWorkerBypass:false};
  writeFileSync(`${out}/result.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({checks:checks.length,passed:checks.filter(check=>check.pass).length,failures,consoleErrors,serverErrors}));
  process.exitCode=failures.length||consoleErrors.length||serverErrors.length?1:0;
}
